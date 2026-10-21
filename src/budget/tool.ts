/**
 * context_remaining 工具（设计 §4.1）：只读调用者自身会话的上下文余量。
 *
 * 与 Codex get_context_remaining 一致，不能指定其他会话。
 * P、W 与宿主同源（tokenMeter / contextPressure）；压缩触发点按本插件 compactAtRatio 镜像估算，标 estimated。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Usage } from './usage.ts'

export const CONTEXT_REMAINING_TOOL = 'context_remaining'

export interface ContextRemaining {
  pressure: number | null
  contextWindow: number | null
  usedRatio: number | null
  /** 预计自动压缩的 token 数（W × compactAtRatio）。 */
  estimatedTrigger: number | null
  /** 距离预计压缩点还剩多少 token（不小于 0）。 */
  remaining: number | null
  estimated: true
  reason?: string
}

/** 纯逻辑：把占用换算成工具返回值。 */
export function contextRemainingOf(usage: Usage | undefined, compactAtRatio: number): ContextRemaining {
  if (usage === undefined) {
    return { pressure: null, contextWindow: null, usedRatio: null, estimatedTrigger: null, remaining: null, estimated: true, reason: '当前路由未声明上下文容量，或计量暂不可用' }
  }
  const estimatedTrigger = Math.floor(usage.contextWindow * compactAtRatio)
  return {
    pressure: usage.pressure,
    contextWindow: usage.contextWindow,
    usedRatio: Math.round(usage.ratio * 1000) / 1000,
    estimatedTrigger,
    remaining: Math.max(0, estimatedTrigger - usage.pressure),
    estimated: true,
  }
}

export function renderContextRemaining(value: ContextRemaining): string {
  if (value.remaining === null) return `无法估算剩余上下文：${value.reason ?? '未知原因'}`
  const pct = ((value.usedRatio ?? 0) * 100).toFixed(1)
  return `上下文已用 ${value.pressure} / ${value.contextWindow} token（约 ${pct}%）。预计约 ${value.estimatedTrigger} token 时自动压缩，还剩约 ${value.remaining} token（估算值）。`
}

export interface ContextToolDeps {
  /** 本插件对该会话生效：普通会话、队长、成员（子会话非成员不生效）。 */
  isActive: (agent: Agent) => boolean
  usage: (agent: Agent) => Usage | undefined
  compactAtRatio: () => number
}

export function registerContextRemainingTool(ctx: Context, deps: ContextToolDeps): () => void {
  return ctx.tools.register(defineTool({
    name: CONTEXT_REMAINING_TOOL,
    description: '查询你自己会话的上下文已用量、预计自动压缩点和剩余 token（估算）。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { text: { type: 'string', required: true } },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      const agent = exec.agent
      if (agent === undefined) throw new Error('context_remaining 需要调用方 agent')
      if (!deps.isActive(agent)) throw new Error('子会话不能使用 context_remaining')
      return { text: renderContextRemaining(contextRemainingOf(deps.usage(agent), deps.compactAtRatio())) }
    },
  }))
}
