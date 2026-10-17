/**
 * team_notes 工具：单工具多 action（list / read / write / append / search）。
 *
 * 读：本团队全部成员笔记 + workspace.md；写：自己的笔记；workspace.md 只有队长能写（设计 0.4.0 §1-3，成员在工具层拒绝）。
 * 待合并清单：虚拟 workspace.pending.md 只读，读 workspace.md 时附带；队长用 resolve 按 id 删除（设计 0.4.0 决定 10–12）。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { TeamIdentity } from '../team/identity.ts'
import { notesRootOf, ownNotePath, resolveNotePath } from './paths.ts'
import { sliceForRead } from './read-range.ts'
import { NotesStore, type NoteMeta } from './store.ts'
import type { WorkspaceSnapshotPolicy } from './workspace-snapshot.ts'
import { ensureLayoutSync } from '../context/migrate.ts'
import { PENDING_NOTE, parseIds, readPending, renderPending, resolvePending } from './pending.ts'

export const TEAM_NOTES_TOOL = 'team_notes'

export interface NotesToolDeps {
  identityOf: (agent: Agent) => TeamIdentity | undefined
  storeFor: (identity: TeamIdentity) => NotesStore
  /** search 结果上限。 */
  maxResults: number
  /** read 单次返回的字节上限（即时配置）。 */
  readMaxBytes?: () => number
  /** 写入成功后回调（记录本窗口写过自己的笔记，设计 0.3.0 §9a-7）。 */
  onWrite?: (agent: Agent, identity: TeamIdentity, meta: NoteMeta) => void
}

/** 按状态根 + 团队代复用 NotesStore（进程内写锁按物理路径共享）；首次使用某状态根时确保布局已迁移。 */
export function createStoreCache(maxFileBytes: () => number, workspaceMaxBytes: () => number = maxFileBytes, workspaceSnapshots?: () => WorkspaceSnapshotPolicy): (identity: { stateRoot: string; team: { id: string; createdAt: number } }) => NotesStore {
  const stores = new Map<string, NotesStore>()
  return (identity) => {
    ensureLayoutSync(identity.stateRoot)
    const root = notesRootOf(identity.stateRoot)
    const key = `${root}\0${identity.team.id}\0${identity.team.createdAt}`
    let store = stores.get(key)
    if (store === undefined) {
      store = new NotesStore(root, maxFileBytes, { id: identity.team.id, createdAt: identity.team.createdAt }, workspaceMaxBytes, { stateRoot: identity.stateRoot, workspaceSnapshots })
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
  args: { action: string; path?: string; content?: string; query?: string; ids?: string; start_line?: number; stop_line?: number },
  identity: TeamIdentity,
  store: NotesStore,
  maxResults: number,
  onWrite?: (meta: NoteMeta) => void,
  readMaxBytes?: number,
): Promise<string> {
  const scope = { teamId: identity.team.id, fileKey: identity.fileKey }
  const pendingText = async () => renderPending(await readPending(identity.stateRoot, identity.team))
  const isPending = (args.path ?? '').trim() === PENDING_NOTE
  switch (args.action) {
    case 'list': {
      const metas = await store.list(scope.teamId)
      const own = ownNotePath(scope.teamId, scope.fileKey)
      const pendingLine = `待合并清单：${PENDING_NOTE}（只读，读 workspace.md 时附带）`
      if (metas.length === 0) return `还没有任何笔记。你的笔记：${own}；共享笔记：workspace.md；${pendingLine}`
      return [`笔记（按修改时间倒序）。你的笔记：${own}`, ...metas.map(m => `- ${formatMeta(m)}`), pendingLine].join('\n')
    }
    case 'read': {
      if (isPending) return pendingText()
      const target = resolveNotePath(args.path, scope)
      if (!target.ok) throw new Error(target.error)
      const text = await store.read(target.path)
      const body = text === undefined ? `${target.path} 还不存在。`
        : text === '' ? `${target.path} 为空。`
        : sliceForRead(target.path, text, args.start_line, args.stop_line, readMaxBytes)
      return target.shared ? `${body}\n\n---\n${await pendingText()}` : body
    }
    case 'resolve': {
      if (identity.role !== 'captain') throw new Error(`只有队长能处理待合并清单（${PENDING_NOTE}）`)
      const ids = parseIds(args.ids)
      if (ids.length === 0) throw new Error('resolve 需要 ids')
      const result = await resolvePending(identity.stateRoot, identity.team, ids)
      const parts: string[] = []
      if (result.removed.length > 0) parts.push(`已从 ${PENDING_NOTE} 删除：${result.removed.map(e => e.id).join('、')}`)
      if (result.missing.length > 0) parts.push(`清单里没有：${result.missing.join('、')}`)
      return parts.join('\n')
    }
    case 'write':
    case 'append': {
      if (isPending) throw new Error(`${PENDING_NOTE} 由插件维护，只读；处理完的条目用 resolve 按 id 删除`)
      const target = resolveNotePath(args.path, scope)
      if (!target.ok) throw new Error(target.error)
      if (target.record) throw new Error(`${target.path} 是插件维护的记录，只读`)
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
      action: { type: 'string', enum: ['list', 'read', 'write', 'append', 'search', 'resolve'], required: true, description: 'list / read / write（全量重写）/ append / search（字面，区分大小写）/ resolve（队长按 id 删除待合并清单条目）' },
      path: { type: 'string', description: '省略为自己的笔记；workspace.md 为共享笔记（只有队长能写，读取时附带待合并清单）；workspace.pending.md 为待合并清单（只读）；<成员>.md 为队友笔记（只读）；records/… 为插件维护的记录（只读）。可读本团队所有笔记，每个文件有大小上限' },
      start_line: { type: 'integer', description: 'read 的起始行（从 1 起，含）；大文件不给范围时只返回末尾一段' },
      stop_line: { type: 'integer', description: 'read 的结束行（含）；省略为读到末尾，单次返回仍有字节上限' },
      content: { type: 'string', description: 'write / append 的内容（Markdown）' },
      query: { type: 'string', description: 'search 的字面字符串（区分大小写）' },
      ids: { type: 'string', description: 'resolve 要删除的清单条目 id，多个用逗号或空格分隔；处理完对应成员笔记后再删' },
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
      const text = await runTeamNotes(args, identity, store, deps.maxResults, meta => deps.onWrite?.(agent, identity, meta), deps.readMaxBytes?.())
      return { text }
    },
  }))
}
