/**
 * 布局迁移（设计 0.4.0 §2.4）。
 *
 * 版本 1（0.3.0，无 layout.json）：`notes/teams/<teamId>/<fileKey>.md`
 * 版本 2（0.4.0）：`notes/teams/nanmi/<teamId>@<代>/<fileKey>.md`
 *
 * 规则：
 * - 活动团队的旧目录按 team.json 的 createdAt 搬到新目录；新目录已有同名文件时保留新的、丢弃旧的
 * - 没有对应活动团队的旧目录直接删除（2026-10-17 用户决定：0.3.0 期间的团队都是测试数据）
 * - 先搬后删，最后写 layout.json；中途失败下次重跑（每步都可重复执行）
 * - 同步执行：身份解析与 prompt 组装是同步路径
 */

import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { BACKEND_NANMI, LAYOUT_VERSION, layoutPath, notesTeamDir, zoneDir, type LayoutFile } from './layout.ts'
import { listTeams, type TeamInfo } from '../team/team-file.ts'

function readLayoutSync(stateRoot: string): LayoutFile | undefined {
  try {
    const value = JSON.parse(readFileSync(layoutPath(stateRoot), 'utf8')) as Partial<LayoutFile>
    if (typeof value.version !== 'number' || !Number.isInteger(value.version)) return undefined
    return { version: value.version, migrations: Array.isArray(value.migrations) ? value.migrations : [] }
  } catch {
    return undefined
  }
}

/** 版本 1 → 2。返回搬迁与删除的目录数（测试用）。 */
export function migrateV1toV2(stateRoot: string, teams: readonly TeamInfo[]): { moved: number; removed: number } {
  const legacyRoot = join(zoneDir(stateRoot, 'notes'), 'teams')
  let moved = 0
  let removed = 0
  let entries
  try {
    entries = readdirSync(legacyRoot, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { moved, removed }
    throw error
  }
  const active = new Map(teams.map(team => [team.id, team]))
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === BACKEND_NANMI) continue
    const source = join(legacyRoot, entry.name)
    const team = active.get(entry.name)
    if (team !== undefined) {
      const target = notesTeamDir(stateRoot, team.id, team.createdAt)
      mkdirSync(target, { recursive: true })
      for (const file of readdirSync(source)) {
        const to = join(target, file)
        if (!existsSync(to)) renameSync(join(source, file), to)
      }
      moved += 1
    } else {
      removed += 1
    }
    rmSync(source, { recursive: true, force: true })
  }
  return { moved, removed }
}

const done = new Set<string>()

/** 确保布局为当前版本；同一进程内每个状态根只检查一次。失败抛出，下次调用重试。 */
export function ensureLayoutSync(stateRoot: string, now: () => number = Date.now): void {
  if (done.has(stateRoot)) return
  const layout = readLayoutSync(stateRoot)
  const version = layout?.version ?? 1
  if (version < LAYOUT_VERSION) {
    const migrations = layout?.migrations ?? []
    if (version < 2) {
      migrateV1toV2(stateRoot, listTeams(stateRoot))
      migrations.push({ from: 1, to: 2, at: now() })
    }
    mkdirSync(join(stateRoot, '.context'), { recursive: true })
    const tmp = `${layoutPath(stateRoot)}.${process.pid}.tmp`
    writeFileSync(tmp, `${JSON.stringify({ version: LAYOUT_VERSION, migrations }, null, 2)}\n`)
    renameSync(tmp, layoutPath(stateRoot))
  }
  done.add(stateRoot)
}

/** 测试用：清空进程内记忆。 */
export function resetLayoutMemo(): void {
  done.clear()
}
