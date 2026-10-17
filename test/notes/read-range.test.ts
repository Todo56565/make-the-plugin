import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sliceForRead } from '../../src/notes/read-range.ts'
import { resolveNotePath } from '../../src/notes/paths.ts'
import { NotesStore } from '../../src/notes/store.ts'
import { runTeamNotes } from '../../src/notes/tool.ts'
import type { TeamIdentity } from '../../src/team/identity.ts'

const text = Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join('\n') + '\n'

test('行范围：小文件原样、区间、越界', () => {
  assert.equal(sliceForRead('a.md', text), text)
  assert.equal(sliceForRead('a.md', text, 3, 4), '（a.md 第 3–4 行，共 10 行）\nline3\nline4')
  assert.equal(sliceForRead('a.md', text, 9), '（a.md 第 9–10 行，共 10 行）\nline9\nline10')
  assert.match(sliceForRead('a.md', text, 11), /超出范围/)
  assert.match(sliceForRead('a.md', text, 5, 2), /小于/)
})

test('行范围：大文件无范围返回末尾，有范围按上限截断', () => {
  const tail = sliceForRead('a.md', text, undefined, undefined, 20)
  assert.match(tail, /^（a\.md 共 10 行，过大，以下为第 8–10 行/)
  assert.ok(tail.endsWith('line8\nline9\nline10'))
  assert.match(sliceForRead('a.md', text, 1, 10, 12), /第 1–2 行，共 10 行；超过单次上限，下一段从第 3 行起/)
})

test('records 路径：只读、只能本团队、映射到当前代', async () => {
  const scope = { teamId: 'team-a', fileKey: 'alice' }
  assert.equal(resolveNotePath('records/full/0001.md', scope).ok, true)
  assert.equal(resolveNotePath('records/teams/team-b/t1/a1/1-x.md', scope).ok, false)
  assert.equal(resolveNotePath('records/other/x.md', scope).ok, false)
  const stateRoot = mkdtempSync(join(tmpdir(), 'rec-'))
  const notesRoot = join(stateRoot, '.context', 'notes')
  const createdAt = 1_700_000_000_000
  const snapDir = join(stateRoot, '.context', 'records', 'teams', 'nanmi', `team-a@${createdAt.toString(36)}`, 't1', 'a1')
  mkdirSync(snapDir, { recursive: true })
  writeFileSync(join(snapDir, '000001-abcd1234.md'), '快照内容\n')
  const store = new NotesStore(notesRoot, 100, { id: 'team-a', createdAt })
  const id: TeamIdentity = { role: 'member', fileKey: 'alice', agentKey: 'Alice', stateRoot,
    team: { id: 'team-a', name: 'A', captainSessionId: 'c1', createdAt, members: [], tasks: [] } }
  assert.equal(await runTeamNotes({ action: 'read', path: 'records/teams/team-a/t1/a1/000001-abcd1234.md' }, id, store, 5), '快照内容\n')
  await assert.rejects(runTeamNotes({ action: 'write', path: 'records/full/0001.md', content: 'x' }, { ...id, role: 'captain' }, store, 5), /只读/)
})
