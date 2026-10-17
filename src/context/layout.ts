/**
 * `.context` 目录布局（设计 0.4.0 §2.2–2.4）。
 *
 * ```
 * <stateRoot>/.context/
 *   layout.json
 *   notes/      模型经 team_notes 写
 *   shared/     跨插件协议区
 *   records/    仅插件写，只追加，永久
 *   state/      可删、自动重建
 *   ext/<插件>/ 其他插件自留地
 * ```
 *
 * 这里只算路径，不碰文件（layout.json 读写除外）。
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { atomicWrite } from './atomic.ts'

/** 当前布局版本。0.3.0 的布局（无 layout.json）视为 1。 */
export const LAYOUT_VERSION = 2
/** 本插件支持的团队后端（NanmiCoder/dsh-agent-teams）。 */
export const BACKEND_NANMI = 'nanmi'

export type Zone = 'notes' | 'shared' | 'records' | 'state' | 'ext'

/** `<stateRoot>/.context` */
export function contextRootOf(stateRoot: string): string {
  return join(stateRoot, '.context')
}

export function zoneDir(stateRoot: string, zone: Zone): string {
  return join(contextRootOf(stateRoot), zone)
}

/** 团队「代」：team.json 的 createdAt（毫秒）转 base36，约 8 位。 */
export function generationOf(createdAt: number): string {
  if (!Number.isSafeInteger(createdAt) || createdAt < 0) throw new Error(`非法 createdAt：${createdAt}`)
  return createdAt.toString(36)
}

/** `<teamId>@<代>` */
export function teamGenKey(teamId: string, createdAt: number): string {
  return `${teamId}@${generationOf(createdAt)}`
}

/** 解析 `<teamId>@<代>`；不合格返回 undefined。 */
export function parseTeamGenKey(name: string): { teamId: string; generation: string; createdAt: number } | undefined {
  const at = name.lastIndexOf('@')
  if (at < 1 || at === name.length - 1) return undefined
  const generation = name.slice(at + 1)
  if (!/^[0-9a-z]+$/.test(generation)) return undefined
  const createdAt = Number.parseInt(generation, 36)
  if (!Number.isSafeInteger(createdAt)) return undefined
  return { teamId: name.slice(0, at), generation, createdAt }
}

/** 在用笔记的团队代目录：`notes/teams/nanmi/<teamId>@<代>/` */
export function notesTeamDir(stateRoot: string, teamId: string, createdAt: number): string {
  return join(zoneDir(stateRoot, 'notes'), 'teams', BACKEND_NANMI, teamGenKey(teamId, createdAt))
}

/** 永久记录的团队代目录：`records/teams/nanmi/<teamId>@<代>/` */
export function recordsTeamDir(stateRoot: string, teamId: string, createdAt: number): string {
  return join(zoneDir(stateRoot, 'records'), 'teams', BACKEND_NANMI, teamGenKey(teamId, createdAt))
}

/** 某 attempt 的成员笔记快照目录：`…/<taskId>/a<attempt>/` */
export function attemptSnapshotDir(stateRoot: string, teamId: string, createdAt: number, taskId: string, attempt: number): string {
  return join(recordsTeamDir(stateRoot, teamId, createdAt), taskId, `a${attempt}`)
}

/** 快照文件名：`<seq>-<hash8>.md`，seq 补零到 3 位。 */
export function snapshotFileName(seq: number, hash: string): string {
  return `${String(seq).padStart(3, '0')}-${hash.slice(0, 8)}.md`
}

/** 全文分卷：`records/full/0001.md` */
export function fullVolumePath(stateRoot: string, volume: number): string {
  return join(zoneDir(stateRoot, 'records'), 'full', `${String(volume).padStart(4, '0')}.md`)
}

/** workspace.md 修改前快照：`records/workspace-snapshots/000001.md` */
export function workspaceSnapshotPath(stateRoot: string, seq: number): string {
  return join(zoneDir(stateRoot, 'records'), 'workspace-snapshots', `${String(seq).padStart(6, '0')}.md`)
}

/** 待合并清单目录（全部团队代，合并流程扫它就是全局队列）：`shared/pending/nanmi/` */
export function pendingDir(stateRoot: string): string {
  return join(zoneDir(stateRoot, 'shared'), 'pending', BACKEND_NANMI)
}

/** 某团队代的待合并清单（物理）：`shared/pending/nanmi/<teamId>@<代>.jsonl` */
export function pendingPath(stateRoot: string, teamId: string, createdAt: number): string {
  return join(pendingDir(stateRoot), `${teamGenKey(teamId, createdAt)}.jsonl`)
}

/** 跨插件锁：`shared/locks/<name>.lock` */
export function lockPath(stateRoot: string, name: string): string {
  return join(zoneDir(stateRoot, 'shared'), 'locks', `${name}.lock`)
}

/** 全文游标（可重建缓存）：`state/full-cursor.json` */
export function fullCursorPath(stateRoot: string): string {
  return join(zoneDir(stateRoot, 'state'), 'full-cursor.json')
}

/** 会话级运行状态：`state/sessions/<sessionId>.json` */
export function sessionStatePath(stateRoot: string, sessionId: string): string {
  return join(zoneDir(stateRoot, 'state'), 'sessions', `${sessionId}.json`)
}

/** 其他插件自留地：`ext/<plugin>/` */
export function extDir(stateRoot: string, plugin: string): string {
  return join(zoneDir(stateRoot, 'ext'), plugin)
}

export interface LayoutMigration {
  from: number
  to: number
  /** 完成时间（毫秒）。 */
  at: number
}

export interface LayoutFile {
  version: number
  migrations: LayoutMigration[]
}

export function layoutPath(stateRoot: string): string {
  return join(contextRootOf(stateRoot), 'layout.json')
}

/** 读 layout.json；不存在或损坏返回 undefined（调用方按版本 1 处理）。 */
export async function readLayout(stateRoot: string): Promise<LayoutFile | undefined> {
  try {
    const value = JSON.parse(await readFile(layoutPath(stateRoot), 'utf8')) as Partial<LayoutFile>
    if (typeof value.version !== 'number' || !Number.isInteger(value.version)) return undefined
    return { version: value.version, migrations: Array.isArray(value.migrations) ? value.migrations : [] }
  } catch {
    return undefined
  }
}

export async function writeLayout(stateRoot: string, layout: LayoutFile): Promise<void> {
  await atomicWrite(layoutPath(stateRoot), `${JSON.stringify(layout, null, 2)}\n`)
}
