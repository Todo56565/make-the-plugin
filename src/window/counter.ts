/**
 * 每会话窗口信息（设计 0.3.0 §5、§9a-7）。
 *
 * 口径与 history 模型一致（src/history/model.ts）：窗口 N = 1 + 自己的 `compaction/summary` 数，
 * fork 继承前缀（seq < inheritedEventCount）里的摘要不算。
 * 窗口开始时间 = 最后一个自己的 `compaction/summary` 的时间；w1 用会话头 `createdAt`。
 *
 * 会话投影只记录每个摘要事件的 (seq, time)：投影按会话隔离、随日志重放，resume 后自动恢复；
 * 继承前缀在读取时按 `session.inheritedEventCount` 过滤（投影里拿不到它）。
 *
 * 同一投影还记录 w1 交接是否已发（0.5.0 E4）：交接是一条只发一次的 user 消息，
 * 继承前缀里的也算（fork 出来的会话已经带着它）。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
import { z } from 'zod'

export const WINDOW_PROJECTION_KEY = 'tokenBudgetWindow'
/** w1 交接消息的 source.kind。 */
export const HANDOFF_SOURCE_KIND = 'dsh-token-budget/handoff'

export interface SummaryMark {
  seq: number
  time: number
}

/** 投影状态：会话日志里每个 compaction/summary 的 seq 与时间。 */
export interface WindowState {
  summaries: SummaryMark[]
  /** 会话日志里是否已有 w1 交接消息。 */
  handoffSent: boolean
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    tokenBudgetWindow: WindowState
  }
}

const windowStateSchema = z.object({
  summaries: z.array(z.object({ seq: z.number().int().nonnegative(), time: z.number() })),
  handoffSent: z.boolean(),
})

/** 投影要看的事件字段。 */
export interface WindowEvent {
  type: string
  seq: number
  time: number
  data?: unknown
}

function isHandoffMessage(event: WindowEvent): boolean {
  if (event.type !== 'user/message') return false
  const source = (event.data as { source?: { kind?: unknown } } | undefined)?.source
  return source?.kind === HANDOFF_SOURCE_KIND
}

/** 纯函数：折叠一个事件。 */
export function applyWindowEvent(state: WindowState, event: WindowEvent): WindowState {
  if (event.type === 'compaction/summary') return { ...state, summaries: [...state.summaries, { seq: event.seq, time: event.time }] }
  if (!state.handoffSent && isHandoffMessage(event)) return { ...state, handoffSent: true }
  return state
}

export interface WindowInfo {
  /** history 模型编号（从 1 开始）。 */
  index: number
  /** 窗口开始时间（毫秒）。 */
  startTime: number
}

/** 纯函数：由摘要记录得到当前窗口。 */
export function windowInfoFrom(summaries: readonly SummaryMark[], inheritedEventCount: number, createdAt: number): WindowInfo {
  let index = 1
  let startTime = createdAt
  for (const mark of summaries) {
    if (mark.seq < inheritedEventCount) continue
    index += 1
    startTime = mark.time
  }
  return { index, startTime }
}

/** 注册窗口投影，返回注销函数。 */
export function registerWindowCounter(ctx: Context): () => void {
  return ctx.sessionProjections.register({
    key: WINDOW_PROJECTION_KEY,
    stateSchema: windowStateSchema,
    stateVersion: 3,
    init: () => ({ summaries: [], handoffSent: false }),
    apply: (state, event: SessionEvent) => applyWindowEvent(state, event as WindowEvent),
  })
}

/** 纯函数：这一步要不要发 w1 交接。 */
export function needsInitialHandoff(windowIndex: number, handoffSent: boolean): boolean {
  return windowIndex === 1 && !handoffSent
}

/** 会话日志里是否已有 w1 交接；投影不可用时返回 undefined。 */
export function handoffSentOf(ctx: Context, session: Session): boolean | undefined {
  try {
    return ctx.sessionProjections.stateOf(session, WINDOW_PROJECTION_KEY)?.handoffSent
  } catch {
    return undefined
  }
}

/** 当前窗口；投影不可用时返回 undefined。 */
export function windowOf(ctx: Context, session: Session): WindowInfo | undefined {
  try {
    const state = ctx.sessionProjections.stateOf(session, WINDOW_PROJECTION_KEY)
    if (state === undefined) return undefined
    const inherited = Number(session.inheritedEventCount)
    return windowInfoFrom(state.summaries, Number.isFinite(inherited) && inherited > 0 ? inherited : 0, session.header.createdAt)
  } catch {
    return undefined
  }
}
