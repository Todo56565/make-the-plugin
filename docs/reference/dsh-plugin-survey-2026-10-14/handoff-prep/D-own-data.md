# D. 团队成员压缩时，交接模板实际能取到的数据（dsh-token-budget）

日期：2026-10-15
基线：插件仓库 `/workspace/work/Todo56565_make-the-plugin`（HEAD `238c52b`），agent-teams 源码 `/workspace/work/NanmiCoder_dsh-agent-teams/src`（0.1.23），compaction-basic 0.2.0-rc.2 构建产物 `/workspace/work/pk/deepseek-ai-dsh-compaction-basic-0.2.0-rc.2/package/lib/index.js`（下称 `basic`），宿主类型取自插件 `node_modules/@deepseek-ai/*`。

引用约定：
- 插件源码写相对路径，例如 `src/team/team-file.ts:71`
- agent-teams 写 `AT/文件:行`，例如 `AT/types.ts:181`
- 设计文档写 `设计:行`，指 `docs/design/plugin-design.md`
- 调研报告写 `04:行`，指 `docs/reference/dsh-plugin-survey-2026-10-14/04-handoff-design.md`
- 宿主类型写 `session.d.ts:行`，指 `node_modules/@deepseek-ai/dsh-session/lib/types/index.d.ts`；`types.d.ts:行` 指同目录的 `types.d.ts`
- 标【推断】的内容没有运行态验证

---

## 0. 结论速览

1. **summarize 被调用时能拿到的东西比 04 假设的多，也比它假设的少。** 钩子是 `async summarize(input, agent, signal)`（`basic:899`），可以异步读盘。从 `agent.id` 和 `agent.session.header.cwd` 可以同步解析出团队、成员键、任务和笔记路径。但有四项现在拿不到，或者拿不准：
   - **attempt_id**：team.json 里有，插件的 `coerceTeam` 没解析（`src/team/team-file.ts:71-80`），要扩展。
   - **新窗口编号**：summarize 运行时 `compaction/end` 还没写入，窗口投影仍是旧值（`basic:469,478,484`；`src/window/counter.ts:44`）。fork 会话还会多算继承来的压缩（`设计:275,432`）。
   - **「上一步动作」的时间**：只有已弃用、禁止新调用的 `eventAt/snapshotEvents` 能读到事件时间（`session.d.ts:177-200`，`设计:211`）。`input.messages` 里没有时间。
   - **最后一次写笔记的会话内记录**：`team_notes` 有 `onWrite` 回调，但 `index.ts` 没接（`src/notes/tool.ts:22,73,121`；`src/index.ts:139-143`）。磁盘上只剩按成员名共享的文件 mtime。
2. **「笔记新鲜」不能照抄 smart-compact 的「笔记写入后事件数 = 0」。** 写笔记本身的 `tool/result` 和压缩前刚追加的 `compaction/start`，时间都晚于 mtime。照抄的话几乎永远判定过期。建议改用会话投影，记录「最后一次成功写自己笔记」的 seq 和时间，以及之后的工作事件数，再绑定到当前 attempt（§2 方案 C）。
3. **04 §4.1 模板里，一半字段与现有 hint 或 persona 重复。** 只有 attempt_id 和新鲜度结论是新信息。「上一步动作」在 D1 下本来就以原文保留在新窗口里（`设计:169`）。
4. **主要交互风险**：
   - hint 和模板读的是两个时刻的 team.json 快照，可能互相矛盾。
   - 模板体积超限时，事务在 summarize 返回之后才拒绝（`basic:600-601`），钩子内无法退回 LLM。失败后本窗口的 45% 尝试已被 `CompactionGate` 消耗（`src/budget/compact.ts:22-28`）。
   - 最后一个节点过大时，可能连续压缩，产生「模板压模板」或「LLM 摘要压模板」。

---

## 1. 可用字段清单

### 1.0 summarize 被调用时的环境（决定「能否拿到」的前提）

| 事实 | 出处 |
|---|---|
| 签名 `async summarize(input, agent, signal)`，可返回 Promise，所以钩子内允许异步读盘 | `basic:899-903` |
| 引擎经 `this.summarize` 动态派发，对实例打补丁有效 | `basic:1013-1016` |
| 调用前已追加 `compaction/start`。`compaction/end` 在 summarize 返回并提交之后才追加 | `basic:469`、`:478`、`:482-484` |
| `input = { tools?, messages: [system 头, ...被遮蔽区间的消息] }`，消息由 `deriveEventMessage` 推出，**不带事件时间** | `basic:695-703` |
| 自动压缩（45% overflow 和 80% pressure）用 `stability: 'whole-surface'`：summarize 返回后，会话 surface 必须与开始时完全一致。读盘不影响这一点 | `basic:972-975`、`:609-611` |
| 手动 `/compact`（`compactNow`）同样走 summarize，`retain=0`，`stability: 'selected-span'` | `basic:985-1001` |
| summarize 的返回值会被套上 `CHECKPOINT_PREAMBLE`（「…without acknowledging this checkpoint」）并包进 `<summary>`，再做体积检查：框后 token 数 ≥ 被遮蔽 token 数就抛错 | `basic:280`、`:344-348`、`:596-601` |
| 插件闭包里可用的资源：`teams`（TeamDirectory）、`config`、`createStoreCache`、`ctx.tokenMeter`、`ctx.sessionProjections`、`windowOf`、`usageOf` | `src/index.ts:46,52,62-65,137` |

所以「只有 agent 对象和会话」在实践中的意思是：所有能用 `agent.id`、`agent.session.header.cwd`、`agent.session`（投影、tokenMeter、`inheritedEventCount`、`seq`）作键查到的数据都能拿到。只存在于事件时间里的数据，必须先由投影或 `session/event` 监听记录下来。

### 1.1 字段总表

「解析」列：插件现在是否已经读出该字段。「summarize 时」列：在钩子里能否拿到。

| # | 字段 | 数据源（文件:行） | 插件读法（文件:行） | 同步/异步 | 解析 | summarize 时 | 备注 |
|---|---|---|---|---|---|---|---|
| 1 | 团队 id | `AT/types.ts:357-358`（目录名即 id） | `coerceTeam` `src/team/team-file.ts:82`；身份 `src/team/identity.ts:59-75` | 同步 `readdirSync/readFileSync`（`team-file.ts:91-121`） | 是 | **能**：`teams.identityOf(agent)`，只需 `agent.id` 和 `session.header.cwd`（`src/team/directory.ts:13-16,39-53`） | 正结果在进程内永久缓存，直到 `invalidate()`（`directory.ts:42,56-58`），所以可能是旧快照 |
| 2 | 团队名 | `AT/types.ts:355-356` | `team-file.ts:83` | 同上 | 是 | 能 | 已在 hint 首行（`src/prompt/hint.ts:54`），也在 persona（`AT/members.ts:801`） |
| 3 | 团队目标 description | `AT/types.ts:360` | 未解析（`team-file.ts:63-88` 不读） | — | 否 | 扩展后能 | 已在成员 persona（system 头，跨压缩保留，`AT/members.ts:798,806`），模板不必带 |
| 4 | 成员 key：`agentKey` | 成员名 `AT/types.ts:265-266`；队长 `captain` `AT/state.ts:52` | `src/team/identity.ts:38-43` | 同步 | 是 | 能 | 队长判定只认精确 `captainSessionId`，fork 后代按非团队处理（`identity.ts:7-10`，`设计:253`） |
| 5 | 成员 key：`fileKey` | 同 `sanitizeKey` 规则 | `identity.ts:74`；`team-file.ts:44-52` | 同步 | 是 | 能 | **笔记文件名用 fileKey，不是 agentKey**（`src/notes/paths.ts:21-23`） |
| 6 | 成员角色 role / 状态 status | `AT/types.ts:268`、`:297-298` | 未解析（`team-file.ts:66-70` 只取 id、name） | — | 否 | 扩展后能 | role 已在 persona（`AT/members.ts:801`） |
| 7 | 当前任务 id | `AT/types.ts:167` | `team-file.ts:73-79` | 同步 | 是 | 能 | 选取规则见 §1.2 |
| 8 | 当前任务标题 subject | `AT/types.ts:169` | `team-file.ts:76` | 同步 | 是 | 能 | 模型代写字段，需要脱敏（`04:66`） |
| 9 | 当前任务描述 description | `AT/types.ts:171` | **未解析** | — | 否 | 扩展后能 | 契约字段在 `AT/types.ts:195-201`（objective/inScope/acceptance…），读回途径是 `claim_task` 返回的 `task_details`（`AT/tools.ts:396-405,1798-1805`）。`设计:416`（7-4）定的是 hint 只放 id 和标题，「不抄契约」见 `设计:327` |
| 10 | 当前任务状态 | `AT/types.ts:14-20,172` | `team-file.ts:77` | 同步 | 是 | 能 | 终态集合 `AT/types.ts:23` 与 `src/prompt/hint.ts:16` 一致 |
| 11 | attempt 序号 | `AT/types.ts:179-180`；+1 在 `AT/state.ts:195-198` | **未解析** | — | 否 | 扩展后能 | |
| 12 | **attempt_id** | `AT/types.ts:181-182`；生成于 `AT/state.ts:182-191`（`randomUUID`，同时 `status=claimed`、刷新 `updatedAt`）；清空于 `AT/state.ts:205-213`（取消）、`:215-227`（撤销/转交） | **未解析** | 同步读 team.json 即可。agent-teams 用 `atomicWriteText` 整文件替换（`AT/state.ts:294,703`），无锁读不会读到半截 | 否 | **扩展 `TeamTaskInfo` 和 `coerceTeam` 后能** | 写入方：调度器 `AT/scheduler.ts:385,400`；`claim_task` `AT/tools.ts:1820-1821`；队长接管 `AT/tools.ts:1708`。详见 §1.3 |
| 13 | 任务 `updatedAt` / `createdAt` | `AT/types.ts:254-255` | 未解析 | 同步 | 否 | 扩展后能 | **team.json 没有 claimedAt**。`updatedAt` 在每次状态或内容变化时都会刷新：`AT/state.ts:190,212,226`；`AT/tools.ts:1712,2001`（update_task）、`:2115`（队长 amend）；`AT/scheduler.ts:480` |
| 14 | 队长 session id | `AT/types.ts:363-364` | `team-file.ts:33,65,84` | 同步 | 是 | 能 | 队长自己压缩时 `identity.role === 'captain'`；队长通常没有「当前任务」，只有接管时才有（`AT/tools.ts:1707-1712`） |
| 15 | 自己笔记的路径 | `<stateRoot>/.context/notes/teams/<teamId>/<fileKey>.md` | `src/notes/paths.ts:16-23` | 纯计算 | 是 | 能 | `stateRoot` 用会话头 cwd（`src/team/identity.ts:29-31`） |
| 16 | 自己笔记的 mtime | fs `stat` | 异步 `NotesStore.meta` `src/notes/store.ts:65-74`；同步 `listNoteMetasSync` `src/prompt/hint.ts:19-36` | 两种都有 | 是 | 能 | 写入是先写临时文件再 `rename`（`store.ts:139-143`），mtime ≈ 写入完成时刻。**按成员名共享**：同一成员换会话、换任务后仍是同一文件（`设计:315`） |
| 17 | 自己笔记的大小（行数/字节） | 同上 | `store.ts:69`；`hint.ts:32` | 同上 | 是 | 能 | 两个函数都会把整文件读进来再计数 |
| 18 | 笔记大小上限 | `maxFileBytes` 默认 10000（`src/config.ts:107`） | `store.ts:42-49`（每次取当下值）；超限拒写 `store.ts:132-136` | 同步 | 是 | 能：`config.notesOptions.maxFileBytes` | 超限的写入被拒，mtime 不变 |
| 19 | workspace.md 路径/mtime/大小 | `src/notes/paths.ts:13` | 同 16、17 | 同上 | 是 | 能 | **写入者无法归属**：任何成员都能写（`src/notes/tool.ts:70` 允许 `shared`），notesMerge 也会写（`src/notes/merge.ts:151`）。不能拿它判断「本成员的笔记是否新鲜」 |
| 20 | 本团队其他笔记的元数据（最近 N 个） | 同上 | `store.list` `store.ts:103-114`；`listNoteMetasSync` | 两种都有 | 是 | 能 | 已在 hint（`hint.ts:66-70`） |
| 21 | 最后一次写笔记的会话内记录 | `tool/call`（name + arguments）`types.d.ts:354-360`；`tool/result`（isError）`types.d.ts:374-388` | **未记录**。`team_notes` 有 `onWrite` 钩子（`tool.ts:22,73,121`），但 `index.ts:139-143` 没传 | — | 否 | **现在拿不到**，需要新增投影或监听（§2） | |
| 22 | 窗口编号 | 投影 `tokenBudgetWindow`：成功的 `compaction/end` +1（`src/window/counter.ts:31-48`） | `windowOf` `counter.ts:51-58` | 同步 | 是 | **能，但拿到的是旧窗口 N**。新窗口是 N+1（end 还没写，`basic:484`） | fork 会话会重放继承来的压缩（`counter.ts:7`；`设计:275,432`）。history 工具的 `w<N>` 口径不同：只数 `inheritedEventCount` 之后的 `compaction/summary`（`src/history/model.ts:4,122`；`src/history/source.ts:46`）。v1 设计不向模型展示编号（`设计:276`） |
| 23 | 窗口起点时间 | 无 | 投影只存计数（`counter.ts:18-20`） | — | 否 | **拿不到**，需扩展投影（apply 能拿到 `event.time`：`types.d.ts:494-495`；投影签名 `dsh-session-projection/lib/types/index.d.ts:58`） | |
| 24 | hint 内容 | 计算：`hintText` `src/prompt/hint.ts:52-76`；缓存键 `` `${window}:${teamId}` `` `src/index.ts:119-127` | `WindowHintCache` `hint.ts:79-93`（只有 `get(agentId,key,compute)`，没有只读 getter） | 同步 | 是 | 能重算（同步、便宜）。旧窗口的 hint 文本也在 `input.messages` 的 runtime-context 快照里 | 超过 `hintMaxBytes`（默认 4000，`config.ts:108`）整条不注入（`hint.ts:75`） |
| 25 | 上一步动作（工具名） | `input.messages` 里的 assistant tool-call 块 | 无 | 同步 | — | 能拿到**被遮蔽区间里**的最后一个工具名 | D1 只保留最后一个节点及其工具配对（`设计:169`），真正最后的动作以原文留在新窗口 |
| 26 | 上一步动作（时间） | 事件 `time` | 只有 `eventAt/snapshotEvents/ownEvents`，均已弃用（`session.d.ts:177-200`；`设计:211`），或者 persistence 整读（`src/history/source.ts:29-60`，需要 flush 并整文件解码） | — | — | **不建议在 summarize 里取**；要取就用投影 | |
| 27 | 上下文占用 | `usageOf` `src/budget/usage.ts:24-33` | — | 同步 | 是 | 能 | 压缩前的值 |
| 28 | `notes` / `history` 开关 | `src/config.ts:97-98`；注册分支 `src/index.ts:136,164` | — | 同步 | 是 | 能 | 开关只在重启后生效（`src/index.ts:56`）。`notes=false` 时没有 `team_notes`，hybrid 应恒走 LLM；`history=false` 时模板不能提 history 工具 |
| 29 | `session.inheritedEventCount` / `session.seq` | `session.d.ts:121,208` | 未使用 | 同步 | — | 能 | 可用于把窗口编号修正成 history 口径（§3-1） |

### 1.2 「当前任务」应怎样选

- hint 的规则是 `assignee === agentKey && !TERMINAL`（`src/prompt/hint.ts:55`），会把 **pending 但已指派** 的排队任务也列进去。转交后的任务会以 `status=pending` 加新 assignee 的形式出现（`AT/state.ts:222-224`）。
- 成员同一时刻最多拥有一个未完成的 claimed/in_progress 任务（`AT/tools.ts:1816-1818`；规则文本 `AT/members.ts:826`）。
- 所以模板的「当前任务」应取 `assignee === agentKey && status ∈ {claimed, in_progress} && attemptId !== undefined`，最多一条。pending 的只作为「排队」信息，或者干脆不写。
- 队长：一般没有这样的任务，只有接管时才有（`AT/tools.ts:1707-1712`，接管后直接 `in_progress`）。队长压缩时，模板要么另写一版（团队未完成任务数，hint 已有：`hint.ts:59-61`），要么对队长恒走 LLM。04 没有区分这两种情况。

### 1.3 attempt_id 的可得性与必要性

- **必要**：调度器把 attempt_id 写在派工消息里（`AT/scheduler.ts:262-265`）。这是一条 user 消息，D1 压缩后会被遮蔽。persona 只说「保留 attempt_id」（`AT/members.ts:815,823`；`AT/capabilities.ts:13`），本身不含它。
- **兜底已存在**：
  - `claim_task` 对自己已认领的任务幂等，会返回同一个 attempt_id（`AT/tools.ts:1794-1805`）。
  - `update_task` 漏传 attempt_id 时，报错文本直接给出当前 id，并说明「不是撤销」（`AT/tools.ts:1947-1948`）。

  所以模板带 attempt_id 是为了省一到两次往返，不是正确性的前提。
- **安全**：attempt_id 已明文存在 team.json 和派工消息里，模板再写一次不扩大暴露面。脱敏不要碰它。smart-compact 的规则只覆盖手机号、邮箱、证件号、企业名（`/workspace/work/hoyyang_dsh-smart-compact/src/redact.ts:43-52`），不会误伤 UUID。
- **时效**：summarize 时应**绕过 TeamDirectory 缓存重读** team.json（`teams.forget(agent.id)` 后再 `identityOf`，`src/team/directory.ts:61-63`）。原因是调度器派工时直接写 team.json（`AT/scheduler.ts:385,400`），不经过任何 `agent_teams_*` 工具调用，身份缓存不会失效（`src/index.ts:75-78`）。

---

## 2. 「笔记新鲜」的可行定义

### 2.1 现有可复用的时间戳和信号

| 信号 | 位置 | 有什么 | 缺什么 |
|---|---|---|---|
| 笔记 mtime | `src/notes/store.ts:18,69`；`src/prompt/hint.ts:32` | 文件最后写入时刻（毫秒） | 不区分会话、不区分任务（按成员名共享，`设计:315`）。成员绕开 `team_notes`、用通用 fs 工具写也会改 mtime。部分文件系统的 mtime 精度只有 1–2 秒 |
| 任务 `updatedAt` | `AT/types.ts:255` | 最近一次任务变化的时刻 | 不是认领时刻。in_progress、输出更新、队长 amend 都会刷新它（`AT/tools.ts:2001,2115`） |
| `attempt` / `attemptId` | `AT/types.ts:180-182` | 「哪一次执行」的身份，变了就是新任务代 | 没有时间 |
| 窗口投影 | `src/window/counter.ts:15-58` | 压缩次数，随日志重放，resume 后自动恢复 | 没有时间。fork 会多算 |
| `CompletionTracker` | `src/notes/merge.ts:29-49` | 每个团队「已完成任务 id 集合」的进程内快照 | **没有时间，只看 completed**，冷启动后第一次观察只建快照（`merge.ts:22,37-45`）。只能借用它的「工具返回后重读 team.json 做差分」模式 |
| `TeamToolCalls` | `src/notes/merge.ts:52-70` | 按会话识别 `agent_teams_*` 调用的返回 | 只返回布尔值。可以照它的写法识别 `team_notes` 和 `agent_teams_claim_task` 的返回 |
| `CompactionGate` | `src/budget/compact.ts:17-39` | 每会话「已尝试过的窗口号」和运行中标记 | 没有时间 |
| 预算档位 | `src/index.ts:96-100`；`src/budget/usage.ts:40-47` | 每次组装时现算 | 不落存储，不知道「本窗口第一次跨 37% 是什么时候」 |
| `tool/call`、`tool/result` 事件 | `types.d.ts:354-360,374-388` | 工具名、原始 arguments、callId、isError，事件带 `time` 和 `seq` | 需要投影或 `session/event` 监听去记录 |
| `session.inheritedEventCount` | `session.d.ts:121` | fork 继承前缀的长度 | — |

**两个让「写入后事件数 = 0」失效的事实：**
1. `team_notes` 的 `tool/result` 在 `execute` 返回之后才追加，时间晚于文件 mtime。之后还有 assistant 回复。
2. `compaction/start` 在 summarize 之前就追加了（`basic:469`）。smart-compact 的 `isContentEvent` 排除了 `compaction/` 前缀（`/workspace/work/hoyyang_dsh-smart-compact/src/rollover.ts:164-168`），但第 1 条没有排除。它的严格判定 `eventsAfter > 0 ⇒ stale`（`rollover.ts:119-133`）在本场景几乎恒为过期。

**另一个限制：** smart-compact 的事件来源是 `session.snapshotEvents()`（`/workspace/work/hoyyang_dsh-smart-compact/src/history.ts:40-47`），宿主已标注「new calls are prohibited」（`session.d.ts:187-193`；`设计:211`）。不能照搬。

### 2.2 候选定义

#### 方案 A：只用 mtime，与窗口起点和任务起点比较
`fresh ⇔ mtime(own) ≥ max(windowStart, taskStart) − ε`
- `windowStart`：扩展窗口投影，记录最后一次成功 `compaction/end` 的 `event.time`。第一窗用会话第一条事件的时间。
- `taskStart`：当前任务 `updatedAt`（近似值），或者 attemptId 首次出现的时刻。
- `ε`：用来吸收 mtime 精度，例如 2 秒。

| 利 | 弊 |
|---|---|
| 实现最小：一次 `stat`，加投影里的一个字段；同步可得；resume 后仍成立 | **衡量不出「写完笔记后又干了多少活」**。窗口开头写一次、之后干到 45%，依然判新鲜。这正是 04 想防的情形 |
| 不依赖事件 API | `updatedAt` 会被 in_progress 和 amend 推后：笔记在标 in_progress 之前写的会被判过期（偏严，可以接受）；队长 amend 也会让成员笔记「过期」（偏严） |
| | mtime 不区分会话：同一成员的旧会话写的笔记，可能落在新会话第一窗起点之后 |

#### 方案 B：会话投影记录写笔记的事件位置，统计之后的工作量
扩展 `tokenBudgetWindow` 投影（或新建一个），在 `apply` 里记录：
- `lastNoteWrite: { seq, time, window }`：`tool/call` 的 `name === 'team_notes'`，arguments 里 `action ∈ {write, append}`，且 path 指向自己（省略、`self`、或以 `<fileKey>.md` 结尾）；对应的 `tool/result` 不是 `isError`。投影拿不到 fileKey，可以先记下原始 path，到 summarize 时再用 `resolveNotePath`（`src/notes/paths.ts:43-65`）判断。
- `workSinceNote`：此后「工作事件」的计数，例如除 `team_notes`、`context_remaining`、`history_*` 以外的 `tool/call`。
- `windowStartedAt`、`lastToolCall: { name, time }`：顺带记下，供模板和方案 A 使用。

判定：`fresh ⇔ lastNoteWrite 存在 ∧ workSinceNote ≤ K`，K 可配置，建议 2–3。

| 利 | 弊 |
|---|---|
| 直接衡量「笔记之后有多少没记下来的工作」，最贴近 04 的意图 | 实现量最大：stateVersion 升级、解析 arguments、path 归属判断、和 `tool/result` 配对 |
| 投影随日志重放，resume 后自动恢复，不用弃用 API，不读盘 | fork 子会话会继承父会话的记录。可以用 `seq < session.inheritedEventCount` 排除（`session.d.ts:121`） |
| 不受 mtime 精度和其他会话写入干扰 | 成员用通用 fs 工具写笔记的话看不到。K 需要按实际调参 |
| 计数可以排除压缩、runtime-context 快照等非工作事件，规避 §2.1 的两个坑 | |

#### 方案 C（推荐）：B 加 attempt 绑定，A 作降级
`fresh ⇔ B 判新鲜 ∧ 这次笔记写在当前 attempt 开始之后`
- 「当前 attempt 开始」：投影另记 `lastClaim: { taskId, attemptIdSeen?, seq, time }`，取自成功的 `agent_teams_claim_task` 返回（成员规则要求每次派工都调用它：`AT/members.ts:815`、`AT/scheduler.ts:265`）。要更省事，也可以在写笔记时把当时 team.json 里的 attemptId 一起记下，summarize 时与现在的 attemptId 比较。
- 投影不可用时，降级为方案 A。再判不了，就走 LLM。

| 利 | 弊 |
|---|---|
| 防住最危险的误判：上一个任务完成后，调度器自动派下一个（`AT/scheduler.ts:385`；`AT/members.ts:826`）。旧任务的笔记按 mtime 和事件数都还「新鲜」，但讲的是别的任务 | 依赖成员确实调了 `claim_task`。调度器派工本身在成员会话里没有工具事件 |
| 与「模板写 attempt_id」天然一致：模板宣称的 attempt，正是笔记覆盖的那个 attempt | 队长没有任务，退化为纯 B |
| 每一层判不了都退回 LLM，与 `04:72`「读取失败一律走 LLM」一致 | 三层逻辑，测试面更大 |

**关于和「最后一次工具调用」比较：** 要求 `mtime ≥ lastToolCall.time` 等于要求写笔记就是最后一个动作，过严。D1 在 pre-step 触发（`src/index.ts:183-204`），而预算提醒在 37/40/43% 就要求写笔记（`src/budget/reminder.ts:21-23`），提醒到压缩之间一般还有若干步。所以「最后一次工具调用」更适合拿来算 B 里的 `workSinceNote`，不适合直接比时间。

---

## 3. 04 模板草案和新鲜度判定，与实际可得数据对不上的地方

| # | 04 原文 | 实际情况 | 建议 |
|---|---|---|---|
| 1 | 「团队窗口 #N 已打开」（`04:57`） | summarize 时 `windowOf` 返回旧窗口号，新窗口要 +1（`basic:469,484`；`src/window/counter.ts:44`）。fork 会话会算上继承的压缩（`设计:275,432`）。v1 设计决定不向模型展示编号（`设计:276`）。history 工具的 `w<N>` 口径不同（`src/history/model.ts:4,122`） | 要么删掉编号；要么投影记下每次 end 的 seq，summarize 时按 `seq ≥ inheritedEventCount` 计数再 +1，与 history 口径对齐。展示编号要先改 `设计:276` 的决议 |
| 2 | 「身份：<成员名>（团队 <team>）」（`04:58`） | hint 首行已有（`src/prompt/hint.ts:54`），persona 也有（`AT/members.ts:801-806`） | 删除，或只在 hint 被整条丢弃时保留（见 §4-1） |
| 3 | 「当前任务：<task id> <标题>，attempt_id=<从 .agent-teams 读>，状态=<…>」（`04:59`）；「attempt_id 从磁盘（team.json）读」（`04:65`） | 插件的 `TeamTaskInfo` 和 `coerceTeam` 不解析 attemptId、attempt、updatedAt、description（`src/team/team-file.ts:21-26,71-80`）。没写选取规则：hint 规则包含 pending（`hint.ts:55`）。队长没有当前任务 | 扩展解析，可选字段宽容。按 §1.2 选任务。单独写队长分支，或队长恒走 LLM |
| 4 | 「任务 id 与标题和 hint 同源（设计:415）」（`04:65`） | 行号引错：`设计:415` 是 7-3 合并层，hint 来源是 `设计:416`（7-4）。「同源」也只是同一个文件：hint 用 TeamDirectory 缓存的快照（`src/team/directory.ts:42`），可能落后于磁盘 | 改为 `设计:416`。summarize 里先 `teams.forget(agent.id)` 再读，让模板和随后重算的 hint 用同一个新快照 |
| 5 | 「上一步动作：<最后一个工具名 + 时间>」（`04:60`） | 时间没有可用的非弃用来源（`session.d.ts:177-200`；`设计:211`）。`input.messages` 不带时间（`basic:695-703`）。D1、80%、手动压缩都会保留最近原文，最后一个动作在新窗口里本来就可见（`设计:169`；`basic:932,949`） | 删除。若要保留，由方案 B 的投影提供 `lastToolCall`，并说明它属于被遮蔽区间之前还是之后 |
| 6 | 「笔记：最近 ≤5 条 team_notes 的元数据」（`04:61`） | `team_notes` 没有「条目」的概念，只有文件（`src/notes/tool.ts:53-57`）。「自己的文件 + 最近 ≤5 个文件」正是 hint 的内容（`hint.ts:63-71`；`设计:416`） | 改成一句「先读你的笔记 `<path>`」，元数据交给 hint |
| 7 | 「上一窗口已完整归档，没有丢弃任何内容」（`04:57`） | 只在 `history` 开关开、且 persistence 可用时才有读回途径（`src/index.ts:164-171`；`src/history/source.ts:31`）。成员读不到继承前缀（`source.ts:46`）。外层 `CHECKPOINT_PREAMBLE` 要求「不要提及 checkpoint」（`basic:280`），与模板「宣布换窗」的口吻相反 | 按开关拼装文本。接受与 preamble 口吻不一致（smart-compact 也是这样），或者改写成中性陈述 |
| 8 | 「缺细节时：用 history_search_contents / history_read_item 读原文」（`04:62`） | 工具名正确（`设计:364`）。hint 已有同样的指引（`hint.ts:73`）。没有 `team_history`：`设计:339` 设计了，但未实现（`src/` 下无此工具），契约只能经 `claim_task` 的 `task_details` 读回 | 去重。提示「契约以 `agent_teams_claim_task` 返回为准」比提示 history 更直接 |
| 9 | 新鲜度：「统计该成员最后一次写自己的 `teams/<teamId>/<agentKey>.md` 之后发生的会话事件数，为 0 或低于阈值即为新鲜」（`04:71`） | ① 文件名是 fileKey（经 `sanitizeKey`），不是 agentKey（`src/team/identity.ts:74`；`src/notes/paths.ts:21-23`）。② smart-compact 原逻辑没有阈值，`>0` 即过期；而且笔记不存在时 `stale=false`，靠另一个 `notesPresent` 拦截（`rollover.ts:119-133,388`）。③ 事件来源 `snapshotEvents` 禁止新调用。④ 写笔记自己的 `tool/result` 和 `compaction/start` 必然晚于 mtime（§2.1）。⑤ mtime 不区分会话和任务 | 改用 §2 方案 C。明确：笔记不存在 ⇒ LLM |
| 10 | 「时间戳取 NotesStore 的 mtimeMs（store.ts:18,69）」（`04:71`） | 可取，但 summarize 是异步上下文，用 `store.meta()`（异步）或 `listNoteMetasSync`（同步）都行。`NotesStore` 实例来自 `createStoreCache`（`src/notes/tool.ts:26-37`），patch 闭包需要拿到同一个 `storeFor` | 接线时把 `storeFor` 提到 `apply` 顶层（现在只在 `if (config.notes)` 里创建，`src/index.ts:137`） |
| 11 | 「在 `agent/created`（或首次 pre-step）解析出团队身份后放进 WeakSet；身份失效时移除」（`04:76`） | 成员在 `agent/created` 时可能还没写进 team.json（`设计:264`）。实现已改为按需解析，负结果缓存 5 秒（`src/team/directory.ts:31,39-53`；`04:92` 也提到）。没有「某个 agent 身份失效」的信号，只有全局 `invalidate`（`directory.ts:56-58`） | 不要 WeakSet，summarize 里直接 `teams.identityOf(agent)`（同步、便宜、口径与其余功能一致） |
| 12 | 「引擎代写字段（任务标题、上一步动作）先做脱敏」（`04:66`） | 合理。标题来自 team.json 的 `subject`，由队长或模型写入 | 脱敏只作用于 subject 和 description，不碰 attempt_id、任务 id、路径 |
| 13 | 体积约束只列在待验证里（`04:97`） | 体积检查在 summarize 返回之后（`basic:600-601`），钩子内拿不到失败结果，无法当场退回 LLM | 钩子内先估算：`ctx.tokenMeter.estimateMessage`（basic 用的就是它，`basic:600`；插件已注入 `tokenMeter`，`src/index.ts:46`），与 `input.messages` 的估算比较，留足余量，不够就直接调原方法 |

---

## 4. 与已实现功能的交互：重复注入与冲突

### 4-1 hint 按窗口刷新（`src/index.ts:110-133`；`src/prompt/hint.ts`）
- **时序**：模板压缩提交 `compaction/end` → 投影 +1 → 下一次组装时 hint 缓存键变化，重算（`index.ts:119`）。runtime context 被压缩替换后会在下一次准入时自动补回（`设计:229`）。所以新窗口里依次是：system 头（persona + `TEAM_MEMBER_PROMPT` + notesPointer）、模板 checkpoint、保留的最后一个节点、新 hint 快照。hint 追加在保留节点之后【推断：准入发生在 pre-step 之后的组装阶段，需要运行态确认】。
- **重复**：身份、任务 id/标题/状态、笔记元数据、history 工具提示，模板和 hint 各写一遍（`hint.ts:54-73` 对 `04:58-62`）。
- **冲突**：
  - hint 用缓存身份，模板若重读磁盘，两者可能显示不同的状态，例如一个是 claimed、一个是 in_progress。
  - hint 会列出 pending 的排队任务，模板只写当前 attempt，模型可能把排队任务当成当前任务。
  - hint 超过 `hintMaxBytes` 时整条不注入（`hint.ts:75`），此时模板反而是唯一来源。
- **建议**：
  - 模板只放 hint 没有的：attempt_id 和新鲜度结论（「笔记覆盖到 attempt X、写于 …，之后有 n 步」）。也可以把 attempt_id 并入 hint 的任务行，让模板只剩一句指引。
  - summarize 里先 `teams.forget(agent.id)`，保证随后的 hint 和模板用同一份快照。

### 4-2 notesPointer（`src/prompt/notes-section.ts:14-25`；`src/index.ts:144-160`）
- 冻结的 system section 已写明「压缩后先读笔记再继续」（`notes-section.ts:19`），和模板的「先读笔记」重复。属于无害冗余，而且不改写 system 头，不影响缓存。
- 判定过期走 LLM 时，pointer 依然叫模型「先读笔记」，可能把它引向过期笔记。这是现状行为，hybrid 没有让它变得更糟。可以考虑在 LLM 兜底的摘要末尾补一句「笔记写于 …，可能过期」，但这样就改了原 summarize 的输出，需要另行决定。

### 4-3 45% pre-step 和 CompactionGate（`src/index.ts:183-215`；`src/budget/compact.ts:17-39`）
- summarize 在 `gate.begin` 和 `gate.end` 之间运行（`index.ts:202-210`）。模板路径不调模型，成员阻塞时间明显缩短，这是 04 §3.2 所说的主要收益。
- **失败会吃掉本窗口的机会**：summarize 返回后体积超限或 surface 变化，会写入带 error 的 `compaction/end`（`basic:487-499`），投影不 +1（`src/window/counter.ts:31-35`）。gate 已记下本窗口尝试过（`compact.ts:26-27`），本窗口不再触发 45%，只能等 80% 兜底。所以 §3-13 的「事先估算」是必需的。
- **可能连续压缩**：D1 保留的最后一个节点若很大（例如大工具结果），压缩后占用仍 ≥45%。窗口号已经变了，下一步 gate 放行，会再压一次。这时被遮蔽区间基本只剩上一次的模板 checkpoint 和 hint 快照，可能出现两种情况：
  - 新鲜度要求「写在本窗口内」：判过期，变成用 LLM 去摘要一段模板，浪费调用；
  - 新鲜度不限窗口：模板替换模板，可以接受。

  `selectCompactableRange` 也可能返回 null（`basic:932-933`；`src/index.ts:205-207` 记「没有可压缩的范围」）。建议新鲜度的窗口锚点用「上次写笔记以来」，不要用「本窗口起点」；或者被遮蔽区间只含上一次 checkpoint 时，直接复用模板。

### 4-4 80% 兜底压缩（preset 自带，`basic:936-960`）
- 走同一个 `compactRegion` → `summarize`（`04:37`），补丁同样生效。它会保留约 16% 的尾段（`04:38`），「上一步动作」更加多余。
- 每次重试（`compactionRetries`，`basic:948-959`）都会重新调用 summarize。模板每次相同，问题不大，但每次都会读盘、重算新鲜度。
- 引擎由同一 preset 的所有会话共享（`设计:149`；`04:80`）。补丁只能按 agent 分流，非团队会话必须原样调用原方法。
- 手动 `/compact` 也会命中（`basic:985-1001`）。用户手动压缩却得到模板，是否符合预期，04 已列为待确认（`04:98`）。

### 4-5 预算提醒（`src/budget/reminder.ts:16-24`；`src/index.ts:88-107`）
- 37/40/43% 的提醒要求写笔记，是笔记新鲜的主要来源。方案 B 的阈值 K 应和「提醒到 45% 之间的典型步数」相匹配。
- 压缩后 P 骤降，提醒变回空串，与模板没有冲突。
- 如果新鲜度要参考「本窗口首次跨 37% 的时刻」，现在没有记录（档位每次组装现算），要在 budget context 的 `text()` 里顺手记一次（同步、无副作用风险）。

### 4-6 notesMerge 和 CompletionTracker（`src/notes/merge.ts`；`src/index.ts:222-299`）
- 合并只写 workspace.md，不影响「自己笔记」的 mtime。但会改变 hint 里「最近改动」的排序，所以 workspace.md 不能当新鲜度依据（§1.1 #19）。
- 任务完成后调度器自动派下一个任务，旧笔记仍然「新鲜」。这是方案 C 要绑定 attempt 的直接原因。
- `CompletionTracker` 和 `TeamToolCalls` 的「工具返回后重读 team.json」模式，可以复用来捕获 `claim_task` 的返回，但它们是进程内状态，重启即丢。新鲜度依据优先放进投影。

### 4-7 身份缓存失效
- `TeamDirectory.invalidate()` 是全局清空，触发条件是任意会话里的 `agent_teams_*` 返回（`src/index.ts:75-78`）。调度器派工不触发它。所以「模板读到的任务」必须强制刷新，见 §1.3 和 §4-1。

---

## 5. 落地前要改的最小代码面（供后续任务参考，未实施）

1. `src/team/team-file.ts:21-26,71-80`：`TeamTaskInfo` 增加可选字段 `attempt`、`attemptId`、`updatedAt`、`description`。坏值一律忽略，不能让整个团队判失败。
2. `src/window/counter.ts`：投影状态增加 `endSeqs` 或 `windowStartedAt`、`lastNoteWrite`、`workSinceNote`、`lastClaim`、`lastToolCall`，并把 `stateVersion` 从 1 升到 2（`counter.ts:42`）。
3. `src/index.ts:137`：把 `storeFor` 提到 `apply` 顶层，供 summarize 补丁使用。
4. 补丁里先 `teams.forget(agent.id)` 再调 `identityOf`，然后估算体积，按开关拼装文本。

## 6. 未能确认的事项
- runtime context（新 hint）在新窗口里的确切位置，是在保留节点之后，还是在下一步才追加。需要运行态确认。
- 多个成员共用一个引擎实例时，summarize 收到的 agent 是否就是正在压缩的那个成员。源码链路成立（`basic:971-972,587`），运行态未验证（同 `04:96`）。
- `ctx.tokenMeter.estimateMessage` 对插件是否作为公共方法暴露：basic 通过 `this.ctx.tokenMeter` 调用（`basic:600,1015`），插件侧的类型声明没有核对。
