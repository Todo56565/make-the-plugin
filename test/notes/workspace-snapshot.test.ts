import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { lockPath, workspaceSnapshotPath } from '../../src/context/layout.ts'
import { cosineSample } from '../../src/notes/snapshot-sampling.ts'
import { WORKSPACE_SNAPSHOT_PRUNE_AT, keptAfterPrune, listWorkspaceSnapshots, snapshotWorkspaceBefore } from '../../src/notes/workspace-snapshot.ts'
import { NotesStore } from '../../src/notes/store.ts'

test('余弦取样：设计示例与边界', () => {
  assert.deepEqual(cosineSample(10, 5), [1, 2, 5, 9, 10])
  assert.deepEqual(cosineSample(20, 6), [1, 3, 8, 13, 18, 20])
  assert.deepEqual(cosineSample(50, 8), [1, 3, 10, 20, 31, 41, 48, 50])
  assert.deepEqual(cosineSample(3, 5), [1, 2, 3])
  assert.deepEqual(cosineSample(9, 1), [9])
  assert.deepEqual(cosineSample(0, 5), [])
})

test('精简：自动全留；未到 100 份不动；到 100 份按余弦留 m 份，钉住的额外保留', () => {
  const hundred = Array.from({ length: WORKSPACE_SNAPSHOT_PRUNE_AT }, (_, i) => i + 1)
  assert.equal(keptAfterPrune(hundred, { keep: 0 }).length, 100)
  assert.equal(keptAfterPrune(hundred.slice(0, 99), { keep: 8 }).length, 99)
  const kept = keptAfterPrune(hundred, { keep: 8, pinned: new Set([50, 51]) })
  assert.deepEqual(kept.filter(n => n !== 50 && n !== 51), cosineSample(100, 8))
  assert.ok(kept.includes(50) && kept.includes(51))
  assert.equal(keptAfterPrune(hundred, { keep: 1 }).length, 2, 'm 至少 2')
})

test('修改前快照：空/不变/与最新相同不拍；编号不复用', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ws-'))
  const policy = { keep: 0 }
  assert.equal(await snapshotWorkspaceBefore(root, undefined, 'a', policy), undefined)
  assert.equal(await snapshotWorkspaceBefore(root, 'a', 'a', policy), undefined)
  assert.equal(await snapshotWorkspaceBefore(root, 'a', 'b', policy), 1)
  assert.equal(await snapshotWorkspaceBefore(root, 'a', 'c', policy), undefined, '与最新一份相同')
  assert.equal(await snapshotWorkspaceBefore(root, 'b', 'c', policy), 2)
  rmSync(workspaceSnapshotPath(root, 2))
  rmSync(workspaceSnapshotPath(root, 1))
  assert.equal(await snapshotWorkspaceBefore(root, 'c', 'd', policy), 3, '删光后编号也不复用')
  assert.deepEqual(await listWorkspaceSnapshots(root), [3])
})

test('累计到 100 份时精简到 m 份，之后继续累计', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ws-'))
  for (let i = 1; i <= 100; i++) await snapshotWorkspaceBefore(root, `v${i}`, `v${i + 1}`, { keep: 5 })
  assert.deepEqual(await listWorkspaceSnapshots(root), cosineSample(100, 5))
  await snapshotWorkspaceBefore(root, 'v101', 'v102', { keep: 5 })
  assert.deepEqual(await listWorkspaceSnapshots(root), [...cosineSample(100, 5), 101])
})

test('NotesStore：给出 stateRoot 时写 workspace.md 前拍快照、持锁后释放；成员笔记不拍', async () => {
  const stateRoot = mkdtempSync(join(tmpdir(), 'ws-'))
  const store = new NotesStore(join(stateRoot, '.context', 'notes'), 10_000, { id: 'team-a', createdAt: 0 }, 20_000, { stateRoot })
  await store.write('workspace.md', '第一版\n')
  await store.append('workspace.md', '补充')
  await store.writeIf('workspace.md', '第一版\n补充\n', '第三版\n')
  await store.write('teams/team-a/alice.md', 'x')
  await store.write('teams/team-a/alice.md', 'y')
  assert.deepEqual(await listWorkspaceSnapshots(stateRoot), [1, 2])
  assert.equal(readFileSync(workspaceSnapshotPath(stateRoot, 1), 'utf8'), '第一版\n')
  assert.equal(readFileSync(workspaceSnapshotPath(stateRoot, 2), 'utf8'), '第一版\n补充\n')
  assert.equal(existsSync(lockPath(stateRoot, 'workspace.md')), false)
})
