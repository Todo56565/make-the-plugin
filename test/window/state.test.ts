import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SwitchStates, decide, freshnessOf, newWindowVerdict, type DecideInput } from '../../src/window/state.ts'

const turnA = {}
const turnB = {}

function input(over: Partial<DecideInput>): DecideInput {
  return {
    role: 'member', window: 1, ratio: 0.3, pressure: 300_000, compactAtRatio: 0.45, fallbackBufferTokens: 16_384,
    fresh: false, canWriteNotes: true, turn: turnA, state: {}, ...over,
  }
}

test('新鲜度：mtime ≥ 窗口开始，或本窗口记录到写入', () => {
  assert.deepEqual(freshnessOf({ window: 2, windowStart: 100, mtimeMs: undefined, lastWrite: undefined }), { fresh: false })
  assert.deepEqual(freshnessOf({ window: 2, windowStart: 100, mtimeMs: 90, lastWrite: undefined }), { fresh: false, at: 90 })
  assert.deepEqual(freshnessOf({ window: 2, windowStart: 100, mtimeMs: 100, lastWrite: undefined }), { fresh: true, at: 100 })
  assert.deepEqual(freshnessOf({ window: 2, windowStart: 100, mtimeMs: 90, lastWrite: { window: 2, at: 95 } }), { fresh: true, at: 95 }, '时钟偏差时写入事件兜住')
  assert.deepEqual(freshnessOf({ window: 2, windowStart: 100, mtimeMs: 90, lastWrite: { window: 1, at: 95 } }), { fresh: false, at: 90 }, '上一窗口的写入不算')
})

test('成员：未到换窗点不动；到点写过笔记直接换', () => {
  assert.deepEqual(decide(input({ ratio: 0.44 })), { kind: 'none' })
  assert.deepEqual(decide(input({ ratio: 0.45, fresh: true })), { kind: 'compact', reason: 'threshold' })
})

test('成员：到点没写笔记 ⇒ 进兜底，额度加在当前压力上', () => {
  assert.deepEqual(decide(input({ ratio: 0.45, pressure: 450_000 })), { kind: 'enter-fallback', deadline: 466_384 })
})

test('成员：看不到 team_notes ⇒ 不兜底，直接换', () => {
  assert.deepEqual(decide(input({ ratio: 0.45, canWriteNotes: false })), { kind: 'compact', reason: 'no-notes' })
})

test('兜底：状态粘住不按比例重判；写笔记不触发换窗；额度用完才换', () => {
  const state = { fallback: { window: 1, deadline: 466_384, turn: turnA } }
  assert.deepEqual(decide(input({ ratio: 0.40, pressure: 400_000, state })), { kind: 'none' }, '用量回落仍在兜底')
  assert.deepEqual(decide(input({ ratio: 0.46, pressure: 460_000, fresh: true, state })), { kind: 'none' }, '写了笔记也不换，等工具或额度')
  assert.deepEqual(decide(input({ ratio: 0.47, pressure: 466_384, state })), { kind: 'compact', reason: 'buffer' })
})

test('兜底中结束本轮：下一次被唤醒的第一步换窗', () => {
  const state = { fallback: { window: 1, deadline: 466_384, turn: turnA } }
  assert.deepEqual(decide(input({ ratio: 0.46, pressure: 455_000, turn: turnB, state })), { kind: 'compact', reason: 'buffer' })
  assert.deepEqual(decide(input({ ratio: 0.46, pressure: 455_000, turn: undefined, state })), { kind: 'none' }, '没有轮次信号的组装不换')
})

test('请求过换窗 ⇒ 下一步换（成员、队长都一样）', () => {
  assert.deepEqual(decide(input({ state: { newWindow: 1 } })), { kind: 'compact', reason: 'tool' })
  assert.deepEqual(decide(input({ role: 'captain', state: { newWindow: 1 } })), { kind: 'compact', reason: 'tool' })
  assert.deepEqual(decide(input({ state: { newWindow: 0 } })), { kind: 'none' }, '旧窗口的请求不算')
})

test('队长：到点、超过兜底额度都不强制换窗', () => {
  assert.deepEqual(decide(input({ role: 'captain', ratio: 0.6, pressure: 600_000 })), { kind: 'none' })
  assert.deepEqual(decide(input({ role: 'captain', ratio: 0.6, state: { fallback: { window: 1, deadline: 1, turn: turnA } } })), { kind: 'none' })
})

test('context_new_window：没写笔记每窗口只拒绝一次', () => {
  const state: { refused?: number } = {}
  assert.equal(newWindowVerdict({ window: 2, fresh: true, canWriteNotes: true, state }), 'accept')
  assert.equal(newWindowVerdict({ window: 2, fresh: false, canWriteNotes: true, state }), 'refuse')
  state.refused = 2
  assert.equal(newWindowVerdict({ window: 2, fresh: false, canWriteNotes: true, state }), 'accept', '第二次放行')
  assert.equal(newWindowVerdict({ window: 3, fresh: false, canWriteNotes: true, state }), 'refuse', '新窗口重新计')
  assert.equal(newWindowVerdict({ window: 3, fresh: false, canWriteNotes: false, state }), 'accept', '写不了笔记不拒绝')
})

test('SwitchStates：按会话 id 存，换窗后旧窗口状态作废，写入记录保留', () => {
  const states = new SwitchStates()
  const s = states.get('sess')
  s.fallback = { window: 1, deadline: 10, turn: turnA }
  s.newWindow = 1
  s.refused = 1
  states.recordWrite('sess', 1, 123)
  assert.equal(states.settle('sess', 1).fallback?.deadline, 10, '同窗口保留')
  const after = states.settle('sess', 2)
  assert.equal(after.fallback, undefined)
  assert.equal(after.newWindow, undefined)
  assert.equal(after.refused, undefined)
  assert.deepEqual(after.lastWrite, { window: 1, at: 123 })
  assert.equal(states.peek('other'), undefined)
})
