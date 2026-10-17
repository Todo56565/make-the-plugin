import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { notesTeamDir, pendingPath } from '../../src/context/layout.ts'
import { addPending, listPendingTeams, parseIds, pendingId, readPending, renderPending, resolvePending, resolvePendingByKey, type NewPendingEntry } from '../../src/notes/pending.ts'
import { NotesStore } from '../../src/notes/store.ts'
import { runTeamNotes } from '../../src/notes/tool.ts'
import { recordTerminalTasks } from '../../src/records/full.ts'
import type { TeamIdentity } from '../../src/team/identity.ts'
import type { TeamInfo, TeamTaskInfo } from '../../src/team/team-file.ts'

const A = { id: 'team-a', createdAt: 0 }
const B = { id: 'team-b', createdAt: 0 }
const item = (taskId: string, teamId = 'team-a', createdAt = 0): NewPendingEntry => ({
  key: `${teamId}@${createdAt.toString(36)}:${taskId}:1`, teamName: 'A 队', taskId, subject: `任务 ${taskId}`,
  attempt: 1, member: 'Alice', status: 'completed', snapshot: `records/teams/${teamId}/${taskId}/a1/001-abcdef12.md`, ref: 'sess/w2/e9', at: 0,
})

test('短 id 稳定、撞了加长；parseIds 支持逗号空格顿号', () => {
  const id = pendingId('k')
  assert.match(id, /^p[0-9a-f]{6}$/)
  assert.equal(pendingId('k'), id)
  assert.match(pendingId('k', new Set([id])), /^p[0-9a-f]{8}$/)
  assert.deepEqual(parseIds(' p1, p2 p3、p4，p5 '), ['p1', 'p2', 'p3', 'p4', 'p5'])
})

test('按团队代分文件：新增按 key 去重；删除只删指定 id，坏行原样保留；目录即全局队列', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pending-'))
  const added = await addPending(root, A, [item('t1'), item('t2'), item('t1')])
  assert.equal(added.length, 2)
  assert.equal(added[0]!.teamId, 'team-a')
  assert.equal((await addPending(root, A, [item('t2')])).length, 0)
  appendFileSync(pendingPath(root, 'team-a', 0), '坏行\n')
  await addPending(root, B, [item('t9', 'team-b')])
  await addPending(root, { id: 'team-a', createdAt: 99 }, [item('t1', 'team-a', 99)])
  assert.deepEqual(await listPendingTeams(root), [A, B, { id: 'team-a', createdAt: 99 }])
  const [a, b] = added
  const result = await resolvePending(root, A, [a!.id, 'pnope'])
  assert.deepEqual(result.removed.map(e => e.id), [a!.id])
  assert.deepEqual(result.missing, ['pnope'])
  assert.deepEqual((await readPending(root, A)).map(e => e.taskId), ['t2'])
  assert.deepEqual((await readPending(root, B)).map(e => e.taskId), ['t9'])
  assert.match(readFileSync(pendingPath(root, 'team-a', 0), 'utf8'), /坏行/)
  assert.equal(await resolvePendingByKey(root, A, b!.key), true)
  assert.equal(await resolvePendingByKey(root, A, b!.key), false)
})

test('渲染本队清单', () => {
  const entries = [item('t1')].map((e, i) => ({ schema: 1 as const, id: `p${i}`, teamId: 'team-a', createdAt: 0, ...e }))
  const text = renderPending(entries)
  assert.match(text, /待合并成员笔记 1 条/)
  assert.match(text, /- p0 · t1「任务 t1」· Alice · completed · 1970-01-01 00:00Z · records\/teams\/team-a\/t1\/a1\/001-abcdef12\.md · sess\/w2\/e9/)
  assert.match(renderPending([]), /没有待合并条目/)
})

function identity(stateRoot: string, role: 'captain' | 'member'): TeamIdentity {
  const fileKey = role === 'captain' ? 'captain' : 'alice'
  return { role, fileKey, agentKey: fileKey, stateRoot, team: { id: 'team-a', name: 'A 队', captainSessionId: 'c1', createdAt: 0, members: [], tasks: [] } }
}

test('team_notes：读 workspace.md 附带本队清单；workspace.pending.md 只读；只有队长能 resolve，只碰本队文件', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pending-'))
  const store = new NotesStore(join(root, '.context', 'notes'), 10_000)
  const [mine, other] = await addPending(root, A, [item('t1'), item('t3')])
  const [theirs] = await addPending(root, B, [item('t2', 'team-b')])
  const member = identity(root, 'member')
  const captain = identity(root, 'captain')
  assert.match(await runTeamNotes({ action: 'read', path: 'workspace.md' }, member, store, 5), /workspace\.md 还不存在。\n\n---\nworkspace\.pending\.md：待合并成员笔记 2 条/)
  await runTeamNotes({ action: 'write', path: 'workspace.md', content: '共识' }, captain, store, 5)
  assert.match(await runTeamNotes({ action: 'read', path: 'workspace.md' }, member, store, 5), /^共识\n\n---\n.*\n- p/)
  assert.match(await runTeamNotes({ action: 'read', path: 'workspace.pending.md' }, member, store, 5), new RegExp(mine!.id))
  await assert.rejects(runTeamNotes({ action: 'write', path: 'workspace.pending.md', content: 'x' }, captain, store, 5), /只读/)
  await assert.rejects(runTeamNotes({ action: 'resolve', ids: mine!.id }, member, store, 5), /只有队长/)
  await assert.rejects(runTeamNotes({ action: 'resolve' }, captain, store, 5), /需要 ids/)
  assert.doesNotMatch(await runTeamNotes({ action: 'read', path: 'workspace.pending.md' }, member, store, 5), new RegExp(theirs!.id))
  const out = await runTeamNotes({ action: 'resolve', ids: `${mine!.id}, ${theirs!.id}` }, captain, store, 5)
  assert.match(out, new RegExp(`已从 workspace\\.pending\\.md 删除：${mine!.id}`))
  assert.match(out, new RegExp(`清单里没有：${theirs!.id}`))
  assert.deepEqual((await readPending(root, A)).map(e => e.id), [other!.id])
  assert.deepEqual((await readPending(root, B)).map(e => e.id), [theirs!.id])
})

test('全文记录：完成/失败且有快照的成员任务进清单，取消与无笔记的不进', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pending-'))
  const createdAt = 1_700_000_000_000
  const team = (tasks: TeamTaskInfo[]): TeamInfo => ({ id: 'team-a', name: 'A 队', captainSessionId: 'c1', createdAt, members: [{ id: 'sess-alice', name: 'Alice' }, { id: 'sess-bob', name: 'Bob' }], tasks })
  const t = (id: string, status: string, assignee = 'Alice'): TeamTaskInfo => ({ id, subject: id, status, assignee, attempt: 1 })
  await recordTerminalTasks(root, [team([])])
  const file = join(notesTeamDir(root, 'team-a', createdAt), 'alice.md')
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, '笔记\n')
  await recordTerminalTasks(root, [team([t('t1', 'completed'), t('t2', 'failed'), t('t3', 'cancelled'), t('t4', 'completed', 'Bob')])], 0, async id => `${id}/w1/e5`)
  const entries = await readPending(root, { id: 'team-a', createdAt })
  assert.deepEqual(entries.map(e => [e.taskId, e.status]), [['t1', 'completed'], ['t2', 'failed']])
  assert.match(entries[0]!.snapshot, /^records\/teams\/team-a\/t1\/a1\/001-[0-9a-f]{8}\.md$/)
  assert.equal(entries[0]!.ref, 'sess-alice/w1/e5')
})
