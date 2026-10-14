/**
 * 窗口级 hint（runtime context，缓存分支 B；设计 §4.2.2、§7-4）。
 *
 * 内容：当前任务 id + 标题（来自 team.json 缓存）+ 笔记元数据（自己的文件 + 最近改动 ≤N 个）。
 * 只在窗口编号变化时重算；超过 hintMaxBytes 整条不注入。
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { TeamIdentity } from '../team/identity.ts'
import { notesRootOf, ownNotePath, WORKSPACE_NOTE } from '../notes/paths.ts'
import { countLines, type NoteMeta } from '../notes/store.ts'

export const HINT_CONTEXT_ORDER = 140

const TERMINAL = new Set(['completed', 'failed', 'cancelled'])

/** 同步读取笔记元数据（hint 在 prompt 组装内同步执行）。 */
export function listNoteMetasSync(identity: TeamIdentity): NoteMeta[] {
  const root = notesRootOf(identity.stateRoot)
  const paths = [WORKSPACE_NOTE]
  try {
    for (const name of readdirSync(join(root, 'teams', identity.team.id))) {
      if (name.endsWith('.md')) paths.push(`teams/${identity.team.id}/${name}`)
    }
  } catch { /* 目录不存在 */ }
  const metas: NoteMeta[] = []
  for (const path of paths) {
    try {
      const abs = join(root, ...path.split('/'))
      const text = readFileSync(abs, 'utf8')
      metas.push({ path, lines: countLines(text), bytes: Buffer.byteLength(text), mtimeMs: statSync(abs).mtimeMs })
    } catch { /* 不存在 */ }
  }
  return metas.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.path < b.path ? -1 : 1))
}

export interface HintInput {
  identity: TeamIdentity
  notes: boolean
  history: boolean
  metas: readonly NoteMeta[]
  recentNotes: number
  maxBytes: number
}

function describe(meta: NoteMeta | undefined, path: string): string {
  return meta === undefined ? `${path}（尚未创建）` : `${path}（${meta.lines} 行，${meta.bytes} 字节）`
}

/** 生成 hint；超过上限返回空串。 */
export function hintText(input: HintInput): string {
  const { identity } = input
  const lines = [`【团队上下文】团队「${identity.team.name}」（${identity.team.id}），你的身份：${identity.agentKey}。`]
  const mine = identity.team.tasks.filter(t => t.assignee === identity.agentKey && !TERMINAL.has(t.status))
  if (mine.length > 0) {
    lines.push('你当前的任务：')
    for (const t of mine) lines.push(`- ${t.id} ${t.subject}（${t.status}）`)
  } else if (identity.role === 'captain') {
    const open = identity.team.tasks.filter(t => !TERMINAL.has(t.status)).length
    lines.push(`团队未完成任务：${open} 个（详情以团队任务为准）。`)
  }
  if (input.notes) {
    const own = ownNotePath(identity.team.id, identity.fileKey)
    lines.push(`你的笔记：${describe(input.metas.find(m => m.path === own), own)}`)
    const recent = input.metas.filter(m => m.path !== own).slice(0, input.recentNotes)
    if (recent.length > 0) {
      lines.push(`最近改动的笔记（至多 ${input.recentNotes} 个，最新在前）：`)
      for (const m of recent) lines.push(`- ${describe(m, m.path)}`)
    }
    lines.push('需要时用 team_notes 读取。')
  }
  if (input.history) lines.push('早先窗口中被压缩的原始消息可用 history 工具只读回看。')
  const text = lines.join('\n')
  return Buffer.byteLength(text) > input.maxBytes ? '' : text
}

/** 每 agent 按窗口缓存 hint。 */
export class WindowHintCache {
  private readonly entries = new Map<string, { key: string; text: string }>()

  get(agentId: string, key: string, compute: () => string): string {
    const prior = this.entries.get(agentId)
    if (prior !== undefined && prior.key === key) return prior.text
    const text = compute()
    this.entries.set(agentId, { key, text })
    return text
  }

  forget(agentId: string): void {
    this.entries.delete(agentId)
  }
}
