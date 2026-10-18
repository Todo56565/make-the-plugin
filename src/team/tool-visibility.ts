/**
 * 普通子会话隐藏本插件工具（0.5.0 E1）。
 *
 * 只看直接父会话：父会话是某个活动团队的队长（captainSessionId）就保留，
 * 子会话本身是成员也保留；其余子代理会话隐藏。不追祖先链、不处理 fork。
 */

import type { TeamInfo } from './team-file.ts'

/** 本模块用到的会话头字段。 */
export interface HeaderLike {
  readonly parentSession?: string
  readonly origin?: string
  readonly delegationDepth?: number
}

/** 纯函数：该会话是否隐藏本插件工具。 */
export function shouldHideTools(child: { id: string; header: HeaderLike }, teams: readonly TeamInfo[]): boolean {
  const { parentSession, origin, delegationDepth } = child.header
  if (parentSession === undefined) return false
  if (origin !== 'subagent' && (delegationDepth ?? 0) === 0) return false
  if (teams.some(team => team.members.some(member => member.id === child.id))) return false
  return !teams.some(team => team.captainSessionId === parentSession)
}
