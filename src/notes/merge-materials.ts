/**
 * 合并材料的上下文窗口保险（设计 0.4.0 §4.1、§4.2）。纯函数，不读文件。
 *
 * 超出预算时依次：
 * 1. 材料 b（历史快照）从中间开始整份丢弃，最旧一份保留；只剩最旧一份仍放不下时截取其开头并标注，再放不下则丢弃；
 * 2. 丢弃材料 a（近期任务记录）；
 * 3. 待合并笔记从最晚的开始少喂（至少留一条；少喂的条目留在清单里下次再合）。
 * 体积按字节计；token 与字节的换算由调用方给出预算时完成。
 */

export interface SnapshotMaterial { seq: number; content: string }

export interface MaterialSet<N> {
  notes: N[]
  recent: string
  snapshots: SnapshotMaterial[]
}

export const TRUNCATED_NOTE = '\n（此份快照过长，只保留开头）\n'

/** 下一份要丢的：正中间那份（不会是最旧的 0 号）。 */
function middleIndex(length: number): number {
  return Math.max(1, Math.floor(length / 2))
}

export function fitMaterials<N>(set: MaterialSet<N>, sizeOf: (note: N) => number, fixedBytes: number, budgetBytes: number | undefined): MaterialSet<N> {
  if (budgetBytes === undefined) return set
  const notes = [...set.notes]
  let recent = set.recent
  const snapshots = [...set.snapshots]
  const total = () => fixedBytes + Buffer.byteLength(recent)
    + notes.reduce((s, n) => s + sizeOf(n), 0)
    + snapshots.reduce((s, x) => s + Buffer.byteLength(x.content), 0)
  while (total() > budgetBytes && snapshots.length > 1) snapshots.splice(middleIndex(snapshots.length), 1)
  if (total() > budgetBytes && snapshots.length === 1) {
    const room = budgetBytes - (total() - Buffer.byteLength(snapshots[0]!.content)) - Buffer.byteLength(TRUNCATED_NOTE)
    if (room > 0) {
      const head = Buffer.from(snapshots[0]!.content).subarray(0, room).toString('utf8').replace(/\uFFFD+$/, '')
      snapshots[0] = { seq: snapshots[0]!.seq, content: head + TRUNCATED_NOTE }
    } else snapshots.length = 0
  }
  if (total() > budgetBytes) recent = ''
  while (total() > budgetBytes && notes.length > 1) notes.pop()
  return { notes, recent, snapshots }
}

/** token 预算换算为字节：按每 token 至多 2 字节保守估计（中文约 3 字节 / token，英文约 4）。 */
export function tokensToBytes(tokens: number): number {
  return Math.max(0, Math.floor(tokens * 2))
}
