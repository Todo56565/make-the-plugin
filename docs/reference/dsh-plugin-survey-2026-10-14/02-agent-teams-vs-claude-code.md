# dsh-agent-teams v0.1.23 是否需要继续向 Claude Code Agent Teams 看齐？

> 评估对象：`@nanmicoder/dsh-agent-teams@0.1.23`（源码 `/workspace/work/NanmiCoder_dsh-agent-teams`，以下路径均相对此目录）
> 对照：Claude Code 官方文档 <https://code.claude.com/docs/en/agent-teams>、<https://code.claude.com/docs/en/cross-session-messaging>（2026-10-14 抓取）；教学实现 `/workspace/work/shareAI-lab_learn-claude-code/s13_agent_teams`（README.zh.md、code.py）及 s06/s08/s10。
> 说明：hooks / sub-agents 页面未单独抓取，TeammateIdle / TaskCreated / TaskCompleted 的语义取自 agent-teams 页 “Enforce quality gates with hooks” 一节。
> 2026-10-15 修订：已按用户仓库 `Todo56565_make-the-plugin/docs/design/plugin-design.md`（下称「设计」，引用写 `设计:行`）对齐。用户的既定路线是：**不改 agent-teams 源码，以独立补丁插件 dsh-token-budget 增强上下文**（设计:33-40）；不写 `team.json`（设计:52）；主会话不查看子会话预算（设计:43）；不记录「任务是否经过压缩」（设计:403）。因此本报告中需要改 agent-teams 源码的建议，一律标为**上游建议**（提给 agent-teams 作者）；用户自己能落地的部分只限补丁插件能做到的范围。

## 0. 结论先行

**不需要“继续全面看齐”。** dsh-agent-teams 在任务模型、审批、质量门禁、attempt 能力令牌、冷恢复、模型路由、可视化上已经明显强于 Claude Code（以下简称 CC）的实验性 Agent Teams；CC 本身在恢复、任务状态滞后、关机等方面写明了“已知限制”。照抄 CC 的形态（成员自批计划、关机由成员同意、无恢复、外部 shell hook）反而会削弱 dsh 的确定性。

**看齐到什么程度：只补“人机交互面”的三个缺口，不补“协议形态”。**
1. **P0（上游建议）** 用户直接与成员对话：先验证宿主行为并给出受控通道（消息记账到邮箱、对 captain 可见、不绕过 attempt）。补丁插件做不了：邮箱和 `team.json` 由 agent-teams 在进程内锁下原子重写，外部写入会竞态（设计:52、:340）。
2. **P1** 成员上下文压缩/换窗后的“当前任务 + attempt_id”重注入（现在依赖模型自己调 `claim_task` 取回）。**用户已决定由 dsh-token-budget 承担**：按窗口刷新的 hint 带任务 id 与标题（设计:325、:415），换窗时的交接模板带从磁盘读出的 attempt_id（`04-handoff-design.md` §4.1）。agent-teams 侧只剩一句成员规则和验证用例，属上游建议。
3. **P1（上游建议）** 可选的任务级 git worktree 隔离（CC 本身没有为队友做这件事，这是超越而非看齐；dsh 已在质量门禁文档里把它列为后续项）。
其余（广播、关机握手、成员级计划审批、用户可配 hook、跨会话消息、tmux 分屏）为 P2 或不做。

## 1. 能力矩阵

图例：**有** = 已有且不弱于 CC；**部分** = 有替代或不完整；**缺失** = 无。

| # | 能力 | CC Agent Teams（官方文档） | dsh 状态 | dsh 当前做法与证据 |
|---|---|---|---|---|
| 1 | 启动与审批 | 设 `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` 后，Claude 用带 `name` 的 Agent 调用即启动队友，“doesn't ask you to confirm the launch”；甚至可能在用户没要求时自发组队 | **有（更强）** | 两阶段协议：`agent_teams_create(approval="required")` 只落盘 staged 草案，不建子会话、不领任务；用户在 Web 计划编辑器里改成员/模型/依赖后点「确认并启动团队」才 spawn（`src/command.ts:69`，`src/index.ts:180-184`，`src/tools.ts:119,305,602-607`，`docs/usage.md:139-147`）。`approval:"automatic"` 仅在用户明确要求时使用 |
| 2 | 成员形态与隔离 | 每个队友是独立 Claude Code 实例/独立上下文窗口；in-process 或 tmux/iTerm2 分屏 | **有** | 成员 = DSH durable 可续聊子代理 `ctx.subagents.startContinuable()`，带 persona（`src/members.ts:903-945`，`docs/usage.md:9-15`）；工具可见性按部署方 `toolPolicies` 限制（`src/tool-policies.ts`，v0.1.23 #59）。注意：这是工具可见性，不是 OS 沙箱（`docs/usage.md` 配置节）。`docs/usage.md:155` “成员仍拥有完整工具集”已被 #59 部分过时，建议改文档 |
| 3 | 任务模型 | 共享任务列表，三态 pending/in progress/completed，依赖自动解锁，文件锁防抢领；已知限制 “Task status can lag” | **有（更强）** | 六态 `pending→claimed→in_progress→completed|failed|cancelled`，转移校验 `src/state.ts:163`；依赖校验 `src/state.ts:139`；每次执行发单调 `attempt` + 唯一 `attemptId`（`src/state.ts:182-232`）；成员不得同时持有两个未完成任务（`src/tools.ts:1741`）；进程内锁 `withTeamLock`（`src/state.ts:67`）；依赖产出传给下游（`src/scheduler.ts:111-152`）；质量 kind 合同（`docs/quality-gates.md` §5–6） |
| 4 | 通信/邮箱 | 每人一个 JSON 邮箱 `~/.claude/teams/{team}/inboxes/{agent}.json`，写入成功才算发送；自动投递，无需轮询；任何队友可按名字互发 | **有** | JSONL 邮箱 `<ws>/.agent-teams/<teamId>/inbox/*.jsonl`（`docs/usage.md:27-34`）；`agent_teams_send_message` 任意成员↔成员/队长直达并唤醒，拒绝冒名 `from`，去重，返回 `live/wake/mailbox/duplicate`（`src/tools.ts:2148-2205`）；只有真正进入接收方 step 的消息才标记已读（`src/mailbox.ts:62-110`）；stale 来源 attempt 的消息被过滤（`src/mailbox.ts:13-17`） |
| 5 | idle 通知与 result 分离 | 队友停下时自动通知 lead，并“includes its final answer in the notification”；API 错误结束也通知 | **有（更结构化）** | result 走任务通道：`update_task` 写 output/verdict，并向 captain 邮箱追加报告（`src/tools.ts:2018-2025`）；idle 走 `agent/status` 事件，驱动自动续领（`src/scheduler.ts:530-551`）；宿主原生 “subagent-settled” 仅作兜底，已有成功报告时被判为冗余（`src/mailbox.ts:64-95`）；成员最终回合失败在任务已结算后记为 durable captain note（`src/members.ts:218-300`，v0.1.23 #205）。与 s13 “result 与 IDLE 是两个事件”（README.zh.md §5）一致 |
| 6 | 关机握手 | lead 发 shutdown request，队友可同意（优雅退出）或拒绝并说明理由；“Shutdown can be slow” | **部分（有意不同）** | 无“成员同意”握手；改为队长侧强制且安全的退场：`agent_teams_remove_member` 撤销 attempt、回收未完成任务、丢弃未读邮件、记录 retired id、中断活动回合、重新调度（`src/tools.ts:1392-1446`）；retired 成员的所有投递路径被拦截（`src/members.ts:1000-1017`，`src/harness-compat.ts:229-271`）；整队停止需 UI 二次确认（`src/index.ts:286-337`，`docs/usage.md:149`）；`agent_teams_delete` 归档保留 |
| 7 | 计划审批（成员级） | lead 处于 plan mode 时 spawn 的队友先只读做计划，再向 lead 发审批请求；**lead 会话自动批准，不经人审** | **部分** | 无成员级 plan mode 闸门（s13 用 `plan_gates` 在工具分发层拦 bash/write/edit，README.zh.md §12）。替代：团队级人类审批（#1）+ `requirements` 质量任务（verdict=pass 才解锁下游）+ 队长专属 `agent_teams_amend_task` 修正合同（`src/tools.ts:2067`，`docs/usage.md:58`） |
| 8 | hooks / 质量门禁 | 用户配置 `TeammateIdle` / `TaskCreated` / `TaskCompleted` hook，exit 2 阻止并回传反馈 | **有（内置，更强）；用户可配 hook 缺失** | 内置机器规则：创建校验 `validateCreateTask`（`src/quality-gates.ts:389`）、完成门禁 `evaluateQualityCompletion`（`:546`）、自动 repair+re-review（`:930`）、verdict 绑定产物字节与漂移检测（`:1101-1205`，v0.1.23 #161）、交付闸 `canDeclareDelivery`（`:1624`）、halt/resume（`:1687`）。无部署方可插拔的外部命令 hook |
| 9 | worktree 隔离 | 队友**没有** worktree 隔离；Agent 调用传 `isolation` 时“不会成为队友”；最佳实践只是“Avoid file conflicts”；worktree 是“手动并行会话”的方案 | **缺失**（CC 也没有） | 只有完成时范围审计（`inScope` vs `changedPaths`，`src/quality-gates.ts:259-388`），非写入拦截；文档明确推迟 worktree（`docs/quality-gates.md:83,807,826`）。s13 有可选任务级 worktree（README.zh.md §9–10，`code.py:489 create_worktree`） |
| 10 | 嵌套 | “No nested teams”；队友可开前台 subagent，不能开后台 | **有** | 一个队长同时一个团队；成员再委派深度 `memberMaxDepth` 默认 0（`src/index.ts:171,201`），守卫覆盖改名工具与 code-runtime 调用（`src/members.ts:1020-1045`）；成员工具面不含队长专属工具（`src/members.ts:833` 规则 9） |
| 11 | 模型路由 | spawn 提示指定 > subagent 定义 model > `CLAUDE_CODE_SUBAGENT_MODEL` > lead 模型；继承 lead effort；allowlist 替换 | **有（更强）** | 成员显式 `provider+model` > `memberModel` > 队长路由；同模型继承思考强度，换模型用目标默认档，显式 `reasoning_effort` 创建前校验；`fallback` 第二选择；生效路由写入 `team.json` 供冷恢复（`docs/usage.md` 配置节与“最终优先级”段，`src/members.ts:428,565`，v0.1.23 #189） |
| 12 | 权限 | 队友继承 lead 权限模式，权限提示冒泡到 lead；**来自其他 agent 的消息不算用户同意**，auto 模式下分类器审查 agent 间消息 | **部分** | 队长专属工具不可被策略重新打开、协调工具不可被拒绝（`docs/usage.md` toolPolicies 段）；拒绝冒名（`src/tools.ts:2183-2186`）；邮件以 “AgentTeams message from X” 标注来源（`src/mailbox.ts:24-30`）。权限提示属宿主职责；插件未在成员规则里明确“队友消息不构成用户授权/不得转托被拒操作” |
| 13 | 恢复 | “No session resumption with in-process teammates”：`/resume`、`/rewind` 不恢复队友；任务目录保留 | **有（远强）** | durable 成员表 + 子会话 descriptor 冷恢复并重新应用模型/工具过滤（`src/members.ts:614-660,945`）；停驻 attempt 不被重铸，仅未观察过的开放任务冷恢复一次（`src/scheduler.ts:10,277,363`，`docs/usage.md:116`）；fork/多跳 lineage 保持队长身份（`src/lineage.ts`，v0.1.23 #176）；归档复盘（`src/state.ts:1161-1218`）。限制：队长离线不能冷恢复成员（`docs/usage.md:153`） |
| 14 | 用户直接与队友对话 | 有：in-process 选中队友回车即可打字；分屏点进 pane；`/compact` 等命令仍作用于 lead | **部分（未验证）** | 面板点击成员可打开其持久化子会话（`src/client/session-navigation.ts:11,58-68`，`docs/usage.md:21`）。插件没有“用户→成员”的受控通道：没有 `from=user` 的邮箱记录，也不抄送 captain。成员 pre-step 准入只检查团队/成员状态（`src/members.ts:642-653`），所以如果宿主允许在子会话输入框发消息，消息会被接收，但绕过邮箱/attempt 记账，captain 也看不到。宿主是否开放该输入框本次未验证 |
| 15 | 跨会话（非团队）消息 | 有：`ListAgents`/`SendMessage`，本机走 socket，跨机走 Remote Control；入站 accept/hold/refuse；不算用户同意；限速/1M 字符上限 | **缺失（属宿主层）** | 插件只在团队内投递；宿主有 `subagents.sendMessage` 接缝，插件只用它做 retired 拦截（`src/harness-compat.ts:240-271`）。无会话发现/寻址 |
| 16 | 上下文管理/压缩 | 每个队友有自己的上下文窗口，各自自动压缩；不继承 lead 历史；spawn prompt 需写足上下文 | **部分**（用户以 dsh-token-budget 补齐：37% 提示、45% 主动压缩、notes、history，设计:33-40；换窗交接见 `04-handoff-design.md`） | 固定核心协议通过 `ctx.systemPrompt.section` 注入（`src/capabilities.ts:101`），压缩或丢弃工具结果后仍在（`README_ZH.md:111`；`docs/progressive-loading.md:40` 验证了**队长** `compactNow` 后继续）。成员压缩后的 attempt_id 恢复：`claim_task` 对自己已领任务幂等返回当前 `attempt_id`（`src/tools.ts:1741,1794-1805`），邮件也带 attempt_id（`src/mailbox.ts:30`），stale 更新被拒（`src/members.ts:267`）。但是否取回取决于模型自己调用，没有自动重注入，也没有成员侧压缩的验证记录 |
| 17 | 可视化 | 终端 agent 面板（上下键/Enter/Esc，idle 行 30s 隐藏），Ctrl+T 任务列表，tmux/iTerm2 分屏 | **有（更强）** | Web 活动面板/工作区页签：成员树、SVG 任务 DAG、模型标签、状态动画、停止按钮、历史复盘（`docs/usage.md:17-24`，`src/client/*`，v0.1.21 workspace tab） |

## 2. 差距排序（收益/成本）

### P0：用户直接与成员对话（受控通道；上游建议，补丁插件无法实现，见 §0）
- **为什么**：这是 CC 文档首段就强调的能力（“talk to any teammate directly without going through the lead”），也是 dsh 唯一一个“用户可感知、宿主可能已部分放开、但插件不记账”的缺口。不受控的直发会绕过 attempt 语义和 captain 可见性，相当于埋了一个一致性隐患。
- **做法**：
  1. 先用真实宿主（Harness 0.2.0-rc.2）验证打开的成员子会话能不能输入、输入后走哪条投递路径。成本约 0.5 天。
  2. 新增面板入口“给成员留言”（或拦截子会话输入）→ 写入成员邮箱，`from: "user"`，带当前 attempt 上下文 → 唤醒成员 → 自动抄送 captain 邮箱。成员规则加一句：用户消息视为对当前 attempt 的指导，不改变任务所有权。
  3. 在 halted/retired/staged 状态下拒绝。
- **成本**：中（1 个工具/路由 + 面板控件 + 3–5 个回归用例）。

### P1：成员压缩/换窗后的“当前任务卡片”重注入（已由 dsh-token-budget 承担）
- **为什么**：CC 不需要解决这个问题，因为它的任务状态本来就会滞后；dsh 的 attempt_id 是强约束，压缩后丢掉它就会出现 stale 拒绝或空转。现在要靠模型记得调 `claim_task`。
- **用户已定的做法**（对齐设计，取代本报告初版「改 agent-teams、每步注入动态 system section」的建议）：
  1. 落在补丁插件，不改 agent-teams（设计:36）。
  2. **按窗口刷新，不按步刷新**：hint（任务 id + 标题 + 笔记元数据）走 `systemPrompt.context` 运行时上下文，只在窗口编号变化时重算（设计:325、:415；缓存分支 B，设计:413）。system section 只放每会话固定的笔记指针（设计:324）。理由：每步都变的值放进 system section 会改写 system 头，放进 context 会每次追加一份完整快照（设计:232）；而且工具或 section 的增删会迫使开新 request series（设计:135）。
  3. **attempt_id 放进换窗交接模板**，从 `.agent-teams` 磁盘状态读，不依赖模型记忆（`04-handoff-design.md` §4.1）。
  4. 压缩是否发生**不回传**主会话（设计:403）。
- **仍可向上游提的**：成员规则 1 加一句「丢失 attempt_id 时调 claim_task 取回」；补一个成员侧 `compactNow` 的验证用例，对应 `docs/progressive-loading.md` 的队长用例。dsh-token-budget 一侧的对应验证是 PoC-8（设计:392）和 04 的 e2e 项。
- **成本**：插件侧已在实现计划内；上游侧很低。

### P1：可选任务级 worktree 隔离（超越 CC，非看齐）
- **为什么**：dsh 的 implementation 任务可以并行写文件，而范围控制只在完成时审计。按 s13 的模式（只有 Lead 能创建；绑定到 pending 任务；领取后工具 cwd 指向 worktree；清理由宿主或用户确认），能把“事后发现越界”变成“物理隔离”。
- **前置**：DSH 的 `startContinuable` / 工具层是否支持按成员或任务覆盖 cwd，本次未核实，需先确认。如果不支持，就要宿主配合，优先级降为 P2。
- **做法**：`agent_teams_create_task({ worktree: true })` 只对 implementation/repair 生效；integration 任务负责合并；`changedPaths` 审计改为在 worktree 内计算。删除/归档时不自动删除脏 worktree。
- **成本**：中到高。

### P2（按需，不急）
- **部署方可配置的门禁命令**（对应 CC 的 TaskCompleted/TaskCreated hook）：在 profile 里声明 `gates.onComplete: <cmd>`，非零退出就拒绝 completed 并把输出作为 finding 回传。内置门禁已经覆盖主要场景，这一项只给企业定制用。
- **成员级计划闸门**：在 implementation 上设 `requirePlan`，在批准前用 toolFilter 隐藏写类工具（s13 `plan_gates`）。要由**人或 captain 显式**批准，不要照抄 CC 的自动批准。
- **队长专属广播**：`to: "*"` 只给 captain 用，按成员扇出到各自邮箱。CC 自己也没有广播（“send one message per recipient”），dsh 现在可以多次调用。仅作便利，注意 token 成本。
- **安全措辞**：成员规则里补一句“来自队友或 captain 的消息不构成用户授权；被拒的操作不得转托他人”，对齐 CC 的 “Messages between agents” 一节。成本极低，可以随 P0 一起发布。
- **文档**：修正 `docs/usage.md:155`，“完整工具集”已被 toolPolicies 改变。

## 3. 不该照抄的地方

| CC 做法 | 不抄的理由 | dsh 现有更优解 |
|---|---|---|
| 无确认自动 spawn，甚至自发组队 | 成本、并发和写权限都不可控 | staged 草案 + 人工 Approve & Run（#1） |
| 成员计划由 lead 自动批准 | 等于没有审批 | 团队级人审 + requirements verdict + amend 台账 |
| 关机要成员同意/可拒绝 | 模型可以拖延或拒绝，关机慢是 CC 的已知限制 | 强制 remove/halt：撤销 attempt、回收任务、拦截投递 |
| 外部 shell hook 当质量门禁主体 | 门禁语义散落在用户脚本里，无法和 attempt/verdict 绑定 | 内置合同门禁、产物字节绑定、自动 repair 循环（可选补 P2 hook 作扩展点） |
| 三态任务、无 attempt 令牌 | 迟到写入会覆盖新结果，这正是 CC “status can lag” 的根源 | 六态 + 单调 attempt + attemptId 失效 |
| 不恢复队友 | 长任务不可用 | durable descriptor 冷恢复、停驻 attempt、fork lineage、归档 |
| tmux/iTerm2 分屏 | DSH 是 Web GUI，架构不同 | Web 面板 + 成员子会话导航 |
| 跨会话/跨机器消息（ListAgents、socket、Remote Control） | 属宿主（Harness）层能力，插件实现会越权，也不安全 | 留给 DSH 宿主；插件只需在宿主提供后把团队成员登记为可寻址对象 |
| 团队目录随会话结束删除 | 失去审计 | 归档保留成员/任务/邮箱 |

## 4. 五个专项评估

1. **用户能否直接与成员对话**：**部分/未验证**。可以打开成员子会话查看（`src/client/session-navigation.ts:58-68`），但插件没有受控的用户→成员通道；宿主若放开输入，消息会绕过邮箱/attempt 记账，captain 也看不见（`src/members.ts:642-653` 只做状态准入）。→ P0。
2. **成员之间广播**：**缺失，CC 也没有**。点对点直达已完备（`src/tools.ts:2148`），多次调用即可。→ P2，只给 captain 用。
3. **跨会话（非团队）消息**：**缺失**，属于宿主层。CC 方案依赖本机 socket、Remote Control 和入站策略，插件不应自造。→ 不做，等宿主提供。四个社区跨会话插件的评估见 `03-peer-messaging.md`。
4. **成员 worktree 隔离**：**缺失，CC 队友也没有**（`isolation` 会让调用退化为普通 subagent）。dsh 已有完成时范围审计（`src/quality-gates.ts:259-388`），worktree 被明确推迟（`docs/quality-gates.md:83,807`）。→ P1，前提是宿主支持按成员覆盖 cwd。
5. **成员上下文压缩/换窗后恢复 attempt_id**：**部分**。核心规则压缩后仍在；`claim_task` 幂等返回当前 attempt_id（`src/tools.ts:1794-1805`）；邮件带 attempt_id（`src/mailbox.ts:30`）；stale 写入被拒（`src/members.ts:267`）；冷恢复不重铸已停驻的 attempt（`src/scheduler.ts:277,363`）。缺两样：换窗后自动给出当前任务和 attempt_id，以及成员侧压缩的验证用例。→ P1，前者由 dsh-token-budget 的窗口级 hint 和交接模板承担（设计:325、:415；`04-handoff-design.md`），后者属上游建议。

## 5. 未核实/局限
- DSH 宿主是否允许在成员子会话输入框发消息，以及子代理能否按成员覆盖 cwd：均未在运行时验证，结论依赖插件源码推断。
- CC hooks、sub-agents 页面未单独抓取；hook 语义取自 agent-teams 页摘要。
- 行号以本次读取的 v0.1.23 源码为准。
