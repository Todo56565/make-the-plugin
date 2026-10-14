# T5 — 独立核验报告：对 t4 对照表关键断言的证伪式复核

- 复核对象：`I:\VMsShare\context-compare\t4-mechanism-matrix.md`（116 行；本报告中所有「t4 Lxx」均指该文件行号）
- 证据根：
  - Codex `I:\VMsShare\_src-compare\codex` @ `a07c8ebd57feedc4cf5dfe854c8e9101de54186b`（与 t1/t4 声明一致，已 `git rev-parse` 核对）
  - 插件 `I:\VMsShare\_src-compare\dsh-agent-teams` @ `1094b84add6f2fb19edf659367fe2fd5f7f14154`（= v0.1.23，与 t4 L3 声明一致）
  - 宿主 `D:\Dev\Path\nodejs_25.0.0\npm-cache\_npx\1e7f6d9597241db0\node_modules\@deepseek-ai\*` = `0.2.0-rc.2`（9 个相关包版本逐一核对）
  - 本机 profile `C:\Users\ZYX\.dsh\profiles\web\cordis.yml`（1285 行）
- 方法：每条断言回到源码逐字读取（文件+行号+关键 token），**不看 t1/t2/t3 的转述是否自洽，只与源码比对**；另用脚本 `t5-anchor-audit.ps1` 对 t4 的 **132 处 `路径:行号` 引用**做了机械审计（行号越界/文件缺失 0 处）。
- 结论先行：**对照表的机制事实层基本可信，但「引用指针层」有 5 处必须修正**（其中 1 处是 t3 的行内依据陈述错误、1 处引用是死指针、1 处引用区间错 26 行、1 处定义/调用点混写、1 处格式歧义）。修正前不应把 t4 当作最终定稿交付。
- 自我更正：初审时我曾把 t4 L29 的"运行态 5 个成员会话"记为计数口径问题；**复核后撤回**——t3 §5.3（`:694-701`）逐行列出恰好 5 个成员会话头部，t4 的转录正确（见 §3.11）。

---

## 1. 抽检结果总表（18 条，超出合同要求的 ≥8 条）

| # | 断言（t4 行） | 判定 | 关键证据 |
|---|---|---|---|
| A1 | M1：阈值 = `min(model 默认 90% 窗口, config)`，`codex-rs/protocol/src/openai_models.rs:529-539`；90% 与 95% 两档并存 | **成立** | `openai_models.rs:529-540` 逐字命中 `(context_window * 9) / 10` 与 `std::cmp::min`；`:393-395` `default_effective_context_window_percent() -> 95`；`context_window.rs:84-86` 用 95% 算 full-context 硬上限 |
| A2 | M2：三处触发点 PreTurn `turn.rs:1304,1316-1329` / MidTurn `:609,621-629` / PostTurn `:719-737`；PostTurn 阈值默认 0=关闭 | **成立** | `turn.rs:1304` `async fn run_pre_sampling_compact`、`:1316-1329` `if token_status.token_limit_reached → CompactionPhase::PreTurn`；`:609-610` `needs_follow_up && (take_new_context_window_request() || token_limit_reached)` → `:621-629` `CompactionPhase::MidTurn`；`:720-727` `model_post_turn_compact_threshold_percent > 0 && !TokenBudget && turn_end_compaction_threshold_reached` → `:736` `PostTurn`；`config/mod.rs:4355-4357` `.unwrap_or_default()`（=`0`，`context_window.rs:111-112` 明确 `post_turn_percent > 0` 才算） |
| A3 | M4：保留首尾、**首尾各 50%**、默认 **10 000 字节**、×1.2 序列化余量 | **成立** | `utils/string/src/truncate.rs:156-158` `split_budget`：`left = budget / 2; (left, budget - left)`；`models-manager/src/model_info.rs:126` `TruncationPolicyConfig::bytes(10_000)`；`utils/output-truncation/src/lib.rs:17-20` `with_serialization_allowance` = `policy * 1.2`（注释 "20% allowance"）；`:4` `APPROX_BYTES_PER_TOKEN = 4` |
| A4 | M5：摘要 prompt = `prompts/templates/compact/prompt.md`；上传时包成 `SUMMARY_PREFIX + 摘要`（`compact.rs:372-383`） | **成立** | `prompt.md` 首行逐字 `You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.`；`compact.rs:383` `let summary_text = format!("{SUMMARY_PREFIX}\n{summary_suffix}")`；`summary_prefix.md` 内容 = "Another language model started to solve this problem…"，确为**加在前面的续作说明** |
| A5 | M6：`COMPACT_USER_MESSAGE_MAX_TOKENS = 20_000`（`compact.rs:63`），唯一调用点 `compact.rs:386`，超预算截断并 `mark_retained_sources_incomplete()`（`730-737`） | **成立** | `compact.rs:63` 逐字；`:386` `build_compacted_history(Vec::new(), &user_messages, &summary_text)`；`:677-688` 透传该常量；`:730` `truncate_text(..., TruncationPolicy::Tokens(remaining))`、`:733-737` `mark_retained_sources_incomplete()`。**（注：`:574` 引用精度问题见 2.4）** |
| A6 | M8：`Feature::TokenBudget` 默认关闭（`features/src/lib.rs:1889-1894`，`Stage::UnderDevelopment`）；`get_context_remaining` 被同 flag 门控（`spec_plan.rs:1401-1404`） | **成立** | `features/src/lib.rs:1889-1894` 逐字 `stage: Stage::UnderDevelopment, default_enabled: false`；`spec_plan.rs:1401-1404` `if features.enabled(Feature::TokenBudget) { NewContextWindowHandler; GetContextRemainingHandler }`；`get_context_remaining_spec.rs:8` 名称为 `"get_context_remaining"` |
| A7 | M18：thread hint 上限 **4 000 字节**，用 `text.len()` 比较 ⇒ 单位为字节（`ext/history-notes/src/extension.rs:30-31`，比较 `:140`） | **成立** | `extension.rs:31` `const MAX_THREAD_HINT_BYTES: usize = 4_000;`；`:129` 请求头带 `TruncationPolicy::Bytes(MAX_THREAD_HINT_BYTES)`；`:140-143` `if text.len() > MAX_THREAD_HINT_BYTES { Failed; return }` ⇒ `len()` 为字节数，且 `TruncationPolicy` 走 `byte_budget()`（`protocol.rs:3510`），**描述准确、未夸大** |
| A8 | M16：notes 侧 5 个 action，**工具名 = namespace+name**（`tools.rs:63-88,290-292`）；单文件上限 1 000 000 UTF-8 字节（`tools.rs:31`） | **部分成立** | 事实成立：`tools.rs:37-41` 五个 notes action；`:71-82` name 映射；`:290-292` `ToolName::namespaced(self.action.namespace(), self.action.name())`；`:28` `NOTES_DESCRIPTION` 逐字含 `1,000,000 UTF-8 bytes`。**引用错误**（见 2.2） |
| A9 | M17：真实名为 namespaced `history.list_windows/list_items/read_item/search_contents`（`tools.rs:75-88,290-292`）；`search_contents` 为**区分大小写字面包含**（`tools.rs:181`）；**`read_item` 必填 `item_id`+`window_id`（`tools.rs:206-218`）**；后端 `alpha/history/v2/search_contents` + 截断策略头 + 超时 35 s（`backend.rs:15,63-87`） | **部分成立** | namespaced 名（`:73-76` 单数行，`:25-26` namespace）、`:290-292`、`:181` 逐字 `"Case-sensitive literal substring to find in item content."`、`:213` notes 同款、`backend.rs:15` `Duration::from_secs(35)`、`:63-75` 截断策略头、`:76-87` search/append/write 附加加密头 —— **全部成立**；但 `tools.rs:206-218` 处无 `read_item`（见 2.3），且读入方要求的 ids 实际在 `:175` |
| A10 | M10：Codex 侧"未见人工压缩入口"；`new_context_window` 语义是重置窗口（`spec_plan.rs:1402`），`get_context_remaining` 只是查询（`get_context_remaining_spec.rs:8`） | **成立（限定条件已写明）** | `spec_plan.rs:1402` `registry.add_with_exposure(NewContextWindowHandler, ToolExposure::DirectModelOnly)`；`get_context_remaining.rs:85-93` handler 仅返回 `base_window_tokens_remaining`。t4 已限定"在本轮 Codex 取证范围内"，未越界断言 |
| A11 | M13：结果投递为全文 `content`（`src/tools.ts:2204,2244`），provenance 仅前置标签（`src/mailbox.ts:22-25`）；成员侧唯一过滤 = 代际失效去重 + ack，非摘要 | **成立** | `src/tools.ts:2204` `{ ...createMessage(from, CAPTAIN_KEY, args.content), ...sourceFields }`（注：`lib/tools.js` 仅 2684 行 ⇒ 此处必然指 `src/`，引用自洽）；`:2220` 成员分支同为原文 `args.content`；`mailbox.ts:22-25` 仅前置 `[Source task …]` 标签 + `message.content`；`mailbox.ts:150-173` 仅做 ack/代际丢弃 |
| A12 | M11/M13：契约字段全量持久化（`src/types.ts:189-204`），重试时契约保留、结果清空（`src/state.ts:171-179`） | **成立** | `types.ts:190-204` 逐字段（kind/round/verdict/findings/objective/inScope/outOfScope/acceptance/verify/changedPaths/acceptanceResults/commandsRun…）；`state.ts:171-179` `clearAttemptResult` 逐字段清空 output/verdict/findings/changedPaths/acceptanceResults/commandsRun |
| A13 | M12：成员 = durable continuable 子代理（`src/members.ts:907-942`，`member.id = start.childId`）、写入 `src/types.ts:261-266`；用 **spawn** 而非 fork（`src/index.ts:196` 默认 `'spawn'`）⇒ 运行态成员 `seeded=false` | **成立（但依据链有错，见 2.1）** | `members.ts:911-936` `ctx.subagents.startContinuable({ provider: config.provider, label, request: {...} })`、`:942` `member.id = start.childId`；`types.ts:261-266`；`index.ts:196` 逐字 `memberProvider: config.memberProvider ?? 'spawn'`；本机确实零继承（`fork` provider `inheritsParentContext = true` @ `dsh-subagent-fork-in-process/lib/index.js:44`，`spawn` = false @ `dsh-subagent-spawn-in-process/lib/index.js:30`，与 `dsh-subagent/lib/types/types.d.ts:327-337` 语义一致） |
| A14 | M15（新增核验）：`codex-rs/core/src/agent/child_config.rs:135-145` `build_agent_shared_config` 在 `Feature::SubagentDefaultContextLimits` 启用时把 `model_context_window` 与 `model_auto_compact_token_limit` 置 None | **成立** | 函数定义在 `child_config.rs:132`，覆写在 `:135-141`（`.enabled(Feature::SubagentDefaultContextLimits)` → `config.model_context_window = None; config.model_auto_compact_token_limit = None;`）。feature 存在且 `default_enabled: false`（`features/src/lib.rs:1481-1486`）⇒ 该行为**默认不生效**，引用范围 135-145 覆盖得住 |
| A15 | M15（新增核验）：同一覆写模式在 `guardian/review.rs:151-153` 复现（评审模型 != 主模型时） | **成立（精确命中）** | `guardian/review.rs:151-153` 逐字 `if review_model.model != context.model_info.slug { spawn_config.model_context_window = None; spawn_config.model_auto_compact_token_limit = None; }` |
| A16 | M15（新增核验）：Codex 亦无按角色分档的压缩预算 —— `AgentRole` 与 compact/context_window/token_limit/budget 组合检索零命中 | **成立** | 全仓 `agent-roles/**` 内 `compact`/`context_window`/`token_limit`/`budget`/`ContextWindow`/`TokenLimit` 各 **0 命中**；`AgentRole` 全仓 128 命中全部落在 `agent-roles` 模块（角色提示/模型配置侧），无一涉及压缩预算。**唯一"按子代理改上下文"的机制就是 A14/A15 两处置 None（收紧为默认模型窗口），且默认关闭** —— "无按角色分档预算"成立，措辞宜写成"只有一处默认关闭的收紧开关" |
| A17 | M15（新增核验）：DSH 宿主 `dsh-compaction-basic` 对 `delegationDepth\|parentSession\|origin ===\|subagent` 零命中 ⇒ 无 agent 维度分支 | **成立（需精确措辞）** | `dsh-compaction-basic/lib/index.js`（1027 行）：`delegationDepth` 0、`parentSession` 0、`subagent` 0、`isSeeded`/`depth` 0、`origin ===`（字面）0；`origin` 作为子串有 2 处，均为**字符串文案**（L249 摘要模板 "the user's original and evolving goals"、L880 错误文案 "preserving the original request error"）。自动监听器对所有 agent 生效（`:827` `if (this.config.auto) this._registerAutomaticCompaction()`；`:839`/`:861` 两个 `ctx.on`），无任何血缘过滤 ⇒ 结论成立 |
| A18 | M4 运行态数字：spill notice **62 条**、工具自身截断 18 处（t3 §4.1 转录） | **成立（转录一致，注意口径非 52）** | `t3…md:512` 逐字 "56 个会话中 62 条 spill notice，另 18 处工具自身的 `[output truncated; …]`"。t4 L21 与之一致。（t3 任务摘要里的 "52 个 spill notice" 是摘要口径错误，t4 未沿用，正确） |

**判定统计：成立 15 条、部分成立 2 条（A8/A9）、成立但依据链有错 1 条（A13）。无"不成立"的机制事实断言。**

---

## 2. 必须修正项（错误原文 + 正确事实 + 证据）

### 2.1 【最严重】t3 行内依据陈述错误：profile **确实覆盖**了默认值

- **错误原文**（t3 `t3-dsh-host-context-infrastructure.md:692`）：
  `memberProvider: config.memberProvider ?? 'spawn'` —— 这是**默认值**，可由 `memberProvider` 配置项改为 `fork`；**本机 profile 未覆盖该默认，故本机实际解析为 spawn。**
- **正确事实**：本机 profile **显式写入了该配置**。
  `C:\Users\ZYX\.dsh\profiles\web\cordis.yml:1270-1274`：
  ```
  - id: agent-teams
    name: '@nanmicoder/dsh-agent-teams'
    config:
      stateDir: .agent-teams
      memberProvider: spawn
  ```
  ⇒ 运行态结论（成员零继承）**不变**，但依据必须改写为"profile 显式指定 spawn（非依赖默认值）"。这一点使 A13 的结论**更硬**（不是"忘了改"，而是明确选择）。
- **同类精度问题（同一行）**：`?? 'spawn'` 是**冗余回退**，真正的 Schema 默认值在 `src/index.ts:133`（`memberProvider: z.string().default('spawn')`）。t4 L29 用 `src/index.ts:196 默认 'spawn'` 引用的是运行时回退表达式，措辞"默认"对应 `:133` 更准确。
- **船长提示的措辞风险已确认存在**，且我找到的版本比提示更严重：不是"把默认值说成固定行为"，而是"把**被 profile 覆盖的默认值**说成未被覆盖"。
- **需要为 t3 记一句公道话**：t3 §5.3 的小节标题（`:690`）已经写了"**默认用 spawn（可配置），不是 fork**"，配置项本身没有被说死；错的只是同一节正文里"profile 未覆盖该默认"这句事实判断（与 `cordis.yml:1274` 直接冲突）。t4 L29 的措辞（"用 spawn 而非 fork（`src/index.ts:196` 默认 `'spawn'`）"）**本身没有把默认写成硬编码**，可保留，但建议补上 profile 显式配置这一句，并去掉"运行态 5 个成员会话"以外的推断语气。

### 2.2 M16（t4 L33）引用区间错 26 行

- **错误原文**：notes 侧 5 个 action（`codex-rs/ext/history-notes/src/tools.rs:63-88,290-292`）
- **正确事实**：`tools.rs` 共 411 行。**`:63-88` 是 `HistoryNotesAction` 的 `namespace()`/`name()`/`endpoint()` 三个 match**；5 个 notes action 的**枚举定义在 `:37-41`**（`NotesListFilesByPrefix`/`NotesReadFile`/`NotesSearchContents`/`NotesAppendToFile`/`NotesWriteFile`）。`history` 侧 action 枚举在 `:33-36`。
- 影响：结论（namespaced 名、5 个 action）不改；仅引用需改为 `tools.rs:37-41,71-82,290-292`。

### 2.3 M17（t4 L34）`read_item` 引用是死指针

- **错误原文**：`read_item` 必填 `item_id`+`window_id`（`tools.rs:206-218`）
- **正确事实**：`tools.rs` 仅 411 行，**`:206-218` 整段不含 `read_item`**（下一条 notes 工具的参数块）。`read_item` 的 schema 在 **`:166-176`**，其 `"required": ["item_id", "window_id"]` 在 **`:175`**。全文件仅 1 处 `read_item`（`:75` 的名称映射）。
- 影响：M17 该分句是**死引用**，需改为 `tools.rs:166-176`（或 `:175`）。其余 M17 分句（`:75-88`、`:181`、`:213`、`backend.rs:15,63-87`）均已逐条命中成立。

### 2.4 M6（t4 L23，两处）引用含义错位

- **错误原文**：`COMPACT_USER_MESSAGE_MAX_TOKENS = 20_000`（`compact.rs:63`），**唯一调用点 `compact.rs:386`**；另一处 `compact.rs:574` 用来支撑"注释过的用户消息"集合。
- **正确事实**：
  - `:574` 是 `collect_annotated_user_messages()` 的**定义行**，**不是调用点**；真正调用在 `:384` `let user_messages = collect_annotated_user_messages(history_items);`。
  - `:386` 是 `build_compacted_history(...)`，它**间接**把常量透传下去（`:677-688` 的 `build_compacted_history_with_limit(..., COMPACT_USER_MESSAGE_MAX_TOKENS)`），说"唯一调用点"尚可；但把 `:574` 与 `:677` 连写会让人误读为"调用链"。
- 影响：结论（20k 是用户消息 token 配额、仅本地文本压缩路径）不改；引用应写成 `compact.rs:574`(定义)/`:384`(调用)/`:386`→`:677-688`(透传)。

### 2.5 引用格式歧义（低severity，但影响复核成本）

t4 在多处把"定义位置"与"调用位置"写成同一串（如 M5 的 `compact.rs:372-383` 实为 `:383` 关键行 + `:372-382` 的 phase 分支；M11 的 `agents_md.rs:1-18,43-49,64,68-72` 混了模块注释与实现）。机械审计显示**行号无越界**（132 处引用 0 处越界、0 处文件缺失），但"引用能解析"≠"引用讲的是那件事"。建议 t6 定稿时对每个 Codex 引用补一个 token 锚点（如 `compact.rs:63 (COMPACT_USER_MESSAGE_MAX_TOKENS)`）。

---

## 3. 未发现问题、且对结论影响最大的几处（确认可放心使用）

1. **M1 阈值语义**：90%（`auto_compact_token_limit`）与 95%（`usable_context_window` / full-context 硬上限）确实是两个并列口径，且 `Total` 与 `BodyAfterPrefix` 两种 scope 对 config 的处理确实不同（`context_window.rs:61-81`：Total 用 `model_info.auto_compact_token_limit()` 的 min 结果；BodyAfterPrefix 用 `config.model_auto_compact_token_limit.or_else(|| model_info.…)` —— **config 优先**）。t4 L18 的"两种 scope 对 config 处理不同"**方向正确**。
2. **M7 三路分流**：`turn.rs:1461-1471`（TokenBudget 早返回）→ `:1473` `match remote_compaction` → `V2`（`:1480` 服务端 opaque）/ `Unsupported`（`:1491-1505` 本地文本摘要）。`RemoteCompactionSupport` 只有 `Unsupported|V2` 两值（`model-provider-info/src/capabilities.rs`）。**三路分流成立**，`:1473` 作为 match 行引用准确。
3. **M9 降级**：`compact.rs:338-350` 逐字 `ContextWindowExceeded → if turn_input_len > 1 { history.remove_first_item(); retries = 0; continue; }`，且 `:335-337` `SessionBudgetExceeded` 提前返回（不做该降级）——与 t4 完全一致。
4. **M8 的"无摘要重置"**：`compact_token_budget.rs:18/31` 注释逐字 "Token-budget compaction **skips model/server summarization** and installs a fresh context window"，`:58` `sess.start_new_context_window(...)`。t4 L24 "无摘要新窗口"成立。
5. **M14 追加式替换**：pruner `:159-166` 先 `session.append("compaction/prune", {...})`、`:167-177` 再 `session.append("tool/result", {...}, {surfaceOp:{op:"replace", startSeq, endSeq}})` —— 逐字命中，t4 的"文件只增不改、替换是投影层动作"成立。
6. **M4 宿主两层**：pruner 默认 `8192/4096/1024`（`lib/index.js:10-14`）+ **按 Unicode code point**（`:25-26` `codePointLength = Array.from(text).length`，`:75-81` 注释 "Measure text content in Unicode code points"）；spill `maxInlineTokens: 12500`（profile `:334-336`）+ head/GAP/tail + notice（`spill-policy/lib/index.js:201-224`）。t4 L21 的"字符 vs 字节"对比**准确**。
7. **M2 宿主两相位**：`agent/pre-step` 传 `"pressure"`（`:839-841`）、`agent/request-error` 的 `CONTEXT_WINDOW_EXCEEDED_CODE` 传 `"context-overflow"`（`:861-872`）、`maxOverflowRetries` 门控（`:867-868`）、溢出路径先 `prune.pruneSession` 再重测再选区间（`:926-934`）；`CompactionTrigger` 恰为 `'pressure' | 'context-overflow'`（`dsh-compaction/lib/types/index.d.ts:25`）。
8. **M10 宿主 `/compact`**：`dsh-command-compact/lib/index.js:55` `ctx.compaction.compactNow(invocation.agent, invocation.signal, invocation.commandId)`、`:93-98` 注册名 `"compact"`。
9. **M19 固定前缀**：`dsh-agent-teams/src/capabilities.ts:101-106`（`ctx.systemPrompt.section`，按 member 选 `TEAM_MEMBER_PROMPT`/`captainPrompt`）。
10. **profile 侧 M4/M15 前提**：`cordis.yml:723-739` 确为 `standard` preset 内的 `compaction` group（含 `compaction-basic`/`command-compact`/`tool-result-pruner` + pruner 三级参数）。
11. **M12 的"5 个成员会话"计数正确（撤回我的初审怀疑）**：`t3…md:694-701` 逐行列出恰好 5 条成员会话头部，每条均 `depth=1 | seeded=false | origin=subagent | preset=standard`，t4 L29 的转录逐字一致。本机"当前 team 只有 4 名成员"与"历史累计 5 个成员会话"不矛盾（存在已归档/已退出的成员会话），我最初的计数质疑不成立。

---

## 4. 对"对照表能否用于决策"的总体判定

**判定：机制事实层可用于决策；引用层必须先按 §2 修正后再定稿（t6 一并做）。**

- **可直接采信的结论**（不依赖任何错误引用）：
  - DSH 宿主**没有任何按成员/子代理区分的压缩预算**（A17：`origin ===`/`delegationDepth`/`parentSession`/`subagent` 全 0 命中，仅 2 处文案误命中；自动监听器对所有 agent 生效）⇒ **M15 作为"最清晰的可落地空白"成立**。
  - Codex 侧的"按子代理收紧"也**只有一处默认关闭的开关**（A14/A15：`SubagentDefaultContextLimits` `default_enabled: false`；guardian 覆写仅在评审模型 != 主模型时触发），**没有按角色的压缩预算**（A16）⇒ t4 把 M15 Codex 侧从"证据不足"改判为"有机制但默认关闭"是**站得住的修正**，但措辞不能写成"Codex 有分档预算"。
  - Codex 三处触发点、90%/95% 两档、截断 50/50 与 10 000 字节、20k 用户消息配额、4000 **字节** thread hint、history 四个 namespaced 工具名、token budget 默认关闭 —— 全部逐字成立。
  - 插件全文投递（A11）、契约持久化/重试清空（A12）、spawn 零继承（A13 结论）。
- **必须先修正的 5 处**：t3:692（依据错误，必须改写）、t4 L33（M16 引用区间错 26 行）、t4 L34（M17 `read_item` 死引用）、t4 L23（M6 定义/调用点混淆）、以及引用格式补 token 锚点（全表，低 severity）。
- **对 t6 的具体要求**：
  1. 凡"M15 Codex 侧"改为"有机制但**默认关闭**（`SubagentDefaultContextLimits`）+ 仅评审模型不同时收紧（guardian）"，不得写成"Codex 有按角色预算"。
  2. 凡提到成员继承时，把依据写成"profile `cordis.yml:1274` 显式 `memberProvider: spawn`"，而不是"默认 spawn"。
  3. M16/M17 的 notes/history 工具引用改用**能定位到该事实的行号**（notes actions `tools.rs:37-41`；read_item schema `:166-176`，required `:175`）。
  4. §4 证据边界表里"M15 的 Codex 侧证据不足"应删除（已被 A14–A16 补齐），改为"M15 的 Codex 侧已取证：仅一处默认关闭的收紧开关"。
- **不影响结论、但建议标注口径的**：M4 运行态数值（62 spill / 18 truncated）取自 t3 §4.1 脚本统计，属运行态观测而非源码契约；t3 的"pruner 真实触发 0 次（UNVERIFIED→收敛）"结论我未观察到反例，但**本轮未重跑会话扫描**（超出 t5 证据范围），t4 已按 t3 原样照抄，保持即可。

---

## 5. 复现方式

- 机械审计脚本：`I:\VMsShare\context-compare\t5-anchor-audit.ps1`
  运行：`pwsh -NoProfile -File I:\VMsShare\context-compare\t5-anchor-audit.ps1`
  输出：`citations with a range problem: 0`（132 处引用，含 bare 文件名的多候选解析）
- 逐条人工核验命令族（本次实际使用）：`Get-Content <file> | %{...}` 打印指定行区间 + `Select-String -Pattern '<token>'` 命中检查。
- 关键反证命令：
  - `Select-String -Path .\dsh-compaction-basic\lib\index.js -Pattern 'origin ===' -SimpleMatch` → 0
  - `Select-String -Path ...\src\tools.ts -Pattern 'read_item'`（codex）→ 仅 L75，`:206-218` 无命中
  - `Select-String -Path C:\Users\ZYX\.dsh\profiles\web\cordis.yml -Pattern 'memberProvider'` → L1274 `memberProvider: spawn`
