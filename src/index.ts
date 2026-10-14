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
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import { Config, validateConfig } from './config.ts'
import { TeamDirectory, isTeamEvent } from './team/directory.ts'
import { registerWindowCounter, windowOf } from './window/counter.ts'
import { bucketOf, usageOf } from './budget/usage.ts'
import { reminderText } from './budget/reminder.ts'
import { CompactionGate, compactionEngineOf } from './budget/compact.ts'

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

  // 窗口计数投影
  ctx.effect(() => registerWindowCounter(ctx), 'dsh-token-budget: window projection')

  // 团队状态变化 ⇒ 清空身份缓存
  ctx.on('session/event', (_session, event) => {
    if (isTeamEvent(event.type)) teams.invalidate()
  })
  ctx.on('agent/disposed', ({ agent }) => {
    teams.forget(agent.id)
    gate.forget(agent.id)
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
