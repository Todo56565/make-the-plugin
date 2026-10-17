/** 设置页文案（中英）。 */
import type { SettingsFormLabels } from '@deepseek-ai/dsh-client-ui-primitives'

export const NS = 'tokenBudget'

export const en = {
  sectionSwitches: 'Features', sectionBudget: 'Token budget', sectionMerge: 'Shared notes merge', sectionLimits: 'Limits',
  notes: 'Team notes', notesHint: 'team_notes tool and note pointers in the handoff',
  history: 'History tools', historyHint: 'Read-only access to earlier compacted windows',
  teamHistory: 'Team mail history', teamHistoryHint: 'team_history tool: read past team messages, including read ones',
  contextTool: 'context_remaining tool', contextToolHint: 'Let agents query remaining context',
  remindAtRatio: 'Remind from (ratio)', remindAtRatioHint: 'Members get reminders from this share of the context; must be below the switch ratio, e.g. 0.37',
  compactAtRatio: 'New window at (ratio)', compactAtRatioHint: 'Members switch to a new context window here (captains are only reminded), e.g. 0.45; at least 0.03',
  bucketStep: 'Reminder step', bucketStepHint: 'Reminder levels are this far apart, e.g. 0.03 (members 37/40%, captain 45/48%)',
  fallbackBufferTokens: 'Fallback buffer (tokens)', fallbackBufferTokensHint: 'Extra room for a member to update its notes after reaching the switch point, e.g. 16384',
  notesMerge: 'Merge member notes into workspace.md when a task completes', notesMergeHint: 'Off: the captain maintains workspace.md',
  mergeProvider: 'Provider', mergeModel: 'Model', mergeEffort: 'Reasoning effort', effortDefault: 'Model default',
  choose: 'Choose…', unavailableOption: '{value} — unavailable', catalogLoading: 'Loading models…',
  catalogFailed: 'Could not load the model list.', retry: 'Retry', mergeNeedsModel: 'Choose a model to enable merging.',
  maxFileBytes: 'Max member note size (bytes)', workspaceMaxBytes: 'Max workspace.md size (bytes)', hintMaxBytes: 'Max handoff size (bytes)', hintMaxBytesHint: 'At least 4000', hintRecentNotes: 'Recent notes in handoff',
  historyMaxResults: 'Max search results', historyMaxReadChars: 'Max read characters', historyMaxListItems: 'Max listed items',
  stateDir: 'agent-teams state directory', stateDirHint: 'Must match the agent-teams row',
  invalid: 'Invalid value', overridden: 'Overridden', reset: 'Reset to default',
  unavailable: 'Settings are unavailable.', readOnly: 'This deployment stores settings read-only.',
  saveFailed: 'The deployment did not accept these values.', save: 'Save', saving: 'Saving…',
  summary: 'Context budget, notes, and history for AgentTeams sessions',
}

export type TokenBudgetKey = keyof typeof en

export const zh: Record<TokenBudgetKey, string> = {
  sectionSwitches: '功能开关', sectionBudget: 'Token 预算', sectionMerge: '共享笔记合并', sectionLimits: '上限',
  notes: '团队笔记', notesHint: 'team_notes 工具与交接里的笔记指针',
  history: '历史工具', historyHint: '只读回看先前被压缩的窗口',
  teamHistory: '团队信件回看', teamHistoryHint: 'team_history 工具：回看团队信件，含已读的信',
  contextTool: 'context_remaining 工具', contextToolHint: '允许智能体查询剩余上下文',
  remindAtRatio: '开始提醒（比例）', remindAtRatioHint: '成员上下文已用比例达到该值起提醒，须小于换窗比例，例如 0.37',
  compactAtRatio: '换窗（比例）', compactAtRatioHint: '成员达到该比例时换到新窗口（队长只提醒），例如 0.45；最低 0.03',
  bucketStep: '提醒步长', bucketStepHint: '相邻两档提醒的间隔，例如 0.03（成员 37/40%，队长 45/48%）',
  fallbackBufferTokens: '兜底额度（token）', fallbackBufferTokensHint: '成员到换窗点后补记笔记的额外额度，例如 16384',
  notesMerge: '成员任务完成时把其笔记合并进 workspace.md', notesMergeHint: '关闭时由队长维护 workspace.md',
  mergeProvider: '提供方', mergeModel: '模型', mergeEffort: '推理强度', effortDefault: '模型默认',
  choose: '请选择…', unavailableOption: '{value}（不可用）', catalogLoading: '正在加载模型…',
  catalogFailed: '无法加载模型列表', retry: '重试', mergeNeedsModel: '请选择模型后再开启合并',
  maxFileBytes: '成员/队长单个笔记上限（字节）', workspaceMaxBytes: 'workspace.md 上限（字节）', hintMaxBytes: '交接上限（字节）', hintMaxBytesHint: '最低 4000', hintRecentNotes: '交接列出的最近笔记数',
  historyMaxResults: '搜索结果上限', historyMaxReadChars: '单次读取字符上限', historyMaxListItems: '单次列出条目上限',
  stateDir: 'agent-teams 状态目录', stateDirHint: '须与 agent-teams 行一致',
  invalid: '值无效', overridden: '已覆盖', reset: '恢复默认',
  unavailable: '设置暂不可用', readOnly: '本部署的设置为只读',
  saveFailed: '本部署没有接受这些值', save: '保存', saving: '保存中…',
  summary: 'AgentTeams 会话的上下文预算、笔记与历史',
}

export function formLabels(t: (key: TokenBudgetKey) => string): SettingsFormLabels {
  return { unavailable: t('unavailable'), readOnly: t('readOnly'), saveFailed: t('saveFailed'), save: t('save'), saving: t('saving') }
}
