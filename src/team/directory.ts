/**
 * 团队身份缓存。
 *
 * prompt 的 `text()` 在每次组装时同步执行，不能每次都扫磁盘，所以按会话缓存：
 * - 任意 `agent-teams/*` 会话事件（建团、增删成员、任务变化……）⇒ 清空全部缓存；
 * - 「不是团队」的结果只缓存短时间（成员会话可能先于 team.json 写入而创建）。
 */

import { resolveIdentity, type TeamIdentity } from './identity.ts'

/** 本插件需要的 agent 形状（与 dsh-agent 的 Agent 结构兼容）。 */
export interface AgentLike {
  readonly id: string
  readonly session: { readonly header: { readonly cwd?: string } }
}

interface Entry {
  identity: TeamIdentity | undefined
  at: number
}

export class TeamDirectory {
  private readonly entries = new Map<string, Entry>()

  private readonly stateDir: string
  private readonly warn: (message: string) => void
  private readonly negativeTtlMs: number
  private readonly now: () => number

  constructor(stateDir: string, warn: (message: string) => void, negativeTtlMs = 5_000, now: () => number = Date.now) {
    this.stateDir = stateDir
    this.warn = warn
    this.negativeTtlMs = negativeTtlMs
    this.now = now
  }

  /** 该 agent 的团队身份；不是团队会话返回 undefined。 */
  identityOf(agent: AgentLike): TeamIdentity | undefined {
    const cached = this.entries.get(agent.id)
    const now = this.now()
    if (cached !== undefined && (cached.identity !== undefined || now - cached.at < this.negativeTtlMs)) {
      return cached.identity
    }
    const identity = resolveIdentity({
      cwd: agent.session.header.cwd,
      stateDir: this.stateDir,
      sessionId: agent.id,
      warn: this.warn,
    })
    this.entries.set(agent.id, { identity, at: now })
    return identity
  }

  /** 团队状态可能已变化：丢弃全部缓存。 */
  invalidate(): void {
    this.entries.clear()
  }

  /** 会话结束时释放。 */
  forget(sessionId: string): void {
    this.entries.delete(sessionId)
  }
}

/** 会话事件类型是否来自 agent-teams。 */
export function isTeamEvent(type: string): boolean {
  return type.startsWith('agent-teams/')
}
