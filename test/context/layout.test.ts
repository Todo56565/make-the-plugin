import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join, relative } from 'node:path'
import {
  attemptSnapshotDir, fullCursorPath, fullVolumePath, generationOf, notesTeamDir, parseTeamGenKey,
  pendingPath, snapshotFileName, teamGenKey, workspaceSnapshotPath,
} from '../../src/context/layout.ts'
import { sanitizeKey } from '../../src/team/team-file.ts'

test('代：createdAt 转 base36，可解析回去', () => {
  const createdAt = 1_792_000_000_000
  const gen = generationOf(createdAt)
  assert.match(gen, /^[0-9a-z]{8}$/)
  assert.deepEqual(parseTeamGenKey(teamGenKey('api-team', createdAt)), { teamId: 'api-team', generation: gen, createdAt })
  assert.equal(parseTeamGenKey('no-generation'), undefined)
  assert.equal(parseTeamGenKey('x@'), undefined)
  assert.equal(parseTeamGenKey('x@UPPER'), undefined)
  assert.throws(() => generationOf(-1))
})

test('各区路径', () => {
  const root = '/w/.agent-teams'
  assert.equal(notesTeamDir(root, 't', 36), '/w/.agent-teams/.context/notes/teams/nanmi/t@10')
  assert.equal(attemptSnapshotDir(root, 't', 36, 't3', 2), '/w/.agent-teams/.context/records/teams/nanmi/t@10/t3/a2')
  assert.equal(snapshotFileName(7, 'abcdef1234'), '007-abcdef12.md')
  assert.equal(fullVolumePath(root, 1), '/w/.agent-teams/.context/records/full/0001.md')
  assert.equal(workspaceSnapshotPath(root, 12), '/w/.agent-teams/.context/records/workspace-snapshots/000012.md')
  assert.equal(pendingPath(root, 'team-a', 36), '/w/.agent-teams/.context/shared/pending/nanmi/team-a@10.jsonl')
  assert.equal(fullCursorPath(root), '/w/.agent-teams/.context/state/full-cursor.json')
})

test('最长路径：相对状态根不超过 160 字符（给 Windows MAX_PATH 留出工作区路径余量）', () => {
  const teamId = sanitizeKey('x'.repeat(200))
  assert.equal(teamId.length, 57)
  const dir = attemptSnapshotDir('/r', teamId, Number.MAX_SAFE_INTEGER, 't99999', 9999)
  const file = join(dir, snapshotFileName(999, 'f'.repeat(64)))
  const rel = relative('/r', file)
  assert.ok(rel.length <= 160, `${rel.length}: ${rel}`)
})
