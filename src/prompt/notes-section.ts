/**
 * notes 稳定指针（system section，缓存分支 B）。
 *
 * 文本只依赖 (teamId, agentKey)：每个 agent 首次得到团队身份后冻结，之后不再变化，
 * 避免改写 system 前缀破坏缓存。
 */

import type { TeamIdentity } from '../team/identity.ts'
import { ownNotePath } from '../notes/paths.ts'

/** 紧随 TEAM_POLICY(600)。 */
export const NOTES_SECTION_ORDER = 620

export function notesSectionText(identity: TeamIdentity): string {
  const own = ownNotePath(identity.team.id, identity.fileKey)
  const lines = [
    '## 团队笔记',
    `你的笔记文件：${own}；工作区共享笔记：workspace.md。用 team_notes 工具读写。`,
    '上下文会在接近预算时被压缩，压缩后早先的原始消息只剩摘要。请在关键节点把进度、结论、决定和下一步记进自己的笔记；压缩后先读笔记再继续。',
    '另外记下：任务的约束与用户要求；继续工作所需的关键数据与引用（确切路径、命令、报错、数字）。写明哪些已验证、哪些只是推测。不必套固定格式，保持精简。',
  ]
  lines.push(identity.role === 'captain'
    ? '你是队长，负责维护 workspace.md：汇总各成员笔记中对全队有用的结论。'
    : 'workspace.md 由队长汇总维护；你主要写自己的笔记，可读本团队所有笔记。')
  return lines.join('\n')
}

/** 每 agent 冻结一次的文本缓存。 */
export class FrozenText {
  private readonly values = new Map<string, string>()

  get(agentId: string, compute: () => string | undefined): string {
    const prior = this.values.get(agentId)
    if (prior !== undefined) return prior
    const value = compute()
    if (value === undefined || value === '') return ''
    this.values.set(agentId, value)
    return value
  }

  forget(agentId: string): void {
    this.values.delete(agentId)
  }
}
