/**
 * 共享笔记自动合并（设计 §7-3，开关 notesMerge.enabled，默认关）。
 *
 * 触发：全文记录新写入的已完成成员任务（src/records/full.ts）。用用户选定的模型把该成员笔记合并进 workspace.md。
 *
 * - 后台执行，不阻塞对话；失败只告警
 * - 同一任务只合并一次
 * - 读 → 调模型 → 条件写入；期间 workspace.md 被改动则重试一次，仍冲突则放弃
 * - 结果超过 workspace.md 上限（workspaceMaxBytes）则放弃，不截断
 */

import type { NotesStore } from './store.ts'
import { CAPTAIN_KEY, type TeamInfo, type TeamTaskInfo } from '../team/team-file.ts'
import { WORKSPACE_NOTE, ownNotePath } from './paths.ts'

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

export interface MergeInput {
  teamName: string
  memberName: string
  taskId: string
  taskSubject?: string
  workspace: string
  memberNote: string
  maxBytes: number
}

export const MERGE_SYSTEM = [
  '你负责维护一个多智能体团队的工作区共享笔记 workspace.md。',
  '把某位成员刚完成任务后的个人笔记中，对全队有长期价值的内容（结论、决定、约定、坑、待办）合并进共享笔记。',
  '要求：',
  '- 输出合并后的完整 workspace.md 正文（Markdown），不要输出解释，不要用代码块包裹',
  '- 保留共享笔记里仍然有效的内容；与新结论冲突的旧内容改写为新结论',
  '- 去重、精简；不要抄写任务契约原文，不要记录过程性细节',
  '- 标注来源成员与任务 id，例如「（Alice，t3）」',
].join('\n')

export function mergePrompt(input: MergeInput): string {
  return [
    `团队：${input.teamName}`,
    `成员：${input.memberName}`,
    `完成的任务：${input.taskId}${input.taskSubject === undefined ? '' : ` ${input.taskSubject}`}`,
    `合并结果不得超过 ${input.maxBytes} 字节（UTF-8）。`,
    '',
    '<workspace.md 当前内容>',
    input.workspace === '' ? '（空）' : input.workspace,
    '</workspace.md 当前内容>',
    '',
    '<成员笔记>',
    input.memberNote,
    '</成员笔记>',
  ].join('\n')
}

/** 去掉模型可能加上的整体代码块包裹。 */
export function cleanMergeOutput(text: string): string {
  let out = text.trim()
  const fenced = /^```[a-zA-Z]*\n([\s\S]*?)\n```$/.exec(out)
  if (fenced !== null) out = fenced[1]!.trim()
  return out === '' ? '' : `${out}\n`
}

export type Generate = (system: string, prompt: string, signal: AbortSignal) => Promise<string>

export interface MergeJob {
  store: NotesStore
  teamId: string
  teamName: string
  memberName: string
  memberFileKey: string
  taskId: string
  taskSubject?: string
  generate: Generate
  signal: AbortSignal
}

export type MergeOutcome = 'merged' | 'empty-note' | 'empty-output' | 'too-large' | 'conflict'

/** 执行一次合并。异常向上抛出，由调用方告警。 */
export async function mergeMemberNote(job: MergeJob): Promise<MergeOutcome> {
  const memberNote = (await job.store.read(ownNotePath(job.teamId, job.memberFileKey)))?.trim() ?? ''
  if (memberNote === '') return 'empty-note'
  for (let attempt = 0; attempt < 2; attempt++) {
    const before = await job.store.read(WORKSPACE_NOTE)
    const raw = await job.generate(MERGE_SYSTEM, mergePrompt({
      teamName: job.teamName,
      memberName: job.memberName,
      taskId: job.taskId,
      taskSubject: job.taskSubject,
      workspace: before ?? '',
      memberNote,
      maxBytes: job.store.maxBytesFor(WORKSPACE_NOTE),
    }), job.signal)
    const next = cleanMergeOutput(raw)
    if (next === '') return 'empty-output'
    if (Buffer.byteLength(next) > job.store.maxBytesFor(WORKSPACE_NOTE)) return 'too-large'
    if (await job.store.writeIf(WORKSPACE_NOTE, before, next) !== undefined) return 'merged'
  }
  return 'conflict'
}
