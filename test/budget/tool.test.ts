import { test } from 'node:test'
import assert from 'node:assert/strict'
import { contextRemainingOf, renderContextRemaining } from '../../src/budget/tool.ts'

test('context_remaining：按 compactAtRatio 估算剩余', () => {
  const value = contextRemainingOf({ pressure: 30_000, contextWindow: 100_000, ratio: 0.3 }, 0.45)
  assert.deepEqual(value, { pressure: 30_000, contextWindow: 100_000, usedRatio: 0.3, estimatedTrigger: 45_000, remaining: 15_000, estimated: true })
  assert.match(renderContextRemaining(value), /还剩约 15000 token/)
  assert.equal(contextRemainingOf({ pressure: 50_000, contextWindow: 100_000, ratio: 0.5 }, 0.45).remaining, 0)
})

test('context_remaining：容量未知时返回 null 与原因', () => {
  const value = contextRemainingOf(undefined, 0.45)
  assert.equal(value.remaining, null)
  assert.match(renderContextRemaining(value), /无法估算/)
})
