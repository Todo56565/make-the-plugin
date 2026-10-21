import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Session } from '@deepseek-ai/dsh-session'
import { applyWindowEvent, type WindowEvent, type WindowState } from '../../src/window/counter.ts'
import { SWITCH_RECORD_TYPE, SwitchLog, hideFrom, parseSwitchRecord, switchStateFrom, type FoldedSwitch, type SwitchRecord } from '../../src/window/switch-log.ts'

const rec = (seq: number, data: SwitchRecord | Record<string, unknown>): WindowEvent => ({ type: SWITCH_RECORD_TYPE, seq, time: seq, data, ignorable: true })

function replay(events: WindowEvent[]): WindowState {
  return events.reduce(applyWindowEvent, { summaries: [], handoffSent: false, switch: {} } as WindowState)
}

test('E5b：投影折叠换窗记录与 turn/start；重放结果与写入顺序一致', () => {
  const events: WindowEvent[] = [
    { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } },
    rec(2, { kind: 'note-write', window: 1, at: 100 }),
    rec(3, { kind: 'refused', window: 1 }),
    rec(4, { kind: 'fallback', window: 1, startedAt: 200, deadline: 9000, turn: 1 }),
    { type: 'turn/start', seq: 5, time: 5, data: { turn: 2 } },
    rec(6, { kind: 'bogus' }),
    { type: SWITCH_RECORD_TYPE, seq: 7, time: 7, data: { kind: 'new-window', window: 1 } },
  ]
  const state = replay(events)
  assert.equal(state.lastTurn, 5)
  assert.equal(state.switch.newWindow, undefined, '没有 ignorable 标记的不认')
  assert.deepEqual(switchStateFrom(state.switch, 0, 1), {
    fallback: { window: 1, startedAt: 200, deadline: 9000, turn: 1 },
    refused: 1,
    lastWrite: { window: 1, at: 100 },
  })
  assert.deepEqual(replay(events), state, '重放幂等')
  // 窗口变了：兜底与拒绝作废，写笔记保留
  assert.deepEqual(switchStateFrom(state.switch, 0, 2), { lastWrite: { window: 1, at: 100 } })
})

test('E5b：settled 清掉该窗口的请求与兜底；继承前缀里的记录忽略', () => {
  const state = replay([
    rec(2, { kind: 'fallback', window: 1, startedAt: 0, deadline: 1, turn: null }),
    rec(3, { kind: 'new-window', window: 1 }),
    rec(4, { kind: 'hide-tools', hide: true }),
    rec(5, { kind: 'settled', window: 1 }),
  ])
  assert.deepEqual(switchStateFrom(state.switch, 0, 1), {})
  assert.equal(hideFrom(state.switch, 0), true)
  assert.equal(hideFrom(state.switch, 10), undefined, '继承来的隐藏决定不算')
  const child = replay([rec(2, { kind: 'refused', window: 1 })])
  assert.deepEqual(switchStateFrom(child.switch, 3, 1), {}, 'seq < inheritedEventCount 忽略')
  assert.equal(parseSwitchRecord({ kind: 'fallback', window: 0, startedAt: 0, deadline: 0, turn: null }), undefined)
})

test('SwitchLog：写日志成功以投影为准；失败改用内存并只告警一次', () => {
  const session = { id: 's1' } as Session
  let folded: FoldedSwitch = {}
  let seq = 0
  let fail = false
  const warnings: string[] = []
  const log = new SwitchLog({
    read: () => folded,
    append: (_s, record) => {
      if (fail) throw new Error('boom')
      folded = replay([rec(++seq, record)]).switch
    },
    warn: m => warnings.push(m),
  })
  log.record(session, { kind: 'refused', window: 1 })
  assert.deepEqual(switchStateFrom(log.folded(session), 0, 1), { refused: 1 })
  fail = true
  log.record(session, { kind: 'new-window', window: 1 })
  log.record(session, { kind: 'note-write', window: 1, at: 5 })
  assert.deepEqual(switchStateFrom(log.folded(session), 0, 1), { refused: 1, newWindow: 1, lastWrite: { window: 1, at: 5 } })
  assert.equal(warnings.length, 1)
})
