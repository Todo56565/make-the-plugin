/** 设置页的暂存表单（DSH 共享表单模型，只在保存时写入）。 */
import {
  SettingsFormModel, settingsNumberField, settingsTextField,
  type SettingsFieldSpec, type SettingsFieldState, type SettingsFormActions, type SettingsFormScope, type SettingsFormShell,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { normalizePicks } from './model-options.ts'

export const BOOLEAN_FIELDS = ['notes', 'history', 'teamHistory', 'contextTool', 'notesMerge', 'mergeRecentTasks'] as const
export const RATIO_FIELDS = ['remindAtRatio', 'compactAtRatio', 'bucketStep'] as const
export const INTEGER_FIELDS = ['fallbackBufferTokens', 'maxFileBytes', 'workspaceMaxBytes', 'readMaxBytes', 'hintMaxBytes', 'hintRecentNotes', 'historyMaxResults', 'historyMaxReadChars', 'historyMaxListItems',
  'mergeSnapshotCount', 'workspaceSnapshotKeep', 'recordsCleanupDays'] as const
export const MODEL_FIELDS = ['mergeProvider', 'mergeModel', 'mergeReasoningEffort'] as const
export const TEXT_FIELDS = ['stateDir'] as const
/** 材料 b 模式（off / cosine / custom）；空 = 默认 off。 */
export const SNAPSHOT_MODES = ['off', 'cosine', 'custom'] as const
/** 普通会话换窗节奏（member / captain）；空 = 默认 member。 */
export const PLAIN_PACES = ['member', 'captain'] as const
/** 下拉字段 → 可选值；第一个是默认值，选默认值即清除覆盖。 */
export const CHOICES = { mergeSnapshots: SNAPSHOT_MODES, plainPace: PLAIN_PACES } as const
export const CHOICE_FIELDS = ['mergeSnapshots', 'plainPace'] as const
/** 自定义快照编号：逗号分隔的正整数；空 = 清除。 */
export const PICKS_FIELDS = ['mergeSnapshotPicks'] as const

export type FieldName =
  | typeof BOOLEAN_FIELDS[number] | typeof RATIO_FIELDS[number] | typeof INTEGER_FIELDS[number]
  | typeof MODEL_FIELDS[number] | typeof TEXT_FIELDS[number] | typeof CHOICE_FIELDS[number] | typeof PICKS_FIELDS[number]

export const ALL_FIELDS: readonly FieldName[] = [...BOOLEAN_FIELDS, ...RATIO_FIELDS, ...INTEGER_FIELDS, ...MODEL_FIELDS, ...TEXT_FIELDS, ...CHOICE_FIELDS, ...PICKS_FIELDS]

export type TokenBudgetFormState = SettingsFormShell & Record<FieldName, SettingsFieldState>

export interface TokenBudgetFormInjected extends SettingsFormActions {
  hooks: { tokenBudgetForm: SnapshotStore<TokenBudgetFormState> }
}

function booleanField(field: string): SettingsFieldSpec {
  return {
    field,
    format: value => value === true ? 'true' : value === false ? 'false' : '',
    parse: text => text === 'true' ? { kind: 'set', value: true } : text === 'false' ? { kind: 'set', value: false } : text === '' ? { kind: 'clear' } : undefined,
  }
}

/** 比例字段的最低值（与插件 schema 一致）。 */
export const RATIO_MIN: Partial<Record<typeof RATIO_FIELDS[number], number>> = { remindAtRatio: 0.01, compactAtRatio: 0.03 }

function ratioField(field: typeof RATIO_FIELDS[number]): SettingsFieldSpec {
  const base = settingsNumberField(field)
  const min = RATIO_MIN[field] ?? 0
  return {
    ...base,
    parse: (text) => {
      if (text.trim() === '') return { kind: 'clear' }
      const value = Number(text)
      return Number.isFinite(value) && value > 0 && value >= min && value < 1 ? { kind: 'set', value } : undefined
    },
  }
}

/** 整数字段的最低值（与插件 schema 一致）；未列出的为 1。 */
export const INTEGER_MIN: Partial<Record<typeof INTEGER_FIELDS[number], number>> = { hintMaxBytes: 4000, workspaceSnapshotKeep: 0, recordsCleanupDays: 0 }

function integerField(field: typeof INTEGER_FIELDS[number]): SettingsFieldSpec {
  const base = settingsNumberField(field)
  const min = INTEGER_MIN[field] ?? 1
  return {
    ...base,
    parse: (text) => {
      if (text.trim() === '') return { kind: 'clear' }
      const value = Number(text)
      return Number.isInteger(value) && value >= min ? { kind: 'set', value } : undefined
    },
  }
}

/** 模型字段：空串 = 清除。 */
function optionalTextField(field: string): SettingsFieldSpec {
  return { ...settingsTextField(field), parse: text => text.trim() === '' ? { kind: 'clear' } : { kind: 'set', value: text.trim() } }
}

function choiceField(field: typeof CHOICE_FIELDS[number]): SettingsFieldSpec {
  const options: readonly string[] = CHOICES[field]
  return {
    ...settingsTextField(field),
    parse: text => text === '' || text === options[0] ? { kind: 'clear' } : options.includes(text) ? { kind: 'set', value: text } : undefined,
  }
}

function picksField(field: string): SettingsFieldSpec {
  return {
    ...settingsTextField(field),
    parse: (text) => {
      if (text.trim() === '') return { kind: 'clear' }
      const value = normalizePicks(text)
      return value === undefined ? undefined : { kind: 'set', value }
    },
  }
}

export class TokenBudgetForm {
  private readonly form: SettingsFormModel<Record<string, unknown>>
  private readonly state: SnapshotStore<TokenBudgetFormState>

  constructor(scope: SettingsFormScope<Record<string, unknown>>) {
    this.form = new SettingsFormModel(scope, [
      ...BOOLEAN_FIELDS.map(booleanField),
      ...RATIO_FIELDS.map(ratioField),
      ...INTEGER_FIELDS.map(integerField),
      ...MODEL_FIELDS.map(optionalTextField),
      ...TEXT_FIELDS.map(field => ({ ...settingsTextField(field), parse: (text: string) => text.trim() === '' ? undefined : { kind: 'set' as const, value: text.trim() } })),
      ...CHOICE_FIELDS.map(choiceField),
      ...PICKS_FIELDS.map(picksField),
    ])
    this.state = this.form.bind(() => {
      const fields = Object.fromEntries(ALL_FIELDS.map(name => [name, this.form.field(name)])) as Record<FieldName, SettingsFieldState>
      return { ...this.form.shell(), ...fields }
    })
  }

  inject(): TokenBudgetFormInjected { return { hooks: { tokenBudgetForm: this.state }, ...this.form.actions() } }
  dispose(): void { this.form.dispose() }
}
