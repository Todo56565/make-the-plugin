/**
 * 原子写（设计 0.4.0 §2.4「锁与原子写」）。
 *
 * 先写同目录临时文件再 rename；Windows 上目标文件被短暂占用时 rename 报 EPERM/EACCES/EBUSY，
 * 按 agent-teams `renameWithRetry` 的做法重试几次。
 */

import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

const RETRYABLE = new Set(['EPERM', 'EACCES', 'EBUSY'])
export const RENAME_RETRIES = 3
export const RENAME_RETRY_DELAY_MS = 50

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

export interface RenameOptions {
  retries?: number
  delayMs?: number
  /** 测试注入。 */
  rename?: (from: string, to: string) => Promise<void>
}

/** rename，遇到可重试错误时重试。 */
export async function renameWithRetry(from: string, to: string, options: RenameOptions = {}): Promise<void> {
  const retries = options.retries ?? RENAME_RETRIES
  const delayMs = options.delayMs ?? RENAME_RETRY_DELAY_MS
  const doRename = options.rename ?? rename
  for (let attempt = 0; ; attempt += 1) {
    try {
      await doRename(from, to)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? ''
      if (RETRYABLE.has(code) && attempt < retries) {
        await sleep(delayMs)
        continue
      }
      throw error
    }
  }
}

/** 原子写入文本文件；父目录不存在时自动创建。 */
export async function atomicWrite(file: string, content: string, options: RenameOptions = {}): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`
  await writeFile(tmp, content, 'utf8')
  try {
    await renameWithRetry(tmp, file, options)
  } catch (error) {
    await rm(tmp, { force: true })
    throw error
  }
}
