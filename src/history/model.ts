/**
 * 历史模型（设计 §4.4）：把会话事件日志投影为「窗口 → 条目」的只读视图。纯逻辑，便于测试。
 *
 * - 窗口 N = 1 + 此前 `compaction/summary` 事件数；窗口 id 为 `w<N>`
 * - 条目只取产生消息的事件（user / assistant / tool / system / developer），条目 id 为 `e<seq>`
 * - 被隐藏的事件取自 `compaction/summary.shadowedSeqs` 与 `compaction/prune.shadowedSeqs`（宿主 tool-result pruner 裁剪超长工具结果时追加），条目上标 `hidden`；prune 不增加窗口计数
 * - 成员边界：只看 `seq >= minSeq`（fork 继承前缀之后）的事件
 */

export type HistoryRole = 'user' | 'assistant' | 'tool' | 'system' | 'developer'
export const HISTORY_ROLES: readonly HistoryRole[] = ['user', 'assistant', 'tool', 'system', 'developer']

/** 只用到的事件字段（与 `SessionEvent` 兼容的最小结构）。 */
export interface EventLike {
  type: string
  seq: number
  time: number
  data?: unknown
}

export interface HistoryItem {
  id: string
  seq: number
  window: number
  role: HistoryRole
  time: number
  /** tool 结果、或仅含工具调用的 assistant 消息所涉及的工具名。 */
  toolNames: string[]
  /** 已被压缩隐藏（当前上下文中看不到原文）。 */
  hidden: boolean
  /** 渲染后的纯文本。 */
  text: string
}

export interface HistoryWindow {
  id: string
  index: number
  /** 窗口起点的首个可见事件 seq。 */
  firstSeq: number
  lastSeq: number
  startTime: number
  endTime: number
  items: number
  hiddenItems: number
}

export interface HistoryModel {
  windows: HistoryWindow[]
  items: HistoryItem[]
  /** 当前（最新）窗口序号。 */
  currentWindow: number
}

interface Block { type?: unknown; text?: unknown; name?: unknown; arguments?: unknown; id?: unknown }

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
}

function blocksOf(message: unknown): Block[] {
  const content = asRecord(message)?.content
  return Array.isArray(content) ? content as Block[] : []
}

/** 渲染内容块：text 原样；tool-call 写成 `[调用 name(args)]`；图片/文件只留占位；推理不收录。 */
export function renderBlocks(blocks: readonly Block[]): { text: string; toolNames: string[] } {
  const parts: string[] = []
  const toolNames: string[] = []
  for (const block of blocks) {
    switch (block.type) {
      case 'text':
        if (typeof block.text === 'string' && block.text !== '') parts.push(block.text)
        break
      case 'tool-call': {
        const name = typeof block.name === 'string' ? block.name : '?'
        toolNames.push(name)
        parts.push(`[调用 ${name}(${typeof block.arguments === 'string' ? block.arguments : ''})]`)
        break
      }
      case 'image':
        parts.push('[图片]')
        break
      case 'file':
        parts.push('[文件]')
        break
      default:
        break
    }
  }
  return { text: parts.join('\n'), toolNames }
}

function messageOf(event: EventLike): { role: HistoryRole; message: unknown } | undefined {
  const data = asRecord(event.data)
  switch (event.type) {
    case 'user/message':
      return { role: 'user', message: data }
    case 'assistant/message':
      return { role: 'assistant', message: data?.message }
    case 'tool/result':
      return { role: 'tool', message: data?.message }
    case 'system/message':
      return { role: 'system', message: data?.message }
    case 'developer/message':
      return { role: 'developer', message: data?.message }
    default:
      return undefined
  }
}

/** 从事件列表构建历史模型。`events` 须按 seq 升序；`minSeq` 之前的事件只用于计窗口与工具名，不产出条目。 */
export function buildHistoryModel(events: readonly EventLike[], minSeq = 0): HistoryModel {
  const hiddenSeqs = new Set<number>()
  const toolNameByCall = new Map<string, string>()
  const items: HistoryItem[] = []
  let window = 1

  for (const event of events) {
    if (event.type === 'compaction/summary' || event.type === 'compaction/prune') {
      const shadowed = asRecord(event.data)?.shadowedSeqs
      if (Array.isArray(shadowed)) for (const seq of shadowed) if (typeof seq === 'number') hiddenSeqs.add(seq)
      if (event.type === 'compaction/summary' && event.seq >= minSeq) window += 1
      continue
    }
    if (event.type === 'tool/call') {
      const data = asRecord(event.data)
      if (typeof data?.callId === 'string' && typeof data.name === 'string') toolNameByCall.set(data.callId, data.name)
      continue
    }
    const projected = messageOf(event)
    if (projected === undefined) continue
    const blocks = blocksOf(projected.message)
    const rendered = renderBlocks(blocks)
    if (projected.role === 'assistant') {
      for (const block of blocks) {
        if (block.type === 'tool-call' && typeof block.id === 'string' && typeof block.name === 'string') toolNameByCall.set(block.id, block.name)
      }
    }
    if (event.seq < minSeq) continue
    let toolNames = rendered.toolNames
    if (projected.role === 'tool') {
      const callId = asRecord(projected.message)?.toolCallId
      const name = typeof callId === 'string' ? toolNameByCall.get(callId) : undefined
      toolNames = name === undefined ? [] : [name]
    }
    if (rendered.text === '' && toolNames.length === 0) continue
    items.push({
      id: `e${event.seq}`,
      seq: event.seq,
      window,
      role: projected.role,
      time: event.time,
      toolNames,
      hidden: false,
      text: rendered.text,
    })
  }

  for (const item of items) item.hidden = hiddenSeqs.has(item.seq)

  const windows = new Map<number, HistoryWindow>()
  for (const item of items) {
    let w = windows.get(item.window)
    if (w === undefined) {
      w = { id: `w${item.window}`, index: item.window, firstSeq: item.seq, lastSeq: item.seq, startTime: item.time, endTime: item.time, items: 0, hiddenItems: 0 }
      windows.set(item.window, w)
    }
    w.lastSeq = item.seq
    w.endTime = item.time
    w.items += 1
    if (item.hidden) w.hiddenItems += 1
  }
  return { windows: [...windows.values()], items, currentWindow: window }
}

export interface ItemFilter {
  windowId?: string | null
  role?: HistoryRole | null
  toolName?: string | null
}

/** 解析窗口 id：`w3` 或 `3`；无法识别返回 undefined。 */
export function parseWindowId(id: string): number | undefined {
  const match = /^w?(\d+)$/.exec(id.trim())
  return match === null ? undefined : Number(match[1])
}

/** 解析条目 id：`e123` 或 `123`。 */
export function parseItemId(id: string): number | undefined {
  const match = /^e?(\d+)$/.exec(id.trim())
  return match === null ? undefined : Number(match[1])
}

/** 按条件过滤条目；window_id 无法识别或不存在时抛错。 */
export function filterItems(model: HistoryModel, filter: ItemFilter): HistoryItem[] {
  let window: number | undefined
  if (filter.windowId != null && filter.windowId !== '') {
    window = parseWindowId(filter.windowId)
    if (window === undefined || (window !== model.currentWindow && !model.windows.some(w => w.index === window))) {
      const ids = model.windows.map(w => w.id)
      throw new Error(`窗口 ${filter.windowId} 不存在${ids.length > 0 ? `（现有：${ids.join('、')}）` : ''}`)
    }
  }
  return model.items.filter(item =>
    (window === undefined || item.window === window)
    && (filter.role == null || item.role === filter.role)
    && (filter.toolName == null || filter.toolName === '' || item.toolNames.includes(filter.toolName)))
}

/** 截断到 `max` 个字符（按 code point），返回是否截断。 */
export function truncateChars(text: string, max: number): { text: string; truncated: boolean; total: number } {
  const chars = [...text]
  if (chars.length <= max) return { text, truncated: false, total: chars.length }
  return { text: chars.slice(0, max).join(''), truncated: true, total: chars.length }
}

function stamp(time: number): string {
  return `${new Date(time).toISOString().replace('T', ' ').slice(0, 16)}Z`
}

export function formatWindow(window: HistoryWindow, current: number): string {
  const mark = window.index === current ? '（当前窗口）' : ''
  return `${window.id}${mark}：${window.items} 条，其中 ${window.hiddenItems} 条已被压缩隐藏；${stamp(window.startTime)} ~ ${stamp(window.endTime)}`
}

export function formatItemHeader(item: HistoryItem): string {
  const tools = item.toolNames.length > 0 ? ` ${item.toolNames.join(',')}` : ''
  const hidden = item.hidden ? ' 已隐藏' : ''
  return `[w${item.window} ${item.role}${tools}${hidden} ${stamp(item.time)}]`
}

export function formatItemPreview(item: HistoryItem, maxChars: number): string {
  const cut = truncateChars(item.text, maxChars)
  const tail = cut.truncated ? `…（共 ${cut.total} 字）` : ''
  return `${formatItemHeader(item)} ${cut.text}${tail} [id: ${item.id}]`
}

/**
 * 截至 `until`（毫秒时间戳）的最后一个条目位置；`until` 缺省取最后一个条目。
 * 供终态快照定位成员「做完时停在哪」：用任务 updatedAt 截断，成员之后接的新活不算。
 */
export function positionAt(model: HistoryModel, until?: number): { window: number; seq: number } | undefined {
  for (let i = model.items.length - 1; i >= 0; i--) {
    const item = model.items[i]!
    if (until === undefined || item.time <= until) return { window: item.window, seq: item.seq }
  }
  return undefined
}
