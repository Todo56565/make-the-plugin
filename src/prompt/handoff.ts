/**
 * 换窗交接【交接】（设计 0.3.0 §5、§6、§7-5、§7-6、§9a-4、§9a-6）。纯文本生成，便于测试。
 *
 * - 只放状态和指针，不讲规则（规则在常驻 section，notes-section.ts）
 * - 完整版：换窗时由接管的 summarize() 返回，放在摘要位置，零 LLM 请求
 * - 精简版：只在 w1 注入一次（身份 + 笔记 / 共享笔记 / team_history 指针，不写任务），前缀缓存稳定
 * - 超过 hintMaxBytes：先少列最近改动的笔记，再截断过长的团队名 / 任务标题；
 *   身份、任务、自己的笔记、上一窗口永远保留
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { TeamIdentity } from '../team/identity.ts'
import { notesRootOf, ownNotePath, physicalNotePath, WORKSPACE_NOTE } from '../notes/paths.ts'
import { countLines, type NoteMeta } from '../notes/store.ts'

export const HANDOFF_TITLE = '【交接】'

const TERMINAL = new Set(['completed', 'failed', 'cancelled'])
/** 队长任务行最多列出的任务 id 数。 */
const MAX_CAPTAIN_TASK_IDS = 20
/** 超限时团队名 / 任务标题依次截断到的长度（字符）。 */
const TRUNCATE_STEPS = [120, 60, 30, 16]

/** 同步读取笔记元数据（在压缩 / 组装内同步执行）。 */
export function listNoteMetasSync(identity: TeamIdentity): NoteMeta[] {
  const root = notesRootOf(identity.stateRoot)
  const paths = [WORKSPACE_NOTE]
  try {
    const dir = physicalNotePath(`teams/${identity.team.id}/`, identity.team)
    for (const name of readdirSync(join(root, ...dir.split('/').filter(Boolean)))) {
      if (name.endsWith('.md')) paths.push(`teams/${identity.team.id}/${name}`)
    }
  } catch { /* 目录不存在 */ }
  const metas: NoteMeta[] = []
  for (const path of paths) {
    try {
      const abs = join(root, ...physicalNotePath(path, identity.team).split('/'))
      const text = readFileSync(abs, 'utf8')
      metas.push({ path, lines: countLines(text), bytes: Buffer.byteLength(text), mtimeMs: statSync(abs).mtimeMs })
    } catch { /* 不存在 */ }
  }
  return metas.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.path < b.path ? -1 : 1))
}

/** 自己笔记的 mtime；不存在返回 undefined。 */
export function ownNoteMtime(identity: TeamIdentity): number | undefined {
  try {
    return statSync(join(notesRootOf(identity.stateRoot), ...physicalNotePath(ownNotePath(identity.team.id, identity.fileKey), identity.team).split('/'))).mtimeMs
  } catch {
    return undefined
  }
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

/** 宿主进程本地时间 HH:MM。 */
export function clock(ts: number): string {
  const d = new Date(ts)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function cut(text: string, max: number): string {
  const chars = [...text]
  return chars.length <= max ? text : `${chars.slice(0, max).join('')}…`
}

/** 上一窗口里自己笔记的状态（§9a-4、§9a-11）。 */
export type OwnNoteState =
  /** 写了且算最新：本窗口写过，且之后由模型调用 context_new_window 换窗（进过兜底的，须兜底开始后写的）。 */
  | { kind: 'updated'; at: number }
  /** 兜底开始后写了，但被兜底额度用完（或宿主压缩）强制换窗：可能没写完。 */
  | { kind: 'incomplete'; at: number }
  /** 只在兜底开始前写过；或没进兜底、本窗口写过但不是 context_new_window 换的窗（宿主自动压缩等）：可能未含最新进展。 */
  | { kind: 'outdated'; at: number }
  /** 上一窗口没写。 */
  | { kind: 'stale' }

export interface HandoffSwitches {
  notes: boolean
  history: boolean
  teamHistory: boolean
}

export interface HandoffInput extends HandoffSwitches {
  identity: TeamIdentity
  /** 刚结束的窗口编号（history 模型口径）。 */
  previousWindow: number
  own: OwnNoteState
  metas: readonly NoteMeta[]
  recentNotes: number
  maxBytes: number
}

const HISTORY_TOOLS_TEXT = 'history_list_items / history_search_contents / history_read_item'

function identityLine(identity: TeamIdentity, nameMax: number): string {
  return `团队「${cut(identity.team.name, nameMax)}」（${identity.team.id}），你的身份：${identity.agentKey}（${identity.role === 'captain' ? '队长' : '成员'}）。`
}

function taskLine(identity: TeamIdentity, titleMax: number): string {
  const open = identity.team.tasks.filter(t => !TERMINAL.has(t.status))
  if (identity.role === 'captain') {
    const ids = open.map(t => t.id)
    const shown = ids.slice(0, MAX_CAPTAIN_TASK_IDS).join('、')
    const more = ids.length > MAX_CAPTAIN_TASK_IDS ? ' 等' : ''
    return ids.length === 0 ? '团队未完成任务：0 个' : `团队未完成任务：${ids.length} 个（${shown}${more}）`
  }
  const mine = open.filter(t => t.assignee === identity.agentKey)
  if (mine.length === 0) return '任务：当前没有分配给你的未完成任务'
  return `任务：${mine.map(t => `${t.id} ${cut(t.subject, titleMax)}（${t.status}）${t.attemptId === undefined ? '' : `，当前 attempt_id ${t.attemptId}`}`).join('；')}`
}

function teamHistoryLine(identity: TeamIdentity): string {
  return identity.role === 'captain' ? '全队来往的信：team_history（含已读）' : '队长和队友的信：team_history（含已读）'
}

function ownNoteLine(input: HandoffInput, meta: NoteMeta | undefined, path: string): string {
  const lines = meta === undefined ? '尚未创建' : `${meta.lines} 行`
  const recover = input.history ? '进展需用 history_* 恢复' : '进展可能缺失'
  switch (input.own.kind) {
    case 'updated':
      return `你的笔记：${path}（${lines}，上一窗口 ${clock(input.own.at)} 更新）`
    case 'incomplete':
      return `你的笔记：${path}（${lines}，上一窗口 ${clock(input.own.at)} 更新，可能未写完${input.history ? '，缺的用 history_* 补' : ''}）`
    case 'outdated':
      return `你的笔记：${path}（${lines}，上一窗口 ${clock(input.own.at)} 更新，可能未含最新进展${input.history ? '，缺的用 history_* 补' : ''}）`
    case 'stale':
      return `你的笔记：${path}（${lines}，上一窗口未更新，${recover}）`
  }
}

function build(input: HandoffInput, recentCount: number, nameMax: number, titleMax: number): string {
  const { identity } = input
  const lines = [HANDOFF_TITLE, identityLine(identity, nameMax), taskLine(identity, titleMax)]
  if (input.notes) {
    const own = ownNotePath(identity.team.id, identity.fileKey)
    lines.push(ownNoteLine(input, input.metas.find(m => m.path === own), own))
    const shared = input.metas.find(m => m.path === WORKSPACE_NOTE)
    lines.push(`共享笔记：${WORKSPACE_NOTE}（${shared === undefined ? '尚未创建' : `${shared.lines} 行`}）`)
    const recent = input.metas.filter(m => m.path !== own && m.path !== WORKSPACE_NOTE).slice(0, recentCount)
    if (recent.length > 0) lines.push(`最近改动的笔记：${recent.map(m => `${m.path}（${m.lines} 行，${clock(m.mtimeMs)}）`).join('；')}`)
  }
  if (input.teamHistory) lines.push(teamHistoryLine(identity))
  lines.push(input.history
    ? `上一窗口：w${input.previousWindow}，原文用 ${HISTORY_TOOLS_TEXT} 按窗口 id 回看`
    : `上一窗口：w${input.previousWindow}`)
  lines.push(`以上是换窗时的快照，任务${input.notes ? '和笔记' : ''}以 agent_teams 工具${input.notes ? '和 team_notes ' : ''}为准。`)
  return lines.join('\n')
}

function fits(text: string, maxBytes: number): boolean {
  return Buffer.byteLength(text) <= maxBytes
}

/** 完整版交接；超限按 §7-6 裁剪，必留行永不丢。 */
export function handoffText(input: HandoffInput): string {
  const available = input.notes ? input.metas.length : 0
  for (let n = Math.min(Math.max(0, input.recentNotes), available); n >= 0; n -= 1) {
    const text = build(input, n, Infinity, Infinity)
    if (fits(text, input.maxBytes)) return text
  }
  let text = ''
  for (const max of TRUNCATE_STEPS) {
    text = build(input, 0, max, max)
    if (fits(text, input.maxBytes)) return text
  }
  return text
}

/** w1 精简版：身份 + 指针，不写任务、不带会变的元数据（§7-5）。 */
export function initialHandoffText(identity: TeamIdentity, switches: HandoffSwitches, maxBytes: number): string {
  const make = (nameMax: number): string => {
    const lines = [HANDOFF_TITLE, identityLine(identity, nameMax)]
    const pointers: string[] = []
    if (switches.notes) {
      pointers.push(`你的笔记：${ownNotePath(identity.team.id, identity.fileKey)}`, `共享笔记：${WORKSPACE_NOTE}`)
    }
    if (switches.teamHistory) pointers.push(teamHistoryLine(identity))
    if (pointers.length > 0) lines.push(pointers.join('；'))
    return lines.join('\n')
  }
  let text = make(Infinity)
  for (const max of TRUNCATE_STEPS) {
    if (fits(text, maxBytes)) return text
    text = make(max)
  }
  return text
}
