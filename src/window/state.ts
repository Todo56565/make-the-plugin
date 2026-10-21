import type { OwnNoteState } from '../prompt/handoff.ts'

/**
 * 换窗状态与决策（设计 0.3.0 §3、§7-2、§9a-2~5、§9a-9、§9a-11）。纯逻辑，便于测试。
 *
 * 状态来自会话日志里的插件记录（0.6.0 E5b，见 switch-log.ts），按会话隔离、随日志重放。
 * 每份状态都带窗口编号，窗口变了（无论谁换的窗）就作废。
 */

/** 换窗原因：决定交接里「你的笔记」一行的写法。 */
export type SwitchReason =
  /** 模型调用了 context_new_window（视为「笔记写完」的声明）。 */
  | 'tool'
  /** 成员看不到 team_notes，到换窗点直接换。 */
  | 'no-notes'
  /** 兜底额度用完，或兜底中结束本轮后再次被唤醒。 */
  | 'buffer'

export interface FallbackState {
  window: number
  /** 进入兜底的时间（毫秒）：交接里只有此后写的笔记才算「最新」（§9a-11）。 */
  startedAt: number
  /** 进入兜底时的压力 + fallbackBufferTokens。 */
  deadline: number
  /** 进入兜底那一轮（最后一个 turn/start 的 seq）：之后组装时轮次不同 ⇒ 已是新的一轮（§9a-9、0.6.0 E5b）。 */
  turn: number | undefined
}

export interface SessionSwitchState {
  /** 兜底中（进入后一直持有，不按比例重判，§9a-5）。 */
  fallback?: FallbackState
  /** 已请求换窗的窗口编号（context_new_window）。 */
  newWindow?: number
  /** 本窗口已拒绝过一次 context_new_window 的窗口编号。 */
  refused?: number
  /** 最近一次 team_notes 写自己笔记的窗口与时间。 */
  lastWrite?: { window: number; at: number }
}

/** 笔记新鲜度：mtime ≥ 窗口开始，或本窗口记录到 team_notes 写自己笔记（§9a-7）。 */
export interface Freshness {
  fresh: boolean
  /** 最近一次更新时间（毫秒）；从未写过为 undefined。 */
  at?: number
}

export function freshnessOf(input: {
  window: number
  windowStart: number
  mtimeMs: number | undefined
  lastWrite: { window: number; at: number } | undefined
}): Freshness {
  const byWrite = input.lastWrite !== undefined && input.lastWrite.window === input.window
  const byMtime = input.mtimeMs !== undefined && input.mtimeMs >= input.windowStart
  const candidates = [input.mtimeMs, byWrite ? input.lastWrite!.at : undefined].filter((v): v is number => v !== undefined)
  const at = candidates.length > 0 ? Math.max(...candidates) : undefined
  return { fresh: byWrite || byMtime, ...(at === undefined ? {} : { at }) }
}

/**
 * 交接里「你的笔记」的状态（§9a-4、§9a-11）。`fallbackStartedAt` 为本窗口进入兜底的时间，没进兜底为 undefined；
 * `reason` 为插件换窗原因，宿主自动压缩（约 80%）为 undefined。
 * 原则：只有模型写完笔记后自己用 context_new_window 声明换窗，才写纯「更新」（2026-10-17 00:16）。
 * - 本窗口没写 ⇒ stale
 * - 没进兜底：调用 context_new_window（成员到点前主动换、队长主动换，都已过「没写拒绝一次」）⇒ updated；
 *   其余（宿主自动压缩，含队长；no-notes）⇒ outdated（可能未含最新进展）
 * - 兜底开始后写过：调用 context_new_window ⇒ updated；额度用完或兜底中被宿主压缩 ⇒ incomplete
 * - 只在兜底开始前写过 ⇒ outdated
 */
export function ownNoteStateOf(freshness: Freshness, fallbackStartedAt: number | undefined, reason: SwitchReason | undefined): OwnNoteState {
  if (!freshness.fresh || freshness.at === undefined) return { kind: 'stale' }
  const at = freshness.at
  const declared = reason === 'tool'
  if (fallbackStartedAt === undefined) return declared ? { kind: 'updated', at } : { kind: 'outdated', at }
  if (at < fallbackStartedAt) return { kind: 'outdated', at }
  return declared ? { kind: 'updated', at } : { kind: 'incomplete', at }
}

export type Decision =
  | { kind: 'none' }
  | { kind: 'compact'; reason: SwitchReason }
  | { kind: 'enter-fallback'; deadline: number }

export interface DecideInput {
  /** 普通会话与成员同样到点进兜底 / 换窗；队长只提醒（0.6.0 §2.2）。 */
  role: 'plain' | 'captain' | 'member'
  window: number
  ratio: number
  pressure: number
  compactAtRatio: number
  fallbackBufferTokens: number
  /** 本会话可见工具里有 team_notes。 */
  canWriteNotes: boolean
  /** 本次组装所在的轮次（最后一个 turn/start 的 seq）。 */
  turn: number | undefined
  state: SessionSwitchState
}

/**
 * 每步组装时的决策（state 只含当前窗口的状态，见 switchStateFrom）：
 * 1. 本窗口请求过换窗 ⇒ 换（tool）
 * 2. 队长：其余情况都不动（只提醒；宿主约 80% 压缩兜底）
 * 3. 成员兜底中：额度用完，或已是新的一轮 ⇒ 换（buffer）；否则继续等。写笔记本身不触发换窗
 * 4. 成员到换窗点：看不到 team_notes ⇒ 换（no-notes）；否则一律进兜底，不看本窗口是否写过笔记（对齐 Codex，§9a-11）
 */
export function decide(input: DecideInput): Decision {
  const { state } = input
  if (state.newWindow === input.window) return { kind: 'compact', reason: 'tool' }
  if (input.role === 'captain') return { kind: 'none' }
  const fallback = state.fallback
  if (fallback !== undefined && fallback.window === input.window) {
    if (input.pressure >= fallback.deadline) return { kind: 'compact', reason: 'buffer' }
    if (fallback.turn !== undefined && input.turn !== undefined && fallback.turn !== input.turn) return { kind: 'compact', reason: 'buffer' }
    return { kind: 'none' }
  }
  if (!(input.ratio >= input.compactAtRatio)) return { kind: 'none' }
  if (!input.canWriteNotes) return { kind: 'compact', reason: 'no-notes' }
  return { kind: 'enter-fallback', deadline: input.pressure + input.fallbackBufferTokens }
}

/** context_new_window 的放行判断：没写笔记时每窗口拒绝一次（§7-2）。 */
export function newWindowVerdict(input: { window: number; fresh: boolean; canWriteNotes: boolean; state: SessionSwitchState }): 'accept' | 'refuse' {
  if (input.fresh || !input.canWriteNotes) return 'accept'
  return input.state.refused === input.window ? 'accept' : 'refuse'
}
