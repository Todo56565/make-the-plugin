/**
 * 只读历史工具（设计 §4.4，参照 Codex history-notes）：
 * history_list_windows / history_list_items / history_read_item / history_search_contents。
 *
 * 只读调用方自己的会话；团队会话专用（非团队会话报错）。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  HISTORY_ROLES, filterItems, formatItemHeader, formatItemPreview, formatWindow, parseItemId, parseWindowId,
  truncateChars, type HistoryModel, type HistoryRole,
} from './model.ts'

export const HISTORY_TOOLS = ['history_list_windows', 'history_list_items', 'history_read_item', 'history_search_contents'] as const

export interface HistoryLimits {
  /** search 结果上限。 */
  maxResults: number
  /** read_item 单次字符上限。 */
  maxReadChars: number
  /** list_items 单次条目上限。 */
  maxListItems: number
}

/** list_items / search 默认每条预览字符数。 */
const PREVIEW_CHARS = 200

function clamp(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined || !Number.isFinite(value) || value < 1) return Math.min(fallback, max)
  return Math.min(Math.floor(value), max)
}

function ordered<T>(list: T[], recentFirst: boolean | undefined): T[] {
  return recentFirst === true ? [...list].reverse() : list
}

export function runListWindows(model: HistoryModel, args: { limit?: number; recent_first?: boolean }): string {
  if (model.windows.length === 0) return '本会话还没有可读的历史。'
  const windows = ordered(model.windows, args.recent_first).slice(0, clamp(args.limit, model.windows.length, model.windows.length))
  return [`共 ${model.windows.length} 个窗口（压缩一次进入下一个窗口）。`, ...windows.map(w => formatWindow(w, model.currentWindow))].join('\n')
}

interface ListArgs {
  window_id?: string | null
  role?: string | null
  tool_name?: string | null
  limit?: number
  recent_first?: boolean
  max_chars_per_item?: number
}

function roleOf(role: string | null | undefined): HistoryRole | null {
  if (role == null || role === '') return null
  if (!(HISTORY_ROLES as readonly string[]).includes(role)) throw new Error(`未知 role：${role}`)
  return role as HistoryRole
}

export function runListItems(model: HistoryModel, args: ListArgs, limits: HistoryLimits): string {
  const items = filterItems(model, { windowId: args.window_id, role: roleOf(args.role), toolName: args.tool_name })
  if (items.length === 0) return '没有符合条件的条目。'
  const limit = clamp(args.limit, limits.maxListItems, limits.maxListItems)
  const page = ordered(items, args.recent_first).slice(0, limit)
  const preview = clamp(args.max_chars_per_item, PREVIEW_CHARS, limits.maxReadChars)
  const lines = page.map(item => formatItemPreview(item, preview))
  if (items.length > page.length) lines.push(`（共 ${items.length} 条，仅显示 ${page.length} 条；可用 window_id / role / tool_name 缩小范围）`)
  return lines.join('\n')
}

export function runReadItem(model: HistoryModel, args: { window_id: string; item_id: string; offset_chars?: number; limit_chars?: number }, limits: HistoryLimits): string {
  const window = parseWindowId(args.window_id)
  const seq = parseItemId(args.item_id)
  const item = window === undefined || seq === undefined ? undefined : model.items.find(i => i.seq === seq && i.window === window)
  if (item === undefined) throw new Error(`窗口 ${args.window_id} 中没有条目 ${args.item_id}`)
  const chars = [...item.text]
  const offset = Math.max(0, Math.floor(args.offset_chars ?? 0))
  const limit = clamp(args.limit_chars, limits.maxReadChars, limits.maxReadChars)
  const slice = chars.slice(offset, offset + limit).join('')
  const end = Math.min(chars.length, offset + limit)
  const tail = end < chars.length ? `\n（第 ${offset}-${end} 字，共 ${chars.length} 字；用 offset_chars=${end} 继续读）` : ''
  return `${formatItemHeader(item)}\n${slice}${tail}`
}

export function runSearch(model: HistoryModel, args: ListArgs & { query: string }, limits: HistoryLimits): string {
  if (args.query === '') throw new Error('query 不能为空')
  const items = filterItems(model, { windowId: args.window_id, role: roleOf(args.role), toolName: args.tool_name })
  const limit = clamp(args.limit, limits.maxResults, limits.maxResults)
  const hits = ordered(items, args.recent_first).filter(item => item.text.includes(args.query))
  if (hits.length === 0) return `没有找到「${args.query}」。`
  const lines = hits.slice(0, limit).map((item) => {
    const at = [...item.text.slice(0, item.text.indexOf(args.query))].length
    const chars = [...item.text]
    const start = Math.max(0, at - 60)
    const snippet = truncateChars(chars.slice(start).join(''), PREVIEW_CHARS).text
    return `${formatItemHeader(item)} ${start > 0 ? '…' : ''}${snippet} [id: ${item.id}]`
  })
  if (hits.length > limit) lines.push(`（共 ${hits.length} 条命中，仅显示前 ${limit} 条）`)
  return lines.join('\n')
}

export interface HistoryToolDeps {
  isTeamAgent: (agent: Agent) => boolean
  load: (agent: Agent, signal: AbortSignal | undefined) => Promise<HistoryModel>
  limits: () => HistoryLimits
}

const textOutput = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: { text: { type: 'string', required: true } },
  },
  render: (_args: unknown, value: { text: string }) => [{ type: 'text' as const, text: value.text }],
} as const

const filterParams = {
  window_id: { type: 'string', description: '窗口 id，如 w2；省略表示全部窗口' },
  role: { type: 'string', enum: [...HISTORY_ROLES], description: '只看某种角色的消息' },
  tool_name: { type: 'string', description: '只看涉及某个工具的条目' },
  recent_first: { type: 'boolean', description: '新的在前' },
} as const

export function registerHistoryTools(ctx: Context, deps: HistoryToolDeps): () => void {
  async function modelFor(agent: Agent | undefined, signal: AbortSignal | undefined): Promise<HistoryModel> {
    if (agent === undefined) throw new Error('历史工具需要调用方 agent')
    if (!deps.isTeamAgent(agent)) throw new Error('当前会话不属于任何 AgentTeams 团队，历史工具不可用')
    return deps.load(agent, signal)
  }

  const disposers = [
    ctx.tools.register(defineTool({
      name: 'history_list_windows',
      description: '列出本会话的上下文窗口（w1 最早，每次压缩后加一）及条目数。压缩掉的原文在这里只读保留，只能查自己的会话。',
      parameters: {
        limit: { type: 'integer', description: '最多返回几个窗口' },
        recent_first: { type: 'boolean', description: '新的在前' },
      },
      output: textOutput,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        return { text: runListWindows(await modelFor(exec.agent, exec.signal), args) }
      },
    })),
    ctx.tools.register(defineTool({
      name: 'history_list_items',
      description: '列出历史条目预览，可按窗口、角色、工具筛选。每条末尾的 [id: ...] 原样传给 history_read_item。',
      parameters: {
        ...filterParams,
        limit: { type: 'integer', description: '最多返回几条' },
        max_chars_per_item: { type: 'integer', description: '每条预览的字符数，默认 200' },
      },
      output: textOutput,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        return { text: runListItems(await modelFor(exec.agent, exec.signal), args, deps.limits()) }
      },
    })),
    ctx.tools.register(defineTool({
      name: 'history_read_item',
      description: '按 window_id 和 item_id 读取一个历史条目的原文，可分段。',
      parameters: {
        window_id: { type: 'string', required: true, description: '条目所在窗口 id' },
        item_id: { type: 'string', required: true, description: '条目 id，即 [id: ...] 里的值' },
        offset_chars: { type: 'integer', description: '从第几个字符开始（从 0 起）' },
        limit_chars: { type: 'integer', description: '最多读多少字符' },
      },
      output: textOutput,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        return { text: runReadItem(await modelFor(exec.agent, exec.signal), args, deps.limits()) }
      },
    })),
    ctx.tools.register(defineTool({
      name: 'history_search_contents',
      description: '在本会话历史原文中做区分大小写的字面搜索。',
      parameters: {
        query: { type: 'string', required: true, description: '字面字符串（区分大小写）' },
        ...filterParams,
        limit: { type: 'integer', description: '最多返回几条命中' },
      },
      output: textOutput,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        return { text: runSearch(await modelFor(exec.agent, exec.signal), args, deps.limits()) }
      },
    })),
  ]
  return () => { for (const dispose of disposers) dispose() }
}
