/**
 * 全文记录（设计 0.4.0 §3、§8 第 6 步）。
 *
 * - 来源：team.json 里进入终态的任务（completed / failed / cancelled），不靠完成信；
 * - 唯一键 `<teamId>@<代>:<taskId>:<attempt>`；分卷 `records/full/0001.md` 起，单卷 1 MB、单条 32 KB（超出截断 output 并标注原长度）；
 * - 每条以一行 `<!-- full-entry {"key":…} -->` 开头，重建游标时只认这一行；
 * - 游标 `state/full-cursor.json` 只是「已写入哪些键」的缓存：丢失/损坏时扫描全部分卷重建；
 *   既无分卷也无游标（首次运行 0.4.0）时只建基线：现有终态任务记入游标，不写条目；
 * - 先追加后更新游标；追加前再查一遍最后一卷，避免崩溃后重复；
 * - 终态时给成员笔记拍一份终态快照，并把该 attempt 的全部快照挂进条目。
 * 同一状态根内串行（进程内链 + 跨进程文件锁）。
 */

import { appendFile, mkdir, readdir, readFile, stat } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { contextRootOf, fullCursorPath, fullVolumePath, generationOf, lockPath, notesTeamDir, zoneDir } from '../context/layout.ts'
import { atomicWrite } from '../context/atomic.ts'
import { withFileLock } from '../context/lock.ts'
import { CAPTAIN_KEY, sanitizeKey, type TeamInfo, type TeamTaskInfo } from '../team/team-file.ts'
import { readSnapshotMetas, takeSnapshot, type SnapshotMeta } from '../notes/snapshot.ts'
import { addPending } from '../notes/pending.ts'

export const FULL_VOLUME_MAX_BYTES = 1024 * 1024
export const FULL_ENTRY_MAX_BYTES = 32 * 1024
export const FULL_CURSOR_SCHEMA = 1
export const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled'])

const MARKER = /^<!-- full-entry (\{.*\}) -->$/gm

export function fullEntryKey(teamId: string, createdAt: number, taskId: string, attempt: number): string {
  return `${teamId}@${generationOf(createdAt)}:${taskId}:${attempt}`
}

export interface FullCursor {
  schema: number
  /** 已写入（或基线跳过）的唯一键。 */
  keys: string[]
}

export interface RecordedTask {
  team: TeamInfo
  task: TeamTaskInfo
  key: string
}

export interface FullEntryInput {
  key: string
  team: TeamInfo
  task: TeamTaskInfo
  /** 执行者会话 id（成员持久会话）；队长或未知时省略。 */
  memberSessionId?: string
  /** 快照：相对 `.context` 的路径 + 元数据。 */
  snapshots: Array<{ path: string; meta: SnapshotMeta }>
  at: number
}

function block(value: unknown): string {
  return typeof value === 'string' ? value : `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``
}

/** 渲染一条全文条目；超过单条上限时截断 output 并标注原长度。纯函数。 */
export function renderFullEntry(input: FullEntryInput, maxBytes = FULL_ENTRY_MAX_BYTES): string {
  const { team, task } = input
  const header = `<!-- full-entry ${JSON.stringify({ key: input.key, at: input.at })} -->`
  const meta = [
    `## ${input.key}`,
    '',
    `- 团队：${team.name}（${team.id}@${generationOf(team.createdAt)}）`,
    `- 任务：${task.id} ${task.subject}`,
    `- 执行者：${task.assignee ?? '（未分配）'}${input.memberSessionId === undefined ? '' : `，会话 ${input.memberSessionId}`}`,
    `- attempt：${task.attempt}${task.attemptId === undefined ? '' : `（attempt_id ${task.attemptId}）`}`,
    `- 状态：${task.status}`,
  ]
  if (input.snapshots.length > 0) {
    meta.push('- 成员笔记快照：')
    for (const s of input.snapshots) meta.push(`  - ${s.path}（${s.meta.reason === 'terminal' ? '终态' : '换窗'}，${s.meta.ref}）`)
  }
  const details = task.details ?? {}
  const rest: string[] = []
  for (const [key, value] of Object.entries(details)) {
    if (key === 'output' || key === 'updatedAt') continue
    rest.push(`### ${key}`, '', block(value), '')
  }
  const tail = rest.join('\n')
  const output = typeof details.output === 'string' ? details.output : undefined
  const compose = (out: string | undefined): string => [
    header, ...meta, '',
    ...(out === undefined ? [] : ['### output', '', out, '']),
    tail,
  ].join('\n').replace(/\n*$/, '\n\n')
  let text = compose(output)
  if (Buffer.byteLength(text) <= maxBytes || output === undefined) return text
  const original = Buffer.byteLength(output)
  const note = `\n\n（output 已截断，原长 ${original} 字节）`
  let budget = maxBytes - Buffer.byteLength(compose('')) - Buffer.byteLength(note)
  if (budget < 0) budget = 0
  const cut = Buffer.from(output).subarray(0, budget).toString('utf8').replace(/\uFFFD+$/, '')
  text = compose(cut + note)
  return text
}

/** 解析分卷里的条目键。 */
export function entryKeysOf(text: string): string[] {
  const keys: string[] = []
  for (const m of text.matchAll(MARKER)) {
    try {
      const parsed = JSON.parse(m[1]!) as { key?: unknown }
      if (typeof parsed.key === 'string') keys.push(parsed.key)
    } catch { /* 坏行跳过 */ }
  }
  return keys
}

async function volumes(stateRoot: string): Promise<number[]> {
  try {
    const names = await readdir(dirname(fullVolumePath(stateRoot, 1)))
    return names.map(n => /^(\d{4,})\.md$/.exec(n)).filter(m => m !== null).map(m => Number(m![1])).sort((a, b) => a - b)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

async function readCursor(stateRoot: string): Promise<FullCursor | undefined> {
  try {
    const parsed = JSON.parse(await readFile(fullCursorPath(stateRoot), 'utf8')) as Partial<FullCursor>
    if (parsed.schema === FULL_CURSOR_SCHEMA && Array.isArray(parsed.keys) && parsed.keys.every(k => typeof k === 'string')) {
      return { schema: FULL_CURSOR_SCHEMA, keys: parsed.keys }
    }
    return undefined
  } catch {
    return undefined
  }
}

async function writeCursor(stateRoot: string, keys: Set<string>): Promise<void> {
  await atomicWrite(fullCursorPath(stateRoot), `${JSON.stringify({ schema: FULL_CURSOR_SCHEMA, keys: [...keys] })}\n`)
}

/** 扫描全部分卷得到已写入的键。 */
export async function scanFullKeys(stateRoot: string): Promise<Set<string>> {
  const keys = new Set<string>()
  for (const n of await volumes(stateRoot)) {
    for (const key of entryKeysOf(await readFile(fullVolumePath(stateRoot, n), 'utf8'))) keys.add(key)
  }
  return keys
}

async function appendEntry(stateRoot: string, text: string): Promise<void> {
  const list = await volumes(stateRoot)
  let n = list.length === 0 ? 1 : list[list.length - 1]!
  if (list.length > 0) {
    const size = (await stat(fullVolumePath(stateRoot, n))).size
    if (size > 0 && size + Buffer.byteLength(text) > FULL_VOLUME_MAX_BYTES) n += 1
  }
  const file = fullVolumePath(stateRoot, n)
  await mkdir(dirname(file), { recursive: true })
  await appendFile(file, text, 'utf8')
}

async function lastVolumeKeys(stateRoot: string): Promise<Set<string>> {
  const list = await volumes(stateRoot)
  if (list.length === 0) return new Set()
  return new Set(entryKeysOf(await readFile(fullVolumePath(stateRoot, list[list.length - 1]!), 'utf8')))
}

/** 终态快照 + 该 attempt 全部快照（路径相对 `.context`，即 records/… 虚拟路径）。 */
async function snapshotsFor(stateRoot: string, team: TeamInfo, task: TeamTaskInfo, ref: string, at: number): Promise<FullEntryInput['snapshots']> {
  const assignee = task.assignee
  if (assignee === undefined || assignee === '' || assignee === CAPTAIN_KEY) return []
  const fileKey = sanitizeKey(assignee)
  try {
    const content = await readFile(join(notesTeamDir(stateRoot, team.id, team.createdAt), `${fileKey}.md`), 'utf8')
    if (content !== '') {
      await takeSnapshot({
        stateRoot, teamId: team.id, createdAt: team.createdAt, taskId: task.id, attempt: task.attempt,
        fileKey, content, ref, reason: 'terminal', at,
      })
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const metas = await readSnapshotMetas(stateRoot, team.id, team.createdAt, task.id, task.attempt)
  const records = zoneDir(stateRoot, 'records')
  const base = relative(contextRootOf(stateRoot), records).split('\\').join('/')
  return metas.map(meta => ({
    meta,
    // 虚拟路径：records/teams/<teamId>/<taskId>/a<attempt>/<file>
    path: `${base}/teams/${team.id}/${task.id}/a${task.attempt}/${meta.file}`,
  }))
}

/**
 * 由成员会话 id 与截止时间算出 `<sessionId>/w<n>/e<seq>`；算不出返回 undefined（退回只记会话 id）。
 */
export type LocateMember = (sessionId: string, until: number | undefined) => Promise<string | undefined>

function updatedAtOf(task: TeamTaskInfo): number | undefined {
  const v = task.details?.updatedAt
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

async function terminalRef(task: TeamTaskInfo, memberSessionId: string | undefined, locate: LocateMember | undefined): Promise<string> {
  if (memberSessionId === undefined) return ''
  if (locate === undefined) return memberSessionId
  try {
    return (await locate(memberSessionId, updatedAtOf(task))) ?? memberSessionId
  } catch {
    return memberSessionId
  }
}

/** 进待合并清单的终态：完成与失败（取消多为改派，笔记会随该成员下一个终态再提交）。 */
const PENDING_STATUSES = new Set(['completed', 'failed'])

const chains = new Map<string, Promise<unknown>>()

/**
 * 把终态任务记入全文。返回本次新写入的任务（基线跳过的不算）。
 * 同一状态根串行。
 */
export function recordTerminalTasks(stateRoot: string, teams: readonly TeamInfo[], now = Date.now(), locate?: LocateMember): Promise<RecordedTask[]> {
  const prior = chains.get(stateRoot) ?? Promise.resolve()
  const run = prior.catch(() => undefined).then(() =>
    withFileLock(lockPath(stateRoot, 'full'), () => recordNow(stateRoot, teams, now, locate)))
  chains.set(stateRoot, run)
  void run.finally(() => {
    if (chains.get(stateRoot) === run) chains.delete(stateRoot)
  }).catch(() => undefined)
  return run
}

async function recordNow(stateRoot: string, teams: readonly TeamInfo[], now: number, locate: LocateMember | undefined): Promise<RecordedTask[]> {
  const terminal: RecordedTask[] = []
  for (const team of teams) {
    for (const task of team.tasks) {
      if (TERMINAL_STATUSES.has(task.status)) terminal.push({ team, task, key: fullEntryKey(team.id, team.createdAt, task.id, task.attempt) })
    }
  }
  let cursor = await readCursor(stateRoot)
  if (cursor === undefined) {
    const hasVolumes = (await volumes(stateRoot)).length > 0
    if (!hasVolumes) {
      // 首次运行：只建基线
      await writeCursor(stateRoot, new Set(terminal.map(t => t.key)))
      return []
    }
    cursor = { schema: FULL_CURSOR_SCHEMA, keys: [...await scanFullKeys(stateRoot)] }
    await writeCursor(stateRoot, new Set(cursor.keys))
  }
  const known = new Set(cursor.keys)
  const fresh = terminal.filter(t => !known.has(t.key))
  if (fresh.length === 0) return []
  const tail = await lastVolumeKeys(stateRoot)
  const written: RecordedTask[] = []
  for (const item of fresh) {
    if (!tail.has(item.key)) {
      const memberSessionId = item.team.members.find(m => m.name === item.task.assignee)?.id || undefined
      const ref = await terminalRef(item.task, memberSessionId, locate)
      const snapshots = await snapshotsFor(stateRoot, item.team, item.task, ref, now)
      // 待合并清单：先于全文条目写入（按 key 幂等），崩溃重试不丢
      const last = snapshots[snapshots.length - 1]
      if (last !== undefined && PENDING_STATUSES.has(item.task.status)) {
        await addPending(stateRoot, [{
          key: item.key, teamId: item.team.id, createdAt: item.team.createdAt, teamName: item.team.name,
          taskId: item.task.id, subject: item.task.subject, attempt: item.task.attempt,
          member: item.task.assignee ?? '', status: item.task.status, snapshot: last.path, ref, at: now,
        }])
      }
      await appendEntry(stateRoot, renderFullEntry({ key: item.key, team: item.team, task: item.task, memberSessionId, snapshots, at: now }))
      written.push(item)
    }
    known.add(item.key)
    await writeCursor(stateRoot, known)
  }
  return written
}
