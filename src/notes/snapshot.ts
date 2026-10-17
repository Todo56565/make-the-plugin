/**
 * 成员笔记快照（设计 0.4.0 决定 8、§8 第 5 步）。
 *
 * - 换窗时、任务终态时各拍一份；与该 attempt 最新一份内容相同则不重拍；
 * - 位置：`records/teams/nanmi/<teamId>@<代>/<taskId>/a<attempt>/<seq>-<hash8>.md`，只读、只追加；
 * - 文件名不含 fileKey；归属与来源坐标记在同目录 `meta.jsonl`，每行一份快照：
 *   `{ schema, file, fileKey, ref: "<sessionId>/w<n>/e<seq>", reason, at, bytes, hash }`。
 * 同一 attempt 目录内串行（进程内），保证序号连续。
 */

import { createHash } from 'node:crypto'
import { appendFile, mkdir, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { attemptSnapshotDir, snapshotFileName } from '../context/layout.ts'
import { atomicWrite } from '../context/atomic.ts'
import { readFileSync } from 'node:fs'
import type { TeamIdentity } from '../team/identity.ts'
import { notesRootOf, ownNotePath, physicalNotePath } from './paths.ts'

export const SNAPSHOT_META_FILE = 'meta.jsonl'
export const SNAPSHOT_META_SCHEMA = 1

export type SnapshotReason = 'window' | 'terminal'

export interface SnapshotRequest {
  stateRoot: string
  teamId: string
  createdAt: number
  taskId: string
  attempt: number
  fileKey: string
  /** 笔记全文（拍照时刻读到的内容）。 */
  content: string
  /** 来源坐标 `<sessionId>/w<n>/e<seq>`。 */
  ref: string
  reason: SnapshotReason
  at?: number
}

export interface SnapshotMeta {
  schema: number
  file: string
  fileKey: string
  ref: string
  reason: SnapshotReason
  at: number
  bytes: number
  hash: string
}

export type SnapshotResult =
  | { created: true; dir: string; meta: SnapshotMeta }
  | { created: false; dir: string; file: string }

const NAME = /^(\d+)-([0-9a-f]{8})\.md$/

export function contentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

/** 来源坐标 `<sessionId>/w<n>/e<seq>`。 */
export function sessionRef(sessionId: string, window: number, seq: number): string {
  return `${sessionId}/w${window}/e${seq}`
}

async function latest(dir: string): Promise<{ seq: number; file: string; hash8: string } | undefined> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  let best: { seq: number; file: string; hash8: string } | undefined
  for (const name of names) {
    const m = NAME.exec(name)
    if (m === null) continue
    const seq = Number(m[1])
    if (best === undefined || seq > best.seq) best = { seq, file: name, hash8: m[2]! }
  }
  return best
}

const chains = new Map<string, Promise<unknown>>()

/** 拍一份快照；内容与最新一份相同时不重拍。 */
export function takeSnapshot(req: SnapshotRequest): Promise<SnapshotResult> {
  const dir = attemptSnapshotDir(req.stateRoot, req.teamId, req.createdAt, req.taskId, req.attempt)
  const prior = chains.get(dir) ?? Promise.resolve()
  const run = prior.catch(() => undefined).then(() => snapshotNow(dir, req))
  chains.set(dir, run)
  void run.finally(() => {
    if (chains.get(dir) === run) chains.delete(dir)
  }).catch(() => undefined)
  return run
}

async function snapshotNow(dir: string, req: SnapshotRequest): Promise<SnapshotResult> {
  const hash = contentHash(req.content)
  const last = await latest(dir)
  if (last !== undefined && last.hash8 === hash.slice(0, 8)) {
    const previous = await readFile(join(dir, last.file), 'utf8').catch(() => undefined)
    if (previous === req.content) return { created: false, dir, file: last.file }
  }
  const file = snapshotFileName((last?.seq ?? 0) + 1, hash)
  await mkdir(dir, { recursive: true })
  await atomicWrite(join(dir, file), req.content)
  const meta: SnapshotMeta = {
    schema: SNAPSHOT_META_SCHEMA,
    file,
    fileKey: req.fileKey,
    ref: req.ref,
    reason: req.reason,
    at: req.at ?? Date.now(),
    bytes: Buffer.byteLength(req.content),
    hash,
  }
  await appendFile(join(dir, SNAPSHOT_META_FILE), `${JSON.stringify(meta)}\n`, 'utf8')
  return { created: true, dir, meta }
}

/** 读某 attempt 的快照元数据（全文条目挂快照时用）；坏行跳过。 */
export async function readSnapshotMetas(stateRoot: string, teamId: string, createdAt: number, taskId: string, attempt: number): Promise<SnapshotMeta[]> {
  const dir = attemptSnapshotDir(stateRoot, teamId, createdAt, taskId, attempt)
  let text: string
  try {
    text = await readFile(join(dir, SNAPSHOT_META_FILE), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const metas: SnapshotMeta[] = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      metas.push(JSON.parse(line) as SnapshotMeta)
    } catch { /* 坏行跳过 */ }
  }
  return metas
}

const TERMINAL = new Set(['completed', 'failed', 'cancelled'])

/**
 * 换窗时给成员拍快照：对每个分给自己、尚未终态的任务（按其当前 attempt）各拍一份。
 * 同步读取笔记内容（固定拍照时刻），写入异步；队长、笔记不存在或为空时不拍。
 */
export function snapshotOnWindowSwitch(identity: TeamIdentity, ref: string, at = Date.now()): Promise<SnapshotResult>[] {
  if (identity.role !== 'member') return []
  const tasks = identity.team.tasks.filter(t => t.assignee === identity.agentKey && !TERMINAL.has(t.status))
  if (tasks.length === 0) return []
  let content: string
  try {
    const rel = physicalNotePath(ownNotePath(identity.team.id, identity.fileKey), identity.team)
    content = readFileSync(join(notesRootOf(identity.stateRoot), ...rel.split('/')), 'utf8')
  } catch {
    return []
  }
  if (content === '') return []
  return tasks.map(task => takeSnapshot({
    stateRoot: identity.stateRoot,
    teamId: identity.team.id,
    createdAt: identity.team.createdAt,
    taskId: task.id,
    attempt: task.attempt,
    fileKey: identity.fileKey,
    content,
    ref,
    reason: 'window',
    at,
  }))
}
