/**
 * 换窗状态与决策（设计 0.3.0 §3、§7-2、§9a-2~5、§9a-9）。纯逻辑，便于测试。
 *
 * 状态一律按会话 id 存：成员 Agent 每轮重建，挂在实例上的状态会丢（PoC-2.5）。
 * 每份状态都带窗口编号，窗口变了（无论谁换的窗）就作废。
 */

/** 换窗原因：决定交接里「你的笔记」一行的写法。 */
export type SwitchReason =
  /** 模型调用了 context_new_window（视为「笔记写完」的声明）。 */
  | 'tool'
  /** 到换窗点时本窗口已写过笔记，直接换。 */
  | 'threshold'
  /** 成员看不到 team_notes，到换窗点直接换。 */
  | 'no-notes'
  /** 兜底额度用完，或兜底中结束本轮后再次被唤醒。 */
  | 'buffer'

export interface FallbackState {
  window: number
  /** 进入兜底时的压力 + fallbackBufferTokens。 */
  deadline: number
  /** 进入兜底那一轮的控制信号：之后组装时信号不同 ⇒ 已是新的一轮（§9a-9）。 */
  turn: object | undefined
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

/** 会话 id → 换窗状态。不随 agent/disposed 清理（成员 Agent 每轮重建，状态必须跨实例）。 */
export class SwitchStates {
  private readonly states = new Map<string, SessionSwitchState>()

  get(sessionId: string): SessionSwitchState {
    let state = this.states.get(sessionId)
    if (state === undefined) {
      state = {}
      this.states.set(sessionId, state)
    }
    return state
  }

  peek(sessionId: string): SessionSwitchState | undefined {
    return this.states.get(sessionId)
  }

  /** 丢掉不属于当前窗口的状态（换窗后调用）。 */
  settle(sessionId: string, window: number): SessionSwitchState {
    const state = this.get(sessionId)
    if (state.fallback !== undefined && state.fallback.window !== window) delete state.fallback
    if (state.newWindow !== undefined && state.newWindow !== window) delete state.newWindow
    if (state.refused !== undefined && state.refused !== window) delete state.refused
    return state
  }

  /** 记录一次写自己笔记。 */
  recordWrite(sessionId: string, window: number, at: number): void {
    this.get(sessionId).lastWrite = { window, at }
  }
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

export type Decision =
  | { kind: 'none' }
  | { kind: 'compact'; reason: SwitchReason }
  | { kind: 'enter-fallback'; deadline: number }

export interface DecideInput {
  role: 'captain' | 'member'
  window: number
  ratio: number
  pressure: number
  compactAtRatio: number
  fallbackBufferTokens: number
  /** 本窗口写过自己的笔记。 */
  fresh: boolean
  /** 本会话可见工具里有 team_notes。 */
  canWriteNotes: boolean
  /** 本次组装的控制信号（每轮一个）。 */
  turn: object | undefined
  state: SessionSwitchState
}

/**
 * 每步组装时的决策（调用前先 {@link SwitchStates.settle}）：
 * 1. 本窗口请求过换窗 ⇒ 换（tool）
 * 2. 队长：其余情况都不动（只提醒；宿主约 80% 压缩兜底）
 * 3. 成员兜底中：额度用完，或已是新的一轮 ⇒ 换（buffer）；否则继续等。写笔记本身不触发换窗
 * 4. 成员到换窗点：写过笔记 ⇒ 换（threshold）；看不到 team_notes ⇒ 换（no-notes）；否则进兜底
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
  if (input.fresh) return { kind: 'compact', reason: 'threshold' }
  if (!input.canWriteNotes) return { kind: 'compact', reason: 'no-notes' }
  return { kind: 'enter-fallback', deadline: input.pressure + input.fallbackBufferTokens }
}

/** context_new_window 的放行判断：没写笔记时每窗口拒绝一次（§7-2）。 */
export function newWindowVerdict(input: { window: number; fresh: boolean; canWriteNotes: boolean; state: SessionSwitchState }): 'accept' | 'refuse' {
  if (input.fresh || !input.canWriteNotes) return 'accept'
  return input.state.refused === input.window ? 'accept' : 'refuse'
}
