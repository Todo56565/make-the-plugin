import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bucketOf } from '../../src/budget/usage.ts'
import { CompactionGate } from '../../src/budget/compact.ts'
import { reminderText } from '../../src/budget/reminder.ts'

test('未到提示阈值不出档', () => {
  assert.equal(bucketOf(0.369, 0.37, 0.03), undefined)
  assert.equal(bucketOf(Number.NaN, 0.37, 0.03), undefined)
})

test('默认档位 37/40/43', () => {
  assert.equal(bucketOf(0.37, 0.37, 0.03), 37)
  assert.equal(bucketOf(0.399, 0.37, 0.03), 37)
  assert.equal(bucketOf(0.40, 0.37, 0.03), 40)
  assert.equal(bucketOf(0.43, 0.37, 0.03), 43)
  assert.equal(bucketOf(0.449, 0.37, 0.03), 43)
})

test('自定义阈值', () => {
  assert.equal(bucketOf(0.55, 0.5, 0.05), 55)
})

test('压缩闸门：同一窗口只尝试一次', () => {
  const gate = new CompactionGate()
  assert.equal(gate.canAttempt('s', 1), true)
  gate.begin('s', 1)
  assert.equal(gate.canAttempt('s', 1), false)
  gate.end('s')
  assert.equal(gate.canAttempt('s', 1), false)
  assert.equal(gate.canAttempt('s', 2), true)
})

test('提示文本：notes 关闭时不提 team_notes', () => {
  assert.match(reminderText({ bucket: 40, compactAtRatio: 0.45, notes: true }), /40%.*45%[\s\S]*team_notes/)
  assert.doesNotMatch(reminderText({ bucket: 40, compactAtRatio: 0.45, notes: false }), /team_notes/)
})
