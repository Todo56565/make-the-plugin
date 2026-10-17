/**
 * team_notes read 的行范围（设计 0.4.0 §5）。纯函数。
 *
 * - 行号从 1 起，start/stop 均含；
 * - 上限由设置 readMaxBytes 决定（默认 {@link READ_MAX_BYTES}）；
 * - 不给范围且文件超过上限：只返回末尾若干整行，附总行数与分段读提示；
 * - 给了范围但结果仍超上限：从 start 起截到上限，提示下一段的起始行。
 */

export const READ_MAX_BYTES = 24_000

function splitLines(text: string): string[] {
  const lines = text.split('\n')
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

export function sliceForRead(path: string, text: string, start?: number, stop?: number, maxBytes: number = READ_MAX_BYTES): string {
  const lines = splitLines(text)
  const total = lines.length
  if (start === undefined && stop === undefined) {
    if (Buffer.byteLength(text) <= maxBytes) return text
    let bytes = 0
    let from = total
    while (from > 0) {
      const size = Buffer.byteLength(lines[from - 1]!) + 1
      if (bytes + size > maxBytes && from < total) break
      bytes += size
      from -= 1
    }
    return `（${path} 共 ${total} 行，过大，以下为第 ${from + 1}–${total} 行；用 start_line / stop_line 分段读）\n${lines.slice(from).join('\n')}`
  }
  const a = Math.max(1, Math.floor(start ?? 1))
  const b = Math.min(total, Math.floor(stop ?? total))
  if (a > total) return `（${path} 共 ${total} 行，start_line ${a} 超出范围）`
  if (b < a) return `（${path} 共 ${total} 行，stop_line 小于 start_line）`
  const out: string[] = []
  let bytes = 0
  let i = a
  for (; i <= b; i++) {
    const size = Buffer.byteLength(lines[i - 1]!) + 1
    if (bytes + size > maxBytes && out.length > 0) break
    out.push(lines[i - 1]!)
    bytes += size
  }
  const last = i - 1
  const more = last < b ? `；超过单次上限，下一段从第 ${last + 1} 行起` : ''
  return `（${path} 第 ${a}–${last} 行，共 ${total} 行${more}）\n${out.join('\n')}`
}
