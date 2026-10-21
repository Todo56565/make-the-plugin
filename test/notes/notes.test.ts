import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { physicalNotePath, resolveNotePath } from '../../src/notes/paths.ts'
import { NotesStore, NoteSizeError, countLines } from '../../src/notes/store.ts'
import { runTeamNotes } from '../../src/notes/tool.ts'
import type { TeamIdentity } from '../../src/team/identity.ts'

const scope = { teamId: 'team-a', fileKey: 'alice' }

test('resolveNotePath：自己、共享、队友、越权', () => {
  assert.deepEqual(resolveNotePath(undefined, scope), { ok: true, path: 'teams/team-a/alice.md', own: true, shared: false, record: false })
  assert.deepEqual(resolveNotePath('workspace.md', scope), { ok: true, path: 'workspace.md', own: false, shared: true, record: false })
  assert.deepEqual(resolveNotePath('bob.md', scope), { ok: true, path: 'teams/team-a/bob.md', own: false, shared: false, record: false })
  assert.deepEqual(resolveNotePath('teams/team-a/alice.md', scope), { ok: true, path: 'teams/team-a/alice.md', own: true, shared: false, record: false })
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

test('会话笔记（0.6.0 §3）：队长笔记映射到开队会话的笔记；普通会话只有自己的笔记和 workspace.md', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sess-notes-'))
  const notes = join(root, '.context', 'notes')
  const team = { id: 'team-a', createdAt: 0, captainSessionId: 'c1' }
  assert.equal(physicalNotePath('teams/team-a/captain.md', team), 'sessions/c1.md')
  assert.equal(physicalNotePath('teams/team-a/alice.md', team), 'teams/nanmi/team-a@0/alice.md')
  assert.equal(physicalNotePath('records/teams/team-a/captain.md', team), '../records/teams/nanmi/team-a@0/captain.md', 'records 不映射')
  assert.equal(physicalNotePath('teams/team-a/captain.md', { id: 'team-a', createdAt: 0, captainSessionId: '' }), 'teams/nanmi/team-a@0/captain.md')

  // 开队前：普通会话写自己的笔记与 workspace.md
  const plain = { role: 'plain', agentKey: 'plain', sessionId: 'c1', stateRoot: root } as const
  const plainStore = new NotesStore(notes, 10_000)
  const runPlain = (args: { action: string; path?: string; content?: string; query?: string }) => runTeamNotes(args, plain, plainStore, 5)
  assert.match(await runPlain({ action: 'write', content: '开队前的进度' }), /已写入 sessions\/c1\.md/)
  assert.match(await runPlain({ action: 'append', path: 'workspace.md', content: '约定：用 pnpm' }), /已追加 workspace\.md/)
  assert.doesNotMatch(await runPlain({ action: 'read', path: 'workspace.md' }), /待合并/)
  await assert.rejects(runPlain({ action: 'read', path: 'alice.md' }), /普通会话只能访问/)
  await assert.rejects(runPlain({ action: 'read', path: 'records/full/0001.md' }), /普通会话只能访问/)
  await assert.rejects(runPlain({ action: 'resolve', ids: 'x' }), /只有队长/)
  const listed = await runPlain({ action: 'list' })
  assert.match(listed, /sessions\/c1\.md/)
  assert.doesNotMatch(listed, /待合并/)

  // 开队后：队长的 self 与队员读的 captain.md 都是这份会话笔记；目录里的旧 captain.md 不列
  const store = new NotesStore(notes, 10_000, team)
  mkdirSync(join(notes, 'teams', 'nanmi', 'team-a@0'), { recursive: true })
  writeFileSync(join(notes, 'teams', 'nanmi', 'team-a@0', 'captain.md'), '旧版队长笔记')
  const info = { id: 'team-a', name: 'A', captainSessionId: 'c1', createdAt: 0, members: [], tasks: [] }
  const captain: TeamIdentity = { role: 'captain', agentKey: 'captain', fileKey: 'captain', stateRoot: root, team: info }
  const member: TeamIdentity = { role: 'member', agentKey: 'alice', fileKey: 'alice', stateRoot: root, team: info }
  assert.equal(await runTeamNotes({ action: 'read' }, captain, store, 5), '开队前的进度')
  assert.equal(await runTeamNotes({ action: 'read', path: 'captain.md' }, member, store, 5), '开队前的进度')
  await runTeamNotes({ action: 'append', content: '队长期间的进度' }, captain, store, 5)
  const teamList = await runTeamNotes({ action: 'list' }, member, store, 5)
  assert.equal(teamList.match(/captain\.md/g)?.length, 1)
  assert.match(await runTeamNotes({ action: 'search', query: '队长期间' }, member, store, 5), /teams\/team-a\/captain\.md:2/)

  // 散队后：回到普通会话，笔记原地还在
  assert.equal(await runPlain({ action: 'read' }), '开队前的进度\n队长期间的进度\n')
})
