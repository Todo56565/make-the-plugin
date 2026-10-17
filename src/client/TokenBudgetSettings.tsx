/** dsh-token-budget 的插件设置页（插件管理面板 → 本行 → 设置）。 */
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import { useEffect, useId, useState, type ReactNode } from 'react'
import { Button, SettingsForm, SettingsValueField, Switch, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { CatalogState } from './catalog.ts'
import { NS, formLabels, type TokenBudgetKey } from './locales.ts'
import { effortOptions, modelOptions, providerOptions, type Option } from './model-options.ts'
import { SNAPSHOT_MODES, type FieldName, type TokenBudgetFormInjected, type TokenBudgetFormState } from './settings-form.ts'
import css from './TokenBudgetSettings.module.css'

export interface TokenBudgetSettingsInjected extends TokenBudgetFormInjected {
  hooks: TokenBudgetFormInjected['hooks'] & { modelCatalog: HostObservable<CatalogState> }
  loadCatalog: (force?: boolean) => void
}

export type TokenBudgetSettingsProps = PropsRuntime<'plugins.row.config'> & PropsLocale<typeof NS> & InjectFace<TokenBudgetSettingsInjected>

type T = (key: TokenBudgetKey, params?: Record<string, string>) => string

function SwitchRow({ name, state, t, disabled, edit, extra }: {
  name: 'notes' | 'history' | 'teamHistory' | 'contextTool' | 'notesMerge' | 'mergeRecentTasks'
  state: TokenBudgetFormState; t: T; disabled: boolean; edit: (field: string, text: string) => void
  extra?: ReactNode
}) {
  const hint = `${name}Hint` as TokenBudgetKey
  return <div className={css.row}>
    <div className={css.text}>
      <span className={css.label}>{t(name)}{extra}</span>
      <p className={css.hint}>{t(hint)}</p>
    </div>
    <Switch checked={state[name].text === 'true'} label={t(name)} disabled={disabled}
      onChange={(next) => { edit(name, next ? 'true' : 'false') }} />
  </div>
}

/** 「例如」：悬停或聚焦时在下方弹出示例，点击可固定。 */
function ExamplePopover({ label, body }: { label: string; body: string }) {
  const [hover, setHover] = useState(false)
  const [pinned, setPinned] = useState(false)
  return <span className={css.exampleWrap} onMouseEnter={() => { setHover(true) }} onMouseLeave={() => { setHover(false) }}>
    <button type="button" className={css.example} aria-expanded={hover || pinned}
      onClick={() => { setPinned(v => !v) }} onFocus={() => { setHover(true) }} onBlur={() => { setHover(false); setPinned(false) }}>{label}</button>
    {(hover || pinned) && <pre className={css.exampleBody} role="tooltip">{body}</pre>}
  </span>
}

function SelectField({ name, label, options, placeholder, state, t, disabled, edit, reset }: {
  name: FieldName; label: string; options: Option[]; placeholder: string
  state: TokenBudgetFormState; t: T; disabled: boolean
  edit: (field: string, text: string) => void; reset: (field: string) => void
}) {
  const id = useId()
  const field = state[name]
  return <div className={css.field}>
    <div className={css.toolbar}>
      <label htmlFor={id}>{label}</label>
      {field.overridden && <><Tag tone="neutral">{t('overridden')}</Tag>
        <Button size="sm" disabled={disabled} onClick={() => { reset(name) }}>{t('reset')}</Button></>}
    </div>
    <select id={id} value={field.text} disabled={disabled} aria-invalid={field.invalid || undefined} className={field.text === '' ? css.empty : undefined}
      onChange={(event) => { edit(name, event.target.value) }}>
      <option value="">{placeholder}</option>
      {options.map(o => <option key={o.value} value={o.value} disabled={o.unavailable}>{o.label}</option>)}
    </select>
  </div>
}

export function TokenBudgetSettings(props: TokenBudgetSettingsProps) {
  const t = props.t as unknown as T
  const state = props.useTokenBudgetForm(value => value)
  const catalog = props.useModelCatalog(value => value)
  const ids = Object.fromEntries((['remindAtRatio', 'compactAtRatio', 'bucketStep', 'fallbackBufferTokens', 'maxFileBytes', 'workspaceMaxBytes', 'readMaxBytes', 'hintMaxBytes', 'hintRecentNotes',
    'historyMaxResults', 'historyMaxReadChars', 'historyMaxListItems', 'stateDir',
    'mergeSnapshotCount', 'mergeSnapshotPicks', 'workspaceSnapshotKeep', 'recordsCleanupDays'] as const).map(k => [k, `token-budget-${k}`]))
  useEffect(() => { props.loadCatalog() }, [props.loadCatalog])
  const disabled = !state.writable || state.saving
  const edit = props.edit, reset = props.resetField
  const unavailable = (value: string) => t('unavailableOption', { value })
  const provider = state.mergeProvider.text, model = state.mergeModel.text
  const mergeOn = state.notesMerge.text === 'true'
  const [snapshotsOpen, setSnapshotsOpen] = useState(false)

  // 级联：换提供方清空模型与推理强度；换模型清空推理强度
  const editProvider = (field: string, text: string) => { edit(field, text); edit('mergeModel', ''); edit('mergeReasoningEffort', '') }
  const editModel = (field: string, text: string) => { edit(field, text); edit('mergeReasoningEffort', '') }

  const value = (name: FieldName, labelKey: TokenBudgetKey, hintKey?: TokenBudgetKey, numeric = true, hintText?: string) =>
    <SettingsValueField key={name} id={ids[name]!} label={t(labelKey)} {...(hintText !== undefined ? { hint: hintText } : hintKey === undefined ? {} : { hint: t(hintKey) })}
      {...state[name]} numeric={numeric} overriddenLabel={t('overridden')} resetLabel={t('reset')} invalidLabel={t('invalid')}
      disabled={disabled} onEdit={(text) => { edit(name, text) }} onReset={() => { reset(name) }} />

  const snapshotMode = state.mergeSnapshots.text === '' ? 'off' : state.mergeSnapshots.text
  const countText = Number(state.mergeSnapshotCount.text), wsText = Number(state.workspaceMaxBytes.text)
  const sampleBytes = (Number.isInteger(countText) && countText > 0 ? countText : 5) * (Number.isInteger(wsText) && wsText > 0 ? wsText : 20000)
  const snapshotDir = `${state.stateDir.text === '' ? '.agent-teams' : state.stateDir.text}/.context/records/workspace-snapshots/`
  const example = <ExamplePopover label={t('example')} body={t('recentTasksExample')} />
  const modeLabels: Record<typeof SNAPSHOT_MODES[number], TokenBudgetKey> = { off: 'snapshotsOff', cosine: 'snapshotsCosine', custom: 'snapshotsCustom' }

  const efforts = effortOptions(catalog.providers, provider, model, state.mergeReasoningEffort.text, unavailable)

  return <SettingsForm labels={formLabels(t)} state={state} onSave={props.save} onDiscard={props.discard}>
    <div className={css.section}>
      <h4 className={css.heading}>{t('sectionSwitches')}</h4>
      <SwitchRow name="notes" state={state} t={t} disabled={disabled} edit={edit} />
      <SwitchRow name="history" state={state} t={t} disabled={disabled} edit={edit} />
      <SwitchRow name="teamHistory" state={state} t={t} disabled={disabled} edit={edit} />
      <SwitchRow name="contextTool" state={state} t={t} disabled={disabled} edit={edit} />
    </div>
    <div className={css.section}>
      <h4 className={css.heading}>{t('sectionBudget')}</h4>
      {value('remindAtRatio', 'remindAtRatio', 'remindAtRatioHint')}
      {value('compactAtRatio', 'compactAtRatio', 'compactAtRatioHint')}
      {value('bucketStep', 'bucketStep', 'bucketStepHint')}
      {value('fallbackBufferTokens', 'fallbackBufferTokens', 'fallbackBufferTokensHint')}
    </div>
    <div className={css.section}>
      <h3 className={css.title}>{t('sectionWorkspace')}</h3>
      <h4 className={css.heading}>{t('sectionMerge')}</h4>
      <SwitchRow name="notesMerge" state={state} t={t} disabled={disabled || state.notes.text === 'false'} edit={edit} />
      {mergeOn && <>
        {catalog.status === 'loading' && <p className={css.notice} role="status">{t('catalogLoading')}</p>}
        {catalog.status === 'error' && <div className={css.toolbar}>
          <p className={css.notice} role="status">{t('catalogFailed')}</p>
          <Button size="sm" onClick={() => { props.loadCatalog(true) }}>{t('retry')}</Button>
        </div>}
        <SelectField name="mergeProvider" label={t('mergeProvider')} placeholder={t('choose')} state={state} t={t} disabled={disabled}
          options={providerOptions(catalog.providers, provider, unavailable)} edit={editProvider} reset={reset} />
        <SelectField name="mergeModel" label={t('mergeModel')} placeholder={t('choose')} state={state} t={t} disabled={disabled || provider === ''}
          options={modelOptions(catalog.providers, provider, model, unavailable)} edit={editModel} reset={reset} />
        {(efforts.length > 0 || state.mergeReasoningEffort.text !== '') &&
          <SelectField name="mergeReasoningEffort" label={t('mergeEffort')} placeholder={t('effortDefault')} state={state} t={t}
            disabled={disabled || model === ''} options={efforts} edit={edit} reset={reset} />}
        {model === '' && <p className={css.notice} role="status">{t('mergeNeedsModel')}</p>}
        <h5 className={css.subheading}>{t('sectionMaterials')}</h5>
        <SwitchRow name="mergeRecentTasks" state={state} t={t} disabled={disabled} edit={edit} extra={example} />
        <div className={css.disclosure}>
          <div className={css.toolbar}>
            <button type="button" className={css.summary} aria-expanded={snapshotsOpen} aria-controls="token-budget-snapshots-body"
              onClick={() => { setSnapshotsOpen(v => !v) }}>
              <span className={snapshotsOpen ? css.chevronOpen : css.chevron} aria-hidden="true">›</span>
              <span className={css.label}>{t('mergeSnapshots')}</span>
              {!snapshotsOpen && <span className={css.summaryValue}>{t(modeLabels[snapshotMode as typeof SNAPSHOT_MODES[number]] ?? 'snapshotsOff')}</span>}
            </button>
            {state.mergeSnapshots.overridden && <><Tag tone="neutral">{t('overridden')}</Tag>
              <Button size="sm" disabled={disabled} onClick={() => { reset('mergeSnapshots') }}>{t('reset')}</Button></>}
          </div>
          {snapshotsOpen && <div id="token-budget-snapshots-body" className={css.disclosureBody}>
            <div className={css.field}>
              <select id="token-budget-mergeSnapshots" aria-label={t('mergeSnapshots')} value={snapshotMode} disabled={disabled}
                onChange={(event) => { edit('mergeSnapshots', event.target.value === 'off' ? '' : event.target.value) }}>
                {SNAPSHOT_MODES.map(mode => <option key={mode} value={mode}>{t(modeLabels[mode])}</option>)}
              </select>
            </div>
            {snapshotMode === 'cosine' && value('mergeSnapshotCount', 'mergeSnapshotCount', undefined, true, t('mergeSnapshotCountHint', { bytes: sampleBytes.toLocaleString() }))}
            {snapshotMode === 'custom' && value('mergeSnapshotPicks', 'mergeSnapshotPicks', 'mergeSnapshotPicksHint', false)}
          </div>}
        </div>
      </>}
    </div>
    <div className={css.section}>
      <h4 className={css.heading}>{t('sectionSnapshots')}</h4>
      {value('workspaceSnapshotKeep', 'workspaceSnapshotKeep', 'workspaceSnapshotKeepHint')}
      <div className={css.text}>
        <span className={css.label}>{t('snapshotDir')}</span>
        <code className={css.path}>{snapshotDir}</code>
      </div>
      {value('recordsCleanupDays', 'recordsCleanupDays', 'recordsCleanupDaysHint')}
    </div>
    <div className={css.section}>
      <h4 className={css.heading}>{t('sectionLimits')}</h4>
      {value('maxFileBytes', 'maxFileBytes')}
      {value('workspaceMaxBytes', 'workspaceMaxBytes')}
      {value('readMaxBytes', 'readMaxBytes')}
      {value('hintMaxBytes', 'hintMaxBytes', 'hintMaxBytesHint')}
      {value('hintRecentNotes', 'hintRecentNotes')}
      {value('historyMaxResults', 'historyMaxResults')}
      {value('historyMaxReadChars', 'historyMaxReadChars')}
      {value('historyMaxListItems', 'historyMaxListItems')}
      {value('stateDir', 'stateDir', 'stateDirHint', false)}
    </div>
  </SettingsForm>
}
