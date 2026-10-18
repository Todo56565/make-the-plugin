/**
 * 普通子会话隐藏本插件工具（0.5.0 E1）。
 *
 * 队长身份与 agent-teams `teamLeadMatch`（lineage.js）同口径：等于 captainSessionId，
 * 或顶层会话、祖先链含队长且不含成员。成员从不算队长。
 * 祖先链读不到时返回 undefined，调用方 fail-open（保留工具）。
 */

import type { TeamInfo } from './team-file.ts'

/** 与 agent-teams 一致的祖先链深度上限。 */
export const LINEAGE_MAX_DEPTH = 32

/** 本模块用到的会话头字段。 */
export interface HeaderLike {
  readonly parentSession?: string
  readonly origin?: string
  readonly delegationDepth?: number
}

/** 一个会话的队长判定材料。 */
export interface LeadIdentity {
  sessionId: string
  /** 祖先会话 id，最近的在前。 */
  ancestry: string[]
  /** 顶层会话才能继承祖先的队长身份。 */
  inheritsLead: boolean
}

/** 是否顶层会话（不是子代理）。 */
export function isTopLevel(header: HeaderLike): boolean {
  return header.origin !== 'subagent' && (header.delegationDepth ?? 0) === 0
}

/** 与 agent-teams `teamLeadMatch` 同规则。 */
export function teamLeadMatch(team: TeamInfo, lead: LeadIdentity): boolean {
  if (team.members.some(member => member.id === lead.sessionId)) return false
  if (team.captainSessionId === lead.sessionId) return true
  if (!lead.inheritsLead) return false
  if (team.members.some(member => member.id !== '' && lead.ancestry.includes(member.id))) return false
  return lead.ancestry.includes(team.captainSessionId)
}

/**
 * 会话头查找：找不到或读不了返回 undefined。
 */
export type HeaderLookup = (sessionId: string) => Promise<HeaderLike | undefined>

/** 解析一个会话的队长判定材料；链上任一会话头读不到返回 undefined。 */
export async function resolveLeadIdentity(sessionId: string, lookup: HeaderLookup): Promise<LeadIdentity | undefined> {
  const header = await lookup(sessionId)
  if (header === undefined) return undefined
  const ancestry: string[] = []
  const seen = new Set([sessionId])
  let parent = header.parentSession
  while (parent !== undefined && !seen.has(parent)) {
    if (ancestry.length >= LINEAGE_MAX_DEPTH) return undefined
    seen.add(parent)
    ancestry.push(parent)
    const next = await lookup(parent)
    if (next === undefined) return undefined
    parent = next.parentSession
  }
  return { sessionId, ancestry, inheritsLead: isTopLevel(header) }
}

export interface HideInput {
  child: { id: string; header: HeaderLike }
  /** 父会话的队长判定材料；读不到为 undefined。 */
  parent: LeadIdentity | undefined
  teams: readonly TeamInfo[]
}

/** 纯函数：该会话是否隐藏本插件工具。 */
export function shouldHideTools(input: HideInput): boolean {
  const { child, parent, teams } = input
  if (child.header.parentSession === undefined || isTopLevel(child.header)) return false
  if (teams.some(team => team.members.some(member => member.id === child.id))) return false
  if (parent === undefined) return false
  return !teams.some(team => teamLeadMatch(team, parent))
}
