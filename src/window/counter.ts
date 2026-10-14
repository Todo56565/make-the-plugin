/**
 * 每会话窗口计数（设计 §4.0.3）。
 *
 * 注册会话投影：每遇到一次成功的 `compaction/end`（无 error 字段）计数 +1。
 * - 投影按会话隔离、随日志重放，resume 后自动恢复；
 * - 手动 /compact 与自动压缩都计；
 * - fork 子会话会重放父会话被复制的压缩事件，v1 不扣除（编号不给模型看，只用于判断「窗口是否变化」）。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
import { z } from 'zod'

export const WINDOW_PROJECTION_KEY = 'tokenBudgetWindow'

/** 投影状态：已完成的压缩次数。窗口编号 = compactions + 1。 */
export interface WindowState {
  compactions: number
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    tokenBudgetWindow: WindowState
  }
}

const windowStateSchema = z.object({ compactions: z.number().int().nonnegative() })

/** 纯函数：一个事件是否是成功完成的压缩。 */
export function isSuccessfulCompactionEnd(event: { type: string; data?: unknown }): boolean {
  if (event.type !== 'compaction/end') return false
  const data = event.data
  return !(typeof data === 'object' && data !== null && 'error' in data && (data as { error?: unknown }).error !== undefined)
}

/** 注册窗口计数投影，返回注销函数。 */
export function registerWindowCounter(ctx: Context): () => void {
  return ctx.sessionProjections.register({
    key: WINDOW_PROJECTION_KEY,
    stateSchema: windowStateSchema,
    stateVersion: 1,
    init: () => ({ compactions: 0 }),
    apply: (state, event: SessionEvent) => (isSuccessfulCompactionEnd(event as { type: string; data?: unknown })
      ? { compactions: state.compactions + 1 }
      : state),
  })
}

/** 当前窗口编号（从 1 开始）；投影不可用时返回 undefined。 */
export function windowOf(ctx: Context, session: Session): number | undefined {
  try {
    const state = ctx.sessionProjections.stateOf(session, WINDOW_PROJECTION_KEY)
    return state === undefined ? undefined : state.compactions + 1
  } catch {
    return undefined
  }
}
