/**
 * 换窗压缩（设计 §2.4 方案 D1；0.3.0 §1-1、§9a-8）。
 *
 * - 经 `ctx.agentPresets.serviceFor(agent, 'compaction')` 取该 agent 所在 preset 的压缩引擎，
 *   调用 `compactIfNeeded(agent, 'context-overflow', signal)`：不保留最近原文
 * - 接管引擎的 `summarize()`：团队会话直接返回【交接】文本，不发任何摘要请求；
 *   compaction-basic 每次经 `regionDependencies()` 动态取 `this.summarize`，
 *   所以插件主动换窗、宿主约 80% 自动压缩、手动 /compact 都走接管后的方法（PoC-5）
 * - `serviceFor()` 每次返回新的 cordis 代理，WeakSet 认不出同一实例：接管标记写在实例上（经代理转发到目标）
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type { CompactionEngine } from '@deepseek-ai/dsh-compaction'

/** 每会话的尝试记录：同一窗口同一原因只尝试一次，失败后不每步重试。 */
export class CompactionGate {
  private readonly attempted = new Map<string, string>()
  private readonly running = new Set<string>()

  canAttempt(sessionId: string, key: string): boolean {
    return !this.running.has(sessionId) && this.attempted.get(sessionId) !== key
  }

  isRunning(sessionId: string): boolean {
    return this.running.has(sessionId)
  }

  begin(sessionId: string, key: string): void {
    this.attempted.set(sessionId, key)
    this.running.add(sessionId)
  }

  end(sessionId: string): void {
    this.running.delete(sessionId)
  }
}

/** 取 agent 所在 preset 的压缩引擎；无 preset 或未装压缩时返回 undefined。 */
export function compactionEngineOf(ctx: Context, agent: { ctx: Context }): CompactionEngine | undefined {
  try {
    return ctx.agentPresets.serviceFor(agent, 'compaction')
  } catch {
    return undefined
  }
}

/** 摘要块（compaction-basic summarize() 的返回形状）。 */
export interface SummaryResult {
  summary: Array<{ type: 'text'; text: string }>
  provider: string
  model: string
}

/** 接管处理器：返回交接文本；返回 undefined 表示不是团队会话，走原方法。 */
export type SummaryOverride = (owner: Agent) => string | undefined

type Summarize = (input: unknown, owner: Agent, signal?: AbortSignal) => Promise<unknown>

const PATCHED = Symbol.for('dsh-token-budget.summarize.patched')
const HANDLER = Symbol.for('dsh-token-budget.summarize.handler')

interface Patchable {
  summarize: Summarize
  [PATCHED]?: true
  [HANDLER]?: SummaryOverride
}

/**
 * 确保引擎的 summarize() 已被接管，并把处理器换成当前插件实例的（插件重载后旧闭包不再生效）。
 * 返回 true 表示这次才打上接管。
 */
export function takeOverSummarize(engine: CompactionEngine, override: SummaryOverride): boolean {
  const target = engine as unknown as Patchable
  target[HANDLER] = override
  if (target[PATCHED] === true) return false
  if (typeof target.summarize !== 'function') return false
  target[PATCHED] = true
  const original = target.summarize.bind(engine) as Summarize
  // 实例属性遮蔽原型方法
  target.summarize = async (input, owner, signal) => {
    const handler = target[HANDLER]
    const text = handler === undefined ? undefined : handler(owner)
    if (text === undefined) return original(input, owner, signal)
    const config = (owner.session as { requestHeader?: () => { config?: { provider?: string; model?: string } } | undefined }).requestHeader?.()?.config
    const result: SummaryResult = {
      summary: [{ type: 'text', text }],
      provider: config?.provider ?? 'dsh-token-budget',
      model: config?.model ?? 'handoff-template',
    }
    return result
  }
  return true
}

/** 插件卸载时调用：处理器清空后，被接管的引擎一律走原方法。 */
export function releaseSummarize(engine: CompactionEngine): void {
  delete (engine as unknown as Patchable)[HANDLER]
}
