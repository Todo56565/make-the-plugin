/**
 * 笔记虚拟路径（设计 §4.2.1）。
 *
 * 根目录：`<stateRoot>/.context/notes/`
 * - `workspace.md`                   共享层（同工作区所有团队共享）
 * - `teams/<teamId>/<fileKey>.md`    每成员原始层（队长 fileKey = captain）
 *
 * 模型只看到虚拟路径；禁止绝对路径、`..`、反斜杠与其他目录。
 */

import { join } from 'node:path'

export const WORKSPACE_NOTE = 'workspace.md'

/** 笔记根目录。 */
export function notesRootOf(stateRoot: string): string {
  return join(stateRoot, '.context', 'notes')
}

/** 某成员自己的笔记虚拟路径。 */
export function ownNotePath(teamId: string, fileKey: string): string {
  return `teams/${teamId}/${fileKey}.md`
}

export interface NoteScope {
  teamId: string
  fileKey: string
}

export type NotePathResult =
  | { ok: true; path: string; own: boolean; shared: boolean }
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
  if (raw === '' || raw === 'self') return { ok: true, path: own, own: true, shared: false }
  if (raw.includes('\\') || raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) {
    return { ok: false, error: `路径必须是笔记虚拟路径，不能是绝对路径：${raw}` }
  }
  const parts = raw.split('/')
  if (parts.some(p => p === '' || p === '.' || p === '..' || !SEGMENT.test(p))) {
    return { ok: false, error: `非法路径：${raw}` }
  }
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
  return { ok: true, path, own: path === own, shared: path === WORKSPACE_NOTE }
}
