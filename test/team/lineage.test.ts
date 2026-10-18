import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveLeadIdentity, shouldHideTools, teamLeadMatch, type HeaderLike } from '../../src/team/lineage.ts'
import type { TeamInfo } from '../../src/team/team-file.ts'

const team = (captain: string, members: string[]): TeamInfo => ({
  id: 't', name: 't', captainSessionId: captain, createdAt: 0, tasks: [],
  members: members.map((id, i) => ({ id, name: `m${i}` })),
})
const sub = (parent: string): HeaderLike => ({ parentSession: parent, origin: 'subagent', delegationDepth: 1 })

test('teamLeadMatch：队长本身、顶层 fork 后代算；成员与成员的 fork 不算', () => {
  const t = team('cap', ['mem'])
  assert.equal(teamLeadMatch(t, { sessionId: 'cap', ancestry: [], inheritsLead: true }), true)
  assert.equal(teamLeadMatch(t, { sessionId: 'f', ancestry: ['cap'], inheritsLead: true }), true)
  assert.equal(teamLeadMatch(t, { sessionId: 'f', ancestry: ['cap'], inheritsLead: false }), false, '子代理不继承')
  assert.equal(teamLeadMatch(t, { sessionId: 'mem', ancestry: ['cap'], inheritsLead: false }), false)
  assert.equal(teamLeadMatch(t, { sessionId: 'f', ancestry: ['mem', 'cap'], inheritsLead: true }), false, '成员的 fork')
})

test('shouldHideTools：只隐藏父会话不是队长的普通子会话', () => {
  const teams = [team('cap', ['mem'])]
  const lead = (id: string, ancestry: string[] = []) => ({ sessionId: id, ancestry, inheritsLead: true })
  assert.equal(shouldHideTools({ child: { id: 'x', header: {} }, parent: undefined, teams }), false, '顶层会话')
  assert.equal(shouldHideTools({ child: { id: 'mem', header: sub('cap') }, parent: lead('cap'), teams }), false, '成员')
  assert.equal(shouldHideTools({ child: { id: 'x', header: sub('cap') }, parent: lead('cap'), teams }), false, '队长的子代理')
  assert.equal(shouldHideTools({ child: { id: 'x', header: sub('f') }, parent: lead('f', ['cap']), teams }), false, '队长 fork 的子代理')
  assert.equal(shouldHideTools({ child: { id: 'x', header: sub('p') }, parent: lead('p'), teams }), true, '普通会话的子代理')
  assert.equal(shouldHideTools({ child: { id: 'x', header: sub('p') }, parent: lead('p'), teams: [] }), true, '没有团队')
  assert.equal(shouldHideTools({ child: { id: 'x', header: sub('mem') }, parent: { sessionId: 'mem', ancestry: ['cap'], inheritsLead: false }, teams }), true, '成员的子代理')
  assert.equal(shouldHideTools({ child: { id: 'x', header: sub('p') }, parent: undefined, teams }), false, '读不到父会话：保留')
})

test('resolveLeadIdentity：沿父链解析；链断或成环', async () => {
  const headers: Record<string, HeaderLike> = { f: { parentSession: 'cap' }, cap: {}, s: sub('f') }
  const lookup = async (id: string) => headers[id]
  assert.deepEqual(await resolveLeadIdentity('f', lookup), { sessionId: 'f', ancestry: ['cap'], inheritsLead: true })
  assert.deepEqual(await resolveLeadIdentity('s', lookup), { sessionId: 's', ancestry: ['f', 'cap'], inheritsLead: false })
  assert.equal(await resolveLeadIdentity('gone', lookup), undefined)
  assert.equal(await resolveLeadIdentity('b', async id => (id === 'b' ? { parentSession: 'missing' } : undefined)), undefined, '链断')
  const loop: Record<string, HeaderLike> = { a: { parentSession: 'b' }, b: { parentSession: 'a' } }
  assert.deepEqual(await resolveLeadIdentity('a', async id => loop[id]), { sessionId: 'a', ancestry: ['b'], inheritsLead: true })
})
