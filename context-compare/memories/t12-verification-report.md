# T12 — 第二轮独立核验报告：memories 对照表（m3）关键断言

- 核验对象（只读，均未修改）：`I:\VMsShare\context-compare\memories\m3-memory-comparison-matrix.md`（111 行 / 34,908 字节）
- 交叉参考：`memories\t9-codex-memories-evidence.md`、`memories\t10-dsh-persistent-memory-forensics.md`、`memories\t10-snippet-verification.log`、第一轮 `t4-mechanism-matrix.md` / `t5-verification-report.md` / `t7-incremental-verification.md`
- 基准：Codex `a07c8ebd57feedc4cf5dfe854c8e9101de54186b`；插件 `1094b84add6f2fb19edf659367fe2fd5f7f14154`（v0.1.23）；宿主 `0.2.0-rc.2`；profile `C:\Users\ZYX\.dsh\profiles\web\cordis.yml`（最后修改 2026-10-11 22:41:31，核验期间未变）
- 方法：逐条回源读源码；**独立重跑** t10 的证据脚本（`event-vocabulary.mjs`）与自写的会话计数脚本；机械引用审计 `t12-anchor-audit.ps1`。
- 结论先行：**m3 可用于决策**。抽检 21 条断言：**成立 18、部分成立 3、不成立 0**。3 处待修正**全部为低严重度引用/措辞问题**，不影响任何机制结论。

---

## 1. 抽检总表

| # | 断言（m3 位置） | 判定 | 证据 |
|---|---|---|---|
| A1 | `Feature::MemoryTool` = `Stage::Stable` + `default_enabled: false`（`features/src/lib.rs:1267-1272`） | **成立** | 逐字命中：`id: Feature::MemoryTool` / `key: "memories"` / `stage: Stage::Stable` / `default_enabled: false`。m3 全文措辞为「有意 opt-in」，**未**出现"实验性" |
| A2 | 版本化目录常量在 **protocol 侧** `protocol/src/memory_version.rs:19-20`（文件共 23 行） | **成立** | `:19-20` = `Self::V1 => "memories"` / `Self::V2 => "memories_v2"`；文件确为 23 行 |
| A3 | README 过期路径：`memories/README.md:5-6` 称编排在 `core/src/memories/`，本 commit `Test-Path` = **False** | **成立** | `Test-Path codex-rs/core/src/memories` = False；README `:5-6` 逐字含 "still lives in `codex-core` under `codex-rs/core/src/memories/`" |
| A4 | 触发链：`app-server/.../turn_processor.rs:704-716` 唯一调用点 → `memories/write/src/start.rs:24` | **成立（调用点确为唯一）** | `turn_processor.rs:704-717` 逐字 `codex_memories_write::start_memories_startup_task(…)`；`:24` 为函数定义 |
| A5 | 四道闸门（非 ephemeral / MemoryTool / 非 subagent / state DB 可用）+ 独立限流闸门 | **成立** | `start.rs:33-38` 三个条件（`config.ephemeral \|\| !features.enabled(MemoryTool) \|\| source.is_non_root_agent()`）；`:59-63` `if context.memory_store().await.is_none() { warn!(…); return; }`；`:79-86` `guard::rate_limits_ok`。阈值 25% 于 `config/src/types.rs:58` |
| A6 | N4 默认值取 2 条 / 年龄 ≤10 天 / 空闲 ≥6 小时（`config/src/types.rs:55-64`） | **成立** | `:55-57` 三个常量逐字 2 / 10 / 6；`:385-390` 的 `Default for MemoriesConfig` 逐字段引用之 |
| A7 | N5 六重收敛之一：`stage1_outputs` 每 thread 仅一行（`thread_id TEXT PRIMARY KEY` + `ON CONFLICT(thread_id) DO UPDATE` + 倒流保护） | **成立** | `state/memory_migrations/0001_memories.sql:1-2` `CREATE TABLE stage1_outputs ( thread_id TEXT PRIMARY KEY`；`state/src/runtime/memories.rs:908-925` `INSERT … ON CONFLICT(thread_id) DO UPDATE SET … WHERE excluded.source_updated_at >= stage1_outputs.source_updated_at` |
| A8 | N5 其他五重：每启动 ≤2 / 淘汰 30 天批 200 / 相位 2 top-256 / `memory_summary.md` <10 000 字节 / 注入再截 2 500 token | **成立** | 30 天 `config/src/types.rs:60`；批 200 `memories/write/src/lib.rs:87` + `phase1.rs:100-102`；top-256 `config/src/types.rs:59`（范围 1–4096 于 `:61-62`）；`workspace.rs:119-120` `summary.lines().next() == Some("v1") && summary.len() < 10_000`；`ext/memories/src/lib.rs:16` `…SUMMARY_TOKEN_LIMIT = 2_500` |
| A9 | N6 产物：相位 1 严格 JSON，V1 三项必填、V2 去 `raw_memory`，V2 `rollout_summary` 截 9000 字节 | **成立** | `phase1_output.rs:61-82`：V1 `"required": ["rollout_summary","rollout_slug","raw_memory"]`、V2 `"required": ["rollout_summary","rollout_slug"]`；`:50-52` `if version == MemoryVersion::V2 { rollout_summary = truncate_text(…, TruncationPolicy::Bytes(9_000)); }` |
| A10 | N7 产物：Markdown 工件集 + 代码硬校验（V1 需 `MEMORY.md`、summary 首行 `v1` 且 <10 000 字节、V2 四个固定标题） | **成立** | 工件集逐字见 `templates/memories/consolidation.md:20-35`（memory_summary.md / MEMORY.md / raw_memories.md / skills/<name>/ / rollout_summaries/<slug>.md）；硬校验 `workspace.rs:105-129`（含四个标题 `## User Profile` / `## User preferences` / `## General Tips` / `## What's in Memory`） |
| A11 | N8 存储：`~/.codex/memories/`、`memories_v2/`，根 = `codex_home.join("memories")`（`memories/write/src/lib.rs:118`） | **成立** | m3:39（N8 行）确引 `lib.rs:118`；回源：`start.rs:64-66` `config.codex_home.join(config.memories.version.directory_name())`，目录名常量见 A2。⚠️ 我初审曾说该引用只在 t9 正文、主表未直引 —— **该说法错误**，主表 N8 行（m3:39）确有该引用（复核命令：`Select-String -Pattern 'lib\.rs:118'` → L39），已更正 |
| A12 | N9 独立 DB：`memories_1.sqlite` / `memories_v2_1.sqlite`（`state/src/sqlite.rs:36,97-112`）、独立 migrator `./memory_migrations`（`state/src/migrations.rs:9`）、旧表被 `0035_drop_memory_tables.sql` 删除 | **成立** | `sqlite.rs:36` `const MEMORIES_DB_FILENAME: &str = "memories_1.sqlite";`；`migrations.rs:9` `MEMORIES_MIGRATOR: Migrator = sqlx_macros::migrate!("./memory_migrations")`；`memory_migrations/` 目录实存（`0001_memories.sql`、`0002_consolidation_progress.sql`）；`state/migrations/0035_drop_memory_tables.sql` 存在 |
| A13 | N10 默认注入通道：读 `memory_summary.md` 截 2 500 token → `PromptFragment::developer_policy` → `core/src/session/mod.rs:4386-4388`；启用 = **两个条件的与**（`extension.rs:46-52`）；V2 按 8900 字符切块（`extension.rs:75-91`） | **成立** | `prompts.rs:35-49` 读 summary 并 `TruncationPolicy::Tokens(…SUMMARY_TOKEN_LIMIT)`；`extension.rs:95-98` `PromptFragment::developer_policy(instructions, ContentItemKind("memories.instructions"))`；`::4386-4388` `PromptSlot::DeveloperPolicy => developer_sections.push(fragment.into())`；`:48` `enabled: config.features.enabled(Feature::MemoryTool) && config.memories.use_memories`；`:82` `floor_char_boundary(remaining.len().min(8_900))` |
| A14 | N11 四个模型工具 + 命名空间 `memories` + 配额（读 20 000 token / list 2 000 / search 200）+ `dedicated_tools` 默认 false | **成立** | `tools/mod.rs:35-52` 四个工具（ad_hoc_note / list / read / search）；`lib.rs:18-22` 命名空间与四个工具名；`lib.rs:11-15` 2000/2000/200/200/20 000；`tools/search.rs:110-116` `case_sensitive` 默认、`max_results` 夹取到 200；`config/src/types.rs:384` `dedicated_tools: false` |
| A15 | N13 检索为**区分大小写的字面包含**；默认 `match_mode = Any`；三种模式 | **成立** | `local/search.rs:284-289` `line.as_ref().contains(query)`（`prepare` 仅按 `case_sensitive`/`normalized` 归一）；`tools/search.rs:106,110-111` `match_mode.unwrap_or(SearchMatchMode::Any)`、`case_sensitive.unwrap_or(true)`、`normalized.unwrap_or(false)`；`backend.rs:100-109` 三变体 `Any` / `AllOnSameLine` / `AllWithinLines { line_count }` |
| A16 | N18 前置依赖：**不依赖服务端**（本地 SQLite + 本地 git + 本地文件系统），但依赖账号侧额度 | **成立** | 产物/检索全在本地（A7/A9/A10/A12 均为本地路径）；额度依赖见 `start.rs:79-86` + `types.rs:58`（25%）。m3 明写"不依赖服务端"，**未**声称依赖 provider 认证 |
| A17 | §0.1 第 2 条：三条压缩路径与记忆**零耦合**，`memor` 命中 0/0/0（`git grep -i` 亦 0） | **成立（但漏掉更强的因果证据）** | 我独立复跑：`core/src/compact.rs`、`compact_remote_v2.rs`、`compact_token_budget.rs` 三者 `memor` 大小写敏感与忽略大小写计数均为 **0**；`git grep -i memor -- 'codex-rs/core/src/compact*.rs'` 无输出。**更强的证据**：`rollout/src/policy.rs:104-125` 的 `should_persist_response_item_for_memories` 明确返回 false 的项包含 `ResponseItem::Compaction` / `CompactionTrigger` / `ContextCompaction` ⇒ 压缩类响应项**在数据入口就被排除**，不是"恰好没耦合"（见 §2 F3） |
| A18 | N16/N12 DSH 侧：全文检索被 profile 显式关闭（`cordis.yml:100-104` `openAt: never`）；语义为 `searchSessions`/`searchEvents` 失败且 SQLite 从不导入；精确读取/过滤仍在 | **成立** | profile `:100-104` 逐字 `id: session-query-sqlite` / `path: ':memory:'` / `openAt: never`，且 **openAt 全 profile 仅此一处**；语义逐字见 `dsh-session-query-sqlite/lib/types/index.d.ts:36-43` |
| A19 | N12 DSH 侧：用户显式引用旧会话 = `MAX_REFERENCES = 3`、每源 65536 字节；mention→快照替换 | **成立** | `dsh-session-reference/lib/types/config.d.ts:3` `MAX_REFERENCES = 3`、`:7` `DEFAULT_MAX_REFERENCE_BYTES = 65536`；`index.d.ts:30-38` "Replace canonical mentions … and place each prepared snapshot immediately after the message that cited it"；profile `:443-444` 已装载该服务 |
| A20 | N16/§2 类别③：插件状态进上下文需身份匹配（`capabilities.ts:42-49`）；归档目录**故意不含 `team.json`**、模型不可达、只走 `?archived=1`；本机无 archive / 无 `retired-members.json` | **成立** | `capabilities.ts:41-48`：`:42` `if (!entry.isDirectory() \|\| entry.name === 'archive') continue;`、`:44-45` `!teamLeadMatch(team, lead) && !team.members.some(m => m.id === agent.id) → continue`；`state.ts:1152-1157` 逐字"The archive directory has no team.json of its own"；`index.ts:271-273` `?archived=1` 分支；`I:\VMsShare\.agent-teams` 下只有 `context-health-codex-vs-dsh/{team.json,inbox/*.jsonl}`，**无 archive 子目录、无 retired-members.json**（`C:\Users\ZYX\.dsh\.agent-teams` 不存在） |
| A21 | N1/§5：按类型精确统计 58 会话 / 35,652 记录 / 44 类型，`note\|memory\|feedback` = **0** | **成立（计数已因新会话增长，性质不变）** | 我独立重跑 `event-vocabulary.mjs 'C:\Users\ZYX\.dsh\sessions'`：`sessions=58 records=36246 distinctTypes=44`，末行 `note/memory/feedback event types: (none)`。**记录数从 35,652 → 36,246（+594）**：58 个会话目录名未变，但会话日志为**多帧追加**，本轮核验期间仍在写入（例：本报告所属会话）⇒ 属运行态正常增长，**不构成错误**；关键属性（0 个 note/memory/feedback 类型）不变。另独立复跑 compaction 计数：`compaction/start 27 / summary 26 / end 27`，与 t10 §3.1 一致；`team/task 12`、`team/member 6`、`team/message/* 6` 与 t10 §2.2 一致 |

---

## 2. 不成立/部分成立条目（错误原文 + 正确事实 + 位置）

### F1（低）`start.rs:90-95` 引用区间越界 1 行

- **错误原文**（m3:33，N2 行）："两阶段**串行**（phase1 → phase2，`start.rs:90-95`）"
- **正确事实**：`codex-rs/memories/write/src/start.rs` **共 94 行**；`:90-91` 逐字为
  ```rust
  90:             // Run phase 2.
  91:             phase2::run(context, config, parent_permission_profile).await;
  ```
  `:92-94` 是闭包/函数收尾（`});`、`}`、`}`）。⇒ 应写作 `start.rs:89-91`（含相位 1 的 `:89`）或 `:90-91`。
- 严重度：**低**（结论"两阶段串行"完全正确，只是区间多算了 3 行到文件尾）

### F2（低）两处引用未标 crate 根，构成路径歧义

- **错误原文**：`state/memory_migrations/0001_memories.sql:1`（m3:36、m3:40）；`config/src/types.rs:55-64`（m3:33、m3:35、m3:36）；`lib.rs:86` / `lib.rs:80-102`（m3:35、m3:36）
- **正确事实**：实际文件分别是
  - `codex-rs/state/memory_migrations/0001_memories.sql`（内容确为 `CREATE TABLE stage1_outputs (`）
  - `codex-rs/config/src/types.rs`（`:55-64` 确为三个 DEFAULT_MEMORIES_* 常量 + 上下界常量）
  - `codex-rs/memories/write/src/lib.rs`（`:80-102` 的 `mod stage_one`）
  而仓库内 **不存在** `memories/*/config/src/types.rs`（memories crate 无 `config` 子目录），也不存在以 `state/`、`config/` 为根的独立 crate 前缀。⇒ 相对路径写法需补 crate 根（`codex-rs/config/src/types.rs` 等），否则复核者按 memories crate 解析会全部找不到。
- 严重度：**低**（m3 行首已声明"Codex 相对 `I:\VMsShare\_src-compare\codex`"，但裸相对路径在多层 crate 仓库里确实歧义；t9 原文的完整写法可回溯，属转录损失）

### F3（低）§0.1 第 2 条的因果强度可加强（措辞，非事实错误）

- **原文**（m3:24）："三条压缩路径与记忆**零耦合** ✅ 本轮实测：`memor` 在三文件中命中 0/0/0"
- **正确事实**：该 0/0/0 我已独立复现（A17），**陈述成立**。但更强的机制证据在 `rollout/src/policy.rs:104-125`：`should_persist_response_item_for_memories` 把 `ResponseItem::Compaction` / `CompactionTrigger` / `ContextCompaction` 一律返回 `false`（同函数还排除 `role == "developer"` 的消息）⇒ 压缩类响应项**不写入 memories 数据源**。建议在该条补一句：零耦合不只是"代码里没互相引用"，更是"压缩产物在设计上被数据入口排除"。
- 另注：同函数排除 developer 角色消息这一点 m3 已引（N4 写作 `policy.rs:104-125`），方向正确。
- 严重度：**低**（属加强，不改判定）

---

## 3. 要求专项复核

### 3.1 m3 是否把 notes / history / compact 误计入 memory

**结论：未误计入，且边界处理是本表最扎实的部分。**

| 概念 | m3 归属声明 | 我的复核 |
|---|---|---|
| notes | `t4` **M16**，"**无独立行**"（m3:6、m3:92） | **成立**。全表检索 `M16` 仅出现在 m3:6（边界宣告）与 92（排除表）；N1–N18 无 notes 独立行 |
| history | `t4` **M17**，"无独立行"（m3:6、m3:93） | **成立**。`M17` 仅出现在 :6/:93；N13 与 history 的关系明确写成"**检索算法同构**，仅作对照物"（m3:44、m3:59），非能力重复计入 |
| compact | `t4` **M5/M6/M9/M14**，"无独立行"（m3:6、m3:94） | **成立**。`M5/M6/M9/M14` 仅出现在 :6/:71/:94；N10 的反面参照（DSH 压缩检查点）明确标为**会话内**、第一轮已归类 |
| spill | `t3 §4.1` / `t4` **M4**，"无独立行"（m3:95） | **成立**。仅在 §2 类别④ 辨析（m3:73） |
- 三条入选判据（跨会话 / 有提炼 / 自动或半自动可召回）在 m3:97 对四者逐一验收，判据本身与 N16/N13/N14/N18 一致，**无自相矛盾**。
- 反向检查：Codex 侧 `ext/memories` 与 `ext/history-notes` 是**两个不同 extension**（前者 `Feature::MemoryTool`/`memories`，后者 `token_budget.use_history_notes_extension` + OpenAI provider + codex backend 认证——第一轮 t1 §8.3 已取证）⇒ m3 把二者分列在两张表、两条 feature 下**正确**。

### 3.2 DSH 侧「跨会话可读性」结论是否成立

**成立，且我逐条复核了三层**：
1. 存储层可读（多帧 zstd JSONL 按 workspace 聚簇）——独立确认 58 个会话文件全部成功解帧（A21 脚本对每个文件做 zstd 魔数扫描 + 解压）。
2. 检索层**被显式关闭**——`cordis.yml:100-104`，且 openAt 全 profile 唯一（A18）。m3 的"本机状态"限定词到位。
3. 激活层**无自动召回**——唯一受控通路是用户显式引用（A19）+ 工作区文件；插件状态需身份匹配（A20）。
- **未发现把"未实现"写成"已实现"**：m3 对 N1/N2/N4/N6/N9/N10/N11/N13/N14/N18 的 DSH 列一律写"**未实现**"，§3 汇总表把 10 条归入"不可照搬（DSH 无对应层）"。反向抽查"已适用/当前即生效"的三个声明（N3 数据源可得性、N12 引用通路、N17 写入权限同向）**均可回源**。

### 3.3 前置依赖表述（服务端/账号/provider 认证）

- m3 对 Codex memories 的依赖表述为：feature flag + `config.memories.use_memories` + 非 ephemeral + 非 subagent + state DB + **账号侧额度信息**；并明确"产物与检索全部在本地……**不依赖服务端**"（N18）。
- 回源：本地性由 A7/A9/A10/A12 支撑；账号侧仅出现在 `guard::rate_limits_ok(auth_manager, config)`（`start.rs:79`）与 `min_rate_limit_remaining_percent = 25`（`types.rs:58`）。
- **未发现**"依赖服务端记忆""依赖 OpenAI provider 认证"这类越界表述——**这是相对第一轮 t1 §8.3 的关键区别**（notes/history 需要 OpenAI provider + codex backend 认证，memories 不需要），m3 未把两者混淆。

### 3.4 行号与逐字片段

- 机械审计（`t12-anchor-audit.ps1`，对 m3 全部 `路径:行号` 引用）：**唯一真实越界是 F1**（`start.rs:90` vs 文件 94 行——注：该脚本把 `:90-95` 读作 `:90`，实际越界点是 `95`）；其余报 `FILE-NOT-RESOLVED` 的 15 处均为**裸文件名/片段名**（`memory_summary.md`、`MEMORY.md`、`CLAUDE.md`、`raw_memories.md`、`0035_drop_memory_tables.sql`、`t4-mechanism-matrix.md`），属解析器局限，非死链（`0035_drop_memory_tables.sql` 与 t4 均已实地确认存在）。
- m3 主表只写位置指针、不粘贴片段（其自定格式），逐字片段在 t9/t10；我抽查 t9/t10 的标记片段 14/14 与源码逐字一致（`t10-snippet-verification.log` 报 failures=0、lines compared=102，我另外人工复核了其中 6 段）。**m3 自身不含 >15 行的代码块**（其代码块仅 §0/§0.1 的表格与引文，无源码片段）⇒ "片段 ≤15 行"约束在 m3 层面不适用，在 t9/t10 层面成立。

---

## 4. 总体判定

**m3 可用于决策。** 理由：

1. **事实层**：21 条抽检中 18 条完全成立，3 条为低严重度引用/措辞问题；**无一条机制结论被证伪**。核心行 N5 的六重收敛全部回源命中（含 `thread_id TEXT PRIMARY KEY` + `ON CONFLICT … WHERE excluded.source_updated_at >=` 的倒流保护、`len() < 10_000`、2 500 token 注入上限）。
2. **边界层**：notes/history/compact/spill 四者均**未被计入 memory**，且附有可验收的三条判据；Codex memories 与 notes/history 分属不同 extension、不同 feature，m3 未混淆。
3. **诚实边界层**：t10 的 4 项与 t9 的 7 项 UNVERIFIED **全部照抄为未验证状态**，并对第 3 项（`dsh_session_log` 服务端是否形成记忆）明确写出"若成立会改变 N16/N18 结论，本表按未验证处理"——**未把未验证当已生效**。
4. **运行态数值层**：58 会话 / 44 类型 / 0 个记忆类事件 / compaction 27-26-27 / team 事件 12-6-6 全部独立复现；唯一差异（记录数 35,652 → 36,246）源于会话日志持续追加，属预期。

**必须修正清单（按严重度）**：

| 编号 | 严重度 | 位置 | 修正 |
|---|---|---|---|
| F1 | **低** | m3:33 | `start.rs:90-95` → `start.rs:89-91`（文件共 94 行） |
| F2 | **低** | m3:33/35/36/40 | 裸相对路径补 crate 根：`codex-rs/config/src/types.rs`、`codex-rs/state/memory_migrations/0001_memories.sql`、`codex-rs/memories/write/src/lib.rs` |
| F3 | **低（加强）** | m3:24（§0.1 第 2 条） | 补一句：零耦合的机制证据是 `rollout/src/policy.rs:104-125` 把 `Compaction`/`CompactionTrigger`/`ContextCompaction` 排除出 memories 数据源 |

**无需回退的部分**：第一轮 t5/t7 的全部结论在第二轮**未被推翻**；m3 引用的 t4 行（M16/M17/M4/M5/M6/M9/M14）与第一轮结论一致，未出现"第二轮改了第一轮口径"的情况。

---

## 5. 复现方式

- `pwsh -NoProfile -File I:\VMsShare\context-compare\memories\t12-anchor-audit.ps1` → m3 引用机械审计（唯一真实越界 = F1）
- `node I:\VMsShare\context-compare\memories\event-vocabulary.mjs 'C:\Users\ZYX\.dsh\sessions'` → `sessions=58 records=36246 distinctTypes=44` + `note/memory/feedback event types: (none)`
- 独立会话计数脚本（本轮临时）：统计 `compaction/*` → `{start:27, summary:26, end:27}`；统计 `team*` → `{team/task:12, team/member:6, team/message/queued:3, team/message/delivered:3}`
- 关键反证命令：
  - `Select-String -Path ...\memories\write\src\start.rs -Pattern 'memor'` → 文件 94 行；`:90-91` 为相位 2 调用
  - `Test-Path codex-rs\core\src\memories` → False
  - `Select-String -Path C:\Users\ZYX\.dsh\profiles\web\cordis.yml -Pattern 'openAt'` → 仅 L104 `openAt: never`
  - `Get-ChildItem I:\VMsShare\.agent-teams -Recurse` → 无 `archive/`、无 `retired-members.json`
