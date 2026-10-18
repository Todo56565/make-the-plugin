import { test } from 'node:test'
import assert from 'node:assert/strict'
import { shouldHideTools, type HeaderLike } from '../../src/team/tool-visibility.ts'
import type { TeamInfo } from '../../src/team/team-file.ts'

const team = (captain: string, members: string[]): TeamInfo => ({
  id: 't', name: 't', captainSessionId: captain, createdAt: 0, tasks: [],
  members: members.map((id, i) => ({ id, name: `m${i}` })),
})
const sub = (parent: string): HeaderLike => ({ parentSession: parent, origin: 'subagent', delegationDepth: 1 })

test('shouldHideTools：只隐藏父会话不是队长的普通子会话', () => {
  const teams = [team('cap', ['mem'])]
  assert.equal(shouldHideTools({ id: 'x', header: {} }, teams), false, '顶层会话')
  assert.equal(shouldHideTools({ id: 'f', header: { parentSession: 'cap' } }, teams), false, '顶层 fork 不是子代理')
  assert.equal(shouldHideTools({ id: 'mem', header: sub('cap') }, teams), false, '成员')
  assert.equal(shouldHideTools({ id: 'x', header: sub('cap') }, teams), false, '队长的子代理')
  assert.equal(shouldHideTools({ id: 'x', header: sub('p') }, teams), true, '普通会话的子代理')
  assert.equal(shouldHideTools({ id: 'x', header: sub('p') }, []), true, '没有团队')
  assert.equal(shouldHideTools({ id: 'x', header: sub('mem') }, teams), true, '成员的子代理')
})
