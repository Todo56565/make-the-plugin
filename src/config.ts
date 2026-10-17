/**
 * dsh-token-budget 配置 schema 与默认值。
 *
 * 权威定义见 docs/design/plugin-design.md §2.2。
 * 插件整体由 DSH 插件管理面板启停；能力开关为 notes / history / teamHistory / contextTool，
 * token budget 是插件本体，没有开关。
 */

import type { Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

/** token budget：提示与主动压缩阈值（均为占路由容量 W 的比例）。 */
export interface BudgetConfig {
  /** 已用比例达到该值起提示（默认 0.37）。 */
  remindAtRatio: number
  /** 已用比例达到该值时成员换窗（默认 0.45）；队长只在此处与再后一档各提醒一次。 */
  compactAtRatio: number
  /** 提醒档位步长（默认 0.03 ⇒ 成员 37/40%，队长 45/48%）。 */
  bucketStep: number
  /** 成员到 compactAtRatio 后补记笔记的额外额度（token，默认 16384，同 Codex）。 */
  fallbackBufferTokens: number
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
  /** 成员/队长单个笔记的字节上限（默认 10000）。 */
  maxFileBytes: number
  /** workspace.md 的字节上限（默认 20000）。 */
  workspaceMaxBytes: number
  /** 换窗交接的字节上限（默认 4000，也是最低值）；超限先少列最近笔记，再截断过长的团队名/任务标题。 */
  hintMaxBytes: number
  /** 交接中列出的最近改动笔记数（默认 5）。 */
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

/** 插件内部使用的分组配置（由扁平配置换算）。 */
export interface Settings {
  stateDir: string
  notes: boolean
  history: boolean
  /** 团队信件回看工具 team_history（默认开启）。 */
  teamHistory: boolean
  budget: BudgetConfig
  notesMerge: NotesMergeConfig
  notesOptions: NotesOptions
  historyOptions: HistoryOptions
}

/**
 * 插件行配置（扁平）。
 *
 * DSH 插件设置页的表单模型只按顶层字段读写（`SettingsFormModel` 的路径为 `[field]`），
 * 所以对外配置保持一层；插件内部再换算成 {@link Settings}。
 * 所有字段都是即时字段（`.volatile()`）：只有即时字段会出现在设置表单里，
 * 修改后宿主经 volatile HMR 更新，不重启插件（见 DSH docs/cookbook/adding-a-settings-card）。
 */
export interface Config {
  /** agent-teams 的状态目录名，必须与 agent-teams 行的 stateDir 一致（默认 `.agent-teams`）。 */
  stateDir: Volatile<string>
  /** 笔记能力（默认开启）。 */
  notes: Volatile<boolean>
  /** 只读历史工具（默认开启）。 */
  history: Volatile<boolean>
  /** 团队信件回看工具（默认开启）。 */
  teamHistory: Volatile<boolean>
  remindAtRatio: Volatile<number>
  compactAtRatio: Volatile<number>
  bucketStep: Volatile<number>
  fallbackBufferTokens: Volatile<number>
  contextTool: Volatile<boolean>
  notesMerge: Volatile<boolean>
  mergeProvider: Volatile<string | undefined>
  mergeModel: Volatile<string | undefined>
  mergeReasoningEffort: Volatile<string | undefined>
  maxFileBytes: Volatile<number>
  workspaceMaxBytes: Volatile<number>
  hintMaxBytes: Volatile<number>
  hintRecentNotes: Volatile<number>
  historyMaxResults: Volatile<number>
  historyMaxReadChars: Volatile<number>
  historyMaxListItems: Volatile<number>
}

/** 交接字节上限的默认值与最低值。 */
export const HINT_MIN_BYTES = 4_000

/**
 * compactAtRatio 的最低值。实测（2026-10-16，W = 1,000,000，deepseek-flash）：成员每个新窗口开局约 1.2%
 * （首个请求 11.7k–12.2k token），0.03 时每窗口约 18k token 可用，换窗正常、无连环换窗；
 * 再低则 remindAtRatio 只能 ≤ 0.01，低于开局用量，且队长开局约 2.1%。见 docs/design/0.3.0-handoff.md §11。
 */
export const COMPACT_MIN_RATIO = 0.03
/** remindAtRatio 的最低值（须小于 compactAtRatio）。 */
export const REMIND_MIN_RATIO = 0.01

const ratio = (value: number, min = 0) => z.number().min(min).max(1).step(0.01).default(value)

export const Config = z.object({
  stateDir: z.string().default('.agent-teams').description('agent-teams 状态目录名，须与 agent-teams 行的 stateDir 一致').volatile(),
  notes: z.boolean().default(true).description('成员笔记与共享 workspace.md').volatile(),
  history: z.boolean().default(true).description('只读历史工具：读取本会话先前窗口中被压缩隐藏的原始消息').volatile(),
  teamHistory: z.boolean().default(true).description('团队信件回看工具 team_history：含已读和已作废的信').volatile(),
  remindAtRatio: ratio(0.37, REMIND_MIN_RATIO).description('成员上下文已用比例达到该值起提醒（须小于 compactAtRatio，最低 0.01）').volatile(),
  compactAtRatio: ratio(0.45, COMPACT_MIN_RATIO).description('上下文已用比例达到该值时成员换窗（仅团队会话；队长只提醒；最低 0.03）').volatile(),
  bucketStep: z.number().min(0.01).max(0.5).step(0.01).default(0.03).description('提醒档位步长').volatile(),
  fallbackBufferTokens: z.natural().min(1).default(16_384).description('成员到换窗点后补记笔记的额外额度（token）').volatile(),
  contextTool: z.boolean().default(true).description('注册 context_remaining 工具').volatile(),
  notesMerge: z.boolean().default(false).description('成员任务完成时自动合并共享笔记；关闭时由队长维护 workspace.md').volatile(),
  mergeProvider: z.string().description('合并使用的模型提供方').volatile(),
  mergeModel: z.string().description('合并使用的模型').volatile(),
  mergeReasoningEffort: z.string().description('合并使用的推理强度').volatile(),
  maxFileBytes: z.natural().min(1).default(10_000).description('成员/队长单个笔记的字节上限').volatile(),
  workspaceMaxBytes: z.natural().min(1).default(20_000).description('workspace.md 的字节上限').volatile(),
  hintMaxBytes: z.natural().min(HINT_MIN_BYTES).default(HINT_MIN_BYTES).description('换窗交接的字节上限（最低 4000）').volatile(),
  hintRecentNotes: z.natural().min(1).default(5).description('换窗交接列出的最近改动笔记数').volatile(),
  historyMaxResults: z.natural().min(1).default(200).description('搜索结果上限').volatile(),
  historyMaxReadChars: z.natural().min(1).default(20_000).description('历史单次读取字符上限').volatile(),
  historyMaxListItems: z.natural().min(1).default(2_000).description('历史单次列出条目上限').volatile(),
})

type Readable<T> = Volatile<T> | T

/** 读取即时字段（兼容未包装的普通值，便于测试）。 */
function read<T>(value: Readable<T>): T {
  return value !== null && typeof value === 'object' && typeof (value as { get?: unknown }).get === 'function'
    ? (value as Volatile<T>).get() as unknown as T
    : value as T
}

/** 扁平配置 ⇒ 分组配置（读取当下的即时值）。 */
export function toSettings(raw: Config | { [K in keyof Config]: unknown }): Settings {
  const config = new Proxy(raw as Record<string, unknown>, { get: (target, key) => read(target[key as string]) }) as unknown as {
    [K in keyof Config]: Config[K] extends Volatile<infer T> ? T : never
  }
  return {
    stateDir: config.stateDir,
    notes: config.notes,
    history: config.history,
    teamHistory: config.teamHistory,
    budget: {
      remindAtRatio: Math.max(REMIND_MIN_RATIO, config.remindAtRatio),
      compactAtRatio: Math.max(COMPACT_MIN_RATIO, config.compactAtRatio),
      bucketStep: config.bucketStep,
      fallbackBufferTokens: config.fallbackBufferTokens,
      tool: config.contextTool,
    },
    notesMerge: {
      enabled: config.notesMerge,
      provider: config.mergeProvider || undefined,
      model: config.mergeModel || undefined,
      reasoningEffort: config.mergeReasoningEffort || undefined,
    },
    notesOptions: {
      maxFileBytes: config.maxFileBytes,
      workspaceMaxBytes: config.workspaceMaxBytes,
      hintMaxBytes: Math.max(HINT_MIN_BYTES, config.hintMaxBytes),
      hintRecentNotes: config.hintRecentNotes,
    },
    historyOptions: {
      maxResults: config.historyMaxResults,
      maxReadChars: config.historyMaxReadChars,
      maxListItems: config.historyMaxListItems,
    },
  }
}

/** 即时配置更新后，原地刷新分组配置（保持对象身份，闭包里拿到的引用随之更新）。 */
export function refreshSettings(target: Settings, raw: Config): void {
  const next = toSettings(raw)
  target.stateDir = next.stateDir
  target.notes = next.notes
  target.history = next.history
  target.teamHistory = next.teamHistory
  Object.assign(target.budget, next.budget)
  target.notesMerge = next.notesMerge
  Object.assign(target.notesOptions, next.notesOptions)
  Object.assign(target.historyOptions, next.historyOptions)
}

/** 配置自洽性检查：返回需要告警的问题（不抛错，避免插件整体挂载失败）。 */
export function validateConfig(config: Settings): string[] {
  const problems: string[] = []
  const { remindAtRatio, compactAtRatio } = config.budget
  if (remindAtRatio >= compactAtRatio) {
    problems.push(`remindAtRatio (${remindAtRatio}) 应小于 compactAtRatio (${compactAtRatio})，否则成员不会收到换窗前的提醒`)
  }
  if (config.notesMerge.enabled && (config.notesMerge.provider === undefined || config.notesMerge.model === undefined)) {
    problems.push('notesMerge 已开启，但未选择模型；自动合并不会运行')
  }
  if (config.notes && config.stateDir.split(/[\\/]/).filter(Boolean)[0] !== '.agent-teams') {
    problems.push(`stateDir（${config.stateDir}）不在 .agent-teams 下：agent-teams 质量闸门只默认排除 .agent-teams/，笔记文件可能被计入交付审计`)
  }
  return problems
}
