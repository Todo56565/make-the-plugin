import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildHistoryModel, type EventLike } from '../../src/history/model.ts'
import { runListItems, runListWindows, runReadItem, runSearch } from '../../src/history/tools.ts'
import { HistorySource, type PersistenceLike } from '../../src/history/source.ts'

const limits = { maxResults: 10, maxReadChars: 50, maxListItems: 100 }

function user(seq: number, text: string): EventLike {
  return { type: 'user/message', seq, time: seq * 1000, data: { id: `m${seq}`, content: [{ type: 'text', text }], source: {} } }
}

const events: EventLike[] = [
  user(0, '队长继承上下文'),
  user(1, '请实现登录模块'),
  { type: 'assistant/message', seq: 2, time: 2000, data: { message: { content: [{ type: 'reasoning', text: '想想' }, { type: 'text', text: '好的' }, { type: 'tool-call', id: 'c1', name: 'read_file', arguments: '{"path":"a.ts"}' }] } } },
  { type: 'tool/call', seq: 3, time: 3000, data: { callId: 'c1', name: 'read_file', arguments: '{}' } },
  { type: 'tool/result', seq: 4, time: 4000, data: { message: { toolCallId: 'c1', content: [{ type: 'text', text: 'export const SECRET_KEY = 1'.padEnd(120, '.') }] } } },
  { type: 'compaction/start', seq: 5, time: 5000, data: {} },
  { type: 'compaction/summary', seq: 6, time: 6000, data: { shadowedSeqs: [1, 2, 4] } },
  user(7, '摘要：已读取 a.ts'),
  user(8, '继续'),
]

test('buildHistoryModel：窗口划分、隐藏、工具名、继承边界', () => {
  const model = buildHistoryModel(events, 1)
  assert.equal(model.currentWindow, 2)
  assert.deepEqual(model.items.map(i => [i.id, i.window, i.role, i.hidden]), [
    ['e1', 1, 'user', true], ['e2', 1, 'assistant', true], ['e4', 1, 'tool', true], ['e7', 2, 'user', false], ['e8', 2, 'user', false],
  ])
  assert.deepEqual(model.items[2]!.toolNames, ['read_file'])
  assert.doesNotMatch(model.items[1]!.text, /想想/)
  assert.match(model.items[1]!.text, /\[调用 read_file/)
  assert.deepEqual(model.windows.map(w => [w.id, w.items, w.hiddenItems]), [['w1', 3, 3], ['w2', 2, 0]])
})

test('工具输出：列窗口、过滤、分段读、搜索', () => {
  const model = buildHistoryModel(events, 1)
  assert.match(runListWindows(model, {}), /w2（当前窗口）/)
  const tools = runListItems(model, { tool_name: 'read_file', role: 'tool' }, limits)
  assert.match(tools, /\[id: e4\]/)
  assert.doesNotMatch(tools, /e2\]/)
  assert.equal(runListItems(model, { window_id: 'w9' }, limits), '没有符合条件的条目。')
  const read = runReadItem(model, { window_id: 'w1', item_id: 'e4' }, limits)
  assert.match(read, /offset_chars=50/)
  assert.match(runReadItem(model, { window_id: 'w1', item_id: 'e4', offset_chars: 100 }, limits), /^\[w1 tool read_file 已隐藏/)
  assert.throws(() => runReadItem(model, { window_id: 'w2', item_id: 'e4' }, limits))
  assert.match(runSearch(model, { query: 'SECRET_KEY' }, limits), /\[id: e4\]/)
  assert.match(runSearch(model, { query: 'secret_key' }, limits), /没有找到/)
  assert.throws(() => runListItems(model, { role: 'bogus' }, limits))
})

test('HistorySource：flush 后只读打开，按修订缓存', async () => {
  let opens = 0
  let flushes = 0
  let revision = 'r1'
  const persistence = {
    async flush() { flushes += 1 },
    async stat() { return { revision } },
    async open(_id: string, access: string) {
      assert.equal(access, 'read')
      opens += 1
      return {
        inheritedEventCount: 1,
        async read(offset: number, length: number) { return { events: events.slice(offset, offset + length) } },
        async close() {},
      }
    },
  } as unknown as PersistenceLike
  const source = new HistorySource(() => persistence)
  const a = await source.load('s1')
  const b = await source.load('s1')
  assert.equal(a, b)
  assert.equal(opens, 1)
  assert.equal(flushes, 2)
  revision = 'r2'
  await source.load('s1')
  assert.equal(opens, 2)
  await assert.rejects(new HistorySource(() => undefined).load('s1'), /sessionPersistence/)
  // 提供本会话 flush 时优先用它，不再全量 persistence.flush()
  let sessionFlushes = 0
  await source.load('s1', undefined, async () => { sessionFlushes += 1 })
  assert.equal(sessionFlushes, 1)
  assert.equal(flushes, 3)
  // 本会话 flush 失败也照常读取已落盘部分
  await source.load('s1', undefined, async () => { throw new Error('boom') })
})

test('buildHistoryModel：compaction/prune 标记隐藏但不增加窗口', () => {
  const pruned: EventLike[] = [
    user(1, '读文件'),
    { type: 'tool/result', seq: 2, time: 2000, data: { message: { toolCallId: 'c1', content: [{ type: 'text', text: '超长原文' }] } } },
    { type: 'compaction/prune', seq: 3, time: 3000, data: { shadowedRange: { start: 2, end: 2 }, shadowedSeqs: [2], shadowedTokenCount: 10 } },
    { type: 'tool/result', seq: 4, time: 4000, data: { message: { toolCallId: 'c1', content: [{ type: 'text', text: '裁剪后' }] } } },
  ]
  const model = buildHistoryModel(pruned, 0)
  assert.equal(model.currentWindow, 1)
  assert.deepEqual(model.items.map(i => [i.id, i.hidden]), [['e1', false], ['e2', true], ['e4', false]])
  assert.deepEqual(model.windows.map(w => [w.id, w.items, w.hiddenItems]), [['w1', 3, 1]])
})

test('HistorySource：inheritedEventCount 缺失时按 0 处理', async () => {
  const persistence = {
    flush: async () => {},
    stat: async () => ({ revision: 1 }),
    open: async () => ({
      inheritedEventCount: undefined,
      read: async (offset: number) => ({ events: offset === 0 ? [user(0, 'a'), { type: 'compaction/summary', seq: 1, time: 1, data: { shadowedSeqs: [0] } }, user(2, 'b')] : [] }),
      close: async () => {},
    }),
  } as unknown as PersistenceLike
  const model = await new HistorySource(() => persistence).load('s')
  assert.equal(model.currentWindow, 2)
  assert.deepEqual(model.items.map(i => [i.id, i.window, i.hidden]), [['e0', 1, true], ['e2', 2, false]])
})
