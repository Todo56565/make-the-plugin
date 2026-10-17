import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureLayoutSync, resetLayoutMemo } from '../../src/context/migrate.ts'
import { notesTeamDir, readLayout } from '../../src/context/layout.ts'
import { NotesStore } from '../../src/notes/store.ts'
import { notesRootOf } from '../../src/notes/paths.ts'

function seed(): string {
  const root = mkdtempSync(join(tmpdir(), 'mig-'))
  mkdirSync(join(root, 'live'), { recursive: true })
  writeFileSync(join(root, 'live', 'team.json'), JSON.stringify({ id: 'live', name: 'live', captainSessionId: 'c', createdAt: 1000, members: [], tasks: [] }))
  const notes = join(root, '.context', 'notes')
  mkdirSync(join(notes, 'teams', 'live'), { recursive: true })
  mkdirSync(join(notes, 'teams', 'gone'), { recursive: true })
  writeFileSync(join(notes, 'workspace.md'), 'shared')
  writeFileSync(join(notes, 'teams', 'live', 'alice.md'), 'old alice')
  writeFileSync(join(notes, 'teams', 'live', 'captain.md'), 'cap')
  writeFileSync(join(notes, 'teams', 'gone', 'bob.md'), 'bob')
  return root
}

test('迁移 v1→v2：活动团队搬到代目录，已不存在的团队删除，workspace.md 不动', async () => {
  resetLayoutMemo()
  const root = seed()
  const target = notesTeamDir(root, 'live', 1000)
  mkdirSync(target, { recursive: true })
  writeFileSync(join(target, 'alice.md'), 'new alice')
  ensureLayoutSync(root, () => 7)
  assert.equal(readFileSync(join(target, 'alice.md'), 'utf8'), 'new alice', '目标已有文件时保留新的')
  assert.equal(readFileSync(join(target, 'captain.md'), 'utf8'), 'cap')
  assert.equal(existsSync(join(root, '.context', 'notes', 'teams', 'live')), false)
  assert.equal(existsSync(join(root, '.context', 'notes', 'teams', 'gone')), false)
  assert.equal(readFileSync(join(root, '.context', 'notes', 'workspace.md'), 'utf8'), 'shared')
  assert.deepEqual(await readLayout(root), { version: 2, migrations: [{ from: 1, to: 2, at: 7 }] })
})

test('迁移可重复执行；已是 v2 不再动目录', () => {
  resetLayoutMemo()
  const root = seed()
  ensureLayoutSync(root)
  resetLayoutMemo()
  mkdirSync(join(root, '.context', 'notes', 'teams', 'late'), { recursive: true })
  ensureLayoutSync(root)
  assert.equal(existsSync(join(root, '.context', 'notes', 'teams', 'late')), true)
})

test('NotesStore：虚拟路径映射到团队代目录，返回虚拟路径', async () => {
  const root = mkdtempSync(join(tmpdir(), 'map-'))
  const store = new NotesStore(notesRootOf(root), 10_000, { id: 'live', createdAt: 1000 })
  const meta = await store.write('teams/live/alice.md', 'hi')
  assert.equal(meta.path, 'teams/live/alice.md')
  assert.equal(readFileSync(join(notesTeamDir(root, 'live', 1000), 'alice.md'), 'utf8'), 'hi')
  await store.write('workspace.md', 'w')
  assert.equal(readFileSync(join(notesRootOf(root), 'workspace.md'), 'utf8'), 'w')
  assert.deepEqual((await store.list('live')).map(m => m.path).sort(), ['teams/live/alice.md', 'workspace.md'])
  const nextGen = new NotesStore(notesRootOf(root), 10_000, { id: 'live', createdAt: 2000 })
  assert.equal(await nextGen.read('teams/live/alice.md'), undefined, '同名新一代团队看不到上一代笔记')
})
