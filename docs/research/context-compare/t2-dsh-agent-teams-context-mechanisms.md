# T2 — dsh-agent-teams 上下文机制取证（子代理生命周期 / 任务契约 / 结果投递 / 记忆文件）

- 被测仓库：`I:\VMsShare\_src-compare\dsh-agent-teams`（只读；取证前后 `git status --porcelain` 均为空）
- 版本锚点：`1094b84add6f2fb19edf659367fe2fd5f7f14154`，tag `v0.1.23`，`package.json` name `@nanmicoder/dsh-agent-teams`
- 引用中的 `src/...` 一律相对仓库根；所有片段逐字摘自该 commit，每个片段前有 `<!-- src: 路径:起始-结束 -->` 标记，可用 `check-t2-evidence.mjs` 复核（结果见 `t2-snippet-verification.log`）
- 分层约定：**【插件】** = dsh-agent-teams 插件自身代码；**【harness】** = DSH（`@deepseek-ai/dsh-*`）提供的能力

---

## 0. 结论速览（先给边界结论）

**边界结论（本次取证的核心判断）：**

1. **【插件】只持久化"工作状态"，不持久化"对话上下文"。** 落盘的是 `team.json`（成员 durable 子会话 id、任务契约、attempt 能力、结构化证据）与 `inbox/*.jsonl`（消息）。成员会话的对话历史本身属于 harness 的 session 存储，插件从不读取、复制、裁剪或重写它 —— 插件对 harness session 事件日志的读取仅有"这个 turn 是否已经 step/start"以及"这段子会话自己的 subagent descriptor"两类。
2. **【插件】不存在任何自研压缩 / 摘要 / 笔记 / 历史检索机制。** 全仓 `src/**` 无 `compact` / `compaction` 调用，也无 `@deepseek-ai/dsh-compaction*` 依赖。插件侧与"上下文体积"有关的逻辑只有**确定性的字符串截断**（dependency outputs、status 文本、inbox 预览、persona protocol），不是模型摘要。
3. **【harness】上下文窗口治理、压缩与工具结果裁剪全部属于宿主。** 本机 DSH 安装（`D:\Dev\Path\nodejs_25.0.0\npm-cache\_npx\1e7f6d9597241db0\node_modules\@deepseek-ai\`）已装载 `dsh-compaction` / `dsh-compaction-basic` / `dsh-compaction-tool-result-pruner` / `dsh-command-compact`（均为 `0.2.0-rc.2`）。插件把"一个成员 = 一个 durable continuable 子会话"交给宿主，其历史与压缩继承宿主 composition。
4. **【插件】唯一的"跨轮次工作记忆"是 `team.json` + mailbox，它是任务状态的权威源（truth source），不是对话记忆的替代品。** 仓库文档对此有显式设计立场（见 §6.2）。

---

## 1. 维度一：member / 子代理的会话生命周期

### 1.1 成员 = captain 的 durable continuable 子代理，跨 harness 重启保留对话

模块头声明了这一生命周期（逐字节选）：

<!-- src: src/members.ts:1-13 -->

```ts
/**
 * Member subagent lifecycle: spawn a continuable child per member, deliver
 * task turns and step-boundary messages, and observe its activity.
 *
 * Members are durable continuable subagents of the captain, so a member keeps
 * its conversation across turns and across harness restarts: the captain
 * queues its next turn through {@link deliverToMember}, it works through its turn
 * (updating team state through the `agent_teams_*` tools), and becomes idle
 * again. Its final assistant message is not readable programmatically, so the
 * member persists its report into the captain's mailbox and the task records,
 * which the captain reads through `agent_teams_status`.
 * @module dsh-agent-teams/members
 */
```

<!-- src: src/types.ts:1-9 -->

```ts
/**
 * Durable AgentTeams state types.
 *
 * A team is one directory under the state root holding `team.json` plus an
 * `inbox/` of per-agent JSONL mailboxes. Members are continuable subagents
 * whose durable child session ids are recorded in the team file, so a team
 * survives harness restarts.
 * @module dsh-agent-teams/types
 */
```

**创建（何时）**：成员在 spawn 时通过【harness】`ctx.subagents.startContinuable` 建立，并把返回的 child session id 写回成员记录。

<!-- src: src/members.ts:907-917 -->

```ts
  const start = await selections.withPending(captain.id, label, llmSelection, () => (
    startMemberWithLenientFilter(
      toolFilter => {
        acceptedFilter = toolFilter
        return ctx.subagents.startContinuable({
          provider: config.provider,
          label,
          request: {
            prompt: [{ type: 'text', text: initialPrompt ?? memberWelcome(team, member.name) }],
            parent: captain,
            persona: memberPersona(team, member, stateDir, config.executionPrompt),
```

`src/members.ts:942` 把 harness 返回的 child id 写进成员记录：`member.id = start.childId`。成员记录的 `id` 字段即该 durable 子会话 id：

<!-- src: src/types.ts:261-266 -->

```ts
/** One team member: a continuable subagent plus its team-side record. */
export interface TeamMember {
  /** Durable continuable subagent session id (empty until spawned). */
  id: string
  /** Unique display name inside the team. */
  name: string
```

【harness】侧该原语的语义（本机 0.2.0-rc.2 安装）：

<!-- src: @deepseek-ai/dsh-subagent/lib/types/continuation.d.ts:7-11 -->

```ts
 * A continuable child has one durable Session and at most one process-local
 * Activation. The Agent inbox is the only turn queue, so this manager owns
 * durable orchestration while the Agent loop owns all turn ordering and
 * execution. No continuable path creates a Task or an intermediate
 * result-bearing wrapper.
```

### 1.2 结束：`interrupt` 保留会话；"退休"只是投递拒绝名单，历史 transcript 仍可读

上游 `interrupt()` 有意保留 continuable session，插件没有定向 forget/retire API，因此用一个持久的 retired-member id 名单在投递边界阻止再次冷启动该成员。

<!-- src: src/members.ts:1000-1012 -->

```ts
/**
 * Install the missing per-child retirement boundary above Harness rc.6.
 *
 * Upstream `interrupt()` deliberately preserves continuable sessions and the
 * upstream seam exposes no targeted forget/retire method. The durable
 * AgentTeams index therefore rejects every inbox delivery before it can cold-resume a
 * retired member. Catalog rows deliberately remain discoverable: Harness rc.8
 * uses the direct-child catalog to authorize historical transcript reads and
 * `openSubagent()`, so filtering those rows would make an archived member's
 * persisted conversation inaccessible. Exact ids keep unrelated subagents
 * untouched while the delivery boundary still prevents further model turns.
 */
```

<!-- src: src/members.ts:1012-1016 -->

```ts
export function installRetiredMemberGuard(ctx: Context, stateDir: string): void {
  guardSubagentDelivery(ctx, async (parent, childId) => {
    const retired = await readRetiredMemberIds(join(parent.session.header.cwd ?? process.cwd(), stateDir))
    return retired.has(childId)
  })
```

退休名单落盘在 state root 的 `retired-members.json`：

<!-- src: src/state.ts:325-338 -->

```ts
/** Atomically add session ids to the durable retired-member deny-list. */
export async function recordRetiredMemberIds(stateRoot: string, memberIds: readonly string[]): Promise<void> {
  const additions = memberIds.filter(id => id !== '')
  if (additions.length === 0) return
  await withTeamLock(`retired-members:${stateRoot}`, async () => {
    const retired = await readRetiredMemberIds(stateRoot)
    for (const id of additions) retired.add(id)
    await mkdir(stateRoot, { recursive: true })
    await atomicWriteText(
      join(stateRoot, RETIRED_MEMBERS_FILE),
      `${JSON.stringify([...retired].sort(), null, 2)}\n`,
    )
  })
}
```

**结论**：成员"结束后上下文是否保留" → **是（对话保留在 harness session 存储中，插件不删）**；插件强制的边界是"不再向该 child 投递任何 turn"，历史 transcript 仍可由 captain 侧读取。

---

## 2. 维度二：队长↔成员之间传递的内容形态

### 2.1 任务派发：一条**全文**分配提示（非摘要），字段化拼装

`src/scheduler.ts:210-269` 的 `assignmentPrompt` 决定成员看到的任务上下文。其函数签名（注意 goal/protocol 每次都随派发重发，不依赖历史）：

<!-- src: src/scheduler.ts:210-219 -->

```ts
export function assignmentPrompt(
  ticket: DispatchTicket,
  stateDir: string,
  teamId: string,
  workOrderWarnings: readonly string[] = [],
): string {
  const description = ticket.description === undefined ? '' : `\n\n${ticket.description}`
  const seed = ticket.profileSeedId === undefined ? '' : ` [${ticket.profileSeedId}]`
  const goal = ticket.teamDescription?.trim() || '(not provided)'
  const protocol = ticket.profileProtocol?.trim() || '(none)'
```

正文模板（节选，展示"全文而非摘要"与必带字段）：

<!-- src: src/scheduler.ts:248-262 -->

```ts
${goal}

Profile protocol:
${protocol}
${executionPrompt === undefined || executionPrompt === '' ? '' : `
Execution guidance:
${executionPrompt}
`}
Completed dependency results:
${formatDependencyOutputs(ticket.dependencyOutputs)}

Task: ${ticket.taskId}${seed} — ${ticket.subject}${description}
${staleWorkOrder}${contract === '' ? '' : `\nContract:\n${contract}\n`}
${structuredCompletion}
Attempt: ${ticket.attempt}
```

**携带哪些字段**：由 `DispatchTicket` 定义（节选）：

<!-- src: src/scheduler.ts:66-74 -->

```ts
export interface DispatchTicket {
  readonly taskId: string
  readonly memberName: string
  readonly memberId: string
  readonly attempt: number
  readonly attemptId: string
  readonly previousAssignee?: string
  /** True when this ticket rotates an unobserved durable open attempt. */
  readonly recoveredOwned: boolean
```

ticket 构造处（节选）：

<!-- src: src/scheduler.ts:403-410 -->

```ts
          return {
            taskId: task.id,
            memberName: currentMember.name,
            memberId: currentMember.id,
            attempt: task.attempt ?? 1,
            attemptId,
            previousAssignee,
            recoveredOwned: recoverOwned,
```

**投递通道**：任务分配走 **queue**（独立 FIFO turn），协调消息走 **steer**（最近 step 边界）：

<!-- src: src/scheduler.ts:450-452 -->

```ts
        const accepted = config.dispatch === undefined
          ? await deliverToMember(ctx, captain, ticket.memberId, prompt, signal)
          : await config.dispatch(captain, team.id, ticket.memberName, prompt, signal, 'queue', ticket.attemptId)
```

<!-- src: src/members.ts:966-972 -->

```ts
export async function deliverToMember(
  ctx: Context,
  captain: Agent,
  childId: string,
  text: string,
  signal: AbortSignal,
  mode: 'queue' | 'steer' = 'queue',
```

【harness】边界：`queueMemberPrompt` 只把文本转发到宿主 inbox 队列，插件不产生第二条内容。

<!-- src: src/harness-compat.ts:191-205 -->

```ts
/** Queue a distinct host-authored turn; never substitute model-message steer. */
export async function queueMemberPrompt(
  runtime: Context['subagents'], parent: Agent, childId: SessionId,
  content: ContentBlock[], signal: AbortSignal,
): Promise<MessageId> {
  const host = boundary(runtime)
  const source = agentTeamsSource({ kind: 'agent-teams' })
  if (typeof host.followup === 'function') {
    return host.followup.call(runtime, parent, childId, content, { source, signal })
  }
  const deliver = host[hostPromptDeliver]
  if (typeof deliver === 'function') return deliver.call(runtime, parent, childId, content, source, signal, 'queue')
  const queue = host[hostPromptQueue]
  if (typeof queue !== 'function') return unsupported('missing host FIFO delivery')
```

### 2.2 消息的形态与持久化字段

<!-- src: src/types.ts:309-323 -->

```ts
/** One mailbox message. */
export interface TeamMessage {
  id: string
  /** `captain` or a member name. */
  from: string
  /** `captain` or a member name. */
  to: string
  content: string
  ts: number
  /** Process-local delivery lease; prevents fallback and direct delivery racing. */
  deliveryClaimedAt?: number
  /** Set after the durable message was accepted by the recipient's live Harness inbox. */
  deliveredAt?: number
  /** Set once the recipient has consumed or been shown the durable fallback. */
  readAt?: number
```

### 2.3 结果投递：投递的是**全文 content**，摘要只出现在 captain 的**概览渲染**里

成员→captain：`send_message` 把 `args.content` 原样写成一条 mailbox 消息（单行证据）：

<!-- src: src/tools.ts:2204 -->




```ts
          const message = { ...createMessage(from, CAPTAIN_KEY, args.content), ...sourceFields, deliveryClaimedAt: Date.now() }
```

live 投递使用同一条消息渲染出的全文（单行证据）：

<!-- src: src/tools.ts:2244 -->




```ts
          delivered = steerCaptainReport(captain, prepared.from, args.content, mailboxPrompt(prepared.fresh.id, CAPTAIN_KEY, [prepared.message])) ? 'live' : 'mailbox'
```

投递文本模板与 provenance 前缀：

<!-- src: src/mailbox.ts:27-31 -->

```ts
function mailboxBody(recipient: string, messages: readonly TeamMessage[]): string {
  return messages.map(message => recipient === CAPTAIN_KEY
      ? `AgentTeams message from member ${message.from}:\n\n${mailboxContent(message)}`
      : `AgentTeams message from ${message.from}${message.attemptId === undefined ? '' : ` for task ${message.taskId}, attempt_id ${message.attemptId}`}:\n\n${mailboxContent(message)}`).join('\n\n')
}
```

<!-- src: src/mailbox.ts:22-25 -->

```ts
export function mailboxContent(message: TeamMessage): string {
  return (message.sourceTaskId === undefined ? ''
    : `[Source task ${message.sourceTaskId}, attempt_id ${message.sourceAttemptId}${message.sourceTaskStatus === undefined ? '' : `, status=${message.sourceTaskStatus}`}]\n`) + message.content
}
```

成员会话唯一的"准入过滤"（丢弃失效代际邮件 + ack 已消费邮件；是去重/失效判定，不是摘要）：

<!-- src: src/mailbox.ts:158-172 -->

```ts
      if (messages.length > 0) admitted.push({ ...input, content: [{ type: 'text' as const, text: mailboxBody(receipt.recipient, messages) }] })
    }
    // Reject only a new turn whose sole trigger was obsolete mail. During an
    // existing turn, a status tool may have consumed this same mail already;
    // dropping its duplicate must not block the pending tool-result response.
    if (decision.messages.length > 0 && admitted.length === 0) {
      const events = sessionOwnEvents(payload.agent.session)
      let continuing = false
      for (let i = events.length - 1; i >= 0; i--) {
        const event = events[i]!
        if (event.type === 'step/start' && event.data.turn === payload.turn) { continuing = true; break }
        if (event.type === 'turn/start') break
      }
      if (!continuing) return { kind: 'reject' }
    }
```

<!-- src: src/mailbox.ts:173-175 -->

```ts
    return { ...decision, messages: admitted }
  })
}
```

---

## 3. 维度三：任务契约在上下文中的作用与持久化

### 3.1 契约被**写进每一轮派发提示**（成员无需回查历史）

<!-- src: src/scheduler.ts:225-230 -->

```ts
  const contract = [
    `Kind: ${kind}${ticket.round === undefined ? '' : ` (round ${ticket.round})`}`,
    ticket.objective === undefined || ticket.objective === '' ? '' : `Objective: ${ticket.objective}`,
    ticket.inScope === undefined || ticket.inScope.length === 0 ? '' : `In scope: ${ticket.inScope.join(', ')}`,
    ticket.outOfScope === undefined || ticket.outOfScope.length === 0 ? '' : `Out of scope: ${ticket.outOfScope.join(', ')}`,
    ticket.acceptance === undefined || ticket.acceptance.length === 0 ? '' : `Acceptance: ${ticket.acceptance.join('; ')}`,
```

<!-- src: src/scheduler.ts:231-241 -->

```ts
    ticket.verify === undefined || ticket.verify.length === 0 ? '' : `Verify: ${ticket.verify.join('; ')}`,
    ticket.reviewedTaskId === undefined ? '' : `Reviewed task: ${ticket.reviewedTaskId}`,
    ticket.findingSourceTaskIds === undefined || ticket.findingSourceTaskIds.length === 0 ? '' : `Fixes findings of: ${ticket.findingSourceTaskIds.join(', ')}`,
  ].filter((line) => line !== '').join('\n')
  const structuredCompletion = ['implementation', 'repair', 'verification', 'integration'].includes(kind)
    ? `
Structured completion payload (keep these arrays in contract order):
acceptanceResults: ${JSON.stringify((ticket.acceptance ?? []).map((criterion) => ({ criterion, status: 'passed', evidence: '<what proved it>' })))}
commandsRun: ${JSON.stringify((ticket.verify ?? []).map((command) => ({ command, status: 'passed', exitCode: 0, evidence: '<observed result>' })))}
${kind === 'implementation' || kind === 'repair' ? 'changedPaths: list the actual workspace-relative POSIX paths you changed.\n' : ''}`
    : ''
```

### 3.2 哪些字段写入状态文件 / 跨轮次持久化

契约字段全部是 `TeamTask` 的持久字段（节选一：identity 与协调）：

<!-- src: src/types.ts:162-163 -->

```ts
/** One task of a team's task list. */
export interface TeamTask {
```

null

<!-- src: src/types.ts:189-204 -->

```ts
  kind?: TaskKind
  /** Review / requirements / repair loop index, 1-based when present. */
  round?: number
  verdict?: ReviewVerdict
  findings?: ReviewFinding[]
  objective?: string
  inScope?: string[]
  outOfScope?: string[]
  acceptance?: string[]
  verify?: string[]
  deliverables?: string[]
  nonGoals?: string[]
  changedPaths?: string[]
  acceptanceResults?: AcceptanceResult[]
  commandsRun?: CommandResult[]
```

**重试/改派时"契约保留、结果清空"**（契约跨 attempt 持久化，证据不跨代际）：

<!-- src: src/state.ts:171-179 -->

```ts
/** Execution results belong to one attempt; a retry must produce its own evidence. */
function clearAttemptResult(task: TeamTask): void {
  task.output = undefined
  task.verdict = undefined
  task.findings = undefined
  task.changedPaths = undefined
  task.acceptanceResults = undefined
  task.commandsRun = undefined
}
```

**终态任务的追加式补充证据**（不可改 verdict）：

<!-- src: src/types.ts:151-160 -->

```ts
/** Append-only observations; never replace the terminal verdict or unlock a gate. */
export interface TaskEvidence {
  at: number
  by: string
  attempt: number
  attemptId?: string
  note?: string
  acceptanceResults?: AcceptanceResult[]
  commandsRun?: CommandResult[]
}
```

**契约可修订，且修订台账持久化**（captain-only，通过后冻结）：

<!-- src: src/types.ts:137-149 -->

```ts
/** One captain-only contract amendment recorded on a quality task. */
export interface TaskRevision {
  /** Epoch ms when the amendment was applied. */
  at: number
  /** Identity that applied it (`captain`). */
  by: string
  /** Why the previous contract was wrong; kept for the audit trail. */
  reason: string
  /** Amended contract field names (`objective`, `acceptance`, …). */
  fields: string[]
  /** Previous values of the amended fields; fields absent before are omitted. */
  previous: Record<string, unknown>
}
```

**结论（维度三）**：`objective / inScope / outOfScope / acceptance / verify / kind / round / findings / acceptanceResults / commandsRun / changedPaths / revisions` **全部**写入 `team.json` 并跨轮次、跨重启持久化；它们既是 gate 判据，也是**每轮重新注入模型上下文的载荷**。`output` 是唯一被下游引用的结果字段（见 §4.1）。

---

## 4. 维度四：状态与计划存储（working memory）

### 4.1 目录结构

<!-- src: src/state.ts:1-14 -->

```ts
/**
 * Team state persistence and pure team-logic rules.
 *
 * State lives on disk under `<workspace>/<stateDir>/<teamId>/`:
 * - `team.json` — the durable {@link TeamState} record
 * - `inbox/<agentKey>.jsonl` — one JSONL mailbox per agent (`captain` or a
 *   member name), mirroring the Claude Code AgentTeams mailbox layout
 *
 * All mutations run through an in-process per-team queue so read-modify-write
 * stays serial; `fs/promises` is used directly because the plugin owns this
 * bookkeeping (host-plane state, like session persistence) and the abstract
 * `fs` service offers no directory deletion.
 * @module dsh-agent-teams/state
 */
```

默认 `stateDir = '.agent-teams'`（`src/index.ts:195`：`stateDir: config.stateDir ?? '.agent-teams',`）。另有一个 state root 级文件：

<!-- src: src/state.ts:55-56 -->

```ts
/** Durable deny-list for AgentTeams members that must never be resumed. */
const RETIRED_MEMBERS_FILE = 'retired-members.json'
```

归档（而非删除）整个团队目录，历史任务图与邮箱可回看：

<!-- src: src/state.ts:1152-1157 -->

```ts
/**
 * Archive a team instead of deleting it: the whole directory (team.json with
 * tasks and dependency graph, plus the mailboxes) moves under
 * `<stateRoot>/archive/<teamId>/` so later sessions can review how tasks were
 * planned and rebuild dependency relationships. The archive directory has no
 * team.json of its own, so the live activity scan skips it naturally.
```

### 4.2 是否充当 working memory

**是，且是权威源（truth source）**——面板与工具都以磁盘状态为准，即使模型漏调工具也不失真：

<!-- src: src/snapshot.ts:1-9 -->

```ts
/**
 * Team activity snapshot assembly for the activity panel.
 *
 * Server-side assembly mirrors the Claude Code desktop teamWatcher: read the
 * durable team files (the truth source) and enrich with live subagent
 * activity, so the panel always reflects the on-disk state even when a model
 * skipped a tool "ritual" (e.g. not calling update_task on completion).
 * @module dsh-agent-teams/snapshot
 */
```

它作为"工作记忆"的模型可读面是 `agent_teams_status` 的紧凑文本渲染（并为 captain 做容量裁剪，见 §5）。

**重要限制**：`team.json`/mailbox 是**任务与协调**的 working memory，**不是成员对话上下文的替代**。成员被唤醒时并未被要求"读 team.json 再继续"，而是续用同一个 durable session（§1.1）。

---

## 5. 维度五：成员被唤醒时看到的上下文边界

### 5.1 新 turn 携带全部历史 —— 由【harness】决定，插件不做裁剪

成员的下一个 turn 通过宿主 inbox 队列/steer 进入同一个 durable session（§2.1）；插件在 `agent/pre-step` 只做**准入判定**（是否已退休、是否 staged/halted、是否 reassigning），**不重写、不缩短**历史：

<!-- src: src/members.ts:644-654 -->

```ts
    const disposeAdmission = childCtx.on('agent/pre-step', async (payload, next) => {
      if (payload.agent.id !== child.id) return next()
      const admitted = await withTeamLock(`team:${stateRoot}:${teamId}`, async () => {
        const team = await readTeam(stateRoot, teamId)
        return team?.captainSessionId === parentSessionId && team.phase !== 'staged' && team.halted !== true
          && team.members.some(member => member.id === child.id && member.name === memberName && member.status !== 'removed' && member.stopping !== true)
          && !team.tasks.some(task => task.reassigning === true && task.assignee === memberName)
      })
      if (!admitted) return { kind: 'reject' }
      return next()
    })
```

### 5.2 插件自有的"裁剪"是**确定性字符串截断**，逐处列出

| 对象 | 上限 | 证据 |
|---|---|---|
| 单条 dependency output | 2000 字符 | `src/scheduler.ts:40-43` |
| dependency outputs 合计 | 12000 字符（超出则**丢最旧的**条目，不摘要） | `src/scheduler.ts:41-43`, `src/scheduler.ts:163-171` |
| `agent_teams_status` 里的 task output | 300 字符 | `src/tools.ts:2842` |
| captain inbox / member inbox 条数 | 10 条 | `src/tools.ts:2405`, `src/tools.ts:2416` |
| member inbox 最新消息预览 | 200 字符 | `src/tools.ts:2361` |
| profile protocol（status 视图） | 240 字符 | `src/tools.ts:2398` |
| persona protocol（角色提示） | 400 字符 | `src/members.ts:30-31`, `src/members.ts:776-780` |
| spawn 失败原因回显 | 400 字符 | `src/tools.ts:2835` |
| member inbox 渲染预览 | 120 字符 | `src/tools.ts:2868` |

<!-- src: src/scheduler.ts:40-43 -->

```ts
/** Per-dependency output cap in the assignment prompt. */
export const DEPENDENCY_OUTPUT_MAX_CHARS = 2_000
/** Combined dependency-output budget in the assignment prompt. */
export const DEPENDENCY_OUTPUTS_TOTAL_MAX_CHARS = 12_000
```

<!-- src: src/scheduler.ts:163-171 -->

```ts
  let selected = formatted
  while (selected.length > 1 && selected.join('\n').length > DEPENDENCY_OUTPUTS_TOTAL_MAX_CHARS) {
    selected = selected.slice(1)
  }
  const last = selected[0]
  if (selected.length === 1 && last !== undefined && last.length > DEPENDENCY_OUTPUTS_TOTAL_MAX_CHARS) {
    selected = [`${last.slice(0, DEPENDENCY_OUTPUTS_TOTAL_MAX_CHARS)} [truncated]`]
  }
  return selected.join('\n')
```

<!-- src: src/members.ts:30-31 -->

```ts
/** Persona snapshot of a profile protocol; the full text lives on team.json. */
export const PERSONA_PROTOCOL_MAX_CHARS = 400
```

<!-- src: src/members.ts:776-780 -->

```ts
function truncatedPersonaProtocol(protocol: string | undefined): string {
  if (protocol === undefined || protocol.trim() === '') return '(none)'
  if (protocol.length <= PERSONA_PROTOCOL_MAX_CHARS) return protocol
  return `${protocol.slice(0, PERSONA_PROTOCOL_MAX_CHARS)}… [truncated]`
}
```

<!-- src: src/tools.ts:2842 -->




```ts
      const output = task.output !== undefined ? `\n      output: ${task.output.slice(0, 300)}` : ''
```

**结论（维度五）**：成员新 turn 的历史边界由 harness 控制（durable session 续用，插件不裁剪成员对话历史）；插件只裁剪**自己生成的文本载荷**，且统一采用"截断 + `[truncated]` 显式标记"，不做无标记丢弃。

### 5.3 输入侧的"显式化"设计：旧/新工作单必须自证新鲜度

<!-- src: src/scheduler.ts:222-224 -->

```ts
  const staleWorkOrder = workOrderWarnings.length === 0
    ? ''
    : `\nBefore you edit anything: this auto-generated work order was derived from a workspace that has since changed.\n${workOrderWarnings.map((warning) => `- ${warning}`).join('\n')}\nRe-read the cited files first, locate the code by content anchor rather than by any position, and report a blocker instead of editing a target that no longer exists.\n`
```

---

## 6. 维度六：插件是否自研压缩 / 摘要 / 笔记 / 历史检索

### 6.1 未实现（明确结论，非推测）

- **压缩（compaction）**：未实现。`src/**` 全仓无 `compact` / `compaction` 调用（§7 命令可复核），也没有 `@deepseek-ai/dsh-compaction*` 依赖。
- **摘要（summarization）**：未实现。没有任何为压缩历史而发起的 LLM 调用；唯一的"总结"是 captain 或成员自己写的 `output` 字段，属于任务结果而非上下文压缩。
- **笔记（notes）**：未实现独立笔记文件。最接近的是 `TaskEvidence.note`（终态任务的追加式观察，§3.2）与 `supplementalEvidence`，它们是**证据记录**，不是供模型回读的语境笔记。
- **历史检索（history retrieval）**：未实现。插件不查询会话历史来重建上下文；它只读 `team.json` / mailbox。对 harness session 事件的读取只有两类用途：取 subagent descriptor / 判断 turn 是否已 step/start，以及把团队事件 `session.append` 进 captain 会话日志用于 UI。

<!-- src: src/harness-compat.ts:122-129 -->

```ts
/** Read child-owned history, excluding any descriptor inherited from a parent. */
export function sessionOwnEvents(session: Session): readonly SessionEvent[] {
  const current = session as unknown as { ownEvents?: () => readonly SessionEvent[] }
  if (typeof current.ownEvents === 'function') return current.ownEvents.call(session)
  const legacy = session as unknown as { events?: readonly SessionEvent[]; header: { seedLength?: number } }
  if (!Array.isArray(legacy.events)) return unsupported('missing ownEvents/legacy session log')
  return legacy.events.slice(legacy.header.seedLength ?? 0)
}
```

### 6.2 依赖边界：【harness】负责上下文生命周期，【插件】负责工作状态

**harness 侧证据（本机实际安装，非仓库）**：`D:\Dev\Path\nodejs_25.0.0\npm-cache\_npx\1e7f6d9597241db0\node_modules\@deepseek-ai\` 下存在 `dsh-compaction`、`dsh-compaction-basic`（package description: `Token-meter-driven compaction policy and LLM summarization backend for the DeepSeek Harness`）、`dsh-compaction-tool-result-pruner`（`Replay-safe model-free head/middle/tail pruning for tool-result surface nodes`）、`dsh-command-compact`，版本均为 `0.2.0-rc.2`。

**插件的显式设计立场（仓库内文档，非插件代码）**：

`docs/compatibility-audit-2026-09-05/issues.md:39`（逐字）：

```
| [#114 长任务上下文膨胀](https://github.com/NanmiCoder/dsh-agent-teams/issues/114) · open | durable/continuable members；未给版本 | 功能建议：上下文生命周期 | **明确设计需求**，未提供具体版本回归 | 先确认宿主原生 compaction 能力和继承行为，插件负责传递当前任务/attempt等工作状态，避免实现第二套压缩引擎 |
```

`docs/issue-maintenance-2026-10-10/README.md:94`（逐字节选）：

```
| #114/#162 context lifecycle | defer pending a concrete workload | Existing host compaction and preset composition must be tested with a specified threshold/workload; automatic context rollover would alter durable member identity and task recovery |
```

`docs/progressive-loading.md:19`（逐字；说明核心规则不依赖工具结果/会话历史，因此历史被压缩后仍可读到规则）：

<!-- src: docs/progressive-loading.md:19-19 -->



```
核心规则不依赖工具结果，因此旧 13 工具白名单可以直接规划，代码模式丢弃返回值、结果被裁剪或会话历史被压缩后仍能读到规则。HMR 清理插件资源并恢复会话身份；部署新版本或修改配置本身可能改变前缀，稳定性约束针对同一版本和配置下的业务生命周期。
```

该"固定前缀"的实现位置（系统提示 section，不随业务状态重写）：

<!-- src: src/capabilities.ts:101-106 -->

```ts
  ctx.systemPrompt.section({
    name: 'agent-teams:usage', order: config.order ?? 117,
    text: ({ agent }) => {
      return agent !== undefined && states.get(agent)?.member ? TEAM_MEMBER_PROMPT : captainPrompt
    },
  })
```

<!-- src: src/capabilities.ts:56-59 -->

```ts
  let mounted = true
  // Snapshot policy once: profiles, team state, and tool results must never
  // rewrite this prefix or control whether core instructions are available.
  const captainPrompt = `${TEAM_ACTIVATION_PROMPT}\n\n${config.captainPrompt()}`
```

**边界总结表**

| 关注点 | 归属 | 依据 |
|---|---|---|
| 成员对话历史的存储、窗口、压缩、工具结果裁剪 | 【harness】 | 插件无 compaction 依赖/调用（§6.1）；宿主已装载 compaction 家族（§6.2） |
| 成员 turn 的排队、唤醒、冷恢复 | 【harness】原语 + 【插件】策略 | `startContinuable` / `followup` / `deliverPrompt` 由宿主提供（`src/harness-compat.ts:191-227`），何时派发由插件 scheduler 决定 |
| 任务/attempt/契约/证据的持久化 | 【插件】 | `src/state.ts`, `src/types.ts` |
| 派发载荷、mailbox 消息、状态渲染 | 【插件】（含确定性截断） | `src/scheduler.ts:210-269`, `src/mailbox.ts`, `src/tools.ts:2785-2877` |
| 历史检索 / 笔记 / 摘要 | **两端均无（插件未实现）** | §6.1 |

---

## 7. 可复核命令

```text
# 版本与只读性
git -C I:\VMsShare\_src-compare\dsh-agent-teams rev-parse HEAD     # 1094b84add6f2fb19edf659367fe2fd5f7f14154
git -C I:\VMsShare\_src-compare\dsh-agent-teams status --porcelain # 空

# 插件未实现压缩（应无输出）
rg -n "compaction|dsh-compaction" I:\VMsShare\_src-compare\dsh-agent-teams\src

# 宿主侧压缩能力（本机安装）
Get-ChildItem "D:\Dev\Path\nodejs_25.0.0\npm-cache\_npx\1e7f6d9597241db0\node_modules\@deepseek-ai" -Filter "dsh-compaction*"
```

---

## 8. 未验证 / 未实现（诚实边界）

- **未验证**：continuable member 在宿主 `dsh-compaction-basic` 下**实际继承的压缩阈值与行为**（阈值/保留比、成员会话是否与 captain 使用同一 policy）。本轮只证明插件侧没有第二套引擎、宿主已装载该能力；插件文档本身也把该验证列为待办（`docs/issue-maintenance-2026-10-10/README.md:94`）。
- **未实现**：插件级压缩、摘要、笔记、历史检索（§6.1）。
- 本文档的 `src/**` 引用基于 commit `1094b84a`；仓库若前进，行号需重新取证。
