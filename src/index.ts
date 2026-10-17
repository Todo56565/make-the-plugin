/**
 * dsh-token-budget：@nanmicoder/dsh-agent-teams 的补丁插件。
 *
 * 宿主层插件（与 agent-teams 同层），只作用于团队会话：
 * - 换窗交接（0.3.0）：成员 37% 起提醒、45% 先兜底（补记笔记）再换窗，队长只提醒两次；
 *   换窗不发摘要请求，摘要位置换成【交接】（接管 compaction 引擎的 summarize()）；context_new_window 工具
 * - notes：成员笔记与共享 workspace.md（开关 `notes`）
 * - history：只读历史工具（开关 `history`）
 * - teamHistory：团队信件回看工具 team_history（开关 `teamHistory`）
 *
 * 权威设计：docs/design/plugin-design.md、docs/design/0.3.0-handoff.md
 *
 * @module dsh-token-budget
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CompactionEngine } from '@deepseek-ai/dsh-compaction'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import { Config, refreshSettings, toSettings, validateConfig, type Settings } from './config.ts'
import { TeamDirectory, isTeamEvent } from './team/directory.ts'
import { registerWindowCounter, windowOf, type WindowInfo } from './window/counter.ts'
import { SwitchStates, decide, freshnessOf, newWindowVerdict, ownNoteStateOf, type Freshness, type SwitchReason } from './window/state.ts'
import { registerNewWindowTool } from './window/new-window-tool.ts'
import { captainLevels, levelOf, memberLevels, usageOf } from './budget/usage.ts'
import { FALLBACK_PROMPT, captainReminderText, memberReminderText } from './budget/reminder.ts'
import { registerContextRemainingTool } from './budget/tool.ts'
import { CompactionGate, compactionEngineOf, releaseSummarize, takeOverSummarize } from './budget/compact.ts'
import { TEAM_NOTES_TOOL, createStoreCache, registerTeamNotesTool } from './notes/tool.ts'
import { ownNotePath } from './notes/paths.ts'
import { sessionRef, snapshotOnWindowSwitch } from './notes/snapshot.ts'
import { TeamToolCalls, mergePendingBatch, type Generate } from './notes/merge.ts'
import { recordTerminalTasks, type LocateMember } from './records/full.ts'
import { listPendingTeams } from './notes/pending.ts'
import { listTeams } from './team/team-file.ts'
import { stateRootOf, type TeamIdentity } from './team/identity.ts'
import { FrozenText, NOTES_SECTION_ORDER, notesSectionText } from './prompt/notes-section.ts'
import { handoffText, initialHandoffText, listNoteMetasSync, ownNoteMtime, type OwnNoteState } from './prompt/handoff.ts'
import { HistorySource } from './history/source.ts'
import { positionAt } from './history/model.ts'
import { registerHistoryTools } from './history/tools.ts'
import { registerTeamHistoryTool } from './team-history/tool.ts'

export { Config }
export const name = 'dsh-token-budget'
/**
 * 依赖（设计 §2.2）：
 * - `agentPresets`：经 `serviceFor(agent, 'compaction')` 取 preset 内的压缩引擎（§2.4）
 * - `sessions` / `sessionPersistence`：history 读取前先 `sessions.flush(session)`，再只读打开日志（§4.4）
 * - `llm` 只供可选的 notesMerge 使用，在调用时用 `ctx.get('llm')` 读取，不列入 inject：
 *   cordis 4 的 inject 没有 optional 写法，列进去 llm 就会成为整插件的启动前提
 * 绝不能出现 'compaction'：宿主层没有该服务（§3.2）
 */
export const inject = ['systemPrompt', 'tools', 'tokenMeter', 'sessionProjections', 'agents', 'agentPresets', 'sessions', 'sessionPersistence']

/** 预算提示 context 的顺序：排在 SUBAGENT_DELEGATION(120) 之后。 */
const BUDGET_CONTEXT_ORDER = 130
const BUDGET_CONTEXT_NAME = 'dsh-token-budget:budget'
/** w1 精简交接 context 的顺序。 */
const HANDOFF_CONTEXT_ORDER = 140
const HANDOFF_CONTEXT_NAME = 'dsh-token-budget:handoff'

export function apply(ctx: Context, raw: Config): void {
  const config = toSettings(raw)
  const logger = ctx.logger('dsh-token-budget')
  for (const problem of validateConfig(config)) logger.warn(problem)
  // 设置页保存 ⇒ 宿主 volatile HMR，不重启插件：原地刷新配置。
  // 能力开关（notes / history / teamHistory / contextTool）也即时生效：按开关注册或注销对应工具。
  const switches: Array<() => void> = []
  ctx.on('loader/volatile-update', () => {
    refreshSettings(config, raw)
    for (const problem of validateConfig(config)) logger.warn(problem)
    for (const sync of switches) sync()
  })
  /** 注册一项可开关的能力：开关打开时注册、关闭时注销；返回值用于启动时同步一次。 */
  const switchable = (label: string, enabled: () => boolean, register: () => () => void): void => {
    let dispose: (() => void) | undefined
    const sync = (): void => {
      if (enabled() && dispose === undefined) {
        dispose = ctx.effect(register, label)
      } else if (!enabled() && dispose !== undefined) {
        dispose()
        dispose = undefined
      }
    }
    switches.push(sync)
    sync()
  }

  const teams = new TeamDirectory(config.stateDir, message => logger.warn(message))
  const gate = new CompactionGate()
  /** 换窗状态，按会话 id 存（成员 Agent 每轮重建，不能挂在实例上）。 */
  const states = new SwitchStates()
  /** 正在进行的插件换窗原因（summarize() 据此写「你的笔记」一行）。 */
  const switching = new Map<string, SwitchReason>()
  const sections = new FrozenText()
  const initialHandoffs = new FrozenText()
  /** 已告警过「取不到压缩引擎」的会话。 */
  const engineMissingWarned = new Set<string>()
  /** history 读取源；会话结束时释放修订缓存。 */
  const historySource = new HistorySource(() => ctx.sessionPersistence)
  // 终态快照坐标：读成员会话日志，取任务 updatedAt 之前的最后一个条目
  const locateMember = async (sessionId: string, until: number | undefined): Promise<string | undefined> => {
    const position = positionAt(await historySource.load(sessionId), until)
    return position === undefined ? undefined : sessionRef(sessionId, position.window, position.seq)
  }

  // 窗口投影（history 模型口径）
  ctx.effect(() => registerWindowCounter(ctx), 'dsh-token-budget: window projection')

  // 团队状态变化 ⇒ 清空身份缓存
  // 当前宿主不写 agent-teams/* 事件，所以同时以 agent_teams_* 工具调用返回为信号
  const teamCalls = new TeamToolCalls()
  ctx.on('session/event', (session, event) => {
    const returned = teamCalls.handle(session.id, event.type, (event as { data?: unknown }).data)
    if (returned || isTeamEvent(event.type)) teams.invalidate()
  })
  // 换窗状态、冻结文本不在这里清：成员 Agent 每轮结束都会 disposed，同一会话 id 下一轮再建
  ctx.on('agent/disposed', ({ agent }) => {
    teams.forget(agent.id)
    engineMissingWarned.delete(agent.id)
    const sessionId = (agent as { session?: { id?: string } }).session?.id
    if (sessionId !== undefined) historySource.forget(sessionId)
  })

  const windowFor = (agent: Agent): WindowInfo =>
    windowOf(ctx, agent.session) ?? { index: 1, startTime: agent.session.header.createdAt }
  /** 该会话现在能不能写笔记：notes 开着，且 team_notes 对它可见（tool_policy 可能裁掉）。 */
  const canWriteNotes = (agent: Agent): boolean => {
    if (!config.notes) return false
    try {
      return ctx.tools.get(TEAM_NOTES_TOOL, agent as never) !== undefined
    } catch {
      return true
    }
  }
  const freshness = (agent: Agent, identity: TeamIdentity, window: WindowInfo): Freshness => freshnessOf({
    window: window.index,
    windowStart: window.startTime,
    mtimeMs: ownNoteMtime(identity),
    lastWrite: states.peek(agent.id)?.lastWrite,
  })

  // ── 接管 summarize()：团队会话返回【交接】，零 LLM 请求 ──
  const patchedEngines = new Set<CompactionEngine>()
  ctx.effect(() => () => {
    for (const engine of patchedEngines) releaseSummarize(engine)
    patchedEngines.clear()
  }, 'dsh-token-budget: summarize takeover')

  /** 生成换窗时的【交接】；不是团队会话返回 undefined（走原摘要）。 */
  const handoffFor = (owner: Agent): string | undefined => {
    const identity = teams.reload(owner)
    if (identity === undefined) return undefined
    const window = windowFor(owner)
    const reason = switching.get(owner.id)
    let own: OwnNoteState = { kind: 'stale' }
    try {
      const fallback = states.peek(owner.id)?.fallback
      const startedAt = fallback !== undefined && fallback.window === window.index ? fallback.startedAt : undefined
      own = ownNoteStateOf(freshness(owner, identity, window), startedAt, reason)
    } catch { /* 当作未更新 */ }
    let metas: ReturnType<typeof listNoteMetasSync> = []
    try {
      if (config.notes) metas = listNoteMetasSync(identity)
    } catch { /* 元数据缺失不影响交接 */ }
    const text = handoffText({
      identity,
      previousWindow: window.index,
      own,
      metas,
      notes: config.notes,
      history: config.history,
      teamHistory: config.teamHistory,
      recentNotes: config.notesOptions.hintRecentNotes,
      maxBytes: config.notesOptions.hintMaxBytes,
    })
    logger.info(`会话 ${owner.id}（${identity.agentKey}）换窗：w${window.index} → w${window.index + 1}，原因 ${reason ?? 'host'}，笔记 ${own.kind}`)
    if (config.notes) {
      try {
        const seq = Number(owner.session.seq) - 1
        for (const pending of snapshotOnWindowSwitch(identity, sessionRef(owner.session.id, window.index, seq))) {
          pending.catch(error => logger.warn(`成员笔记快照失败：${String(error)}`))
        }
      } catch (error) {
        logger.warn(`成员笔记快照失败：${String(error)}`)
      }
    }
    return text
  }
  const summaryOverride = (owner: Agent): string | undefined => {
    try {
      return handoffFor(owner)
    } catch (error) {
      // 交接生成失败也不退回 LLM 摘要：团队会话给最小交接
      logger.warn(`换窗交接生成失败：${String(error)}`)
      try {
        if (teams.identityOf(owner, true) === undefined) return undefined
      } catch {
        return undefined
      }
      return `【交接】\n上一窗口：w${windowFor(owner).index}，交接信息生成失败；进展先读自己的笔记，再用 history_* 回看。`
    }
  }
  const engineFor = (agent: Agent): CompactionEngine | undefined => {
    const engine = compactionEngineOf(ctx, agent)
    if (engine === undefined) return undefined
    takeOverSummarize(engine, summaryOverride)
    patchedEngines.add(engine)
    return engine
  }

  // ── 预算提醒 / 兜底提示（runtime context）──
  const budgetText = (assembly: { agent?: Agent }): string => {
    const agent = assembly.agent
    if (agent === undefined) return ''
    try {
      const identity = teams.identityOf(agent)
      if (identity === undefined) return ''
      const usage = usageOf(ctx, agent.session)
      if (usage === undefined) return ''
      const { remindAtRatio, compactAtRatio, bucketStep } = config.budget
      if (identity.role === 'captain') {
        const level = levelOf(usage.ratio, captainLevels(compactAtRatio, bucketStep))
        return level === undefined ? '' : captainReminderText(level, config.notes)
      }
      const state = states.peek(agent.id)
      if (state?.fallback !== undefined && state.fallback.window === windowFor(agent).index) return FALLBACK_PROMPT
      const levels = memberLevels(remindAtRatio, compactAtRatio, bucketStep)
      const level = levelOf(usage.ratio, levels)
      if (level === undefined) return ''
      return memberReminderText({ level, first: level === levels[0], compactAtRatio, notes: config.notes })
    } catch (error) {
      // text() 在组装内同步执行，抛错会让整步失败：一律吞掉并告警
      logger.warn(`预算提示生成失败：${String(error)}`)
      return ''
    }
  }
  ctx.effect(() => ctx.systemPrompt.context({
    name: BUDGET_CONTEXT_NAME,
    order: BUDGET_CONTEXT_ORDER,
    text: budgetText,
  }), 'dsh-token-budget: budget context')

  // ── w1 精简交接：每会话只算一次，换窗后由摘要位置的完整交接取代 ──
  const initialHandoff = (assembly: { agent?: Agent }): string => {
    const agent = assembly.agent
    if (agent === undefined) return ''
    try {
      if (windowFor(agent).index !== 1) return ''
      const identity = teams.identityOf(agent)
      if (identity === undefined) return ''
      const key = `${agent.id}:${config.notes}:${config.teamHistory}`
      return initialHandoffs.get(key, () => initialHandoffText(identity, {
        notes: config.notes, history: config.history, teamHistory: config.teamHistory,
      }, config.notesOptions.hintMaxBytes))
    } catch (error) {
      logger.warn(`w1 交接生成失败：${String(error)}`)
      return ''
    }
  }
  ctx.effect(() => ctx.systemPrompt.context({
    name: HANDOFF_CONTEXT_NAME,
    order: HANDOFF_CONTEXT_ORDER,
    text: initialHandoff,
  }), 'dsh-token-budget: initial handoff')

  // ── 常驻说明：只放规则，每会话冻结一次 ──
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'dsh-token-budget:notes',
    order: NOTES_SECTION_ORDER,
    text: (assembly) => {
      const agent = assembly.agent
      if (agent === undefined) return ''
      try {
        return sections.get(`${agent.id}:${config.notes}:${config.history}`, () => {
          const identity = teams.identityOf(agent)
          return identity === undefined ? undefined : notesSectionText(identity.role, { notes: config.notes, history: config.history })
        })
      } catch (error) {
        logger.warn(`常驻说明生成失败：${String(error)}`)
        return ''
      }
    },
  }), 'dsh-token-budget: rules section')

  // ── notes：工具（开关 notes，即时生效）──
  const storeFor = createStoreCache(() => config.notesOptions.maxFileBytes, () => config.notesOptions.workspaceMaxBytes, () => ({ keep: config.notesOptions.workspaceSnapshotKeep }))
  registerNotesMerge(ctx, config, storeFor, logger, locateMember)
  switchable('dsh-token-budget: team_notes tool', () => config.notes, () => registerTeamNotesTool(ctx, {
    identityOf: agent => teams.identityOf(agent, true),
    storeFor,
    maxResults: config.historyOptions.maxResults,
    readMaxBytes: () => config.notesOptions.readMaxBytes,
    onWrite: (agent, identity, meta) => {
      if (meta.path !== ownNotePath(identity.team.id, identity.fileKey)) return
      states.recordWrite(agent.id, windowFor(agent).index, Date.now())
    },
  }))

  // ── context_new_window：随时可调；没写笔记时每窗口拒绝一次 ──
  ctx.effect(() => registerNewWindowTool(ctx, {
    request: (agent) => {
      const identity = teams.identityOf(agent, true)
      if (identity === undefined) throw new Error('当前会话不属于任何 AgentTeams 团队，context_new_window 不可用')
      const window = windowFor(agent)
      const state = states.settle(agent.id, window.index)
      const verdict = newWindowVerdict({
        window: window.index,
        fresh: freshness(agent, identity, window).fresh,
        canWriteNotes: canWriteNotes(agent),
        state,
      })
      if (verdict === 'refuse') {
        state.refused = window.index
        logger.info(`会话 ${agent.id}（${identity.agentKey}）请求换窗被拒（w${window.index} 未写笔记）`)
      } else {
        state.newWindow = window.index
        logger.info(`会话 ${agent.id}（${identity.agentKey}）请求换窗（w${window.index}）`)
      }
      return verdict
    },
  }), 'dsh-token-budget: context_new_window tool')

  // ── history：只读历史工具（设计 §4.4；开关 history，即时生效）──
  switchable('dsh-token-budget: history tools', () => config.history, () => registerHistoryTools(ctx, {
    isTeamAgent: agent => teams.identityOf(agent, true) !== undefined,
    load: (agent, signal) => historySource.load(agent.session.id, signal, () => ctx.sessions.flush(agent.session)),
    limits: () => config.historyOptions,
  }))

  // ── team_history：团队信件回看（设计 §4.3；开关 teamHistory，即时生效）──
  switchable('dsh-token-budget: team_history tool', () => config.teamHistory, () => registerTeamHistoryTool(ctx, {
    identityOf: agent => teams.identityOf(agent, true),
    limits: () => config.historyOptions,
  }))

  // ── context_remaining 工具（设计 §4.1；开关 contextTool，即时生效）──
  switchable('dsh-token-budget: context_remaining tool', () => config.budget.tool, () => registerContextRemainingTool(ctx, {
    isTeamAgent: agent => teams.identityOf(agent, true) !== undefined,
    usage: agent => usageOf(ctx, agent.session),
    compactAtRatio: () => config.budget.compactAtRatio,
  }))

  // ── 换窗 ──
  /** 用插件路径换窗；返回是否真的换了。 */
  const switchWindow = async (agent: Agent, signal: AbortSignal, window: WindowInfo, reason: SwitchReason, ratio: number): Promise<boolean> => {
    const key = `${window.index}:${reason}`
    if (!gate.canAttempt(agent.id, key)) return false
    const engine = engineFor(agent)
    if (engine === undefined) {
      // 该 agent 的 preset 没装压缩，或 serviceFor 暂时取不到：不消耗尝试次数，下一步再取；告警按会话只打一次
      if (!engineMissingWarned.has(agent.id)) {
        engineMissingWarned.add(agent.id)
        logger.warn(`会话 ${agent.id} 需要换窗（${reason}，已用 ${(ratio * 100).toFixed(1)}%），但取不到压缩引擎（该 preset 未装压缩或暂未就绪），之后每步重试`)
      }
      return false
    }
    engineMissingWarned.delete(agent.id)
    gate.begin(agent.id, key)
    switching.set(agent.id, reason)
    try {
      const result = await engine.compactIfNeeded(agent, 'context-overflow', signal)
      if (result === null) logger.info(`会话 ${agent.id} 需要换窗（${reason}），但没有可压缩的范围`)
      return result !== null
    } catch (error) {
      logger.warn(`换窗失败，继续本步：${error instanceof Error ? error.message : String(error)}`)
      return false
    } finally {
      switching.delete(agent.id)
      gate.end(agent.id)
      // 无论成败，本窗口的请求都已处理：失败时不再每步重试，宿主约 80% 自动压缩兜底
      const state = states.peek(agent.id)
      if (state !== undefined) {
        if (state.newWindow === window.index) delete state.newWindow
        if (state.fallback?.window === window.index) delete state.fallback
      }
    }
  }

  /** 每步组装前：决定是否换窗 / 进入兜底；返回本步是否换了窗。 */
  const beforeAssemble = async (agent: Agent, signal: AbortSignal): Promise<boolean> => {
    if (signal.aborted || gate.isRunning(agent.id)) return false
    const identity = teams.identityOf(agent)
    if (identity === undefined) return false
    engineFor(agent) // 尽早接管 summarize()：宿主自动压缩也要走模板
    const usage = usageOf(ctx, agent.session)
    if (usage === undefined) return false
    const window = windowFor(agent)
    const state = states.settle(agent.id, window.index)
    const decision = decide({
      role: identity.role,
      window: window.index,
      ratio: usage.ratio,
      pressure: usage.pressure,
      compactAtRatio: config.budget.compactAtRatio,
      fallbackBufferTokens: config.budget.fallbackBufferTokens,
      canWriteNotes: canWriteNotes(agent),
      turn: signal,
      state,
    })
    switch (decision.kind) {
      case 'none':
        return false
      case 'enter-fallback':
        state.fallback = { window: window.index, startedAt: Date.now(), deadline: decision.deadline, turn: signal }
        logger.info(`会话 ${agent.id}（${identity.agentKey}）已用 ${(usage.ratio * 100).toFixed(1)}%，到换窗点，进入兜底（额度到 ${decision.deadline} token）`)
        return false
      case 'compact':
        return switchWindow(agent, signal, window, decision.reason, usage.ratio)
    }
  }

  // 在 system-prompt/assemble 里换窗：宿主每步先组装（runtime context 的 text() 只在这里求值一次），
  // 再跑 agent/pre-step；换窗后就地重算本插件的 context，避免新窗口第一步带着旧提示。
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const agent = context.agent
    const signal = context.signal
    let switched = false
    let fallbackBefore = false
    if (agent !== undefined) {
      fallbackBefore = states.peek(agent.id)?.fallback !== undefined
      if (signal !== undefined) switched = await beforeAssemble(agent, signal)
    }
    const assembly = await next()
    if (agent === undefined) return assembly
    // 进入兜底那一步：预算 context 已在 next() 里按新状态求值；换窗那一步要重算
    if (!switched && fallbackBefore === (states.peek(agent.id)?.fallback !== undefined)) return assembly
    return {
      ...assembly,
      contexts: assembly.contexts.map(entry => entry.name === BUDGET_CONTEXT_NAME
        ? { ...entry, text: budgetText(context) }
        : entry.name === HANDOFF_CONTEXT_NAME
          ? { ...entry, text: initialHandoff(context) }
          : entry),
    }
  })
}

/** 合并单次调用超时。 */
const MERGE_TIMEOUT_MS = 120_000

/** notesMerge：成员任务完成时，把其笔记合并进 workspace.md（开关与模型即时生效）。 */
function registerNotesMerge(
  ctx: Context,
  config: Settings,
  storeFor: ReturnType<typeof createStoreCache>,
  logger: ReturnType<Context['logger']>,
  locateMember: LocateMember,
): void {
  const lifetime = new AbortController()
  ctx.effect(() => () => lifetime.abort(), 'dsh-token-budget: notes merge lifetime')

  const generate: Generate = async (system, prompt, signal) => {
    const { provider, model, reasoningEffort } = config.notesMerge
    if (provider === undefined || model === undefined) throw new Error('未选择合并模型')
    const llm = ctx.get('llm')
    if (llm === undefined) throw new Error('宿主未提供 llm 服务')
    const options: GenerateOptions = {
      provider,
      model,
      system,
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      signal,
    }
    if (reasoningEffort !== undefined) options.reasoningEffort = reasoningEffort as GenerateOptions['reasoningEffort']
    let text = ''
    for await (const chunk of llm.stream(options)) {
      if (chunk.type === 'text-delta') text += chunk.text
      else if (chunk.type === 'finish' && chunk.reason.kind !== 'stop') {
        // max-tokens 也视为失败：截断的共享笔记不能写回
        const failure = 'failure' in chunk.reason ? `：${JSON.stringify(chunk.reason.failure).slice(0, 300)}` : ''
        throw new Error(`模型调用未正常结束（${chunk.reason.kind}）${failure}`)
      }
    }
    return text
  }

  const calls = new TeamToolCalls()
  /** 已补扫过全文的状态根（插件启动后每个状态根第一次出现时补记一次）。 */
  const scannedRoots = new Set<string>()
  const queue = new Map<string, Promise<void>>()

  ctx.on('session/event', (session, event) => {
    const returned = calls.handle(session.id, event.type, (event as { data?: unknown }).data)
    const stateRoot = stateRootOf(session.header.cwd, config.stateDir)
    const firstSeen = !scannedRoots.has(stateRoot)
    if (!returned && !firstSeen) return
    scannedRoots.add(stateRoot)
    let teams
    try {
      teams = listTeams(stateRoot)
    } catch (error) {
      logger.warn(`全文记录：读取团队状态失败（${stateRoot}）：${String(error)}`)
      return
    }
    // 全文记录始终开启；合并以待合并清单为输入：清单非空就处理（含插件启动前积下的与已结束团队代的）
    void recordTerminalTasks(stateRoot, teams, Date.now(), locateMember).then(written => {
      if (written.length > 0) logger.info(`全文记录：新增 ${written.length} 条（${stateRoot}）`)
      const enabled = config.notes && config.notesMerge.enabled && config.notesMerge.model !== undefined
      if (enabled) scheduleDrain(stateRoot)
    }, (error: unknown) => {
      if (!lifetime.signal.aborted) logger.warn(`全文记录失败（${stateRoot}）：${String(error)}`)
    })
  })

  /** 正在处理的状态根；处理中又被触发则处理完再来一轮。 */
  const draining = new Map<string, { again: boolean }>()

  function scheduleDrain(stateRoot: string): void {
    const running = draining.get(stateRoot)
    if (running !== undefined) {
      running.again = true
      return
    }
    const state = { again: false }
    draining.set(stateRoot, state)
    void (async () => {
      do {
        state.again = false
        await drain(stateRoot)
      } while (state.again && !lifetime.signal.aborted)
    })().catch((error: unknown) => {
      if (!lifetime.signal.aborted) logger.warn(`笔记合并失败（${stateRoot}）：${String(error)}`)
    }).finally(() => draining.delete(stateRoot))
  }

  async function drain(stateRoot: string): Promise<void> {
    for (const team of await listPendingTeams(stateRoot)) {
      for (;;) {
        if (lifetime.signal.aborted || !config.notesMerge.enabled) return
        let result
        try {
          result = await mergePendingBatch({
            stateRoot,
            store: storeFor({ stateRoot, team }),
            team,
            generate,
            signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(MERGE_TIMEOUT_MS)]),
          })
        } catch (error) {
          if (!lifetime.signal.aborted) logger.warn(`笔记合并失败（${team.id}）：${String(error)}`)
          break
        }
        if (result.missing.length > 0) logger.warn(`待合并条目的快照读不到，留给队长处理（${team.id}）：${result.missing.join(', ')}`)
        if (result.outcome === 'busy') return
        if (result.outcome === 'merged') {
          logger.info(`已合并 ${result.resolved.length} 条待合并笔记进 workspace.md（${team.id}）`)
          continue
        }
        if (result.outcome !== 'nothing') logger.warn(`笔记合并未写入（${team.id}）：${result.outcome}`)
        break
      }
    }
  }
}
