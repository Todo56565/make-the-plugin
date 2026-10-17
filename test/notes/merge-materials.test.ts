import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { TRUNCATED_NOTE, fitMaterials, tokensToBytes } from '../../src/notes/merge-materials.ts'
import { readFullEntriesSince } from '../../src/records/full.ts'
import { fullVolumePath } from '../../src/context/layout.ts'
import { parseSnapshotPicks } from '../../src/config.ts'

const snaps = (n: number, size: number) => Array.from({ length: n }, (_, i) => ({ seq: i + 1, content: 'x'.repeat(size) }))
const len = (s: string) => Buffer.byteLength(s)

test('窗口保险：不知道窗口不动；快照从中间丢、最旧保留', () => {
  const set = { notes: ['n'], recent: 'r'.repeat(10), snapshots: snaps(5, 100) }
  assert.equal(fitMaterials(set, len, 0, undefined), set)
  const fit = fitMaterials(set, len, 0, 1 + 10 + 250)
  assert.deepEqual(fit.snapshots.map(s => s.seq), [1, 5])
  assert.equal(fit.recent.length, 10)
})

test('窗口保险：只剩最旧一份仍放不下时截开头并标注；再不行丢 a、少喂笔记（至少一条）', () => {
  const fit = fitMaterials({ notes: ['n'], recent: '', snapshots: snaps(3, 100) }, len, 0, 61)
  assert.deepEqual(fit.snapshots.map(s => s.seq), [1])
  assert.ok(fit.snapshots[0]!.content.endsWith(TRUNCATED_NOTE))
  assert.ok(len(fit.snapshots[0]!.content) <= 60)
  const tight = fitMaterials({ notes: ['aaaa', 'bbbb', 'cccc'], recent: 'r'.repeat(50), snapshots: snaps(2, 100) }, len, 0, 9)
  assert.deepEqual(tight, { notes: ['aaaa', 'bbbb'], recent: '', snapshots: [] })
  assert.deepEqual(fitMaterials({ notes: ['aaaa', 'bbbb'], recent: '', snapshots: [] }, len, 100, 1).notes, ['aaaa'])
  assert.equal(tokensToBytes(1000), 2000)
})

test('材料 a：只取 at 晚于上次合并的全文条目，从最新往回取到上限，旧→新拼接', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mat-'))
  const entry = (key: string, at: number, body: string) => `<!-- full-entry ${JSON.stringify({ key, at })} -->\n## ${key}\n${body}\n\n`
  const v1 = fullVolumePath(root, 1)
  mkdirSync(dirname(v1), { recursive: true })
  writeFileSync(v1, entry('k1', 10, 'old') + entry('k2', 20, 'two'))
  writeFileSync(fullVolumePath(root, 2), entry('k3', 30, 'three'))
  const all = await readFullEntriesSince(root, 10, 10_000)
  assert.match(all, /## k2[\s\S]*## k3/)
  assert.doesNotMatch(all, /## k1/)
  const tail = await readFullEntriesSince(root, 0, len(entry('k3', 30, 'three')) + 5)
  assert.match(tail, /## k3/)
  assert.doesNotMatch(tail, /## k2/)
  const cut = await readFullEntriesSince(root, 0, 40)
  assert.match(cut, /此条已截断/)
  assert.equal(await readFullEntriesSince(root, 99, 10_000), '')
})

test('parseSnapshotPicks', () => {
  assert.deepEqual(parseSnapshotPicks(' 3, 1 2、3，x 0 7 '), [1, 2, 3, 7])
  assert.deepEqual(parseSnapshotPicks(''), [])
})
