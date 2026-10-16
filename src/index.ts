/**
 * dsh-token-budget：@nanmicoder/dsh-agent-teams 的补丁插件。
 *
 * 宿主层插件（与 agent-teams 同层），只作用于团队会话：
 * - token budget：37% 起按档提示（runtime context），45% 主动压缩（方案 D1）
 * - notes：成员笔记与共享 workspace.md（开关 `notes`）
 * - history：只读历史工具（开关 `history`）
 * - teamHistory：团队信件回看工具 team_history（开关 `teamHistory`）
 *
 * 权威设计：docs/design/plugin-design.md
 *
 * @module dsh-token-budget
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import { Config, refreshSettings, toSettings, validateConfig, type Settings } from './config.ts'
import { TeamDirectory, isTeamEvent } from './team/directory.ts'
import { registerWindowCounter, windowOf } from './window/counter.ts'
import { bucketOf, usageOf } from './budget/usage.ts'
import { reminderText } from './budget/reminder.ts'
import { registerContextRemainingTool } from './budget/tool.ts'
import { CompactionGate, compactionEngineOf } from './budget/compact.ts'
import { createStoreCache, registerTeamNotesTool } from './notes/tool.ts'
import { CompletionTracker, TeamToolCalls, mergeMemberNote, type Generate } from './notes/merge.ts'
import { listTeams, sanitizeKey } from './team/team-file.ts'
import { stateRootOf } from './team/identity.ts'
import { FrozenText, NOTES_SECTION_ORDER, notesSectionText } from './prompt/notes-section.ts'
import { HistorySource } from './history/source.ts'
import { registerHistoryTools } from './history/tools.ts'
import { registerTeamHistoryTool } from './team-history/tool.ts'
import { HINT_CONTEXT_ORDER, WindowHintCache, hintText, listNoteMetasSync } from './prompt/hint.ts'
import { FALLBACK_PROMPT, NEW_WINDOW_TOOL, PocState, ownLayerTools, levelOf, noteFreshness, pocLog, pocOptions, registerNewWindowTool, reminderLevels, templateSummary, visibleTools, windowInfoOf } from './poc/poc030.ts'

export { Config }
export const name = 'dsh-token-budget'
/**
 * 依赖（设计 §2.2）：
 * - `agentPresets`：方案 D1 经 `serviceFor(agent, 'compaction')` 取 preset 内的压缩引擎（§2.4）
 * - `sessions` / `sessionPersistence`：history 读取前先 `sessions.flush(session)`，再只读打开日志（§4.4）
 * - `llm` 只供可选的 notesMerge 使用，在调用时用 `ctx.get('llm')` 读取，不列入 inject：
 *   cordis 4 的 inject 没有 optional 写法，列进去 llm 就会成为整插件的启动前提
 * 绝不能出现 'compaction'：宿主层没有该服务（§3.2）
 */
export const inject = ['systemPrompt', 'tools', 'tokenMeter', 'sessionProjections', 'agents', 'agentPresets', 'sessions', 'sessionPersistence']

/** 预算提示 context 的顺序：排在 SUBAGENT_DELEGATION(120) 之后。 */
const BUDGET_CONTEXT_ORDER = 130
const BUDGET_CONTEXT_NAME = 'dsh-token-budget:budget'
const HINT_CONTEXT_NAME = 'dsh-token-budget:hint'

export function apply(ctx: Context, raw: Config): void {
  const config = toSettings(raw)
  const logger = ctx.logger('dsh-token-budget')
  for (const problem of validateConfig(config)) logger.warn(problem)
  // 设置页保存 ⇒ 宿主 volatile HMR，不重启插件：原地刷新配置。
  // 能力开关（notes / history / teamHistory / contextTool）也即时生效：按开关注册或注销对应工具与 section。
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
  const poc = new PocState()
  void gate
  const notesPointer = new FrozenText()
  const hints = new WindowHintCache()
  /** 已告警过「取不到压缩引擎」的会话。 */
  const engineMissingWarned = new Set<string>()
  /** history 读取源；会话结束时释放修订缓存。 */
  const historySource = new HistorySource(() => ctx.sessionPersistence)

  // 窗口计数投影
  ctx.effect(() => registerWindowCounter(ctx), 'dsh-token-budget: window projection')

  // 团队状态变化 ⇒ 清空身份缓存
  // 当前宿主不写 agent-teams/* 事件，所以同时以 agent_teams_* 工具调用返回为信号
  const teamCalls = new TeamToolCalls()
  ctx.on('session/event', (session, event) => {
    const returned = teamCalls.handle(session.id, event.type, (event as { data?: unknown }).data)
    if (returned || isTeamEvent(event.type)) teams.invalidate()
  })
  ctx.on('agent/disposed', ({ agent }) => {
    pocLog({ ev: 'agent-disposed', agent: agent.id })
    teams.forget(agent.id)
    gate.forget(agent.id)
    notesPointer.forget(agent.id)
    hints.forget(agent.id)
    engineMissingWarned.delete(agent.id)
    const sessionId = (agent as { session?: { id?: string } }).session?.id
    if (sessionId !== undefined) historySource.forget(sessionId)
  })

  // ── token budget：提示（runtime context，缓存分支 B）──
  const budgetText = (assembly: { agent?: Agent }): string => {
    const agent = assembly.agent
    if (agent === undefined) return ''
    try {
      if (teams.identityOf(agent) === undefined) return ''
      const usage = usageOf(ctx, agent.session)
      if (usage === undefined) return ''
      // PoC：兜底期间注入兜底提示；否则按 0.3.0 §2 档位规则
      if (poc.fallback.has(agent.id)) return FALLBACK_PROMPT
      if (usage.ratio >= config.budget.compactAtRatio) return ''
      const bucket = levelOf(usage.ratio, reminderLevels(config.budget.remindAtRatio, config.budget.compactAtRatio, config.budget.bucketStep))
      void bucketOf
      if (bucket === undefined) return ''
      return reminderText({ bucket, compactAtRatio: config.budget.compactAtRatio, notes: config.notes }) + '\n记完可调用 context_new_window 自己换窗。'
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

  // ── 窗口 hint：任务 + 笔记元数据，只在窗口变化时重算 ──
  const windowHintText = (assembly: { agent?: Agent }): string => {
    const agent = assembly.agent
    if (agent === undefined) return ''
    try {
      const identity = teams.identityOf(agent)
      if (identity === undefined) return ''
      const key = `${windowOf(ctx, agent.session) ?? 0}:${identity.team.id}`
      return hints.get(agent.id, key, () => hintText({
        identity,
        notes: config.notes,
        history: config.history,
        teamHistory: config.teamHistory,
        metas: config.notes ? listNoteMetasSync(identity) : [],
        recentNotes: config.notesOptions.hintRecentNotes,
        maxBytes: config.notesOptions.hintMaxBytes,
      }))
    } catch (error) {
      logger.warn(`窗口 hint 生成失败：${String(error)}`)
      return ''
    }
  }
  ctx.effect(() => ctx.systemPrompt.context({
    name: HINT_CONTEXT_NAME,
    order: HINT_CONTEXT_ORDER,
    text: windowHintText,
  }), 'dsh-token-budget: window hint')

  // ── notes：工具 + 稳定指针（开关 notes，即时生效）──
  const storeFor = createStoreCache(() => config.notesOptions.maxFileBytes)
  registerNotesMerge(ctx, config, storeFor, logger)
  switchable('dsh-token-budget: team_notes tool', () => config.notes, () => registerTeamNotesTool(ctx, {
    identityOf: agent => teams.identityOf(agent, true),
    storeFor,
    maxResults: config.historyOptions.maxResults,
    onWrite: (identity, meta) => pocLog({ ev: 'note-write', team: identity.team.id, name: identity.agentKey, path: meta.path, bytes: meta.bytes }),
  }))
  ctx.effect(() => registerNewWindowTool(ctx, { identityOf: agent => teams.identityOf(agent, true), state: poc }), 'dsh-token-budget: poc context_new_window')
  switchable('dsh-token-budget: notes section', () => config.notes, () => ctx.systemPrompt.section({
    name: 'dsh-token-budget:notes',
    order: NOTES_SECTION_ORDER,
    text: (assembly) => {
      const agent = assembly.agent
      if (agent === undefined) return ''
      try {
        return notesPointer.get(agent.id, () => {
          const identity = teams.identityOf(agent)
          return identity === undefined ? undefined : notesSectionText(identity)
        })
      } catch (error) {
        logger.warn(`笔记指针生成失败：${String(error)}`)
        return ''
      }
    },
  }))

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

  // ── PoC 0.3.0：压缩点流程（推迟一轮 / 兜底 restrict / 换窗工具 / 模板摘要）──
  // serviceFor() 每次返回新的 cordis 代理，WeakSet 认不出同一实例：标记写在实例上（经代理转发到目标）
  const PATCHED = Symbol.for('dsh-token-budget.poc030.summarize')
  const engineFor = (agent: Agent): ReturnType<typeof compactionEngineOf> => {
    const engine = compactionEngineOf(ctx, agent)
    if (engine === undefined) return undefined
    const options = pocOptions()
    const raw = engine as unknown as {
      summarize: (input: unknown, owner: Agent, signal?: AbortSignal) => Promise<unknown>
      config: Record<string, unknown>
    }
    if ((engine as unknown as Record<symbol, unknown>)[PATCHED] !== true) {
      (engine as unknown as Record<symbol, unknown>)[PATCHED] = true
      const original = raw.summarize.bind(engine)
      // PoC-5：实例属性遮蔽原型方法；regionDependencies() 动态取 this.summarize，宿主自动压缩同样经过这里
      raw.summarize = async (input, owner, signal) => {
        const identity = teams.identityOf(owner, true)
        const window = windowInfoOf(owner.session as never)
        const fresh = identity === undefined ? false : noteFreshness(identity, window).fresh
        const stack = new Error().stack?.split('\n').slice(2, 9).map(line => line.trim()) ?? []
        if (!pocOptions().templateSummary || identity === undefined) {
          pocLog({ ev: 'summarize', mode: 'original-llm', agent: owner.id, window: window.index, stack })
          return original(input, owner, signal)
        }
        const target = owner.session.requestHeader()?.config
        pocLog({ ev: 'summarize', mode: 'template', agent: owner.id, name: identity.agentKey, window: window.index, fresh, stack })
        return {
          summary: [{ type: 'text', text: templateSummary(identity, window, fresh) }],
          provider: target?.provider ?? 'none',
          model: target?.model ?? 'none',
        }
      }
      pocLog({ ev: 'engine-patched', agent: agent.id, ctor: (engine as object).constructor?.name, ownSummarize: Object.prototype.hasOwnProperty.call(engine, 'summarize') })
    }
    if (options.hostOverride !== undefined && raw.config.thresholdRatio !== options.hostOverride.thresholdRatio) {
      const { retainRatio: _drop, ...rest } = raw.config
      raw.config = Object.freeze({ ...rest, thresholdRatio: options.hostOverride.thresholdRatio, retainTokens: options.hostOverride.retainTokens })
      pocLog({ ev: 'host-threshold-override', config: raw.config })
    }
    return engine
  }

  // PoC-5：统计所有 LLM 请求（purpose=compaction 即摘要请求）
  ctx.on('llm/stream' as never, ((options: { purpose?: string; sessionId?: string; model?: string }, next: () => unknown) => {
    pocLog({ ev: 'llm-stream', purpose: options.purpose ?? null, sessionId: options.sessionId ?? null, model: options.model ?? null })
    return next()
  }) as never)

  const running = new Set<string>()
  const lastFullTools = new Map<string, typeof _toolsType>()
  let _toolsType: Awaited<ReturnType<typeof ctx.systemPrompt.assemble>>["tools"] = []
  void _toolsType
  const compactNow = async (agent: Agent, signal: AbortSignal, reason: string): Promise<boolean> => {
    const engine = engineFor(agent)
    if (engine === undefined) { pocLog({ ev: 'no-engine', agent: agent.id }); return false }
    running.add(agent.id)
    try {
      const before = usageOf(ctx, agent.session)
      const result = await engine.compactIfNeeded(agent, 'context-overflow', signal)
      const after = usageOf(ctx, agent.session)
      pocLog({ ev: 'plugin-compact', agent: agent.id, reason, ok: result !== null, before: before?.ratio, after: after?.ratio, window: windowInfoOf(agent.session as never).index })
      if (result !== null) poc.clear(agent.id, `compacted:${reason}`)
      return result !== null
    } catch (error) {
      pocLog({ ev: 'plugin-compact-error', agent: agent.id, reason, error: String(error) })
      return false
    } finally {
      running.delete(agent.id)
    }
  }

  /** 返回本次是否压缩了。 */
  const onAssemble = async (agent: Agent, signal: AbortSignal): Promise<boolean> => {
    if (signal.aborted || running.has(agent.id)) return false
    const identity = teams.identityOf(agent)
    if (identity === undefined) return false
    engineFor(agent) // 尽早接管 summarize()
    const usage = usageOf(ctx, agent.session)
    if (usage === undefined) return false
    const options = pocOptions()
    const window = windowInfoOf(agent.session as never)
    const fresh = noteFreshness(identity, window)
    const state = poc.fallback.get(agent.id)
    if (state !== undefined && state.window !== window.index) poc.clear(agent.id, 'window-changed-elsewhere')
    pocLog({
      ev: 'assemble', agent: agent.id, name: identity.agentKey, role: identity.role,
      pressure: usage.pressure, W: usage.contextWindow, ratio: Math.round(usage.ratio * 10000) / 10000,
      window: window.index, windowStart: window.startTime, noteMtime: fresh.mtimeMs, fresh: fresh.fresh,
      fallback: poc.fallback.has(agent.id), visible: visibleTools(ctx, agent),
      headerTools: agent.session.requestHeader()?.tools?.map(tool => tool.name).sort(),
    })
    // PoC：兜底期间检查我们的 restrict 是否还在（成员换 Agent 实例后会丢），丢了就记录并重新施加
    const current = poc.fallback.get(agent.id)
    if (current !== undefined && identity.role === 'member') {
      const visible = visibleTools(ctx, agent)
      const own = ownLayerTools(ctx, agent)
      const extra = Array.isArray(visible) && Array.isArray(own) ? visible.filter(name => !options.fallbackAllow.includes(name) && !own.includes(name)) : []
      if (extra.length > 0) {
        pocLog({ ev: 'restrict-lost', agent: agent.id, extra })
        try { current.revoke = agent.ctx.tools.restrict({ allow: options.fallbackAllow }) ; pocLog({ ev: 'restrict-reapplied', agent: agent.id, visible: visibleTools(ctx, agent) }) } catch (error) { pocLog({ ev: 'restrict-error', agent: agent.id, error: String(error) }) }
      }
    }
    if (poc.newWindow.get(agent.id) === window.index) return compactNow(agent, signal, 'context_new_window')
    if (!options.pluginCompaction) return false
    if (identity.role === 'captain' && options.captainSkip) return false
    if (usage.ratio < config.budget.compactAtRatio) return false
    if (fresh.fresh) return compactNow(agent, signal, state === undefined ? 'threshold-fresh' : 'fallback-note-written')
    if (state === undefined) {
      const next: { window: number; startPressure: number; deadline: number; revoke?: () => void } = {
        window: window.index, startPressure: usage.pressure, deadline: usage.pressure + options.fallbackBufferTokens,
      }
      poc.fallback.set(agent.id, next)
      const before = visibleTools(ctx, agent)
      if (identity.role === 'member') {
        if (options.probeUnknown && !poc.probed) {
          poc.probed = true
          try {
            const revoke = agent.ctx.tools.restrict({ allow: ['team_notes', 'no_such_tool_poc'] })
            revoke()
            pocLog({ ev: 'restrict-probe-unknown', threw: false })
          } catch (error) {
            pocLog({ ev: 'restrict-probe-unknown', threw: true, error: String(error), ownLayer: ownLayerTools(ctx, agent) })
          }
        }
        try {
          next.revoke = agent.ctx.tools.restrict({ allow: options.fallbackAllow })
          pocLog({ ev: 'restrict-applied', agent: agent.id, allow: options.fallbackAllow })
        } catch (error) {
          pocLog({ ev: 'restrict-error', agent: agent.id, error: String(error).slice(0, 600) })
        }
      }
      pocLog({ ev: 'deferred', agent: agent.id, name: identity.agentKey, ratio: usage.ratio, deadline: next.deadline, visibleBefore: before, visibleAfter: visibleTools(ctx, agent) })
      return false
    }
    if (usage.pressure >= state.deadline) return compactNow(agent, signal, 'buffer-exhausted')
    pocLog({ ev: 'deferred-again', agent: agent.id, pressure: usage.pressure, deadline: state.deadline })
    return false
  }

  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const agent = context.agent
    const signal = context.signal
    const hadFallback = agent !== undefined && poc.fallback.has(agent.id)
    const compacted = agent !== undefined && signal !== undefined && await onAssemble(agent, signal)
    const assembly = await next()
    if (agent === undefined) return assembly
    let tools = assembly.tools
    const hasFallback = poc.fallback.has(agent.id)
    if (!hasFallback && !hadFallback) lastFullTools.set(agent.id, assembly.tools)
    if (pocOptions().syncTools && hadFallback !== hasFallback) {
      // restrict/revoke 发生在组装瀑布内，而 assembly.tools 在瀑布之前已算好：按当前 view 改写本步工具
      const visible = new Set(visibleTools(ctx, agent) as string[])
      const base = hasFallback ? assembly.tools : (lastFullTools.get(agent.id) ?? assembly.tools)
      tools = base.filter(tool => visible.has(tool.name))
      pocLog({ ev: 'sync-tools', agent: agent.id, entering: hasFallback, before: assembly.tools.map(tool => tool.name).length, after: tools.map(tool => tool.name) .length })
    }
    return {
      ...assembly,
      tools,
      contexts: assembly.contexts.map(entry => entry.name === BUDGET_CONTEXT_NAME
        ? { ...entry, text: budgetText(context) }
        : entry.name === HINT_CONTEXT_NAME && compacted
          ? { ...entry, text: windowHintText(context) }
          : entry),
    }
  })

  // PoC-6：记录每步放行的输入（信箱回执）与压缩的先后
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    const delay = pocOptions().delay
    if (delay !== undefined && decision.kind === 'enter') {
      const identity = teams.identityOf(payload.agent)
      const usage = usageOf(ctx, payload.agent.session)
      if (identity !== undefined && delay.names.includes(identity.agentKey) && usage !== undefined && usage.ratio >= delay.minRatio) {
        pocLog({ ev: 'delay', agent: payload.agent.id, name: identity.agentKey, step: payload.step, ms: delay.ms })
        await new Promise(resolve => setTimeout(resolve, delay.ms))
      }
    }
    try {
      if (teams.identityOf(payload.agent) !== undefined) {
        const messages = decision.kind === 'enter' ? decision.messages.map(message => {
          const text = message.content.map(block => block.type === 'text' ? block.text : `[${block.type}]`).join(' ')
          return { source: (message as { source?: { kind?: string } }).source?.kind ?? null, text: text.slice(0, 160) }
        }) : []
        pocLog({ ev: 'pre-step', agent: payload.agent.id, step: payload.step, turn: payload.turn, kind: decision.kind, window: windowInfoOf(payload.agent.session as never).index, messages })
      }
    } catch (error) { pocLog({ ev: 'pre-step-log-error', error: String(error) }) }
    return decision
  })
  ctx.on('session/event', (session, event) => {
    if (event.type.startsWith('compaction/')) pocLog({ ev: 'session-event', session: session.id, type: event.type, seq: event.seq })
  })
  void NEW_WINDOW_TOOL
}

/** 合并单次调用超时。 */
const MERGE_TIMEOUT_MS = 120_000

/** notesMerge：成员任务完成时，把其笔记合并进 workspace.md（开关与模型即时生效）。 */
function registerNotesMerge(
  ctx: Context,
  config: Settings,
  storeFor: ReturnType<typeof createStoreCache>,
  logger: ReturnType<Context['logger']>,
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

  const tracker = new CompletionTracker()
  const calls = new TeamToolCalls()
  const queue = new Map<string, Promise<void>>()

  ctx.on('session/event', (session, event) => {
    if (!calls.handle(session.id, event.type, (event as { data?: unknown }).data)) return
    // 关闭时仍要更新快照，否则开启瞬间会把关闭期间完成的任务当成新完成
    const enabled = config.notes && config.notesMerge.enabled && config.notesMerge.model !== undefined
    const stateRoot = stateRootOf(session.header.cwd, config.stateDir)
    let teams
    try {
      teams = listTeams(stateRoot)
    } catch (error) {
      logger.warn(`笔记合并：读取团队状态失败（${stateRoot}）：${String(error)}`)
      return
    }
    const completed = tracker.observe(stateRoot, teams)
    if (!enabled) return
    for (const { team, task } of completed) {
      const memberName = task.assignee!
      const fileKey = sanitizeKey(memberName)
      const run = async () => {
        const outcome = await mergeMemberNote({
          store: storeFor({ stateRoot, team, role: 'member', agentKey: memberName, fileKey }),
          teamId: team.id,
          teamName: team.name,
          memberName,
          memberFileKey: fileKey,
          taskId: task.id,
          taskSubject: task.subject,
          generate,
          signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(MERGE_TIMEOUT_MS)]),
        })
        if (outcome === 'merged') logger.info(`已把 ${memberName} 的笔记合并进 workspace.md（${team.id} / ${task.id}）`)
        else if (outcome !== 'empty-note') logger.warn(`笔记合并未写入（${team.id} / ${task.id}）：${outcome}`)
      }
      // 同一工作区的合并排队执行，减少 workspace.md 冲突
      const prior = queue.get(stateRoot) ?? Promise.resolve()
      const next = prior.then(run).catch((error: unknown) => {
        if (!lifetime.signal.aborted) logger.warn(`笔记合并失败（${team.id} / ${task.id}）：${String(error)}`)
      })
      queue.set(stateRoot, next)
    }
  })
}
