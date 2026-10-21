import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fullCursorPath, fullVolumePath, notesTeamDir } from '../../src/context/layout.ts'
import { entryKeysOf, fullEntryKey, recordTerminalTasks, renderFullEntry } from '../../src/records/full.ts'
import type { TeamInfo, TeamTaskInfo } from '../../src/team/team-file.ts'

const createdAt = 1_700_000_000_000

function team(tasks: TeamTaskInfo[]): TeamInfo {
  return { id: 'team-a', name: 'A 队', captainSessionId: 'c1', createdAt, members: [{ id: 'sess-alice', name: 'Alice' }], tasks }
}
const done = (id: string, attempt = 1, extra: Partial<TeamTaskInfo> = {}): TeamTaskInfo =>
  ({ id, subject: `任务 ${id}`, status: 'completed', assignee: 'Alice', attempt, details: { output: `结果 ${id}`, changedPaths: ['a.ts'] }, ...extra })

test('首次运行只建基线，之后新终态写条目并拍终态快照', async () => {
  const root = mkdtempSync(join(tmpdir(), 'full-'))
  assert.deepEqual(await recordTerminalTasks(root, [team([done('t1')])]), [])
  assert.equal(existsSync(fullVolumePath(root, 1)), false)
  assert.ok(existsSync(fullCursorPath(root)))
  mkdirSync(notesTeamDir(root, 'team-a', createdAt), { recursive: true })
  writeFileSync(join(notesTeamDir(root, 'team-a', createdAt), 'alice.md'), '我的笔记\n')
  const written = await recordTerminalTasks(root, [team([done('t1'), done('t2', 2), { id: 't3', subject: 'x', status: 'in_progress', attempt: 1 }])])
  assert.deepEqual(written.map(w => w.key), [fullEntryKey('team-a', createdAt, 't2', 2)])
  const text = readFileSync(fullVolumePath(root, 1), 'utf8')
  assert.deepEqual(entryKeysOf(text), [`team-a@${createdAt.toString(36)}:t2:2`])
  assert.match(text, /### output\n\n结果 t2/)
  assert.match(text, /会话 sess-alice/)
  assert.match(text, /records\/teams\/team-a\/t2\/a2\/001-[0-9a-f]{8}\.md（终态/)
  assert.deepEqual(await recordTerminalTasks(root, [team([done('t1'), done('t2', 2)])]), [])
})

test('游标丢失：扫描分卷重建，不当作首次运行', async () => {
  const root = mkdtempSync(join(tmpdir(), 'full-'))
  await recordTerminalTasks(root, [team([])])
  await recordTerminalTasks(root, [team([done('t1')])])
  rmSync(fullCursorPath(root))
  const written = await recordTerminalTasks(root, [team([done('t1'), done('t2')])])
  assert.deepEqual(written.map(w => w.task.id), ['t2'])
  assert.equal(entryKeysOf(readFileSync(fullVolumePath(root, 1), 'utf8')).length, 2)
})

test('游标落后于分卷（追加后崩溃）不重复写', async () => {
  const root = mkdtempSync(join(tmpdir(), 'full-'))
  await recordTerminalTasks(root, [team([])])
  await recordTerminalTasks(root, [team([done('t1')])])
  writeFileSync(fullCursorPath(root), JSON.stringify({ schema: 1, keys: [] }))
  assert.deepEqual(await recordTerminalTasks(root, [team([done('t1')])]), [])
  assert.equal(entryKeysOf(readFileSync(fullVolumePath(root, 1), 'utf8')).length, 1)
})

test('单条超限截断 output 并标注原长度', () => {
  const t = done('t1', 1, { details: { output: '字'.repeat(20_000) } })
  const text = renderFullEntry({ key: 'k', team: team([t]), task: t, snapshots: [], at: 0 }, 4_000)
  assert.ok(Buffer.byteLength(text) <= 4_000)
  assert.match(text, /output 已截断，原长 60000 字节/)
})

test('终态快照坐标：locate 给出 w/e 并按 updatedAt 截断；locate 失败退回会话 id', async () => {
  const { readSnapshotMetas } = await import('../../src/notes/snapshot.ts')
  const root = mkdtempSync(join(tmpdir(), 'full-'))
  await recordTerminalTasks(root, [team([])])
  mkdirSync(notesTeamDir(root, 'team-a', createdAt), { recursive: true })
  writeFileSync(join(notesTeamDir(root, 'team-a', createdAt), 'alice.md'), '笔记一\n')
  const calls: Array<[string, number | undefined]> = []
  const t1 = done('t1', 1, { details: { output: 'r', updatedAt: 12345 } })
  await recordTerminalTasks(root, [team([t1])], 0, async (id, until) => { calls.push([id, until]); return `${id}/w3/e40` })
  assert.deepEqual(calls, [['sess-alice', 12345]])
  assert.equal((await readSnapshotMetas(root, 'team-a', createdAt, 't1', 1))[0]!.ref, 'sess-alice/w3/e40')
  writeFileSync(join(notesTeamDir(root, 'team-a', createdAt), 'alice.md'), '笔记二\n')
  await recordTerminalTasks(root, [team([t1, done('t2')])], 0, async () => { throw new Error('读不到') })
  assert.equal((await readSnapshotMetas(root, 'team-a', createdAt, 't2', 1))[0]!.ref, 'sess-alice')
})

test('E5a：同一 attempt 整数、不同 attemptId 各记一条，快照分目录；cancelled 用旧键', async () => {
  const root = mkdtempSync(join(tmpdir(), 'full-'))
  await recordTerminalTasks(root, [team([])])
  mkdirSync(notesTeamDir(root, 'team-a', createdAt), { recursive: true })
  writeFileSync(join(notesTeamDir(root, 'team-a', createdAt), 'alice.md'), '笔记\n')
  const first = await recordTerminalTasks(root, [team([done('t1', 1, { attemptId: 'aaaaaaaa-1111' })])])
  assert.deepEqual(first.map(w => w.key), [`team-a@${createdAt.toString(36)}:t1:1:aaaaaaaa`])
  // 回退后重做：attempt 仍为 1，attemptId 不同
  const redo = await recordTerminalTasks(root, [team([done('t1', 1, { attemptId: 'bbbbbbbb-2222' }), done('t2', 1, { status: 'cancelled', attemptId: 'cccccccc' })])])
  assert.deepEqual(redo.map(w => w.key), [`team-a@${createdAt.toString(36)}:t1:1:bbbbbbbb`, `team-a@${createdAt.toString(36)}:t2:1`])
  const text = readFileSync(fullVolumePath(root, 1), 'utf8')
  assert.match(text, /records\/teams\/team-a\/t1\/a1-aaaaaaaa\/001-/)
  assert.match(text, /records\/teams\/team-a\/t1\/a1-bbbbbbbb\/001-/)
  assert.equal(fullEntryKey('team-a', createdAt, 't1', 1, undefined), `team-a@${createdAt.toString(36)}:t1:1`)
})
