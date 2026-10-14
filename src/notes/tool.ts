/**
 * team_notes 工具：单工具多 action（list / read / write / append / search）。
 *
 * 读：本团队全部成员笔记 + workspace.md；写：仅自己的笔记 + workspace.md。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { TeamIdentity } from '../team/identity.ts'
import { notesRootOf, ownNotePath, resolveNotePath } from './paths.ts'
import { NotesStore, type NoteMeta } from './store.ts'

export const TEAM_NOTES_TOOL = 'team_notes'

export interface NotesToolDeps {
  identityOf: (agent: Agent) => TeamIdentity | undefined
  storeFor: (identity: TeamIdentity) => NotesStore
  /** search 结果上限。 */
  maxResults: number
  /** 写入后回调（用于失效 hint 等）。 */
  onWrite?: (identity: TeamIdentity, meta: NoteMeta) => void
}

/** 按 stateRoot 复用 NotesStore（同一工作区共用一把进程内锁）。 */
export function createStoreCache(maxFileBytes: () => number): (identity: TeamIdentity) => NotesStore {
  const stores = new Map<string, NotesStore>()
  return (identity) => {
    const root = notesRootOf(identity.stateRoot)
    let store = stores.get(root)
    if (store === undefined) {
      store = new NotesStore(root, maxFileBytes)
      stores.set(root, store)
    }
    return store
  }
}

function formatMeta(meta: NoteMeta): string {
  return `${meta.path}（${meta.lines} 行，${meta.bytes} 字节）`
}

/** 执行一次 team_notes 调用，返回给模型的文本。纯逻辑，便于测试。 */
export async function runTeamNotes(
  args: { action: string; path?: string; content?: string; query?: string },
  identity: TeamIdentity,
  store: NotesStore,
  maxResults: number,
  onWrite?: (meta: NoteMeta) => void,
): Promise<string> {
  const scope = { teamId: identity.team.id, fileKey: identity.fileKey }
  switch (args.action) {
    case 'list': {
      const metas = await store.list(scope.teamId)
      const own = ownNotePath(scope.teamId, scope.fileKey)
      if (metas.length === 0) return `还没有任何笔记。你的笔记：${own}；共享笔记：workspace.md`
      return [`笔记（按修改时间倒序）。你的笔记：${own}`, ...metas.map(m => `- ${formatMeta(m)}`)].join('\n')
    }
    case 'read': {
      const target = resolveNotePath(args.path, scope)
      if (!target.ok) throw new Error(target.error)
      const text = await store.read(target.path)
      if (text === undefined) return `${target.path} 还不存在。`
      return text === '' ? `${target.path} 为空。` : text
    }
    case 'write':
    case 'append': {
      const target = resolveNotePath(args.path, scope)
      if (!target.ok) throw new Error(target.error)
      if (!target.own && !target.shared) throw new Error(`只能写自己的笔记（${ownNotePath(scope.teamId, scope.fileKey)}）或 workspace.md`)
      if (args.content === undefined) throw new Error(`${args.action} 需要 content`)
      const meta = args.action === 'write' ? await store.write(target.path, args.content) : await store.append(target.path, args.content)
      onWrite?.(meta)
      return `已${args.action === 'write' ? '写入' : '追加'} ${formatMeta(meta)}`
    }
    case 'search': {
      const query = args.query ?? ''
      if (query === '') throw new Error('search 需要 query')
      const { hits, truncated } = await store.search(scope.teamId, query, maxResults)
      if (hits.length === 0) return `没有找到「${query}」。`
      const lines = hits.map(h => `${h.path}:${h.line}: ${h.text}`)
      if (truncated) lines.push(`（结果已截断，仅显示前 ${maxResults} 条）`)
      return lines.join('\n')
    }
    default:
      throw new Error(`未知 action：${args.action}`)
  }
}

export function registerTeamNotesTool(ctx: Context, deps: NotesToolDeps): () => void {
  return ctx.tools.register(defineTool({
    name: TEAM_NOTES_TOOL,
    description: [
      'AgentTeams 团队笔记：在上下文压缩后保留进度与结论。笔记存放在磁盘上，压缩不会丢失。',
      'action：list 列出笔记；read 读取；write 全量重写；append 追加；search 区分大小写的字面搜索。',
      'path：省略表示你自己的笔记；workspace.md 为工作区共享笔记；<成员>.md 为本团队某成员的笔记。',
      '只能写自己的笔记和 workspace.md，可以读本团队所有笔记。单个文件有大小上限，超出会被拒绝，请保持精简。',
      '不要把任务契约抄进笔记（以团队任务为准），只记进度、关键结论、决定和下一步。',
    ].join('\n'),
    parameters: {
      action: { type: 'string', enum: ['list', 'read', 'write', 'append', 'search'], required: true, description: '操作' },
      path: { type: 'string', description: '笔记路径；省略表示自己的笔记' },
      content: { type: 'string', description: 'write / append 的内容（Markdown）' },
      query: { type: 'string', description: 'search 的字面字符串（区分大小写）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { text: { type: 'string', required: true } },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    isConcurrencySafe: args => args.action === 'list' || args.action === 'read' || args.action === 'search',
    async execute(args, exec) {
      const agent = exec.agent
      if (agent === undefined) throw new Error('team_notes 需要调用方 agent')
      const identity = deps.identityOf(agent)
      if (identity === undefined) throw new Error('当前会话不属于任何 AgentTeams 团队，team_notes 不可用')
      const store = deps.storeFor(identity)
      const text = await runTeamNotes(args, identity, store, deps.maxResults, meta => deps.onWrite?.(identity, meta))
      return { text }
    },
  }))
}
