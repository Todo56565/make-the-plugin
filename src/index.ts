/**
 * dsh-token-budget：@nanmicoder/dsh-agent-teams 的补丁插件。
 *
 * 宿主层插件（与 agent-teams 同层），只作用于团队会话：
 * - token budget：37% 起按档提示（runtime context），45% 主动压缩（方案 D1）
 * - notes：成员笔记与共享 workspace.md（开关 `notes`）
 * - history：只读历史工具（开关 `history`）
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
import { HINT_CONTEXT_ORDER, WindowHintCache, hintText, listNoteMetasSync } from './prompt/hint.ts'

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
  // 能力开关（notes / history / contextTool）也即时生效：按开关注册或注销对应工具与 section。
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
      const bucket = bucketOf(usage.ratio, config.budget.remindAtRatio, config.budget.bucketStep)
      if (bucket === undefined) return ''
      return reminderText({ bucket, compactAtRatio: config.budget.compactAtRatio, notes: config.notes })
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
  }))
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

  // ── context_remaining 工具（设计 §4.1；开关 contextTool，即时生效）──
  switchable('dsh-token-budget: context_remaining tool', () => config.budget.tool, () => registerContextRemainingTool(ctx, {
    isTeamAgent: agent => teams.identityOf(agent, true) !== undefined,
    usage: agent => usageOf(ctx, agent.session),
    compactAtRatio: () => config.budget.compactAtRatio,
  }))

  // ── token budget：45% 主动压缩（方案 D1）──
  /** 达到阈值时主动压缩；返回本次是否真的压缩了。 */
  const maybeCompact = async (agent: Agent, signal: AbortSignal): Promise<boolean> => {
    if (signal.aborted) return false
    try {
      if (teams.identityOf(agent) === undefined) return false
      const usage = usageOf(ctx, agent.session)
      if (usage === undefined || usage.ratio < config.budget.compactAtRatio) return false
      const window = windowOf(ctx, agent.session) ?? 0
      if (!gate.canAttempt(agent.id, window)) return false
      const engine = compactionEngineOf(ctx, agent)
      if (engine === undefined) {
        // 该 agent 的 preset 没装压缩，或 serviceFor 暂时取不到：不消耗本窗口的尝试次数，下一步再取。
        // 告警按会话只打一次，避免每步刷屏。
        if (!engineMissingWarned.has(agent.id)) {
          engineMissingWarned.add(agent.id)
          logger.warn(`会话 ${agent.id} 已用 ${(usage.ratio * 100).toFixed(1)}%，但取不到压缩引擎（该 preset 未装压缩或暂未就绪），本步跳过主动压缩，之后每步重试`)
        }
        return false
      }
      engineMissingWarned.delete(agent.id)
      gate.begin(agent.id, window)
      try {
        const result = await engine.compactIfNeeded(agent, 'context-overflow', signal)
        logger.info(result === null
          ? `会话 ${agent.id} 已用 ${(usage.ratio * 100).toFixed(1)}%，没有可压缩的范围`
          : `会话 ${agent.id} 已用 ${(usage.ratio * 100).toFixed(1)}%，已主动压缩`)
        return result !== null
      } finally {
        gate.end(agent.id)
      }
    } catch (error) {
      logger.warn(`主动压缩失败，继续本步：${error instanceof Error ? error.message : String(error)}`)
      return false
    }
  }

  // 主路径：在 system-prompt/assemble 里压缩。
  // 宿主每步先组装（runtime context 的 text() 只在这里求值一次），再跑 agent/pre-step；
  // 若在 pre-step 才压缩，压缩后第一步带的仍是压缩前算出的预算提示和窗口 hint。
  // 组装时各 context 已求值，所以压缩后就地重算本插件的两段。
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const agent = context.agent
    const signal = context.signal
    const compacted = agent !== undefined && signal !== undefined && await maybeCompact(agent, signal)
    const assembly = await next()
    if (!compacted) return assembly
    return {
      ...assembly,
      contexts: assembly.contexts.map(entry => entry.name === BUDGET_CONTEXT_NAME
        ? { ...entry, text: budgetText(context) }
        : entry.name === HINT_CONTEXT_NAME
          ? { ...entry, text: windowHintText(context) }
          : entry),
    }
  })

  // 兜底：组装上下文不带 agent / signal 的宿主仍在 pre-step 压缩（同窗口只尝试一次，与主路径不重复）
  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    await maybeCompact(agent, signal)
    return next()
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
