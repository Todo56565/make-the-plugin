# T6 — 定稿：对照表修正落实情况 + dsh 侧可落地改进建议

- 输入：`t4-mechanism-matrix.md`（对照表正文，19 个机制行 M1–M19）与 `t5-verification-report.md`（独立核验，18 条抽检 / 5 处必须修正）
- 范围定位：比对目标 = **NanmiCoder/dsh-agent-teams 成品插件** + 其实际依赖的宿主压缩组件栈（`dsh-compaction` 系列）。DSH 自带的 `@deepseek-ai/dsh-experimental-agent-team*`（实验版）**不是比对对象、也不作为基准**；本文件所有建议都不建立在实验版行为之上。
- 证据分级：**【源码】**= 逐字可复核（路径:行号）；**【运行态】**= 本机会话/配置实测；**【推断】**= 由前两者推导、尚未实测。
- 本文件只写当前状态与已修正事实。

---

## 1. t5 核验结论的落实

t5 判定：机制事实层成立（15/18 成立、2 部分成立、1 依据链有错，无"不成立"），引用层 5 处必须先修正。**5 处均已落实**（落实记录同步写入 t4 §4.1/§4.2）：

| # | t5 指出的问题 | 落实状态 | 落实后的引用（当前状态） | 复核 |
|---|---|---|---|---|
| 1 | **t3 §5.3 依据错误**：「本机 profile 未覆盖该默认」与事实冲突 | ✅ 已改写 | t3 §5.3 与 §8 表现写为「本机 profile **显式写入** `memberProvider: spawn`」；并区分三层：Schema 默认 `dsh-agent-teams/src/index.ts:133`（`z.string().default('spawn')`）、运行时回退 `:196`（`?? 'spawn'`）、实际生效来源 `@nanmicoder/dsh-agent-teams/cordis.patch.yml:21` | 本轮重读插件包 `cordis.patch.yml:19-21`，`memberProvider: spawn` 在 **:21**【运行态】 |
| 2 | **M16 引用区间错 26 行**（`tools.rs:63-88` 实为三个 match，notes 枚举在 `:37-41`） | ✅ 已改 | notes 5 个 action = `codex-rs/ext/history-notes/src/tools.rs:37-41`；name/namespace 映射 `:71-82`；`tool_name()` 组装 `:290-292`；`NOTES_DESCRIPTION` 在 `:28` | 逐字确认 `:37-41` 五个 notes 枚举、`:71-82` name 映射【源码】 |
| 3 | **M17 `read_item` 死指针**（`:206-218` 无 `read_item`） | ✅ 已改 | `read_item` schema = `tools.rs:166-176`，`"required": ["item_id","window_id"]` 在 **`:175`**；全文件 `read_item` 字面仅 `:75`（名称映射）与 `:89`（endpoint） | 逐字确认 `:166-176` 与 `:175`【源码】 |
| 4 | **M6 定义/调用点混淆**（把 `:574` 当调用点） | ✅ 已改 | 定义 `compact.rs:574`（`collect_annotated_user_messages`）/ 调用 `:384` / 透传 `:386` → `:677-688` → 回填 `:696-755` | t5 §2.4 事实与本轮复核一致【源码】 |
| 5 | **引用格式混写定义/调用点**（低 severity，全表补 token 锚点） | ⚠️ **部分落实**（见下） | 二轮改动的引用已带 token 锚点（如 `compact.rs:63` 常量 / `:574` 定义 / `:175` required）；**全表 132 处引用未逐一补锚点** | 本文件 §6 把该遗留项列为待办，不谎报完成 |

**关于第 5 处为何只做到部分**：补锚点是对**已存在引用**的格式增补，不改变任何结论；t4 当前 226 行、主表 19 行 × 7 列结构自检通过（0 处不平衡），批量改写引用存在引入新笔误的风险而收益只是可读性。因此本轮把「带 token 锚点」定为**新增/改动引用的强制格式**，历史引用留待后续按需增补，并在 §6 明示尚未完成。

**t5 未提出、但本轮自查发现的一处口径问题**：`t3` §4.1 的「62 条 spill notice / 18 处子进程截断」属**运行态观测**（脚本统计），不是源码契约。t4 M4 引用时已注明来源，本文件再次标注，避免被当作规范常量引用。

---

## 2. 改进建议清单（按 DSH 长程 team 任务的实际约束排序）

排序依据：① 是否直接缓解长程 team 任务中**已实测**的压力来源；② 是否能在**不改动第三方包**的前提下落地；③ 是否需要宿主/上游配合。

### 建议 1（最高优先）· 让宿主压缩栈感知"子代理/成员"维度，并提供统一降档闸门

- **要解决的问题**：长程 team 任务中，成员会话的压力最集中（全文投递，见建议 2），但宿主压缩栈对成员与 captain 使用**完全相同的阈值与保留比**，无法对成员单独降档。运行态实例：成员会话 `5555841f-…` 的 `pressure=348,245` / `surface=280,941`，与 captain 同处一套公式下（阈值 ≈803,392），并无按成员收紧的手段。
- **对应 Codex 的机制**：M15 —— Codex 在子代理构造时通过 `Feature::SubagentDefaultContextLimits` 显式把 `model_context_window` / `model_auto_compact_token_limit` 置 `None`（`codex-rs/core/src/agent/child_config.rs:135-141`），即"子代理继承的窗口/压缩配额可被集中覆写"。**限定**：该 feature 为 `default_enabled: false`、`Stage::UnderDevelopment`（`codex-rs/features/src/lib.rs:1481-1486`），guardian 侧的同款覆写只在评审模型不同于主模型时触发（`guardian/review.rs:151-154`）。因此 Codex 是"**有闸门但默认不生效**"，不是"现成就在按成员分档"。
- **改动位置**：**宿主压缩组件栈** —— `@deepseek-ai/dsh-compaction-basic` 的配置解析与阈值计算（`lib/index.js:128-134` 的 `thresholdTokens` / `retainTokens` 计算处）。插件层**不是**可行落点：`dsh-agent-teams` 不持有该公式，也没有压缩栈的注入句柄。
- **最小可行改法**：在 `resolveConfig`/目标策略解析处新增一个可选配置项（例如 `agentLimits` 或 `subagentHeadroomTokens`），键为 `origin`/`delegationDepth`（会话头已具备这两个字段，见 `dsh-session-persistence-jsonl/lib/types/format.d.ts:38-53`），值为对 `headroomTokens`/`thresholdRatio`/`retainRatio` 的覆写；缺省不改变任何现有行为（保持与今天完全一致的阈值）。**注意实现约束**：该包是第三方 npm 产物（`node_modules/@deepseek-ai/`，不在 `NanmiCoder/dsh-agent-teams` 依赖树内），本机不宜直接改写其构建产物——正规路径是向上游提特性请求，或用 profile 层能表达的等效方式（例如给成员路径单独挂一套更保守的 compaction 配置）。**若 profile 层无法表达"按 agent 区分"（当前 isolated presets 的粒度是 preset，而非 per-agent），则本建议只能落在上游。**
- **验证方式**（三者任一即可证伪）：
  1. 运行一个成员执行长任务的 team，观察成员会话日志 `compaction/start` 事件是否出现，并比对 `shadowedTokenCount` 与 captain 会话的同口径数值；期望成员在更低压力即触发。
  2. 在同一压力水平下断言成员会话摘要阈值：读 `storages/session_projcache/sessions/<id>.json` 的 `contextPressure` 与 `compaction/*` 事件的先后关系。
  3. 反证：若成员与 captain 的触发压力完全相同，则实现未生效。

### 建议 2（高优先，插件层可独立完成）· 收敛"队长收件箱"进入上下文的正文体量

- **要解决的问题**：`agent_teams_status` 每次调用都会把队长收件箱中**最多 10 条未确认消息的全文正文**渲染进 captain 的上下文，并在同一次调用里**全部 ack**；成员回报越长，captain 侧的单次状态查询越贵。
- **证据**：`dsh-agent-teams/src/tools.ts:2405-2409`（`captain_inbox: captainInbox.slice(0, 10).map(... content: mailboxContent(message) ...)`）；同一批 id 在 `:2415-2421` 被 ack；`mailboxContent` 只加一个前置 `[Source task …]` 标签、正文不截断（`src/mailbox.ts:22-25`）。
- **对应 Codex 的机制**：M13/M12 —— Codex 在远程压缩的保留判据里**显式排除子代理进度消息**（`codex-rs/core/src/compact_remote_v2.rs:548` 的 `!is_descendant_progress`），即"过程性回报不进入需要长期保留的上下文"。
- **改动位置**：**dsh-agent-teams 插件层**（`src/tools.ts` 的状态渲染；可选配套 `src/mailbox.ts:22-25` 的 `mailboxContent`）。
- **最小可行改法**：保留现有 10 条上限与 ack 语义不变，只把渲染从"全部全文"改为"最近 1–2 条全文 + 其余仅 `from/ts/首行指针`"，并为每条超过 N 字符的正文加 `[truncated — 完整正文见 inbox/<agent>.jsonl]` 标记（与插件现有的确定性截断风格一致，见 `src/scheduler.ts:40-43`、`src/members.ts:776-780`）。不新增摘要模型、不改投递协议。
- **验证方式**：
  1. 构造 10 条各 500 字符的成员回报，调用 `agent_teams_status`，比对改动前后该工具返回文本的字符数（同一状态、同一批消息）。
  2. 断言 ack 行为不变：调用后 `inbox/captain.jsonl` 中同样这 10 条消息的 `readAt` 被置位。
  3. 反证：captain 侧仍需回读全文时，能从 inbox 文件取回（不丢信息）。

### 建议 3（中优先，需宿主能力）· 把"压缩后仍保留最近用户原话"做成可配置的保留策略

- **要解决的问题**：宿主压缩栈按**窗口比例**保留消息（`retainRatio: 0.16`，本机 ≈139k tokens），没有"用户原话优先保留"的独立配额；长程 team 任务中用户的原始约束/授权容易被一并摘要掉。
- **对应 Codex 的机制**：M6 —— Codex 本地文本压缩路径有独立的用户消息 token 配额 `COMPACT_USER_MESSAGE_MAX_TOKENS = 20_000`（`compact.rs:63`，回填逻辑 `:696-755`，超预算时截断并 `mark_retained_sources_incomplete()` `:730-737`），且在挑选时**排除已识别摘要消息**以避免重复保留（`:601` `is_summary_message`）。
- **必带的口径限定（来自 t4 §3 / R1）**：20 000 只对**本地文本压缩路径**成立；Codex 的远程/服务器侧 v2 是 `RETAINED_MESSAGE_TOKEN_BUDGET = 64_000`、单条 agent 消息上限 10 000（`compact_remote_v2.rs:78-79`）。**不得**把 20k 当作 DSH 的调参目标数值，两者不是同一量纲（比例 vs 配额）。
- **改动位置**：**宿主压缩组件栈** —— `@deepseek-ai/dsh-compaction-basic` 的区间选择与保留量计算（`lib/index.js:128-134` 的 `retainTokens`、以及 `selectCompactableRange` 的调用点 `:927-934`）。
- **最小可行改法**：新增可选 `retainUserMessagesFloorTokens`（或等效命名）：先按现有 `retainRatio` 选区间，再检查"被遮蔽区间内是否含 user 角色消息"，若含则把这一小段拉回保留侧，受一个显式 token 上限约束。**同时**需要与摘要提示词协同（提示词已要求引用用户原始目标，见 `lib/index.js:249`），否则会出现"拉回的消息与摘要重复"。缺省关闭，保持现有行为。
- **验证方式**：
  1. 对固定会话（含 ≥3 条 user 消息）跑 `compactNow`，断言压缩后 surface 上仍能读到被拉回的那几条 user 消息原文。
  2. 断言总量约束生效：拉回后的保留侧 token 估算 ≤ 配置上限。
  3. 反证：未配置该项时，压缩结果与今天逐字一致。

### 建议 4（中优先，纯插件层）· 让"契约/证据"在压缩后仍可被廉价重读（已具备，建议显式化）

- **要解决的问题**：成员会话被压缩后，早期 injected 的 persona/protocol 与契约正文可能不在 surface 上；captain 需要能低成本重建"这个任务原本要求什么"。
- **对应 Codex 的机制**：M19 —— 固定前缀不被业务状态重写（Codex 侧的对应保护是 `compact.rs:601` 的摘要识别排除）；DSH 侧插件已有同向设计：`src/capabilities.ts:56-59`（策略一次性快照，注释明言 profiles/team state/tool results 不得重写该前缀）与 `:101-106`（`agent-teams:usage` section），仓库文档 `docs/progressive-loading.md:19` 明确"结果被裁剪或会话历史被压缩后仍能读到规则"。
- **改动位置**：**dsh-agent-teams 插件层**（无需改压缩栈）。
- **最小可行改法**：不改机制，只在 `team.json` 的渲染面补一个稳定的"契约重读入口"：`agent_teams_status` 已输出 task 契约（每轮派发亦重发，`src/scheduler.ts:225-241`），建议再保证一份**未截断**的契约可一键取回（现状 `tools.ts:2842` 对 task `output` 只给 300 字符，契约字段本身未截断，但缺少"取原文"的显式路径）。
- **验证方式**：对一个已完成压缩的成员会话，断言 `agent_teams_status` 仍返回完整 `objective/inScope/acceptance/verify`（比对 `team.json` 原始字段逐字一致）。

### 建议 5（低优先，仅诊断价值）· 为"压缩失败/溢出救援"补可观测记录

- **要解决的问题**：压缩可能失败，且失败当前难以在会话日志中定位。运行态实例：26 次压缩中有 **1 次失败**，原因是额度不足（`compaction/end` 带 `400: ... insufficient credits ...`）。t3 §9 亦记录：是否发生过 `context-overflow` 救援**没有独立落盘证据**。
- **对应 Codex 的机制**：M9 —— Codex 的降级是显式且有终点的：`ContextWindowExceeded` 时循环 `history.remove_first_item()`，直到 `turn_input_len <= 1` 才 `set_total_tokens_full` 并上抛（`compact.rs:338-350`）；且预算类错误（`SessionBudgetExceeded`）**不**走该降级。
- **改动位置**：**宿主组件栈**（`@deepseek-ai/dsh-compaction-basic` 的溢出路径 `lib/index.js:861-872`、`:927-934`）。
- **最小可行改法**：仅在溢出救援尝试失败/达到 `maxOverflowRetries` 上限时追加一条持久事件（复用既有 `compaction/*` 事件族的形状），记录触发原因、重试次数与最终结果。
- **验证方式**：制造一次溢出（把路由 `contextWindow` 调小后跑长任务），断言会话日志出现该事件；反证：正常路径下不产生额外事件。
- **为何排最后**：它不直接减少压力，只是把"看不见的失败"变成可观测；且需要改第三方包。

---

## 3. 不建议照搬的 Codex 机制（及原因）

| Codex 机制 | 证据 | 不建议照搬的原因 |
|---|---|---|
| **远程 / 服务端 opaque 压缩（含三路分流）** | `codex-rs/core/src/session/turn.rs:1473` 按 `RemoteCompactionSupport` 分流；`compact_remote_v2.rs:499`（服务端返回 opaque item）、`:78-79`（64k / 单条 10k） | DSH 的 `dsh-compaction` 是**与后端无关的本地服务缝**（`dsh-compaction/lib/types/index.d.ts:1-8`），压缩在本机由 LLM 摘要或无模型裁剪完成；没有"服务端按会话持有压缩状态"的可依赖对象。照搬等于发明一个新的服务端协议，收益（opaque 摘要质量）无法在本地被验证。 |
| **跨窗口 `history.*` 检索工具** | `ext/history-notes/src/tools.rs`（4 个 namespaced 工具；`search_contents` 区分大小写字面包含 `:181`；`read_item` schema `:166-176`，required `:175`） | 该工具族依赖**服务端窗口索引**（名字即 `list_windows` / `window_id`；调用打到 `alpha/history/v2/*`，见 `backend.rs`）。DSH 的压缩不产生窗口 id——摘要直接落在原事件区间位置（t3 §7.2），因此没有可列举的"窗口"维度。DSH 在对等场景下走的是**另一条已生效的路径**：spill 文件外置 + notice 给出 `read`/`grep` 指引（`dsh-spill-policy/lib/index.js:24-27`，运行态 62 条 notice），**不需要新组件**。 |
| **thread hint（跨窗口提示注入，4000 字节上限）** | `ext/history-notes/src/extension.rs:30-31`（上限，`:140` 用 `text.len()` ⇒ 字节）、`:46-52`（启用条件：`token_budget.use_history_notes_extension` + OpenAI provider + codex backend 认证） | 同因：DSH 没有 `window_id`/`previous_window_id` 概念，没有"上一个窗口"可挂载提示的锚点。此外该机制在 Codex 侧也非默认开启（三重前置条件），照搬会引入一个当前无消费者的新注入位。 |
| **token budget 的"模型可见剩余额度"** | `get_context_remaining` 工具（`get_context_remaining_spec.rs:8`），但注册被 `Feature::TokenBudget` 门控（`spec_plan.rs:1401-1404`），该 feature `default_enabled: false`（`features/src/lib.rs:1889-1894`） | **不建议在插件层照搬**：宿主 token-meter 目前只做内部度量（`dsh-compaction-basic/lib/index.js:128-134`、pruner `:567`），不向模型暴露额度。插件若自行估算并注入"还剩多少 token"，会与宿主真实度量**不一致**（两套口径），且 team 任务的瓶颈是成员会话压力而非"模型不知道额度"。若要引入，应由宿主提供权威数值，属新能力而非照搬。 |
| **在 DSH 再增加一个"自动压缩触发点"** | Codex 自动触发三处：PreTurn `turn.rs:1304,1316`、MidTurn `:609,621`、PostTurn `:719-737`（PostTurn 阈值默认 0 = 关闭，`config/mod.rs:4355-4357`） | **照搬无收益，不算"不建议照搬"**：DSH 的自动触发**已经存在**——`agent/pre-step` pressure 检查（`dsh-compaction-basic/lib/index.js:839`）。问题是它在本机**实质休眠**：56 个会话最大 pressure 仅 394,485，远低于阈值 ≈803,392，26 次压缩全部靠手动 `/compact`。真正的动作是建议 1（让成员在更低压力触发），而不是再加一个触发点。 |

### 3.1 归类汇总

- **不建议照搬（4 条，原因均为"DSH 缺对等基础设施"或"会引入第二套口径"）**：远程/服务端 opaque 压缩（缺服务端压缩状态持有者）、跨窗口 `history.*` 检索（缺窗口索引；有 spill 文件检索这条已生效的替代路径）、thread hint（缺 `window_id` 锚点，且 Codex 侧本身默认不启用）、模型可见 token 额度（宿主不暴露权威数值，插件自算会双口径）。
- **照搬无效（1 条）**：再加一个自动压缩触发点（已存在且休眠，见上）。
- **可以照搬且值得做**：M13 的"过程性回报不排他保留"→ 建议 2；M6 的用户原话配额 → 建议 3；M15 的子代理配额闸门 → 建议 1（但**限定**：Codex 该闸门 `default_enabled: false`，是"有机制未生效"，不是现成做法）。

---

## 4. 与 t4 对照表的关系（当前状态）

- **对照表正文**：`t4-mechanism-matrix.md`（19 个机制行 M1–M19；主表 7 列 = 机制维度 · Codex · 插件层 · 宿主压缩栈 · 对我方是否适用 · 分类，另含四类分类、报告差异 R1–R5、证据边界 §4、Codex 逐字附录 §5）。
- **本轮对 t4 的改动**：仅落实 t5 的 5 处引用修正（§1 表），并已在 t4 §4.1/§4.2 留有落实记录；**未改动任何机制事实结论**，M15 的"两边都无分档、差异在配额覆写闸门"表述维持。
- **核验状态**：t5（基准 = t4 初版 116 行）已完成；t7（基准 = 本定稿版，对象含 M15 改写、§5 附录新证据、上述 5 处落实、以及本文件建议的落点真实性）待跑。**t5 的 pass 不覆盖定稿版**，以 t7 结论为准。

## 5. 待办（明确未完成项）

1. **全表 132 处引用补 token 锚点**：本轮只对新增/改动引用强制带锚点，历史引用未逐一补（详见 §1 第 5 行）。
2. **建议 1 / 3 / 5 的落点均在第三方 npm 包**（`node_modules/@deepseek-ai/dsh-compaction*`）：本机不宜改写构建产物，正规路径是上游特性请求或 profile 层等效表达；本文件已标注该约束，未声称已实现。
3. **建议 2 / 4 可在插件层独立完成**，但本轮为**设计说明**，未改任何插件源码（`I:\VMsShare\_src-compare\dsh-agent-teams` 保持只读）。

## 6. 命名说明（取证件 vs 正式交付）

- `t1-` / `t2-` / `t3-` 前缀 = **取证件**（分别对应 Codex 侧、插件侧、宿主侧的逐字取证），保留前缀以示来源与可追溯性。
- `t4-mechanism-matrix.md` = **对照表正文（正式交付）**；`t6-improvement-plan.md`（本文件）= **定稿：修正落实 + 改进建议（正式交付）**。
- `t5-verification-report.md` / `t7-incremental-verification.md` = **核验件**（对正式交付的证伪式复核）。
- `README.md` = **总入口**（结论摘要 + 文件清单 + 已知待办）。
- 契约名与实际文件名的偏差：任务书曾出现 `dsh-vs-codex-context-matrix.md`，实际交付为 `t4-mechanism-matrix.md`（内容对应），映射见 `README.md`。
