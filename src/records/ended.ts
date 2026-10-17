/**
 * 结束代的发现与收尾（设计 0.4.0 §2.4「结束代的发现」、决定 8、§8 第 10 步）。
 *
 * - 发现：不另存「已见团队」；扫 `notes/teams/nanmi/*@*`、`records/teams/nanmi/*@*`、`shared/pending/nanmi/*@*`，
 *   对不上活动 team.json（`<teamId>/team.json` 不存在，或 createdAt 不同）的代即已结束。team.json 存在但读不出
 *   （正在被改写、损坏）时一律当作未知、本次跳过，避免把活动团队的笔记搬走。不依赖 `archive/`。
 * - 收尾（幂等，可重复执行）：
 *   1. 删除没有全文条目的 attempt 快照目录（中途放弃、始终没有终态）；
 *   2. 把在用笔记 `notes/teams/nanmi/<代>/*` 搬入 `records/teams/nanmi/<代>/notes/`；
 *   3. 首次发现时写 `records/teams/nanmi/<代>/ended.json`（结束时间以发现时刻计）；
 *   4. 该代的待合并清单：留给合并流程继续处理（已结束代的条目照样可合并），文件清空后删除；
 *   5. cleanupDays > 0 时，结束超过该天数的代整体删除（records 下该代目录 + 待合并清单）。默认关。
 * - 插件启动后每个状态根第一次出现时补扫一次，之后随全文记录一起执行。
 */

import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rename, rm, rmdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { atomicWrite } from '../context/atomic.ts'
import { BACKEND_NANMI, lockPath, notesTeamDir, parseTeamGenKey, pendingDir, pendingPath, recordsTeamDir, teamGenKey, zoneDir } from '../context/layout.ts'
import { withFileLock } from '../context/lock.ts'
import { readTeamFile } from '../team/team-file.ts'
import { fullEntryKey, scanFullKeys } from './full.ts'

export const ENDED_FILE = 'ended.json'
export const ENDED_SCHEMA = 1
const DAY_MS = 86_400_000

export interface EndedGeneration { teamId: string; createdAt: number }

export interface SweepResult {
  /** 本次判定为已结束的代（`<teamId>@<代>`）。 */
  ended: string[]
  /** 本次首次发现结束的代。 */
  newlyEnded: string[]
  movedNotes: number
  removedAttempts: number
  /** 本次按 cleanupDays 整体删除的代。 */
  purged: string[]
}

export interface SweepOptions {
  now?: number
  /** 0 = 关；否则删除结束超过这么多天的代。 */
  cleanupDays?: number
}

async function names(dir: string, suffix = ''): Promise<string[]> {
  try {
    return (await readdir(dir)).filter(n => n.endsWith(suffix)).map(n => n.slice(0, n.length - suffix.length))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

/** 该代是否已结束；未知（team.json 读不出）返回 undefined。 */
function isEnded(stateRoot: string, gen: EndedGeneration): boolean | undefined {
  try {
    const team = readTeamFile(stateRoot, gen.teamId)
    if (team === undefined) return existsSync(join(stateRoot, gen.teamId, 'team.json')) ? undefined : true
    return team.createdAt !== gen.createdAt
  } catch {
    return undefined
  }
}

/** 列出全部已结束的代（纯发现，不改动文件）。 */
export async function findEndedGenerations(stateRoot: string): Promise<EndedGeneration[]> {
  const keys = new Set([
    ...await names(join(zoneDir(stateRoot, 'notes'), 'teams', BACKEND_NANMI)),
    ...await names(join(zoneDir(stateRoot, 'records'), 'teams', BACKEND_NANMI)),
    ...await names(pendingDir(stateRoot), '.jsonl'),
  ])
  const out: EndedGeneration[] = []
  for (const key of [...keys].sort()) {
    const parsed = parseTeamGenKey(key)
    if (parsed === undefined) continue
    const gen = { teamId: parsed.teamId, createdAt: parsed.createdAt }
    if (isEnded(stateRoot, gen) === true) out.push(gen)
  }
  return out
}

async function readEndedAt(dir: string): Promise<number | undefined> {
  try {
    const v = (JSON.parse(await readFile(join(dir, ENDED_FILE), 'utf8')) as { endedAt?: unknown }).endedAt
    return typeof v === 'number' && Number.isFinite(v) ? v : undefined
  } catch {
    return undefined
  }
}

async function isDir(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

/** 删除没有全文条目的 attempt 目录；返回删除数。 */
async function removeUnrecordedAttempts(dir: string, gen: EndedGeneration, recorded: ReadonlySet<string>): Promise<number> {
  let removed = 0
  for (const taskId of await names(dir)) {
    if (taskId === 'notes') continue
    const taskDir = join(dir, taskId)
    if (!await isDir(taskDir)) continue
    for (const a of await names(taskDir)) {
      const m = /^a(\d+)$/.exec(a)
      if (m === null) continue
      if (recorded.has(fullEntryKey(gen.teamId, gen.createdAt, taskId, Number(m[1])))) continue
      await rm(join(taskDir, a), { recursive: true, force: true })
      removed++
    }
    await rmdir(taskDir).catch(() => undefined)
  }
  return removed
}

/** 在用笔记搬入 records/…/notes/；返回搬动文件数。 */
async function moveNotes(stateRoot: string, gen: EndedGeneration): Promise<number> {
  const from = notesTeamDir(stateRoot, gen.teamId, gen.createdAt)
  const files = await names(from)
  if (files.length === 0) {
    await rmdir(from).catch(() => undefined)
    return 0
  }
  const to = join(recordsTeamDir(stateRoot, gen.teamId, gen.createdAt), 'notes')
  await mkdir(to, { recursive: true })
  let moved = 0
  for (const name of files) {
    await rename(join(from, name), join(to, name))
    moved++
  }
  await rmdir(from).catch(() => undefined)
  return moved
}

/** 清空的待合并清单文件删除（持该代的锁）。 */
async function dropEmptyPending(stateRoot: string, gen: EndedGeneration, purge: boolean): Promise<void> {
  const file = pendingPath(stateRoot, gen.teamId, gen.createdAt)
  if (!existsSync(file)) return
  await withFileLock(lockPath(stateRoot, `pending-${teamGenKey(gen.teamId, gen.createdAt)}`), async () => {
    const text = await readFile(file, 'utf8').catch(() => undefined)
    if (text !== undefined && (purge || text.trim() === '')) await rm(file, { force: true })
  })
}

/** 扫描并收尾全部已结束的代。 */
export async function sweepEndedGenerations(stateRoot: string, options: SweepOptions = {}): Promise<SweepResult> {
  const now = options.now ?? Date.now()
  const days = options.cleanupDays ?? 0
  const result: SweepResult = { ended: [], newlyEnded: [], movedNotes: 0, removedAttempts: 0, purged: [] }
  const ended = await findEndedGenerations(stateRoot)
  if (ended.length === 0) return result
  const recorded = await scanFullKeys(stateRoot)
  for (const gen of ended) {
    const key = teamGenKey(gen.teamId, gen.createdAt)
    result.ended.push(key)
    const dir = recordsTeamDir(stateRoot, gen.teamId, gen.createdAt)
    result.removedAttempts += await removeUnrecordedAttempts(dir, gen, recorded)
    result.movedNotes += await moveNotes(stateRoot, gen)
    let endedAt = await readEndedAt(dir)
    if (endedAt === undefined) {
      endedAt = now
      await mkdir(dir, { recursive: true })
      await atomicWrite(join(dir, ENDED_FILE), `${JSON.stringify({ schema: ENDED_SCHEMA, teamId: gen.teamId, createdAt: gen.createdAt, endedAt })}\n`)
      result.newlyEnded.push(key)
    }
    const purge = days > 0 && now - endedAt > days * DAY_MS
    await dropEmptyPending(stateRoot, gen, purge)
    if (purge) {
      await rm(dir, { recursive: true, force: true })
      result.purged.push(key)
    }
  }
  return result
}

/** records 区总占用（字节），供设置页显示。 */
export async function recordsUsageBytes(stateRoot: string): Promise<number> {
  const walk = async (dir: string): Promise<number> => {
    let total = 0
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return 0
    }
    for (const e of entries) {
      const p = join(dir, e.name)
      if (e.isDirectory()) total += await walk(p)
      else if (e.isFile()) total += (await stat(p)).size
    }
    return total
  }
  return walk(zoneDir(stateRoot, 'records'))
}
