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
import type {} from '@deepseek-ai/dsh-agent'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import { Config, validateConfig } from './config.ts'
import { TeamDirectory, isTeamEvent } from './team/directory.ts'
import { registerWindowCounter, windowOf } from './window/counter.ts'
import { bucketOf, usageOf } from './budget/usage.ts'
import { reminderText } from './budget/reminder.ts'
import { CompactionGate, compactionEngineOf } from './budget/compact.ts'
import { createStoreCache, registerTeamNotesTool } from './notes/tool.ts'
import { CompletionTracker, TeamToolCalls, mergeMemberNote, type Generate } from './notes/merge.ts'
import { listTeams, sanitizeKey } from './team/team-file.ts'
import { stateRootOf } from './team/identity.ts'
import { FrozenText, NOTES_SECTION_ORDER, notesSectionText } from './prompt/notes-section.ts'
import { HINT_CONTEXT_ORDER, WindowHintCache, hintText, listNoteMetasSync } from './prompt/hint.ts'

export { Config }
export const name = 'dsh-token-budget'
export const inject = ['systemPrompt', 'tools', 'tokenMeter', 'sessionProjections', 'agents']

/** 预算提示 context 的顺序：排在 SUBAGENT_DELEGATION(120) 之后。 */
const BUDGET_CONTEXT_ORDER = 130

export function apply(ctx: Context, config: Config): void {
  const logger = ctx.logger('dsh-token-budget')
  for (const problem of validateConfig(config)) logger.warn(problem)

  const teams = new TeamDirectory(config.stateDir, message => logger.warn(message))
  const gate = new CompactionGate()
  const notesPointer = new FrozenText()
  const hints = new WindowHintCache()

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
  })

  // ── token budget：提示（runtime context，缓存分支 B）──
  ctx.effect(() => ctx.systemPrompt.context({
    name: 'dsh-token-budget:budget',
    order: BUDGET_CONTEXT_ORDER,
    text: (assembly) => {
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
    },
  }), 'dsh-token-budget: budget context')

  // ── 窗口 hint：任务 + 笔记元数据，只在窗口变化时重算 ──
  ctx.effect(() => ctx.systemPrompt.context({
    name: 'dsh-token-budget:hint',
    order: HINT_CONTEXT_ORDER,
    text: (assembly) => {
      const agent = assembly.agent
      if (agent === undefined) return ''
      try {
        const identity = teams.identityOf(agent)
        if (identity === undefined) return ''
        const key = `${windowOf(ctx, agent.session) ?? 0}:${identity.team.id}`
        return hints.get(agent.id, key, () => hintText({
          identity,
          notes: config.notes,
          // history 工具尚未实现，暂不在 hint 中提及
          history: false,
          metas: config.notes ? listNoteMetasSync(identity) : [],
          recentNotes: config.notesOptions.hintRecentNotes,
          maxBytes: config.notesOptions.hintMaxBytes,
        }))
      } catch (error) {
        logger.warn(`窗口 hint 生成失败：${String(error)}`)
        return ''
      }
    },
  }), 'dsh-token-budget: window hint')

  // ── notes：工具 + 稳定指针 ──
  if (config.notes) {
    const storeFor = createStoreCache(config.notesOptions.maxFileBytes)
    if (config.notesMerge.enabled) registerNotesMerge(ctx, config, storeFor, logger)
    ctx.effect(() => registerTeamNotesTool(ctx, {
      identityOf: agent => teams.identityOf(agent),
      storeFor,
      maxResults: config.historyOptions.maxResults,
    }), 'dsh-token-budget: team_notes tool')
    ctx.effect(() => ctx.systemPrompt.section({
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
    }), 'dsh-token-budget: notes section')
  }

  // ── token budget：45% 主动压缩（方案 D1）──
  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    if (signal.aborted) return next()
    try {
      if (teams.identityOf(agent) === undefined) return next()
      const usage = usageOf(ctx, agent.session)
      if (usage === undefined || usage.ratio < config.budget.compactAtRatio) return next()
      const window = windowOf(ctx, agent.session) ?? 0
      if (!gate.canAttempt(agent.id, window)) return next()
      const engine = compactionEngineOf(ctx, agent)
      if (engine === undefined) {
        logger.warn(`会话 ${agent.id} 已用 ${(usage.ratio * 100).toFixed(1)}%，但取不到压缩引擎，跳过主动压缩`)
        gate.begin(agent.id, window)
        gate.end(agent.id)
        return next()
      }
      gate.begin(agent.id, window)
      try {
        const result = await engine.compactIfNeeded(agent, 'context-overflow', signal)
        logger.info(result === null
          ? `会话 ${agent.id} 已用 ${(usage.ratio * 100).toFixed(1)}%，没有可压缩的范围`
          : `会话 ${agent.id} 已用 ${(usage.ratio * 100).toFixed(1)}%，已主动压缩`)
      } finally {
        gate.end(agent.id)
      }
    } catch (error) {
      logger.warn(`主动压缩失败，继续本步：${error instanceof Error ? error.message : String(error)}`)
    }
    return next()
  })
}

/** 合并单次调用超时。 */
const MERGE_TIMEOUT_MS = 120_000

/** notesMerge：成员任务完成时，把其笔记合并进 workspace.md。 */
function registerNotesMerge(
  ctx: Context,
  config: Config,
  storeFor: ReturnType<typeof createStoreCache>,
  logger: ReturnType<Context['logger']>,
): void {
  const { provider, model, reasoningEffort } = config.notesMerge
  if (provider === undefined || model === undefined) return
  const lifetime = new AbortController()
  ctx.effect(() => () => lifetime.abort(), 'dsh-token-budget: notes merge lifetime')

  const generate: Generate = async (system, prompt, signal) => {
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
    const stateRoot = stateRootOf(session.header.cwd, config.stateDir)
    let teams
    try {
      teams = listTeams(stateRoot)
    } catch (error) {
      logger.warn(`笔记合并：读取团队状态失败（${stateRoot}）：${String(error)}`)
      return
    }
    for (const { team, task } of tracker.observe(stateRoot, teams)) {
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
