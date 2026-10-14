/**
 * dsh-token-budget 配置 schema 与默认值。
 *
 * 权威定义见 docs/design/plugin-design.md §2.2。
 * 插件整体由 DSH 插件管理面板启停；这里只有两个能力开关（notes / history），
 * token budget 是插件本体，没有开关。
 */

import z from '@deepseek-ai/schemastery'

/** token budget：提示与主动压缩阈值（均为占路由容量 W 的比例）。 */
export interface BudgetConfig {
  /** 已用比例达到该值起提示（默认 0.37）。 */
  remindAtRatio: number
  /** 已用比例达到该值时，插件对团队会话主动压缩（默认 0.45，方案 D1）。 */
  compactAtRatio: number
  /** 提示文本按该步长量化，只在跨档时变化（默认 0.03 ⇒ 37/40/43%）。 */
  bucketStep: number
  /** 是否注册 context_remaining 工具（默认 true）。 */
  tool: boolean
}

/** 共享笔记自动合并（默认关闭 = 由队长维护 workspace.md）。 */
export interface NotesMergeConfig {
  enabled: boolean
  /** 开启时由用户从 DSH 账户的模型列表中选择。 */
  provider?: string
  model?: string
  reasoningEffort?: string
}

export interface NotesOptions {
  /** 单个笔记文件的字节上限（默认 10000）。 */
  maxFileBytes: number
  /** 笔记 hint 的字节上限，超过则整条不注入（默认 4000）。 */
  hintMaxBytes: number
  /** hint 中列出的最近笔记数（默认 5）。 */
  hintRecentNotes: number
}

export interface HistoryOptions {
  /** search_contents 返回结果上限（默认 200）。 */
  maxResults: number
  /** read_item 单次读取字符上限（默认 20000）。 */
  maxReadChars: number
  /** list_items 单次列出条目上限（默认 2000）。 */
  maxListItems: number
}

export interface Config {
  /** agent-teams 的状态目录名，必须与 agent-teams 行的 stateDir 一致（默认 `.agent-teams`）。 */
  stateDir: string
  /** 笔记能力（默认开启）。 */
  notes: boolean
  /** 只读历史工具（默认开启）。 */
  history: boolean
  budget: BudgetConfig
  notesMerge: NotesMergeConfig
  notesOptions: NotesOptions
  historyOptions: HistoryOptions
}

const ratio = (value: number) => z.number().min(0).max(1).step(0.01).default(value)

export const Config: z<Config> = z.object({
  stateDir: z.string().default('.agent-teams').description('agent-teams 状态目录名，须与 agent-teams 行的 stateDir 一致'),
  notes: z.boolean().default(true).description('成员笔记与共享 workspace.md'),
  history: z.boolean().default(true).description('只读历史工具：读取本会话先前窗口中被压缩隐藏的原始消息'),
  budget: z.object({
    remindAtRatio: ratio(0.37).description('上下文已用比例达到该值起提示'),
    compactAtRatio: ratio(0.45).description('上下文已用比例达到该值时主动压缩（仅团队会话）'),
    bucketStep: z.number().min(0.01).max(0.5).step(0.01).default(0.03).description('提示档位步长'),
    tool: z.boolean().default(true).description('注册 context_remaining 工具'),
  }).description('token budget'),
  notesMerge: z.object({
    enabled: z.boolean().default(false).description('自动合并共享笔记；关闭时由队长维护 workspace.md'),
    provider: z.string().description('合并使用的模型提供方'),
    model: z.string().description('合并使用的模型'),
    reasoningEffort: z.string().description('合并使用的推理强度'),
  }).description('共享笔记自动合并'),
  notesOptions: z.object({
    maxFileBytes: z.natural().default(10_000),
    hintMaxBytes: z.natural().default(4_000),
    hintRecentNotes: z.natural().min(1).default(5),
  }).description('笔记选项'),
  historyOptions: z.object({
    maxResults: z.natural().min(1).default(200),
    maxReadChars: z.natural().min(1).default(20_000),
    maxListItems: z.natural().min(1).default(2_000),
  }).description('历史工具选项'),
})

/** 配置自洽性检查：返回需要告警的问题（不抛错，避免插件整体挂载失败）。 */
export function validateConfig(config: Config): string[] {
  const problems: string[] = []
  const { remindAtRatio, compactAtRatio } = config.budget
  if (remindAtRatio >= compactAtRatio) {
    problems.push(`budget.remindAtRatio (${remindAtRatio}) 应小于 budget.compactAtRatio (${compactAtRatio})，否则不会出现提示`)
  }
  if (config.notesMerge.enabled && (config.notesMerge.provider === undefined || config.notesMerge.model === undefined)) {
    problems.push('notesMerge.enabled 已开启，但未选择 provider / model；自动合并不会运行')
  }
  return problems
}
