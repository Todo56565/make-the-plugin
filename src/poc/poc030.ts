/**
 * 0.3.0 设计 PoC（只在 poc/0.3.0 分支，不合入 main）。
 *
 * 覆盖 docs/design/0.3.0-handoff.md §9 的 6 项：
 * 1 推迟压缩一轮（兜底额度）  2 兜底 restrict 与 agent-teams deny 叠加
 * 3 context_new_window 触发换窗  4 本窗口笔记新鲜度（mtime ≥ 窗口开始）
 * 5 接管 summarize() 零 LLM 请求，宿主自动压缩也走它  6 同一步来信不丢
 *
 * 运行参数读 POC_DIR/poc.json（每次读取，改了即生效），证据写 POC_DIR/poc.jsonl。
 */

import { appendFileSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { TeamIdentity } from '../team/identity.ts'
import { notesRootOf, ownNotePath } from '../notes/paths.ts'

export const POC_DIR = process.env.DSH_TB_POC_DIR ?? '/workspace/work/poc030'
export const NEW_WINDOW_TOOL = 'context_new_window'

export interface PocOptions {
  /** 兜底额度（token），默认 16384。 */
  fallbackBufferTokens: number
  /** 兜底期间对成员施加的 allow 列表。 */
  fallbackAllow: string[]
  /** 插件自己的阈值压缩（关闭后只剩宿主自动压缩）。 */
  pluginCompaction: boolean
  /** 队长不由插件压缩（§7-4）。 */
  captainSkip: boolean
  /** 接管 summarize()（团队会话返回模板）。 */
  templateSummary: boolean
  /** 运行时改宿主 compaction-basic 阈值（模拟 profile 降宿主 thresholdRatio）。 */
  hostOverride?: { thresholdRatio: number; retainTokens: number }
  /** 进入兜底时额外探测 restrict 对未知名的行为。 */
  probeUnknown: boolean
  /** restrict/revoke 后同步改写本步 assembly.tools（修正「晚一步」）。 */
  syncTools: boolean
  /** PoC-6：对这些成员，用量 ≥ minRatio 时在 pre-step 放行后延迟 ms（拉长步间窗口让来信落在压缩那一步被认领）。 */
  delay?: { names: string[]; minRatio: number; ms: number }
}

const DEFAULTS: PocOptions = {
  fallbackBufferTokens: 16384,
  fallbackAllow: ['team_notes', NEW_WINDOW_TOOL],
  pluginCompaction: true,
  captainSkip: true,
  templateSummary: true,
  probeUnknown: true,
  syncTools: false,
}

export function pocOptions(): PocOptions {
  try {
    return { ...DEFAULTS, ...JSON.parse(readFileSync(join(POC_DIR, 'poc.json'), 'utf8')) as Partial<PocOptions> }
  } catch {
    return { ...DEFAULTS }
  }
}

export function pocLog(record: Record<string, unknown>): void {
  try {
    mkdirSync(POC_DIR, { recursive: true })
    appendFileSync(join(POC_DIR, 'poc.jsonl'), JSON.stringify({ t: new Date().toISOString(), ms: Date.now(), ...record }) + '\n')
  } catch { /* PoC 日志失败不影响运行 */ }
}

interface EventLike { type: string; time?: number; seq?: number }
interface SessionLike {
  id: string
  seq: number
  eventAt(seq: number): EventLike
  requestHeader(): { config?: { provider: string; model: string }; tools?: Array<{ name: string }> } | undefined
}

export interface WindowInfo {
  /** history 模型编号：1 + 此前 compaction/summary 数。 */
  index: number
  /** 窗口开始时间：最后一个 compaction/summary 的 time；w1 取首个事件 time。 */
  startTime: number
}

/** 扫描会话日志得到当前窗口（与 history 模型同口径）。 */
export function windowInfoOf(session: SessionLike): WindowInfo {
  let index = 1
  let startTime = 0
  for (let seq = 0; seq < session.seq; seq += 1) {
    const event = session.eventAt(seq)
    if (seq === 0) startTime = event.time ?? 0
    if (event.type === 'compaction/summary') { index += 1; startTime = event.time ?? startTime }
  }
  return { index, startTime }
}

export function ownNoteFile(identity: TeamIdentity): string {
  return join(notesRootOf(identity.stateRoot), ownNotePath(identity.team.id, identity.fileKey))
}

/** PoC-4：自己的笔记 mtime ≥ 本窗口开始时间。 */
export function noteFreshness(identity: TeamIdentity, window: WindowInfo): { fresh: boolean; mtimeMs: number | null } {
  try {
    const mtimeMs = statSync(ownNoteFile(identity)).mtimeMs
    return { fresh: mtimeMs >= window.startTime, mtimeMs }
  } catch {
    return { fresh: false, mtimeMs: null }
  }
}

/** 0.3.0 §2 的提醒档位：remindAt + k×step 且严格小于 compactAt；不整除时去掉最后一档。 */
export function reminderLevels(remindAt: number, compactAt: number, step: number): number[] {
  const r = Math.round(remindAt * 100)
  const c = Math.round(compactAt * 100)
  const s = Math.max(1, Math.round(step * 100))
  const levels: number[] = []
  for (let v = r; v < c; v += s) levels.push(v)
  if ((c - r) % s !== 0) levels.pop()
  return levels
}

export function levelOf(ratio: number, levels: number[]): number | undefined {
  const used = Math.floor(ratio * 100 + 1e-9)
  let hit: number | undefined
  for (const level of levels) if (used >= level) hit = level
  return hit
}

export const FALLBACK_PROMPT = [
  '【上下文已用尽】本窗口上下文已到上限。不要继续任务，不要给最终答复；新窗口不会自动带上本窗口内容。',
  '现在只调用一次 team_notes（action=write 或 append，写你自己的笔记）记下检查点：目标、决定、进展、经验、下一步，以及仍在处理的请求在哪个窗口、用什么关键词能搜到。然后调用 context_new_window。',
].join('\n')

/** 可见工具：dsh-tools view(agent).visible 的键。 */
export function visibleTools(ctx: Context, agent: Agent): string[] | string {
  try {
    const tools = ctx.tools as unknown as { view(scope: unknown): { visible: Map<string, unknown> } }
    return [...tools.view(agent).visible.keys()].sort()
  } catch (error) {
    return `view 失败：${String(error)}`
  }
}

/** 本 agent 自己层注册的工具（knownNames − restrictableNames，不受 restrict 影响）。 */
export function ownLayerTools(ctx: Context, agent: Agent): string[] | string {
  try {
    const tools = ctx.tools as unknown as { view(scope: unknown): { knownNames: Set<string>; restrictableNames: Set<string> } }
    const view = tools.view(agent)
    return [...view.knownNames].filter(name => !view.restrictableNames.has(name)).sort()
  } catch (error) {
    return `view 失败：${String(error)}`
  }
}

interface FallbackState {
  window: number
  startPressure: number
  deadline: number
  revoke?: () => void
}

/** 兜底与换窗请求状态。 */
export class PocState {
  readonly fallback = new Map<string, FallbackState>()
  /** agent.id → 请求换窗时的窗口编号。 */
  readonly newWindow = new Map<string, number>()
  /** agent.id → 已拒绝过的窗口编号（每窗口只拒绝一次）。 */
  readonly rejected = new Map<string, number>()
  probed = false

  clear(agentId: string, reason: string): void {
    const state = this.fallback.get(agentId)
    if (state !== undefined) {
      try { state.revoke?.() } catch (error) { pocLog({ ev: 'restrict-revoke-error', agent: agentId, error: String(error) }) }
      this.fallback.delete(agentId)
      pocLog({ ev: 'fallback-cleared', agent: agentId, reason })
    }
    this.newWindow.delete(agentId)
  }
}

export interface NewWindowDeps {
  identityOf: (agent: Agent) => TeamIdentity | undefined
  state: PocState
}

/** PoC-3：无参数换窗工具。本窗口没写笔记时拒绝一次，第二次放行。 */
export function registerNewWindowTool(ctx: Context, deps: NewWindowDeps): () => void {
  return ctx.tools.register(defineTool({
    name: NEW_WINDOW_TOOL,
    description: '开新窗口，不影响任务和文件状态。',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(_args, exec) {
      const agent = exec.agent
      if (agent === undefined) throw new Error('context_new_window 需要调用方 agent')
      const identity = deps.identityOf(agent)
      if (identity === undefined) throw new Error('当前会话不属于任何 AgentTeams 团队')
      const window = windowInfoOf(agent.session as unknown as SessionLike)
      const fresh = noteFreshness(identity, window)
      if (!fresh.fresh && deps.state.rejected.get(agent.id) !== window.index) {
        deps.state.rejected.set(agent.id, window.index)
        pocLog({ ev: 'new-window-rejected', agent: agent.id, name: identity.agentKey, window: window.index })
        return { text: '本窗口还没写自己的笔记：先用 team_notes 记笔记再调；笔记满了就用 write 整篇精简重写。' }
      }
      deps.state.newWindow.set(agent.id, window.index)
      pocLog({ ev: 'new-window-requested', agent: agent.id, name: identity.agentKey, window: window.index, fresh: fresh.fresh })
      return { text: '已请求换窗：下一步开始前换到新窗口。' }
    },
  }))
}

/** PoC-5：零模型调用的换窗信息模板。 */
export function templateSummary(identity: TeamIdentity, window: WindowInfo, fresh: boolean): string {
  return [
    '【交接】',
    `团队「${identity.team.name}」（${identity.team.id}），你的身份：${identity.agentKey}（${identity.role === 'captain' ? '队长' : '成员'}）。`,
    `你的笔记：${ownNotePath(identity.team.id, identity.fileKey)}（${fresh ? '上一窗口已更新' : '上一窗口未更新，进展需用 history_* 恢复'}）`,
    '共享笔记：workspace.md；队长和队友的信：team_history（含已读）',
    `上一窗口：w${window.index}，原文用 history_list_items / history_search_contents / history_read_item 按窗口 id 回看`,
    '（PoC 模板：零 LLM 调用）',
  ].join('\n')
}
