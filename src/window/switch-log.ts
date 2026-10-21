/**
 * 换窗状态写进会话日志（设计 0.5.0 §E5b、0.6.0 §1）。
 *
 * 兜底、换窗请求 / 拒绝、最近写自己笔记、子会话工具隐藏决定，都以插件记录
 * `plugin:dsh-token-budget/switch` 追加到会话日志；窗口投影折叠它们（见 counter.ts）。
 * 日志随重启续接、随回退一起回退，状态与时间线始终一致；内存只在写日志失败时兜底。
 *
 * 写入点只能是 agent/created、system-prompt/assemble、agent/pre-step、工具 execute；
 * 在 session/event 监听里写会抛「append cannot reenter」。
 * 投影忽略 seq < inheritedEventCount 的记录（继承前缀里的不属于本会话，与 windowInfoFrom 一致）。
 */

import type { Session } from '@deepseek-ai/dsh-session'
import * as dshSession from '@deepseek-ai/dsh-session'
import { z } from 'zod'
import type { FallbackState, SessionSwitchState } from './state.ts'

export const SWITCH_RECORD_TYPE = 'plugin:dsh-token-budget/switch'

export type SwitchRecord =
  /** 进入兜底；turn 为当时最后一个 turn/start 的 seq。 */
  | { kind: 'fallback'; window: number; startedAt: number; deadline: number; turn: number | null }
  /** context_new_window 放行。 */
  | { kind: 'new-window'; window: number }
  /** context_new_window 被拒（本窗口未写笔记）。 */
  | { kind: 'refused'; window: number }
  /** 写了自己的笔记。 */
  | { kind: 'note-write'; window: number; at: number }
  /** 该窗口的换窗请求 / 兜底已处理（无论成败），不再重试。 */
  | { kind: 'settled'; window: number }
  /** 子会话工具隐藏决定（每会话一次）。 */
  | { kind: 'hide-tools'; hide: boolean }

declare module '@deepseek-ai/dsh-session' {
  interface PluginRecordMap {
    'plugin:dsh-token-budget/switch': SwitchRecord
  }
}

const win = z.number().int().positive()
const recordSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('fallback'), window: win, startedAt: z.number(), deadline: z.number(), turn: z.number().nullable() }),
  z.object({ kind: z.literal('new-window'), window: win }),
  z.object({ kind: z.literal('refused'), window: win }),
  z.object({ kind: z.literal('note-write'), window: win, at: z.number() }),
  z.object({ kind: z.literal('settled'), window: win }),
  z.object({ kind: z.literal('hide-tools'), hide: z.boolean() }),
])

/** 校验日志里的记录数据；读不懂返回 undefined（旧版本或手改的记录跳过）。 */
export function parseSwitchRecord(data: unknown): SwitchRecord | undefined {
  const parsed = recordSchema.safeParse(data)
  return parsed.success ? parsed.data as SwitchRecord : undefined
}

/** 折叠后的记录：每类只留最新一条，带 seq 以便过滤继承前缀。 */
export interface FoldedSwitch {
  fallback?: { seq: number; window: number; startedAt: number; deadline: number; turn: number | null }
  newWindow?: { seq: number; window: number }
  refused?: { seq: number; window: number }
  lastWrite?: { seq: number; window: number; at: number }
  hide?: { seq: number; hide: boolean }
}

export const foldedSwitchSchema = z.object({
  fallback: z.object({ seq: z.number(), window: z.number(), startedAt: z.number(), deadline: z.number(), turn: z.number().nullable() }).optional(),
  newWindow: z.object({ seq: z.number(), window: z.number() }).optional(),
  refused: z.object({ seq: z.number(), window: z.number() }).optional(),
  lastWrite: z.object({ seq: z.number(), window: z.number(), at: z.number() }).optional(),
  hide: z.object({ seq: z.number(), hide: z.boolean() }).optional(),
})

/** 纯函数：折叠一条记录。 */
export function applySwitchRecord(state: FoldedSwitch, record: SwitchRecord, seq: number): FoldedSwitch {
  switch (record.kind) {
    case 'fallback': {
      const { kind: _, ...rest } = record
      return { ...state, fallback: { seq, ...rest } }
    }
    case 'new-window':
      return { ...state, newWindow: { seq, window: record.window } }
    case 'refused':
      return { ...state, refused: { seq, window: record.window } }
    case 'note-write':
      return { ...state, lastWrite: { seq, window: record.window, at: record.at } }
    case 'settled': {
      const next = { ...state }
      if (next.fallback?.window === record.window) delete next.fallback
      if (next.newWindow?.window === record.window) delete next.newWindow
      return next
    }
    case 'hide-tools':
      return { ...state, hide: { seq, hide: record.hide } }
  }
}

/**
 * 纯函数：折叠结果 → 当前窗口的换窗状态。继承前缀（seq < inherited）里的忽略；
 * 兜底、换窗请求、拒绝只认当前窗口（窗口变了即作废）；最近写笔记原样保留（新鲜度自己比窗口）。
 */
export function switchStateFrom(folded: FoldedSwitch, inherited: number, window: number): SessionSwitchState {
  const own = <T extends { seq: number }>(v: T | undefined): T | undefined => v !== undefined && v.seq >= inherited ? v : undefined
  const state: SessionSwitchState = {}
  const fallback = own(folded.fallback)
  if (fallback !== undefined && fallback.window === window) {
    const value: FallbackState = { window, startedAt: fallback.startedAt, deadline: fallback.deadline, turn: fallback.turn ?? undefined }
    state.fallback = value
  }
  const newWindow = own(folded.newWindow)
  if (newWindow !== undefined && newWindow.window === window) state.newWindow = window
  const refused = own(folded.refused)
  if (refused !== undefined && refused.window === window) state.refused = window
  const lastWrite = own(folded.lastWrite)
  if (lastWrite !== undefined) state.lastWrite = { window: lastWrite.window, at: lastWrite.at }
  return state
}

/** 隐藏决定；继承前缀里的不算。 */
export function hideFrom(folded: FoldedSwitch, inherited: number): boolean | undefined {
  const hide = folded.hide
  return hide !== undefined && hide.seq >= inherited ? hide.hide : undefined
}

type Append = (session: Session, record: SwitchRecord) => void

/** 宿主的 appendPluginRecord；旧版 DSH 没有该导出时返回 undefined。 */
export function hostAppend(): Append | undefined {
  const fn = (dshSession as { appendPluginRecord?: unknown }).appendPluginRecord
  if (typeof fn !== 'function') return undefined
  return (session, record) => { (fn as typeof dshSession.appendPluginRecord)(session, SWITCH_RECORD_TYPE, record) }
}

export interface SwitchLogDeps {
  /** 读投影里的折叠结果；投影不可用返回 undefined。 */
  read: (session: Session) => FoldedSwitch | undefined
  append: Append | undefined
  warn: (message: string) => void
}

/**
 * 换窗状态的读写入口。正常情况下一切以日志为准；写日志失败的会话改用内存
 * （从当时的投影复制一份接着折叠），只告警一次，行为退回 0.5.x 的进程内状态。
 */
export class SwitchLog {
  private readonly deps: SwitchLogDeps
  /** 写日志失败过的会话：会话 id → 内存折叠结果。 */
  private readonly memory = new Map<string, FoldedSwitch>()

  constructor(deps: SwitchLogDeps) {
    this.deps = deps
  }

  /** 当前折叠结果。 */
  folded(session: Session): FoldedSwitch {
    return this.memory.get(session.id) ?? this.deps.read(session) ?? {}
  }

  /** 追加一条记录。 */
  record(session: Session, record: SwitchRecord): void {
    const mem = this.memory.get(session.id)
    if (mem === undefined) {
      if (this.deps.append !== undefined) {
        try {
          this.deps.append(session, record)
          return
        } catch (error) {
          this.deps.warn(`会话 ${session.id} 写换窗记录失败，改用进程内状态（重启后丢失）：${error instanceof Error ? error.message : String(error)}`)
        }
      } else {
        this.deps.warn(`当前 DSH 没有 appendPluginRecord，会话 ${session.id} 的换窗状态只存在进程内（重启后丢失）`)
      }
      this.memory.set(session.id, applySwitchRecord(this.deps.read(session) ?? {}, record, Number.MAX_SAFE_INTEGER))
      return
    }
    this.memory.set(session.id, applySwitchRecord(mem, record, Number.MAX_SAFE_INTEGER))
  }
}
