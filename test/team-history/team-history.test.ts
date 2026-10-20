import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { canSee, parseMailbox, readMailView } from '../../src/team-history/mailbox.ts'
import { runTeamHistory } from '../../src/team-history/tool.ts'
import type { TeamIdentity } from '../../src/team/identity.ts'

const limits = { maxResults: 200, maxReadChars: 20_000, maxListItems: 2_000 }

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'th-'))
  const inbox = join(root, 'team-a', 'inbox')
  mkdirSync(inbox, { recursive: true })
  const line = (m: object) => JSON.stringify(m)
  writeFileSync(join(inbox, 'captain.jsonl'), [
    line({ id: 'm1', from: 'alice', to: 'captain', content: '进度：完成第一段', ts: 1000, readAt: 1100 }),
    line({ id: 'm4', from: 'bob', to: 'captain', content: '我卡住了', ts: 4000 }),
  ].join('\n') + '\n')
  writeFileSync(join(inbox, 'alice.jsonl'), [
    line({ id: 'm2', from: 'captain', to: 'alice', content: '改用方案 B', ts: 2000, readAt: 2100, taskId: 't1' }),
    line({ id: 'm5', from: 'captain', to: 'alice', content: '旧纠正', ts: 1500, discardedAt: 1600 }),
    '{坏行',
  ].join('\n') + '\n')
  writeFileSync(join(inbox, 'bob.jsonl'), line({ id: 'm3', from: 'alice', to: 'bob', content: '接口在 src/api.ts', ts: 3000, readAt: 3100 }) + '\n')
  return root
}

function identity(root: string, role: 'captain' | 'member', agentKey: string): TeamIdentity {
  return { role, agentKey, fileKey: agentKey, stateRoot: root, team: { id: 'team-a', name: 'A', captainSessionId: 'c', createdAt: 0, members: [], tasks: [] } }
}

test('parseMailbox：坏行计数', () => {
  const parsed = parseMailbox('{"id":"a","from":"x","to":"y","content":"c","ts":1}\nnope\n{"id":1}\n')
  assert.equal(parsed.messages.length, 1)
  assert.equal(parsed.malformed, 2)
})

test('可见性：队长看全部；成员看收到的和自己发出的', async () => {
  const root = fixture()
  const captain = await readMailView(identity(root, 'captain', 'captain'))
  assert.deepEqual(captain.messages.map(m => m.id), ['m1', 'm5', 'm2', 'm3', 'm4'])
  assert.equal(captain.malformed, 1)
  const alice = await readMailView(identity(root, 'member', 'alice'))
  assert.deepEqual(alice.messages.map(m => m.id), ['m1', 'm5', 'm2', 'm3'])
  const bob = await readMailView(identity(root, 'member', 'bob'))
  assert.deepEqual(bob.messages.map(m => m.id), ['m3', 'm4'])
  assert.equal(canSee({ role: 'member', agentKey: 'bob' }, { id: 'x', from: 'alice', to: 'captain', content: '', ts: 0 }), false)
})

test('可见性：只看本代创建之后；成员只看自己加入之后（同名新成员读不到旧信）', async () => {
  const root = fixture()
  const base = identity(root, 'captain', 'captain')
  const team = { ...base.team, createdAt: 1500, members: [{ id: 's-alice2', name: 'alice', joinedAt: 2500 }] }
  const captain = await readMailView({ ...base, team })
  assert.deepEqual(captain.messages.map(m => m.id), ['m5', 'm2', 'm3', 'm4'])
  const alice = await readMailView({ ...identity(root, 'member', 'alice'), team })
  assert.deepEqual(alice.messages.map(m => m.id), ['m3'])
})

test('list：按发信人→收信人汇总，默认不含作废', async () => {
  const text = await runTeamHistory({ action: 'list' }, identity(fixture(), 'captain', 'captain'), limits)
  assert.match(text, /共 4 封信/)
  assert.match(text, /alice → bob：1 封（未读 0）/)
  assert.match(text, /bob → captain：1 封（未读 1）/)
  assert.match(text, /1 行无法解析/)
})

test('read：过滤、分页、作废信、单封全文', async () => {
  const root = fixture()
  const cap = identity(root, 'captain', 'captain')
  const page = await runTeamHistory({ action: 'read', limit: 2 }, cap, limits)
  assert.match(page, /第 1–2 封，共 4 封（时间正序）；下一页 offset=2/)
  assert.match(page, /进度：完成第一段/)
  const toAlice = await runTeamHistory({ action: 'read', to: 'alice', include_discarded: true }, cap, limits)
  assert.match(toAlice, /旧纠正/)
  assert.match(toAlice, /已作废/)
  const byTask = await runTeamHistory({ action: 'read', task_id: 't1' }, cap, limits)
  assert.match(byTask, /改用方案 B/)
  assert.doesNotMatch(byTask, /进度/)
  const one = await runTeamHistory({ action: 'read', message_id: 'm3' }, cap, limits)
  assert.match(one, /alice → bob（已读）\n接口在 src\/api.ts/)
  await assert.rejects(runTeamHistory({ action: 'read', message_id: 'm4' }, identity(root, 'member', 'alice'), limits), /没有可见的信/)
  const recent = await runTeamHistory({ action: 'read', recent_first: true, limit: 1 }, cap, limits)
  assert.match(recent, /我卡住了/)
})

test('read：超过字符上限时截断并给下一页', async () => {
  const text = await runTeamHistory({ action: 'read' }, identity(fixture(), 'captain', 'captain'), { ...limits, maxReadChars: 60 })
  assert.match(text, /下一页 offset=/)
})

test('search：字面、区分大小写', async () => {
  const cap = identity(fixture(), 'captain', 'captain')
  assert.match(await runTeamHistory({ action: 'search', query: 'src/api' }, cap, limits), /找到 1 封/)
  assert.match(await runTeamHistory({ action: 'search', query: 'SRC/api' }, cap, limits), /没有找到/)
  await assert.rejects(runTeamHistory({ action: 'search' }, cap, limits), /需要 query/)
})

test('没有信箱目录时返回空', async () => {
  const root = mkdtempSync(join(tmpdir(), 'th-empty-'))
  assert.match(await runTeamHistory({ action: 'list' }, identity(root, 'member', 'alice'), limits), /没有信件/)
})
