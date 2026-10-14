/**
 * 只读解析 agent-teams 的 team.json（磁盘格式见 dsh-agent-teams@0.1.23 `src/types.ts`）。
 *
 * agent-teams 没有公共 API，本插件只读取它需要的字段，并对缺字段保持宽容：
 * 任何不符合预期的内容都视为「不是团队」，绝不抛到 prompt 组装里。
 */

import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** 本插件用到的成员字段。 */
export interface TeamMemberInfo {
  /** 持久子代理会话 id（未派生时为空串）。 */
  id: string
  /** 团队内唯一的成员名。 */
  name: string
}

/** 本插件用到的任务字段（用于 notes hint）。 */
export interface TeamTaskInfo {
  id: string
  subject: string
  status: string
  assignee?: string
}

/** 本插件用到的团队字段。 */
export interface TeamInfo {
  /** 目录 id（团队的稳定身份）。 */
  id: string
  name: string
  captainSessionId: string
  members: TeamMemberInfo[]
  tasks: TeamTaskInfo[]
}

/** agent-teams 的队长键（`state.ts` CAPTAIN_KEY）。 */
export const CAPTAIN_KEY = 'captain'

const MAX_KEY_LENGTH = 48

/** 与 agent-teams `sanitizeKey` 同规则，把成员名转成安全的文件名。 */
export function sanitizeKey(name: string): string {
  const cleaned = name.normalize('NFC').trim().toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
  if (cleaned === '') return `k-${keyDigest(name)}`
  const points = [...cleaned]
  if (points.length > MAX_KEY_LENGTH) return `${points.slice(0, MAX_KEY_LENGTH).join('')}-${keyDigest(name)}`
  return cleaned
}

function keyDigest(name: string): string {
  return createHash('sha256').update(name).digest('hex').slice(0, 8)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 把 JSON 值收窄为 TeamInfo；不合格返回 undefined。 */
export function coerceTeam(value: unknown, dirId: string): TeamInfo | undefined {
  if (!isRecord(value)) return undefined
  if (typeof value.captainSessionId !== 'string' || !Array.isArray(value.members)) return undefined
  const members: TeamMemberInfo[] = []
  for (const raw of value.members) {
    if (!isRecord(raw) || typeof raw.name !== 'string') continue
    members.push({ id: typeof raw.id === 'string' ? raw.id : '', name: raw.name })
  }
  const tasks: TeamTaskInfo[] = []
  for (const raw of Array.isArray(value.tasks) ? value.tasks : []) {
    if (!isRecord(raw) || typeof raw.id !== 'string' || typeof raw.subject !== 'string') continue
    tasks.push({
      id: raw.id,
      subject: raw.subject,
      status: typeof raw.status === 'string' ? raw.status : 'unknown',
      ...(typeof raw.assignee === 'string' ? { assignee: raw.assignee } : {}),
    })
  }
  return {
    id: typeof value.id === 'string' && value.id !== '' ? value.id : dirId,
    name: typeof value.name === 'string' ? value.name : dirId,
    captainSessionId: value.captainSessionId,
    members,
    tasks,
  }
}

/** 读取一个团队目录的 team.json；文件不存在返回 undefined，其余错误抛出。 */
export function readTeamFile(stateRoot: string, dirId: string): TeamInfo | undefined {
  let raw: string
  try {
    raw = readFileSync(join(stateRoot, dirId, 'team.json'), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR') return undefined
    throw error
  }
  const text = raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw
  return coerceTeam(JSON.parse(text), dirId)
}

/**
 * 列出 stateRoot 下的所有活动团队。
 * 跳过 `archive`（agent-teams 归档目录）与以 `.` 开头的目录（本插件的 `.context`）。
 */
export function listTeams(stateRoot: string): TeamInfo[] {
  let entries
  try {
    entries = readdirSync(stateRoot, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const teams: TeamInfo[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === 'archive' || entry.name.startsWith('.')) continue
    const team = readTeamFile(stateRoot, entry.name)
    if (team !== undefined) teams.push(team)
  }
  return teams
}
