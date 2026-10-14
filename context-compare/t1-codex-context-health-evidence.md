# t1 — Codex 上下文健康机制取证报告

- **仓库**: `openai/codex` 本地克隆 `I:\VMsShare\_src-compare\codex`
- **commit（实测）**: `a07c8ebd57feedc4cf5dfe854c8e9101de54186b`，committer date `2026-10-11T12:38:29Z`，subject `Handle broken pipes gracefully in plugin list output (#53109)`
  - 取证命令: `git -C I:\VMsShare\_src-compare\codex log -1 --format='%H %cI %s'`
  - ⚠️ 任务描述里写的日期 `2026-10-11` 与 commit 一致；视频报告所依据的版本未指定，本报告所有结论以该 commit 为准。
- **方法**: 只读。全部证据用 grep/read 直接读工作区文件；未执行构建、未运行测试、未修改任何文件。
- **路径约定**: 所有路径均为**相对仓库根**的 POSIX 路径（仓库根 = 上面那个克隆目录）。
- **注意（版本落差）**: 该 commit 的 Codex 已经比视频报告描述的形态复杂很多（有 `codex-rs/ext/*` 扩展体系、token budget feature、history/notes 后端工具、remote compaction v2）。报告中多条结论与代码不符，见文末 §11。

---

## 1. 自动压缩：触发条件、发生位置、config limit 与默认比例取 min

### 1.1 触发阈值 = min(model 默认 90% 窗口, config 覆盖值)

`codex-rs/protocol/src/openai_models.rs:529`（同一 impl 内 `resolved_context_window` 在 :518，`usable_context_window` 在 :523）：

```rust
    pub fn auto_compact_token_limit(&self) -> Option<i64> {
        let context_limit = self
            .resolved_context_window()
            .map(|context_window| (context_window * 9) / 10);
        let config_limit = self.auto_compact_token_limit;
        if let Some(context_limit) = context_limit {
            return Some(
                config_limit.map_or(context_limit, |limit| std::cmp::min(limit, context_limit)),
            );
        }
        config_limit
```

- 默认比例就是 **9/10 = 90%**，硬写在代码里；documented 语义见同文件 `:460-464` 的注释（"derives it from `context_window` (90%). When provided, core clamps it to 90% of the context window"）。
- **`min` 的实际实现就是 `std::cmp::min(limit, context_limit)`**（`:536`）。注意：当 config 传了 limit 时也会被 90% 上限夹住——所以"config 覆盖"并不能把阈值抬到 90% 以上。

### 1.2 `Total` 与 `BodyAfterPrefix` 两种 scope 走的是不同分支（容易被误读）

`codex-rs/core/src/session/context_window.rs:61`：

```rust
    let (auto_compact_scope_tokens, auto_compact_scope_limit, auto_compact_window_prefill_tokens) =
        match config.model_auto_compact_token_limit_scope {
            AutoCompactTokenLimitScope::Total => (
                active_context_tokens,
                model_info.auto_compact_token_limit(),
                None,
            ),
            AutoCompactTokenLimitScope::BodyAfterPrefix => {
                let window = sess.auto_compact_window_snapshot().await;
                let baseline = window.prefill_input_tokens.unwrap_or(active_context_tokens);

                let scope_limit = config
                    .model_auto_compact_token_limit
                    .or_else(|| model_info.auto_compact_token_limit());
```

- `Total` 分支直接把 config 值塞进 `ModelInfo.auto_compact_token_limit`（`codex-rs/models-manager/src/model_info.rs:29-31`：`model.auto_compact_token_limit = Some(auto_compact_token_limit)`），因此 `min` 生效。
- `BodyAfterPrefix` 分支读的是 `config.model_auto_compact_token_limit`，config 优先、缺省才回落 model 值，**没有在 core 侧重做 min**。这是一个真实的语义差异，值得在对照表里单列。

### 1.3 三个触发点（PreTurn / MidTurn / PostTurn）

**(a) PreTurn** — `codex-rs/core/src/session/turn.rs:1304`：

```rust
async fn run_pre_sampling_compact(
    sess: &Arc<Session>,
    turn_context: &Arc<TurnContext>,
    client_session: &mut ModelClientSession,
    cancellation_token: &CancellationToken,
) -> CodexResult<()> {
    maybe_run_previous_model_inline_compact(sess, turn_context, client_session, cancellation_token)
        .await?;
    let token_status =
        super::context_window::context_window_token_status(sess.as_ref(), turn_context.as_ref())
            .await;
    // Compact if the configured auto-compaction budget or usable context window is exhausted.
    if token_status.token_limit_reached {
```

→ 触发条件 `token_status.token_limit_reached`（`:1316`），随后在 `:1321-1329` 调用 `run_auto_compact(..., CompactionPhase::PreTurn)`。

**(b) MidTurn** — `codex-rs/core/src/session/turn.rs:609`：

```rust
                let should_roll_over = needs_follow_up
                    && (sess.take_new_context_window_request().await || token_limit_reached);
                let allow_auto_compact_fallback = !should_roll_over && !token_limit_reached;
```
→ `:621-629` `if should_roll_over { ... run_auto_compact(..., CompactionPhase::MidTurn) }`，与 `needs_follow_up`（`:574`：`model_needs_follow_up || has_pending_input`）绑定，即在一次采样+工具执行之后、还有后续步骤时压缩。

**(c) PostTurn** — `codex-rs/core/src/session/turn.rs:719`：

```rust
                    let config = &turn_context.config;
                    if config.model_post_turn_compact_threshold_percent > 0
                        && !config.features.enabled(Feature::TokenBudget)
                        && super::context_window::context_window_token_status(
```
→ `:730-737` 在回合结束时再压一次，phase = `PostTurn`。阈值默认 **0（关闭）**：`codex-rs/core/src/config/mod.rs:4355-4357` 用 `unwrap_or_default()`，而 `codex-rs/config/src/config_toml.rs:191` 的类型是 `Option<u8>`。

### 1.4 `token_limit_reached` 的完整口径（含 fallback buffer 与硬窗口）

`codex-rs/core/src/session/context_window.rs:102`：

```rust
    let buffered_auto_compact_limit = auto_compact_scope_limit
        .map(|limit| limit.saturating_add(auto_compact_fallback_buffer_tokens));

    // Force compaction once the buffered window or the model's full context window is reached.
    let full_context_window_limit_reached =
        full_context_window_limit.is_some_and(|limit| active_context_tokens >= limit);
    let token_limit_reached = buffered_auto_compact_limit
        .is_some_and(|limit| auto_compact_scope_tokens >= limit)
        || full_context_window_limit_reached;
```

- `full_context_window_limit` = `resolved_context_window * effective_context_window_percent / 100`（`:84-86`），而 `effective_context_window_percent` 默认 **95**（`codex-rs/protocol/src/openai_models.rs:393` `const fn default_effective_context_window_percent() -> i64 { 95 }`）。
- 也就是说存在两个不同的百分比：**压缩阈值 90%（模型 auto-compact 默认）** 与 **可用窗口 95%（硬上限）**。
- **视频报告称 "约 90% 触发自动压缩" 与代码一致**；`95%` 是另一件事（见 §11 备注）。

---

## 2. 长工具输出截断：保留首尾、省略中间

### 2.1 入口与策略

`codex-rs/utils/output-truncation/src/lib.rs:36`：

```rust
pub fn truncate_text(content: &str, policy: TruncationPolicy) -> String {
    match policy {
        TruncationPolicy::Bytes(bytes) => truncate_middle_chars(content, bytes),
        TruncationPolicy::Tokens(tokens) => truncate_middle_with_token_budget(content, tokens).0,
    }
}
```

`codex-rs/utils/string/src/truncate.rs` 文件头注释即写明策略：`//! Utilities for truncating large chunks of output while preserving a prefix` / `//! and suffix on UTF-8 boundaries.`（:1-2）。

### 2.2 "保留首尾"的**实际参数**：左右各一半

`codex-rs/utils/string/src/truncate.rs:156`：

```rust
fn split_budget(budget: usize) -> (usize, usize) {
    let left = budget / 2;
    (left, budget - left)
}
```

即**不是**常见的"首 70% / 尾 30%"，而是预算对半分（奇数时右侧多 1 字节）。省略标记见同文件 `:162`：`format!("…{removed_count} tokens truncated…")` / `"…{removed_count} chars truncated…"`。

### 2.3 预算超出时的包装格式与序列化余量

`codex-rs/utils/output-truncation/src/lib.rs:23`：

```rust
pub fn formatted_truncate_text(content: &str, policy: TruncationPolicy) -> String {
    if content.len() <= policy.byte_budget() {
        return content.to_string();
    }

    let original_token_count = approx_token_count(content);
    let total_lines = content.lines().count();
    let result = truncate_text(content, policy);
    format!(
        "Warning: truncated output (original token count: {original_token_count})\nTotal output lines: {total_lines}\n\n{result}"
    )
}
```

`with_serialization_allowance` 额外放宽 20%，见 `codex-rs/utils/output-truncation/src/lib.rs:17`：

```rust
/// Adds the existing 20% allowance for serialization and headers.
/// Saved history budgets already include this allowance.
pub fn with_serialization_allowance(policy: TruncationPolicy) -> TruncationPolicy {
    policy * 1.2
}
```

### 2.4 默认预算常量（10 KiB）与 `tool_output_token_limit` 覆盖

`codex-rs/models-manager/src/model_info.rs:126`：`truncation_policy: TruncationPolicyConfig::bytes(/*limit*/ 10_000),`（`local_model_info()` 的默认值）。

覆盖路径 `codex-rs/models-manager/src/model_info.rs:32`：

```rust
    if let Some(token_limit) = config.tool_output_token_limit {
        model.truncation_policy = match model.truncation_policy.mode {
            TruncationMode::Bytes => {
                let byte_limit =
                    i64::try_from(approx_bytes_for_tokens(token_limit)).unwrap_or(i64::MAX);
                TruncationPolicyConfig::bytes(byte_limit)
            }
            TruncationMode::Tokens => {
                let limit = i64::try_from(token_limit).unwrap_or(i64::MAX);
                TruncationPolicyConfig::tokens(limit)
            }
        };
    }
```

### 2.5 多段 content items 的"省略中间项"

非文本（图片/音频/加密）条目不属于截断对象，但**文本/音频条目被整体丢弃时**会插入计数标记：

`codex-rs/utils/output-truncation/src/lib.rs:240`：

```rust
    if omitted_text_items > 0 {
        out.push(FunctionCallOutputContentItem::InputText {
            text: format!("[omitted {omitted_text_items} text items ...]"),
        });
    }
    if omitted_audio_items > 0 {
        out.push(FunctionCallOutputContentItem::InputText {
            text: format!("[omitted {omitted_audio_items} audio items ...]"),
        });
    }
```

`approx_bytes_for_tokens` 的换算是 **4 字节 = 1 token**：`codex-rs/utils/string/src/truncate.rs:4` `const APPROX_BYTES_PER_TOKEN: usize = 4;`。

### 2.6 代码模式下的同类截断（head/tail 缓冲，另一处实现）

`codex-rs/core/src/unified_exec/head_tail_buffer.rs`（150 行，`codex-rs/core/src/unified_exec/head_tail_buffer_tests.rs` 为测试）——长驻进程输出走的是 head/tail ring buffer，而不是 `truncate_text`。属于同一维度但实现独立，建议对照表里注明"两条截断路径"。

---

## 3. 交接摘要（handoff summary）：prompt 构造、调用位置、续作说明

### 3.1 prompt 本体就是模板文件

`codex-rs/prompts/src/compact.rs:1-2`：

```rust
pub const SUMMARIZATION_PROMPT: &str = include_str!("../templates/compact/prompt.md");
pub const SUMMARY_PREFIX: &str = include_str!("../templates/compact/summary_prefix.md");
```

`codex-rs/prompts/templates/compact/prompt.md` 全文（共 11 行）：

```
You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.

Include:
- Current progress and key decisions made
- Important context, constraints, or user preferences
- What remains to be done (clear next steps)
- Any critical data, examples, or references needed to continue

Be concise, structured, and focused on helping the next LLM seamlessly continue the work.
```

### 3.2 摘要被包装成 `SUMMARY_PREFIX + 摘要正文`，并作为最后一条 history 项

`codex-rs/core/src/compact.rs:372`：

```rust
    let summary_suffix = if matches!(compaction_metadata.phase(), CompactionPhase::PostTurn) {
        get_last_assistant_message_from_turn(compaction_response.output.iter())
            .filter(|summary| !summary.trim().is_empty())
            .ok_or_else(|| {
                CodexErr::Stream(
                    "Post-turn compaction completed without an assistant summary".to_string(),
                )
            })?
    } else {
        get_last_assistant_message_from_turn(history_snapshot.raw_items()).unwrap_or_default()
    };
    let summary_text = format!("{SUMMARY_PREFIX}\n{summary_suffix}");
```

摘要作为 `CompactionSummary` 片段被 push 到替换历史末尾：`codex-rs/core/src/compact.rs:759-769`：

```rust
    let summary_text = if summary_text.is_empty() {
        "(no summary available)".to_string()
    } else {
        summary_text.to_string()
    };

    history.push(ResponseItemEnvelope::new(ContextualUserFragment::into(
        CompactionSummary::new(summary_text),
    )));
```

**"续作说明"到底是什么**：就是 `SUMMARY_PREFIX`（`codex-rs/prompts/templates/compact/summary_prefix.md`，共 2 行）：

```
Another language model started to solve this problem and produced a summary of its thinking process. You also have access to the state of the tools that were used by that language model. Use this to build on the work that has already been done and avoid duplicating work. Here is the summary produced by the other language model, use the information in this summary to assist with your own analysis:
```

它**加在摘要前面**（`format!("{SUMMARY_PREFIX}\n{summary_suffix}")`），不是加在摘要后面。

### 3.3 摘要会被"识别并排除"，避免被当成用户原话重复保留

`codex-rs/core/src/compact.rs:601`：

```rust
pub(crate) fn is_summary_message(message: &str) -> bool {
    message.starts_with(format!("{SUMMARY_PREFIX}\n").as_str())
}
```

调用点 `codex-rs/core/src/compact.rs:591`（`compacted_user_message` 内 `if is_summary_message(&message) { return None; }`）。

### 3.4 压缩后追加的续作说明 —— **UNVERIFIED**

- 报告若指"压缩完成后系统再插入一段 'continue your task' 文本"，在 `codex-rs/core/src/compact.rs`、`codex-rs/core/src/compact_token_budget.rs`、`codex-rs/core/src/compact_remote_v2.rs` 三处 close 流程里都**没有**这种片段；替换历史只包含 [retained 用户原话…] + [context 片段] + [CompactionSummary]。
- 已检索位置：在 `codex-rs` 全域 grep `resume the task|continue the work|Continue working|continue where you left off`，仅命中 `codex-rs/core/src/context/contextual_user_message_tests.rs:106`（goal 上下文模板，与压缩无关）及 TUI 文案。
- 与压缩相邻的唯一"给模型的话"是**压缩前**的 fallback 开发者消息（见 §7.3），以及压缩完成后给**用户**的 Warning（`codex-rs/core/src/compact.rs:421-424`）：
  ```rust
      let warning = EventMsg::Warning(WarningEvent {
          message: "Heads up: Long threads and multiple compactions can cause the model to be less accurate. Start a new thread when possible to keep threads small and targeted.".to_string(),
      });
  ```
  这是 UI 事件，不进模型上下文。

---

## 4. "压缩之外保留最近用户原话"的真实常量与作用范围

### 4.1 常量名与值

`codex-rs/core/src/compact.rs:63`：

```rust
const COMPACT_USER_MESSAGE_MAX_TOKENS: usize = 20_000;
```

### 4.2 作用范围：**只在 compaction 生成的替换历史里**，从最近往回想回填，最多 20k token

`codex-rs/core/src/compact.rs:386`（唯一生产调用点）：

```rust
    let mut new_history = build_compacted_history(Vec::new(), &user_messages, &summary_text);
```

`codex-rs/core/src/compact.rs:677`：

```rust
pub(crate) fn build_compacted_history(
    initial_context: Vec<ResponseItemEnvelope>,
    user_messages: &[CompactedUserMessage<'_>],
    summary_text: &str,
) -> Vec<ResponseItemEnvelope> {
    build_compacted_history_with_limit(
        initial_context,
        user_messages,
        summary_text,
        COMPACT_USER_MESSAGE_MAX_TOKENS,
    )
}
```

回填逻辑（倒序 + 预算递减 + 超预算时截断到剩余额度）：`codex-rs/core/src/compact.rs:696-755`，关键片段：

```rust
    let mut selected_messages = Vec::new();
    if max_tokens > 0 {
        let mut remaining = max_tokens;
        for message in user_messages.iter().rev() {
            if remaining == 0 {
                break;
            }
            let tokens = approx_token_count(&message.message);
```

以及超预算那一条的截断与"来源不完整"标记：`codex-rs/core/src/compact.rs:730-737`：

```rust
                vec![ContentItem::InputText {
                    text: truncate_text(&message.message, TruncationPolicy::Tokens(remaining)),
                }]
            };
            if tokens > remaining
                && let Some(metadata) = &mut harness_metadata
            {
                metadata.mark_retained_sources_incomplete();
            }
```

- **确认：20_000 token 是真实常量，作用域仅限 compaction 替换历史中"注释过的用户消息"集合**（`collect_annotated_user_messages`，`codex-rs/core/src/compact.rs:574`）。
- **与报告的关键差异**：`codex-rs/core/src/compact_remote_v2.rs:78-79` 是**另一套预算**：
  ```rust
  pub(crate) const RETAINED_MESSAGE_TOKEN_BUDGET: usize = 64_000;
  const MAX_RETAINED_AGENT_MESSAGE_TOKENS: i64 = 10_000;
  ```
  远程/服务器侧压缩保留 64k token 的"消息组"（含工具输出、developer 消息），单条 agent message 上限 10k token（`codex-rs/core/src/compact_remote_v2.rs:517`、`:579`）。所以"约 2 万 token"只对**本地文本压缩**成立；走 remote compaction v2 的会话是 64k。报告未区分这两条路径。

---

## 5. 压缩请求本身超出窗口时的降级：丢弃最早历史

`codex-rs/core/src/compact.rs:338`：

```rust
            Err(e) if matches!(e.details(), CodexErrorDetails::ContextWindowExceeded) => {
                if turn_input_len > 1 {
                    // Trim from the beginning to preserve cache (prefix-based) and keep recent messages intact.
                    error!(
                        "Context window exceeded while compacting; removing oldest history item. Error: {e}"
                    );
                    history.remove_first_item();
                    retries = 0;
                    continue;
                }
                sess.set_total_tokens_full(turn_context.as_ref()).await;
                return Err(e);
            }
```

- **与报告"丢弃最早历史"完全一致**，且循环重试直到 `turn_input_len <= 1`，此时把 token 计数标为 full 并把错误上抛（`set_total_tokens_full`）。
- 该 `ContextWindowExceeded` 分支之前先排除了 `Interrupted | TurnAborted`（`:327-334`）与 `SessionBudgetExceeded`（`:335-337`），顺序有意义：预算类错误不做丢弃降级。
- 注意这是**本地文本压缩路径**的降级；远程 v2 有独立的 attempt 机制（`codex-rs/core/src/compact_remote_v2_attempt.rs`，150 行）与更小的流重试预算 `MAX_REMOTE_COMPACTION_V2_STREAM_RETRIES: u64 = 2`（`codex-rs/core/src/compact_remote_v2.rs:82`）。

---

## 6. 远程 / opaque 压缩路径与文本摘要的代码分流

### 6.1 唯一分流点：按 provider capability 三选一

`codex-rs/core/src/session/turn.rs:1473`（`run_auto_compact` 内部）：

```rust
    match turn_context.provider.capabilities().remote_compaction {
        RemoteCompactionSupport::V2 => {
            emit_compact_metric(
                &sess.services.session_telemetry,
                "remote_v2",
                /*manual*/ false,
            );
            run_inline_remote_auto_compact_task_v2(
```

继续 `failover` 分支（`:1491-1506`）：

```rust
        RemoteCompactionSupport::Unsupported => {
            emit_compact_metric(
                &sess.services.session_telemetry,
                "local",
                /*manual*/ false,
            );
            run_inline_auto_compact_task(
```

- **在此之前还有一次短路**：TokenBudget feature 打开时完全不走摘要，直接开新窗口（`codex-rs/core/src/session/turn.rs:1461-1471`）：
  ```rust
      if turn_context.config.features.enabled(Feature::TokenBudget) {
          // Compaction is the reset request, so force a new context window
          // instead of consuming a pending `new_context` tool request.
          crate::compact_token_budget::run_inline_auto_compact_task(
  ```
  该函数体最终只做 `sess.start_new_context_window(step_context, world_state)`（`codex-rs/core/src/compact_token_budget.rs:58`），**不产生任何摘要**。

### 6.2 opaque 侧：服务端返回的 compaction item 被直接当作历史项保留

`codex-rs/core/src/compact_remote_v2.rs:499`：

```rust
fn build_v2_compacted_history(
    prompt_input: Vec<ResponseItem>,
    prompt_input_metadata: Vec<Option<CodexHarnessMetadata>>,
    compaction_output: ResponseItem,
    features: &Features,
    image_budget: RetainedImageBudget,
) -> (Vec<ResponseItemEnvelope>, usize) {
```

`:512-522` 只保留"允许保留的组"再 append `compaction_output`（opaque item）：

```rust
    let retained = v2_history_item_groups(prompt_input)
        .filter(|group| is_retained_for_remote_compaction_v2(&group.source, features))
        .flat_map(HistoryItemGroup::into_items)
        .collect::<Vec<_>>();
    let mut retained =
        truncate_retained_messages(retained, RETAINED_MESSAGE_TOKEN_BUDGET, image_budget);
```

保留判据 `codex-rs/core/src/compact_remote_v2.rs:548` 明确排除"子代理进度消息"和"FINAL_ANSWER 完成消息"，其余按 token 上限保留：

```rust
        return !is_descendant_progress
            && !is_completion
            && estimate_item_token_count(item) <= MAX_RETAINED_AGENT_MESSAGE_TOKENS;
```

### 6.3 分流在插入位置的兼容处理

本地压缩的替换历史插入点兼顾远程路径（可能只返回 compaction item 而没有用户消息）：`codex-rs/core/src/compact.rs:649-662` 先找 `last_real_user_index`，退化到 `last_user_or_summary_index`，再退化到 `last_compaction_index`（`ResponseItem::Compaction | ResponseItem::ContextCompaction`）。对应文档注释在 `:605-614`。

- **三点分流可总结为**：TokenBudget 开启 → 无摘要重置窗口；provider `remote_compaction = V2` → 服务端 opaque compaction；其余 → 本地文本摘要（`SUMMARIZATION_PROMPT`）。

---

## 7. Token budget：默认开关、配置项、`get_context_remaining`、reminder 阈值与模板

### 7.1 默认关闭（feature flag）

`codex-rs/features/src/lib.rs:1889`：

```rust
    FeatureSpec {
        id: Feature::TokenBudget,
        key: "token_budget",
        stage: Stage::UnderDevelopment,
        default_enabled: false,
    },
```

- **确认报告"token budget 默认关闭"成立**（`stage: UnderDevelopment` + `default_enabled: false`）。
- 配置结构体 `codex-rs/features/src/feature_configs.rs:369`（`TokenBudgetConfigToml`，`#[serde(deny_unknown_fields)]`）字段：`enabled`、`use_history_notes_extension`、`reminder_threshold_tokens`、`reminder_message_template`、`guidance_message`、`auto_compact_fallback_prompt`、`auto_compact_fallback_buffer_tokens`（`:371-395`）。
- 生效前提还有一长串**账号/模型门槛**（`codex-rs/core/src/session/token_budget.rs:27-42`：必须 `ContextManagement` feature + `supports_experimental_context` + codex backend route + ChatGPT 登录 + PlanType ∈ {Plus,Pro,ProLite,ProMax}，见 `:13-19`）。

### 7.2 `get_context_remaining` 工具

工具名常量 `codex-rs/core/src/tools/handlers/get_context_remaining_spec.rs:8`：

```rust
pub(crate) const GET_CONTEXT_REMAINING_TOOL_NAME: &str = "get_context_remaining";
```

注册处（**位于 TokenBudget 开关之内**）：`codex-rs/core/src/tools/spec_plan.rs:1401`：

```rust
    if features.enabled(Feature::TokenBudget) {
        registry.add_with_exposure(NewContextWindowHandler, ToolExposure::DirectModelOnly);
        registry.add(GetContextRemainingHandler);
    }
```

实现返回 `base_window_tokens_remaining`：`codex-rs/core/src/tools/handlers/get_context_remaining.rs:85-93`：

```rust
            let token_status = crate::session::context_window::context_window_token_status(
                invocation.session.as_ref(),
                invocation.turn.as_ref(),
            )
            .await;

            Ok(boxed_tool_output(GetContextRemainingOutput::new(
                token_status.base_window_tokens_remaining,
            )))
```

模型看到的文本由 `TokenBudgetRemainingContext` 渲染（`codex-rs/core/src/context/token_budget_context.rs:170-177`）：`"You have {tokens_left} tokens left in this context window."`（未知时 `"You have unknown tokens left in this context window."`）。`role()` = `"developer"`（`:158`）。

### 7.3 reminder 阈值与模板（`{n_remaining}` 占位）

`codex-rs/core/src/session/token_budget.rs:178`（`maybe_record`）：

```rust
    if config
        .reminder_threshold_tokens
        .is_some_and(|threshold| base_window_tokens_remaining <= threshold)
    {
        let reminder_due = {
            let mut state = sess.state.lock().await;
            state.claim_token_budget_reminder()
        };
        if reminder_due {
            let response_item =
                ContextualUserFragment::into(crate::context::TokenBudgetReminder::new(
                    &config.reminder_message_template,
                    base_window_tokens_remaining,
                ));
```

模板替换与渲染：`codex-rs/core/src/context/token_budget_context.rs:186-213`：

```rust
impl TokenBudgetReminder {
    pub(crate) fn new(message_template: &str, n_remaining: i64) -> Self {
        Self {
            message: message_template.replace("{n_remaining}", &n_remaining.to_string()),
        }
    }
}
```

```rust
impl ContextualUserFragment for TokenBudgetReminder {
    fn content_kind(&self) -> ContentItemKind {
        ContentItemKind("token_budget.reminder".to_string())
    }

    fn role(&self) -> &'static str {
        "developer"
    }
```

**auto-compact fallback 提示**（阈值到达 0 且允许 fallback 时注入）：`codex-rs/core/src/session/token_budget.rs:201-223`，content kind `compaction.auto_fallback_prompt`（`codex-rs/core/src/context/token_budget_context.rs:230`），role 同为 `developer`（`:233`）。

调用位置（**MidTurn 之后、压缩判断之前**）：`codex-rs/core/src/session/turn.rs:612-618`：

```rust
                super::token_budget::maybe_record(
                    sess.as_ref(),
                    turn_context.as_ref(),
                    token_status.base_window_tokens_remaining,
                    allow_auto_compact_fallback,
                )
                .await;
```

### 7.4 阈值校验（正向约束）

`codex-rs/core/src/config/mod.rs:1247`：`"features.token_budget.reminder_threshold_tokens must be positive"`（`reminder_threshold_tokens: Option<i64>` 定义在 `:1232`）。`auto_compact_fallback_prompt` / `guidance_message` 有长度上限 2000（`codex-rs/features/src/feature_configs.rs:382`、`:386`、`:390`）。

### 7.5 另外两个预算通道（报告未提，容易混淆）

- `rollout_budget`：`codex-rs/core/src/rollout_budget.rs:75-90`，用 `reminder_at_remaining_tokens: Vec<i64>`（`codex-rs/core/src/config/mod.rs:1339`）做多档提醒，`sampling_token_weight` 加权。feature 同样 `default_enabled: false`（`codex-rs/features/src/lib.rs:1901-1906`）。
- `guardian` 侧另有 `codex-rs/guardian-context/src/budget.rs` 的 `4_000.0 / 64_000.0` 预算表，与 token budget 无关。

---

## 8. 持久笔记（notes）与跨窗口 thread hint

### 8.1 thread hint 上限确实是 4000 字节

`codex-rs/ext/history-notes/src/extension.rs:30`：

```rust
// Bound model context even when note paths are unusually long.
const MAX_THREAD_HINT_BYTES: usize = 4_000;
```

应用点（两处：请求头截断策略 + 响应超限放弃）`codex-rs/ext/history-notes/src/extension.rs:122`：

```rust
            let Ok(result) = config
                .backend
                .call(
                    "alpha/notes/v2/thread_hint",
                    session_store.level_id(),
                    &identity.agent_name,
                    json!({}),
                    TruncationPolicy::Bytes(MAX_THREAD_HINT_BYTES),
                )
                .await
            else {
                track_status(ThreadHintStatus::Failed);
                return Vec::new();
            };
```

```rust
            if text.len() > MAX_THREAD_HINT_BYTES {
                track_status(ThreadHintStatus::Failed);
                return Vec::new();
            }
```

结果作为 `PromptSlot::ContextWindow` 片段注入，content kind `notes.thread_hint`（`:148-152`）。

### 8.2 启用条件（不是默认开）

`codex-rs/ext/history-notes/src/extension.rs:46-52`：必须 `token_budget.use_history_notes_extension` **且** `config.model_provider.is_openai()` **且** 当前认证走 codex backend，否则 `thread_store.remove::<HistoryNotesExtensionConfig>()`。

实验上下文路径会自动打开它：`codex-rs/core/src/session/token_budget.rs:53-56`：

```rust
    config
        .token_budget
        .get_or_insert_default()
        .use_history_notes_extension = true;
```

### 8.3 持久笔记工具集（9 个 action：4 history + 5 notes）

`codex-rs/ext/history-notes/src/tools.rs:30-45` 枚举 `HistoryNotesAction`：
`HistoryListWindows, HistoryListItems, HistoryReadItem, HistorySearchContents, NotesListFilesByPrefix, NotesReadFile, NotesSearchContents, NotesAppendToFile, NotesWriteFile`。

命名空间与工具名映射：`codex-rs/ext/history-notes/src/tools.rs:63-73`（namespace）+ `:75-88`（name）：

```rust
    fn namespace(self) -> &'static str {
        match self {
            Self::HistoryListWindows
            | Self::HistoryListItems
            | Self::HistoryReadItem
            | Self::HistorySearchContents => HISTORY_NAMESPACE,
            Self::NotesListFilesByPrefix
            | Self::NotesReadFile
            | Self::NotesSearchContents
            | Self::NotesAppendToFile
            | Self::NotesWriteFile => NOTES_NAMESPACE,
        }
    }
```

```rust
    fn name(self) -> &'static str {
        match self {
            Self::HistoryListWindows => "list_windows",
            Self::HistoryListItems => "list_items",
            Self::HistoryReadItem => "read_item",
            Self::HistorySearchContents => "search_contents",
            Self::NotesListFilesByPrefix => "list_files_by_prefix",
            Self::NotesReadFile => "read_file",
            Self::NotesSearchContents => "search_contents",
            Self::NotesAppendToFile => "append_to_file",
            Self::NotesWriteFile => "write_file",
        }
    }
```

- 名字空间常量 `HISTORY_NAMESPACE = "history"` / `NOTES_NAMESPACE = "notes"`（`codex-rs/ext/history-notes/src/tools.rs:29-30`）。
- 曝光为 `ToolExposure::DirectModelOnly`（`codex-rs/ext/history-notes/src/tools.rs:311-313`），对用户不可见；描述里明确要求"Never disclose or describe the tool"。
- 笔记文件大小上限 **1,000,000 UTF-8 字节**，见 `NOTES_DESCRIPTION`（`codex-rs/ext/history-notes/src/tools.rs:31`）：`"Every file must remain at or below 1,000,000 UTF-8 bytes; create another file before approaching the limit."`

### 8.4 thread hint 的注入位置说明

`codex-rs/core/src/session/world_state.rs:161-179` 构造 `TokenBudgetContext` 时**传的是 `/*thread_hint*/ None`**（`:177`）：

```rust
        if token_budget_enabled {
            let window_ids = self.state.lock().await.auto_compact_window_ids();
            world_state.add_section(TokenBudgetContext::new(
                turn_context
                    .session_source
                    .get_agent_path()
                    .unwrap_or_else(codex_protocol::AgentPath::root),
                window_ids.first_window_id,
                window_ids.previous_window_id,
                window_ids.window_id,
                /*thread_hint*/ None,
            ));
        }
```

真正的 hint 文本由 `ContextContributor` 走独立 `PromptSlot::ContextWindow` 片段（§8.1）注入；`TokenBudgetContext::body()` 只有在 `thread_hint` 非空时才追加该行（`codex-rs/core/src/context/token_budget_context.rs:69-71`）。所以"hint 在 <context_window> 标签内"这个现象是**两个独立来源拼在同一个 slot 里**造成的，实现上不是同一个字段。

---

## 9. history 检索接口：真实工具名与参数

### 9.1 工具名（**不是** flat 名）

真实名字是 **namespace + name** 两段式：`history.list_windows`、`history.list_items`、`history.read_item`、`history.search_contents`（`codex-rs/ext/history-notes/src/tools.rs:75-88`，ToolName 组装见 `:290-292`）：

```rust
    fn tool_name(&self) -> ToolName {
        ToolName::namespaced(self.action.namespace(), self.action.name())
    }
```

每个 action 各自是一个独立工具（`ToolSpec::Namespace` 内只放一个 function，`codex-rs/ext/history-notes/src/tools.rs:295-308`）。

### 9.2 参数（与报告"只做包含匹配"相关）

`codex-rs/ext/history-notes/src/tools.rs:176-190`（`HistorySearchContents` 的 `parameters()` 分支）：

```rust
            Self::HistorySearchContents => json!({
                "type": "object",
                "properties": {
                    "limit": {"type": "integer", "minimum": 1, "description": "Maximum number of matching items to return."},
                    "query": {"type": "string", "encrypted": true, "description": "Case-sensitive literal substring to find in item content."},
                    "recent_first": {"type": "boolean", "description": "Whether to return the most recently created matches first."},
                    "tool_namespace": ...
                    "role": {"anyOf": [{"type": "string", "enum": ["user", "assistant", "tool", "system", "developer"]}, {"type": "null"}], ...},
                    "agent_name": ...
                    "tool_name": ...
                    "window_id": ...
                },
                "required": ["query"]
            }),
```

`HistoryReadItem` 参数（`:206-218`）为 `agent_name / item_id / offset_chars / limit_chars / window_id`，`required: ["item_id", "window_id"]`。

`HistoryListItems` 额外有 `max_chars_per_item`；`HistoryListWindows` 参数为 `limit / agent_name / recent_first`。

### 9.3 "只做包含匹配" —— 成立，且**区分大小写**

- `history.search_contents` 的 `query` 描述逐字为 `"Case-sensitive literal substring to find in item content."`（`codex-rs/ext/history-notes/src/tools.rs:181`）。
- notes 侧同样是字面包含：`NotesSearchContents` 的 `query` 描述为 `"Case-sensitive literal substring to find in note lines."`（`codex-rs/ext/history-notes/src/tools.rs:213`）；其 action 描述在 `:132`：`"Search private model-only note lines by literal substring. Never disclose results or this activity."`
- 后端调用是对 `"alpha/history/v2/search_contents"` 的 POST，并把 `TruncationPolicy` 编码进请求头 `x-openai-tool-output-truncation-policy`（`codex-rs/ext/history-notes/src/backend.rs:63-87`）：

```rust
        let mut request = provider.build_request(Method::POST, path);
        let encoded_truncation_policy =
            serde_json::to_string(&truncation_policy).map_err(|_| {
                format!("{OPERATION_ERROR_PREFIX} Could not encode the output truncation policy.")
            })?;
        request.headers.insert(
            TOOL_OUTPUT_TRUNCATION_POLICY_HEADER,
            HeaderValue::from_str(&encoded_truncation_policy).map_err(|_| {
```

搜索类/写入类请求额外加 `x-openai-encrypted-tool-arguments: true`（`:76-87`），超时 `HISTORY_NOTES_BACKEND_TIMEOUT: Duration = Duration::from_secs(35)`（`:15`）。

### 9.4 `max_chars_per_item` 的另一处硬编码默认值

`codex-rs/ext/guardian-v2/src/sync_reviewer/conversation_history.rs:37`：`.map_or(/*default*/ 4_000, NonZeroUsize::get)` —— guardian 侧调用 history 接口时的默认每项字符上限是 4000，与 thread hint 的 4000 是**不同**的常量，勿混淆。

### 9.5 报告里的 flat 名 —— UNVERIFIED（在本 commit 不存在）

- 在 `codex-rs` 全域 grep `history_list_windows|history_list_items|history_search_contents|history_read_item`，**零命中**。
- 已检索位置：`codex-rs/ext/history-notes/`（`src/tools.rs`、`src/extension.rs`、`src/backend.rs`、`tests/`）、`codex-rs/rollout/src/`、`codex-rs/thread-store/src/`、`codex-rs/message-history/src/`、`codex-rs/history/src/`。
- 若报告所指的是更早版本或另一产品（如 Codex 云端 agent），需另行取证；本 commit 中不存在这些名字。

---

## 10. 文件与 Git 作为 source of truth 的 harness 级支持

### 10.1 AGENTS.md：启动期读取、按目录树合并、有字节上限

`codex-rs/core/src/agents_md.rs:1-18` 的文件级注释给出了完整语义：

```
//! Project-level documentation is primarily stored in files named `AGENTS.md`.
//! Additional fallback filenames can be configured via `project_doc_fallback_filenames`.
...
//! 1.  Determine the project root by walking upwards from the current working
//!     directory until a configured `project_root_markers` entry is found.
//!     When `project_root_markers` is unset, the default marker list is used
//!     (`.git`). If no marker is found, only the current working directory is
//!     considered. An empty marker list disables parent traversal.
//! 2.  Collect every `AGENTS.md` found from the project root down to the
//!     current working directory (inclusive) and concatenate their contents in
//!     that order.
//! 3.  We do **not** walk past the project root.
```

常量：`codex-rs/core/src/agents_md.rs:43-49`：

```rust
pub const DEFAULT_AGENTS_MD_FILENAME: &str = "AGENTS.md";
/// Preferred local override for AGENTS.md instructions.
pub const LOCAL_AGENTS_MD_FILENAME: &str = "AGENTS.override.md";

/// When both user and project AGENTS.md docs are present, they will be
/// concatenated with the following separator.
const AGENTS_MD_SEPARATOR: &str = "\n\n--- project-doc ---\n\n";
```

无信任目录时**完全不读项目文档**：`codex-rs/core/src/agents_md.rs:64`：

```rust
    if config.active_project.is_untrusted() {
        return Ok((!loaded.is_empty()).then_some(loaded));
    }
```

字节预算按顺序递减（`codex-rs/core/src/agents_md.rs:68-72`：`let mut remaining = config.project_doc_max_bytes;` → `if remaining == 0 { break; }`）。

注入到上下文：`codex-rs/core/src/session/world_state.rs:202`：`world_state.add_section(AgentsMdState::new(step_context.loaded_agents_md.as_deref()));`

仓库内文档只有一句话转发外部文档：`docs/agents_md.md`（全文 3 行）：

```
# AGENTS.md

For information about AGENTS.md, see [this documentation](https://developers.openai.com/codex/guides/agents-md).
```

提示词层面的规范写在基础指令里，例如 `codex-rs/protocol/src/prompts/base_instructions/default.md:17-27`（`# AGENTS.md spec`，含 "The scope of an AGENTS.md file is the entire directory tree rooted at the folder that contains it."、深层文件优先级更高、直接指令优先于 AGENTS.md）。

### 10.2 Git 差异：只作为 UI 事件，不回流模型上下文

`codex-rs/core/src/session/turn.rs:3182-3188`：

```rust
    if should_emit_turn_diff {
        {
            let tracker = turn_diff_tracker.lock().await;
            ...
            let msg = EventMsg::TurnDiff(TurnDiffEvent { unified_diff });
```

`TurnDiff` 是 `EventMsg`（发给客户端/UI），**不是** ResponseItem，因此不会进入下一次请求的 history。

### 10.3 "进度文件"约定 —— UNVERIFIED

- 在 `codex-rs/prompts/templates/**` 全域 grep `progress|PROGRESS|plan file|NOTES|scratchpad`，仅命中：
  - `codex-rs/prompts/templates/compact/prompt.md:4`（摘要模板里的 "Current progress and key decisions made"，指的是摘要内容结构，不是磁盘文件）；
  - `codex-rs/prompts/templates/persistent_mode.md:9`：`"Keep the target, last known state, stopping condition, and next check in the available task/checkpoint state so the follow-up survives sleep and context resets."` —— 说的是**任务/检查点状态**，没有指定任何文件名或路径约定。
- 仓库里**没有** `progress.md` / `NOTES.md` / `PLAN.md` 之类的强制文件名常量；已检索 `codex-rs/core/src`、`codex-rs/prompts/`、`codex-rs/docs/`、`docs/`。
- 换句话说：这一维在 Codex 侧是**靠 AGENTS.md + 模型自行写文件**实现的"事实约定"，harness 层没有专门机制（对比之下，notes 扩展是服务端后端存储，不是工作区文件，见 §8.3）。

### 10.4 与"文件系统为真源"相关的相邻机制（可作对照素材）

- `codex-rs/core/src/agents_md_manager.rs`（189 行）：AGENTS.md 的刷新/缓存管理。
- `codex-rs/core/src/turn_diff_tracker.rs`（359 行）：按回合聚合 unified diff，供 UI 与 `TurnDiff` 事件使用。
- `codex-rs/core/src/context/world_state/agents_md.rs`（76 行）：AGENTS.md 作为 world-state section 的增量渲染。

---

## 11. 视频报告 vs 代码：逐条差异清单

| # | 报告/任务描述的说法 | 代码事实（含位置） | 判定 |
|---|---|---|---|
| D1 | 自动压缩阈值"约 90% 上下文窗口" | `codex-rs/protocol/src/openai_models.rs:529-537`，`(context_window * 9) / 10` | **一致** |
| D2 | "config limit 与默认比例取 min" | 同上 `:536` `std::cmp::min(limit, context_limit)` | **一致**，但需补充：`Total` scope 走 `ModelInfo.auto_compact_token_limit()`（含 min），`BodyAfterPrefix` scope 走 `config.or_else(model)`（**不含 min**），见 `codex-rs/core/src/session/context_window.rs:61-81` |
| D3 | 长工具输出"保留首尾、省略中间" | `codex-rs/utils/string/src/truncate.rs:36`、`:156` | **一致**；补充：首尾**各 50%**（`split_budget`），默认预算 10 000 字节（`codex-rs/models-manager/src/model_info.rs:126`），另加 20% 序列化余量（`codex-rs/utils/output-truncation/src/lib.rs:17-21`） |
| D4 | 压缩之外保留最近用户原话"约 2 万 token" | `codex-rs/core/src/compact.rs:63` `COMPACT_USER_MESSAGE_MAX_TOKENS: usize = 20_000` | **仅对本地文本压缩成立**；remote compaction v2 是 `RETAINED_MESSAGE_TOKEN_BUDGET: usize = 64_000`（`codex-rs/core/src/compact_remote_v2.rs:78`），单条 agent message 10 000（`:79`） |
| D5 | 压缩请求自身超窗口时"丢弃最早历史" | `codex-rs/core/src/compact.rs:338-350` `history.remove_first_item()` | **一致** |
| D6 | 存在远程/opaque 压缩路径 | `codex-rs/core/src/session/turn.rs:1473-1507` 按 `RemoteCompactionSupport` 分流；TokenBudget 分支在 `:1461-1471` 直接开新窗口、**无摘要** | **一致**且比报告更细（三条路径） |
| D7 | token budget 默认关闭 | `codex-rs/features/src/lib.rs:1889-1894` `default_enabled: false` | **一致** |
| D8 | 有 "get context remaining" 类工具 | `codex-rs/core/src/tools/handlers/get_context_remaining_spec.rs:8`；**但仅当 TokenBudget feature 开启时才注册**（`codex-rs/core/src/tools/spec_plan.rs:1401-1404`） | **一致**，需补"同时被 flag 门控" |
| D9 | reminder threshold tokens + developer reminder 模板 | `codex-rs/features/src/feature_configs.rs:376-383`；渲染 `codex-rs/core/src/context/token_budget_context.rs:186-200`（role = developer） | **一致** |
| D10 | 跨窗口 thread hint 上限 4000 字节 | `codex-rs/ext/history-notes/src/extension.rs:31` `MAX_THREAD_HINT_BYTES: usize = 4_000` | **一致**，单位确为**字节**（`text.len()` 比较，`:140`） |
| D11 | history 工具名 `history_list_windows` / `history_list_items` / `history_search_contents` / `history_read_item` | 实际为 namespace 工具 `history.list_windows` / `history.list_items` / `history.read_item` / `history.search_contents`（`codex-rs/ext/history-notes/src/tools.rs:75-88`、`:290-292`） | **不一致**（flat 名在本 commit 零命中，UNVERIFIED） |
| D12 | history 检索"只做包含匹配" | `codex-rs/ext/history-notes/src/tools.rs:222` `"Case-sensitive literal substring to find in item content."` | **一致**，且明确**区分大小写** |
| D13 | 压缩后追加"续作说明" | 只有**前置**的 `SUMMARY_PREFIX`（`codex-rs/core/src/compact.rs:383`、`codex-rs/prompts/templates/compact/summary_prefix.md`）；未找到压缩后追加的续作片段 | **未找到，UNVERIFIED**（检索范围见 §3.4） |
| D14 | （隐含）压缩提示词名为 handoff summary 模板 | `codex-rs/prompts/templates/compact/prompt.md` 首行 "You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task." | **一致** |
| D15 | （报告未提）post-turn 压缩 | `codex-rs/core/src/session/turn.rs:720-737`，阈值默认 **0 = 关闭**（`codex-rs/core/src/config/mod.rs:4355-4357`） | 报告**漏项** |
| D16 | （报告未提）token budget 下的 `new_context_window` 工具（无摘要重置） | `codex-rs/core/src/tools/handlers/new_context_window.rs:13-14`、注册于 `codex-rs/core/src/tools/spec_plan.rs:1402` | 报告**漏项** |
| D17 | （报告未提）压缩完成的用户告警 & 多轮压缩精度提示 | `codex-rs/core/src/compact.rs:421-424` | 报告**漏项** |

---

## 12. 明确标注的 UNVERIFIED 项

1. **压缩后追加的"续作说明"文本** — 未找到。检索位置：`codex-rs/core/src/compact.rs`（全文 866 行）、`codex-rs/core/src/compact_token_budget.rs`（69 行）、`codex-rs/core/src/compact_remote_v2.rs`（1332 行）、`codex-rs/core/src/compact_remote_v2_attempt.rs`（150 行）、`codex-rs/prompts/templates/compact/`，以及全域 grep `resume the task|continue the work|Continue working|continue where you left off`。
2. **history flat 工具名** `history_list_windows` / `history_list_items` / `history_search_contents` / `history_read_item` — 全域零命中。检索位置：`codex-rs/ext/history-notes/**`、`codex-rs/rollout/src/**`、`codex-rs/thread-store/src/**`、`codex-rs/message-history/src/**`、`codex-rs/history/src/**`。
3. **"进度文件"约定**（harness 强制某个进度文件） — 未找到任何文件名常量或提示词约定。检索位置：`codex-rs/prompts/templates/**`（仅命中 `compact/prompt.md:4` 与 `persistent_mode.md:9`）、`codex-rs/core/src/**`、`codex-rs/docs/**`、`docs/**`。
4. **视频报告所依据的具体 commit/版本** — 未知。本报告全部结论针对 `a07c8ebd57feedc4cf5dfe854c8e9101de54186b`；报告中若引用更早版本的行为，需在旧 commit 上复核。
5. **`memory` / `memories` 模块是否构成"跨窗口持久记忆"** — 本报告未把 `codex-rs/memories/write/**`（如 `phase1.rs` 755 行、`runtime.rs` 430 行）与 `codex-rs/state/src/runtime/memories.rs`（5038 行）的完整语义纳入结论；它们确实存在，但与 §8 的 notes 是**不同**机制（一个是从 rollout 提炼记忆，一个是会话内的 notes/history 后端工具）。若要写进对照表，需单独取证（超出本任务 10 维定义）。
6. **`truncation.rs` 端到端预算** — 本报告给出 `ToolInvocationContext::truncation_policy`（`codex-rs/core/src/tools/context.rs:133`）与 `with_serialization_allowance`（`codex-rs/core/src/tools/context.rs:154`、`:210`、`:552`）作为调用链证据，但**未逐工具**核对最终 `policy` 值（不同 handler 可能再取 min，例如 `codex-rs/core/src/mcp_tool_call/conversation_history.rs:157-159`）。若需要"每个工具的确切字节上限"，需再做一轮按 handler 的取证。

---

## 13. 关键常量速查（供对照表直接引用）

| 常量 | 值 | 位置 |
|---|---|---|
| 自动压缩默认比例 | 90% of `resolved_context_window` | `codex-rs/protocol/src/openai_models.rs:532` |
| 可用窗口比例 | 95% | `codex-rs/protocol/src/openai_models.rs:393` |
| 本地压缩保留用户消息预算 | 20 000 tokens | `codex-rs/core/src/compact.rs:63` |
| 远程压缩 v2 保留消息预算 | 64 000 tokens | `codex-rs/core/src/compact_remote_v2.rs:78` |
| 远程压缩 v2 单条 agent 消息上限 | 10 000 tokens | `codex-rs/core/src/compact_remote_v2.rs:79` |
| 默认工具输出截断 | 10 000 字节 | `codex-rs/models-manager/src/model_info.rs:126` |
| 序列化余量 | ×1.2 | `codex-rs/utils/output-truncation/src/lib.rs:19-21` |
| 字节→token 估算 | 4 字节 = 1 token | `codex-rs/utils/string/src/truncate.rs:4` |
| thread hint 上限 | 4 000 字节 | `codex-rs/ext/history-notes/src/extension.rs:31` |
| notes 单文件上限 | 1 000 000 UTF-8 字节 | `codex-rs/ext/history-notes/src/tools.rs:31`（`NOTES_DESCRIPTION`） |
| history 后端超时 | 35 s | `codex-rs/ext/history-notes/src/backend.rs:15` |
| post-turn 压缩阈值默认值 | 0（关闭） | `codex-rs/core/src/config/mod.rs:4355-4357` |
| 远程压缩 v2 流重试上限 | 2 | `codex-rs/core/src/compact_remote_v2.rs:82` |

## 14. 复现命令

```powershell
# commit 校验
git -C I:\VMsShare\_src-compare\codex log -1 --format='%H %cI %s'

# 10 个维度的关键检索（示例）
# (1) 阈值与 min
git -C I:\VMsShare\_src-compare\codex grep -n "fn auto_compact_token_limit" -- codex-rs/protocol/src/openai_models.rs
git -C I:\VMsShare\_src-compare\codex grep -n "model_auto_compact_token_limit_scope" -- codex-rs/core/src/session/context_window.rs
# (2) 截断
git -C I:\VMsShare\_src-compare\codex grep -n "fn split_budget" -- codex-rs/utils/string/src/truncate.rs
# (3) 交接摘要
git -C I:\VMsShare\_src-compare\codex grep -n "SUMMARY_PREFIX" -- codex-rs/prompts/src/compact.rs codex-rs/core/src/compact.rs
# (4) 20k 常量
git -C I:\VMsShare\_src-compare\codex grep -n "COMPACT_USER_MESSAGE_MAX_TOKENS" -- codex-rs/core/src/compact.rs
# (5) 降级丢弃最早历史
git -C I:\VMsShare\_src-compare\codex grep -n "remove_first_item" -- codex-rs/core/src/compact.rs
# (6) 远程分流
git -C I:\VMsShare\_src-compare\codex grep -n "RemoteCompactionSupport" -- codex-rs/core/src/session/turn.rs
# (7) token budget flag
git -C I:\VMsShare\_src-compare\codex grep -n "Feature::TokenBudget" -- codex-rs/features/src/lib.rs codex-rs/core/src/tools/spec_plan.rs
# (8) hint 上限
git -C I:\VMsShare\_src-compare\codex grep -n "MAX_THREAD_HINT_BYTES" -- codex-rs/ext/history-notes/src/extension.rs
# (9) history 工具名
git -C I:\VMsShare\_src-compare\codex grep -n "fn name" -- codex-rs/ext/history-notes/src/tools.rs
# (10) AGENTS.md
git -C I:\VMsShare\_src-compare\codex grep -n "DEFAULT_AGENTS_MD_FILENAME" -- codex-rs/core/src/agents_md.rs
```

*报告结束。所有代码片段均为仓库当前内容逐字摘录，每段 ≤ 15 行。*
