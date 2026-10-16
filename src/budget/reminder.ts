/**
 * 预算提醒与兜底提示文本（runtime context，设计 0.3.0 §2、§7-4、§9a-2）。
 *
 * 文本只在跨档或进入兜底时变化，未达档位为空串（空 context 不贡献内容）。
 * 规则性说明在常驻 section 里（notes-section.ts），这里只给用量和动作。
 */

import { NEW_WINDOW_TOOL } from '../window/new-window-tool.ts'

export interface MemberReminderInput {
  /** 当前档位（整数百分比）。 */
  level: number
  /** 是否是本窗口第一档（只有第一档说明换窗工具）。 */
  first: boolean
  /** 换窗点（比例）。 */
  compactAtRatio: number
  /** notes 能力是否开启。 */
  notes: boolean
}

/** 成员提醒：第一档说明 context_new_window，之后只催记笔记、换窗。 */
export function memberReminderText(input: MemberReminderInput): string {
  const compactAt = Math.round(input.compactAtRatio * 100)
  if (input.first) {
    const lines = [`【上下文预算】本窗口上下文已用约 ${input.level}%，到约 ${compactAt}% 时会换到新窗口，早先的原始消息不再在上下文中。`]
    lines.push(input.notes
      ? `现在用 team_notes 把进展记进自己的笔记；记完可以调用 ${NEW_WINDOW_TOOL} 自己换窗，不必等到 ${compactAt}%。`
      : `需要时可以调用 ${NEW_WINDOW_TOOL} 自己换窗，不必等到 ${compactAt}%。`)
    return lines.join('\n')
  }
  return input.notes
    ? `【上下文预算】本窗口上下文已用约 ${input.level}%（约 ${compactAt}% 换窗）。尽快记笔记，然后调用 ${NEW_WINDOW_TOOL} 换窗。`
    : `【上下文预算】本窗口上下文已用约 ${input.level}%（约 ${compactAt}% 换窗）。请尽快调用 ${NEW_WINDOW_TOOL} 换窗。`
}

/** 队长提醒：只说明可以记笔记并换窗，不催促（设计 0.3.0 §7-4）。 */
export function captainReminderText(level: number, notes: boolean): string {
  return notes
    ? `【上下文预算】本窗口上下文已用约 ${level}%。方便时可以把要点记进笔记，再调用 ${NEW_WINDOW_TOOL} 换到新窗口；不换也可以继续工作。`
    : `【上下文预算】本窗口上下文已用约 ${level}%。方便时可以调用 ${NEW_WINDOW_TOOL} 换到新窗口；不换也可以继续工作。`
}

/** 成员兜底提示（对齐 Codex auto_compact_fallback_prompt；不限制工具）。 */
export const FALLBACK_PROMPT = [
  '【上下文已用尽】本窗口上下文已到上限。不要继续任务，不要给最终答复；新窗口不会自动带上本窗口的内容。',
  '现在把进展一次性写进你自己的笔记（尽量只调用一次 team_notes）：目标、决定、进展、经验、下一步，以及仍在处理的请求在哪个窗口、用什么关键词能搜到。',
  `写完立即调用 ${NEW_WINDOW_TOOL}。`,
].join('\n')
