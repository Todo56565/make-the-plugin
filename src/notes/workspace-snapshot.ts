/**
 * workspace.md 修改前快照（设计 0.4.0 决定 9、§8 第 8 步）。
 *
 * - 每次修改 workspace.md 前，把修改前的内容存成 `records/workspace-snapshots/<6 位编号>.md`，不进全文；
 *   修改前为空 / 不存在、或新旧内容相同则不拍；与最新一份快照内容相同也不重拍。
 * - 编号单调递增、永不复用：取「现存最大编号」与 `state/workspace-snapshot-seq.json` 记录的较大者 + 1。
 * - 保留：keep = 0 为「自动」，全部保留；keep = m（≥ 2）时，快照累计到 100 份即按余弦取样只留 m 份（按现存顺序取样，
 *   最旧、最新必留），pinned 里的编号（「自定义」看板勾选）额外保留、不计入 m。
 * - 调用方须已持有 `shared/locks/workspace.md.lock`（NotesStore 写 workspace.md 时持锁调用）。
 */

import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { atomicWrite } from '../context/atomic.ts'
import { workspaceSnapshotPath, zoneDir } from '../context/layout.ts'
import { cosineSample } from './snapshot-sampling.ts'

/** 累计到这么多份时精简。 */
export const WORKSPACE_SNAPSHOT_PRUNE_AT = 100
const NAME = /^(\d{6,})\.md$/

export interface WorkspaceSnapshotPolicy {
  /** 0 = 自动（全部保留）；否则精简后保留的份数。 */
  keep: number
  /** 额外保留的编号。 */
  pinned?: ReadonlySet<number>
}

function seqStatePath(stateRoot: string): string {
  return join(zoneDir(stateRoot, 'state'), 'workspace-snapshot-seq.json')
}

/** 现存快照编号，升序。 */
export async function listWorkspaceSnapshots(stateRoot: string): Promise<number[]> {
  let names: string[]
  try {
    names = await readdir(dirname(workspaceSnapshotPath(stateRoot, 1)))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  return names.map(n => NAME.exec(n)).filter(m => m !== null).map(m => Number(m![1])).sort((a, b) => a - b)
}

async function lastSeq(stateRoot: string): Promise<number> {
  try {
    const v = (JSON.parse(await readFile(seqStatePath(stateRoot), 'utf8')) as { last?: unknown }).last
    return typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : 0
  } catch {
    return 0
  }
}

/** 精简后应保留的编号（纯逻辑）。未到阈值或 keep = 0 时全部保留。 */
export function keptAfterPrune(existing: readonly number[], policy: WorkspaceSnapshotPolicy): number[] {
  if (policy.keep <= 0 || existing.length < WORKSPACE_SNAPSHOT_PRUNE_AT) return [...existing]
  const keep = new Set(cosineSample(existing.length, Math.max(2, policy.keep)).map(i => existing[i - 1]!))
  for (const n of existing) if (policy.pinned?.has(n) === true) keep.add(n)
  return existing.filter(n => keep.has(n))
}

/**
 * 拍一份修改前快照（必要时精简）。返回新快照编号；未拍返回 undefined。
 * @param before 修改前内容（undefined = 文件不存在）
 * @param after 即将写入的内容
 */
export async function snapshotWorkspaceBefore(stateRoot: string, before: string | undefined, after: string, policy: WorkspaceSnapshotPolicy): Promise<number | undefined> {
  if (before === undefined || before === '' || before === after) return undefined
  const existing = await listWorkspaceSnapshots(stateRoot)
  const newest = existing[existing.length - 1]
  if (newest !== undefined) {
    try {
      if (await readFile(workspaceSnapshotPath(stateRoot, newest), 'utf8') === before) return undefined
    } catch { /* 读不到就照常拍 */ }
  }
  const seq = Math.max(newest ?? 0, await lastSeq(stateRoot)) + 1
  const file = workspaceSnapshotPath(stateRoot, seq)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, before, { encoding: 'utf8', flag: 'wx' })
  await atomicWrite(seqStatePath(stateRoot), `${JSON.stringify({ last: seq })}\n`)
  const all = [...existing, seq]
  const kept = new Set(keptAfterPrune(all, policy))
  for (const n of all) if (!kept.has(n)) await rm(workspaceSnapshotPath(stateRoot, n), { force: true })
  return seq
}
