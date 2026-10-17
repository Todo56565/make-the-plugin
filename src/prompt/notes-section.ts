/**
 * 常驻说明（system section，设计 0.3.0 §4）：只放规则，不放路径和状态。
 *
 * 路径、任务、窗口等状态在【交接】里（handoff.ts）。文本只依赖角色与能力开关，
 * 每个会话首次得到团队身份后冻结，之后不再变化，避免改写 system 前缀破坏缓存。
 */

import type { TeamRole } from '../team/identity.ts'

/** 紧随 TEAM_POLICY(600)。 */
export const NOTES_SECTION_ORDER = 620

export interface SectionSwitches {
  notes: boolean
  history: boolean
}

export function notesSectionText(role: TeamRole, switches: SectionSwitches): string {
  const lines = [
    switches.notes ? '## 团队笔记与换窗' : '## 换窗',
    '上下文接近预算时会换到新窗口，早先的原始消息不再在上下文中；新窗口开头的【交接】列出你的身份、任务、笔记位置和回看工具。',
  ]
  if (switches.notes) {
    lines.push('边做边用 team_notes 记进自己的笔记：进度、结论、决定、下一步；任务约束与用户要求；关键数据与引用（确切路径、命令、报错、数字）；仍在处理的请求在哪个窗口、用什么关键词能搜到。写明哪些已验证、哪些是推测。保持精简，不要抄任务契约。')
    lines.push(switches.history ? '换窗后先读自己的笔记，缺的细节再用 history_* 回看。' : '换窗后先读自己的笔记。')
    lines.push(`笔记${switches.history ? '和历史' : ''}是内部工作记录，不要在对外回复里提起。`)
    lines.push(role === 'captain'
      ? '你负责维护 workspace.md：汇总各成员笔记中对全队有用的结论。'
      : 'workspace.md 由队长或合并模型维护，你不能写；把结论写进自己的笔记，可读本团队所有笔记。')
  } else if (switches.history) {
    lines.push('换窗后缺的细节用 history_* 回看；历史是内部工作记录，不要在对外回复里提起。')
  }
  return lines.join('\n')
}

/** 每会话冻结一次的文本缓存（键里带上影响文本的开关）。 */
export class FrozenText {
  private readonly values = new Map<string, string>()

  get(key: string, compute: () => string | undefined): string {
    const prior = this.values.get(key)
    if (prior !== undefined) return prior
    const value = compute()
    if (value === undefined || value === '') return ''
    this.values.set(key, value)
    return value
  }

  forget(key: string): void {
    this.values.delete(key)
  }
}
