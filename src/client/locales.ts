/** 设置页文案（中英）。 */
import type { SettingsFormLabels } from '@deepseek-ai/dsh-client-ui-primitives'

export const NS = 'tokenBudget'

export const en = {
  sectionSwitches: 'Features', sectionBudget: 'Token budget', sectionWorkspace: 'workspace.md', sectionMerge: 'Note merge', sectionMaterials: 'Also include', sectionSnapshots: 'Snapshots', sectionLimits: 'Limits',
  notes: 'Team notes', notesHint: 'team_notes tool and note pointers in the handoff',
  history: 'History tools', historyHint: 'Read-only access to earlier compacted windows',
  teamHistory: 'Team mail history', teamHistoryHint: 'team_history tool: read past team messages, including read ones',
  contextTool: 'context_remaining tool', contextToolHint: 'Let agents query remaining context',
  remindAtRatio: 'Remind from (ratio)', remindAtRatioHint: 'Members get reminders from this share of the context; must be below the switch ratio, e.g. 0.37',
  compactAtRatio: 'New window at (ratio)', compactAtRatioHint: 'Members switch to a new context window here (captains are only reminded), e.g. 0.45; at least 0.03',
  bucketStep: 'Reminder step', bucketStepHint: 'Reminder levels are this far apart, e.g. 0.03 (members 37/40%, captain 45/48%)',
  fallbackBufferTokens: 'Fallback buffer (tokens)', fallbackBufferTokensHint: 'Extra room for a member to update its notes after reaching the switch point, e.g. 16384',
  plainPace: 'Plain sessions switch like', plainPaceHint: 'Sessions outside any team: like a member (switch at the ratio above) or like a captain (reminders only)', paceMember: 'A member (default)', paceCaptain: 'A captain',
  notesMerge: 'Merge member notes with an external model', notesMergeHint: 'Member note snapshots taken when tasks end go to the pending list; the chosen model merges them into workspace.md. Off: the captain works through the list',
  mergeRecentTasks: 'Recent task records', mergeRecentTasksHint: 'Full task records since the last merge, up to 16,000 bytes', example: 'Example', recentTasksExample: "## alpha@mgu3k1c0:t-007:2\n\n- Team: Alpha (alpha@mgu3k1c0)\n- Task: t-007 Add edge-case tests for snapshot-sampling\n- Assignee: tester-1, session 7c1e…\n- attempt: 2\n- Status: completed\n- Member note snapshots:\n  - records/teams/alpha/t-007/a2/001-3f9c2a1b.md (window switch, 7c1e…/w1/e214)\n  - records/teams/alpha/t-007/a2/002-8d04e6f7.md (terminal, 7c1e…/w2/e388)\n\n### output\n\nAdded tests for N<m, N=1, m=1 …\n(entries over 32 KB are truncated, with the original length noted)\n\n### changedPaths\n\nsrc/notes/snapshot-sampling.ts …",
  mergeSnapshots: 'Earlier workspace.md snapshots (experimental)', snapshotsOff: 'Off', snapshotsCosine: 'Cosine sampling', snapshotsCustom: 'Custom',
  mergeSnapshotCount: 'Snapshots to sample', mergeSnapshotCountHint: 'Up to about {bytes} bytes; if the merge model\'s context is exceeded, snapshots are dropped from the middle and the oldest is kept',
  mergeSnapshotPicks: 'Snapshot numbers', mergeSnapshotPicksHint: 'Comma-separated, e.g. 1,5,12. These snapshots are never pruned; if the merge model\'s context is exceeded, they are dropped from the middle too',
  workspaceSnapshotKeep: 'Snapshots to keep', workspaceSnapshotKeepHint: '0 keeps all; otherwise prune to this many (at least 2) once 100 accumulate; custom numbers are kept on top',
  snapshotDir: 'Snapshot folder',
  recordsCleanupDays: 'Clean up ended team generations (days)', recordsCleanupDaysHint: '0 never cleans up; when due, deletes that generation\'s member note snapshots, moved notes and pending list; full task records stay',
  mergeProvider: 'Provider', mergeModel: 'Model', mergeEffort: 'Reasoning effort', effortDefault: 'Model default',
  choose: 'Choose…', unavailableOption: '{value} — unavailable', catalogLoading: 'Loading models…',
  catalogFailed: 'Could not load the model list.', retry: 'Retry', mergeNeedsModel: 'Choose a model to enable merging.',
  maxFileBytes: 'Max member note size (bytes)', workspaceMaxBytes: 'Max workspace.md size (bytes)', readMaxBytes: 'Max note read size (bytes)', hintMaxBytes: 'Max handoff size (bytes)', hintMaxBytesHint: 'At least 4000', hintRecentNotes: 'Recent notes in handoff', hintRecentNotesHint: 'How many recently changed notes the window handoff lists',
  historyMaxResults: 'Max search results', historyMaxResultsHint: 'Most results one history search or note search returns',
  historyMaxReadChars: 'Max read characters', historyMaxReadCharsHint: 'Most characters one history read or teammate-mail read returns; longer text is truncated',
  historyMaxListItems: 'Max listed items', historyMaxListItemsHint: 'Most entries one history listing or mail listing returns',
  stateDir: 'agent-teams state directory', stateDirHint: 'Must match the agent-teams row',
  invalid: 'Invalid value', overridden: 'Overridden', reset: 'Reset to default',
  unavailable: 'Settings are unavailable.', readOnly: 'This deployment stores settings read-only.',
  saveFailed: 'The deployment did not accept these values.', save: 'Save', saving: 'Saving…',
  summary: 'Context budget, notes, and history for top-level and AgentTeams sessions',
}

export type TokenBudgetKey = keyof typeof en

export const zh: Record<TokenBudgetKey, string> = {
  sectionSwitches: '功能开关', sectionBudget: 'Token 预算', sectionWorkspace: 'workspace.md', sectionMerge: 'note 合并', sectionMaterials: '附带', sectionSnapshots: '快照配置', sectionLimits: '上限',
  notes: '团队笔记', notesHint: 'team_notes 工具与交接里的笔记指针',
  history: '历史工具', historyHint: '只读回看先前被压缩的窗口',
  teamHistory: '团队信件回看', teamHistoryHint: 'team_history 工具：回看团队信件，含已读的信',
  contextTool: 'context_remaining 工具', contextToolHint: '允许智能体查询剩余上下文',
  remindAtRatio: '开始提醒（比例）', remindAtRatioHint: '成员上下文已用比例达到该值起提醒，须小于换窗比例，例如 0.37',
  compactAtRatio: '换窗（比例）', compactAtRatioHint: '成员达到该比例时换到新窗口（队长只提醒），例如 0.45；最低 0.03',
  bucketStep: '提醒步长', bucketStepHint: '相邻两档提醒的间隔，例如 0.03（成员 37/40%，队长 45/48%）',
  fallbackBufferTokens: '兜底额度（token）', fallbackBufferTokensHint: '成员到换窗点后补记笔记的额外额度，例如 16384',
  plainPace: '普通会话换窗节奏', plainPaceHint: '不在团队中的会话：按队员（到上面的换窗比例就换）或按队长（只提醒）', paceMember: '按队员（默认）', paceCaptain: '按队长',
  notesMerge: '由外接模型合并成员笔记', notesMergeHint: '成员任务结束时的笔记快照进入待合并清单，由所选模型合并进 workspace.md；关闭时由队长处理清单',
  mergeRecentTasks: '近期任务记录', mergeRecentTasksHint: '上次合并以来的任务全文，最多 16,000 字节', example: '例如', recentTasksExample: "## alpha@mgu3k1c0:t-007:2\n\n- 团队：Alpha（alpha@mgu3k1c0）\n- 任务：t-007 给 snapshot-sampling 加边界测试\n- 执行者：tester-1，会话 7c1e…\n- attempt：2\n- 状态：completed\n- 成员笔记快照：\n  - records/teams/alpha/t-007/a2/001-3f9c2a1b.md（换窗，7c1e…/w1/e214）\n  - records/teams/alpha/t-007/a2/002-8d04e6f7.md（终态，7c1e…/w2/e388）\n\n### output\n\n边界情况已补测试：N<m、N=1、m=1……\n（单条超过 32 KB 时截断 output 并注明原长）\n\n### changedPaths\n\nsrc/notes/snapshot-sampling.ts ……",
  mergeSnapshots: 'workspace.md 历史快照（实验性）', snapshotsOff: '关', snapshotsCosine: '余弦取样', snapshotsCustom: '自定义',
  mergeSnapshotCount: '取样份数', mergeSnapshotCountHint: '最多约 {bytes} 字节；超出合并模型上下文时从中间丢弃，最旧一份保留',
  mergeSnapshotPicks: '快照编号', mergeSnapshotPicksHint: '用逗号分隔，例如 1,5,12；这些快照不会被精简；超出合并模型上下文时同样从中间丢弃',
  workspaceSnapshotKeep: '快照保留份数', workspaceSnapshotKeepHint: '0 为全部保留；否则累计 100 份时精简到该份数（最少 2），自定义编号额外保留',
  snapshotDir: '快照目录',
  recordsCleanupDays: '清理已结束的团队代（天）', recordsCleanupDaysHint: '0 为不清理；到期删除该代的成员笔记快照、搬入的笔记与待合并清单，全文记录保留',
  mergeProvider: '提供方', mergeModel: '模型', mergeEffort: '推理强度', effortDefault: '模型默认',
  choose: '请选择…', unavailableOption: '{value}（不可用）', catalogLoading: '正在加载模型…',
  catalogFailed: '无法加载模型列表', retry: '重试', mergeNeedsModel: '请选择模型后再开启合并',
  maxFileBytes: '成员/队长单个笔记上限（字节）', workspaceMaxBytes: 'workspace.md 上限（字节）', readMaxBytes: '单次读取笔记上限（字节）', hintMaxBytes: '交接上限（字节）', hintMaxBytesHint: '最低 4000', hintRecentNotes: '交接列出的最近笔记数', hintRecentNotesHint: '换窗交接时列出最近改动的几份笔记',
  historyMaxResults: '搜索结果上限', historyMaxResultsHint: '历史搜索和笔记搜索每次最多返回的条数',
  historyMaxReadChars: '单次读取字符上限', historyMaxReadCharsHint: '读历史、读队员来信时每次最多返回的字符，超出截断',
  historyMaxListItems: '单次列出条目上限', historyMaxListItemsHint: '列历史条目、列来信时每次最多的条数',
  stateDir: 'agent-teams 状态目录', stateDirHint: '须与 agent-teams 行一致',
  invalid: '值无效', overridden: '已覆盖', reset: '恢复默认',
  unavailable: '设置暂不可用', readOnly: '本部署的设置为只读',
  saveFailed: '本部署没有接受这些值', save: '保存', saving: '保存中…',
  summary: '顶层会话与 AgentTeams 会话的上下文预算、笔记与历史',
}

export function formLabels(t: (key: TokenBudgetKey) => string): SettingsFormLabels {
  return { unavailable: t('unavailable'), readOnly: t('readOnly'), saveFailed: t('saveFailed'), save: t('save'), saving: t('saving') }
}
