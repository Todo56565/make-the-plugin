/**
 * 预算提示文本（runtime context，缓存分支 B）。
 *
 * 文本只在跨档时变化，未达阈值时为空串（空 context 不贡献内容）。
 */

export interface ReminderInput {
  /** 当前档位（整数百分比）。 */
  bucket: number
  /** 主动压缩阈值（比例）。 */
  compactAtRatio: number
  /** notes 能力是否开启。 */
  notes: boolean
}

export function reminderText(input: ReminderInput): string {
  const compactAt = Math.round(input.compactAtRatio * 100)
  const lines = [
    `【上下文预算】本会话上下文已用约 ${input.bucket}%，达到约 ${compactAt}% 时会自动压缩，之前的原始消息将被摘要替换。`,
  ]
  if (input.notes) {
    lines.push('请现在用 team_notes 记下当前进度、关键结论和下一步，压缩后可据此继续。')
  }
  return lines.join('\n')
}
