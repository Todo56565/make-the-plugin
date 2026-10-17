/**
 * 跨进程、跨插件的文件锁（设计 0.4.0 §2.4）。
 *
 * - 锁文件用 `open(..., 'wx')` 独占创建，内容为 `{ pid, time, token }`
 * - 锁存在时间超过 staleMs 视为持有者已崩溃，可接管（删除后重抢）
 * - 释放时只删除自己持有的锁（比对 token），避免误删接管者的锁
 * - 等待超过 timeoutMs 抛 LockTimeoutError
 *
 * 其他插件（如未来的常驻合并助手）写 `workspace.md` 必须使用同一锁文件与同一格式。
 */

import { mkdir, open, readFile, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

export class LockTimeoutError extends Error {}

export interface LockOptions {
  /** 判定锁过期的时长，默认 30 秒。 */
  staleMs?: number
  /** 最长等待，默认 10 秒。 */
  timeoutMs?: number
  /** 轮询间隔，默认 50 毫秒。 */
  retryMs?: number
  /** 测试注入。 */
  now?: () => number
}

export interface LockRecord {
  pid: number
  time: number
  token: string
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

async function readLock(path: string): Promise<LockRecord | undefined> {
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as Partial<LockRecord>
    if (typeof value.pid === 'number' && typeof value.time === 'number' && typeof value.token === 'string') return value as LockRecord
    return undefined
  } catch {
    return undefined
  }
}

/** 尝试获取一次；成功返回 token。 */
async function tryAcquire(path: string, now: number): Promise<string | undefined> {
  const token = randomUUID()
  let handle
  try {
    handle = await open(path, 'wx')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return undefined
    throw error
  }
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid, time: now, token } satisfies LockRecord))
  } finally {
    await handle.close()
  }
  return token
}

/** 持锁执行 fn。 */
export async function withFileLock<T>(path: string, fn: () => Promise<T>, options: LockOptions = {}): Promise<T> {
  const staleMs = options.staleMs ?? 30_000
  const timeoutMs = options.timeoutMs ?? 10_000
  const retryMs = options.retryMs ?? 50
  const now = options.now ?? Date.now
  await mkdir(dirname(path), { recursive: true })
  const deadline = now() + timeoutMs
  let token: string | undefined
  for (;;) {
    token = await tryAcquire(path, now())
    if (token !== undefined) break
    const held = await readLock(path)
    // 内容不完整（持有者刚创建、尚未写完）时不接管，等下一轮。
    if (held !== undefined && now() - held.time > staleMs) {
      await rm(path, { force: true })
      continue
    }
    if (now() >= deadline) throw new LockTimeoutError(`等待锁超时：${path}`)
    await sleep(retryMs)
  }
  try {
    return await fn()
  } finally {
    const current = await readLock(path)
    if (current?.token === token) await rm(path, { force: true })
  }
}
