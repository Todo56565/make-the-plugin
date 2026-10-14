# Codex 子 Agent 上下文边界与压缩 —— 只读取证报告

- 仓库：`I:\VMsShare\_src-compare\codex`（Rust monorepo，源码根 `codex-rs/`）
- 基线 commit：`a07c8ebd57feedc4cf5dfe854c8e9101de54186b`（2026-10-11，`Handle broken pipes gracefully in plugin list output (#53109)`）
- **重要基线限制：该检出是 shallow clone（`.git\shallow` 存在，`git rev-list --count HEAD` = 1）。任何依赖 git 历史的取证（PR 说明、feature 引入动机的历史）在本仓库**不可能**完成，已在 UNVERIFIED 中列出。**
- 本次为只读取证，未修改任何文件。

---

## 1. 结论摘要（逐问题一句话）

| # | 问题 | 结论 |
|---|---|---|
| A1 | 子 Agent 是否有独立 context window？ | **是。** 子 Agent 是独立 `Thread`/`Session`，窗口与压缩阈值来自它自己的 `Config`（由父的 turn config 克隆后按角色/模型覆盖）；`TurnContext::model_context_window()` 只读本 session 的 `ModelInfo`，父窗口不参与。 |
| A2 | 子 Agent 初始上下文包含什么？ | **两种模式**：`fork_turns=none`（默认）→ 全新线程，只有 `spawn_agent` 的 `message` 任务描述 + 子自己的 base/developer instructions；`fork_turns=all`（`SpawnAgentForkMode::FullHistory`）→ 拷贝父的**完整持久化 model context**（含父的 compaction checkpoint/replacement history），但**剔除** `TokenUsageRecord`、`Reasoning`、`FunctionCall`/`FunctionCallOutput(call_id)`、`AgentMessage`、父的 developer 指令与 usage hint，并追加"你现在是子 Agent"的 usage hint。 |
| A3 | 压缩归属？ | **子压缩自己的窗口。** 压缩在 `Session` 层（`session/turn.rs` → `compact*`），子 Agent 是独立 session 因此独立决策/独立压缩；检索范围内 `compact*.rs` 对 `SubAgent` 无任何特判，父不会代子压缩。 |
| B4 | 父能否感知子的上下文压力/压缩/换窗？ | **不能（模型可见层面）。** 无任何把子的 `active_context_tokens`/`auto_compact_scope_*`/`window_id`/`Compacted` 事件带回父的事件、消息、工具结果或提示注入。唯一的"跨 Agent 压力信号"是 `RolloutBudget`：**全树共享的 token 预算**，父与子都会各自收到"剩余预算"提醒，但那是**树级额度**，不是任何一个子 Agent 的窗口状态。 |
| B5 | 子结束时向父回传什么？ | 仅 `AgentStatus`：`Completed(Option<String>)` = 子最后一轮 final assistant 文本（或空），或 `Errored(String)`；渲染为 `InterAgentCompletionMessage` 后以 `InterAgentCommunication`（`trigger_turn=false`）投递。**无任何 token/窗口/压缩字段。** 同轮还会向发起线程 emit 一个 `SubAgentActivityItem{kind:Completed}`，其字段只有 model / reasoning_effort / id / kind / agent_thread_id / agent_path。 |
| C6 | 子压缩后是否有"重新获得任务契约"机制？ | **部分有，且是隐式的。** (a) 本地文本压缩（`compact.rs`）把**用户原话**（含 spawn 任务消息）在 20k token 预算内保留进 replacement history；(b) 每次换窗都会用 `build_initial_context_with_world_state` **重建初始上下文**（子自己的 developer instructions、usage hint、world state）；(c) `TokenUsageRecord`/`TokenUsage` 在 fork 时被剥离，无"任务状态文件读回"机制。但 **`new_context`（Feature `TokenBudget`）与 token-budget 换窗是"不做摘要、直接开新窗口"**，此时**没有**把 spawn 任务消息重新注入的专用机制——只能依赖它作为 user message 被其他地方保留。 |
| C7 | `SubagentDefaultContextLimits` 的语义与动机？ | **语义（代码可确证）**：开启后，为子 Agent 构造 config 时把 `model_context_window` 与 `model_auto_compact_token_limit` 置 `None`，即**放弃父的显式覆盖，回落到模型目录自身的窗口/阈值**（`ModelInfo::resolved_context_window()` / `auto_compact_token_limit()`）。**动机（无注释、无文档、无历史）→ UNVERIFIED**，仅有灰度信号：该 feature 至今 `Stage::UnderDevelopment`、`default_enabled: false`，且**全仓唯一使用点只有 `child_config.rs:137`**。 |
| C8 | 多 Agent 协作模式下上下文是否互相可见？ | **模型可见层面互不可见。** V2 的 Agent 间工具面（`spawn_agent`/`send_message`/`followup_task`/`wait_agent`/`interrupt_agent`/`list_agents`）只暴露**身份 + 生命周期状态**（`list_agents` 返回 `{agent_name, agent_status}`，`spawn_agent` 返回 `{task_name, nickname}`）。唯一"看自己窗口"的工具 `get_context_remaining` 读的是 `invocation.session` 自身状态，无法指定目标 Agent。**例外（非窗口状态）**：Guardian 审查会话与 `get_guardian_package` 确实读取**父/根的有界证据**（授权、发送者消息、根历史），这是跨 Agent 上下文传递，但方向是"父→子"的证据，且不含 token/窗口字段。 |

---

## 2. 逐问题证据

### A1. 子 Agent 有自己的独立 context window

**(a) 子 config 的构造：父 config 克隆 + 显式置空（feature 开启时）**

`codex-rs/core/src/agent/child_config.rs:132-165`（关键 132-146）：

```rust
fn build_agent_shared_config(turn: &TurnContext) -> Result<Config, String> {
    let base_config = turn.config.clone();
    let mut config = (*base_config).clone();
    if config
        .features
        .enabled(Feature::SubagentDefaultContextLimits)
    {
        config.model_context_window = None;
        config.model_auto_compact_token_limit = None;
    }
    // Preserve activation for history forks without freezing the parent's model-owned prompts.
    // Fresh child startup restores configured preferences from the retained snapshot.
    config.token_budget = turn.configured_token_budget.clone();
    config.model = Some(turn.model_info().slug.clone());
    config.model_provider = turn.provider.info().clone();
```

**(b) 决定子窗口/压缩上限的调用点（`child_config.rs` 之外）**

- spawn：`codex-rs/core/src/agent/child_config.rs:110-122`（`build_agent_spawn_config`，调用 `build_agent_shared_config`）
- resume：`codex-rs/core/src/agent/child_config.rs:124-130`（`build_agent_resume_config`，同样调用 `build_agent_shared_config`）
- 调用者：
  - `codex-rs/core/src/agent/control/spawn.rs:408`（`config = build_agent_resume_config(&turn)`）
  - `codex-rs/core/src/tools/handlers/multi_agents_v2/spawn.rs:134-147`（V2 spawn 走 `prepare_agent_spawn_config`）
  - `codex-rs/core/src/tools/handlers/multi_agents_v2/message_tool.rs:60`、`multi_agents/resume_agent.rs:86`、`multi_agents/send_input.rs:58`
- 另有一处复现同一覆写模式：`codex-rs/core/src/guardian/review.rs:151-154`（仅当 review 模型 ≠ 父模型时）：

```rust
    if review_model.model != context.model_info.slug {
        spawn_config.model_context_window = None;
        spawn_config.model_auto_compact_token_limit = None;
    }
```

（注意：guardian 这处是**条件性**的——模型不同才清空；child_config 那处是**无条件**的，只要 feature 开就清空。）

**(c) 窗口最终从子自己的 `ModelInfo` 解析（与父窗口无关）**

`codex-rs/core/src/session/turn_context.rs:755-758`：

```rust
    /// Legacy: returns the frozen initial-turn model context window.
    /// Step-scoped consumers should use their captured `StepContext::settings`.
    pub(crate) fn model_context_window(&self) -> Option<i64> {
        self.model_info().usable_context_window()
    }
```

`codex-rs/core/src/session/context_window.rs:53-95`（子 session 的 token 状态完全由自己的 config + model_info + 自己的累计用量决定）：

```rust
async fn context_window_token_status_with_config(
    sess: &Session,
    config: &Config,
    model_info: &ModelInfo,
) -> ContextWindowTokenStatus {
    let active_context_tokens = sess.get_total_token_usage().await;
    ...
            AutoCompactTokenLimitScope::BodyAfterPrefix => {
                let window = sess.auto_compact_window_snapshot().await;
                ...
            }
    };
    // The model's full context window is a hard cap, independent of the auto-compaction scope.
    let full_context_window_limit = model_info.resolved_context_window().map(|context_window| {
        context_window.saturating_mul(model_info.effective_context_window_percent) / 100
    });
```

**(d) 置 `None` 后的实际回落语义**

`codex-rs/protocol/src/openai_models.rs:517-541`：

```rust
impl ModelInfo {
    pub fn resolved_context_window(&self) -> Option<i64> {
        self.context_window.or(self.max_context_window)
    }
    ...
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
    }
```

**(e) 用量账本按 thread 隔离（父的累计用量不进入子）**

`codex-rs/core/src/agent/control/spawn.rs:121-123`：

```rust
        // Child threads inherit model context, not the parent's cumulative usage state.
        RolloutItem::TokenUsageRecord(_) => false,
```

`codex-rs/core/src/agent/control/spawn.rs:1240-1243`：

```rust
                RolloutItem::Compacted(compacted) => {
                    // This compaction becomes part of the subagent's initial history. Rewrite its
                    // metadata to describe the child rather than the parent.
                    compacted.latest_token_usage_record = None;
```

`codex-rs/core/src/agent/control_tests.rs:2711-2721`（测试断言子 rollout 不含父的用量记录/检查点）：

```rust
        "child rollout should not inherit parent token usage checkpoints"
    );
    let inherited_resume_metadata = lines
        .iter()
        .find_map(|line| match &line.item {
            RolloutItem::Compacted(item) => item.resume_metadata.as_ref(),
```

---

### A2. 子 Agent 的初始上下文

**(a) 两种 fork 模式与边界选取**

V2 工具参数解析：`codex-rs/core/src/tools/handlers/multi_agents_v2/spawn.rs:279-305`：

```rust
impl SpawnAgentArgs {
    fn fork_mode(&self) -> Result<Option<SpawnAgentForkMode>, FunctionCallError> {
        if self.fork_context.is_some() {
            return Err(FunctionCallError::RespondToModel(
                "fork_context is not supported in MultiAgentV2; use fork_turns instead".to_string(),
            ));
        }
        let fork_turns = self
            .fork_turns
            .as_deref()
            .map(str::trim)
            .filter(|fork_turns| !fork_turns.is_empty())
            .unwrap_or("all");
        if fork_turns.eq_ignore_ascii_case("none") {
            return Ok(None);
        }
        // Accept legacy turn counts without limiting the inherited history.
        if fork_turns.eq_ignore_ascii_case("all") || fork_turns.parse::<NonZeroUsize>().is_ok() {
            return Ok(Some(SpawnAgentForkMode::FullHistory));
        }
```

**注意**：`fork_turns` 只区分 `none` / `all`；数字（历史遗留）被当作 `all` 处理，**不存在"只 fork 前 N 轮"的截断**。`SpawnAgentForkMode` 只有一个变体（`codex-rs/core/src/agent/types.rs:21-24`）：

```rust
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SpawnAgentForkMode {
    FullHistory,
}
```

V1 侧对应 `args.fork_context`（布尔）：`codex-rs/core/src/tools/handlers/multi_agents/spawn.rs:112`：

```rust
    let fork_mode = args.fork_context.then_some(SpawnAgentForkMode::FullHistory);
```

**(b) 无 fork：全新线程，初始输入只有任务消息**

`codex-rs/core/src/agent/control/spawn.rs:799-834`（`fork_mode` 为 `None` 时不加载父历史，只对齐 history_mode）：

```rust
        let fork_context = match (session_source, options.fork_mode.as_ref()) {
            (Some(session_source), Some(_)) => {
                ...
            }
            (Some(_), None) => {
                if let Some(parent_thread_id) = parent_thread_id
                    && let Ok(parent_thread) = state.get_thread(parent_thread_id).await
                {
                    start_options.history_mode = matches!(
                        parent_thread.config_snapshot().await.history_mode,
                        ThreadHistoryMode::Paginated
                    )
                    .then_some(ThreadHistoryMode::Paginated);
                    ...
                }
                None
            }
            (None, _) => None,
        };
```

子线程的启动输入来自工具调用：`codex-rs/core/src/tools/handlers/multi_agents_v2/spawn.rs:191-194`：

```rust
            input: AgentInput::Message {
                message: agent_message_from_tool(message, &source),
                mode: MessageDeliveryMode::TriggerTurn,
            },
```

**(c) fork 的边界：白名单式裁剪（保留什么/丢弃什么）**

`codex-rs/core/src/agent/control/spawn.rs:81-125`：

```rust
fn keep_forked_rollout_item(item: &RolloutItem, preserve_context_baselines: bool) -> bool {
    match item {
        RolloutItem::ResponseItem(envelope) => match &envelope.item {
            ResponseItem::Message { role, phase, .. } => match role.as_str() {
                "system" | "developer" | "user" => true,
                "assistant" => matches!(
                    phase,
                    Some(MessagePhase::PartialAnswer | MessagePhase::FinalAnswer)
                ),
                _ => false,
            },
            ...
            ResponseItem::AgentMessage { .. }
            | ResponseItem::Reasoning { .. }
            | ResponseItem::LocalShellCall { .. }
            | ResponseItem::FunctionCall { .. }
            ...
            | ResponseItem::Compaction { .. }
            | ResponseItem::CompactionTrigger { .. }
            | ResponseItem::ContextCompaction { .. }
            | ResponseItem::Other => false,
        },
        RolloutItem::RealtimeItem(_)
        | RolloutItem::InterAgentCommunication(_)
        | RolloutItem::InterAgentCommunicationMetadata { .. }
        | RolloutItem::RetainedContext(_)
        | RolloutItem::SecurityRiskScore(_) => false,
        // Full-history forks preserve the cached prompt prefix and can keep diffing
        // from the parent's durable baseline unless legacy compaction requires rebuilding it.
        RolloutItem::TurnContext(_) | RolloutItem::WorldState(_) => preserve_context_baselines,
        // Child threads inherit model context, not the parent's cumulative usage state.
        RolloutItem::TokenUsageRecord(_) => false,
        RolloutItem::Compacted(_) | RolloutItem::EventMsg(_) | RolloutItem::SessionMeta(_) => true,
    }
}
```

**但**：`MultiAgentVersion::V2` + `multi_agent_v2.preserve_fork_prefix` 时，所有 `ResponseItem` **全部保留**（走缓存前缀复用路径）——`codex-rs/core/src/agent/control/spawn.rs:1116-1128, 1218-1220`：

```rust
        let preserve_fork_prefix = multi_agent_version == MultiAgentVersion::V2
            && config.multi_agent_v2.preserve_fork_prefix
            && preserve_context_baselines;
        if preserve_fork_prefix {
            let InitialHistory::Forked(items) = fork_history_from_snapshot(
                ForkSnapshot::Interrupted,
                InitialHistory::Forked(forked_rollout_items),
                InterruptedTurnHistoryMarker::Disabled,
            ) else {
                unreachable!("a forked snapshot remains forked");
            };
            forked_rollout_items = items;
        }
```

```rust
        forked_rollout_items.retain_mut(|item| {
            let keep = (preserve_fork_prefix && matches!(item, RolloutItem::ResponseItem(_)))
                || keep_forked_rollout_item(item, preserve_context_baselines);
```

**(d) fork 时注入的"你是子 Agent"提示（上下文边界声明）**

`codex-rs/core/src/agent/control/spawn.rs:1287-1293`：

```rust
        if preserve_fork_prefix {
            forked_rollout_items.push(RolloutItem::ResponseItem(
                ContextualUserFragment::into(MultiAgentUsageHint::new(
                    "You are now a newly spawned child agent. The preceding conversation is inherited parent context. Follow your own role, identity, and task below; earlier identities, tasks, and action-specific approvals belong to your ancestors. Inherited tool calls are historical records; live tool sessions and process handles are not inherited. Report your result to your parent.",
                )).into(),
            ));
        }
```

**(e) 父的 developer 指令被替换为子的（不是简单继承）**

`codex-rs/core/src/agent/control/spawn.rs:1188-1213`（`parent_developer_instructions` → `subagent_developer_instructions` 的逐字替换）：

```rust
                    let (
                        Some(parent_developer_instructions),
                        Some(subagent_developer_instructions),
                    ) = (
                        parent_developer_instructions.as_ref(),
                        subagent_developer_instructions.as_ref(),
                    )
                    else {
                        return true;
                    };
                    // TODO(anp) track better message fragment provenance in rollouts.
                    if !text.contains(parent_developer_instructions) {
                        return true;
                    }

                    *replaced = true;
                    let replacement = if preserve_context_baselines {
                        subagent_developer_instructions.as_str()
                    } else {
                        ""
                    };
                    *text = text.replace(parent_developer_instructions, replacement);
```

端到端测试（含"父已被压缩，子继承压缩摘要"）：`codex-rs/app-server/tests/suite/v2/multi_agent_v2_developer_instructions.rs:282-470`，关键断言 447-466：

```rust
    assert!(
        child_request.body_contains_text(COMPACTED_SUMMARY),
        "the full-history child should inherit the compacted parent summary"
    );
    let child_developer_texts = child_request.message_input_texts("developer");
    assert_eq!(
        child_developer_texts
            .iter()
            .filter(|text| text.as_str() == CHILD_INSTRUCTIONS)
            .count(),
        1,
        "the child should receive its configured developer instructions exactly once"
    );
    assert!(
        child_developer_texts
            .iter()
            .all(|text| text != PARENT_INSTRUCTIONS),
        "the child should not inherit parent instructions from compacted history"
    );
```

**结论**：fork 是"父的 model context 快照"级别，不是"父的实时上下文"；且 `fork_turns` 无法做部分截断。

---

### A3. 压缩归属：子压缩自己的窗口

**(a) 压缩运行在 `Session` 层，由该 session 自己的 turn 驱动**

`codex-rs/core/src/session/turn.rs:9-10`：

```rust
use crate::compact::run_inline_auto_compact_task;
use crate::compact_remote_v2::run_inline_remote_auto_compact_task as run_inline_remote_auto_compact_task_v2;
```

`codex-rs/core/src/session/turn.rs:346-353 / 611-628 / 718-736`（pre-turn / mid-turn / post-turn 三个触发点，全部基于**本 session** 的 `token_status`）：见 §A1(c)。

**(b) 压缩模块对"子 Agent"零特判（否定证据）**

对 `codex-rs/core/src/compact.rs`、`compact_remote_v2.rs`、`compact_token_budget.rs` 检索
`SubAgent|subagent|is_subagent|ThreadSpawn|session_source` → **0 命中**。
（检索范围与命令见 §3。）

**(c) token-budget 换窗的自我描述**

`codex-rs/core/src/compact_token_budget.rs:16-24, 51-61`：

```rust
/// Runs token-budget manual compaction as a normal compaction lifecycle.
///
/// Token-budget compaction skips model/server summarization and installs a fresh context window
/// instead. It is still modeled as compaction so compact hooks and `ContextCompaction` turn items
/// observe the same lifecycle as local or remote compaction.
pub(crate) async fn run_manual_compact_task(
```

```rust
    let compaction_item = TurnItem::ContextCompaction(ContextCompactionItem::new());
    sess.emit_turn_item_started(turn_context, &compaction_item)
        .await;
    sess.start_new_context_window(step_context, world_state)
        .await;
```

---

### B4. 子 → 父的上下文/压缩回传：**不存在**（模型可见层面）

**(a) 子 session 的 `TokenCount` 只在子自己的事件流里**

`codex-rs/core/src/session/mod.rs:4985-4993`：

```rust
    pub(crate) async fn send_token_count_event(&self, turn_context: &TurnContext) {
        let (info, rate_limits) = {
            let state = self.state.lock().await;
            state.token_info_and_rate_limits()
        };
        let event = EventMsg::TokenCount(TokenCountEvent { info, rate_limits });
        self.send_event(turn_context, event).await;
    }
```

`TokenCount` 是 `EventMsg`，走该 session 的客户端事件流（app-server 转发为 `thread/tokenUsage/updated`，按 `threadId` 区分——见 `codex-rs/app-server/tests/suite/v2/multi_agent_v2_developer_instructions.rs:884-890`）：

```rust
    let is_child_usage = |notification: &JSONRPCNotification| {
        notification.method == "thread/tokenUsage/updated"
            && notification
                .params
                .as_ref()
                .is_some_and(|params| params["threadId"].as_str() == Some(child_thread_id.as_str()))
    };
```

**(b) 唯一跨 Agent 的"压力"信号：树级共享 `RolloutBudget`（不是窗口状态）**

`codex-rs/core/src/rollout_budget.rs:18-29, 47-93`：

```rust
/// Shared accounting and reminder state for one root-thread session tree.
#[derive(Default)]
pub(crate) struct RolloutBudget {
    state: OnceLock<Mutex<RolloutBudgetState>>,
}

struct RolloutBudgetState {
    config: RolloutBudgetConfig,
    weighted_tokens_used: f64,
    /// Last reminder delivered to each thread, so every thread observes crossed thresholds.
    deliveries: HashMap<ThreadId, ThreadBudgetDelivery>,
}
```

```rust
    /// Returns true once the configured budget is exhausted, including on later calls.
    pub(crate) fn record_usage(&self, usage: &TokenUsage) -> CodexResult<bool> {
        ...
        state.weighted_tokens_used += units;
        Ok(state.weighted_tokens_used >= state.config.limit_tokens as f64)
    }
```

子 Agent 的用量经 `AgentControl::record_usage` 记入**同一树级账本**：`codex-rs/core/src/agent/control/api.rs:286-290` 与 `codex-rs/core/src/agent/control/budget.rs:11-17`。因此父会被**间接**影响（额度被子的消耗推进），且父可读到"剩余额度"。**但这既不是子的 `context window`，也不是子的压缩状态。**

**(c) `AgentControl` 契约里没有任何读取子窗口/压缩的方法**

`codex-rs/core/src/agent/api.rs:35-165` 全量方法清单：`identity` / `resolve` / `spawn` / `send` / `take_mailbox` / `watch_mailbox` / `ensure_child_loaded` / `interrupt` / `list` / `child_agent_paths` / `check_turn_admission` / `admit_turn` / `record_usage` / `turn_finished` / `service_tier` / `propagate_config_update` / `get_guardian_package` / `pending_budget_reminder` / `mark_budget_reminder_delivered`。
- `list` 返回 `Vec<LiveAgent>`（`codex-rs/core/src/agent/types.rs:44-50`：`thread_id` / `metadata` / `status`），**无窗口字段**
- `child_agent_paths` 返回 `Vec<AgentPath>`
- `get_guardian_package(agent)` 返回 `Option<GuardianRootSnapshot>`，方向是"worker 读 root 证据"，非"root 读 worker 窗口"

**(d) 工具面同样无窗口回传**

`list_agents` 输出结构：`codex-rs/core/src/tools/handlers/multi_agents_v2/list_agents.rs:59-70` 与 `:87-91`：

```rust
        let agents = agents
            .into_iter()
            .map(|agent| ListedAgent {
                agent_name: agent
                    .metadata
                    .agent_path
                    .as_ref()
                    .map(ToString::to_string)
                    .unwrap_or_else(|| agent.thread_id.to_string()),
                agent_status: agent.status,
            })
            .collect();
```

```rust
#[derive(Debug, Serialize)]
struct ListedAgent {
    agent_name: String,
    agent_status: AgentStatus,
}
```

`spawn_agent` 输出：`codex-rs/core/src/tools/handlers/multi_agents_v2/spawn.rs:308-318`：

```rust
#[derive(Debug, Serialize)]
#[serde(untagged)]
pub(crate) enum SpawnAgentResult {
    WithNickname {
        task_name: String,
        nickname: Option<String>,
    },
    HiddenMetadata {
        task_name: String,
    },
}
```

"读自己剩余窗口"的工具是**自作用域**的（无法指定目标 Agent）：`codex-rs/core/src/tools/handlers/get_context_remaining.rs:85-93`：

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

---

### B5. 子结束时的回传内容

**(a) 回传载体只有 `AgentStatus`**

`codex-rs/protocol/src/protocol.rs:1928-1948`（`pub enum AgentStatus` 在 1932 行）：

```rust
/// Agent lifecycle status, derived from emitted events.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq, JsonSchema, TS, Default)]
#[serde(rename_all = "snake_case")]
#[ts(rename_all = "snake_case")]
pub enum AgentStatus {
    /// Agent is waiting for initialization.
    #[default]
    PendingInit,
    /// Agent is currently running.
    Running,
    /// Agent's current turn was interrupted and it may receive more input.
    Interrupted,
    /// Agent is done. Contains the final assistant message.
    Completed(Option<String>),
    /// Agent encountered an error.
    Errored(String),
    /// Agent has been shutdown.
    Shutdown,
    /// Agent is not found.
    NotFound,
}
```

**(b) 回传路径（完整调用链）**

`codex-rs/core/src/agent/control/completion.rs:27-128`：

```rust
    /// Routes a captured terminal outcome without retaining the child's live turn context.
    pub(crate) async fn notify_parent_of_terminal_turn(
        &self,
        outcome: AgentTurnOutcome,
        trace: &ThreadTraceContext,
    ) {
```

```rust
        let message = match (&status, outcome.error_info) {
            (AgentStatus::Errored(error), Some(CodexErrorInfo::TooManyDenials)) => {
                Some(format_guardian_interruption_message(
                    parent_agent_path.clone(),
                    child_agent_path.clone(),
                    error,
                ))
            }
            _ => format_inter_agent_completion_message(
                parent_agent_path.clone(),
                child_agent_path.clone(),
                &status,
            ),
        };
        let Some(message) = message else {
            return;
        };
        // `communication` owns the message. Keep a second copy only when the
        // recorder will actually need it after parent delivery succeeds.
        let trace_message = trace.is_enabled().then(|| message.clone());
        let communication = InterAgentCommunication::new(
            child_agent_path.clone(),
            parent_agent_path,
            Vec::new(),
            message,
            /*trigger_turn*/ false,
        );
```

`codex-rs/core/src/session_prefix.rs:20-37`（消息体构造 + 1k token 上限）：

```rust
pub(crate) fn format_inter_agent_completion_message(
    task_name: AgentPath,
    sender: AgentPath,
    status: &AgentStatus,
) -> Option<String> {
    let payload = match status {
        AgentStatus::Completed(Some(message)) => message.clone(),
        AgentStatus::Completed(None) => String::new(),
        AgentStatus::Errored(error) => {
            let error = truncate_text(error, TruncationPolicy::Tokens(ERROR_MAX_TOKENS));
            format!("Agent errored: {error}\n\n{ERROR_NEXT_ACTION}")
        }
        AgentStatus::Shutdown => "Agent shut down.".to_string(),
        AgentStatus::NotFound => "Agent was not found.".to_string(),
        AgentStatus::PendingInit | AgentStatus::Running | AgentStatus::Interrupted => return None,
    };
    Some(InterAgentCompletionMessage::new(task_name, sender, payload).render())
}
```

（上限常量：`codex-rs/core/src/session_prefix.rs:9-12`，`COMPLETION_MESSAGE_MAX_TOKENS = 1_000`。）

**(c) `AgentTurnOutcome` 结构确认无上下文/压缩字段**

`codex-rs/core/src/agent/api.rs:235-244`：

```rust
pub struct AgentTurnOutcome {
    pub thread_id: ThreadId,
    pub turn_id: String,
    pub source: SessionSource,
    pub parent_turn_id: Option<String>,
    pub initiating_agent_path: Option<AgentPath>,
    pub status: AgentStatus,
    /// Typed reason used to choose guidance in the parent notification.
    pub error_info: Option<CodexErrorInfo>,
}
```

**(d) 同轮的活动通知也不含窗口字段**

`codex-rs/protocol/src/protocol.rs` `SubAgentActivityEvent`（4486 行 `pub enum SubAgentActivityKind`，4494 行 `pub struct SubAgentActivityEvent`；`SubAgentActivityKind` = `Started|Interacted|Interrupted|Completed`）：

```rust
pub enum SubAgentActivityKind {
    Started,
    Interacted,
    Interrupted,
    Completed,
}

pub struct SubAgentActivityEvent {
    /// Resolved model at sub-agent creation; absent from older records and other activities.
    pub model: Option<String>,
    /// Resolved reasoning effort at sub-agent creation, when known.
    pub reasoning_effort: Option<ReasoningEffortConfig>,
    pub event_id: String,
    #[serde(default)]
    pub occurred_at_ms: i64,
    /// Thread ID of the affected sub-agent.
    pub agent_thread_id: ThreadId,
    /// Canonical v2 path of the affected sub-agent.
    pub agent_path: AgentPath,
    pub kind: SubAgentActivityKind,
}
```

与 `codex-rs/protocol/src/items.rs` 的 `SubAgentActivityItem`（`model`/`reasoning_effort`/`id`/`kind`/`agent_thread_id`/`agent_path`）一致。

**(e) 子会话的 `final answer` 语义由提示词固化**

`codex-rs/prompts/src/model_messages/multi_agent.rs:27-45`（子 Agent 侧 hint，第 34 行）：

```rust
const DEFAULT_MULTI_AGENT_V2_SUBAGENT_USAGE_HINT_TEXT: &str = r#"You are an agent in a team of agents collaborating to complete a task.
...
When you provide a response in the final channel, that content is immediately delivered back to your parent agent.
```

---

### C6. 压缩后是否"重新获得任务契约"

**(a) 本地文本压缩：用户原话被保留（含 spawn 任务消息）**

`codex-rs/core/src/compact.rs:63`：

```rust
const COMPACT_USER_MESSAGE_MAX_TOKENS: usize = 20_000;
```

`codex-rs/core/src/compact.rs:574-599`（筛选：仅排除 summary 消息，其余用户消息全部收集；`collect_user_messages` 为 test-only 包装，在 566-572 行）：

```rust
pub(crate) fn collect_annotated_user_messages(
    items: &[ResponseItemEnvelope],
) -> Vec<CompactedUserMessage<'_>> {
    items
        .iter()
        .filter_map(|envelope| compacted_user_message(&envelope.item, envelope.metadata.as_ref()))
        .collect()
}

fn compacted_user_message<'a>(
    item: &'a ResponseItem,
    harness_metadata: Option<&'a CodexHarnessMetadata>,
) -> Option<CompactedUserMessage<'a>> {
    let Some(TurnItem::UserMessage(user)) = crate::event_mapping::parse_turn_item(item) else {
        return None;
    };
    let message = user.message();
    if is_summary_message(&message) {
        return None;
    }
    Some(CompactedUserMessage { ... })
}
```

**(b) 每次换窗都重建"初始上下文"（即契约的系统侧部分被重新注入）**

`codex-rs/core/src/session/mod.rs:4658-4700`（`start_new_context_window`）：

```rust
    pub(crate) async fn start_new_context_window(
        &self,
        step_context: &StepContext,
        world_state: Arc<WorldState>,
    ) {
        let turn_context = step_context.turn.as_ref();
        let history = self.clone_history().await;
        ...
        let (context_updates, world_state_snapshot) = self
            .build_initial_context_with_world_state(step_context, world_state.as_ref())
            .await;
```

`codex-rs/core/src/session/mod.rs:4326-4345`（重建内容含 developer instructions）：

```rust
        if !separate_guardian_developer_message
            && let Some(developer_instructions) = turn_context.developer_instructions.as_deref()
            && !developer_instructions.is_empty()
        {
            developer_sections
                .push(DeveloperInstructions::new(developer_instructions).render_fragment());
        }
```

**(c) `new_context` 工具明确"不做摘要"**

`codex-rs/core/src/tools/handlers/new_context_window.rs:13-45`：

```rust
pub(crate) const NEW_CONTEXT_WINDOW_MESSAGE: &str =
    "A new context window will start without summarizing conversation history.";
...
            invocation.session.request_new_context_window().await;
```

触发点（mid-turn，`needs_follow_up` 且请求/触顶）：`codex-rs/core/src/session/turn.rs:610-628`：

```rust
                let should_roll_over = needs_follow_up
                    && (sess.take_new_context_window_request().await || token_limit_reached);
                let allow_auto_compact_fallback = !should_roll_over && !token_limit_reached;
```

**判断**：不存在专门的"压缩后重放 brief / 读回任务状态文件"机制。契约的**系统侧部分**（developer instructions、usage hint、world state）在每次换窗时由 `build_initial_context_with_world_state` 天然重建；契约的**用户侧部分**（spawn 任务消息）只在**摘要型压缩**里因 `collect_user_messages` 的 20k 保留而被保住，在 `new_context` / token-budget 换窗里没有专用重放路径。

---

### C7. `SubagentDefaultContextLimits` 语义与动机

**(a) feature 定义（灰度）**

`codex-rs/features/src/lib.rs:1481-1486`：

```rust
    FeatureSpec {
        id: Feature::SubagentDefaultContextLimits,
        key: "subagent_default_context_limits",
        stage: Stage::UnderDevelopment,
        default_enabled: false,
    },
```

**(b) 全仓唯一使用点**

对全仓（`.rs/.md/.toml/.json`，排除 `target/`）检索 `SubagentDefaultContextLimits` → 仅 3 命中：
1. `codex-rs/features/src/lib.rs:231`（枚举成员声明）
2. `codex-rs/features/src/lib.rs:1482`（FeatureSpec 注册）
3. `codex-rs/core/src/agent/child_config.rs:137`（唯一消费者）

**没有**任何专属测试、注释、doc、README 提到它。（`features/src/feature_configs.rs` 中也**没有** `subagent_default_context_limits` 的 TOML 配置面——说明它只能通过 feature 开关启停，不能带参数。）

**(c) 语义（可确证）**

`codex-rs/core/src/agent/child_config.rs:135-141` + `codex-rs/protocol/src/openai_models.rs:1849-1876`（§A1(d)）→ 开启后子 Agent **不再继承父的 `model_context_window` / `model_auto_compact_token_limit` 显式值**，改为回落到子自己模型的目录默认（窗口 = `context_window.or(max_context_window)`；自动压缩阈值 = `min(配置值, 窗口×90%)`，无配置则 `窗口×90%`）。

字段来源 `codex-rs/core/src/config/mod.rs:650` 与 `:655-657`：

```rust
    pub model_context_window: Option<i64>,
    ...
    /// Controls whether `model_auto_compact_token_limit` applies to the full
    ...
    pub model_auto_compact_token_limit_scope: AutoCompactTokenLimitScope,
```

**(d) 动机 → UNVERIFIED**

代码内**没有**任何注释解释为什么要把子 Agent 的这两个字段置 `None`（`child_config.rs:135-141` 只有条件与赋值，无 `//` 说明）；仓库无 `docs/` 相关文档（`codex-rs/docs/` 仅 `bazel.md`、`protocol_v1.md`）；无 `.agents/` 笔记目录（仅有 `exec-server/src/sandbox_integrity/AGENTS.md`、`tui/src/bottom_pane/AGENTS.md`，与本主题无关）；**仓库为 shallow clone，无法用 git log/blame 追溯引入 PR**。
可确证的只有两个**间接信号**：该 feature 长期停在 `UnderDevelopment` + `default_enabled: false`（灰度未放量），且它与 `guardian/review.rs:151-154` 的"模型不同就清空"是同一意图的两种写法——都指向"**父与子模型不同时，父的窗口数值对子无意义，应回落到子模型的真实窗口**"。

---

### C8. 多 Agent 协作模式下上下文互相可见性

**(a) V2 工具面（互不可见窗口）**

`codex-rs/core/src/tools/handlers/multi_agents_v2/` 目录内容：`analytics.rs`、`followup_task.rs`、`interrupt_agent.rs`、`list_agents.rs`、`message_tool.rs`、`send_message.rs`、`spawn.rs`、`wait.rs`。
- `list_agents` → `{agent_name, agent_status}`（§B4(d)）
- `spawn_agent` → `{task_name, nickname}`（§B4(d)）
- `get_context_remaining` → 自 session 剩余 token（§B4(d)），且受 `Feature::TokenBudget` 门控：`codex-rs/core/src/tools/spec_plan.rs:1399-1404`（`if features.enabled(Feature::TokenBudget)` 在 1401 行）：

```rust
    if features.enabled(Feature::TokenBudget) {
        registry.add_with_exposure(NewContextWindowHandler, ToolExposure::DirectModelOnly);
        registry.add(GetContextRemainingHandler);
    }
```

**(b) 上下文传播由父显式控制（设计意图的官方表述）**

`codex-rs/prompts/src/model_messages/multi_agent.rs:7-26`（root hint）：

```rust
const DEFAULT_MULTI_AGENT_V2_ROOT_AGENT_USAGE_HINT_TEXT: &str = r#"You are `/root`, the primary agent in a team of agents collaborating to fulfill the user's goals.
...
Child agents can also spawn their own sub-agents.
You can decide how much context you want to propagate to your sub-agents with the `fork_turns` parameter.
```

**(c) "看另一个 Agent 的窗口状态"的能力：不存在；但存在"跨 Agent 读上下文"的两条例外链路（都不含窗口/压缩字段）**

例外 1 —— **Guardian 审查会话读父/根证据**（父→子的有界上下文传递）：`codex-rs/core/src/agent/api.rs:142-146`：

```rust
    /// Read the existing bounded root evidence for a worker. The local backend returns
    /// `None` for the root, a non-V2 tree, or an unavailable root runtime.
    fn get_guardian_package(&self, agent: ThreadId) -> BoxFuture<'_, Option<GuardianRootSnapshot>>;
```

用法（reviewer 侧读自己所属树）：`codex-rs/core/src/guardian/prompt.rs:119`、`review_request.rs:48,182,219,286`、`review_session_context.rs:45`、`codex_thread.rs:1052`。

例外 2 —— **跨线程投递时抓取发送者上下文**：`codex-rs/core/src/agent/control/sender_context.rs:1-13, 97-110`：

```rust
//! Captures genuine sender instructions and assistant context for host-delivered task messages.
//! Only turn-input admission calls this, before queueing; ordinary tool results and
//! quoted delegation text cannot establish sender provenance. Unloaded senders are read
//! through the host's authenticated thread store, without resuming their runtime.
```

```rust
        if let Some(source_thread_id) = source_thread_id
            && let Ok(manager) = self.upgrade()
        {
            let context = match manager.get_thread(source_thread_id).await {
                Ok(sender) => sender
                    .conversation_history_snapshot()
                    .await
                    .retained_context()
                    .cloned(),
```

（注意：这是 **retained_context / 授权证据**，不是模型窗口；且 `spawn.rs:1253-1257` 明确在 fork 时把它清空/重置。）

**(d) agent-graph-store：关系与状态，无窗口**

`codex-rs/agent-graph-store/` 仅提供线程 spawn 边的持久化（`Open` 状态等）：`codex-rs/core/src/agent/control/spawn.rs:203-218` 使用 `list_thread_spawn_descendants`；`codex-rs/core/src/agent/control/runtime_context.rs:32-39` 使用它枚举子树线程；`codex-rs/core/src/agent/control/runtime_context.rs:41-48` 只用它来渲染 `- <agent_ref>: <nickname>` 形式的子 Agent 清单行。均为身份/关系，非上下文状态。

---

## 3. 检索范围清单（否定结论的证据基础）

所有检索均在 `I:\VMsShare\_src-compare\codex\codex-rs` 下、排除 `target/`：

| 目的 | 范围 | 关键词 | 结果 |
|---|---|---|---|
| feature 全仓使用点 | 全部 `.rs/.md/.toml/.json` | `SubagentDefaultContextLimits` | 3 命中，全部在 §C7 列出 |
| 子 Agent 模块内的上下文/压缩交互 | `core/src/agent/**/*.rs` | `context_window\|auto_compact\|compact\|Compaction\|token_limit\|token_budget` | 命中集中在 `child_config.rs:139-140`、`spawn.rs:108-125/1105-1285`、`control_tests.rs`（测试） |
| 压缩模块是否特判子 Agent | `core/src/compact.rs`、`compact_remote_v2.rs`、`compact_token_budget.rs` | `SubAgent\|subagent\|is_subagent\|ThreadSpawn\|session_source` | **0 命中** |
| 子→父上下文回传 | 全仓 `.rs` | `EventMsg::TokenCount`、`TokenCount(` | 命中全在 session/rollout/app-server/analytics；**无**子→父转发点 |
| 压缩事件流转 | 全仓 `.rs` | `ContextCompacted\|ContextWindowUpdated\|CompactionTrigger` | `ContextCompacted` 仅走本 session 事件 → app-server `thread/compacted`；无跨 Agent |
| 工具面是否暴露 token/窗口 | `core/src/tools/handlers/**/*.rs` | `TokenUsage\|token_usage\|context_window` | 仅 `get_context_remaining.rs`（自作用域）、`new_context_window*.rs`（自作用域） |
| 文档/注释中的动机 | 全仓 `.md` + `codex-rs/docs/` + `AGENTS.md` | `subagent\|sub-agent\|child agent`、`compaction\|context window` | 命中的 `.md` 均为 orchestrator 模板、collab 提示、skills 样例、README；**无**本设计说明 |
| Agent 笔记 | 全仓 `.agents/`、`*.note.md` | 目录/文件名 | 无 `.agents/`；仅 2 个无关 `AGENTS.md` |
| git 历史 | `.git` | `git rev-list --count HEAD`、`.git\shallow` | **shallow clone（1 commit）**，历史取证不可行 |

---

## 4. 对 DSH 设计的可迁移点

### 4.1 可直接借鉴

1. **"子 Agent = 独立 session/thread，窗口与压缩阈值由自己的 config 决定"** 是最清晰的边界模型。Codex 用 `build_agent_shared_config` 单点集中决定子 Agent 的窗口/压缩配置（`child_config.rs:132-165`），spawn/resume 共用同一函数，语义一致。DSH 若走"子 Agent 独立上下文"，建议同样把"子上下文策略"收拢到**一个**构造点，避免 spawn/resume/重连三条路径漂移。
2. **fork 是"白名单裁剪的快照"，不是"共享实时上下文"**。`keep_forked_rollout_item`（`spawn.rs:81-125`）逐类型决定去留（丢弃 reasoning / tool call / 累计用量；保留 user/system/developer 与 compaction 检查点），并在快照后**追加**边界声明（`spawn.rs:1287-1293` 的"You are now a newly spawned child agent…"）。这是可迁移的：**继承历史必须显式声明边界**，否则子 Agent 会把父的历史误当自己的。
3. **用量账本隔离 + 树级预算分离**：子不继承父的 `TokenUsageRecord`（`spawn.rs:121-123`），但共享一个树级 `RolloutBudget`（`rollout_budget.rs`）。这个"**窗口按 Agent 隔离 / 预算按树共享**"的双层设计很适合 DSH：既避免子 Agent 被父的累计用量误压，又能让父间接感知全树成本。
4. **"压缩后契约重建"分两层**：摘要型压缩保留用户原话（`compact.rs` 20k 预算 + `collect_user_messages`），换窗型则无条件重建初始上下文（`start_new_context_window` → `build_initial_context_with_world_state`）。DSH 若要在子 Agent 换窗后保住任务契约，最稳的做法是**把任务契约放进"初始上下文构建"的那一层**（每次都重建），而不是依赖它在历史里存活。
5. **`get_context_remaining` 的自作用域设计**值得保留：让 Agent 只读自己的余量，是"暴露压力但不暴露他人窗口"的干净切分。

### 4.2 前提不成立 / 需要 DSH 自己决定的

1. **"父可以感知子的上下文压力"在 Codex 里不成立**。若 DSH 需要"父看到子快满了"来做调度决策（例如改派/拆分任务），Codex 没有可抄的实现——它的 `AgentTurnOutcome`、`AgentStatus`、`live agent list`、`SubAgentActivity*` 都不含窗口/压缩字段（§B5）。DSH 必须自己新增回传通道，并同时决定这是否会造成"子窗口状态污染父决策"。
2. **"fork 部分历史"在 Codex V2 里不成立**。`fork_turns` 只接受 `none|all`，数字也被当作 `all`（`multi_agents_v2/spawn.rs:287-304`）。若 DSH 想支持"只带最近 N 轮"，那是 Codex 没有的能力，需自建，并要额外解决"截断边界处的 tool call/output 配对"问题（Codex 通过整段丢弃 tool call + output 来规避，`spawn.rs:92-111`）。
3. **`SubagentDefaultContextLimits` 的动机不可抄**：没有注释/文档/历史可查（§C7(d)）。DSH 不能引用"Codex 因为 X 所以这样做"。只能引用其**可观测语义**（父显式窗口对子无效 → 回落子模型目录默认），并自行给出理由。
4. **Guardian 的跨 Agent 上下文传递不是通用的多 Agent 模式**：它是"审查者读被审查树的有界证据"（`get_guardian_package`），方向与语义都特化（授权/证据），且 `spawn.rs:1253` 在 fork 时会清空 `guardian_history`。不要把它当作"Agent 间上下文共享"的范本。
5. **远程压缩 ≠ 子 Agent 压缩**：`compact_remote_v2.rs` 是服务端 opaque 摘要（同一 session 内），与"子 Agent 是独立 session"无关；两者只在"都由本 session 的 turn 触发"这一点上共用基础设施（`session/turn.rs:9-10` 的两条 import）。

---

## 5. UNVERIFIED 清单

| # | 事项 | 原因 | 已检索位置 |
|---|---|---|---|
| U1 | `SubagentDefaultContextLimits` 的**设计动机**、引入 PR、作者意图 | 代码无注释；无文档；**仓库是 shallow clone（1 commit），`git log -S`/`git blame` 不可用** | `codex-rs/core/src/agent/child_config.rs:132-141`；`codex-rs/features/src/lib.rs:231,1481-1486`；`codex-rs/docs/**`；全仓 `.md`；`.agents/`（不存在）；`git rev-list --count HEAD` = 1；`.git\shallow` 存在 |
| U2 | 该 feature 是否有**规划中的**放量计划 / 对应测试矩阵 | 无专属测试；无 CHANGELOG | 全仓检索 `SubagentDefaultContextLimits`（3 命中）；`codex-rs/features/src/feature_configs.rs` 无对应 TOML 段 |
| U3 | 父 Agent 是否能通过 **app-server / TUI 之外的私有通道**（如 rollout trace、otel）看见子的压缩事件 | 仅确认 otel 有 `agent.type = main \| subagent` 属性与"可能导出子代理文本"的说明，未逐条核对事件 schema 是否含 compaction | `codex-rs/otel/README.md:136,144`；`codex-rs/rollout-trace/src/reducer/tool/agents.rs`；`codex-rs/analytics/src/facts.rs:454`（`CompactionTrigger`） |
| U4 | `fork_turns` 传入数字时"被当作 all"是否为**临时兼容**还是永久语义 | 注释只写 "Accept legacy turn counts without limiting the inherited history"，未见 TODO/issue 引用 | `codex-rs/core/src/tools/handlers/multi_agents_v2/spawn.rs:287-304` |
| U5 | `preserve_fork_prefix = true` 时"保留全部 ResponseItem"是否意味着子 Agent 会看到父的 `Compaction`/`ContextCompaction` 项 | 代码上 `preserve_fork_prefix` 分支在 `retain_mut` 中直接 `keep = true`，但 item 级语义（这些项对子模型是否可见/被过滤）未逐一验证 | `codex-rs/core/src/agent/control/spawn.rs:1116-1128,1218-1234`；`codex-rs/core/src/config/mod.rs:1374,1397` |
| U6 | `new_context` 换窗后 spawn 任务消息是否**确实丢失** | 逻辑上 `start_new_context_window` 只重建 initial context + retained client items；但未找到直接断言"任务消息丢失"的测试 | `codex-rs/core/src/session/mod.rs:4658-4700`；`codex-rs/core/src/session/turn.rs:610-628`；`codex-rs/core/src/tools/handlers/new_context_window.rs` |
| U7 | 是否存在**仓库外**（设计文档、RFC、OpenAI 内部）对本设计动机的说明 | 本次仅只读取证本仓库 | — |

---

## 附：与任务给定"已确认事实"的核对

| 给定事实 | 核对结果 |
|---|---|
| 1. `core/src/agent/` 下子 Agent 基础设施文件 | **成立**（额外发现 `status.rs`、`agent_resolver.rs` 及 `control/` 子模块 20+ 文件） |
| 2. `child_config.rs:132-141` 覆写 `model_context_window`/`model_auto_compact_token_limit` | **成立**（精确到 135-141；feature 定义确在 `features/src/lib.rs:1481-1486`） |
| 3. `guardian/review.rs:151-154` 复现该模式 | **成立**，但**需加限定**：guardian 侧是**条件性**清空（`if review_model.model != context.model_info.slug`），child_config 侧是**无条件**（feature 开即清空） |
| 4. `MultiAgentVersion::V2` 与各 agent-* crate | **成立**（`core/src/tools/handlers/multi_agents_v2/` 为 V2 工具面） |
| 5. `AgentRoleOverrides` 无上下文/压缩字段 | **成立**（未在本次发现反例；role 只影响 model/reasoning/instructions） |
| 6. 压缩三路径 + 记忆零耦合 | **成立**（另发现第四类：`new_context` / token-budget 换窗，`compact_token_budget.rs` 归属压缩生命周期） |

**未发现与"已确认事实"直接矛盾之处。** 唯一需要修正的细节是第 3 条的"复现"应标注为**条件性覆写**，两者触发条件不同。
