import { test } from 'node:test'
import assert from 'node:assert/strict'
import { hintText, WindowHintCache } from '../../src/prompt/hint.ts'
import { FrozenText, notesSectionText } from '../../src/prompt/notes-section.ts'
import type { TeamIdentity } from '../../src/team/identity.ts'

const member: TeamIdentity = {
  role: 'member', agentKey: 'Alice', fileKey: 'alice', stateRoot: '/tmp/x',
  team: {
    id: 'team-a', name: 'A 队', captainSessionId: 'c1', members: [],
    tasks: [
      { id: 't1', subject: '调研方案', status: 'in_progress', assignee: 'Alice' },
      { id: 't2', subject: '已完成的', status: 'completed', assignee: 'Alice' },
      { id: 't3', subject: '别人的', status: 'pending', assignee: 'Bob' },
    ],
  },
}

test('notes 指针只依赖团队与身份', () => {
  const text = notesSectionText(member)
  assert.match(text, /teams\/team-a\/alice\.md/)
  assert.doesNotMatch(text, /\d+%/)
})

test('FrozenText：首次非空后冻结', () => {
  const frozen = new FrozenText()
  assert.equal(frozen.get('a', () => undefined), '')
  assert.equal(frozen.get('a', () => 'v1'), 'v1')
  assert.equal(frozen.get('a', () => 'v2'), 'v1')
})

test('hint：任务、笔记元数据、上限', () => {
  const metas = [
    { path: 'teams/team-a/bob.md', lines: 3, bytes: 30, mtimeMs: 3 },
    { path: 'teams/team-a/alice.md', lines: 2, bytes: 14, mtimeMs: 2 },
    { path: 'workspace.md', lines: 1, bytes: 9, mtimeMs: 1 },
  ]
  const text = hintText({ identity: member, notes: true, history: true, metas, recentNotes: 1, maxBytes: 4000 })
  assert.match(text, /t1 调研方案/)
  assert.doesNotMatch(text, /t2|t3/)
  assert.match(text, /你的笔记：teams\/team-a\/alice\.md（2 行，14 字节）/)
  assert.match(text, /bob\.md/)
  assert.doesNotMatch(text, /- workspace\.md/, 'recentNotes=1 只列一个')
  assert.match(text, /history/)
  assert.match(text, /本窗口开始时的快照/)
  assert.equal(hintText({ identity: member, notes: true, history: false, metas, recentNotes: 5, maxBytes: 50 }), '')
  assert.doesNotMatch(hintText({ identity: member, notes: false, history: false, metas, recentNotes: 5, maxBytes: 4000 }), /笔记/)
})

test('WindowHintCache：窗口不变不重算', () => {
  const cache = new WindowHintCache()
  let n = 0
  const compute = () => `v${++n}`
  assert.equal(cache.get('a', '1:t', compute), 'v1')
  assert.equal(cache.get('a', '1:t', compute), 'v1')
  assert.equal(cache.get('a', '2:t', compute), 'v2')
})
