/**
 * 上下文占用计算（设计 §4.1）。
 *
 * P = ctx.tokenMeter.measure(session).totalTokens（与 compaction-basic 同源）
 * W = contextPressure 投影的 contextWindow（路由容量）
 * u = P / W
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-token-meter'

export interface Usage {
  /** 当前压力 token 数。 */
  pressure: number
  /** 路由容量。 */
  contextWindow: number
  /** 已用比例 P / W。 */
  ratio: number
}

/** 读取会话当前占用；容量未知或计量失败返回 undefined。 */
export function usageOf(ctx: Context, session: Session): Usage | undefined {
  try {
    const contextWindow = ctx.sessionProjections.stateOf(session, 'contextPressure')?.contextWindow
    if (contextWindow === undefined || !(contextWindow > 0)) return undefined
    const pressure = ctx.tokenMeter.measure(session).totalTokens
    return { pressure, contextWindow, ratio: pressure / contextWindow }
  } catch {
    return undefined
  }
}

/**
 * 把已用比例量化成提示档位（整数百分比）。
 * 未到 remindAt 返回 undefined；否则 remindAt + k × step（向下取档）。
 * 默认 0.37 / 0.03 ⇒ 37、40、43、46…
 */
export function bucketOf(ratio: number, remindAt: number, step: number): number | undefined {
  if (!(ratio >= remindAt) || !(step > 0)) return undefined
  // 用整数百分点计算，避免浮点误差（0.37 + 0.03 × 2 ≠ 0.43）
  const base = Math.round(remindAt * 100)
  const stepPct = Math.max(1, Math.round(step * 100))
  const usedPct = Math.floor(ratio * 100 + 1e-9)
  return base + Math.floor((usedPct - base) / stepPct) * stepPct
}
