/**
 * 笔记虚拟路径（设计 §4.2.1）。
 *
 * 根目录：`<stateRoot>/.context/notes/`
 * - `workspace.md`                   共享层（同工作区所有团队共享）
 * - `teams/<teamId>/<fileKey>.md`    每成员原始层（队长 fileKey = captain）
 *
 * - `records/…`                      仅插件写的永久记录（只读，设计 0.4.0 §5）：
 *   `records/full/<卷>`、`records/workspace-snapshots/<份>`、`records/teams/<本团队 teamId>/…`
 *
 * 以上是模型看到的虚拟路径；团队笔记的物理位置是 `teams/nanmi/<teamId>@<代>/<fileKey>.md`
 * （设计 0.4.0 §2.4），由 physicalNotePath 映射。禁止绝对路径、`..`、反斜杠与其他目录。
 */

import { join } from 'node:path'
import { BACKEND_NANMI, teamGenKey } from '../context/layout.ts'

export const WORKSPACE_NOTE = 'workspace.md'

/** 笔记根目录。 */
export function notesRootOf(stateRoot: string): string {
  return join(stateRoot, '.context', 'notes')
}

/** 某成员自己的笔记虚拟路径。 */
export function ownNotePath(teamId: string, fileKey: string): string {
  return `teams/${teamId}/${fileKey}.md`
}

/** 笔记所属团队的一代。 */
export interface NoteTeam {
  id: string
  createdAt: number
}

export const RECORDS_PREFIX = 'records/'

/** 团队级虚拟路径 `teams/<teamId>/<rest>` → 物理 `teams/nanmi/<teamId>@<代>/<rest>`；其他原样。 */
function mapTeamPath(path: string, team: NoteTeam | undefined): string {
  if (team === undefined) return path
  const prefix = `teams/${team.id}/`
  if (!path.startsWith(prefix)) return path
  return `teams/${BACKEND_NANMI}/${teamGenKey(team.id, team.createdAt)}/${path.slice(prefix.length)}`
}

/**
 * 虚拟路径 → 相对笔记根的物理路径。只映射本团队的 `teams/<teamId>/…`；
 * `records/…` 映射到与笔记根同级的 records 区（结果以 `../records/` 开头）。
 */
export function physicalNotePath(path: string, team: NoteTeam | undefined): string {
  if (path.startsWith(RECORDS_PREFIX)) return `../records/${mapTeamPath(path.slice(RECORDS_PREFIX.length), team)}`
  return mapTeamPath(path, team)
}

export interface NoteScope {
  teamId: string
  fileKey: string
}

export type NotePathResult =
  | { ok: true; path: string; own: boolean; shared: boolean; record: boolean }
  | { ok: false; error: string }

const SEGMENT = /^[^/\\\0]+$/

/**
 * 解析模型给的路径。
 * - 省略 / 空 / `self` ⇒ 自己的笔记
 * - `workspace.md` ⇒ 共享笔记
 * - `<name>.md` ⇒ 本团队 `teams/<teamId>/<name>.md`
 * - `teams/<teamId>/<name>.md` ⇒ 仅限本团队
 */
export function resolveNotePath(input: string | undefined, scope: NoteScope): NotePathResult {
  const own = ownNotePath(scope.teamId, scope.fileKey)
  const raw = (input ?? '').trim()
  if (raw === '' || raw === 'self') return { ok: true, path: own, own: true, shared: false, record: false }
  if (raw.includes('\\') || raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) {
    return { ok: false, error: `路径必须是笔记虚拟路径，不能是绝对路径：${raw}` }
  }
  const parts = raw.split('/')
  if (parts.some(p => p === '' || p === '.' || p === '..' || !SEGMENT.test(p))) {
    return { ok: false, error: `非法路径：${raw}` }
  }
  if (parts[0] === 'records') return resolveRecordPath(raw, parts, scope)
  let path: string
  if (parts.length === 1) {
    path = parts[0] === WORKSPACE_NOTE ? WORKSPACE_NOTE : `teams/${scope.teamId}/${parts[0]}`
  } else if (parts.length === 3 && parts[0] === 'teams') {
    if (parts[1] !== scope.teamId) return { ok: false, error: `只能访问本团队（${scope.teamId}）的笔记` }
    path = raw
  } else {
    return { ok: false, error: `非法路径：${raw}（可用：workspace.md、<成员>.md、teams/${scope.teamId}/<成员>.md）` }
  }
  if (!path.endsWith('.md')) return { ok: false, error: `笔记文件必须以 .md 结尾：${raw}` }
  return { ok: true, path, own: path === own, shared: path === WORKSPACE_NOTE, record: false }
}

/** `records/full/<f>`、`records/workspace-snapshots/<f>`、`records/teams/<本团队>/…`（至少一层）。 */
function resolveRecordPath(raw: string, parts: string[], scope: NoteScope): NotePathResult {
  const hint = `可用：records/full/<卷>、records/workspace-snapshots/<份>、records/teams/${scope.teamId}/…`
  const area = parts[1]
  if ((area === 'full' || area === 'workspace-snapshots') && parts.length === 3) {
    return { ok: true, path: raw, own: false, shared: false, record: true }
  }
  if (area === 'teams' && parts.length >= 4) {
    if (parts[2] !== scope.teamId) return { ok: false, error: `只能读本团队（${scope.teamId}）的记录` }
    return { ok: true, path: raw, own: false, shared: false, record: true }
  }
  return { ok: false, error: `非法路径：${raw}（${hint}）` }
}
