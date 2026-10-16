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

/** 比例 ⇒ 整数百分点（避免浮点误差：0.37 + 0.03 × 2 ≠ 0.43）。 */
function pct(ratio: number): number {
  return Math.round(ratio * 100)
}

/**
 * 成员的提醒档位（整数百分比，设计 0.3.0 §2）：`remindAt + k × step`，取严格小于 `compactAt` 的值；
 * `(compactAt − remindAt) / step` 不是整数时去掉最后一档（离上限不足一个步长）；
 * 但只剩一档时保留（第一档负责说明换窗工具，不能没有）。
 * 默认 0.37 / 0.45 / 0.03 ⇒ [37, 40]；0.02 / 0.04 / 0.03 ⇒ [2]。
 */
export function memberLevels(remindAt: number, compactAt: number, step: number): number[] {
  const r = pct(remindAt)
  const c = pct(compactAt)
  const s = Math.max(1, pct(step))
  if (!(r < c)) return []
  const levels: number[] = []
  for (let v = r; v < c; v += s) levels.push(v)
  if ((c - r) % s !== 0 && levels.length > 1) levels.pop()
  return levels
}

/** 队长的提醒档位：`compactAt` 与再往后一个步长（默认 [45, 48]，设计 0.3.0 §7-4）。 */
export function captainLevels(compactAt: number, step: number): number[] {
  const c = pct(compactAt)
  return [c, c + Math.max(1, pct(step))]
}

/** 当前所在档位（已达到的最高一档）；一档都没到返回 undefined。 */
export function levelOf(ratio: number, levels: readonly number[]): number | undefined {
  if (!Number.isFinite(ratio)) return undefined
  const used = Math.floor(ratio * 100 + 1e-9)
  let hit: number | undefined
  for (const level of levels) if (used >= level) hit = level
  return hit
}
