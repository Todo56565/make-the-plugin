# T4 — 机制清单对照表：Codex vs dsh-agent-teams（插件层）/ DSH 宿主压缩栈

- 输入：`t1-codex-context-health-evidence.md`（openai/codex @ `a07c8ebd`）、`t2-dsh-agent-teams-context-mechanisms.md`（dsh-agent-teams @ `1094b84a` / v0.1.23）、`t3-dsh-host-context-infrastructure.md`（本机 DSH `0.2.0-rc.2` 安装 + 运行态会话）
- 组织方式：**按机制维度组织行**，不按仓库组织。列固定为 `Codex / dsh-agent-teams（插件层）/ DSH 宿主压缩栈`。
- 范围定位：DSH 侧主体是 **NanmiCoder/dsh-agent-teams 成品插件**；DSH 自带的实验版"智能体团队"不在本表内、也不作为评价基准。插件自身不实现压缩/摘要/笔记/检索，把对话历史窗口与压缩整体外包给宿主 `dsh-compaction` 组件栈，因此 DSH 侧结论必须按【插件只持久化工作状态】+【宿主压缩栈处理对话历史】合成读取。
- 证据来源有四个、都必须可回溯：**t1 / t2 / t3**（团队前序取证）+ **§5 附录的补充取证**（船长提供、本轮逐条复核，同一 commit `a07c8ebd`）。凡引用 §5 附录的格，都在格内标注"来源：§5"。
- 证据引用格式：`相对路径:行号`（Codex 相对 `I:\VMsShare\_src-compare\codex`；插件相对 `I:\VMsShare\_src-compare\dsh-agent-teams`；**【宿主压缩栈】列的包内路径相对 `D:\Dev\Path\nodejs_25.0.0\npm-cache\_npx\1e7f6d9597241db0\node_modules\@deepseek-ai\`**，profile 文件用绝对路径 `C:\Users\ZYX\.dsh\profiles\web\cordis.yml`；三类引用均与 t3 原文的标记一致，见该文 §1–§7）。为控制表格宽度，单元格只写可回溯的位置指针，不复述逐字片段；逐字片段在 t1/t2/t3 原文中。

## 0. 列的读法（三条硬约束）

1. **【插件】列不含对话历史治理。** 插件对 harness session 事件日志的读取只有两类：判断 turn 是否已 `step/start`、取该子会话自己的 subagent descriptor（`dsh-agent-teams/src/harness-compat.ts:122-129`）。因此凡是"压缩/摘要/裁剪对话历史"的机制，【插件】列一律写"未实现"，不写"委托给宿主"当作插件能力（t2 §6.1、§6.2 边界总结表）。
2. **【宿主压缩栈】列只在宿主侧成立**，其生效前提是本机 `standard` preset 启用了该组（`@deepseek-ai/dsh-web-app/presets/standard.patch.yml:63-79`，t3 §1.5）；`preset-minimal`（`@deepseek-ai/dsh-web-app/presets/minimal.patch.yml`）内 compaction 相关行数为 0（t3 §1.5）。所以宿主列的任何结论都带"**当前 preset = standard**"这个前置条件。
3. **未取证不写。** 任一格若无 t1/t2/t3 支撑，写 `证据不足`；t1/t3 明确标注 UNVERIFIED 的项照抄其未验证状态。

## 1. 主表：机制维度 → 三方做法

| # | 机制维度 | Codex（做法 + 证据） | dsh-agent-teams 插件层（做法 + 证据） | DSH 宿主压缩栈（做法 + 证据） | 对我方是否适用（生效条件 / 能否照搬 / 依赖组件） | 分类 |
|---|---|---|---|---|---|---|
| M1 | **自动压缩触发：阈值算法** | 阈值 = `min(model 默认 90% 窗口, config)`，实现在 `codex-rs/protocol/src/openai_models.rs:529-539`（`(context_window*9)/10` 与 `std::cmp::min`）；注意 `Total`/`BodyAfterPrefix` 两种 scope 对 config 处理不同（`codex-rs/core/src/session/context_window.rs:61-81`） | 未实现（`src/**` 无 compact/compaction 调用，t2 §6.1） | `thresholdTokens = floor(min(contextWindow×0.8, messageBudget−headroomTokens))`，`dsh-compaction-basic/lib/index.js:15,17,128-134`；本机 1M 窗口 ⇒ ≈803,392，retain≈139k（t3 §2.2） | **不适用（前提不成立）**：公式存在且已装载，但本机 56 个会话最大 `contextPressure` 仅 394,485（阈值的一半），自动触发 0 次（t3 §2.3）。适用条件 = 单会话压力真的接近窗口 80%；照搬无需改插件，但若要收紧到成员级，需宿主 `dsh-compaction-basic` 支持按 agent 分档（当前不支持，见 M15） | ①同一问题不同解法（90% 固定比例 vs 80% 且按路由窗口动态算） |
| M2 | **自动压缩触发：发生时机（回合相位）** | 三处触发点：PreTurn `codex-rs/core/src/session/turn.rs:1304,1316-1329`、MidTurn `:609,621-629`（与 `needs_follow_up` 绑定）、PostTurn `:719-737`（阈值默认 0 = 关闭，`codex-rs/core/src/config/mod.rs:4355-4357`） | 未实现 | 两个监听点：`agent/pre-step` 传 `"pressure"`（`dsh-compaction-basic/lib/index.js:827,834-841`）+ `agent/request-error` 的 `CONTEXT_WINDOW_EXCEEDED` 传溢出（`index.js:861-868`）；`CompactionTrigger` 只有 `'pressure' \| 'context-overflow'` 两种（`dsh-compaction/lib/types/index.d.ts:25`） | **部分适用**：宿主已有"回合前 + 溢出救援"两个相位，缺少 Codex 式的"回合中途/回合后"相位；若需要 PostTurn 式相位，依赖宿主新增 `CompactionTrigger` 取值或新的事件挂钩（`dsh-compaction` 是服务缝，扩展点是它） | ①同一问题不同解法（三相位 vs 两相位） |
| M3 | **自动压缩触发：窗口两档口径** | 两个百分比并存：压缩阈值 90%、可用窗口硬上限 95%（`codex-rs/protocol/src/openai_models.rs:393` `default_effective_context_window_percent=95`）；`token_limit_reached` 还叠 fallback buffer（`codex-rs/core/src/session/context_window.rs:102-115`） | 未实现 | 单档阈值 + 头部余量 `headroomTokens` 默认 65,536（`index.js:63`）+ 为补全预留的 `reservedCompletionTokens`（`index.js:128-134`）；无 95% 第二档 | **不需要照搬**：两档口径在 DSH 侧由"阈值 + reservedCompletion + headroom"三元组覆盖，引入第二档只会增加配置面 | ③DSH 有而 Codex 无（把"第二档"表达成补全预留而非窗口比例） |
| M4 | **长工具输出截断：确定性裁剪** | 保留首尾、省略中间；**首尾各 50%**（`codex-rs/utils/string/src/truncate.rs:156` `split_budget`），默认预算 **10 000 字节**（`codex-rs/models-manager/src/model_info.rs:126`），另加 ×1.2 序列化余量（同仓库 `utils/output-truncation/src/lib.rs:17-21`）；省略标记 `:162`；字节→token 按 4:1（`utils/string/src/truncate.rs:4`） | 未实现（插件侧只有自己生成文本的截断，不碰工具结果） | **两层独立机制**：① `dsh-compaction-tool-result-pruner` 按 **Unicode code point** 裁中间段，默认 `thresholdChars 8192 / headChars 4096 / tailChars 1024`（`dsh-compaction-tool-result-pruner/lib/index.js:7-14,91-95`），只作用于当前 surface 的 `tool/result`（`index.js:137-146`），且**追加替换事件**而非改文件（`index.js:159-177`）；② `dsh-spill-policy` 按 **token** 预算把超大结果外置到文件，保留 head+GAP+tail 并附路径与检索指引（`dsh-spill-policy/lib/index.js:183-199,216-224,24-27`），本机 `maxInlineTokens: 12500`（`@deepseek-ai/dsh-base/cordis.patch.yml:407-410`），作用域"除 read 外所有工具结果"（`lib/index.js:237-242`） | **适用，无需改插件**：成员与 captain 走同一 preset，裁剪自动生效。**运行态注意**：pruner 在 56 个会话中未观测到真实触发（t3 §4.2 UNVERIFIED→收敛），实际生效的是 spill（62 条 notice）与工具自身截断（18 处 `[output truncated; full output: …Temp\dsh-subprocess…]`）（t3 §4.1） | ②DSH 有而 Codex 无（多出"外置到文件 + 可检索路径"一层）；裁中间段一条为 ①同一问题不同解法（字符 vs 字节、8192/4096/1024 vs 10000 对半） |
| M5 | **交接摘要（handoff summary）：prompt 与外壳** | 摘要 prompt = `codex-rs/prompts/templates/compact/prompt.md`（"Create a handoff summary for another LLM…"）；上传时包成 `SUMMARY_PREFIX + 摘要`（`codex-rs/core/src/compact.rs:372-383`，前缀文件 `prompts/templates/compact/summary_prefix.md`）；摘要作为 `CompactionSummary` 片段 push 到替换历史末尾（`compact.rs:759-769`） | 未实现（无任何为压缩历史发起的 LLM 调用，t2 §6.1） | 摘要 prompt = 固定章节结构 `COMPACTION_INSTRUCTION`（`dsh-compaction-basic/lib/index.js:243-248`）；替换用户消息的外壳 = `CHECKPOINT_PREAMBLE` + `<compacted-summary>`（`index.js:280`；运行态实例 t3 §7.2）；摘要调用刻意复刻上一次路由请求以复用 KV 前缀（`dsh-compaction-basic/lib/types/summarizer.d.ts:14-19`） | **适用**：能力已在宿主，插件零改动即可让成员受益。差异点：Codex 的"续作说明"是**加在摘要前**的 `SUMMARY_PREFIX`，DSH 是**包在摘要外的 checkpoint 前言**——两者位置都在摘要之前/外层，语义等价 | ①同一问题不同解法（前缀说明 vs checkpoint 外壳；DSH 额外做 KV 前缀复用） |
| M6 | **压缩之外保留最近用户原话** | 本地文本压缩路径：`COMPACT_USER_MESSAGE_MAX_TOKENS = 20_000`（`codex-rs/core/src/compact.rs:63` 常量）；用户消息集合由 `collect_annotated_user_messages` **定义**于 `compact.rs:574`、**调用**于 `:384`；透传链 `:386`（`build_compacted_history`）→ `:677-688`（`build_compacted_history_with_limit(..., COMPACT_USER_MESSAGE_MAX_TOKENS)`）→ 倒序回填 `:696-755`，超预算截断并 `mark_retained_sources_incomplete()`（`:730-737`）；已识别摘要消息会被排除（`compact.rs:601` `is_summary_message`） | 未实现 | 保留最近 `retainRatio` 默认 **0.16** 比例的消息预算（`dsh-compaction-basic/lib/index.js:17,128-134`，本机 ≈139k tokens），旧段被摘要替换；**无"用户原话优先"的独立配额** | **不可照搬"20k"**：DSH 的保留是**比例制**而非"用户消息 token 配额制"。要复刻"用户原话单独保底"需宿主 `dsh-compaction-basic` 扩展选择策略（属新增能力，非配置）。**注意**：见 §3 R1，20k 只对 Codex 本地文本压缩成立 | ④表面相似但语义不同（token 配额 vs 窗口比例） |
| M7 | **远程/opaque 压缩路径** | 三条路径唯一分流点 `codex-rs/core/src/session/turn.rs:1473`：TokenBudget 开启 → 无摘要新窗口（`:1461-1471` → `compact_token_budget.rs:58`）；provider `remote_compaction = V2` → 服务端 opaque compaction（`compact_remote_v2.rs:499`、保留判据 `:548`）；否则本地文本摘要 | 未实现 | **无远程/opaque 压缩路径**：压缩一律在本地发动 LLM 摘要（`dsh-compaction-basic`）或做无模型裁剪；`dsh-compaction` 只是与后端无关的服务缝（`dsh-compaction/lib/types/index.d.ts:1-8`） | **不适用（DSH 侧对等物不存在）**：DSH 没有"服务端 opaque compaction"概念。若将来新增，扩展点同样是 `dsh-compaction` 的 `CompactionEngine` 抽象，而非插件 | ②Codex 有而 DSH 无（服务端 opaque 压缩 + 三路分流） |
| M8 | **token budget 主动规划** | `Feature::TokenBudget` 默认关闭（`codex-rs/features/src/lib.rs:1889-1894`，`Stage::UnderDevelopment`）；开启后有 `get_context_remaining` 工具（`core/src/tools/handlers/get_context_remaining_spec.rs:8`，但注册被 flag 门控 `core/src/tools/spec_plan.rs:1401-1404`）、reminder 阈值（`features/src/feature_configs.rs:376-383`）与 developer 角色渲染（`core/src/context/token_budget_context.rs:186-200`）；生效还有账号/模型门槛（`core/src/session/token_budget.rs:27-42`） | 未实现（成员从不被注入"还剩多少 token"类信息；派发提示无该字段，`src/scheduler.ts:210-269`） | **无**：token-meter 只用于内部度量与阈值判定（`dsh-compaction-basic/lib/index.js:128-134`、pruner `index.js:567` 的 `tokenMeter.estimateMessage`），**不向模型暴露剩余额度**；`agent/pre-step` 压力检查也不注入提示 | **不可照搬（需宿主新增）**：要复刻需宿主提供"剩余 token 可见性"（类似 Codex 的 developer 消息注入）。插件侧可做的只有把额度写进派发提示，但 t2 域内无此字段，属新增断言，本轮**不提出** | ②Codex 有而 DSH 无（模型可见的预算 + 预算提醒） |
| M9 | **压缩请求自身超窗口时的降级** | 本地路径：`ContextWindowExceeded` → 循环 `history.remove_first_item()` 丢弃最早历史，直到 `turn_input_len <= 1` 才 `set_total_tokens_full` 上抛（`codex-rs/core/src/compact.rs:338-350`；`SessionBudgetExceeded` 不做该降级 `:335-337`）；远程 v2 另有自己的 attempt/重试预算（`compact_remote_v2.rs:82` `MAX_REMOTE_COMPACTION_V2_STREAM_RETRIES=2`） | 未实现 | 溢出救援路径：`agent/request-error` 且 code = `CONTEXT_WINDOW_EXCEEDED` → 先跑 pruner、重测、再选可压区间，受 `maxOverflowRetries` 默认 1 限制（`dsh-compaction-basic/lib/index.js:861-868`、`927-934`）；**不做"逐个丢弃最早历史项"的循环降级** | **部分适用**：DSH 已有的溢出救援覆盖"压缩请求本身放不下"的一部分场景（先裁剪再压），但缺少 Codex 的整项丢弃降级。是否照搬取决于是否观测到失败——本机仅 1 次压缩失败且原因是**额度不足**（t3 §2.3），非窗口溢出 | ①同一问题不同解法（丢项循环 vs 先裁后压 + 重试上限） |
| M10 | **人工/手动压缩入口** | t1 取证范围内**未见**"人工触发压缩"的命令或工具；`get_context_remaining` 只是查询（`get_context_remaining_spec.rs:8`），TokenBudget 分支注册的 `new_context_window` 工具（`codex-rs/core/src/tools/spec_plan.rs:1402`）语义是"重置窗口"而非"摘要压缩" | 未实现（插件不注册 compact 类命令） | `dsh-command-compact` 注册 `compact` 命令，唯一动作 `ctx.compaction.compactNow(...)`（`dsh-command-compact/lib/index.js:55-64,93-98`） | **适用**：本机 26 次压缩**全部**由 `/compact` 手动触发、失败 1 次（额度不足）（t3 §2.3）——即这条是当前**唯一真正在跑的压缩入口**。插件侧无需改动，但长程 team 任务实际上没有自动兜底 | ③DSH 有而 Codex 无（**在本轮 Codex 取证范围内**，人工压缩入口证据不足） |
| M11 | **跨窗口状态文件 / 权威源** | 目录级事实源 = `AGENTS.md`（`codex-rs/core/src/agents_md.rs:1-18,43-49,64,68-72`，`.git` 根发现、不越根、untrusted 项目不读、按 `project_doc_max_bytes` 顺序递减），注入位置 `core/src/session/world_state.rs:202`；Git 差异**只作 UI 事件不回流模型**（`core/src/session/turn.rs:3182-3188`）；"进度文件"约定**未找到任何文件名常量**（t1 §10.3 UNVERIFIED） | **有且是权威源**：`<workspace>/.agent-teams/<teamId>/{team.json,inbox/<key>.jsonl}`（`src/state.ts:1-14`，默认 `stateDir='.agent-teams'` `src/index.ts:195`）+ state root 级 `retired-members.json`（`src/state.ts:55-56`）；归档而非删除（`src/state.ts:1152-1157`）；被显式定义为 truth source（`src/snapshot.ts:1-9`）；契约字段全量持久化（`src/types.ts:189-204`），重试时契约保留、结果清空（`src/state.ts:171-179`） | `session.v4.jsonl.zstd` 多帧 zstd 追加（`dsh-session-persistence-jsonl/lib/types/format.d.ts:12-19,38-53`、`zstd.d.ts:29-34`）；压缩以追加替换事件实现，文件只增不改（t3 §3.3） | **已适用，是我方强项**：team.json 的"每轮重新注入契约"（`src/scheduler.ts:225-241`）在 DSH 侧等价于 Codex 的 AGENTS.md 常驻注入，但**范围更窄**（只覆盖 task 契约，不覆盖项目事实）。可照搬的动作：把项目事实也纳入 `team.json` 的持久字段——**但这是新增设计，超出 t1/t2/t3 证据范围，本表不作为结论** | ③DSH 有而 Codex 无（结构化任务权威源）；与 Codex 的 AGENTS.md 属 ④表面相似但语义不同（任务/协调状态 vs 项目文档） |
| M12 | **子代理上下文隔离/继承** | 隔离为主：远程压缩 v2 的保留判据显式排除**子代理进度消息**与 FINAL_ANSWER 完成消息（`codex-rs/core/src/compact_remote_v2.rs:548`）；fork/provider 侧的具体继承语义 t1 **未取证** | 成员 = captain 的 durable continuable 子代理（`src/members.ts:907-942`，`member.id = start.childId` 写入 `src/types.ts:261-266`）；用 **spawn** 而非 fork（本机依据 = 插件自带 patch 层**显式写入** `memberProvider: spawn`，`@nanmicoder/dsh-agent-teams/cordis.patch.yml:21`；插件侧 Schema 默认与运行时回退分别为 `src/index.ts:133` `memberProvider: z.string().default('spawn')` 与 `:196` `?? 'spawn'`）⇒ 运行态 5 个成员会话全部 `seeded=false, depth=1, origin=subagent, preset=standard`（t3 §5.3） | `fork` provider `inheritsParentContext = true`，seed = 父日志到最后一个 `turn/end` 的前缀、一次性快照（`dsh-subagent-fork-in-process/lib/index.js:4-11,23-28,44,48-55`）；`spawn` provider `inheritsParentContext = false`（`dsh-subagent-spawn-in-process/lib/index.js:30`）；该标志仅描述性、非服务校验项（`dsh-subagent/lib/types/types.d.ts:332-337`） | **已适用**：成员零继承是**当前事实**，不是配置缺省意外。可照搬的替代方案已存在于宿主（把 `memberProvider` 切到 `fork` 即得"已完成轮次前缀"继承），但 t2/t3 未取证该切换对 team 任务的实际影响，本轮不推荐 | ①同一问题不同解法（Codex 以"排除子代理进度"做保留侧隔离 vs DSH 以 provider 选择做继承侧隔离） |
| M13 | **结果投递形态** | t1 取证范围内**未涉及** team 场景下的"成员→队长结果投递"；Codex 侧对应的"跨代理消息"在 t1 只有远程压缩保留判据间接提及（`compact_remote_v2.rs:548`）⇒ 该侧写**证据不足** | **全文字段化投递、无摘要**：任务派发是全文提示（`src/scheduler.ts:210-269`，契约每轮重注入 `:225-241`）；投递通道 queue（独立 FIFO turn）vs steer（最近 step 边界）（`src/scheduler.ts:450-452`、`src/members.ts:966-972`、`src/harness-compat.ts:191-205`）；结果投递为全文 content（`src/tools.ts:2204,2244`），provenance 仅前置标签（`src/mailbox.ts:22-25,27-31`）；成员侧唯一过滤是代际失效去重 + ack（`src/mailbox.ts:158-175`），**非摘要** | **宿主不参与投递内容**：成员 turn 只投递文本到 inbox（同插件证据链），surface 装配时才受 spill/pruner/摘要影响（t3 §6.2） | **已适用（本列无宿主依赖）**：插件侧投递形态完整，已是"零信息损耗"设计。**代价**：全文投递使成员会话**只增不减**，而成员无成员级预算（见 M15），这是长程 team 的首要压力来源。改进方向属 t6，本表只标注 | ④表面相似但语义不同（DSH 的全文投递 vs Codex 摘要式跨段传递，两者不在同一语义层） |
| M14 | **压缩前后是否重写会话记录** | t1 取证只覆盖"替换 history 对象"：本地 `build_compacted_history` 构造新历史（`compact.rs:677`，调用点 `:386`），远程 v2 `build_v2_compacted_history` 构造新列表（`compact_remote_v2.rs:499`）；**压缩是否重写/保留原 rollout 记录，t1 未取证 ⇒ 证据不足** | 未实现（插件不写会话日志内容，只把团队事件 `session.append` 进 captain 会话用于 UI，t2 §6.1） | 明确"**追加而非修改**"：pruner 先 `session.append("compaction/prune", …)` 记定价，再 `session.append("tool/result", …, {surfaceOp:{op:"replace"}})`（`dsh-compaction-tool-result-pruner/lib/index.js:159-177`）；会话文件只增不减、历史可回放（t3 §3.3） | **已适用，且是 DSH 的架构优点**：替换是**投影层**动作，原始事件流保留 ⇒ 复核与回滚成本低。插件侧无需改动 | ③DSH 有而 Codex 无（就"追加式替换、原记录留存"这一点，**Codex 侧证据不足**） |
| M15 | **按成员/子代理区分预算** | **无按角色分档**：`AgentRoleOverrides` 结构体只含 `developer_instructions/model/model_reasoning_effort/model_reasoning_summary/model_verbosity/personality/service_tier/features/skills`，**无任何上下文窗口或压缩字段**（`codex-rs/core/src/agent/role.rs:36-48`）；但**有子代理共享配置闸门**：`build_agent_shared_config` 在 `Feature::SubagentDefaultContextLimits` 启用时显式 `config.model_context_window = None; config.model_auto_compact_token_limit = None;`（`codex-rs/core/src/agent/child_config.rs:132-141`，函数 `:132-165`；该 feature `default_enabled: false`，`codex-rs/features/src/lib.rs:1481-1486`）；同一模式在跨模型评审复现（`codex-rs/core/src/guardian/review.rs:151-154`）。**来源：§5**（本格证据由船长补充取证提供，同一 commit `a07c8ebd`，与 t1 同等标准；逐字片段见 §5 附录）；t1 原文此格为 UNVERIFIED | 未实现：插件完全不参与预算（t2 §6.1） | **无分流，且不感知 agent 维度**：`dsh-compaction-basic/lib/index.js` 全文对 `origin`/`delegationDepth`/`parentSession`/`subagent` 检索命中 0（2 处为文案误命中；本轮独立复核）；自动监听器对所有 agent 生效；成员与 captain 走同一 preset、同一公式、**各自独立计**（t3 §6.1、§6.2） | **共同空白，但表达闸门不同**：两边都**没有**按成员/角色分档的压缩预算（原结论成立）；差别在于 Codex 有可显式覆写子代理继承配额的**闸门**（`SubagentDefaultContextLimits`），DSH 宿主压缩栈**连 agent 维度都不感知**。**改进落点**：不是"给每个成员调不同阈值"，而是在宿主压缩配置层引入"子代理配额闸门"，由 team 插件对成员统一降档；**落点必须在宿主压缩组件**（插件无法单方面改预算）。前提条件：该宿主扩展尚不存在——`dsh-compaction-basic` 现在没有该钩子 | ①同一问题不同解法（**两边都无分档**：Codex 是"显式覆写继承配额"，DSH 是"完全不分维度"） |
| M16 | **持久笔记（notes）** | 有：`history-notes` 扩展的 notes 侧 5 个 action（`notes.list_files_by_prefix` / `read_file` / `search_contents` / `append_to_file` / `write_file`）——action 枚举 `codex-rs/ext/history-notes/src/tools.rs:37-41`、name/namespace 映射 `:71-82`、`tool_name()` 组装 `:290-292`，曝光 `ToolExposure::DirectModelOnly`（`:311-313`，描述要求"Never disclose or describe the tool"）；单文件上限 **1 000 000 UTF-8 字节**（`tools.rs:28` `NOTES_DESCRIPTION`）；存在性前提 = `token_budget.use_history_notes_extension` **且** `is_openai()` provider **且** codex backend 认证（`ext/history-notes/src/extension.rs:46-52`），实验上下文路径会自动打开它（`core/src/session/token_budget.rs:53-56`） | 未实现独立笔记文件：最接近的是 `TaskEvidence.note` 与 `supplementalEvidence`，但它们是**证据记录**、不是供模型回读的语境笔记（`src/types.ts:151-160`；t2 §6.1 结论） | **无**：宿主压缩栈不提供任何"模型可写的持久笔记"接口；`compaction-basic` 的产物只是压缩检查点，不是可追加的笔记文件（t3 §7.1） | **当前不可照搬（DSH 侧缺对等能力）**：Codex 的 notes 是**服务端后端存储**，不是工作区文件（t1 §8.3/§10.3），因此也无法用"让插件写本地文件"来等价替换。插件侧已有一个可用但不是同一语义的落脚点：`team.json` 的 append-only 证据字段（`types.ts:151-160`）——它可被模型后续读到，但只在被显式渲染进派发/status 时才进上下文。**注意**：t1 §12.5 明确把 `codex-rs/memories/**` 的"从 rollout 提炼记忆"与 notes 区分开且**未取证**，本行不得把 memories 计入 notes | ②Codex 有而 DSH 无（模型可写的持久笔记面） |
| M17 | **history 检索** | 有：`history` 侧 4 个 action，**真实名是 namespaced 形式** `history.list_windows` / `history.list_items` / `history.read_item` / `history.search_contents`（`codex-rs/ext/history-notes/src/tools.rs:75-88`，`tool_name()` 组装 `:290-292`；报告给的 flat 名在本 commit 全域零命中，t1 §9.5）；`search_contents` 的 `query` 逐字为 `"Case-sensitive literal substring to find in item content."`（`tools.rs:181`）⇒ **区分大小写的字面包含匹配**；`read_item` 的 schema 在 `tools.rs:166-176`、其 `"required": ["item_id", "window_id"]` 在 `:175`（全文件 `read_item` 字面仅出现在 `:75` 名称映射与 `:89` endpoint）；后端调用 `alpha/history/v2/search_contents` 并携带截断策略请求头，超时 35 s（`ext/history-notes/src/backend.rs:15,63-87`） | **未实现**：插件不查询会话历史来重建上下文，只读 `team.json` / mailbox；对 harness session 事件的读取只有取 subagent descriptor、判断 turn 是否已 `step/start`、以及把团队事件 `session.append` 进 captain 会话用于 UI 三类（`src/harness-compat.ts:122-129`；t2 §6.1 边界表末行"历史检索/笔记/摘要 = 两端均无（插件未实现）"） | **未实现任何"历史检索工具"**；宿主侧与检索沾边的只有 spill 文件外置后的**文件级检索指引**——notice 文本含 `Use read with offset/limit, or grep this path to search within it.`（`dsh-spill-policy/lib/index.js:24-27`），运行态实例见 t3 §4.1（49,930 字符结果 → 14430 bytes 外置） | **部分照搬已存在**：spill notice 给的是"路径 + read/grep 指引"，属同一问题（回查被裁掉的原文）的**不同解法**——Codex 走服务端 history 检索，DSH 走本地文件检索，后者不需要新组件、当前即生效。**另**：DSH 侧缺少 Codex 式的"跨窗口历史 items 按窗口列举"能力（t3 无对应取证），若要跨窗口回读，只能靠 M11 的 `team.json`/session 文件本身，属新增设计、本轮不提出 | ①同一问题不同解法（服务端 history API vs 本地 spill 文件检索）；同时带 ②（DSH 无 history 检索工具） |
| M18 | **thread hint / 跨窗口提示注入** | thread hint 上限 **4 000 字节**（`codex-rs/ext/history-notes/src/extension.rs:30-31`，比较用 `text.len()` ⇒ 单位确为字节 `:140`）；超限或调用失败即放弃本次注入（`:122-140`）；**启用条件** = `token_budget.use_history_notes_extension` + OpenAI provider + codex backend 认证（`extension.rs:46-52`，实验上下文路径自动打开 `core/src/session/token_budget.rs:53-56`）；注入为 `PromptSlot::ContextWindow` 片段、content kind `notes.thread_hint`（`extension.rs:148-152`）。**易误读点**：`world_state.rs:161-179` 构造 `TokenBudgetContext` 时传的是 `/*thread_hint*/ None`（`:177`），真正 hint 走独立 ContextContributor ⇒ "hint 在 `<context_window>` 里"是**两个来源拼进同一 slot**（t1 §8.4） | 未实现 | **无 thread hint 机制**：宿主不注入"上一个窗口的提示"；`compaction-basic` 的检查点前言 `CHECKPOINT_PREAMBLE`（`index.js:280`）是**替换历史段**的一部分，不是独立的恒定注入片段（t3 §7.1） | **不适用（DSH 侧无对等物）**：Codex 的 hint 之所以需要"跨窗口"，是因为它有 `window_id`/`previous_window_id` 的窗口概念（`world_state.rs:161-179`）。DSH 的压缩不产生窗口 id，摘要直接落在原区间位置（t3 §7.2），因此没有"跨窗口提示"的挂点。硬要照搬等于先给宿主发明窗口编号，属新增设计 | ②Codex 有而 DSH 无（跨窗口概念 + hint 注入位） |
| M19 | **固定前缀 / 压缩后仍稳定的指令面** | 有同类动机但机制不同：基础指令与 `AGENTS.md` 作为 world-state section 注入（`codex-rs/core/src/session/world_state.rs:202`；`agents_md.rs:1-18`），并对**已识别摘要**做排除以免被当成用户原话重复保留（`compact.rs:601` `is_summary_message`，调用点 `:591`） | **有**：`ctx.systemPrompt.section(...)` 注册 `agent-teams:usage` 段，文本按 agent 是否 member 选择 `TEAM_MEMBER_PROMPT` / `captainPrompt`（`src/capabilities.ts:101-106`）；策略一次性快照，注释明言"profiles、team state、tool results must never rewrite this prefix"（`src/capabilities.ts:56-59`）；仓库文档给出设计理由（**属仓库文档而非插件代码**）："核心规则不依赖工具结果……结果被裁剪或会话历史被压缩后仍能读到规则"（`docs/progressive-loading.md:19`，t2 §6.2） | 不是宿主机制，而是 harness 系统提示装配（`systemPrompt.section`）；压缩只改写 surface 上的历史段，不触碰系统提示（t3 §6.2：surface 是被压缩栈改写的投影，而非原始事件流） | **已适用，且是我方相对优势**：`capabilities.ts:56-59` 的"固定前缀"约束使长程任务在被裁剪/压缩后仍能读到团队规则，与 `docs/progressive-loading.md:19` 的显式声明一致 | ③DSH 有而 Codex 无（**显式把"前缀不被业务状态重写"写成不变量**；Codex 侧只有"排除摘要消息"这类局部保护） |

## 2. 四类情况分类

按"不强行一一对应"的原则，逐条归入四类之一（仅列主表行的归属，机制的完整说明见主表）：

### 类别① 同一问题不同解法（机制同构、参数/实现不同）
- **M1 自动压缩阈值**：Codex 固定 90% 窗口（config 只能下调）vs DSH 80% 与"窗口−补全预留−headroom"取小。
- **M2 触发相位**：Codex PreTurn/MidTurn/PostTurn 三相位 vs DSH `pressure` + `context-overflow` 两相位。
- **M4 裁剪中间段**：Codex 按**字节**、首尾各 50%、默认 10 000 字节 vs DSH pruner 按**code point**、4096/1024、阈值 8192。
- **M5 交接摘要外壳**：Codex `SUMMARY_PREFIX + 摘要` vs DSH `CHECKPOINT_PREAMBLE + <compacted-summary>`（DSH 额外复用 KV 前缀）。
- **M17 回查被裁掉的原文**：Codex 走服务端 history 检索（`history.search_contents`，区分大小写字面包含）vs DSH 走 spill 文件 + notice 里的 `read`/`grep` 路径指引。
- **M9 压缩自身溢出**：Codex 循环丢最早历史项 vs DSH 先裁剪再压 + `maxOverflowRetries` 上限。
- **M12 子代理隔离**：Codex 在保留判据里排除"子代理进度/完成消息" vs DSH 把"继承/不继承"做成 provider 选择——本机以 bundle 方式装载 agent-teams 插件，该插件自带 patch 层**显式指定** `memberProvider: spawn`（`@nanmicoder/dsh-agent-teams/cordis.patch.yml:21`），故成员零继承是显式选择的结果。
- **M15 按成员/子代理区分预算**：**两边都无分档**——Codex 以"子代理共享配置闸门"显式覆写子代理继承的窗口/压缩上限（`SubagentDefaultContextLimits`，默认关闭），DSH 宿主压缩栈完全无 agent 维度分支。属共同空白的两种表达方式（详见主表 M15 与 §6）。

### 类别② Codex 有而 DSH 无（含"本 commit 才有"）
- **M7 远程/opaque 压缩**：Codex 有服务端 opaque 路径与三路分流（`turn.rs:1473`），DSH 只有本地摘要/无模型裁剪。
- **M8 模型可见的 token budget**：Codex 有 `get_context_remaining`（flag 门控）、reminder 阈值与 developer 角色提醒；DSH 的 token-meter 只做内部度量，不向模型暴露剩余额度。
- **M16 持久笔记**：Codex notes 侧 5 个 action（`notes.*`，服务端后端存储）；DSH 无"模型可写的持久笔记"面。
- **M18 thread hint**：Codex 有 4 000 字节上限的跨窗口 hint 注入位；DSH 无窗口编号概念，也没有恒定注入片段。
- **M6 的"用户原话配额"**：Codex 有独立的用户消息 token 配额语义；DSH 无对应物（见类别④的裁定说明）。**注意**：该配额只对**本地文本压缩**路径成立，远程 v2 是 64k / 单条 agent 消息 10k（t1 §11 D4）——写这条改进项时不得写成"2 万 token"。
- 另：Codex 的 `AGENTS.md` 目录级事实源（M11）在 DSH 侧无对等物——DSH 对应层的取证不在 t1/t2/t3 范围（DSH 是否有等价 project-doc 机制，**证据不足**），故不计入本类，只在 M11 的"适用性"列注明范围差异。

### 类别③ DSH 有而 Codex 无（**限定在本轮 Codex 取证范围内**）
- **M4 的 spill 外置层**：超预算工具结果落盘 + notice 给出路径与 `read`/`grep` 检索指引（62 条运行态 notice），Codex 侧对应机制 t1 未取证。
- **M10 人工压缩入口**：DSH `/compact` 可证（且是本机唯一实际在跑的压缩），Codex 侧人工入口在 t1 范围内证据不足。
- **M14 追加式替换**：DSH 明确"先写定价事件、再追加替换事件、声明 `surfaceOp=replace`，文件只增不改"，运行态可验（114 帧/229 记录）；Codex 侧是否保留原记录 t1 未取证。
- **M15 按成员预算的空白**：DSH 侧是**已证实的空白**（检索命中 0 + 运行态成员 pressure 实测）；Codex 侧经补充取证后**不构成能力有无的对比**——Codex 也无按角色分档的压缩预算（`AgentRoleOverrides` 无上下文/压缩字段），只多出一个"显式覆写子代理继承配额"的闸门（`SubagentDefaultContextLimits`，默认关闭）。因此这条**不要**写成"Codex 有、DSH 没有"，而应写"**两边都无分档，DSH 连 agent 维度都不感知**"——属**共同空白的表达差异**，故归类标为 ①。
- **M11 结构化任务权威源**：`team.json` + mailbox 是显式的 truth source，契约字段跨 attempt 持久化；Codex 的 `AGENTS.md` 是项目文档，不承载任务图。
- **M19 固定前缀**：DSH 把"前缀不被业务状态重写"写成显式不变量（`src/capabilities.ts:56-59`），Codex 侧只有"排除摘要消息"这类局部保护（`compact.rs:601`）。

> 说明：类别②与类别③都在"对方侧"留有 UNVERIFIED 项（M7/M8 的 DSH 侧无对应物是**结构性的**，不是取证缺口；其余标注证据不足者已逐格写明）。M15 的 Codex 侧原为"证据不足"，经补充取证后已收敛并改判为 ①（**共同空白**），见 §4 与 §5 附录。

### 类别④ 表面相似但语义不同（**禁止强行对应**）
- **M6 保留用户原话**：Codex 的 20 000 是**用户消息 token 配额**（"注释过的用户消息"集合，定义 `compact.rs:574` / 调用 `:384` / 透传 `:386`→`:677-688`）；DSH 的 0.16 是**窗口消息预算比例**（本机 ≈139k，含工具输出/developer 消息）。两者数值不可互译，也**不可把 20k 当成 DSH 的调参目标**。
- **M11 AGENTS.md vs team.json**：前者是"项目级文档，启动期按目录树合并注入"，后者是"任务/attempt/契约状态，每轮重发"。共同点只是"都是磁盘上的权威源"，作用域与生命周期不同。
- **M13 结果投递**：DSH 投递的是**成员自己写的全文报告**（无摘要、无损失），Codex 侧对应的"交接摘要"是**模型对历史的压缩产物**。同样是"把一段上下文交给下一个执行者"，一个是通信协议、一个是窗口治理，语义层不同。
- **M5 摘要外壳的"续作说明"**：Codex 的 `SUMMARY_PREFIX` 是**加在摘要字符串前面**的续作说明（`compact.rs:383`），DSH 的 `CHECKPOINT_PREAMBLE` 是**替换用户消息时分隔摘要与前文**的外壳（`index.js:280`）。字符串位置相近，但一个属于摘要文本本身（会被 `is_summary_message` 识别并排除，`compact.rs:601`），一个属于消息包装，不参与摘要识别。
- **M2 的"inside 回合"触发点**：Codex MidTurn 与 `needs_follow_up` 绑定，语义是"这一轮还要继续，先把历史压掉"；DSH 的 `agent/pre-step` 是**每个 step 前**的压力检查。都叫"中途"，但 Codex 的粒度是"回合内是否还有后续"，DSH 的粒度是"每次采样前"。

### 不能归入四类的行
- **M3**：不属于四类中的任何一类，它是 DSH 把 Codex 的"第二档窗口比例"**表达为配置三元组**（阈值 + reservedCompletionTokens + headroomTokens）的结果，归类应写"不可直接对照"（口径不同，不是能力差异）。同类还有 **M10** 中 Codex 侧的人工入口（证据不足，无法判类）。

## 3. 报告差异结论（t1 §11 必带项及其对本表的影响）

视频报告《Codex 上下文压缩：从截断、摘要到 Token Budget》（BV1WpYT6jEx7）的说法**不能直接抄进结论**。以下为 t1 §11 中直接影响本表的五条，并说明它们如何改变了本表的写法：

| 编号 | 报告说法 | 代码事实（t1 证据） | 对本表的影响 |
|---|---|---|---|
| **R1** | "压缩之外保留最近用户原话约 2 万 token" | 20 000 **仅是本地文本压缩**的 `COMPACT_USER_MESSAGE_MAX_TOKENS`（`codex-rs/core/src/compact.rs:63`）；远程/服务器侧 v2 是 `RETAINED_MESSAGE_TOKEN_BUDGET = 64_000`，且单条 agent 消息上限 `MAX_RETAINED_AGENT_MESSAGE_TOKENS = 10_000`（`codex-rs/core/src/compact_remote_v2.rs:78-79`） | **M6 单元格必须双写**：写"20k 仅本地文本压缩路径成立；远程 v2 为 64k/单条 10k"。**禁止**把它当作 DSH 的 0.16 保留比例的等价物或调参目标（类别④） |
| **R2** | history 工具名 = `history_list_windows` / `history_list_items` / `history_search_contents` / `history_read_item` | 真实名为 **namespaced 形式** `history.list_windows` / `history.list_items` / `history.read_item` / `history.search_contents`（`codex-rs/ext/history-notes/src/tools.rs:75-88`、`:290-292`）；flat 名在本 commit **全域零命中**（t1 §9.5 UNVERIFIED） | **M12/M14 及任何引用 history 工具的地方一律用 namespaced 名**；本表主表 M12 的 Codex 侧结论不依赖工具名，故未受影响，但 §3 备注必须带出此结论 |
| **R3** | history 检索"只做包含匹配" | 成立，且明确**区分大小写**：`query` 描述逐字为 `"Case-sensitive literal substring to find in item content."`（`tools.rs:181`）；notes 侧同为大小写敏感字面包含（`tools.rs:213`） | 若后续把"历史检索"列为改进项，**必须写明大小写敏感**，不能写成"模糊搜索" |
| **R4** | 压缩后追加"续作说明" | **未找到**压缩后追加的片段：只有**前置**的 `SUMMARY_PREFIX`（`compact.rs:383`；搜索范围 `compact.rs` 866 行、`compact_token_budget.rs` 69 行、`compact_remote_v2.rs` 1332 行等，t1 §3.4/§12.1 UNVERIFIED） | **M5 单元格只写"加在摘要前/外"**，不得写"压缩后系统再插入续作提示" |
| **R5** | （报告未提）post-turn 压缩 / `new_context_window` / 压缩完成告警 | 均存在：PostTurn 阈值默认 0 关闭（`turn.rs:719-737`、`config/mod.rs:4355-4357`）；`new_context_window`（`spec_plan.rs:1402`）；压缩完成 Warning 是**UI 事件、不进模型上下文**（`compact.rs:421-424`） | **M2 必须单列 PostTurn（默认关闭）**；任何"压缩完成后模型看到 X"的写法都不成立——Warning 不进上下文 |

补充（不改变上述五条的判定）：报告里"token budget 默认关闭"、"压缩请求超窗口时丢弃最早历史"、"thread hint 上限 4000 字节"、"约 90% 触发自动压缩"四条与代码**一致**（t1 §11 D1/D5/D7/D10），本表 M1/M9 已按代码口径书写；`Total`/`BodyAfterPrefix` 的 config 处理差异（t1 §1.2）是报告**未提**的语义分叉，本表 M1 已注明。

## 4. 证据充分性与未覆盖项（诚实边界）

- **两侧都无、或我方明确未实现的格**：M5/M6/M8/M9/M10/M13/M15/M16/M17 的【插件】列，M18 的【插件】列（未实现）与【宿主压缩栈】列（无 thread hint 机制），以及 M7 的【宿主压缩栈】列（无远程压缩对等物）——这些是**未实现**，不是"证据不足"。
- **本表标注"证据不足"的格**（不得据此下结论）：
  - M13 的 Codex 侧：t1 未取证 team 场景下的"成员→队长结果投递"。
  - M14 的 Codex 侧"是否保留原始 rollout 记录"：t1 只覆盖替换后的 history 对象。
  - M10 的 Codex 侧"是否存在人工压缩入口"。
  - M3 的归类（不可直接对照，非证据问题）。
- **补充取证后已收敛、不再写"证据不足"的格**（来源与片段见 §5 附录，均由船长提供、我逐条复核过行号与原文）：
  - **M15 的 Codex 侧**：改为"无按角色分档 + 有 `SubagentDefaultContextLimits` 子代理配额闸门（默认关闭）"的结论（来源：§5 附录，本轮复核）。
  - 该结论的边界：`SubagentDefaultContextLimits` 的确切产品语义在仓库内**无文档**（仅 feature 定义 `codex-rs/features/src/lib.rs:1481-1486`），因此本表**只陈述可观测行为**（启用时把两个字段置 `None`），不推断其意图。
  - 另：§5.5 的 `token_budget` 继承（`child_config.rs:144`）是**继承**、与上一条的**剥离**方向相反，两者不得合并叙述；本表 M8 的 token budget 结论不变。
- **t3 自带的 UNVERIFIED 项**（其存在由源码契约证明，运行态未观测到）：pruner 真实触发实例为 0；压缩前后压力对比不可得（投影只保留最新值、`compaction/summary` 无压缩前 token 字段）；是否发生过 `context-overflow` 救援无独立落盘证据；`image-offload` 阈值未取证。这些**不影响** M4/M9 的"机制存在"结论，但**禁止**在本表基础上断言"pruner/溢出救援在本机实际起过作用"。
- **本表除 t1/t2/t3 外只含一个补充证据源：§5 附录**（船长补充取证、同一 commit `a07c8ebd`、本轮逐条复核），除该附录与引用它的 M15 外不引入任何新断言。所有"适用性/照搬"判断都写成"已适用 / 需宿主某组件支持 / 证据不足 / 不需要照搬"四档，其中"需宿主支持"一律点名具体组件（`dsh-compaction-basic` 分档逻辑与子代理配额闸门、`dsh-compaction` 触发表、宿主剩余额度暴露）。改进项的落地写法属 t6 范围，本表不展开。

### 4.1 独立复核与核验处置（只验证引用与事实，不改变机制结论）

| 复核项 | 命令 / 方式 | 结果 |
|---|---|---|
| 宿主证据行号可回溯性 | 对 t3 引用的 21 个源码锚点按「文件 + 行号 + 关键 token」逐一读取（`dsh-compaction-basic`、`-tool-result-pruner`、`dsh-spill-policy`、`dsh-subagent*`、`dsh-compaction`、`dsh-command-compact`、`dsh-session-persistence-jsonl`） | 21/21 命中（4 处初判 MISMATCH 均因锚点 token 落在注释行、定义在紧邻下一行，属锚点写法问题而非证据错误） |
| 插件证据行号可回溯性 | 对 t2 引用的 31 个源码锚点按同样方式读取 `src/**.ts`、`docs/progressive-loading.md` | 31/31 命中（同上原因），t2 自带的 `check-t2-evidence.mjs` 亦已 43/43 通过 |
| **M15 的"宿主无成员分流"是否被注释/文案误判为无** | `Select-String -Path …\dsh-compaction-basic\lib\index.js -Pattern 'origin\|delegationDepth\|parentSession\|subagent\|isSeeded'` | **命中 2 处，均为文案**（L249 摘要提示词里的 `user's original ... goals`、L880 的 `preserving the original request error`），无任何分支/过滤逻辑 ⇒ 支持 t3 §6.1 的"无血缘分流"结论 |
| **M15 的 Codex 侧补充取证**（船长提供，本轮逐条复核） | 读取 `codex-rs/core/src/agent/child_config.rs:110-169`、`codex-rs/core/src/guardian/review.rs:135-160`、`codex-rs/core/src/agent/role.rs:30-89`、`codex-rs/features/src/lib.rs:1478-1489`；并对 `codex-rs` 全域检索 `SubagentDefaultContextLimits` 与 `model_auto_compact_token_limit` | `build_agent_shared_config` 的 `None` 覆写（`:135-141`）、guardian 跨模型分支（`:151-153`）、`AgentRoleOverrides` 无上下文/压缩字段（`:36-48`）、feature `default_enabled: false`（`:1481-1486`）**全部与补充描述一致**；非测试代码中 `model_auto_compact_token_limit` 的写点只有 `child_config.rs:140` 与 `review.rs:153` 两处 ⇒ 支持"无按角色分档"的否定结论 |
| **t5 核验意见的处置**（`t5-verification-report.md` 的 §2.1–§2.4） | 对每条被点名的引用回源重读：agent-teams 插件自带 patch 层的配置块（`@nanmicoder/dsh-agent-teams/cordis.patch.yml:19-21`）、`dsh-agent-teams/src/index.ts:131-139`、`ext/history-notes/src/tools.rs:26-45`/`:61-90`/`:160-190` | **§2.1 成立**（插件包 patch 第 21 行确有 `memberProvider: spawn`，我上一版的"profile 未覆盖"是错的，已改写 t3 §5.3 与本表 M12）；**§2.2 成立**（notes action 枚举在 `:37-41`，已改）；**§2.3 成立**（`:206-218` 处无 `read_item`，正确位置 `:166-176`，已改）；**§2.4 成立**（`:384` 才是调用点，已改）。**§2.6（全表补 token 锚点）为低优先级格式项**，本表只对二轮改动的引用补了锚点，余项留给 t6 |

> 该复核只用于确认引用可回溯；若与 t1/t2/t3 原文冲突，以原文为准。

### 4.2 版本修订台账（t4 初版 → 船长补充取证轮 → t5 核验更正轮）

| 位置 | 修订前 | 修订后 | 依据 |
|---|---|---|---|
| 主表 M15 · Codex 列 | 「t1 范围内无…⇒ **证据不足**」 | 「**无按角色分档** + 有 `SubagentDefaultContextLimits` 子代理配额闸门（默认关闭）」，追加 §5 附录逐字证据 | §5.1–§5.4（本轮复核） |
| 主表 M15 · 适用性列 | 「这是本对照最清晰的可落地空白…」 | 「**共同空白，但表达闸门不同**；改进落点 = 宿主压缩配置层引入"子代理配额闸门"」 | §5.1；DSH 侧 t3 §6.1 |
| 主表 M15 · 分类列 | ③DSH 有而 Codex 无 | **①同一问题不同解法**（两边都无分档） | 同上 |
| §2 类别①/③ | M15 仅列于 ③ | ③ 改为不在场说明，① 新增 M15 条目 | 同上 |
| §4 证据不足清单 | M13/M15 的 Codex 侧 | 只保留 M13 / M14 / M10 / M3；M15 移入"已收敛" | 同上 |
| §5 收口 | 「最清晰的可落地空白是 M15…没有任何按成员区分的预算」 | 「**两边都没有分档**；差异在"配额覆写闸门的有无"」 | 同上 |
| t3 §5.3 与 §8 表 | 「用的是 spawn，不是 fork」 | 「**默认**用 spawn（`memberProvider` 可覆盖）」；运行态 `seeded=false` 结论不变 | 复核 `src/index.ts:196` |
| t3 §5.3 与 §8 表（**二轮**，据 t5 核验更正） | 「本机 profile 未覆盖该默认」——**该陈述错误** | 「插件自带 patch 层**显式写入** `memberProvider: spawn`（`@nanmicoder/dsh-agent-teams/cordis.patch.yml:21`）」；另补 Schema 默认在 `src/index.ts:133`、`:196` 是运行时回退 | 复核插件包 `cordis.patch.yml:19-21` |
| 主表 M16 · Codex 列（二轮） | notes 5 个 action 引用 `tools.rs:63-88,290-292`、notes 上限引 `:31` | 改为 action 枚举 `:37-41`、name/namespace `:71-82`、`tool_name()` `:290-292`；`NOTES_DESCRIPTION` 在 `:28` | t5 §2.2（本轮复核：`:37-41`/`:71-83`/`:26-28` 逐字命中） |
| 主表 M17 · Codex 列（二轮） | `read_item` 必填字段引 `tools.rs:206-218` | 改为 `:166-176`（schema）、`"required": ["item_id","window_id"]` 在 `:175` | t5 §2.3（本轮复核：`:175` 逐字命中） |
| 主表 M6 · Codex 列（二轮） | `collect_annotated_user_messages` 引 `:574` 且写作"唯一调用点 `:386`" | 改为 定义 `:574` / 调用 `:384` / 透传 `:386`→`:677-688` | t5 §2.4（本轮复核） |
| 主表 M12 · Codex 列（二轮） | 「`src/index.ts:196` 默认 `'spawn'`」 | 改为「本机依据 = 插件自带 patch 层显式 `memberProvider: spawn`（插件包 `cordis.patch.yml:21`）」，并补 Schema 默认 `:133` | t5 §2.1（本轮复核） |

## 5. 附录：M15 的 Codex 侧逐字证据（补充取证，按 t1 同等标准）

- 证据源：`I:\VMsShare\_src-compare\codex`，commit `a07c8ebd`（与 t1 同一 commit）。
- 来源：船长补充取证；本轮做**只读复核**（行号与逐字内容逐条比对，结论一致），未修改被读取的文件。
- 用途：支撑 M15 的"无按角色分档 + 有子代理配额覆写闸门"结论。以下片段均为**逐字**，每段 ≤15 行。

### 5.1 子代理共享配置：`SubagentDefaultContextLimits` 启用时剥掉两个上下文档位

`codex-rs/core/src/agent/child_config.rs:135-141`（函数 `build_agent_shared_config` 起于 `:132`，两个调用方 `build_agent_spawn_config` `:110-122`、`build_agent_resume_config` `:124-130`）：

```rust
    if config
        .features
        .enabled(Feature::SubagentDefaultContextLimits)
    {
        config.model_context_window = None;
        config.model_auto_compact_token_limit = None;
    }
```

**可观测行为（本表只陈述这一层）**：该 feature 启用时，子代理的 `model_context_window` 与 `model_auto_compact_token_limit` 被置为 `None`（即不再沿用父级通过 config 施加的窗口/自动压缩上限）。**不推断产品意图**：仓库内无该 feature 的文档，`codex-rs/features/src/lib.rs:1481-1486` 仅给出定义。

### 5.2 跨模型评审中的同一模式

`codex-rs/core/src/guardian/review.rs:151-154`：

```rust
    if review_model.model != context.model_info.slug {
        spawn_config.model_context_window = None;
        spawn_config.model_auto_compact_token_limit = None;
    }
```

### 5.3 子代理基础设施中**没有**按角色分档的压缩预算

`codex-rs/core/src/agent/role.rs:36-48`（`AgentRoleOverrides`）：

```rust
#[derive(Default, Serialize)]
struct AgentRoleOverrides {
    developer_instructions: Option<String>,
    model: Option<String>,
    model_reasoning_effort: Option<ReasoningEffort>,
    model_reasoning_summary: Option<ReasoningSummary>,
    model_verbosity: Option<Verbosity>,
    personality: Option<Personality>,
    service_tier: Option<String>,
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    features: BTreeMap<String, bool>,
    skills: Option<SkillsConfig>,
}
```

- **无** `model_context_window`、**无** `model_auto_compact_token_limit`、**无** 任何 retain/compaction 字段 ⇒ 角色维度不承载压缩预算。
- 全 `codex-rs` 检索 `AgentRole` + `compact` / `context_window` / `token_limit` / `budget` 的组合**零命中**（命中项全部落在测试文件、`MultiAgentRoleInstructions` 提示词、或 `role.rs` 的 `skills.config.retain` 等无关语义上）。
- 非测试代码中 `model_auto_compact_token_limit` 的写点只有两处：`codex-rs/core/src/agent/child_config.rs:140` 与 `codex-rs/core/src/guardian/review.rs:153`（均为置 `None`）；其余均为读取（`core/src/session/context_window.rs:62-73`、`models-manager/src/model_info.rs:29` 等）或测试构造。

### 5.4 该闸门的开关状态

`codex-rs/features/src/lib.rs:1481-1486`：

```rust
    FeatureSpec {
        id: Feature::SubagentDefaultContextLimits,
        key: "subagent_default_context_limits",
        stage: Stage::UnderDevelopment,
        default_enabled: false,
    },
```

⇒ 属**未发布、默认关闭**的 feature；`Feature::SubagentDefaultContextLimits` 的枚举成员在 `codex-rs/features/src/lib.rs:231`。

### 5.5 相关但不同的一条（避免误读）

`codex-rs/core/src/agent/child_config.rs:142-145`：

```rust
    // Preserve activation for history forks without freezing the parent's model-owned prompts.
    // Fresh child startup restores configured preferences from the retained snapshot.
    config.token_budget = turn.configured_token_budget.clone();
    config.model = Some(turn.model_info().slug.clone());
```

这是**继承** `token_budget`（上一段是**剥离**窗口/压缩上限），二者方向相反，不得合并叙述。本表 M8 的"token budget"结论不因此改变（Codex 的 token budget 仍是全局 feature，不是按角色分档）。

## 6. 一句话收口

Codex 与 DSH 在**机制维度上高度可比**（压缩触发、摘要外壳、确定性裁剪、跨窗口状态、子代理隔离、持久笔记与检索、按子代理的配额表达都有对位），但三处**不可强行对应**：①"保留用户原话 20k"是本地文本压缩路径的 token 配额，与 DSH 的窗口比例保留不是同一量纲（远程 v2 为 64k）；②"人工 `/compact`"在 DSH 是当前唯一实际在跑的压缩入口，而 Codex 侧自动触发才是主路径；③DSH 的"追加式 surface 替换 + spill 外置检索"是 Codex 本轮取证未覆盖的架构特性。**M15 的准确表述是：两边都没有按成员/角色分档的压缩预算**——Codex 有子代理共享配置闸门（`SubagentDefaultContextLimits`，默认关闭）可显式覆写子代理继承的窗口/压缩上限，DSH 宿主压缩栈则连 agent 维度都不感知（零 `delegationDepth/parentSession/origin/subagent` 命中）；即差异在"**配额覆写闸门的有无**"，不在"是否分档"。**最清晰的可落地落点仍是 M15**：在宿主压缩配置层引入"子代理配额闸门"让插件对成员统一降档（Codex 侧 `child_config.rs:135-141` 可作参照实现），而长程 team 任务的成员全文投递（M13）恰恰是压力最集中的地方。
