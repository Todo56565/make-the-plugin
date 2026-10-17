import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveNotePath } from '../../src/notes/paths.ts'
import { NotesStore, NoteSizeError, countLines } from '../../src/notes/store.ts'
import { runTeamNotes } from '../../src/notes/tool.ts'
import type { TeamIdentity } from '../../src/team/identity.ts'

const scope = { teamId: 'team-a', fileKey: 'alice' }

test('resolveNotePath：自己、共享、队友、越权', () => {
  assert.deepEqual(resolveNotePath(undefined, scope), { ok: true, path: 'teams/team-a/alice.md', own: true, shared: false })
  assert.deepEqual(resolveNotePath('workspace.md', scope), { ok: true, path: 'workspace.md', own: false, shared: true })
  assert.deepEqual(resolveNotePath('bob.md', scope), { ok: true, path: 'teams/team-a/bob.md', own: false, shared: false })
  assert.deepEqual(resolveNotePath('teams/team-a/alice.md', scope), { ok: true, path: 'teams/team-a/alice.md', own: true, shared: false })
  for (const bad of ['../x.md', '/etc/passwd', 'teams/team-b/x.md', 'a/b.md', 'x.txt', 'C:x.md', 'a\\b.md', 'teams/team-a/../x.md']) {
    assert.equal(resolveNotePath(bad, scope).ok, false, bad)
  }
})

test('countLines', () => {
  assert.equal(countLines(''), 0)
  assert.equal(countLines('a'), 1)
  assert.equal(countLines('a\n'), 1)
  assert.equal(countLines('a\nb'), 2)
})

function identity(stateRoot: string, fileKey = 'alice', role: 'captain' | 'member' = 'member'): TeamIdentity {
  return {
    role, fileKey, agentKey: fileKey === 'captain' ? 'captain' : 'Alice', stateRoot,
    team: { id: 'team-a', name: 'A 队', captainSessionId: 'c1', createdAt: 0, members: [], tasks: [] },
  }
}

test('store：追加、串行、上限', async () => {
  const store = new NotesStore(mkdtempSync(join(tmpdir(), 'notes-')), 50)
  await Promise.all([store.append('teams/team-a/alice.md', 'one'), store.append('teams/team-a/alice.md', 'two')])
  assert.equal(await store.read('teams/team-a/alice.md'), 'one\ntwo\n')
  await assert.rejects(store.append('teams/team-a/alice.md', 'x'.repeat(60)), NoteSizeError)
  assert.equal(await store.read('teams/team-a/alice.md'), 'one\ntwo\n', '超限不写入')
})

test('team_notes：完整流程', async () => {
  const root = mkdtempSync(join(tmpdir(), 'state-'))
  const store = new NotesStore(join(root, '.context', 'notes'), 10_000)
  const me = identity(root)
  const run = (args: { action: string; path?: string; content?: string; query?: string }) => runTeamNotes(args, me, store, 2)
  assert.match(await run({ action: 'list' }), /还没有任何笔记/)
  assert.match(await run({ action: 'write', content: '# 进度\n完成 t1' }), /已写入 teams\/team-a\/alice\.md（2 行/)
  await assert.rejects(run({ action: 'append', path: 'workspace.md', content: 'x' }), /成员不能写 workspace\.md/)
  const captain = identity(root, 'captain', 'captain')
  assert.match(await runTeamNotes({ action: 'append', path: 'workspace.md', content: '结论：用方案 B' }, captain, store, 2), /已追加 workspace\.md/)
  await assert.rejects(run({ action: 'write', path: 'bob.md', content: 'x' }), /只能写自己的笔记/)
  assert.equal(await run({ action: 'read' }), '# 进度\n完成 t1')
  assert.match(await run({ action: 'read', path: 'bob.md' }), /还不存在/)
  assert.match(await run({ action: 'list' }), /workspace\.md[\s\S]*alice\.md|alice\.md[\s\S]*workspace\.md/)
  assert.match(await run({ action: 'search', query: '方案' }), /workspace\.md:1: 结论：用方案 B/)
  assert.match(await run({ action: 'search', query: 'xyz' }), /没有找到/)
  await run({ action: 'append', content: 'a1\na2\na3' })
  assert.match(await run({ action: 'search', query: 'a' }), /已截断/)
  await assert.rejects(run({ action: 'drop' }), /未知 action/)
})

test('workspace.md 单独上限', async () => {
  const store = new NotesStore(mkdtempSync(join(tmpdir(), 'lim-')), 10, undefined, 30)
  await store.write('workspace.md', 'x'.repeat(25))
  await assert.rejects(store.write('teams/team-a/alice.md', 'x'.repeat(25)), NoteSizeError)
  await assert.rejects(store.write('workspace.md', 'x'.repeat(31)), /上限 30 字节/)
})
