/**
 * 待合并清单（设计 0.4.0 决定 10–12、§5、§8 第 7 步）。
 *
 * - 按团队代分文件：物理 `shared/pending/nanmi/<teamId>@<代>.jsonl`，模型看到虚拟 `workspace.pending.md`（映射到本队当前代，由本模块渲染）；
 *   合并流程扫整个 `shared/pending/nanmi/` 目录即全局队列（listPendingTeams）；结束代整个文件随代处理（第 10 步）；
 * - 每行一条：`{ schema, id, key, teamId, createdAt, teamName, taskId, subject, attempt, member, status, snapshot, ref, at }`；
 *   `id` 为短 id（`p` + 唯一键 SHA-256 前 6 位十六进制，撞了再加长），`key` 即全文唯一键 `<teamId>@<代>:<taskId>:<attempt>`；
 * - 只有插件新增（任务终态时，与全文条目同时）；队长 / 合并流程只能按 id 删除既有行，不能改、不能加；其他 Agent 只读；
 * - 新增是追加；删除是锁内读出 + 原子重写。两者都持该团队代的跨进程锁 `shared/locks/pending-<teamId>@<代>.lock`。
 * - 坏行、未知 schema 的行读取时跳过，删除重写时原样保留（不丢别人的数据）。
 */

import { createHash } from 'node:crypto'
import { appendFile, mkdir, readdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { atomicWrite } from '../context/atomic.ts'
import { lockPath, parseTeamGenKey, pendingDir, pendingPath, teamGenKey } from '../context/layout.ts'
import { withFileLock } from '../context/lock.ts'

export const PENDING_SCHEMA = 1
export const PENDING_NOTE = 'workspace.pending.md'

export interface PendingEntry {
  schema: typeof PENDING_SCHEMA
  id: string
  key: string
  teamId: string
  createdAt: number
  teamName: string
  taskId: string
  subject: string
  attempt: number
  member: string
  status: string
  /** 成员笔记快照的 records/… 虚拟路径（该 attempt 最新一份）。 */
  snapshot: string
  /** 成员会话坐标 `<sessionId>/w<n>/e<seq>`（可能只有会话 id）。 */
  ref: string
  at: number
}

export type NewPendingEntry = Omit<PendingEntry, 'schema' | 'id' | 'teamId' | 'createdAt'>

/** 团队的一代。 */
export interface PendingTeam { id: string; createdAt: number }

const fileOf = (stateRoot: string, team: PendingTeam) => pendingPath(stateRoot, team.id, team.createdAt)
const lockOf = (stateRoot: string, team: PendingTeam) => lockPath(stateRoot, `pending-${teamGenKey(team.id, team.createdAt)}`)

interface Line { raw: string; entry?: PendingEntry }

function isEntry(value: unknown): value is PendingEntry {
  const v = value as Partial<PendingEntry> | null
  return typeof v === 'object' && v !== null && v.schema === PENDING_SCHEMA
    && typeof v.id === 'string' && typeof v.key === 'string' && typeof v.teamId === 'string'
    && typeof v.createdAt === 'number' && typeof v.taskId === 'string' && typeof v.snapshot === 'string'
}

async function readLines(file: string): Promise<Line[]> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const lines: Line[] = []
  for (const raw of text.split('\n')) {
    if (raw.trim() === '') continue
    let entry: PendingEntry | undefined
    try {
      const parsed: unknown = JSON.parse(raw)
      if (isEntry(parsed)) entry = parsed
    } catch { /* 坏行：保留原文，读取时跳过 */ }
    lines.push(entry === undefined ? { raw } : { raw, entry })
  }
  return lines
}

/** 读某团队代的清单（跳过坏行），按写入顺序。 */
export async function readPending(stateRoot: string, team: PendingTeam): Promise<PendingEntry[]> {
  return (await readLines(fileOf(stateRoot, team))).flatMap(l => l.entry === undefined ? [] : [l.entry])
}

/** 全局队列：有清单文件的全部团队代（不区分在用 / 结束）。 */
export async function listPendingTeams(stateRoot: string): Promise<PendingTeam[]> {
  let names: string[]
  try {
    names = await readdir(pendingDir(stateRoot))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  return names.flatMap(name => {
    if (!name.endsWith('.jsonl')) return []
    const parsed = parseTeamGenKey(name.slice(0, -'.jsonl'.length))
    return parsed === undefined ? [] : [{ id: parsed.teamId, createdAt: parsed.createdAt }]
  }).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
}

/** 由唯一键生成短 id，避开已占用的 id。 */
export function pendingId(key: string, taken: ReadonlySet<string> = new Set()): string {
  const hex = createHash('sha256').update(key).digest('hex')
  for (let n = 6; n <= hex.length; n += 2) {
    const id = `p${hex.slice(0, n)}`
    if (!taken.has(id)) return id
  }
  throw new Error(`无法为 ${key} 生成短 id`)
}

/** 插件新增条目；同一 key 已在清单里则跳过。返回实际新增的条目。 */
export function addPending(stateRoot: string, team: PendingTeam, items: readonly NewPendingEntry[]): Promise<PendingEntry[]> {
  if (items.length === 0) return Promise.resolve([])
  return withFileLock(lockOf(stateRoot, team), async () => {
    const existing = await readPending(stateRoot, team)
    const keys = new Set(existing.map(e => e.key))
    const ids = new Set(existing.map(e => e.id))
    const added: PendingEntry[] = []
    for (const item of items) {
      if (keys.has(item.key)) continue
      const entry: PendingEntry = { schema: PENDING_SCHEMA, id: pendingId(item.key, ids), teamId: team.id, createdAt: team.createdAt, ...item }
      keys.add(entry.key)
      ids.add(entry.id)
      added.push(entry)
    }
    if (added.length > 0) {
      const file = fileOf(stateRoot, team)
      await mkdir(dirname(file), { recursive: true })
      await appendFile(file, added.map(e => `${JSON.stringify(e)}\n`).join(''), 'utf8')
    }
    return added
  })
}

export interface ResolveResult {
  removed: PendingEntry[]
  /** 清单里没有的 id。 */
  missing: string[]
}

/** 按 id 删除某团队代清单的既有行（只删，不改不加）；不存在的 id 不影响其余 id。 */
export function resolvePending(stateRoot: string, team: PendingTeam, ids: readonly string[]): Promise<ResolveResult> {
  const wanted = [...new Set(ids.map(id => id.trim()).filter(id => id !== ''))]
  return withFileLock(lockOf(stateRoot, team), async () => {
    const lines = await readLines(fileOf(stateRoot, team))
    const byId = new Map(lines.flatMap(l => l.entry === undefined ? [] : [[l.entry.id, l.entry] as const]))
    const result: ResolveResult = { removed: [], missing: [] }
    const drop = new Set<string>()
    for (const id of wanted) {
      const entry = byId.get(id)
      if (entry === undefined) result.missing.push(id)
      else { drop.add(id); result.removed.push(entry) }
    }
    if (drop.size > 0) {
      const kept = lines.filter(l => l.entry === undefined || !drop.has(l.entry.id)).map(l => `${l.raw}\n`).join('')
      await atomicWrite(fileOf(stateRoot, team), kept)
    }
    return result
  })
}

/** 解析模型给的 id 列表（逗号 / 空白分隔）。 */
export function parseIds(input: string | undefined): string[] {
  return (input ?? '').split(/[\s,，、]+/).map(s => s.trim()).filter(s => s !== '')
}

function stamp(at: number): string {
  return new Date(at).toISOString().slice(0, 16).replace('T', ' ') + 'Z'
}

/** 渲染虚拟 `workspace.pending.md`（本队当前代的清单）。 */
export function renderPending(entries: readonly PendingEntry[]): string {
  const lines = [`${PENDING_NOTE}：待合并成员笔记 ${entries.length} 条（插件维护，只读；队长处理后用 team_notes resolve 按 id 删除）`]
  if (entries.length === 0) lines.push('（没有待合并条目）')
  for (const e of entries) {
    lines.push(`- ${e.id} · ${e.taskId}「${e.subject}」· ${e.member} · ${e.status} · ${stamp(e.at)} · ${e.snapshot}${e.ref === '' ? '' : ` · ${e.ref}`}`)
  }
  return lines.join('\n')
}

/** 合并流程用：按全文唯一键删除条目（合并成功后由插件删，模型不参与）。返回是否删到。 */
export async function resolvePendingByKey(stateRoot: string, team: PendingTeam, key: string): Promise<boolean> {
  const entry = (await readPending(stateRoot, team)).find(e => e.key === key)
  if (entry === undefined) return false
  return (await resolvePending(stateRoot, team, [entry.id])).removed.length > 0
}
