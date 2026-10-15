/**
 * 历史读取源（设计 §4.4）：经宿主 `sessionPersistence` 只读句柄分页读取本会话日志。
 *
 * - 先 `sessions.flush(session)` 只冲刷本会话（设计 §4.4）；未提供时退回 `persistence.flush()` 全量冲刷，读到的才是最新
 * - `open(id, 'read')` 不抢写锁；读完即关
 * - 只看 `inheritedEventCount` 之后的事件（成员读不到队长继承来的上下文）
 * - 按 `stat().revision` 缓存模型：修订不变直接复用；不落盘、不留第二份数据
 */

import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import { buildHistoryModel, type EventLike, type HistoryModel } from './model.ts'

const PAGE = 500

/** persistence 的最小结构，便于测试替换。 */
export type PersistenceLike = Pick<SessionPersistence, 'open' | 'flush' | 'stat'>

interface Entry { revision: string; model: HistoryModel }

export class HistorySource {
  private readonly cache = new Map<string, Entry>()
  private readonly persistence: () => PersistenceLike | undefined

  constructor(persistence: () => PersistenceLike | undefined) {
    this.persistence = persistence
  }

  /** @param flushSession 冲刷本会话缓冲事件（宿主 `sessions.flush(session)`）；省略时用 `persistence.flush()`。 */
  async load(sessionId: string, signal?: AbortSignal, flushSession?: () => Promise<unknown>): Promise<HistoryModel> {
    const persistence = this.persistence()
    if (persistence === undefined) throw new Error('宿主未提供 sessionPersistence，历史工具不可用')
    try {
      await (flushSession ?? (() => persistence.flush()))()
    } catch {
      // flush 失败不影响读取本会话已落盘部分
    }
    const id = sessionId as Parameters<PersistenceLike['open']>[0]
    const snapshot = await persistence.stat(id, { signal })
    if (snapshot === undefined) throw new Error('本会话尚未持久化，暂无可读历史')
    const revision = String(snapshot.revision)
    const cached = this.cache.get(sessionId)
    if (cached !== undefined && cached.revision === revision) return cached.model

    const handle = await persistence.open(id, 'read')
    try {
      // 宿主类型声明为必填；防御性兜底，避免 undefined → NaN 导致窗口不递增、继承前缀不过滤
      const inherited = Number(handle.inheritedEventCount)
      const minSeq = Number.isFinite(inherited) && inherited > 0 ? inherited : 0
      const events: EventLike[] = []
      for (let offset = 0; ; offset += PAGE) {
        signal?.throwIfAborted()
        const { events: page } = await handle.read(offset, PAGE, { signal })
        for (const event of page) events.push(event as EventLike)
        if (page.length < PAGE) break
      }
      const model = buildHistoryModel(events, minSeq)
      this.cache.set(sessionId, { revision, model })
      return model
    } finally {
      await handle.close()
    }
  }

  forget(sessionId: string): void {
    this.cache.delete(sessionId)
  }
}
