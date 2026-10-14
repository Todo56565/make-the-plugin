# dsh-smart-compact vs dsh-token-budget 对比报告

- 对象 A：`hoyyang/dsh-smart-compact` v0.5.3（本地 `/workspace/work/hoyyang_dsh-smart-compact`，HEAD `b5a074e`）
- 对象 B：`Todo56565/make-the-plugin` = `dsh-token-budget` v0.0.1（本地 `/workspace/work/Todo56565_make-the-plugin`，HEAD `b229480`，仓库只有 1 个提交）
- 参考：`NanmiCoder/dsh-agent-teams` 0.1.23；`/workspace/work/pk` 里 dsh 0.2.0-rc.2 的 `dsh-compaction-basic` 与 `dsh-subagent`；B 的 `node_modules` 里 0.2.0-rc.2 的 `dsh-agent-preset-registry` / `dsh-system-prompt` / `dsh-session`
- 写于 2026-10-14，2026-10-15 按设计文档修订。证据写法：`文件:行`。**【实测】**= 本次在沙箱里跑过；**【源码】**= 读代码得出；**【推断】**= 由前两者推出、没在真实宿主上跑过
- 设计依据：`docs/design/plugin-design.md`（下称「设计」，引用写 `设计:行`）与 `docs/design/临时记录.md`（下称「记录」）。设计已明确并经用户确认的取舍，本报告记为**已定取舍**，不再列为缺陷；只有设计未覆盖、或代码与设计不符的条目才列为**仍待处理**（§4.2）

---

## 0. 结论先行

1. **只能选一个时，用 dsh-token-budget（make-the-plugin）做底座，不要装 smart-compact。** smart-compact 是给 dsh 0.1.5 时代、没有 preset 隔离的 profile 写的。在 agent-teams 0.1.23 要求的宿主 0.2.0-rc.2 上，它有三处核心功能实际失效或被覆盖：提醒到不了模型、`ctx_history` 读不到工具结果、自动换窗可能被 preset 自带的 80% LLM 摘要抢先（后两条见 §1.3）。
2. **两者能同时装上**：工具名不重复，`compaction` 服务槽也不冲突，因为两边用的根本不是同一个引擎。但同时装的效果是互相干扰，而不是互相补充：两套 notes、两套 history、两个「剩余上下文」工具算法不同，换窗锚点还会让模型去读空的 `ctx_notes`。**不建议同时装。**
3. **要从 smart-compact 移植的只有它真正的强项**：零模型调用的交接模板、笔记新鲜度检查、脱敏、`new_context`、运行状态文件。改成「通过 `serviceFor` 给 preset 引擎装一个只对团队会话生效的 `summarize` 钩子」，笔记新鲜时用模板、缺失或过期时退回原 LLM 摘要（用户 2026-10-14 确认，方案见 `04-handoff-design.md`）。核心工作量约 **4–5 人日**（明细见 §3）。

---

## 1. 完成度对比

### 1.1 功能覆盖

| 能力 | smart-compact | token-budget |
|---|---|---|
| 作用范围 | 所有会话，不区分团队（`src/index.ts:54-400` 里没有任何身份过滤） | **只管团队会话**：按 `team.json` 解析队长和成员（`src/team/identity.ts:31-75`，`src/index.ts:84,107,175`） |
| 预算提示 | 首次说明 + 25/50/75% 各一次 + grace 提醒，注入方式是 `system-prompt/assemble` waterfall（`src/reminder.ts:62-67,112-176`）。**在 0.2.0-rc.2 上不生效**，见 §1.6-A1 | 37/40/43% 按 3% 分档，走 `systemPrompt.context`，只在跨档时文本才变（`src/index.ts:77-96`，`src/budget/usage.ts:40-47`，`src/budget/reminder.ts:63-72`） |
| 自动压缩 | 85% 三段策略：不动 / grace / 强制换窗（`src/rollover.ts:491-517`）；overflow 直接交给 basic 处理（`:518-520`） | 45%，在宿主层 `agent/pre-step` 里，通过 `serviceFor(agent,'compaction')` 取 preset 的引擎，调用 `compactIfNeeded(agent,'context-overflow')`（`src/index.ts:172-200`，`src/budget/compact.ts:42-50`） |
| 压缩产物 | **零模型调用**的交接模板：Task / Last action / 笔记指针 / 笔记过期提示 / history 指针，并按最坏情况估算 token（`src/rollover.ts:213-270,376-423`） | preset 的 compaction-basic 照常调 **LLM 摘要**，overflow 分支绕过阈值与保留尾段，只保留最后一个节点及其配对（basic `lib/index.js:906-908,927-934`）。这是已定取舍：D1（设计:165-173、:410）与 v1 不拦截（设计:412、:425-429）。用户 2026-10-14 已追加「笔记新鲜时走模板」的修订，见 `04-handoff-design.md` |
| 笔记 | `ctx_notes`，按 **sessionId** 存在 DSH_HOME 下（`src/index.ts:61-62,291-334`） | `team_notes`：成员各自一份 + 团队共享 `workspace.md`，存在工作区 `.agent-teams/.context/notes/`（`src/notes/tool.ts:43-125`，设计 §4.2.1）；可选在任务完成时用模型合并（`src/index.ts:207-285`） |
| 窗口原文回查 | `ctx_history` list/read/search，数据来自 `session.snapshotEvents()`（`src/history.ts:40-47`）。这个接口在 0.2.0-rc.2 已标 deprecated（`dsh-session/lib/index.js:1370-1376`） | `history_list_windows/list_items/read_item/search_contents` 四个工具，用 persistence 只读句柄（非弃用路径），带 `inheritedEventCount` 边界（`src/history/source.ts:4-6,32-45`） |
| 剩余量工具 | `get_context_remaining` = W − P（`src/budget.ts:48-60`） | `context_remaining` = floor(W×0.45) − P，并标明是估算（`src/budget/tool.ts`） |
| 模型主动换窗 | `new_context`，带「请求不会被悄悄吞掉」的保证（`src/index.ts:372-391`，`src/rollover.ts:442-490`） | 无 |
| 手动命令 / UI | `/smart-compact` 命令 + 输入框按钮 + 可用性路由（`src/command.ts`，`src/state.ts`，`src/client/*`） | 设置页：配置模型下拉、数值即时生效（`src/client/*`，`src/config.ts`） |
| 运行可观测 | `engine-state.json`：挂载情况、换窗次数、拒绝原因、提醒计数（`src/index.ts:173-265`） | 只有 logger |
| 脱敏 | 有，强制开启（`src/redact.ts`，`src/rollover.ts:403-413`） | 无（摘要由宿主生成） |

### 1.2 测试数量与覆盖

| | smart-compact | token-budget |
|---|---|---|
| 用例数 | 10 个文件，**123 个**（vitest） | 9 个文件，**32 个**（`node --test`） |
| 本次结果（依赖用仓库 lockfile 安装） | **122/123 通过**【实测】。唯一失败的 `notes.test.ts:66` 往 `/proc/definitely/not/writable` 写文件，在沙箱里超过了 5s 超时，属于环境问题，不是代码缺陷 | **32/32 通过**，`pnpm typecheck` 通过，`pnpm build` 成功，`lib/index.js` 能正常 import【实测】 |
| 换成 0.2.0-rc.2 宿主包后重跑 | **119/123**：除上面那个环境用例外，`history.test.ts` 又挂 3 个。原因是 0.2.0-rc.2 的 `dsh-session-query` 的 `blockText` 不再提取 `tool-result` 块（`node_modules/@deepseek-ai/dsh-session-query/lib/index.js:576-582`），`ctx_history` 的 search/read 因此拿不到工具结果正文【实测，临时副本 `/tmp/sc2`】 | 本来就锁定 0.2.0-rc.2 |
| 覆盖面 | 引擎测试继承**真实的** `BasicCompactionEngine`（0.1.5-rc.2），ctx 是假的（`tests/engine.test.ts:1-40`）。另外覆盖了命令、生命周期、客户端、脱敏。**提醒测试用的假结构 `{system:'BASE'}`（`tests/reminder.test.ts:31`）与真实宿主的组装结构不一致**，所以 §1.6-A1 的缺陷没被测出来 | 全是纯逻辑单测：分档、闸门、身份、笔记、合并、history 模型、hint。**`index.ts` 的接线、45% pre-step 压缩路径、`serviceFor` 取引擎，都没有测试** |

### 1.3 真实宿主验证

- **smart-compact**：CHANGELOG 记录了多次真实会话事故及修复，例如 664 个会话的回放（0.5.1）、2707 个事件的回放（0.5.2）。但这些都是在 **0.1.5-rc 系**宿主上做的（`README.md:173,176,201`；lockfile 里宿主包全是 0.1.5-rc.2）。没有看到 0.2.0-rc.2 / preset 隔离 profile 上的验证记录。B 仓库自己的调研也指出过这个问题（`docs/research/context-compare/community-plugins-survey.md:58-60`）。
- **token-budget**：在真实 DSH 0.2.0-rc.2 web 上验证过的只有两项：设置页（出现、下拉、保存写入 profile）和 persistence 只读读取（设计 §2.2、§4.4 末段）。**核心路径没有在真实团队会话里跑过**：成员会话能否看到宿主层 section/context、45% 主动压缩、hint 刷新、笔记会不会影响审计，即设计 §6 的 PoC-2 到 PoC-9 全部未完成。

### 1.4 发布 / 安装形态

| | smart-compact | token-budget |
|---|---|---|
| 分发 | npm 公开包 `dsh-smart-compact@0.5.3`（`npm view` 能查到【实测】），BSD-3-Clause | `"private": true`，`UNLICENSED`，v0.0.1，只能 `dsh plugin add file:...` 安装 |
| 宿主依赖 | peer `>=0.1.5-rc <2`，范围很宽。但 README 说插件自带的 `node_modules` 才是实际运行时用的版本（`README.md:176`），lockfile 锁的是 0.1.5-rc.2，**也就是在 0.2.0 宿主上会跑 0.1.5 版的 BasicCompactionEngine 子类** | peer 精确锁 0.2.0-rc.2，跟着 agent-teams 0.1.23 的支持范围走（`package.json` peerDependencies；设计 §0-2） |
| 侵入性 | 附带 `scripts/patch-token-meter.mjs`，要直接改宿主的 token-meter 文件，每次升级 dsh 后都要重跑 | 不改宿主，也不改 agent-teams |

### 1.5 文档

- smart-compact：中英双语 README（205 / 195 行），CHANGELOG 每个版本都写了事故背景和验证数字。但 cordis.patch.yml 里写的「web profile 上 compaction-basic 已禁用，所以互斥没问题」，在 0.2.0 的 preset 结构下已经不成立（`cordis.patch.yml` 头部注释）。
- token-budget：设计文档 444 行，证据分了等级，做得很扎实（`docs/design/plugin-design.md`），另有临时记录 1020 行和大量调研。README 兼容性表写「DSH 宿主源码基线 `d7432673`（`0.2.1-alpha.2`）」（`README.md:63`），而 peer 锁 0.2.0-rc.2（`package.json:62-71`）。设计对此有说明：0.2.1-alpha.2 是**取证用的源码基线**（设计:17），运行与 PoC 的宿主是 0.2.0-rc.2，0.2.1-alpha.2 不在 agent-teams 支持范围内（设计:21-24、:375）。所以三处**并不矛盾**。剩下的只是措辞：README 那张表没有「运行宿主 0.2.0-rc.2」这一行，读者容易把源码基线误当成支持版本（轻微，见 §4.2-B10）。另外没有 CHANGELOG。

### 1.6 已知缺陷（本次读代码 / 实测发现）

**smart-compact**

- **A1（严重）提醒在真实宿主上从来到不了模型，而计数器显示「已送达」。** `appendTo` 只认 `assembled.system` 或 `assembled.developer` 字符串字段（`src/reminder.ts:106-110`）。但 0.1.5-rc.2 和 0.2.0-rc.2 的 `system-prompt/assemble` 组装对象结构都是 `{sections, contexts, tools, variables}`，没有这两个字段（smart-compact 自带依赖 `node_modules/@deepseek-ai/dsh-system-prompt/lib/index.js:338-351`；0.2.0-rc.2 同文件 `:338-355`）。结果就是首次说明、25/50/75% 提醒、grace 提醒全部退化成写日志（`:164-171`）。同时 `observe({kind:'briefed'|'tier'|'grace'})` 在追加文本**之前**就已经计数（`:131-135`、`:141`、`:157`），所以 `engine-state.json` 的 `reminderObserved` 会显示「已提醒」。**用探针脚本复现过【实测】**：`/workspace/work/reports/evidence/01-smart-compact-reminder-probe.ts`，输出 `changed=false`、`obs=[briefed,tier,tier,tier,grace]`，外加一条 warn。
- **A2（严重，推断）在 0.2.0 web preset 下，自动换窗可能被 preset 自带的 compaction-basic 抢先。** smart-compact 的引擎在宿主层 provide；preset 在 `isolate:{compaction:true}` 组里还有自己的 compaction-basic（B 设计 §3.2，引用 `web-app/cordis.patch.yml:527-528`、`standard.patch.yml:66-71`）。basic 的 pre-step 监听不按 agent 过滤（basic `lib/index.js:839`），默认阈值 0.8（`:15`），还会被 `W−O−headroom` 进一步压低（`:130-132`），比 smart-compact 的 0.85（`src/config.ts:27,38`）更早触发。也就是说，自动换窗大概率先变成一次 LLM 摘要，smart-compact 的零模型模板只能在手动 `/smart-compact`、`new_context` 或 preset 没装压缩的会话里起作用。需要在真实宿主上确认一次。
- **A3**：`ctx_history` 用的是已弃用的 `snapshotEvents()`（`src/history.ts:40-47`）；文本提取依赖 `dsh-session-query`，在 0.2.0-rc.2 上读不到工具结果（见 §1.2，3 个用例失败）。
- **A4**：笔记按 sessionId 存（`src/index.ts:306-307`）。团队成员被重派或重生后会换新会话，笔记就接不上；也没有团队共享层。
- **A5（小）**：分档提醒按会话记一次（`src/reminder.ts:136-146`），换窗后不会重置，第二个窗口起不再有 25/50/75% 提醒（不过 A1 修好之前这点无关紧要）；`retainRatio` 从原始配置读取，却没写进 schema（`src/config.ts:24-31` 对比 `:42`）。

**token-budget**

逐条对照设计后分两类。完整清单与处理建议见 §4.2。

*已定取舍（设计已写明并经用户确认，不算缺陷）*

- **B2 → 已定取舍：45% 走 overflow 分支的 LLM 摘要，只保留最后一个节点及其配对。** 这是方案 D1：设计:165-168 写明范围选择与 `retain = 0` 的真实含义，设计:173 写明「v1 采用 D1（用户已确认，2026-10-14）」，并给出不保留最近原文的理由（任务契约在 `team.json`，hint 带任务 id 与标题，`history` 工具可回读原文）；决议表见设计:410。摘要提示词要求「不提压缩」这一点，设计:279 与记录:393 已经知晓，所以由插件观察事件、用笔记补足。v1 不拦截摘要是 §7-10 的决议（设计:412、:425-429）。成本口径更正：摘要请求复用会话自身的 system、tools 和前缀消息，大部分输入会命中 KV cache（basic `lib/index.js:890-892`；设计:374、:427；本机 cc 路由实测 406 条 assistant 消息中 402 条 `cacheReadTokens > 0`，记录:964）。所以 45% 比 80% 更频繁，主要多出来的是**输出 token 和等待摘要生成的时间**，未命中缓存的尾段输入是次要部分。用户 2026-10-14 追加的修订（笔记新鲜时用模板、零模型调用）见 `04-handoff-design.md`。
- **B5（前半）→ 已定取舍：队长的 fork 后代按非团队处理。** 设计:252「v1 不复刻祖先链，只认精确 id」，影响面列入 PoC-3（设计:387）。代码一致（`src/team/identity.ts:5-6`）。
- **「约 45%」在小窗口路由上偏差、`context_remaining` 的压缩点是估算 → 已知并已在设计中标注。** 设计:175 写明 `W − O − headroomTokens` 可能先于 45% 生效；设计:289、:295 写明 `estimatedTrigger` 是镜像估算，返回里标 `estimated: true`。

*仍待处理（设计未覆盖，或代码与设计不符）*

- **B1（中，代码与设计不符）`inject` 少声明服务。** 设计:101 要求 `inject` 含 `agentPresets`、`sessions`、`sessionPersistence`；代码只有 `['systemPrompt','tools','tokenMeter','sessionProjections','agents']`（`src/index.ts:38`），却在运行时 `ctx.get` 取 `agentPresets`（`src/budget/compact.ts:43`）、`sessionPersistence`（`src/index.ts:154`）。`llm`（`src/index.ts:219`，供 §7-3 笔记合并的 `ctx.llm.stream()`，设计:414）**设计和代码都没声明**，属设计未覆盖。后果：插件不等这些服务就绪；拿不到引擎时会打 warn，并把该窗口标成「已尝试」（`src/index.ts:181-185`），本窗口不再主动压缩。
- **B3（小，设计未覆盖）失败后同窗口不重试。** `CompactionGate` 每窗口只尝试一次（`src/budget/compact.ts:17-39`，`src/index.ts:179,183,187`），取不到引擎也计为已尝试。设计 §2.4 没有写失败重试策略；设计:161 说宿主 80% 自动压缩保留作兜底，所以后果是退回 80%，不会卡死。
- **B4（低优先级，性能；代码偏离设计）非团队身份的否定缓存只有 5 秒。** 设计:254 写的是「在 `agent/created` 时解析一次并缓存，由 `agent-teams/*` 事件失效」。实际代码是按需解析，「不是团队」的结果只缓存 5 秒（`src/team/directory.ts:31,39-52`）。
  - **触发条件**：普通会话调用 `identityOf` 时，距上次判定已超过 5 秒。调用点在 prompt section 的 `text()`、pre-step 和工具过滤（`src/index.ts:84,106,141,156,165,175`）。这时会同步 `readdirSync` 一次 `.agent-teams/`，并逐个 `readFileSync` 加 `JSON.parse` 读 `team.json`（`src/team/team-file.ts:94,105-121`）。
  - **不是定时轮询**：会话空闲时不扫描。工作区没有 `.agent-teams/` 时只有一次 ENOENT，代价可以忽略。只有工作区存在多个团队、并且有长跑的普通会话时，才会在每一步多出几次小文件同步读。
  - **偏离有正当理由**：宿主 0.2.0-rc.2 不写 `agent-teams/*` 事件（设计:414）；成员在 `agent/created` 时可能还没写进 `team.json`（设计:263）。
  - **建议**：更新设计:254 的文字。可选的优化是改为按 `stateRoot` 目录的 mtime 失效，或在首次判定为非团队并超过一定时长后停止重查。

- **B5（后半，文档未落实）`allow` 型工具策略会裁掉本插件工具。** 设计:372 要求「文档必须提示：用 `allow` 策略时把这三个名字加进去」，`README.md` 里没有这条提示。
- **B6（验证缺口）核心路径没有接线或集成测试，PoC-2 到 PoC-9 未做。** PoC 清单在设计:379-393，属于已规划但未执行。`index.ts` 的接线、45% pre-step 路径、`serviceFor` 取引擎都没有测试，这一点设计没有覆盖。仓库只有 1 个提交，尚未发布。
- **B7（小，代码与设计不符）history 读取的 flush 与回退。** 设计:353 写「`ctx.sessions.flush(session)` 后只读分页；persistence 不可用时退到 `sessionQuery.readSession`」。代码用的是 `persistence.flush()`（`src/history/source.ts:32`），这一做法已在 0.2.0-rc.2 上做过 PoC（设计:365）。但代码**没有** `sessionQuery` 回退，persistence 缺失时直接报错（`src/history/source.ts:30`）。
- **B8（发布）** `private`、`UNLICENSED`，README「许可：待定」，没有 CHANGELOG。设计没有覆盖发布形态。
- **B9（设计文档自身需同步）** D1 取代方案 A 之后，设计里有几处旧文字没有更新：设计:177「`compactAtRatio` … 不驱动压缩」（D1 下它驱动压缩，`src/index.ts:177`）；设计:381 PoC 前置「把 `thresholdRatio` 设为 0.45」；设计:421「直接调自动压缩函数 → 不可行」（已被设计:143 的更正取代）；设计:385 PoC-1 的 inject 列表与设计:101 不一致；设计:141「没有不做摘要直接换窗的路径」不完全准确。勘误建议汇总在 `04-handoff-design.md` §5。
- **B10（轻微，文档措辞）** README 兼容性表只列「源码基线 0.2.1-alpha.2」（`README.md:63`），建议补一行「运行宿主 0.2.0-rc.2（跟随 agent-teams 0.1.23 的 supportedHosts，设计:24）」。这不是版本矛盾，见 §1.5。

### 1.7 评分表（1–5 分，以「agent-teams 0.1.23 + dsh 0.2.0-rc.2」为目标环境打分）

| 维度 | smart-compact | token-budget | 说明 |
|---|:-:|:-:|---|
| 功能广度（不看场景） | **5** | 4 | A 多了零模型换窗、new_context、命令和按钮、运行状态文件、脱敏 |
| 团队场景契合度 | 1 | **5** | A 完全不知道有团队 |
| 与目标宿主的 API 适配 | 2 | **4** | A1/A2/A3 对 B1 |
| 单测数量与质量 | **5** | 3 | 123 个对 32 个；A 的提醒测试结构不真实，B 没有接线测试 |
| 真实宿主验证 | 3 | 2 | A 验证得多，但都在 0.1.5；B 在 0.2.0 上只验证了外围 |
| 发布 / 安装成熟度 | **5** | 2 | npm 公开包 + BSD 对 private + UNLICENSED |
| 文档 | 4 | 4 | A 偏用户文档，B 偏设计取证；两边都有过时或不一致的地方 |
| 已知缺陷严重度（分越高越好） | 2 | 4 | A1 是「看起来在工作，实际没生效」，最危险；B2 改为已定取舍后，B 剩下的都是中小问题（§4.2） |
| **在目标环境下的加权结论** | **3.0** | **3.7** | 加权和 ÷ 10，适配和场景契合各占双倍权重 |

注：初版写的是 A ≈2.6、B ≈3.6。按表中各分和「两项双倍权重」的口径重新计算，A 为 30/10 = 3.0。初版 2.6 无法由表中分数复现，这里改用可复现的数值。B 因缺陷项由 3 调为 4，变为 37/10 = 3.7。结论不变：B 明显领先。

---

## 2. 能否同时安装：冲突分析

**结论：技术上能同时装、能同时运行，不会报错也不会卡死；但功能上会互相干扰，不建议同时装。**

| 冲突点 | 结论 | 证据 |
|---|---|---|
| **compaction 服务槽** | **不冲突**。A 在宿主层 `new RolloverCompactionEngine()` 时 provide `compaction`，被占用就降级成只有工具（A `src/index.ts:73-135`）。web profile 的宿主层 compaction-basic 已禁用，所以 A 能拿到宿主层的槽。B 不 provide，只通过 `agentPresets.serviceFor(agent,'compaction')` 取，而 `serviceForAgent` 只返回 **preset 挂载 fiber 内**的实现（`dsh-agent-preset-registry/lib/index.js:177-188` 的 `withinFiber(impl.fiber, mount.fiber)`）。⇒ **B 的 45% 压缩永远调不到 A 的 Rollover 引擎，调的是 preset 自己的 LLM 摘要引擎。** 两边不抢同一个槽，但也就意味着两边没法协作 | 见左 |
| **两个阈值：45% 和 85%** | 团队会话里 B 先在 45% 触发 overflow 压缩（B `src/index.ts:177,189`），压完占用大幅下降，A 的 85% 和 preset 的 80% 都不会再被触到。⇒ **团队会话里 A 的自动换窗形同虚设**，A 的零模型模板永远用不上。普通会话不受 B 影响，但 A 仍可能被 preset 的 80% 抢先（A2） | A `src/rollover.ts:500-507`；basic `lib/index.js:15,839` |
| **pre-step 执行顺序** | 两个插件都在宿主层 `ctx.on('agent/pre-step', …, next)` 串行注册（A 继承 basic 的注册，basic `lib/index.js:839`；B `src/index.ts:172`），顺序取决于 profile 的加载顺序。**无论谁先执行，结果都一样**：先执行的那个压缩后，后面的会重新测量（A `src/rollover.ts:494`；B `src/budget/usage.ts:24-33`），发现低于阈值就跳过。两边都是 await 串行，不会并发压缩；pressure 路径另有 `assertNoActiveCompaction` 保护（basic `lib/index.js:937`；overflow 路径没有这道检查，靠串行执行保证不并发）。**不会重复压缩，也不会死锁** | 见左 |
| **工具名冲突** | 没有重名。A：`get_context_remaining / ctx_notes / ctx_history / new_context`；B：`context_remaining / team_notes / history_list_windows / history_list_items / history_read_item / history_search_contents`，能正常注册 | A `src/index.ts:268-391`；B `src/budget/tool.ts`、`src/notes/tool.ts:14`、`src/history/tools.ts` |
| **两套 notes / history / remaining 让模型困惑** | **严重**。团队成员的工具目录里会**多出 10 个**功能重叠的工具：<br>① 两个 remaining 的分母不同：A 是 W−P（离窗口满还剩多少），B 是 0.45W−P（离压缩还剩多少），同一时刻返回的数字可能差几十万 token；<br>② B 的提示叫模型写 `team_notes`（B `src/budget/reminder.ts:69`），而 A 的换窗锚点检查的是 `ctx_notes`（A `src/rollover.ts:221-230`），写了 team_notes 的成员一旦被 A 换窗，锚点会说「this session has no ctx_notes yet」，把模型引到 ctx_history 去重建；<br>③ `ctx_history` 和 `history_*` 是同一件事的两种实现，前者在 0.2.0 上还读不到工具结果（A3）| 见左 |
| **窗口编号** | 两边都从日志重放计数：A 数 `compaction/summary`（A `src/rollover.ts:61-64`），B 数成功的 `compaction/end`（B `src/window/counter.ts:31-47`），都会把对方的压缩算进去，编号一致，不冲突 | 见左 |
| **prompt 注入** | A 的提醒在 0.2.0 上是空操作（A1），不会污染 B 的 runtime context；B 用 `systemPrompt.context` 和 `section`，与 A 互不影响 | 见左 |
| **成员会话** | 两边都会作用到成员会话：A 是因为 basic 的 pre-step 不过滤 agent，且成员会继承宿主层工具和 section（任务给定的结论）；B 按 `team.json` 只认团队会话 | — |

**如果一定要两个都装**，至少要：把 A 的 `auto` 设为 false，或把阈值调到不可能触发；在 profile 里禁用 A 的工具（成员会话用 `restrict` 拒绝 `ctx_*` / `get_context_remaining` / `new_context`）。这样 A 就只剩下 `/smart-compact` 手动按钮。还要接受手动换窗时锚点指向 `ctx_notes` 的问题。代价和收益不成比例。

---

## 3. 「只选一个」：明确建议

### 3.1 结论

**以 dsh-token-budget（make-the-plugin）为底座，从 smart-compact 移植「零模型交接模板」一组模块；smart-compact 本身不安装。**

理由：

1. 目标场景是 agent-teams 0.1.23 + dsh 0.2.0-rc.2。B 的底层（团队身份解析、runtime-context 通道、persistence 只读 history、preset 内引擎通道）在这个宿主上都是对的。A 在这个宿主上提醒失效（A1）、history 退化（A3）、自动换窗可能被抢先（A2）。
2. 如果反过来以 A 为底，需要补的东西包括：团队身份解析、共享笔记、重写提醒通道、重写 history、把「宿主层 provide 引擎」改成「preset 内挂钩」。这些加起来**就是 B 的全部代码**，等于在 A 上重写一遍 B，而 A 的引擎子类和按钮都要推翻。
3. A 真正领先 B 的只有一块：零模型的 `summarize` 模板，加上它的诚实性设计（笔记存在性、新鲜度、脱敏、最坏情况估价）。这一块可以完整移植，大约 300 行。

### 3.2 移植清单（从 A 搬到 B）

| # | 移植内容（A 的源） | 在 B 里的落点（新建 / 修改） | 改造要点 | 估计 |
|---|---|---|---|---|
| 1 | 交接模板：`src/rollover.ts:71-270`（`buildHandoffCheckpoint` / `deriveHandoffContext` / `deriveNotesFreshness` / `deriveRecentActivity` / `handoffCheckpointWorstCaseText`） | 新建 `src/handoff/template.ts` | 措辞从 `ctx_notes/ctx_history` 改成 `team_notes/history_*`；`Task:` 不再取 `session/title`，改用 `team.json` 里的任务 id、标题和契约要点（B 的 hint 已经有这份数据，`src/prompt/hint.ts`）；新鲜度改用 `NotesStore` 的 `mtimeMs`（B `src/notes/store.ts:18,69`）对比事件时间 | 1 天 |
| 2 | 脱敏：`src/redact.ts`（76 行）+ `tests/redact.test.ts` | 新建 `src/handoff/redact.ts` | 原样搬过来，测试从 vitest 改写成 node:test | 0.25 天 |
| 3 | 零模型 summarize（A 的思路见 `src/rollover.ts:376-423`），**机制改成挂钩**，不再继承基类 | 新建 `src/handoff/hook.ts`，修改 `src/index.ts`、`src/budget/compact.ts` | 用 `serviceFor(agent,'compaction')` 拿到 preset 引擎后，把实例上的 `summarize` 包一层，**只对团队会话**返回模板，其他会话照常走原逻辑。`summarize()` 是 basic 公开的唯一定制钩子（basic `lib/index.js:796,893`），并通过 `this.summarize` 动态派发（`:1016`），所以实例级覆写会生效。钩子收到的 agent 就是 `compactRegion` 的调用方（`:971-972,478,587`）。团队判定用 `WeakSet<agent>`；笔记新鲜时返回模板，缺失或过期时调原方法（用户 2026-10-14 确认，见 `04-handoff-design.md`）。preset 引擎是共享的：包装要幂等（用 symbol 标记），dispose 时还原。开关形态在 07 里只是建议（`handoff: hybrid/template/llm`，默认 hybrid），需写进设计 §7-10。要保持「模板必须严格小于被隐藏内容」这条事务约束，参照 A 的 worst-case 定价 | 1–1.5 天 |
| 4 | `new_context`：`src/new-context.ts` 加 `src/rollover.ts:442-490` 的「不被悄悄吞掉」语义 | 新建 `src/budget/new-context.ts` | 只对团队会话注册；在 B 的 pre-step 里消费请求，调 `compactIfNeeded(agent,'context-overflow')`；压缩没真正提交前请求一直保留 | 0.5 天 |
| 5 | 运行状态文件：`src/index.ts:173-265` 的 `engine-state.json` 模式 | 新建 `src/ops/state.ts` | 记录压缩尝试 / 成功 / 失败原因、提示档位命中次数、取不到引擎的次数；**计数放在真正送达之后**（不要重犯 A1） | 0.5 天 |
| 6 | 同时修 B 自身（只修 §4.2「仍待处理」里的条目）：B1 按设计:101 补全 `inject`，并把 `llm` 一并补进设计与代码；或者明确用可选依赖，拿不到时不标记窗口；B3 失败后按步数退避重试；B4 把「不是团队」的缓存改成按事件失效、TTL 拉长，同时更新设计:254 | `src/index.ts:38`、`src/budget/compact.ts`、`src/team/directory.ts` | — | 0.5 天 |
| 7 | 集成测试：参照 A `tests/engine.test.ts` 的做法，用**真实的** 0.2.0-rc.2 `BasicCompactionEngine` 加假 ctx，验证「45% → 挂钩后的 summarize → 不调用模型（`streamCalls==0`）→ 模板写入」 | 新建 `test/handoff/*.test.ts` | — | 0.5–1 天 |
| — | **小计（核心）** | | | **约 4–5 人日** |
| 可选 | `/smart-compact` 命令 + 输入框按钮：`src/command.ts`（235 行）、`src/state.ts`（221 行）、`src/client/*`（约 400 行） | `src/command/*`、client | 改成只对团队会话可用的 `/team-compact`；客户端 inject 要按 0.2.0-rc.2 重新核对 | 2 天，建议放到 v2 之后 |

**不要移植的**：A 的宿主层 `RolloverCompactionEngine` 子类和 provide 抢槽（在 preset 结构下没用，还和 B 的通道冲突）；`system-prompt/assemble` 提醒（A1）；基于 `snapshotEvents` 的 `ctx_history`（A3）；按会话存的 `ctx_notes`（A4）；`patch-token-meter.mjs`（要改宿主文件，不符合 B「不改 DSH」的边界，设计 §1.1）。

### 3.3 落地前必须先做的 PoC（按顺序）

1. B 设计里的 PoC-2（成员会话能看到宿主层 section/context）、PoC-9（45% 触发点）和 D1 路径的真实运行（设计:386、:393）。这些在当前 v0.0.1 都还没证实。
2. 移植 #3 之后：确认 `serviceFor` 拿到的实例被包装后，45% 主动压缩和 preset 自带的 80% pressure 路径都走到钩子；团队会话在笔记新鲜时得到模板，非团队会话、以及笔记缺失或过期的团队会话仍然调 LLM（待验证项见 `04-handoff-design.md` §6）。

---

## 4. make-the-plugin 当前设计：值得保留的独特点与明显问题

### 4.1 值得保留（smart-compact 没有，也做不到）

1. **团队作用域**：按 `team.json` 精确识别队长和成员（`src/team/identity.ts:31-75`），解析失败一律按非团队处理、不让组装崩溃（`src/index.ts:89-94`）；非团队会话完全不受影响。
2. **共享 `workspace.md` 加成员笔记两层结构**：存在工作区 `.agent-teams/.context/notes/`，避开了 agent-teams 质量闸门的扫描范围，归档也不会把它搬走（设计 §4.2.1 的论证）；按**成员名**而不是 sessionId 做键，成员重生后笔记还能接上；读写权限是「读全团队，只写自己的和 workspace.md」（`src/notes/tool.ts:65-70`）。
3. **任务完成时合并笔记**：通过观察 `agent_teams_*` 工具返回、对比快照来判断任务完成，绕开了宿主不写 `agent-teams/*` 事件的问题（`src/index.ts:245-283`）；同一工作区串行排队；截断的结果当作失败、不写回（`:232-235`）。默认关闭，模型由用户自选。
4. **缓存友好的注入策略**：稳定的指针放 system section，只在首次非空时冻结（`FrozenText`）；会变的内容放 runtime context，并量化到只在跨档或换窗时变化（设计 §3.3、§7-1）。这一点比 A 的 waterfall 改写方案正确。
5. **非弃用的 history 读取**：persistence 只读句柄，加 `inheritedEventCount` 边界，成员读不到队长继承过来的上下文（`src/history/source.ts:4-6`）。
6. **设置页**：数值即时生效，模型来自目录下拉，已在真实 0.2.0-rc.2 上验证过。
7. **证据分级的设计文档**：每个结论都带源码锚点，PoC 清单可证伪。

### 4.2 问题清单：逐条对照设计

**已定取舍**（设计已写明并经用户确认；本报告初版曾列为问题，现撤回）

| # | 初版说法 | 对应的设计决定 | 现状 |
|---|---|---|---|
| 1 | 45% 用 LLM 摘要、不保留原文，是「最大的问题」（B2） | §2.4 D1：overflow 分支只留最后一个节点及其配对，用户 2026-10-14 确认（设计:165-173、:410） | 已定。用户 2026-10-14 追加修订：笔记新鲜时改走模板，「原文不保留」不变，见 `04-handoff-design.md` |
| 2 | v1 不拦截摘要 | §7-10「v1 不拦截」（设计:412、:425-429） | 已定。04 给出对 §7-10 的修订建议 |
| 3 | 「贵」：每次换窗多付一次摘要调用 | 设计:427 已写明输入大部分命中前缀缓存 | 更正：多出来的主要是输出 token 和等待时间（见 §1.6-B2） |
| 4 | README 与 package.json 的宿主版本「三处矛盾」 | §0：0.2.1-alpha.2 是取证源码基线，运行宿主是 0.2.0-rc.2（设计:17、:21-24） | 不矛盾，只剩措辞建议（B10） |
| 5 | fork 后代不认作团队成员 | 设计:252 v1 只认精确 id，PoC-3 确认影响面 | 已定 |
| 6 | 「约 45%」在小窗口上不准；`estimatedTrigger` 是估算 | 设计:175、:289、:295 已标注 | 已知并已标注 |

**仍待处理**（设计未覆盖，或代码与设计不符；均已读 `src/` 核实）

| # | 条目 | 类型 | 证据 |
|---|---|---|---|
| 1 | `inject` 缺 `agentPresets`/`sessions`/`sessionPersistence`；`llm` 设计和代码都没声明（B1） | 代码≠设计 + 设计未覆盖 | `src/index.ts:38`、`:154`、`:219`；`src/budget/compact.ts:43`；设计:101、:414 |
| 2 | 核心路径没有接线或集成测试；PoC-2 到 PoC-9 未做（B6） | 验证缺口 | 设计:379-393；`test/` 下没有 pre-step 或 `serviceFor` 用例 |
| 3 | 压缩失败、取不到引擎都按「已尝试」处理，同窗口不重试（B3） | 设计未覆盖 | `src/index.ts:179-187`；`src/budget/compact.ts:17-39`；兜底见设计:161 |
| 4 | （低）非团队身份只缓存 5 秒，超时后按需同步重扫（B4） | 代码偏离设计:254（有理由），代价很小但设计没有覆盖 | `src/team/directory.ts:31,39-52`；`src/team/team-file.ts:94,105-121` |
| 5 | README 没有提示 `allow` 型工具策略要放行三个工具名 | 设计要求未落实 | 设计:372；`README.md` |
| 6 | history 没有 `sessionQuery` 回退 | 代码≠设计（小） | 设计:353；`src/history/source.ts:30` |
| 7 | 发布形态：private、UNLICENSED、1 个提交、没有 CHANGELOG | 设计未覆盖 | `package.json`；`README.md`「许可：待定」 |
| 8 | 设计文档里 D1 之前的旧文字未同步（设计:141、:177、:381、:385、:421） | 文档勘误 | 汇总于 `04-handoff-design.md` §5 |
| 9 | README 兼容性表缺「运行宿主 0.2.0-rc.2」一行 | 文档措辞（轻微） | `README.md:63`；设计:24 |

---

## 附：本次实测记录

| 操作 | 结果 |
|---|---|
| `hoyyang_dsh-smart-compact`：`npm ci` + `vitest run` | 122/123；`notes.test.ts:66` 在沙箱 `/proc` 下 5s 超时，属环境问题；`tsc --noEmit` 通过 |
| smart-compact 的临时副本 `/tmp/sc2`：宿主包换成 0.2.0-rc.2（pnpm，关闭 strict peers）后重跑 | 119/123；新增失败的 3 个都在 `tests/history.test.ts`（工具结果文本提取为空）。直接用 npm 装会报 `Cannot read properties of undefined (reading 'spec')`，所以改用 pnpm |
| `Todo56565_make-the-plugin`：`pnpm install --frozen-lockfile` + `pnpm test` + `pnpm typecheck` + `pnpm build` | 32/32，typecheck 通过，build 成功，`import('./lib/index.js')` 导出 `Config/apply/inject/name` |
| A1 探针 | `/workspace/work/reports/evidence/01-smart-compact-reminder-probe.ts`：喂入真实组装结构 `{sections,contexts,tools,variables}` 后，`changed=false`，但计数 `[briefed,tier,tier,tier,grace]` 全部记上 |
| 未做 | 没有在真实 DSH 宿主上跑团队会话（需要模型 API key 和交互），所以 A2 和 B 的 D1 路径仍是【推断】 |
