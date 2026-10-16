/**
 * context_new_window 工具（设计 0.3.0 §7-1、§7-2、§9a-3；描述参照 Codex `new_context`）。
 *
 * 无参数。工具本身只记录「本窗口请求换窗」并立即返回，下一步组装时由插件换窗：
 * 工具执行时本步的工具调用还没配对完成，不能在这里压缩（PoC-3）。
 * 本窗口没写过自己的笔记时拒绝一次（每窗口一次），第二次放行。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const NEW_WINDOW_TOOL = 'context_new_window'

export const NEW_WINDOW_REFUSED = '本窗口还没写自己的笔记：先用 team_notes 记笔记再调；笔记满了就用 write 整篇精简重写。'
export const NEW_WINDOW_ACCEPTED = '已请求换窗：下一步开始前换到新窗口。'

export interface NewWindowDeps {
  /** 处理一次调用：返回是否放行；非团队会话抛错。 */
  request: (agent: Agent) => 'accept' | 'refuse'
}

export function registerNewWindowTool(ctx: Context, deps: NewWindowDeps): () => void {
  return ctx.tools.register(defineTool({
    name: NEW_WINDOW_TOOL,
    description: '开始一个新的上下文窗口，不影响任务和文件状态。',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(_args, exec) {
      const agent = exec.agent
      if (agent === undefined) throw new Error(`${NEW_WINDOW_TOOL} 需要调用方 agent`)
      return { text: deps.request(agent) === 'accept' ? NEW_WINDOW_ACCEPTED : NEW_WINDOW_REFUSED }
    },
  }))
}
