import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { attemptSnapshotDir, fullVolumePath, notesTeamDir, pendingPath, recordsTeamDir } from '../../src/context/layout.ts'
import { ENDED_FILE, findEndedGenerations, recordsUsageBytes, sweepEndedGenerations } from '../../src/records/ended.ts'
import { fullEntryKey } from '../../src/records/full.ts'

const DAY = 86_400_000

function put(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, text)
}

function teamJson(root: string, id: string, createdAt: number | string): void {
  put(join(root, id, 'team.json'), typeof createdAt === 'string' ? createdAt : JSON.stringify({ id, name: id, captainSessionId: 'c', createdAt, members: [], tasks: [] }))
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'ended-'))
  // live：活动代 1000；old：活动团队已换代（新 2000），1000 代结束；gone：team.json 不在；broken：team.json 坏
  teamJson(root, 'live', 1000)
  teamJson(root, 'old', 2000)
  teamJson(root, 'broken', '{oops')
  for (const [id, at] of [['live', 1000], ['old', 1000], ['old', 2000], ['gone', 5], ['broken', 7]] as const) {
    put(join(notesTeamDir(root, id, at), 'alice.md'), `${id} 笔记\n`)
  }
  put(join(attemptSnapshotDir(root, 'old', 1000, 't1', 1), '001-aaaaaaaa.md'), '有终态')
  put(join(attemptSnapshotDir(root, 'old', 1000, 't2', 1), '001-bbbbbbbb.md'), '无终态')
  put(join(attemptSnapshotDir(root, 'live', 1000, 't9', 1), '001-cccccccc.md'), '活动代不动')
  put(fullVolumePath(root, 1), `<!-- full-entry ${JSON.stringify({ key: fullEntryKey('old', 1000, 't1', 1), at: 1 })} -->\n## x\n`)
  put(pendingPath(root, 'gone', 5), '')
  put(pendingPath(root, 'old', 1000), '{"schema":1}\n')
  return root
}

test('发现结束代：对不上活动 team.json 的代；team.json 读不出的跳过', async () => {
  const root = setup()
  const ended = (await findEndedGenerations(root)).map(g => `${g.teamId}@${g.createdAt}`)
  assert.deepEqual(ended, ['gone@5', 'old@1000'])
})

test('收尾：删无终态 attempt、搬在用笔记、记结束时间、删空清单；幂等', async () => {
  const root = setup()
  const r = await sweepEndedGenerations(root, { now: 10 * DAY })
  assert.deepEqual(r.newlyEnded, ['gone@5', 'old@rs'])
  assert.equal(r.movedNotes, 2)
  assert.equal(r.removedAttempts, 1)
  assert.ok(existsSync(attemptSnapshotDir(root, 'old', 1000, 't1', 1)))
  assert.equal(existsSync(attemptSnapshotDir(root, 'old', 1000, 't2', 1)), false)
  assert.ok(existsSync(attemptSnapshotDir(root, 'live', 1000, 't9', 1)))
  assert.equal(readFileSync(join(recordsTeamDir(root, 'old', 1000), 'notes', 'alice.md'), 'utf8'), 'old 笔记\n')
  assert.equal(existsSync(notesTeamDir(root, 'old', 1000)), false)
  assert.ok(existsSync(join(notesTeamDir(root, 'old', 2000), 'alice.md')))
  assert.ok(existsSync(join(notesTeamDir(root, 'broken', 7), 'alice.md')))
  assert.equal(existsSync(pendingPath(root, 'gone', 5)), false, '空清单删除')
  assert.ok(existsSync(pendingPath(root, 'old', 1000)), '有内容的清单留给合并流程')
  const again = await sweepEndedGenerations(root, { now: 11 * DAY })
  assert.deepEqual(again.newlyEnded, [])
  assert.equal(again.movedNotes + again.removedAttempts, 0)
  assert.equal(JSON.parse(readFileSync(join(recordsTeamDir(root, 'old', 1000), ENDED_FILE), 'utf8')).endedAt, 10 * DAY)
  assert.ok(await recordsUsageBytes(root) > 0)
})

test('cleanupDays：结束超过 N 天的代整体删除（含清单），默认不删', async () => {
  const root = setup()
  await sweepEndedGenerations(root, { now: 10 * DAY })
  assert.deepEqual((await sweepEndedGenerations(root, { now: 100 * DAY })).purged, [])
  assert.deepEqual((await sweepEndedGenerations(root, { now: 12 * DAY, cleanupDays: 3 })).purged, [])
  const r = await sweepEndedGenerations(root, { now: 14 * DAY, cleanupDays: 3 })
  assert.deepEqual(r.purged, ['gone@5', 'old@rs'])
  assert.equal(existsSync(recordsTeamDir(root, 'old', 1000)), false)
  assert.equal(existsSync(pendingPath(root, 'old', 1000)), false)
  assert.ok(existsSync(attemptSnapshotDir(root, 'live', 1000, 't9', 1)))
})
