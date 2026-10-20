/**
 * 团队信箱只读视图（设计 §4.3，0.2.0）。
 *
 * agent-teams 每个收件人一个 `inbox/<收件人>.jsonl`（队长为 `captain`），已读的信仍留在文件里
 * （`readAt`），作废的信标 `discardedAt`。它自己的工具只展示未读信，本模块补「回看全部」：
 * - 队长：全队所有信箱
 * - 成员：自己的收件箱 + 自己发出的信（与 agent-teams「成员只看自己的信箱」一致，另加自己写过的内容）
 *
 * 文件由 agent-teams 整文件原子替换，无锁读取只会读到某个完整版本。坏行跳过并计数。
 */

import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { TeamIdentity } from '../team/identity.ts'

/** 本插件用到的信件字段（dsh-agent-teams@0.1.23 `TeamMessage`）。 */
export interface MailMessage {
  id: string
  from: string
  to: string
  content: string
  ts: number
  deliveredAt?: number
  readAt?: number
  discardedAt?: number
  taskId?: string
  sourceTaskId?: string
}

export interface MailView {
  /** 按时间正序（同一时刻按 id）。 */
  messages: MailMessage[]
  /** 解析失败的行数。 */
  malformed: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 把一行 JSON 收窄为信件；不合格返回 undefined。 */
export function coerceMessage(value: unknown): MailMessage | undefined {
  if (!isRecord(value)) return undefined
  const { id, from, to, content, ts } = value
  if (typeof id !== 'string' || typeof from !== 'string' || typeof to !== 'string' || typeof content !== 'string' || typeof ts !== 'number') return undefined
  const message: MailMessage = { id, from, to, content, ts }
  for (const key of ['deliveredAt', 'readAt', 'discardedAt'] as const) {
    if (typeof value[key] === 'number') message[key] = value[key] as number
  }
  for (const key of ['taskId', 'sourceTaskId'] as const) {
    if (typeof value[key] === 'string') message[key] = value[key] as string
  }
  return message
}

/** 解析一个信箱文件的文本。 */
export function parseMailbox(text: string): { messages: MailMessage[]; malformed: number } {
  const messages: MailMessage[] = []
  let malformed = 0
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    let parsed: unknown
    try { parsed = JSON.parse(line) } catch { malformed += 1; continue }
    const message = coerceMessage(parsed)
    if (message === undefined) malformed += 1
    else messages.push(message)
  }
  return { messages, malformed }
}

/** 调用者能看到这封信吗。 */
export function canSee(identity: Pick<TeamIdentity, 'role' | 'agentKey'>, message: MailMessage): boolean {
  if (identity.role === 'captain') return true
  return message.to === identity.agentKey || message.from === identity.agentKey
}

/**
 * 调用者能看到的最早时间：本代团队创建之后；成员还要在自己加入之后。
 * agent-teams 移除成员、同 id 换代都不清信箱，同名新成员或新一代不应读到旧信。
 */
export function visibleSince(identity: Pick<TeamIdentity, 'role' | 'agentKey' | 'team'>): number {
  const joined = identity.role === 'member'
    ? identity.team.members.find(m => m.name === identity.agentKey)?.joinedAt
    : undefined
  return Math.max(identity.team.createdAt, joined ?? 0)
}

/** 读取团队全部信箱，按可见性过滤。 */
export async function readMailView(identity: TeamIdentity): Promise<MailView> {
  const dir = join(identity.stateRoot, identity.team.id, 'inbox')
  let names: string[]
  try {
    names = (await readdir(dir)).filter(name => name.endsWith('.jsonl')).sort()
  } catch {
    return { messages: [], malformed: 0 }
  }
  const since = visibleSince(identity)
  const messages: MailMessage[] = []
  let malformed = 0
  for (const name of names) {
    let text: string
    try { text = await readFile(join(dir, name), 'utf8') } catch { continue }
    const parsed = parseMailbox(text)
    malformed += parsed.malformed
    for (const message of parsed.messages) if (message.ts >= since && canSee(identity, message)) messages.push(message)
  }
  messages.sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return { messages, malformed }
}

export type MailState = '已作废' | '已读' | '已投递' | '未读'

export function stateOf(message: MailMessage): MailState {
  if (message.discardedAt !== undefined) return '已作废'
  if (message.readAt !== undefined) return '已读'
  if (message.deliveredAt !== undefined) return '已投递'
  return '未读'
}

export interface MailFilter {
  from?: string
  to?: string
  taskId?: string
  includeDiscarded?: boolean
}

export function filterMail(messages: readonly MailMessage[], filter: MailFilter): MailMessage[] {
  return messages.filter(m => (filter.includeDiscarded === true || m.discardedAt === undefined)
    && (filter.from === undefined || m.from === filter.from)
    && (filter.to === undefined || m.to === filter.to)
    && (filter.taskId === undefined || m.taskId === filter.taskId || m.sourceTaskId === filter.taskId))
}
