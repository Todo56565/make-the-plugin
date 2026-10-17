import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { TeamToolCalls, cleanMergeOutput, mergePendingBatch, readMergeCursor, type Generate } from '../../src/notes/merge.ts'
import { addPending, readPending, type NewPendingEntry } from '../../src/notes/pending.ts'
import { lockPath } from '../../src/context/layout.ts'
import { NotesStore } from '../../src/notes/store.ts'


test('TeamToolCalls：只认 agent_teams_* 调用的返回', () => {
  const calls = new TeamToolCalls()
  calls.handle('s', 'tool/call', { callId: 'a', name: 'agent_teams_update_task' })
  calls.handle('s', 'tool/call', { callId: 'b', name: 'read' })
  assert.equal(calls.handle('s', 'tool/result', { message: { toolCallId: 'b' } }), false)
  assert.equal(calls.handle('other', 'tool/result', { message: { toolCallId: 'a' } }), false)
  assert.equal(calls.handle('s', 'tool/result', { message: { toolCallId: 'a' } }), true)
  assert.equal(calls.handle('s', 'tool/result', { message: { toolCallId: 'a' } }), false)
})

test('cleanMergeOutput 去掉整体代码块', () => {
  assert.equal(cleanMergeOutput('```markdown\n# 共享\n- a\n```'), '# 共享\n- a\n')
  assert.equal(cleanMergeOutput('  \n'), '')
})

const A = { id: 'team-a', createdAt: 0 }
const entry = (taskId: string, at: number, member = 'Alice', status = 'completed'): NewPendingEntry => ({
  key: `team-a@0:${taskId}:1`, teamName: 'A 队', taskId, subject: `任务 ${taskId}`, attempt: 1, member, status,
  snapshot: `records/teams/team-a/${taskId}/a1/001-abcdef12.md`, ref: 's/w1/e1', at,
})

function setup(max = 10_000) {
  const stateRoot = mkdtempSync(join(tmpdir(), 'merge-'))
  const store = new NotesStore(join(stateRoot, '.context', 'notes'), 10_000, A, max, { stateRoot })
  const snap = (taskId: string, text: string) => writeSnapshot(stateRoot, taskId, text)
  const job = (generate: Generate, batchMax?: number) => ({ stateRoot, store, team: A, generate, signal: new AbortController().signal, batchMax })
  return { stateRoot, store, snap, job }
}

function writeSnapshot(stateRoot: string, taskId: string, text: string): void {
  const file = join(stateRoot, '.context', 'records', 'teams', 'nanmi', 'team-a@0', taskId, 'a1', '001-abcdef12.md')
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, text)
}

test('合并喂的是清单快照而非活笔记；成功后只删喂入的 id', async () => {
  const { stateRoot, store, snap, job } = setup()
  await addPending(stateRoot, A, [entry('t1', 1), entry('t2', 2, 'Bob', 'failed'), entry('t3', 3), entry('t4', 4)])
  snap('t1', '结论：方案 B')
  snap('t2', '坑：接口限流')
  snap('t3', '   ')
  await store.write('teams/team-a/alice.md', '活笔记：不该出现')
  let seen = ''
  const result = await mergePendingBatch(job(async (_s, prompt) => { seen = prompt; return '# 共享\n- 方案 B（Alice，t1）' }))
  assert.equal(result.outcome, 'merged')
  assert.match(seen, /结论：方案 B/)
  assert.match(seen, /成员：Bob；任务：t2 任务 t2（失败）/)
  assert.doesNotMatch(seen, /活笔记/)
  assert.equal(await store.read('workspace.md'), '# 共享\n- 方案 B（Alice，t1）\n')
  const left = await readPending(stateRoot, A)
  assert.deepEqual(left.map(e => e.taskId), ['t4'], 't1、t2 喂入后删除，t3 空快照直接删除，t4 快照缺失保留')
  assert.equal(result.missing.length, 1)
  assert.equal((await mergePendingBatch(job(async () => { throw new Error('不该调用') }))).outcome, 'nothing')
})

test('分批：至多 batchMax 条，按时间先后', async () => {
  const { stateRoot, snap, job } = setup()
  await addPending(stateRoot, A, [entry('t2', 2), entry('t1', 1), entry('t3', 3)])
  for (const t of ['t1', 't2', 't3']) snap(t, `笔记 ${t}`)
  let seen = ''
  await mergePendingBatch(job(async (_s, p) => { seen = p; return 'ok' }, 2))
  assert.match(seen, /笔记 t1[\s\S]*笔记 t2/)
  assert.doesNotMatch(seen, /笔记 t3/)
  assert.deepEqual((await readPending(stateRoot, A)).map(e => e.taskId), ['t3'])
})

test('失败不删清单：超限、空输出、冲突；merge.lock 被占用时跳过', async () => {
  const { stateRoot, store, snap, job } = setup(100)
  await addPending(stateRoot, A, [entry('t1', 1)])
  snap('t1', '结论')
  assert.equal((await mergePendingBatch(job(async () => 'y'.repeat(200)))).outcome, 'too-large')
  assert.equal((await mergePendingBatch(job(async () => ''))).outcome, 'empty-output')
  let n = 0
  const racing: Generate = async () => { await store.write('workspace.md', `改动 ${++n}`); return '新内容' }
  assert.equal((await mergePendingBatch(job(racing))).outcome, 'conflict')
  assert.equal(await store.read('workspace.md'), '改动 2')
  assert.equal((await readPending(stateRoot, A)).length, 1)
  const held = lockPath(stateRoot, 'merge')
  mkdirSync(dirname(held), { recursive: true })
  writeFileSync(held, JSON.stringify({ pid: 1, time: Date.now(), token: 'x' }))
  assert.equal((await mergePendingBatch(job(async () => 'ok'))).outcome, 'busy')
  assert.equal((await readPending(stateRoot, A)).length, 1)
})

test('材料 a / b 进提示词；成功后记下合并时间；搁置的批次不调用模型', async () => {
  const { stateRoot, snap, job } = setup()
  await addPending(stateRoot, A, [entry('t1', 1)])
  snap('t1', '结论')
  assert.equal(await readMergeCursor(stateRoot), 0)
  let since = -1
  let seen = ''
  const result = await mergePendingBatch({
    ...job(async (_s, p) => { seen = p; return 'ok' }),
    extras: async s => { since = s; return { recent: '全文条目 X', snapshots: [{ seq: 3, content: '旧版共享笔记' }] } },
    now: () => 1234,
  })
  assert.equal(result.outcome, 'merged')
  assert.equal(since, 0)
  assert.match(seen, /<workspace.md 历史快照 #3（参考）>\n旧版共享笔记/)
  assert.match(seen, /<近期任务记录（参考）>\n全文条目 X/)
  assert.equal(await readMergeCursor(stateRoot), 1234)

  await addPending(stateRoot, A, [entry('t2', 2)])
  snap('t2', '再一条')
  let called = false
  const held = await mergePendingBatch({ ...job(async () => { called = true; return 'x' }), held: () => true })
  assert.equal(held.outcome, 'held')
  assert.equal(called, false)
  assert.equal((await readPending(stateRoot, A)).length, 1)
})
