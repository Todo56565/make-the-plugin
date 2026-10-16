/**
 * team_history 工具：只读回看团队信件（设计 §4.3，0.2.0）。单工具多 action（list / read / search）。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { TeamIdentity } from '../team/identity.ts'
import { filterMail, readMailView, stateOf, type MailFilter, type MailMessage, type MailView } from './mailbox.ts'

export const TEAM_HISTORY_TOOL = 'team_history'

export interface TeamHistoryLimits {
  maxResults: number
  maxReadChars: number
  maxListItems: number
}

export interface TeamHistoryArgs {
  action: string
  from?: string
  to?: string
  task_id?: string
  message_id?: string
  query?: string
  offset?: number
  limit?: number
  recent_first?: boolean
  include_discarded?: boolean
}

const DEFAULT_LIMIT = 20
const SNIPPET_RADIUS = 80

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

/** 宿主进程本地时间 `YYYY-MM-DD HH:mm:ss±HH:MM`（带时区，避免模型把 UTC 当成用户时间）。 */
export function formatTime(ts: number): string {
  const d = new Date(ts)
  const offset = -d.getTimezoneOffset()
  const zone = `${offset >= 0 ? '+' : '-'}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${zone}`
}

function header(m: MailMessage): string {
  const task = m.taskId !== undefined ? `，任务 ${m.taskId}` : m.sourceTaskId !== undefined ? `，来自任务 ${m.sourceTaskId}` : ''
  return `${m.id} ${formatTime(m.ts)} ${m.from} → ${m.to}（${stateOf(m)}${task}）`
}

function scopeLine(identity: TeamIdentity): string {
  return identity.role === 'captain' ? '范围：全队信箱' : `范围：发给 ${identity.agentKey} 的信和 ${identity.agentKey} 发出的信`
}

function malformedLine(view: MailView): string[] {
  return view.malformed > 0 ? [`（有 ${view.malformed} 行无法解析，已跳过）`] : []
}

function filterOf(args: TeamHistoryArgs): MailFilter {
  return {
    ...(args.from !== undefined && args.from !== '' ? { from: args.from } : {}),
    ...(args.to !== undefined && args.to !== '' ? { to: args.to } : {}),
    ...(args.task_id !== undefined && args.task_id !== '' ? { taskId: args.task_id } : {}),
    includeDiscarded: args.include_discarded === true,
  }
}

function list(identity: TeamIdentity, view: MailView, args: TeamHistoryArgs, limits: TeamHistoryLimits): string {
  const messages = filterMail(view.messages, filterOf(args))
  if (messages.length === 0) return [`没有信件。${scopeLine(identity)}`, ...malformedLine(view)].join('\n')
  const pairs = new Map<string, { count: number; unread: number; discarded: number; last: number }>()
  for (const m of messages) {
    const key = `${m.from} → ${m.to}`
    const entry = pairs.get(key) ?? { count: 0, unread: 0, discarded: 0, last: 0 }
    entry.count += 1
    if (m.discardedAt !== undefined) entry.discarded += 1
    else if (m.readAt === undefined) entry.unread += 1
    entry.last = Math.max(entry.last, m.ts)
    pairs.set(key, entry)
  }
  const rows = [...pairs.entries()].sort((a, b) => b[1].last - a[1].last)
  const lines = [`共 ${messages.length} 封信。${scopeLine(identity)}`]
  for (const [key, e] of rows.slice(0, limits.maxListItems)) {
    lines.push(`- ${key}：${e.count} 封（未读 ${e.unread}${e.discarded > 0 ? `，已作废 ${e.discarded}` : ''}），最近 ${formatTime(e.last)}`)
  }
  if (rows.length > limits.maxListItems) lines.push(`（只列出最近的 ${limits.maxListItems} 组）`)
  lines.push('用 action=read（可按 from / to / task_id 过滤）读正文。')
  return [...lines, ...malformedLine(view)].join('\n')
}

function read(identity: TeamIdentity, view: MailView, args: TeamHistoryArgs, limits: TeamHistoryLimits): string {
  if (args.message_id !== undefined && args.message_id !== '') {
    const m = view.messages.find(message => message.id === args.message_id)
    if (m === undefined) throw new Error(`没有可见的信 ${args.message_id}`)
    const body = m.content.length > limits.maxReadChars ? `${m.content.slice(0, limits.maxReadChars)}\n（正文已截断，共 ${m.content.length} 字符）` : m.content
    return `${header(m)}\n${body}`
  }
  const all = filterMail(view.messages, filterOf(args))
  if (args.recent_first === true) all.reverse()
  const offset = Math.max(0, Math.floor(args.offset ?? 0))
  const limit = Math.min(Math.max(1, Math.floor(args.limit ?? DEFAULT_LIMIT)), limits.maxListItems)
  if (all.length === 0) return [`没有信件。${scopeLine(identity)}`, ...malformedLine(view)].join('\n')
  if (offset >= all.length) throw new Error(`offset 超出范围：共 ${all.length} 封`)
  const out: string[] = []
  let used = 0
  let shown = 0
  for (const m of all.slice(offset, offset + limit)) {
    const block = `${header(m)}\n${m.content}`
    if (shown > 0 && used + block.length > limits.maxReadChars) break
    out.push(used + block.length > limits.maxReadChars ? `${block.slice(0, limits.maxReadChars - used)}\n（正文已截断，用 message_id 读全文）` : block)
    used += block.length
    shown += 1
  }
  const end = offset + shown
  const footer = `第 ${offset + 1}–${end} 封，共 ${all.length} 封${args.recent_first === true ? '（最新在前）' : '（时间正序）'}${end < all.length ? `；下一页 offset=${end}` : ''}`
  return [footer, '', out.join('\n\n'), ...malformedLine(view)].join('\n')
}

function search(identity: TeamIdentity, view: MailView, args: TeamHistoryArgs, limits: TeamHistoryLimits): string {
  const query = args.query ?? ''
  if (query === '') throw new Error('search 需要 query')
  const hits: string[] = []
  let total = 0
  for (const m of filterMail(view.messages, filterOf(args))) {
    const at = m.content.indexOf(query)
    if (at < 0) continue
    total += 1
    if (hits.length >= limits.maxResults) continue
    const start = Math.max(0, at - SNIPPET_RADIUS)
    const end = Math.min(m.content.length, at + query.length + SNIPPET_RADIUS)
    const snippet = `${start > 0 ? '…' : ''}${m.content.slice(start, end)}${end < m.content.length ? '…' : ''}`.replace(/\n/g, ' ')
    hits.push(`- ${header(m)}\n  ${snippet}`)
  }
  if (total === 0) return [`没有找到「${query}」。${scopeLine(identity)}`, ...malformedLine(view)].join('\n')
  const lines = [`找到 ${total} 封含「${query}」的信${total > hits.length ? `，显示前 ${hits.length} 封` : ''}。用 action=read + message_id 读全文。`, ...hits]
  return [...lines, ...malformedLine(view)].join('\n')
}

/** 执行一次 team_history 调用。纯逻辑（除读盘），便于测试。 */
export async function runTeamHistory(args: TeamHistoryArgs, identity: TeamIdentity, limits: TeamHistoryLimits): Promise<string> {
  const view = await readMailView(identity)
  switch (args.action) {
    case 'list': return list(identity, view, args, limits)
    case 'read': return read(identity, view, args, limits)
    case 'search': return search(identity, view, args, limits)
    default: throw new Error(`未知 action：${args.action}`)
  }
}

export interface TeamHistoryDeps {
  identityOf: (agent: Agent) => TeamIdentity | undefined
  limits: () => TeamHistoryLimits
}

export function registerTeamHistoryTool(ctx: Context, deps: TeamHistoryDeps): () => void {
  return ctx.tools.register(defineTool({
    name: TEAM_HISTORY_TOOL,
    description: '只读回看团队信件，含已读和已作废的信。队长看全队，成员看发给自己和自己发出的信。',
    parameters: {
      action: { type: 'string', enum: ['list', 'read', 'search'], required: true, description: 'list（按发信人→收信人汇总）/ read / search（字面，区分大小写）' },
      from: { type: 'string', description: '发信人："captain" 或成员名' },
      to: { type: 'string', description: '收信人："captain" 或成员名' },
      task_id: { type: 'string', description: '只看与该任务相关的信' },
      message_id: { type: 'string', description: 'read：读这一封的全文' },
      query: { type: 'string', description: 'search 的字面字符串' },
      offset: { type: 'integer', description: 'read 的起始序号，从 0 开始' },
      limit: { type: 'integer', description: `read 的封数，默认 ${DEFAULT_LIMIT}` },
      recent_first: { type: 'boolean', description: 'read：最新的在前' },
      include_discarded: { type: 'boolean', description: '包含已作废的信（默认不含）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { text: { type: 'string', required: true } },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const agent = exec.agent
      if (agent === undefined) throw new Error('team_history 需要调用方 agent')
      const identity = deps.identityOf(agent)
      if (identity === undefined) throw new Error('当前会话不属于任何 AgentTeams 团队，team_history 不可用')
      return { text: await runTeamHistory(args, identity, deps.limits()) }
    },
  }))
}
