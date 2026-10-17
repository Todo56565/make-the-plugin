import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { coerceTeam, sanitizeKey } from '../../src/team/team-file.ts'
import { matchIdentity, resolveIdentity } from '../../src/team/identity.ts'
import { TeamDirectory } from '../../src/team/directory.ts'

const team = (id: string, captain: string, members: Array<[string, string]>) => ({
  id, name: id, captainSessionId: captain, createdAt: 0,
  members: members.map(([mid, name]) => ({ id: mid, name })),
  tasks: [{ id: 't1', subject: '调研', status: 'in_progress', assignee: 'alice' }],
})

test('coerceTeam 宽容解析', () => {
  assert.equal(coerceTeam(null, 'x'), undefined)
  assert.equal(coerceTeam({ members: [] }, 'x'), undefined)
  const t = coerceTeam(team('a', 'c1', [['m1', 'alice']]), 'a')
  assert.equal(t?.members[0]?.name, 'alice')
  assert.equal(t?.tasks[0]?.subject, '调研')
})

test('matchIdentity：队长、成员、歧义、未派生成员', () => {
  const teams = [coerceTeam(team('a', 'c1', [['m1', 'alice'], ['', 'bob']]), 'a')!]
  assert.deepEqual(matchIdentity(teams, 'c1') !== 'ambiguous' && matchIdentity(teams, 'c1')?.agentKey, 'captain')
  const m = matchIdentity(teams, 'm1')
  assert.ok(m !== undefined && m !== 'ambiguous' && m.role === 'member' && m.agentKey === 'alice')
  assert.equal(matchIdentity(teams, ''), undefined)
  const two = [...teams, coerceTeam(team('b', 'c2', [['m1', 'x']]), 'b')!]
  assert.equal(matchIdentity(two, 'm1'), 'ambiguous')
})

test('sanitizeKey 与 agent-teams 同规则', () => {
  assert.equal(sanitizeKey('  Alice Smith '), 'alice-smith')
  assert.equal(sanitizeKey('研究员 1'), '研究员-1')
  assert.match(sanitizeKey('!!!'), /^k-[0-9a-f]{8}$/)
})

function workspace(): string {
  const cwd = mkdtempSync(join(tmpdir(), 'dtb-'))
  const root = join(cwd, '.agent-teams')
  mkdirSync(join(root, 'team-a'), { recursive: true })
  writeFileSync(join(root, 'team-a', 'team.json'), '\uFEFF' + JSON.stringify(team('team-a', 'c1', [['m1', 'Alice']])))
  mkdirSync(join(root, 'archive', 'old'), { recursive: true })
  writeFileSync(join(root, 'archive', 'old', 'team.json'), JSON.stringify(team('old', 'm1', [])))
  mkdirSync(join(root, '.context', 'notes'), { recursive: true })
  mkdirSync(join(root, 'broken'), { recursive: true })
  return cwd
}

test('resolveIdentity：跳过 archive 与 .context，读 BOM', () => {
  const cwd = workspace()
  const warns: string[] = []
  const id = resolveIdentity({ cwd, stateDir: '.agent-teams', sessionId: 'm1', warn: w => warns.push(w) })
  assert.equal(id?.role, 'member')
  assert.equal(id?.fileKey, 'alice')
  assert.equal(warns.length, 0)
})

test('resolveIdentity：损坏的 team.json 只告警', () => {
  const cwd = workspace()
  writeFileSync(join(cwd, '.agent-teams', 'broken', 'team.json'), '{oops')
  const warns: string[] = []
  assert.equal(resolveIdentity({ cwd, stateDir: '.agent-teams', sessionId: 'm1', warn: w => warns.push(w) }), undefined)
  assert.equal(warns.length, 1)
})

test('TeamDirectory：否定结果短时缓存，事件后失效', () => {
  const cwd = workspace()
  let now = 0
  const dir = new TeamDirectory('.agent-teams', () => {}, 5_000, () => now)
  const agent = { id: 'm2', session: { header: { cwd } } }
  assert.equal(dir.identityOf(agent), undefined)
  writeFileSync(join(cwd, '.agent-teams', 'team-a', 'team.json'), JSON.stringify(team('team-a', 'c1', [['m1', 'Alice'], ['m2', 'Bob']])))
  assert.equal(dir.identityOf(agent), undefined, 'TTL 内仍用缓存')
  assert.equal(dir.identityOf(agent, true)?.agentKey, 'Bob', 'fresh 跳过否定缓存（工具调用）')
  dir.invalidate()
  assert.equal(dir.identityOf(agent)?.agentKey, 'Bob')
  now = 1_000_000
  assert.equal(dir.identityOf(agent)?.agentKey, 'Bob', '肯定结果不过期')
})

test('coerceTeam 读出任务的 attempt_id（换窗交接要带）', () => {
  const t = coerceTeam({
    captainSessionId: 'c', createdAt: 0, members: [],
    tasks: [
      { id: 't1', subject: 's', status: 'in_progress', assignee: 'bob', attemptId: 'a-1' },
      { id: 't2', subject: 's', status: 'pending', attemptId: '' },
    ],
  }, 'x')!
  assert.equal(t.tasks[0]!.attemptId, 'a-1')
  assert.equal('attemptId' in t.tasks[1]!, false)
})
