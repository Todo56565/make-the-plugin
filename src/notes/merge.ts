/**
 * 共享笔记自动合并（设计 0.4.0 决定 10–12、§5、§8 第 9 步；开关 notesMerge.enabled，默认关）。
 *
 * 输入是待合并清单本身：每次取一个团队代清单里最早的至多 MERGE_BATCH_MAX 条，读各自指向的成员笔记快照
 * （只读、不再变，不读成员当前活笔记），一次喂给合并模型。
 *
 * - 读 → 调模型 → 条件写入 workspace.md；期间 workspace.md 被改动则重试一次，仍冲突则放弃
 * - 只有条件写入成功后，才按本次实际喂入的条目 id 删除清单（删的即喂的；模型无须回报合并了哪些）
 * - 快照为空的条目无可合并，直接删除；快照文件读不到的条目留在清单里交给队长，不喂入
 * - 结果超过 workspace.md 上限（workspaceMaxBytes）则放弃，不截断
 * - 一批持跨进程锁 `shared/locks/merge.lock`；锁被别的进程持有时本次跳过，由持有者处理
 */

import type { NotesStore } from './store.ts'
import { WORKSPACE_NOTE } from './paths.ts'
import { readPending, resolvePending, type PendingEntry, type PendingTeam } from './pending.ts'
import { lockPath, zoneDir } from '../context/layout.ts'
import { LockTimeoutError, withFileLock } from '../context/lock.ts'
import { atomicWrite } from '../context/atomic.ts'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fitMaterials, type SnapshotMaterial } from './merge-materials.ts'

/** 单次合并最多喂入的条目数。 */
export const MERGE_BATCH_MAX = 8
/** merge.lock 的过期判定：远大于单次合并超时，避免正常合并中被接管。 */
const MERGE_LOCK_STALE_MS = 10 * 60_000

/** 记录会话里尚未返回的 agent_teams_* 工具调用。 */
export class TeamToolCalls {
  private readonly pending = new Set<string>()

  /** 处理一个会话事件；返回 true 表示一个 agent_teams_* 调用刚返回。 */
  handle(sessionId: string, type: string, data: unknown): boolean {
    if (data === null || typeof data !== 'object') return false
    const d = data as { callId?: unknown; name?: unknown; message?: { toolCallId?: unknown } }
    if (type === 'tool/call') {
      if (typeof d.name === 'string' && d.name.startsWith('agent_teams_') && typeof d.callId === 'string') {
        this.pending.add(`${sessionId}\0${d.callId}`)
      }
      return false
    }
    if (type === 'tool/result' && typeof d.message?.toolCallId === 'string') {
      return this.pending.delete(`${sessionId}\0${d.message.toolCallId}`)
    }
    return false
  }
}

export interface MergeNote {
  member: string
  taskId: string
  subject: string
  status: string
  attempt: number
  content: string
}

export interface MergeInput {
  teamName: string
  workspace: string
  notes: readonly MergeNote[]
  maxBytes: number
  /** 材料 a：近期任务记录（全文条目原文）。 */
  recent?: string
  /** 材料 b：workspace.md 历史快照，旧→新。 */
  snapshots?: readonly SnapshotMaterial[]
}

export const MERGE_SYSTEM = [
  '你负责维护一个多智能体团队的工作区共享笔记 workspace.md。',
  '把若干成员在任务结束时的个人笔记快照中，对全队有长期价值的内容（结论、决定、约定、坑、待办）合并进共享笔记。',
  '要求：',
  '- 输出合并后的完整 workspace.md 正文（Markdown），不要输出解释，不要用代码块包裹',
  '- 保留共享笔记里仍然有效的内容；与新结论冲突的旧内容改写为新结论',
  '- 去重、精简；不要抄写任务契约原文，不要记录过程性细节',
  '- 失败任务的笔记只取对全队有用的教训与未完成事项',
  '- 如附有近期任务记录或 workspace.md 历史快照，它们只作参考：用来理解来龙去脉、找回被误删的长期内容；不要恢复已被新结论推翻的旧内容，不要照抄任务记录',
  '- 标注来源成员与任务 id，例如「（Alice，t3）」',
].join('\n')

const STATUS_TEXT: Record<string, string> = { completed: '已完成', failed: '失败' }

export function mergePrompt(input: MergeInput): string {
  const lines = [
    `团队：${input.teamName}`,
    `合并结果不得超过 ${input.maxBytes} 字节（UTF-8）。`,
    '',
    '<workspace.md 当前内容>',
    input.workspace === '' ? '（空）' : input.workspace,
    '</workspace.md 当前内容>',
  ]
  for (const snap of input.snapshots ?? []) {
    lines.push('', `<workspace.md 历史快照 #${snap.seq}（参考）>`, snap.content.trimEnd(), '</workspace.md 历史快照>')
  }
  if (input.recent !== undefined && input.recent !== '') {
    lines.push('', '<近期任务记录（参考）>', input.recent.trimEnd(), '</近期任务记录>')
  }
  for (const note of input.notes) {
    const subject = note.subject === '' ? '' : ` ${note.subject}`
    const attempt = note.attempt > 1 ? `，第 ${note.attempt} 次` : ''
    lines.push('', `<成员笔记快照 成员：${note.member}；任务：${note.taskId}${subject}（${STATUS_TEXT[note.status] ?? note.status}${attempt}）>`, note.content, '</成员笔记快照>')
  }
  return lines.join('\n')
}

/** 去掉模型可能加上的整体代码块包裹。 */
export function cleanMergeOutput(text: string): string {
  let out = text.trim()
  const fenced = /^```[a-zA-Z]*\n([\s\S]*?)\n```$/.exec(out)
  if (fenced !== null) out = fenced[1]!.trim()
  return out === '' ? '' : `${out}\n`
}

export type Generate = (system: string, prompt: string, signal: AbortSignal) => Promise<string>

export interface PendingMergeJob {
  stateRoot: string
  /** 映射到该团队代的笔记存储（读 records/… 快照、写 workspace.md）。 */
  store: NotesStore
  team: PendingTeam
  generate: Generate
  signal: AbortSignal
  batchMax?: number
  /** 可选材料 a / b；since 为上次成功合并的时间（毫秒，无记录为 0）。 */
  extras?: (since: number) => Promise<{ recent: string; snapshots: SnapshotMaterial[] }>
  /** 合并模型可用的输入预算（字节）；undefined 表示不知道窗口，不做保险。 */
  budgetBytes?: () => Promise<number | undefined>
  /** 返回 true 表示这一批（按 signature）已被搁置，本次不调用模型。 */
  held?: (signature: string) => boolean
  now?: () => number
}

export type MergeOutcome = 'merged' | 'nothing' | 'busy' | 'held' | 'empty-output' | 'too-large' | 'conflict'

export interface MergeResult {
  outcome: MergeOutcome
  /** 这一批的标识（本次选中喂入的条目 id，逗号连接）；没有可喂条目时为 ''。 */
  signature?: string
  /** 本次喂入并已删除的条目 id（含快照为空直接删除的）。 */
  resolved: string[]
  /** 快照读不到、留在清单里的条目 id。 */
  missing: string[]
}

/** 处理某团队代清单的一批。异常向上抛出，由调用方告警。 */
export async function mergePendingBatch(job: PendingMergeJob): Promise<MergeResult> {
  try {
    return await withFileLock(lockPath(job.stateRoot, 'merge'), () => runBatch(job), { staleMs: MERGE_LOCK_STALE_MS, timeoutMs: 0 })
  } catch (error) {
    if (error instanceof LockTimeoutError) return { outcome: 'busy', resolved: [], missing: [] }
    throw error
  }
}

function cursorPath(stateRoot: string): string {
  return join(zoneDir(stateRoot, 'state'), 'merge-cursor.json')
}

/** 上次成功合并的时间（毫秒）；无记录为 0。可重建缓存，丢了只影响材料 a 的起点。 */
export async function readMergeCursor(stateRoot: string): Promise<number> {
  try {
    const v = (JSON.parse(await readFile(cursorPath(stateRoot), 'utf8')) as { lastMergedAt?: unknown }).lastMergedAt
    return typeof v === 'number' && Number.isFinite(v) ? v : 0
  } catch {
    return 0
  }
}

async function runBatch(job: PendingMergeJob): Promise<MergeResult> {
  // 持锁后再读清单：别的进程刚处理过的条目不会重复喂入
  const entries = [...await readPending(job.stateRoot, job.team)].sort((a, b) => a.at - b.at)
  const missing: string[] = []
  const empty: string[] = []
  const picked: Array<{ entry: PendingEntry; content: string }> = []
  for (const entry of entries) {
    if (picked.length >= (job.batchMax ?? MERGE_BATCH_MAX)) break
    const content = await job.store.read(entry.snapshot).catch(() => undefined)
    if (content === undefined) missing.push(entry.id)
    else if (content.trim() === '') empty.push(entry.id)
    else picked.push({ entry, content: content.trim() })
  }
  const done = async (outcome: MergeOutcome, ids: string[], signature?: string): Promise<MergeResult> => {
    if (ids.length > 0) await resolvePending(job.stateRoot, job.team, ids)
    return { outcome, resolved: ids, missing, signature }
  }
  if (picked.length === 0) return done('nothing', empty, '')
  const signature = picked.map(p => p.entry.id).join(',')
  if (job.held?.(signature) === true) return done('held', empty, signature)
  const since = await readMergeCursor(job.stateRoot)
  const extras = job.extras === undefined ? { recent: '', snapshots: [] } : await job.extras(since)
  const budget = job.budgetBytes === undefined ? undefined : await job.budgetBytes()
  const maxBytes = job.store.maxBytesFor(WORKSPACE_NOTE)
  const teamName = picked[0]!.entry.teamName
  for (let attempt = 0; attempt < 2; attempt++) {
    const before = await job.store.read(WORKSPACE_NOTE)
    const fixed = Buffer.byteLength(MERGE_SYSTEM) + Buffer.byteLength(mergePrompt({ teamName, workspace: before ?? '', notes: [], maxBytes }))
    const fit = fitMaterials({ notes: picked, recent: extras.recent, snapshots: extras.snapshots }, p => Buffer.byteLength(p.content) + 200, fixed, budget)
    const notes = fit.notes.map(({ entry, content }) => ({ member: entry.member, taskId: entry.taskId, subject: entry.subject, status: entry.status, attempt: entry.attempt, content }))
    const raw = await job.generate(MERGE_SYSTEM, mergePrompt({ teamName, workspace: before ?? '', notes, maxBytes, recent: fit.recent, snapshots: fit.snapshots }), job.signal)
    const next = cleanMergeOutput(raw)
    if (next === '') return done('empty-output', empty, signature)
    if (Buffer.byteLength(next) > maxBytes) return done('too-large', empty, signature)
    if (await job.store.writeIf(WORKSPACE_NOTE, before, next) !== undefined) {
      await atomicWrite(cursorPath(job.stateRoot), `${JSON.stringify({ lastMergedAt: (job.now ?? Date.now)() })}\n`)
      return done('merged', [...fit.notes.map(f => f.entry.id), ...empty], signature)
    }
  }
  return done('conflict', empty, signature)
}
