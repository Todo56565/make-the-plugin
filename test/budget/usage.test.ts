import { test } from 'node:test'
import assert from 'node:assert/strict'
import { captainLevels, levelOf, memberLevels } from '../../src/budget/usage.ts'
import { CompactionGate } from '../../src/budget/compact.ts'
import { FALLBACK_PROMPT, captainReminderText, memberReminderText } from '../../src/budget/reminder.ts'

test('成员档位：不整除时去掉最后一档', () => {
  assert.deepEqual(memberLevels(0.37, 0.45, 0.03), [37, 40])
  assert.deepEqual(memberLevels(0.37, 0.45, 0.04), [37, 41])
  assert.deepEqual(memberLevels(0.36, 0.45, 0.03), [36, 39, 42])
  assert.deepEqual(memberLevels(0.02, 0.05, 0.03), [2], '测试阈值 2/5/3 只有一档')
  assert.deepEqual(memberLevels(0.02, 0.04, 0.03), [2], '只剩一档时保留（第一档说明换窗工具）')
  assert.deepEqual(memberLevels(0.5, 0.45, 0.03), [], 'remindAt ≥ compactAt 没有档位')
})

test('队长档位：compactAt 与再后一个步长', () => {
  assert.deepEqual(captainLevels(0.45, 0.03), [45, 48])
  assert.deepEqual(captainLevels(0.05, 0.03), [5, 8])
})

test('levelOf：取已达到的最高一档', () => {
  const levels = [37, 40]
  assert.equal(levelOf(0.369, levels), undefined)
  assert.equal(levelOf(Number.NaN, levels), undefined)
  assert.equal(levelOf(0.37, levels), 37)
  assert.equal(levelOf(0.399, levels), 37)
  assert.equal(levelOf(0.40, levels), 40)
  assert.equal(levelOf(0.449, levels), 40)
  assert.equal(levelOf(0.6, levels), 40)
})

test('压缩闸门：同一窗口同一原因只尝试一次', () => {
  const gate = new CompactionGate()
  assert.equal(gate.canAttempt('s', '1:tool'), true)
  gate.begin('s', '1:tool')
  assert.equal(gate.isRunning('s'), true)
  assert.equal(gate.canAttempt('s', '1:buffer'), false, '运行中不再尝试')
  gate.end('s')
  assert.equal(gate.canAttempt('s', '1:tool'), false)
  assert.equal(gate.canAttempt('s', '1:buffer'), true)
  assert.equal(gate.canAttempt('s', '2:tool'), true)
})

test('成员提醒：第一档说明换窗工具，之后只催', () => {
  const first = memberReminderText({ level: 37, first: true, compactAtRatio: 0.45, notes: true })
  assert.match(first, /37%[\s\S]*45%/)
  assert.match(first, /team_notes/)
  assert.match(first, /context_new_window/)
  const later = memberReminderText({ level: 40, first: false, compactAtRatio: 0.45, notes: true })
  assert.match(later, /40%/)
  assert.match(later, /context_new_window/)
  assert.ok(later.length < first.length, '后续提醒更短')
  assert.doesNotMatch(memberReminderText({ level: 37, first: true, compactAtRatio: 0.45, notes: false }), /team_notes/)
})

test('队长提醒不催促；兜底提示要求一次写完再换窗', () => {
  const text = captainReminderText(45, true)
  assert.match(text, /45%/)
  assert.match(text, /context_new_window/)
  assert.match(text, /不换也可以/)
  assert.doesNotMatch(text, /尽快|立即|必须/)
  assert.match(FALLBACK_PROMPT, /team_notes/)
  assert.match(FALLBACK_PROMPT, /context_new_window/)
  assert.match(FALLBACK_PROMPT, /不要继续任务/)
  assert.match(FALLBACK_PROMPT, /把最新进展补记进你自己的笔记（尽量一次 team_notes）/)
  assert.match(FALLBACK_PROMPT, /然后立即调用 context_new_window/)
})
