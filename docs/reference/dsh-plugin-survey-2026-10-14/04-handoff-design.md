# dsh-token-budget：45% 压缩改为「模板交接 + LLM 兜底」（已确认方案，对 §7-10 的修订建议）

日期：2026-10-14，2026-10-15 修订。基线：dsh 0.2.0-rc.2，dsh-agent-teams 0.1.23。
依据：`docs/design/plugin-design.md`（下称「设计」，引用写 `设计:行`），`docs/design/临时记录.md`（下称「记录」）。
状态：用户已确认，**尚未写入设计文档**。本文件给出写入 §7-10 的修订内容（§2），以及顺带发现的设计勘误（§5）。

## 1. 已定决策（用户 2026-10-14 确认）

1. **「原文不保留」维持现状。** 继续由 `agent/pre-step` 调 `compactIfNeeded(agent, 'context-overflow')`，只保留最后一个节点及其工具调用配对。这就是现行方案 D1（设计:165-173、:410），本次不改。
2. **笔记新鲜时用固定交接模板，零模型调用。**
3. **笔记缺失或过期时退回 LLM 摘要**，即调用 preset 引擎原有的 `summarize()`。
4. **拦截点选 compaction 引擎的 `summarize()` 钩子**：通过 `ctx.agentPresets.serviceFor(agent, 'compaction')` 拿到 preset 引擎，对实例打补丁，按 agent 用 `WeakSet` 判断是否为团队会话。**不选** §7-10 原文设想的 `llm/stream` 中间件加 `COMPACTION_INSTRUCTION` 文本匹配（设计:425-427）。

## 2. 对设计 §7-10 的修订建议

| 项 | 现行设计（设计:412、:425-429） | 修订为 |
|---|---|---|
| 是否拦截 | v1 不拦截，等 PoC-8 后再决定是否加默认关闭的实验开关（设计:412、:429） | 拦截，团队会话默认 hybrid：笔记新鲜 ⇒ 模板；缺失或过期 ⇒ 原 LLM 摘要 |
| 拦截点 | `llm/stream` waterfall，可 short-circuit（设计:425）；识别摘要请求靠匹配 `COMPACTION_INSTRUCTION`，宿主一改就失效（设计:427） | 引擎的 `summarize()` 钩子（§3.1）。不做文本匹配，也不碰 `llm/stream`，不存在「preset 隔离组内的调用是否经过宿主层 listener」这个待证推断（设计:425） |
| 作用范围 | — | 只对 `WeakSet` 中的团队 agent；其他会话、引擎的其他方法一律不变 |
| 连续性风险 | 「新窗口连续性完全依赖成员是否写好笔记」（设计:427） | 由新鲜度闸门化解：笔记不新鲜就不用模板 |
| 成本说法 | 输入约 0.45W，大部分命中前缀缓存；输出 ≤ `maxTokens` 65,536（设计:427） | 保留，并写明结论：零模型交接主要节省**输出 token 和等待摘要生成的时间**，输入因前缀复用大多已命中 KV cache（§3.2） |
| 便宜模型 | `summarizationProvider/summarizationModel`（设计:428） | 保留为 LLM 兜底路径上的可选降本手段 |
| 配置（建议，未经用户确认） | — | `handoff: 'hybrid' \| 'template' \| 'llm'`，默认 `hybrid`；新鲜度阈值可配 |

§7 决议表第 412 行建议改为：「7-10 摘要拦截：**团队会话拦截**（用户 2026-10-14）。拦截点为 `serviceFor` 取得的 preset 引擎的 `summarize()`；笔记新鲜 ⇒ 零模型交接模板，缺失或过期 ⇒ 原 LLM 摘要；原文保留策略仍按 D1。」

## 3. 依据

### 3.1 `summarize()` 是引擎公开的定制钩子【源码】

compaction-basic 0.2.0-rc.2（`/workspace/work/pk/deepseek-ai-dsh-compaction-basic-0.2.0-rc.2/package/lib/index.js`）：

- 类注释：「`summarize()` is the sole subclass customization hook」（`:796`）；方法注释：「Override this sole hook for a template or remote summarizer」（`:893`）；实现 `:899`。
- 引擎内部经 `this.summarize` 动态派发（`regionDependencies`，`:1013-1016`），所以对**实例**覆写同样生效。
- 钩子收到的 agent 就是 `compactRegion(start, end, agent)` 的调用方：`:971-972` → `compactSurfaceRegion` → `:478` → `summarizeCompaction` `:587`。所以按 agent 判团队身份在源码层面成立（运行态仍需验证，见 §6）。
- 覆盖面：45% 主动压缩（overflow 分支，`:927-934`）和 preset 自带的 80% pressure 压缩都经 `compactRegion` → `summarize`。所以挂钩后，团队会话在两条路径上都适用 hybrid 规则。
- overflow 分支绕过阈值与保留尾段（`:906-908`）；默认阈值 0.8、保留 0.16（`:15,17`）。

同类先例：smart-compact v0.5.3 子类覆写 `summarize()`，返回 `provider:'rollover-template', model:'none'`（`/workspace/work/hoyyang_dsh-smart-compact/src/rollover.ts:376-423`），模板在 `:213-247`。用 `serviceFor` 拿实例后包装 `summarize` 的做法来自 MimicHunterZ/dsh-agent-compact（`docs/research/context-compare/community-plugins-survey.md:115`、`:176`）。

### 3.2 「贵」的更正

摘要请求复用会话自身的 system prompt、tools 和前缀消息，注释写明目的是不让 provider 的 KV cache 失效（basic `lib/index.js:890-892`；设计:374；记录:380）。本机 cc 路由实测 406 条带 usage 的 assistant 消息中有 402 条 `cacheReadTokens > 0`（记录:964）。所以一次摘要的输入大部分是缓存命中。模板交接省下的主要是：

- 摘要的**输出 token**（上限 `maxTokens`，设计:427）；
- **等待摘要生成的时间**，这段时间成员会话处于阻塞；
- 次要的一点：checkpoint 之后未命中缓存的尾段输入。

不应再说「每次换窗都要付一整次昂贵的摘要调用」。

## 4. 方案细节

### 4.1 模板内容（建议）

```
[dsh-token-budget] 团队窗口 #N 已打开。上一窗口已完整归档，没有丢弃任何内容。
身份：<成员名>（团队 <team>）
当前任务：<task id> <标题>，attempt_id=<从 .agent-teams 读>，状态=<…>
上一步动作：<最后一个工具名 + 时间，不含参数和结果>
笔记：最近 ≤5 条 team_notes 的元数据。先读笔记，笔记里没写的不要自行假设。
缺细节时：用 history_search_contents / history_read_item 读原文。
```

- attempt_id 从磁盘（`team.json`）读，不依赖模型记忆。任务 id 与标题和 hint 同源（设计:415）。
- 引擎代写的字段（任务标题、上一步动作）先做脱敏，可参考 smart-compact 的 `src/redact.ts`。
- 返回 `provider:'team-handoff', model:'none'`，便于在日志中区分。

### 4.2 新鲜度判定

- 参考 smart-compact 的 `deriveNotesFreshness`（`src/rollover.ts:119-133`）：统计该成员最后一次写自己的 `teams/<teamId>/<agentKey>.md` 之后发生的会话事件数。为 0 或低于阈值（可配置）即为新鲜。时间戳取 `NotesStore` 的 `mtimeMs`（`src/notes/store.ts:18,69`）。
- 笔记目录不存在、读取失败、或判定为过期，一律走 LLM 兜底。

### 4.3 接线

- 在 `agent/created`（或首次 pre-step）解析出团队身份后，把该 agent 放进 `WeakSet<Agent>`；身份失效时移除。
- 通过 `serviceFor(agent, 'compaction')` 拿到 preset 引擎。每个引擎实例只打一次补丁（symbol 标记，幂等），插件 dispose 时还原：
  - agent 在 `WeakSet` 中，且笔记新鲜：返回模板；
  - 其他情况：调用原方法。
- preset 引擎被同一 preset 的所有会话共享（设计:149），所以补丁只改 `summarize`，不改 `config`，也不碰 `thresholdRatio`。这与设计:149「不采用改共享引擎配置」的立场一致。

## 5. 对设计文档的勘误建议

| # | 位置 | 现文 | 建议 |
|---|---|---|---|
| 1 | 设计:141 | 「DSH 里『换窗』= 摘要压缩：没有 Codex 那种不做摘要、直接开新窗口的路径」 | **不完全准确。** 宿主确实没有内建的不摘要换窗，但 `summarize()` 是引擎公开的定制钩子（basic `lib/index.js:796,893`），可以返回零模型模板。smart-compact 就是靠覆写它实现 Codex 式换窗的（`hoyyang_dsh-smart-compact/src/rollover.ts:376`）。建议改为：「宿主没有内建的不摘要换窗路径，但 `summarize()` 钩子可以返回模板，从而实现零模型换窗（见 §7-10 修订）」 |
| 2 | 设计:425-427 | 拦截点为 `llm/stream`，识别靠匹配 `COMPACTION_INSTRUCTION` | 按 §2 改为 `summarize()` 钩子 |
| 3 | 设计:177 | 「`compactAtRatio` 只用于提示文本与 PoC-9 偏差校验；不驱动压缩」 | 这是方案 A 时期的文字。D1 下它驱动主动压缩（`src/index.ts:177,189`），需改写 |
| 4 | 设计:381 | PoC 前置：「按 §2.4 把 `thresholdRatio` 设为 0.45」 | D1 下宿主阈值保持默认、作兜底（设计:161），前置应只保留「回退 §14 的降阈值覆盖」 |
| 5 | 设计:421 | 「直接调自动压缩函数是否可行 → 不可行，有三道门」 | 已被设计:143 的更正（`serviceFor` 通道）取代，建议标注「已过时」 |
| 6 | 设计:101、:385 | inject 列表未含 `llm`；PoC-1 的列表也未含 `agentPresets/sessions/sessionPersistence` | 统一两处；§7-3 笔记合并用 `ctx.llm.stream()`（设计:414），应把 `llm` 列入 |
| 7 | 设计:254 | 身份「在 `agent/created` 时解析一次并缓存，由 `agent-teams/*` 事件失效」 | 实现改成按需解析，「非团队」缓存 5 秒，以 `agent_teams_*` 工具返回作失效信号（`src/team/directory.ts:31,39-52`；`src/index.ts:65-68`），建议同步 |

## 6. 待验证

- [ ] 多个成员共用一个引擎实例时，`summarize` 收到的 agent 是否就是正在压缩的那个成员。源码链路已确认（§3.1），还需运行态确认。
- [ ] 按最坏情况长度估算的模板，能否满足压缩事务「checkpoint 比被遮蔽内容小」的约束（参考 smart-compact 的 `handoffCheckpointWorstCaseText`，`src/rollover.ts:261-270`）。
- [ ] 补丁同时作用于 preset 的 80% pressure 路径和团队成员手动 `/compact`。这是否符合预期，需要用户确认（推断：符合「团队会话统一 hybrid」的意图）。
- [ ] e2e：成员到 45% 换窗后，不调用 `claim_task`，直接用模板里的 attempt_id 执行 `update_task`，应当成功。
- [ ] e2e：成员从未写过笔记时，换窗走的是 LLM 摘要（provider 不是 `team-handoff`）。
- [ ] 非团队会话的压缩完全不受影响（provider 仍是原 LLM）。
