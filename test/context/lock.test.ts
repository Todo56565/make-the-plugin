import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, utimesSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LockTimeoutError, withFileLock } from '../../src/context/lock.ts'
import { atomicWrite, renameWithRetry } from '../../src/context/atomic.ts'

const dir = () => mkdtempSync(join(tmpdir(), 'lock-'))

test('锁：串行化并发写，结束后删除锁文件', async () => {
  const lock = join(dir(), 'locks', 'w.lock')
  const order: string[] = []
  await Promise.all(['a', 'b', 'c'].map(name => withFileLock(lock, async () => {
    order.push(`${name}+`)
    await new Promise(r => setTimeout(r, 10))
    order.push(`${name}-`)
  }, { retryMs: 2 })))
  for (let i = 0; i < order.length; i += 2) assert.equal(order[i]!.slice(0, 1), order[i + 1]!.slice(0, 1))
  assert.equal(existsSync(lock), false)
})

test('锁：过期锁可接管；未过期则超时', async () => {
  const d = dir()
  const lock = join(d, 'w.lock')
  writeFileSync(lock, JSON.stringify({ pid: 1, time: 0, token: 'old' }))
  let ran = false
  await withFileLock(lock, async () => { ran = true }, { now: () => 100_000 })
  assert.equal(ran, true)
  writeFileSync(lock, JSON.stringify({ pid: 1, time: Date.now(), token: 'live' }))
  await assert.rejects(withFileLock(lock, async () => undefined, { timeoutMs: 30, retryMs: 5 }), LockTimeoutError)
  assert.equal(JSON.parse(readFileSync(lock, 'utf8')).token, 'live')
})

test('锁：内容读不出（创建后写完前崩溃）按 mtime 判过期；新建的不接管', async () => {
  const d = dir()
  const lock = join(d, 'w.lock')
  writeFileSync(lock, '')
  const old = (Date.now() - 60_000) / 1000
  utimesSync(lock, old, old)
  let ran = false
  await withFileLock(lock, async () => { ran = true })
  assert.equal(ran, true)
  assert.equal(existsSync(lock), false)
  writeFileSync(lock, '{"pid":')
  await assert.rejects(withFileLock(lock, async () => undefined, { timeoutMs: 30, retryMs: 5 }), LockTimeoutError)
  assert.equal(readFileSync(lock, 'utf8'), '{"pid":')
})

test('锁：fn 抛错也释放', async () => {
  const lock = join(dir(), 'w.lock')
  await assert.rejects(withFileLock(lock, async () => { throw new Error('x') }))
  assert.equal(existsSync(lock), false)
})

test('rename 遇 EPERM 重试，超过次数抛出', async () => {
  let calls = 0
  const flaky = async () => { calls += 1; if (calls < 3) throw Object.assign(new Error('busy'), { code: 'EPERM' }) }
  await renameWithRetry('a', 'b', { rename: flaky, delayMs: 1 })
  assert.equal(calls, 3)
  calls = 0
  const always = async () => { calls += 1; throw Object.assign(new Error('busy'), { code: 'EBUSY' }) }
  await assert.rejects(renameWithRetry('a', 'b', { rename: always, delayMs: 1, retries: 2 }))
  assert.equal(calls, 3)
  await assert.rejects(renameWithRetry('a', 'b', { rename: async () => { throw Object.assign(new Error('no'), { code: 'ENOENT' }) } }))
})

test('atomicWrite：建父目录、覆盖、不留临时文件', async () => {
  const d = dir()
  const file = join(d, 'x', 'y.md')
  await atomicWrite(file, 'one')
  await atomicWrite(file, 'two')
  assert.equal(readFileSync(file, 'utf8'), 'two')
  mkdirSync(join(d, 'x'), { recursive: true })
  const { readdirSync } = await import('node:fs')
  assert.deepEqual(readdirSync(join(d, 'x')), ['y.md'])
})
