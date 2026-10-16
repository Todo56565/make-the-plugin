import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyWindowEvent, windowInfoFrom, type WindowState } from '../../src/window/counter.ts'

test('投影只记录 compaction/summary 的 seq 与时间', () => {
  let state: WindowState = { summaries: [] }
  state = applyWindowEvent(state, { type: 'user/message', seq: 0, time: 1 })
  const same = state
  state = applyWindowEvent(state, { type: 'compaction/end', seq: 1, time: 2 })
  assert.equal(state, same, '无关事件返回同一引用')
  state = applyWindowEvent(state, { type: 'compaction/summary', seq: 5, time: 50 })
  assert.deepEqual(state.summaries, [{ seq: 5, time: 50 }])
})

test('窗口编号与开始时间：与 history 模型同口径，跳过继承前缀', () => {
  const summaries = [{ seq: 3, time: 30 }, { seq: 10, time: 100 }, { seq: 20, time: 200 }]
  assert.deepEqual(windowInfoFrom([], 0, 7), { index: 1, startTime: 7 }, 'w1 用会话 createdAt')
  assert.deepEqual(windowInfoFrom(summaries, 0, 7), { index: 4, startTime: 200 })
  assert.deepEqual(windowInfoFrom(summaries, 5, 7), { index: 3, startTime: 200 }, '继承来的摘要不算')
  assert.deepEqual(windowInfoFrom(summaries.slice(0, 1), 5, 7), { index: 1, startTime: 7 })
})
