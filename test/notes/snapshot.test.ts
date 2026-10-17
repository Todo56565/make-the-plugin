import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { attemptSnapshotDir, notesTeamDir } from '../../src/context/layout.ts'
import { readSnapshotMetas, sessionRef, snapshotOnWindowSwitch, takeSnapshot } from '../../src/notes/snapshot.ts'
import type { TeamIdentity } from '../../src/team/identity.ts'

const createdAt = 1_700_000_000_000

test('快照：去重、序号递增、元数据', async () => {
  const stateRoot = mkdtempSync(join(tmpdir(), 'snap-'))
  const base = { stateRoot, teamId: 'team-a', createdAt, taskId: 't1', attempt: 2, fileKey: 'alice', reason: 'window' as const }
  const r1 = await takeSnapshot({ ...base, content: '进展 A\n', ref: sessionRef('s1', 1, 10) })
  const r2 = await takeSnapshot({ ...base, content: '进展 A\n', ref: sessionRef('s1', 2, 20) })
  const r3 = await takeSnapshot({ ...base, content: '进展 B\n', ref: sessionRef('s1', 2, 30), reason: 'terminal' })
  assert.equal(r1.created, true)
  assert.equal(r2.created, false)
  assert.equal(r3.created, true)
  const dir = attemptSnapshotDir(stateRoot, 'team-a', createdAt, 't1', 2)
  const files = readdirSync(dir).filter(f => f.endsWith('.md')).sort()
  assert.equal(files.length, 2)
  assert.match(files[0]!, /^001-[0-9a-f]{8}\.md$/)
  assert.match(files[1]!, /^002-[0-9a-f]{8}\.md$/)
  const metas = await readSnapshotMetas(stateRoot, 'team-a', createdAt, 't1', 2)
  assert.deepEqual(metas.map(m => [m.file, m.ref, m.reason, m.fileKey]), [
    [files[0], 's1/w1/e10', 'window', 'alice'],
    [files[1], 's1/w2/e30', 'terminal', 'alice'],
  ])
})

test('快照：并发拍照序号不冲突', async () => {
  const stateRoot = mkdtempSync(join(tmpdir(), 'snap-'))
  const base = { stateRoot, teamId: 'team-a', createdAt, taskId: 't1', attempt: 1, fileKey: 'alice', reason: 'window' as const, ref: 's/w1/e1' }
  await Promise.all(['a', 'b', 'c'].map(c => takeSnapshot({ ...base, content: c })))
  const files = readdirSync(attemptSnapshotDir(stateRoot, 'team-a', createdAt, 't1', 1)).filter(f => f.endsWith('.md'))
  assert.deepEqual(files.map(f => f.slice(0, 3)).sort(), ['001', '002', '003'])
})

test('换窗快照：只拍成员自己未终态的任务；队长、无笔记不拍', async () => {
  const stateRoot = mkdtempSync(join(tmpdir(), 'snap-'))
  const team = { id: 'team-a', name: 'A', captainSessionId: 'c1', createdAt, members: [], tasks: [
    { id: 't1', subject: 'x', status: 'in_progress', assignee: 'Alice', attempt: 3 },
    { id: 't2', subject: 'y', status: 'completed', assignee: 'Alice', attempt: 1 },
    { id: 't3', subject: 'z', status: 'in_progress', assignee: 'Bob', attempt: 1 },
  ] }
  const alice: TeamIdentity = { role: 'member', fileKey: 'alice', agentKey: 'Alice', stateRoot, team }
  assert.deepEqual(snapshotOnWindowSwitch(alice, 's/w1/e5'), [])
  mkdirSync(notesTeamDir(stateRoot, 'team-a', createdAt), { recursive: true })
  writeFileSync(join(notesTeamDir(stateRoot, 'team-a', createdAt), 'alice.md'), '笔记\n')
  const results = await Promise.all(snapshotOnWindowSwitch(alice, 's/w1/e5'))
  assert.equal(results.length, 1)
  assert.equal(results[0]!.dir, attemptSnapshotDir(stateRoot, 'team-a', createdAt, 't1', 3))
  assert.deepEqual(snapshotOnWindowSwitch({ ...alice, role: 'captain', fileKey: 'captain', agentKey: 'captain' }, 's/w1/e5'), [])
})
