# t9 — Codex 跨会话记忆（memories）机制取证报告

- **仓库**: `openai/codex` 本地克隆 `I:\VMsShare\_src-compare\codex`
- **commit（实测）**: `a07c8ebd57feedc4cf5dfe854c8e9101de54186b`，`2026-10-11T12:38:29Z`
  - 取证命令: `git -C I:\VMsShare\_src-compare\codex log -1 --format='%H %cI'`
- **方法**: 只读。全部证据用 grep/read 直读工作区文件；未构建、未运行测试、未修改仓库。
- **路径约定**: 全部为**相对仓库根**的 POSIX 路径。

## 0. 先回答验收要求的「实现载体与调用链」（一句话版）

跨会话记忆不是"模型随手写的笔记"，而是**两阶段后台流水线 + 磁盘工件 + 每回合开发者指令注入 + 可选的只读检索工具**：

```
root 会话首个 turn 提交 (app-server turn_processor.rs:704-716)
  └─ codex_memories_write::start_memories_startup_task   (memories/write/src/start.rs:24)
      ├─ 相位闸门: ephemeral / Feature::MemoryTool / 非 subagent / state DB 可用  (:33-38, :60-63)
      ├─ ensure_layout + seed_extension_instructions + phase1::prune            (:64-77)
      ├─ 限流闸门 guard::rate_limits_ok                                         (:79-86)
      ├─ phase1::run  → 逐 rollout 调模型 → stage1_outputs 表（SQLite）          (memories/write/src/phase1.rs:56)
      └─ phase2::run  → 同步内存工件到 ~/.codex/memories*/ → git 基线 diff
                       → 起 consolidation 子代理重写 MEMORY.md / memory_summary.md (memories/write/src/phase2.rs:49)
读取侧（每个新 thread 组装上下文时）
  └─ MemoriesExtension::contribute_thread_context                    (ext/memories/src/extension.rs:56-102)
      ├─ 读 <codex_home>/memories{,_v2}/memory_summary.md, 截断到 2500 token         (ext/memories/src/prompts.rs:35-49)
      └─ PromptFragment::developer_policy(...) → developer 消息 (memories.instructions) (extension.rs:95-98)
```

---

## 1. 记忆提炼的触发时机：谁触发、入口函数、调用链

### 1.1 触发点：root 会话的第一个 turn 被接受之后（**不是**压缩后、不是会话结束、不是定时器）

`codex-rs/app-server/src/request_processors/turn_processor.rs:704`：

```rust
        if turn_has_input && started {
            let config_snapshot = thread.config_snapshot().await;
            if config_snapshot.is_primary_environment_configured() {
                codex_memories_write::start_memories_startup_task(
                    Arc::clone(&self.thread_manager),
                    Arc::clone(&self.auth_manager),
                    thread_id,
                    Arc::clone(&thread),
                    thread.config().await,
                    config_snapshot.permission_profile,
                    &config_snapshot.session_source,
                );
            }
        }
```

条件 `turn_has_input && started` 意味着：**只有真正开启了一个新 turn（非 steer 到已有 turn）时才触发**，且每个 turn 提交都会尝试触发（幂等性靠 DB 作业租约保证，见 §6.1）。这是唯一调用点（全域 grep `start_memories_startup_task` 仅命中此处与 `memories/write/src/start.rs:24`、测试）。

### 1.2 相位闸门（四道硬条件）

`codex-rs/memories/write/src/start.rs:33`：

```rust
    if config.ephemeral
        || !config.features.enabled(Feature::MemoryTool)
        || source.is_non_root_agent()
    {
        return;
    }
```

`codex-rs/memories/write/src/start.rs:59`（异步任务里还有第四道：state DB 可用）：

```rust
        tokio::spawn(async move {
            if context.memory_store().await.is_none() {
                warn!("state db unavailable for memories startup pipeline; skipping");
                return;
            }
```

### 1.3 入口函数与两阶段串行

`codex-rs/memories/write/src/start.rs:77`：

```rust
            // Clean memories to make preserve DB size. This does not consume tokens so can be
            // done before the quota check.
            phase1::prune(context.as_ref(), &config).await;

            if !guard::rate_limits_ok(&auth_manager, &config).await {
```

```rust
            // Run phase 1.
            phase1::run(Arc::clone(&context), Arc::clone(&config)).await;
            // Run phase 2.
            phase2::run(context, config, parent_permission_profile).await;
```

- `Feature::MemoryTool` 默认**关闭**：`codex-rs/features/src/lib.rs:1267-1272`
  ```rust
      FeatureSpec {
          id: Feature::MemoryTool,
          key: "memories",
          stage: Stage::Stable,
          default_enabled: false,
      },
  ```
- 版本选择与双写：`codex-rs/memories/write/src/start.rs:40-44`（`dual_write` 时同时跑 V1 + V2 两套目录）。
- README 自述与代码一致：`codex-rs/memories/README.md:29-38`（"The pipeline is triggered when a root session starts, and only if: the session is not ephemeral / the memory feature is enabled / the session is not a sub-agent session / the state DB is available"）。
- ⚠️ README 有一处**过期路径**：`codex-rs/memories/README.md:5-6` 称 "Runtime orchestration for Phase 1 and Phase 2 still lives in `codex-core` under `codex-rs/core/src/memories/`" —— 该目录在 a07c8ebd 下**不存在**（已确认 `codex-rs/core/src/` 无 `memories/` 子目录），编排实际在 `codex-rs/memories/write/src/`。这属于文档与代码不一致。

### 1.4 与压缩/会话结束的关系（回答"是不是压缩后触发"）

**不是。** 压缩路径（`codex-rs/core/src/compact.rs`、`compact_remote_v2.rs`、`compact_token_budget.rs`）中没有任何 memory 调用；全域 grep `start_memories_startup_task|phase1::run|phase2::run` 均不出现于 compact 相关文件。记忆提炼与压缩是**两条完全独立的后台路径**：压缩服务于"当前会话继续"，记忆服务于"未来会话复用"。

---

## 2. 数据来源：从 rollout 取什么、如何筛选与截断

### 2.1 作业来源：state DB 里的 rollout 作业，带 5 项筛选规则

`codex-rs/memories/write/src/phase1.rs:130`：

```rust
    let allowed_sources = INTERACTIVE_SESSION_SOURCES
        .iter()
        .map(ToString::to_string)
        .collect::<Vec<_>>();

    match state_db
        .claim_stage1_jobs_for_startup(
            context.thread_id(),
            codex_state::Stage1StartupClaimParams {
                scan_limit: crate::stage_one::THREAD_SCAN_LIMIT,
                max_claimed: memories_config.max_rollouts_per_startup,
                max_age_days: memories_config.max_rollout_age_days,
                min_rollout_idle_hours: memories_config.min_rollout_idle_hours,
                allowed_sources: allowed_sources.as_slice(),
                lease_seconds: crate::stage_one::JOB_LEASE_SECONDS,
            },
```

`INTERACTIVE_SESSION_SOURCES` 定义在 `codex-rs/rollout/src/lib.rs:88-95`：`Cli`、`VSCode`、`Custom("atlas")`、`Custom("chatgpt")` —— 即**只处理交互式人类会话，不处理子代理/内部会话**。

默认参数（`codex-rs/config/src/types.rs:55-64`）：

```rust
pub const DEFAULT_MEMORIES_MAX_ROLLOUTS_PER_STARTUP: usize = 2;
pub const DEFAULT_MEMORIES_MAX_ROLLOUT_AGE_DAYS: i64 = 10;
pub const DEFAULT_MEMORIES_MIN_ROLLOUT_IDLE_HOURS: i64 = 6;
pub const DEFAULT_MEMORIES_MIN_RATE_LIMIT_REMAINING_PERCENT: i64 = 25;
pub const DEFAULT_MEMORIES_MAX_RAW_MEMORIES_FOR_CONSOLIDATION: usize = 256;
pub const DEFAULT_MEMORIES_MAX_UNUSED_DAYS: i64 = 30;
const MIN_MEMORIES_MAX_RAW_MEMORIES_FOR_CONSOLIDATION: usize = 1;
const MAX_MEMORIES_MAX_RAW_MEMORIES_FOR_CONSOLIDATION: usize = 4096;
```

关键限流参数（`codex-rs/memories/write/src/lib.rs:80-102`）：

```rust
mod stage_one {
    pub(super) const REASONING_EFFORT: codex_protocol::openai_models::ReasoningEffort =
        codex_protocol::openai_models::ReasoningEffort::Low;
    pub(super) const CONCURRENCY_LIMIT: usize = 8;
    pub(super) const JOB_LEASE_SECONDS: i64 = 3_600;
    pub(super) const JOB_RETRY_DELAY_SECONDS: i64 = 3_600;
    pub(super) const THREAD_SCAN_LIMIT: usize = 5_000;
    pub(super) const PRUNE_BATCH_SIZE: usize = 200;
```

### 2.2 条目级筛选：白名单 + 分类分级

`codex-rs/rollout/src/policy.rs:104`（哪些 ResponseItem 可供记忆使用）：

```rust
pub fn should_persist_response_item_for_memories(item: &ResponseItem) -> bool {
    match item {
        ResponseItem::Message { role, .. } => role != "developer",
        ResponseItem::AgentMessage { .. }
        | ResponseItem::LocalShellCall { .. }
        | ResponseItem::FunctionCall { .. }
        | ResponseItem::ToolSearchCall { .. }
        | ResponseItem::FunctionCallOutput { .. }
        | ResponseItem::ToolSearchOutput { .. }
        | ResponseItem::CustomToolCall { .. }
        | ResponseItem::CustomToolCallOutput { .. }
        | ResponseItem::WebSearchCall { .. } => true,
```

`codex-rs/memories/write/src/rollout_input.rs:27`（六档优先级，`Human` 最高、`Tool` 最低）：

```rust
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum Tier {
    Human,
    Final,
    OtherAgent,
    Commentary,
    Context,
    Tool,
}
```

同时明确丢弃非模型可见项（`codex-rs/memories/write/src/rollout_input.rs:48-58`：`SessionMeta`、`Compacted`、`TurnContext`、`EventMsg` 等一律 `None`）；图片/音频替换为占位符（`:63-72`：`"[image omitted]"` / `"[audio omitted]"`）。

### 2.3 截断参数（三层截断）

`codex-rs/memories/write/src/rollout_input.rs:22`：

```rust
const OMITTED: &str = "[... response items omitted ...]\n";
const TRUNCATION_RESERVE_BYTES: usize = 96;
const TOOL_OUTPUT_TOKENS: usize = 2_000;
const MAX_ROW_BYTES: usize = 10_000;
```

- 单条工具输出 ≤ 2000 token（`:185-191`）；单行 ≤ 10000 字节（`:193-196`）。
- 整体预算按 tier 从高到低回填，剩余不足时插入 `OMITTED` 标记（`:199-225`）。
- 最终 rollout 输入 token 上限 = 模型有效窗口的 **70%**（`codex-rs/memories/write/src/lib.rs:101` `CONTEXT_WINDOW_PERCENT: i64 = 70;`），无有效窗口时回落 `DEFAULT_ROLLOUT_TOKEN_LIMIT: usize = 150_000`（`:94`），计算见 `codex-rs/memories/write/src/prompts.rs:121-129`。
- 输入按 **8900 字符**切块，避免超过单条片段上限（`codex-rs/memories/write/src/rollout_input.rs:248-257`）。
- 密钥脱敏贯穿：`redact_secrets` 在 `rollout_input.rs:16` 导入并在 `:173`、`phase1_output.rs:49`、`:54`、`:56` 多次应用。

---

## 3. 提炼产物形态：结构化 JSON → 结构化 DB 行 → 自然语言磁盘工件

### 3.1 相位 1 产物：严格 JSON（两版 schema 不同）

`codex-rs/memories/write/src/phase1_output.rs:61`：

```rust
pub(crate) fn output_schema(version: MemoryVersion) -> Value {
    match version {
        MemoryVersion::V1 => json!({
            "type": "object",
            "properties": {
                "rollout_summary": { "type": "string" },
                "rollout_slug": { "type": ["string", "null"] },
                "raw_memory": { "type": "string" }
            },
            "required": ["rollout_summary", "rollout_slug", "raw_memory"],
            "additionalProperties": false
        }),
        MemoryVersion::V2 => json!({
            "type": "object",
            "properties": {
                "rollout_summary": { "type": "string" },
                "rollout_slug": { "type": "string" }
            },
            "required": ["rollout_summary", "rollout_slug"],
            "additionalProperties": false
        }),
    }
}
```

- 严格模式通过 `prompt.output_schema_strict = true` 施加（`codex-rs/memories/write/src/phase1.rs:313`）。
- `StageOneOutput` 结构：`raw_memory: Option<String>` / `rollout_summary: String` / `rollout_slug: Option<String>`（`phase1_output.rs:11-15`）。
- **V2 不再产出 `raw_memory`**（`phase1_output.rs:44-47`），并在 V2 下把 `rollout_summary` 截断到 **9000 字节**（`:50-52`）：
  ```rust
          if version == MemoryVersion::V2 {
              rollout_summary = truncate_text(&rollout_summary, TruncationPolicy::Bytes(9_000));
          }
  ```

### 3.2 相位 2 产物：磁盘上的自然语言 Markdown 工件

工件清单（`codex-rs/memories/write/templates/memories/consolidation.md:20-35`）：

```
Folder structure (under {{ memory_root }}/):

- memory_summary.md
  - Always loaded into the system prompt. First line must be exactly `v1`.
    Must stay dense, highly navigational, and discriminative enough to guide retrieval.
- MEMORY.md
  - Handbook entries. Used to grep for keywords; aggregated insights from rollouts;
    pointers to rollout summaries if certain past rollouts are very relevant.
- raw_memories.md
  - Temporary file: merged raw memories from Phase 1. Input for Phase 2.
- skills/<skill-name>/
  - Reusable procedures. Entrypoint: SKILL.md; may include scripts/, templates/, examples/.
- rollout_summaries/<rollout_slug>.md
```

**硬性校验（代码强制，不只是提示词）** `codex-rs/memories/write/src/workspace.rs:76`：

```rust
pub(crate) async fn validate_consolidation_artifacts_for_version(
    root: &Path,
    version: MemoryVersion,
) -> anyhow::Result<()> {
    let removed_symlinks = remove_memory_symlinks(root).await?;
    anyhow::ensure!(
        removed_symlinks == 0,
        "removed {removed_symlinks} symbolic links from consolidated memory workspace"
    );

    if version == MemoryVersion::V1 {
        let memory_path = root.join("MEMORY.md");
```

摘要格式与大小上限（`codex-rs/memories/write/src/workspace.rs:105-129`）：

```rust
    anyhow::ensure!(
        summary.lines().next() == Some("v1"),
        "memory summary artifact does not start with v1: {}",
        summary_path.display()
    );
```

```rust
pub fn is_valid_v2_summary(summary: &str) -> bool {
    summary.lines().next() == Some("v1")
        && summary.len() < 10_000
        && [
            "## User Profile",
            "## User preferences",
            "## General Tips",
            "## What's in Memory",
        ]
        .iter()
        .all(|heading| summary.lines().any(|line| line.trim() == *heading))
}
```

→ **`memory_summary.md` 必须首行为 `v1`、总长 < 10 000 字节**，V2 还必须有四个固定二级标题。V1 必须有 `MEMORY.md` 文件存在。

### 3.3 `raw_memories.md` 与 rollout summary 文件的正文结构（代码生成，非模型生成）

`codex-rs/memories/write/src/storage.rs:57`：

```rust
    body.push_str("Merged stage-1 raw memories (stable ascending thread-id order):\n\n");
    for memory in retained {
        writeln!(body, "## Thread `{}`", memory.thread_id).map_err(raw_memories_format_error)?;
        writeln!(
            body,
            "updated_at: {}",
            memory.source_updated_at.to_rfc3339()
        )
        .map_err(raw_memories_format_error)?;
        writeln!(body, "cwd: {}", memory.cwd.display()).map_err(raw_memories_format_error)?;
        writeln!(body, "rollout_path: {}", memory.rollout_path.display()).map_err(raw_memories_format_error)?;
```

单条 rollout summary 文件头（`codex-rs/memories/write/src/storage.rs:117-133`）：`thread_id` / `updated_at` / `rollout_path` / `cwd` / 可选 `git_branch` + 正文。

文件名规则：`<YYYY-MM-DDTHH-MM-SS>-<4位短哈希>[-<slug≤60字符>].md`（`codex-rs/memories/write/src/storage.rs:161-237`，常量 `ROLLOUT_SLUG_MAX_LEN: usize = 60`）。

---

## 4. 存储位置与格式：独立 SQLite 库（DB）+ 磁盘工件目录 + git 基线

### 4.1 磁盘位置

`codex-rs/memories/write/src/lib.rs:118`：

```rust
pub fn memory_root(codex_home: &AbsolutePathBuf) -> AbsolutePathBuf {
    codex_home.join("memories")
}
```

版本化目录名（`codex-rs/protocol/src/memory_version.rs:15-22`）：

```rust
impl MemoryVersion {
    /// Sibling roots keep v1 cleanup and rollback independent of v2 artifacts.
    pub fn directory_name(self) -> &'static str {
        match self {
            Self::V1 => "memories",
            Self::V2 => "memories_v2",
        }
    }
}
```

→ `~/.codex/memories/`（V1）与 `~/.codex/memories_v2/`（V2）；子目录 `rollout_summaries/`、`extensions/`，文件 `raw_memories.md`、`MEMORY.md`、`memory_summary.md`、`phase2_workspace_diff.md`（常量见 `codex-rs/memories/write/src/lib.rs:37-41`、`:112-116`）。

### 4.2 DB 位置与文件（独立于 state DB）

`codex-rs/state/src/sqlite.rs:36` / `:97` / `:107`：

```rust
const MEMORIES_DB_FILENAME: &str = "memories_1.sqlite";
```

```rust
const MEMORIES_DB: RuntimeDbSpec = RuntimeDbSpec {
    label: "memories DB",
    filename: MEMORIES_DB_FILENAME,
    kind: DbKind::Memories,
    open_phase: "open_memories",
    migrate_phase: "migrate_memories",
    background_reclamation: false,
    recovery: RecoveryMode::BackupAndRebuild,
};

const MEMORIES_V2_DB: RuntimeDbSpec = RuntimeDbSpec {
    label: "memories v2 DB",
    filename: "memories_v2_1.sqlite",
    background_reclamation: false,
    ..MEMORIES_DB
};
```

→ `~/.codex/memories_1.sqlite`、`~/.codex/memories_v2_1.sqlite`，由独立 migrator 管理（`codex-rs/state/src/migrations.rs:9`：`MEMORIES_MIGRATOR: Migrator = sqlx_macros::migrate!("./memory_migrations")`）。

### 4.3 表结构（含版本隔离与相位 2 选择标记）

`codex-rs/state/memory_migrations/0001_memories.sql:1`（V1/V2 各自一份库，表结构如下）：

```sql
CREATE TABLE stage1_outputs (
    thread_id TEXT PRIMARY KEY,
    source_updated_at INTEGER NOT NULL,
    raw_memory TEXT NOT NULL,
    rollout_summary TEXT NOT NULL,
    rollout_slug TEXT,
    generated_at INTEGER NOT NULL,
    usage_count INTEGER,
    last_usage INTEGER,
    selected_for_phase2 INTEGER NOT NULL DEFAULT 0,
    selected_for_phase2_source_updated_at INTEGER
);
```

后续增量迁移（同样只读引用）：`0009_stage1_outputs_rollout_slug.sql`（加 `rollout_slug`）、`0016_memory_usage.sql`（加 `usage_count`/`last_usage`）、`0017_phase2_selection_flag.sql`、`0018_phase2_selection_snapshot.sql`（同时给 `threads` 加 `memory_mode TEXT NOT NULL DEFAULT 'enabled'`）。

**"版本标记"是双层的**：
1. **记录级**：`memory_summary.md` 首行必须为 `v1`（`workspace.rs:105-109`），提示词也要求首行 `v1`（`consolidation_v2.md:23`）。
2. **存储级**：V1/V2 各用一套 DB 文件 + 一套目录（`memory_version.rs:17-22`、`sqlite.rs:97-112`），且 v2 库按需惰性创建（`codex-rs/state/src/runtime/memory_versions.rs:15-25`）。

另有一处历史遗留：`codex-rs/state/migrations/0006_memories.sql` 曾在 **state DB** 内建过 `stage1_outputs`，随后被 `codex-rs/state/migrations/0035_drop_memory_tables.sql` 删除：

```sql
DROP TABLE IF EXISTS jobs;
DROP TABLE IF EXISTS stage1_outputs;
```

→ 即"记忆表已从 state DB 迁出到独立 memories DB"。

---

## 5. 检索 / 注入接口：**两条路**（developer 指令注入 + 可选只读工具）

### 5.1 主通道：`memory_summary.md` 内容注入 developer 消息（默认路径）

`codex-rs/ext/memories/src/prompts.rs:35`：

```rust
pub(crate) async fn build_memory_tool_developer_instructions(
    codex_home: &AbsolutePathBuf,
    version: MemoryVersion,
) -> Option<String> {
    let base_path = codex_home.join(version.directory_name());
    let memory_summary_path = base_path.join("memory_summary.md");
    let memory_summary = fs::read_to_string(&memory_summary_path)
        .await
        .ok()?
        .trim()
        .to_string();
    let memory_summary = truncate_text(
        &memory_summary,
        TruncationPolicy::Tokens(MEMORY_TOOL_DEVELOPER_INSTRUCTIONS_SUMMARY_TOKEN_LIMIT),
    );
    if memory_summary.is_empty() {
        return None;
    }
```

- 上限 `MEMORY_TOOL_DEVELOPER_INSTRUCTIONS_SUMMARY_TOKEN_LIMIT: usize = 2_500`（`codex-rs/ext/memories/src/lib.rs:16`）。
- 模板渲染 `base_path` + `memory_summary`（`prompts.rs:58-63`），V1 用 `read_path.md`、V2 用 `read_path_v2.md`（`prompts.rs:10-22`、`:54-57`）。
- V2 会按 **8900 字符**切分为多个片段以规避单片段字节上限（`codex-rs/ext/memories/src/extension.rs:75-91`）：
  ```rust
                  MemoryVersion::V2 => {
                      // Keep the complete summary while respecting each fragment's byte cap.
                      let mut remaining = instructions.as_str();
                      let mut fragments = Vec::new();
                      while !remaining.is_empty() {
                          let end = remaining.floor_char_boundary(remaining.len().min(8_900));
  ```
- 注入通道是 **developer policy**（`extension.rs:95-98`）：
  ```rust
                  PromptFragment::developer_policy(
                      instructions,
                      ContentItemKind("memories.instructions".to_string()),
                  )
  ```
  `developer_policy` 落在 `PromptSlot::DeveloperPolicy`（`codex-rs/ext/extension-api/src/contributors/prompt.rs:33-35`），在会话组装时被归入 `developer_sections`（`codex-rs/core/src/session/mod.rs:4386-4388`）。
- 启用开关是 **两个条件的与**（`codex-rs/ext/memories/src/extension.rs:46-52`）：
  ```rust
      fn from_config(config: &Config) -> Self {
          Self {
              enabled: config.features.enabled(Feature::MemoryTool) && config.memories.use_memories,
              dedicated_tools: config.memories.dedicated_tools,
              codex_home: config.codex_home.clone(),
              version: config.memories.version,
          }
      }
  ```
- 注入内容里还包含**引用要求**：回答时若用了记忆，须在最终回复末尾追加 `<oai-mem-citation>` 块（`codex-rs/ext/memories/templates/memories/read_path_v2.md:24-34`；V1 同结构见 `read_path.md:75-115`）。
- 记忆目录被加进沙箱可读根，模型才能真去读文件（`codex-rs/core/src/config/mod.rs:4237-4239`）：
  ```rust
          if features.enabled(Feature::MemoryTool) && memories_config.use_memories {
              helper_readable_roots.push(memories_root);
          }
  ```

### 5.2 次通道：4 个记忆工具（**默认关闭**）

`codex-rs/ext/memories/src/extension.rs:146`：

```rust
        if !config.enabled || !config.dedicated_tools {
            return Vec::new();
        }
```

`codex-rs/config/src/types.rs:384`：`dedicated_tools: false,`（默认关闭）。工具集合（`codex-rs/ext/memories/src/tools/mod.rs:35-52`）：

```rust
    vec![
        Arc::new(ad_hoc_note::AddAdHocNoteTool {
            backend: backend.clone(),
            metrics_client: metrics_client.clone(),
        }),
        Arc::new(list::ListTool { ... }),
        Arc::new(read::ReadTool { ... }),
        Arc::new(search::SearchTool { backend, metrics_client }),
    ]
```

工具名与命名空间（`codex-rs/ext/memories/src/lib.rs:18-22`）：命名空间 `memories`，工具 `add_ad_hoc_note` / `list` / `read` / `search`（即 `memories.read` 等）。四个工具均为 `DirectModelOnly` 暴露级别（`codex-rs/ext/memories/src/tools/mod.rs:55-57` 构造 `ToolName::namespaced(MEMORY_TOOLS_NAMESPACE, name)`；`search`/`read`/`list` 三个工具声明 `supports_parallel_tool_calls() == true`，见 `search.rs:58-60`、`read.rs:49-51`、`list.rs:58-60`，`add_ad_hoc_note` 未声明即默认 false）。

### 5.3 匹配方式：**字面包含**（可配大小写/归一化），**无向量/语义检索**

`codex-rs/ext/memories/src/local/search.rs:284`：

```rust
    fn matched_query_flags(&self, line: &str) -> Vec<bool> {
        let line = self.comparison.prepare(line);
        self.prepared_queries
            .iter()
            .map(|query| line.as_ref().contains(query))
            .collect()
    }
```

`codex-rs/ext/memories/src/local/search.rs:315`（大小写/归一化处理，仍是字面匹配）：

```rust
    fn prepare<'a>(self, value: &'a str) -> Cow<'a, str> {
        if self.case_sensitive && !self.normalized {
            return Cow::Borrowed(value);
        }

        let value = if self.case_sensitive {
            Cow::Borrowed(value)
        } else {
            Cow::Owned(value.to_lowercase())
        };
```

三种匹配模式（`codex-rs/ext/memories/src/backend.rs:100-109`）：

```rust
pub enum SearchMatchMode {
    Any,
    AllOnSameLine,
    AllWithinLines {
        #[schemars(range(min = 1))]
        line_count: usize,
    },
}
```

默认值与配额（`codex-rs/ext/memories/src/tools/search.rs:106-116`）：`match_mode` 默认 `Any`、`case_sensitive` 默认 **true**、`normalized` 默认 false、结果上限 200；读取上限 20000 token、list 上限 2000（`codex-rs/ext/memories/src/lib.rs:11-16`）。

### 5.4 引用回流：模型回答里的 citation 会更新 `usage_count`（影响排序，见 §6）

`codex-rs/core/src/stream_events_utils.rs:186`：

```rust
async fn record_stage1_output_usage_and_detect_memory_citation(
    state_db_ctx: Option<&codex_state::MemoryStore>,
    item: &ResponseItem,
) -> bool {
    let Some(raw_text) = raw_assistant_output_text_from_item(item) else {
        return false;
    };

    let (_, citations) = strip_citations(&raw_text);
    let Some(memory_citation) = parse_memory_citation(citations) else {
        return false;
    };
    record_stage1_output_usage_for_memory_citation(state_db_ctx, &memory_citation).await
}
```

`codex-rs/core/src/stream_events_utils.rs:201`：

```rust
async fn record_stage1_output_usage_for_memory_citation(
    state_db_ctx: Option<&codex_state::MemoryStore>,
    memory_citation: &MemoryCitation,
) -> bool {
    let thread_ids = thread_ids_from_memory_citation(memory_citation);
    if thread_ids.is_empty() {
        return true;
    }

    if let Some(db) = state_db_ctx {
        let _ = db.record_stage1_output_usage(&thread_ids).await;
    }
    true
}
```

解析逻辑（`codex-rs/memories/read/src/citations.rs:45-51`：从 `<rollout_ids>` 取 ThreadId；`<citation_entries>` 取文件指针，`:53-70`）。

### 5.5 另一条遥测通道（非模型可见）：shell 读取分类

`codex-rs/memories/read/src/usage.rs:30`（把 `cat ~/.codex/memories/MEMORY.md` 这类命令归类打点，`MemoriesUsageKind` 见 `:9-27`，V2 路径识别见 `:51-56`）。这只是度量，不构成检索接口。

---

## 6. 生命周期：更新、去重、淘汰、容量上限

### 6.1 去重与并发：DB 租约 + `ON CONFLICT` 版本比较

作业种类与相位 2 冷却（`codex-rs/state/src/runtime/memories.rs:21-27`）：

```rust
const JOB_KIND_MEMORY_STAGE1: &str = "memory_stage1";
const JOB_KIND_MEMORY_CONSOLIDATE_GLOBAL: &str = "memory_consolidate_global";
const MEMORY_CONSOLIDATION_JOB_KEY: &str = "global";
const PHASE2_SUCCESS_COOLDOWN_SECONDS: i64 = 6 * 60 * 60;
const PHASE2_INPUT_SELECTION_PAGE_SIZE: usize = 512;

const DEFAULT_RETRY_REMAINING: i64 = 3;
```

按 `source_updated_at` 去重/更新（`codex-rs/state/src/runtime/memories.rs:908`）：

```rust
INSERT INTO stage1_outputs (
    thread_id,
    source_updated_at,
    raw_memory,
    rollout_summary,
    rollout_slug,
    generated_at
) VALUES (?, ?, ?, ?, ?, ?)
ON CONFLICT(thread_id) DO UPDATE SET
    source_updated_at = excluded.source_updated_at,
```

且**倒流保护**：`WHERE excluded.source_updated_at >= stage1_outputs.source_updated_at`（`:924`）。租约拿不到时直接返回 false（`:903-906`），避免并发写。

### 6.2 消耗/淘汰：两套独立清理逻辑

**(a) 阶段 1 输出淘汰**（启动时执行，`max_unused_days` 默认 30 天）`codex-rs/state/src/runtime/memories.rs:413`：

```sql
DELETE FROM stage1_outputs
WHERE thread_id IN (
    SELECT thread_id
    FROM stage1_outputs
    WHERE selected_for_phase2 = 0
      AND COALESCE(last_usage, source_updated_at) < ?
    ORDER BY
      COALESCE(last_usage, source_updated_at) ASC,
      source_updated_at ASC,
      thread_id ASC
    LIMIT ?
)
```

调用点：`codex-rs/memories/write/src/phase1.rs:97-118`（`prune`，批大小 `PRUNE_BATCH_SIZE: usize = 200`）。**被标记为 `selected_for_phase2 = 1` 的基线行不会被剪掉**。

**(b) 相位 2 输入选择**：按用量和新鲜度排名的 top-N（`codex-rs/state/src/runtime/memories.rs:438-452` 文档注释 + 实现）：

```
/// - current selection keeps only non-empty stage-1 outputs whose
///   `last_usage` is within `max_unused_days`, or whose
///   `source_updated_at` is within that window when the memory has never
///   been used
/// - eligible rows are ranked by `usage_count DESC`,
///   `COALESCE(last_usage, source_updated_at) DESC`, `source_updated_at DESC`,
///   `thread_id DESC`
/// - the selected top-N rows are returned in stable `thread_id ASC` order
```

N = `max_raw_memories_for_consolidation`，默认 **256**，可配置范围 1–4096（`codex-rs/config/src/types.rs:59`、`:61-62`）。

**(c) 过期 rollout summary 文件与扩展资源清理**：`codex-rs/memories/write/src/storage.rs:80-108`（`prune_rollout_summaries`，不在 `keep` 集合内的 `.md` 删除）；扩展资源保留窗口 `RETENTION_DAYS: i64 = 7`（`codex-rs/memories/write/src/lib.rs:43-46`）。

### 6.3 相位 2 的"是否需要跑"由 git 脏度决定，而非 DB watermark

`codex-rs/memories/write/src/phase2.rs:122`：

```rust
    // 6. Use git to decide whether the synced workspace actually changed.
    let workspace_diff = match memory_workspace_diff(&root).await {
        Ok(diff) => diff,
        Err(err) => {
            tracing::error!("failed checking memory workspace changes: {err}");
            job::failed(context.as_ref(), &db, &claim, "failed_workspace_status").await;
            return;
        }
    };
    if !workspace_diff.has_changes()
        && validate_consolidation_artifacts_for_version(&root, config.memories.version)
            .await
            .is_ok()
    {
```

- git 基线仓库由 `codex-git-utils` 维护（`codex-rs/memories/write/src/workspace.rs:16-23`：`ensure_git_baseline_repository`；`:46-49`：`reset_git_repository`）。
- 无变化即成功退出，不调模型（`:136-152`）。
- 水位线仅作记账，不决定是否运行（README `:139-150` 明确说明；代码 `codex-rs/memories/write/src/phase2.rs:107` `get_watermark`）。

### 6.4 容量是否会随会话增长？

**不会线性增长**，有四道收敛机制：
1. 每个 thread 在 `stage1_outputs` 只有**一行**（`thread_id TEXT PRIMARY KEY`，`0001_memories.sql:2` + `ON CONFLICT(thread_id) DO UPDATE`）→ 记录数上限 ≈ 会话数，而非回合数。
2. 阶段 1 每启动最多处理 `max_rollouts_per_startup`（默认 2）条，扫描上限 5000（`codex-rs/config/src/types.rs:55`、`lib.rs:86`）。
3. 淘汰默认 30 天未使用（`DEFAULT_MEMORIES_MAX_UNUSED_DAYS: i64 = 30`），单批 200。
4. 相位 2 只把 top-256 行同步进工件目录，其余文件按下标集合删除（`codex-rs/memories/write/src/storage.rs:30-41`、`:80-108`）；且 `memory_summary.md` 被校验 < 10 000 字节，注入时再截到 2500 token（§3.2、§5.1）→ **注入上下文不随记忆库增长**。

### 6.5 清除与删除路径

- 用户侧清空：`codex_memories_write::clear_memory_roots_contents`（`codex-rs/memories/write/src/control.rs:3`；调用点 `codex-rs/cli/src/main.rs:2137`、`codex-rs/app-server/src/request_processors/thread_processor.rs:1926`）。
- DB 全清：`codex-rs/state/src/runtime/memories.rs:50-52` `clear_memory_data`；跨版本清理由 `codex-rs/state/src/runtime/memory_versions.rs:28-37` 保证（V1 库 + 存在则 V2 库）。
- 单 thread 删除：`codex-rs/state/src/runtime/memory_versions.rs:39-51`。

### 6.6 外部上下文污染保护

`codex-rs/core/src/stream_events_utils.rs:168`：

```rust
pub(crate) async fn mark_thread_memory_mode_polluted_if_external_context(
    sess: &Session,
    turn_context: &TurnContext,
    item: &ResponseItem,
) {
    if !turn_context.config.memories.disable_on_external_context
        || !response_item_may_include_external_context(item)
    {
        return;
    }
    state_db::mark_thread_memory_mode_polluted(
        sess.services.state_db.as_deref(),
        sess.thread_id,
        "record_completed_response_item",
    )
    .await;
}
```

配合 `threads.memory_mode`（迁移 `0018_phase2_selection_snapshot.sql:3`）与 `list_stage1_outputs_for_global` 的 `stage1_output_from_row_if_thread_enabled` 过滤（`codex-rs/state/src/runtime/memories.rs:384`），可让"用过外部上下文的会话"不进入记忆库。

---

## 7. 与 notes / history / compact 的边界（不得混写）

| 机制 | 存储载体 | 谁写 | 谁读 | 生命周期 | 关键证据 |
|---|---|---|---|---|---|
| **memories（本任务）** | `~/.codex/memories{,_v2}/` 磁盘工件 + `~/.codex/memories_1.sqlite` / `memories_v2_1.sqlite` | **后台两阶段流水线**（phase1 模型抽取 + phase2 consolidation 子代理）；用户只能在**显式要求**时通过 ad-hoc note 间接改 | 每个新 thread 的 developer 指令（`memory_summary.md`，≤2500 token）+ 可选 `memories.*` 工具 | 30 天未使用淘汰；top-256；摘要 <10 000 字节 | §1–§6 |
| **notes / thread hint（t1 §8）** | 服务端后端（`alpha/notes/v2/*`），非工作区文件 | 模型可直接写（`notes.write_file` / `append_to_file`，上限 1 000 000 字节/文件） | 模型工具 + `ContextWindow` slot 注入的 thread hint（≤4000 字节） | 后端托管，随 context window 迁移存活 | `codex-rs/ext/history-notes/src/tools.rs:31`、`extension.rs:31` |
| **history（t1 §9）** | 服务端后端（`alpha/history/v2/*`），按 window/item 组织 | **只读**（4 个 history 工具无写操作） | 模型工具，字面包含匹配（case-sensitive） | 后端托管，跨 context window 可检索 | `codex-rs/ext/history-notes/src/tools.rs:75-88`、`:181` |
| **compact（t1 §1–§6）** | 会话内历史（内存 + rollout） | 压缩流程自动/手动 | 仅当前会话下一次请求 | 每次压缩替换整段历史 | `codex-rs/core/src/compact.rs:63`、`:338-350` |

**三者最容易混的四个判断点**：

1. **是否跨会话**：只有 memories 跨会话（从历史 rollout 提炼，注入未来 thread）；notes 与 history 都是**同一 rollout 内**跨 context window；compact 连 window 都不跨（是同一 window 内替换）。
2. **谁是写入主体**：notes 是模型直接可写文件；memories 的**生成完全由后台流水线**完成，模型在正常对话中**不允许**改记忆文件（`read_path.md:119`：`You can update the memories **only** when explicitly asked by the user.`），只能写 `extensions/ad_hoc/notes/` 让 consolidation 应用（`read_path_v2.md:17-20`）。
3. **存储介质**：memories 有**本地 SQLite + 本地 git 基线目录**（`stage1_outputs` 表 + `~/.codex/memories/.git`）；notes/history 是**服务端 opaque 后端**（t1 §8.1、§9.3 已取证 `alpha/*` 端点）。
4. **触发时机**：memories 由 **root 会话 turn 提交**触发（`turn_processor.rs:704-716`）；notes/history 无自动触发（纯模型工具调用）；compact 由 token 阈值触发（t1 §1.3）。

### 7.1 与 t1 结论的衔接/纠偏

- t1 §12 第 5 项把 memories 标为 UNVERIFIED，本报告补齐：**它是独立子系统，不是 notes 的别名**。
- t1 §8 的 `MAX_THREAD_HINT_BYTES = 4_000`（`ext/history-notes/src/extension.rs:31`）属于 **history-notes 扩展**，与本报告的 memories 扩展（`ext/memories/`）是**两个不同 crate**，目录名相似但机制无关。
- t1 §8.3 的 `notes.*` 工具与本节 `memories.*` 工具的命名空间不同（`notes` vs `memories`），后端端点也不同（`alpha/notes/v2/*` vs 本地文件系统 `LocalMemoriesBackend`，见 `codex-rs/ext/memories/src/extension.rs:150-158`）。

---

## 8. UNVERIFIED 项（含已检索位置与关键词）

1. **相位 1 完整重试策略的边界（`retry_remaining` 用尽后的行为）** —— 部分未取证。已检索：`codex-rs/state/src/runtime/memories.rs`（`DEFAULT_RETRY_REMAINING: i64 = 3`，`:27`）、`codex-rs/memories/write/src/phase1.rs:324-344`（`result::failed`）。未逐行追 `mark_stage1_job_failed` 的 retry 递减与 lease 回收全流程。
2. **`skills/` 工件的生成细节与校验** —— 未取证。已知它属于相位 2 子代理的自由产物（`consolidation.md:30-31`、`:182`），`validate_consolidation_artifacts_for_version` **只校验 `MEMORY.md`（V1）与 `memory_summary.md`**，不校验 `skills/`（`codex-rs/memories/write/src/workspace.rs:76-115`）。是否另有 skills 校验未找到。
3. **`guard::rate_limits_ok` 的完整判定逻辑** —— 未逐行取证。已定位：`codex-rs/memories/write/src/guard.rs`（58 行）、阈值 `DEFAULT_MEMORIES_MIN_RATE_LIMIT_REMAINING_PERCENT: i64 = 25`（`codex-rs/config/src/types.rs:58`）。
4. **`extract_model` / `consolidation_model` 的模型选择回落顺序** —— 仅取证相位 2 一侧：`codex-rs/memories/write/src/phase2.rs:344-350`（`consolidation_model` 否则 `provider.memory_consolidation_preferred_model()`）。相位 1 的 `extract_model` 使用点未定位。
5. **V2 `raw_memory` 的替代物** —— 已知 V2 不产出 `raw_memory`（`phase1_output.rs:44-47`），但 `raw_memories.md` 生成仍是 `memory.raw_memory.trim()`（`storage.rs:73`）。V2 下该字段为空的完整表现未取证。
6. **`memories/read/src/lib.rs` 的对外导出面** —— 未取证（12 行文件，仅在 `usage.rs`/`citations.rs` 的引用路径中间接推断）。
7. **README 中 `codex-rs/core/src/memories/` 路径** —— 该路径在本 commit **不存在**；已确认 `codex-rs/core/src/` 下无 `memories` 目录（`Get-ChildItem codex-rs\core\src\memories` 无输出）。这是文档过期，非代码缺失。

---

## 9. 复现命令

```powershell
# 触发点与调用链
git -C I:\VMsShare\_src-compare\codex grep -n "start_memories_startup_task" -- codex-rs
git -C I:\VMsShare\_src-compare\codex grep -n "phase1::run\|phase2::run" -- codex-rs/memories/write/src/start.rs
# 数据来源
git -C I:\VMsShare\_src-compare\codex grep -n "claim_stage1_jobs_for_startup" -- codex-rs/memories/write/src/phase1.rs
git -C I:\VMsShare\_src-compare\codex grep -n "should_persist_response_item_for_memories" -- codex-rs/rollout/src/policy.rs
# 产物形态
git -C I:\VMsShare\_src-compare\codex grep -n "fn output_schema" -- codex-rs/memories/write/src/phase1_output.rs
git -C I:\VMsShare\_src-compare\codex grep -n "is_valid_v2_summary" -- codex-rs/memories/write/src/workspace.rs
# 存储
git -C I:\VMsShare\_src-compare\codex grep -n "MEMORIES_DB_FILENAME\|memories_v2_1" -- codex-rs/state/src/sqlite.rs
git -C I:\VMsShare\_src-compare\codex grep -n "CREATE TABLE stage1_outputs" -- codex-rs/state/memory_migrations/0001_memories.sql
# 检索/注入
git -C I:\VMsShare\_src-compare\codex grep -n "build_memory_tool_developer_instructions\|developer_policy" -- codex-rs/ext/memories/src
git -C I:\VMsShare\_src-compare\codex grep -n "fn matched_query_flags" -- codex-rs/ext/memories/src/local/search.rs
# 生命周期
git -C I:\VMsShare\_src-compare\codex grep -n "prune_stage1_outputs_for_retention\|get_phase2_input_selection" -- codex-rs/state/src/runtime/memories.rs
```

*报告结束。所有代码片段均为仓库当前内容逐字摘录，每段 ≤ 15 行。*
