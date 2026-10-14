import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CompletionTracker, TeamToolCalls, cleanMergeOutput, mergeMemberNote, type Generate } from '../../src/notes/merge.ts'
import { NotesStore } from '../../src/notes/store.ts'
import type { TeamInfo } from '../../src/team/team-file.ts'

const team = (tasks: TeamInfo['tasks']): TeamInfo => ({ id: 'team-a', name: 'A 队', captainSessionId: 'c1', members: [], tasks })

test('CompletionTracker：首次只建快照，之后报告新完成的成员任务', () => {
  const tracker = new CompletionTracker()
  assert.deepEqual(tracker.observe('/r', [team([{ id: 't1', subject: 'x', status: 'completed', assignee: 'Alice' }])]), [])
  const found = tracker.observe('/r', [team([
    { id: 't1', subject: 'x', status: 'completed', assignee: 'Alice' },
    { id: 't2', subject: 'y', status: 'completed', assignee: 'Bob' },
    { id: 't3', subject: 'z', status: 'completed', assignee: 'captain' },
    { id: 't4', subject: 'w', status: 'in_progress', assignee: 'Bob' },
  ])])
  assert.deepEqual(found.map(f => f.task.id), ['t2'])
  assert.deepEqual(tracker.observe('/r', [team([{ id: 't2', subject: 'y', status: 'completed', assignee: 'Bob' }])]), [])
})

test('TeamToolCalls：只认 agent_teams_* 调用的返回', () => {
  const calls = new TeamToolCalls()
  calls.handle('s', 'tool/call', { callId: 'a', name: 'agent_teams_update_task' })
  calls.handle('s', 'tool/call', { callId: 'b', name: 'read' })
  assert.equal(calls.handle('s', 'tool/result', { message: { toolCallId: 'b' } }), false)
  assert.equal(calls.handle('other', 'tool/result', { message: { toolCallId: 'a' } }), false)
  assert.equal(calls.handle('s', 'tool/result', { message: { toolCallId: 'a' } }), true)
  assert.equal(calls.handle('s', 'tool/result', { message: { toolCallId: 'a' } }), false)
})

test('cleanMergeOutput 去掉整体代码块', () => {
  assert.equal(cleanMergeOutput('```markdown\n# 共享\n- a\n```'), '# 共享\n- a\n')
  assert.equal(cleanMergeOutput('  \n'), '')
})

function setup(max = 10_000) {
  const store = new NotesStore(mkdtempSync(join(tmpdir(), 'merge-')), max)
  const job = (generate: Generate) => ({
    store, teamId: 'team-a', teamName: 'A 队', memberName: 'Alice', memberFileKey: 'alice',
    taskId: 't1', taskSubject: '调研', generate, signal: new AbortController().signal,
  })
  return { store, job }
}

test('mergeMemberNote：合并、空笔记、超限、冲突', async () => {
  const { store, job } = setup(100)
  assert.equal(await mergeMemberNote(job(async () => 'x')), 'empty-note')
  await store.write('teams/team-a/alice.md', '结论：方案 B')
  let seen = ''
  assert.equal(await mergeMemberNote(job(async (_s, prompt) => { seen = prompt; return '# 共享\n- 方案 B（Alice，t1）' })), 'merged')
  assert.match(seen, /结论：方案 B/)
  assert.equal(await store.read('workspace.md'), '# 共享\n- 方案 B（Alice，t1）\n')
  assert.equal(await mergeMemberNote(job(async () => 'y'.repeat(200))), 'too-large')
  assert.equal(await mergeMemberNote(job(async () => '')), 'empty-output')
  let n = 0
  const racing: Generate = async () => { await store.write('workspace.md', `改动 ${++n}`); return '新内容' }
  assert.equal(await mergeMemberNote(job(racing)), 'conflict')
  assert.equal(await store.read('workspace.md'), '改动 2')
})
