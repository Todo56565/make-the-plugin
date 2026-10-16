import { test } from 'node:test'
import assert from 'node:assert/strict'
import { clock, handoffText, initialHandoffText, type HandoffInput } from '../../src/prompt/handoff.ts'
import { FrozenText, notesSectionText } from '../../src/prompt/notes-section.ts'
import type { TeamIdentity } from '../../src/team/identity.ts'

const member: TeamIdentity = {
  role: 'member', agentKey: 'bob', fileKey: 'bob', stateRoot: '/tmp/x',
  team: {
    id: 'team-7f3a', name: '接口重构', captainSessionId: 'c1', members: [],
    tasks: [
      { id: 't2', subject: '接口联调', status: 'in_progress', assignee: 'bob', attemptId: '59752a8f' },
      { id: 't3', subject: '已完成的', status: 'completed', assignee: 'bob' },
      { id: 't4', subject: '别人的', status: 'pending', assignee: 'alice' },
      { id: 't5', subject: '没人认领', status: 'pending' },
    ],
  },
}
const captain: TeamIdentity = { ...member, role: 'captain', agentKey: 'captain', fileKey: 'captain' }

const at = new Date(2026, 9, 16, 14, 20).getTime()
const metas = [
  { path: 'teams/team-7f3a/carol.md', lines: 5, bytes: 50, mtimeMs: at + 3 },
  { path: 'teams/team-7f3a/bob.md', lines: 42, bytes: 400, mtimeMs: at },
  { path: 'workspace.md', lines: 18, bytes: 180, mtimeMs: at - 1 },
  { path: 'teams/team-7f3a/alice.md', lines: 30, bytes: 300, mtimeMs: new Date(2026, 9, 16, 14, 5).getTime() },
]

function base(over: Partial<HandoffInput> = {}): HandoffInput {
  return {
    identity: member, previousWindow: 2, own: { kind: 'updated', at }, metas, recentNotes: 5, maxBytes: 4000,
    notes: true, history: true, teamHistory: true, ...over,
  }
}

test('常驻说明只放规则：不含路径、团队名、百分比；按角色区分', () => {
  const text = notesSectionText('member', { notes: true, history: true })
  assert.match(text, /## 团队笔记与换窗/)
  assert.match(text, /【交接】/)
  assert.match(text, /history_\*/)
  assert.match(text, /workspace\.md 由队长汇总/)
  assert.doesNotMatch(text, /teams\/|\d+%/)
  assert.match(notesSectionText('captain', { notes: true, history: true }), /你负责维护 workspace\.md/)
  assert.doesNotMatch(notesSectionText('member', { notes: false, history: true }), /team_notes/)
})

test('FrozenText：首次非空后冻结', () => {
  const frozen = new FrozenText()
  assert.equal(frozen.get('a', () => undefined), '')
  assert.equal(frozen.get('a', () => 'v1'), 'v1')
  assert.equal(frozen.get('a', () => 'v2'), 'v1')
})

test('交接（成员）：行序与内容同设计 §6，带 attempt_id', () => {
  const lines = handoffText(base()).split('\n')
  assert.deepEqual(lines, [
    '【交接】',
    '团队「接口重构」（team-7f3a），你的身份：bob（成员）。',
    '任务：t2 接口联调（in_progress），当前 attempt_id 59752a8f',
    `你的笔记：teams/team-7f3a/bob.md（42 行，上一窗口 ${clock(at)} 更新）`,
    '共享笔记：workspace.md（18 行）',
    `最近改动的笔记：teams/team-7f3a/carol.md（5 行，${clock(at + 3)}）；teams/team-7f3a/alice.md（30 行，14:05）`,
    '队长和队友的信：team_history（含已读）',
    '上一窗口：w2，原文用 history_list_items / history_search_contents / history_read_item 按窗口 id 回看',
    '以上是换窗时的快照，任务和笔记以 agent_teams 工具和 team_notes 为准。',
  ])
  assert.equal(clock(at), '14:20')
})

test('交接：笔记三种状态', () => {
  assert.match(handoffText(base({ own: { kind: 'incomplete', at } })), /bob\.md（42 行，上一窗口 14:20 更新，可能未写完，缺的用 history_\* 补）/)
  assert.match(handoffText(base({ own: { kind: 'stale' } })), /bob\.md（42 行，上一窗口未更新，进展需用 history_\* 恢复）/)
  assert.match(handoffText(base({ own: { kind: 'stale' }, metas: [] })), /bob\.md（尚未创建，上一窗口未更新/)
})

test('交接（队长）：任务行列未完成任务', () => {
  const text = handoffText(base({ identity: captain }))
  assert.match(text, /你的身份：captain（队长）/)
  assert.match(text, /团队未完成任务：3 个（t2、t4、t5）/)
  assert.match(text, /全队来往的信：team_history/)
})

test('交接：能力开关关闭时不出现对应行', () => {
  const text = handoffText(base({ notes: false, history: false, teamHistory: false }))
  assert.doesNotMatch(text, /笔记：|team_history|history_/)
  assert.match(text, /上一窗口：w2$/m)
  assert.match(text, /任务以 agent_teams 工具为准/)
})

test('交接超限：先少列最近笔记，再截断团队名 / 任务标题；必留行不丢', () => {
  const many = Array.from({ length: 5 }, (_, i) => ({ path: `teams/team-7f3a/${'m'.repeat(800)}${i}.md`, lines: 1, bytes: 1, mtimeMs: at + 10 + i }))
  const full = handoffText(base({ metas: [...metas, ...many], recentNotes: 9 }))
  assert.ok(Buffer.byteLength(full) <= 4000)
  assert.match(full, /最近改动的笔记/)
  const listed = (full.match(/m{800}/g) ?? []).length
  assert.ok(listed > 0 && listed < 5, `只列出部分最近笔记（${listed}）`)

  const longName = { ...member, team: { ...member.team, name: '名'.repeat(2000), tasks: [{ ...member.team.tasks[0]!, subject: '题'.repeat(2000) }] } }
  const cut = handoffText(base({ identity: longName }))
  assert.ok(Buffer.byteLength(cut) <= 4000, `截断后 ${Buffer.byteLength(cut)} 字节`)
  assert.doesNotMatch(cut, /最近改动的笔记/)
  for (const must of ['你的身份：bob', '任务：t2', 'attempt_id 59752a8f', '你的笔记：', '上一窗口：w2']) assert.ok(cut.includes(must), must)
  assert.match(cut, /名…」/)
})

test('w1 精简交接：身份 + 指针，不写任务和会变的元数据', () => {
  const text = initialHandoffText(member, { notes: true, history: true, teamHistory: true }, 4000)
  assert.equal(text, [
    '【交接】',
    '团队「接口重构」（team-7f3a），你的身份：bob（成员）。',
    '你的笔记：teams/team-7f3a/bob.md；共享笔记：workspace.md；队长和队友的信：team_history（含已读）',
  ].join('\n'))
  assert.equal(initialHandoffText(member, { notes: false, history: true, teamHistory: false }, 4000).split('\n').length, 2)
})
