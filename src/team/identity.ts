/**
 * 会话 → 团队身份解析（设计 §4.0.1）。
 *
 * - 队长：`team.captainSessionId === sessionId`，agentKey = `captain`
 * - 成员：`team.members[].id === sessionId`，agentKey = 成员名
 * - v1 不复刻 agent-teams 的 fork 祖先链（fork 后代按非团队处理）
 * - 命中多个团队视为无团队并告警
 * - 任何读/解析异常都当作非团队会话，只告警
 */

import { join } from 'node:path'
import { CAPTAIN_KEY, listTeams, sanitizeKey, type TeamInfo } from './team-file.ts'

export type TeamRole = 'captain' | 'member'

export interface TeamIdentity {
  role: TeamRole
  /** 团队快照（解析时刻）。 */
  team: TeamInfo
  /** 团队内身份键：队长为 `captain`，成员为成员名。 */
  agentKey: string
  /** agentKey 的文件安全形式。 */
  fileKey: string
  /** agent-teams 状态根目录：`<cwd>/<stateDir>`。 */
  stateRoot: string
}

/** 状态根目录：与 agent-teams 一致，用会话头 cwd（不是后来切换的工作目录）。 */
export function stateRootOf(cwd: string | undefined, stateDir: string): string {
  return join(cwd ?? process.cwd(), stateDir)
}

/** 在团队列表中查找某会话的身份；歧义时返回 'ambiguous'。 */
export function matchIdentity(teams: readonly TeamInfo[], sessionId: string): { role: TeamRole; team: TeamInfo; agentKey: string } | 'ambiguous' | undefined {
  let found: { role: TeamRole; team: TeamInfo; agentKey: string } | undefined
  for (const team of teams) {
    let hit: { role: TeamRole; team: TeamInfo; agentKey: string } | undefined
    if (team.captainSessionId === sessionId) {
      hit = { role: 'captain', team, agentKey: CAPTAIN_KEY }
    } else {
      const member = team.members.find(m => m.id !== '' && m.id === sessionId)
      if (member !== undefined) hit = { role: 'member', team, agentKey: member.name }
    }
    if (hit === undefined) continue
    if (found !== undefined) return 'ambiguous'
    found = hit
  }
  return found
}

export interface ResolveOptions {
  cwd: string | undefined
  stateDir: string
  sessionId: string
  warn: (message: string) => void
}

/** 同步解析团队身份；失败一律返回 undefined。 */
export function resolveIdentity(options: ResolveOptions): TeamIdentity | undefined {
  const stateRoot = stateRootOf(options.cwd, options.stateDir)
  let teams: TeamInfo[]
  try {
    teams = listTeams(stateRoot)
  } catch (error) {
    options.warn(`读取团队状态失败（${stateRoot}）：${String(error)}`)
    return undefined
  }
  const match = matchIdentity(teams, options.sessionId)
  if (match === 'ambiguous') {
    options.warn(`会话 ${options.sessionId} 同时属于多个团队，按非团队会话处理`)
    return undefined
  }
  if (match === undefined) return undefined
  return { ...match, fileKey: match.role === 'captain' ? CAPTAIN_KEY : sanitizeKey(match.agentKey), stateRoot }
}
