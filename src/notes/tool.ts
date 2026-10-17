/**
 * team_notes 工具：单工具多 action（list / read / write / append / search）。
 *
 * 读：本团队全部成员笔记 + workspace.md；写：自己的笔记；workspace.md 只有队长能写（设计 0.4.0 §1-3，成员在工具层拒绝）。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { TeamIdentity } from '../team/identity.ts'
import { notesRootOf, ownNotePath, resolveNotePath } from './paths.ts'
import { NotesStore, type NoteMeta } from './store.ts'
import { ensureLayoutSync } from '../context/migrate.ts'

export const TEAM_NOTES_TOOL = 'team_notes'

export interface NotesToolDeps {
  identityOf: (agent: Agent) => TeamIdentity | undefined
  storeFor: (identity: TeamIdentity) => NotesStore
  /** search 结果上限。 */
  maxResults: number
  /** 写入成功后回调（记录本窗口写过自己的笔记，设计 0.3.0 §9a-7）。 */
  onWrite?: (agent: Agent, identity: TeamIdentity, meta: NoteMeta) => void
}

/** 按状态根 + 团队代复用 NotesStore（进程内写锁按物理路径共享）；首次使用某状态根时确保布局已迁移。 */
export function createStoreCache(maxFileBytes: () => number, workspaceMaxBytes: () => number = maxFileBytes): (identity: Pick<TeamIdentity, 'stateRoot' | 'team'>) => NotesStore {
  const stores = new Map<string, NotesStore>()
  return (identity) => {
    ensureLayoutSync(identity.stateRoot)
    const root = notesRootOf(identity.stateRoot)
    const key = `${root}\0${identity.team.id}\0${identity.team.createdAt}`
    let store = stores.get(key)
    if (store === undefined) {
      store = new NotesStore(root, maxFileBytes, { id: identity.team.id, createdAt: identity.team.createdAt }, workspaceMaxBytes)
      stores.set(key, store)
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
      if (target.shared && identity.role !== 'captain') throw new Error(`成员不能写 workspace.md（由队长或合并模型维护），请写进自己的笔记（${ownNotePath(scope.teamId, scope.fileKey)}）`)
      if (!target.own && !target.shared) throw new Error(`只能写自己的笔记（${ownNotePath(scope.teamId, scope.fileKey)}）${identity.role === 'captain' ? '或 workspace.md' : ''}`)
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
    description: '团队笔记，存在磁盘上，上下文压缩后不丢失。',
    parameters: {
      action: { type: 'string', enum: ['list', 'read', 'write', 'append', 'search'], required: true, description: 'list / read / write（全量重写）/ append / search（字面，区分大小写）' },
      path: { type: 'string', description: '省略为自己的笔记；workspace.md 为共享笔记（只有队长能写）；<成员>.md 为队友笔记（只读）。可读本团队所有笔记，每个文件有大小上限' },
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
      const text = await runTeamNotes(args, identity, store, deps.maxResults, meta => deps.onWrite?.(agent, identity, meta))
      return { text }
    },
  }))
}
