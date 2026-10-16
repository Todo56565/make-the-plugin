/** 设置页的暂存表单（DSH 共享表单模型，只在保存时写入）。 */
import {
  SettingsFormModel, settingsNumberField, settingsTextField,
  type SettingsFieldSpec, type SettingsFieldState, type SettingsFormActions, type SettingsFormScope, type SettingsFormShell,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'

export const BOOLEAN_FIELDS = ['notes', 'history', 'teamHistory', 'contextTool', 'notesMerge'] as const
export const RATIO_FIELDS = ['remindAtRatio', 'compactAtRatio', 'bucketStep'] as const
export const INTEGER_FIELDS = ['maxFileBytes', 'hintMaxBytes', 'hintRecentNotes', 'historyMaxResults', 'historyMaxReadChars', 'historyMaxListItems'] as const
export const MODEL_FIELDS = ['mergeProvider', 'mergeModel', 'mergeReasoningEffort'] as const
export const TEXT_FIELDS = ['stateDir'] as const

export type FieldName =
  | typeof BOOLEAN_FIELDS[number] | typeof RATIO_FIELDS[number] | typeof INTEGER_FIELDS[number]
  | typeof MODEL_FIELDS[number] | typeof TEXT_FIELDS[number]

export const ALL_FIELDS: readonly FieldName[] = [...BOOLEAN_FIELDS, ...RATIO_FIELDS, ...INTEGER_FIELDS, ...MODEL_FIELDS, ...TEXT_FIELDS]

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

function ratioField(field: string): SettingsFieldSpec {
  const base = settingsNumberField(field)
  return {
    ...base,
    parse: (text) => {
      if (text.trim() === '') return { kind: 'clear' }
      const value = Number(text)
      return Number.isFinite(value) && value > 0 && value < 1 ? { kind: 'set', value } : undefined
    },
  }
}

function integerField(field: string): SettingsFieldSpec {
  const base = settingsNumberField(field)
  return {
    ...base,
    parse: (text) => {
      if (text.trim() === '') return { kind: 'clear' }
      const value = Number(text)
      return Number.isInteger(value) && value >= 1 ? { kind: 'set', value } : undefined
    },
  }
}

/** 模型字段：空串 = 清除。 */
function optionalTextField(field: string): SettingsFieldSpec {
  return { ...settingsTextField(field), parse: text => text.trim() === '' ? { kind: 'clear' } : { kind: 'set', value: text.trim() } }
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
    ])
    this.state = this.form.bind(() => {
      const fields = Object.fromEntries(ALL_FIELDS.map(name => [name, this.form.field(name)])) as Record<FieldName, SettingsFieldState>
      return { ...this.form.shell(), ...fields }
    })
  }

  inject(): TokenBudgetFormInjected { return { hooks: { tokenBudgetForm: this.state }, ...this.form.actions() } }
  dispose(): void { this.form.dispose() }
}
