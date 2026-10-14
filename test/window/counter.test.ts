import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isSuccessfulCompactionEnd } from '../../src/window/counter.ts'

test('只计成功的 compaction/end', () => {
  assert.equal(isSuccessfulCompactionEnd({ type: 'compaction/end', data: { compactionId: 'x', turn: 1 } }), true)
  assert.equal(isSuccessfulCompactionEnd({ type: 'compaction/end', data: { compactionId: 'x', turn: 1, error: 'boom' } }), false)
  assert.equal(isSuccessfulCompactionEnd({ type: 'compaction/start', data: {} }), false)
})
