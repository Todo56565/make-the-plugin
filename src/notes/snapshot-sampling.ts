/**
 * 快照余弦取样（设计 0.4.0 §4.2、§4.3）。纯函数：输入份数与取样数，输出 1 起的序号；不读文件、不依赖合并流程。
 *
 * 切比雪夫-洛巴托点：x_k = (1 − cos(π·k/(m−1))) / 2，k = 0..m−1；i_k = 1 + round(x_k·(N−1))；去重、升序。
 * 两端密、中间疏，最旧（1）与最新（N）必定入选；N ≤ m 时全取。
 */
export function cosineSample(n: number, m: number): number[] {
  if (!Number.isSafeInteger(n) || n <= 0) return []
  if (!Number.isSafeInteger(m) || m <= 0) return []
  if (n <= m) return Array.from({ length: n }, (_, i) => i + 1)
  if (m === 1) return [n]
  const picked = new Set<number>()
  for (let k = 0; k < m; k++) {
    const x = (1 - Math.cos(Math.PI * k / (m - 1))) / 2
    picked.add(1 + Math.round(x * (n - 1)))
  }
  return [...picked].sort((a, b) => a - b)
}
