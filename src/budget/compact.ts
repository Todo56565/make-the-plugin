/**
 * 45% 主动压缩（设计 §2.4 方案 D1）。
 *
 * 在宿主层 `agent/pre-step` 中，仅对团队会话：已用比例 ≥ compactAtRatio 时，
 * 经 `ctx.agentPresets.serviceFor(agent, 'compaction')` 取该 agent 所在 preset 的压缩引擎，
 * 调用 `compactIfNeeded(agent, 'context-overflow', signal)`：
 * 不保留最近原文（只保留最后一个节点及其工具调用配对），细节由 notes / history 回读。
 *
 * 防抖：同一窗口只尝试一次；压缩成功后窗口编号变化，下一窗口可再次触发。
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type { CompactionEngine } from '@deepseek-ai/dsh-compaction'

/** 每会话的尝试记录：sessionId → 已尝试过的窗口编号。 */
export class CompactionGate {
  private readonly attempted = new Map<string, number>()
  private readonly running = new Set<string>()

  /** 本窗口是否还可以尝试。 */
  canAttempt(sessionId: string, window: number): boolean {
    return !this.running.has(sessionId) && this.attempted.get(sessionId) !== window
  }

  begin(sessionId: string, window: number): void {
    this.attempted.set(sessionId, window)
    this.running.add(sessionId)
  }

  end(sessionId: string): void {
    this.running.delete(sessionId)
  }

  forget(sessionId: string): void {
    this.attempted.delete(sessionId)
    this.running.delete(sessionId)
  }
}

/** 取 agent 所在 preset 的压缩引擎；无 preset 或未装压缩时返回 undefined。 */
export function compactionEngineOf(ctx: Context, agent: { ctx: Context }): CompactionEngine | undefined {
  const registry = ctx.get('agentPresets')
  if (registry === undefined) return undefined
  try {
    return registry.serviceFor(agent, 'compaction')
  } catch {
    return undefined
  }
}
