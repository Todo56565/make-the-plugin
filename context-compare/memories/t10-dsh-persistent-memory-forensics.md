# T10 — DSH 侧持久化记忆取证（跨会话可读性 / 插件持久化边界 / 是否有提炼机制）

> 与 Codex memories 对照的另一半。全文遵守第一轮 t2/t3 的三层分层纪律：
> - **【插件】** = `NanmiCoder/dsh-agent-teams`
> - **【宿主压缩栈】** = `dsh-compaction` / `-basic` / `-tool-result-pruner` / `-command-compact`（+ `dsh-spill-*`）
> - **【harness 核心】** = 会话/子代理/请求装配 + 会话检索/引用等宿主基础
>
> **跨会话记忆总结论（先给答案）：部分存在，且是"显式引用式"而非"自动召回式"。**
> 新会话**不会**自动读到上一会话的内容；只有两条受控通路：(a) 用户显式引用另一个会话（`ctx.sessionReferenceResolver`，每会话 ≤3 个引用、每源 64 KiB 下限）；(b) 工作区文件（`AGENTS.md`/`CLAUDE.md`，**属项目指令不是对话记忆**）。全机 **58 个会话、35,652 条事件、44 种事件类型中，不存在任何 note / memory / feedback 类型**；无任何"从会话提炼长期记忆"的机制。第一轮的 notes（无）/ history 检索（无）结论在跨会话维度同样成立，spill 外置属**单会话内**。

## 取证环境（全部只读）

| 项 | 值 |
|---|---|
| DSH 安装根 | `D:\Dev\Path\nodejs_25.0.0\npm-cache\_npx\1e7f6d9597241db0\node_modules\@deepseek-ai\` |
| DSH_HOME | `C:\Users\ZYX\.dsh` |
| 会话数据 | `C:\Users\ZYX\.dsh\sessions\<workspace>\<sessionId>\session.v4.jsonl.zstd` |
| 本机规模（本轮实测） | **58 个会话日志 / 35,652 条 JSONL 记录 / 44 种事件类型** |
| 插件实际状态目录 | `I:\VMsShare\.agent-teams\context-health-codex-vs-dsh\`（team.json 94,614 B + 4 个 inbox JSONL） |
| 只读性 | 未写入任何被测文件；evidence 工具在 `I:\VMsShare\context-compare\memories\` |

---

**证据自检（可复现）**：每条源码引用前有 `<!-- src: 路径:起始-结束 -->` 标记；
`node memories\check-t10-evidence.mjs memories\t10-dsh-persistent-memory-forensics.md <dshNodeModulesRoot> <dshHome> <dsh-agent-teams克隆根>`
逐字节复核 **14/14 段全部一致（102 行参与比较，failures=0）**；另有 4 个未标记代码块是**运行态证据**
（会话头解帧结果、`.agent-teams` 目录清单、事件词表命令输出、复核命令），已由文中命令与来源说明定位。

## 维度 1：跨会话可读性

### 1.1 存储格式（harness 核心）：全局可读的多帧 zstd JSONL，按 workspace 分目录

`D:\...\@deepseek-ai\dsh-session-persistence-jsonl\lib\types\zstd.d.ts:1-6`：

<!-- src: D:\Dev\Path\nodejs_25.0.0\npm-cache\_npx\1e7f6d9597241db0\node_modules\@deepseek-ai\dsh-session-persistence-jsonl\lib\types\zstd.d.ts:1-6 -->
```ts
/**
 * Zstandard frame primitives for the JSONL persistence backend. The backend
 * owns a concatenated-frame container so it can append and recover batches
 * without exposing compression mechanics through the persistence seam.
 * @module dsh-session-persistence-jsonl/zstd
 */
```

真实会话文件与头（本轮解帧）：


```text
{"type":"session","version":4,"id":"session-6680b4d6-e2c4-4400-a087-754f1238cb5c","createdAt":1791728967519,"cwd":"I:\\VMsShare","isSeeded":false,"delegationDepth":0,"agentPreset":"standard"}
```

→ 格式本身**可被任意新会话读取**（纯 JSONL + 公开 zstd 帧），且按 workspace 聚簇；但"可读"不等于"会被读"——见下。

### 1.2 自动召回：**不存在**（新会话默认不加载任何旧会话内容）

会话引用服务只在**用户显式引用**时工作，并且给的是**引用快照**而非长期记忆：

`D:\...\@deepseek-ai\dsh-session-reference\lib\types\index.d.ts:1-6`：

<!-- src: D:\Dev\Path\nodejs_25.0.0\npm-cache\_npx\1e7f6d9597241db0\node_modules\@deepseek-ai\dsh-session-reference\lib\types\index.d.ts:1-6 -->
```ts
/**
 * Cross-session snapshot preparation. Hosts adapt mentions into structured
 * references; this service owns exact reads, projection, budgets, and durable context.
 *
 * @module @deepseek-ai/dsh-session-reference
 */
```

`D:\...\@deepseek-ai\dsh-session-reference\lib\types\index.d.ts:30-38`（只在被引用时替换/追加快照）：

<!-- src: D:\Dev\Path\nodejs_25.0.0\npm-cache\_npx\1e7f6d9597241db0\node_modules\@deepseek-ai\dsh-session-reference\lib\types\index.d.ts:30-38 -->
```ts
    /**
     * Replace canonical mentions in direct user messages and place each prepared
     * snapshot immediately after the message that cited it.
     * @param agent - agent entering the model step.
     * @param messages - messages accepted by downstream pre-step listeners.
     * @param signal - active turn cancellation.
     * @returns direct messages followed by their session-reference context in citation order.
     */
    private prepareDirectMessages;
```

预算上限（`D:\...\@deepseek-ai\dsh-session-reference\lib\types\config.d.ts:1-17`）：

<!-- src: D:\Dev\Path\nodejs_25.0.0\npm-cache\_npx\1e7f6d9597241db0\node_modules\@deepseek-ai\dsh-session-reference\lib\types\config.d.ts:1-7 -->
```ts
/** Configuration and stable diagnostics for session references. */
/** Hard maximum references accepted by one message. */
export declare const MAX_REFERENCES = 3;
/** Default number of discovery candidates returned to a host. */
export declare const DEFAULT_CANDIDATE_LIMIT = 50;
/** Minimum automatic UTF-8 budget for one rendered reference JSON object. */
export declare const DEFAULT_MAX_REFERENCE_BYTES = 65536;
```

### 1.3 全文检索：**由 bundle 层默认关闭**

`@deepseek-ai/dsh-web-app/cordis.patch.yml:27-31`（web-app 层复述；base 层默认见 `@deepseek-ai/dsh-base/cordis.patch.yml:149-153`）：

<!-- src: D:\Dev\Path\nodejs_25.0.0\npm-cache\_npx\1e7f6d9597241db0\node_modules\@deepseek-ai\dsh-web-app\cordis.patch.yml:27-33 -->
```yaml
- id: session-query-sqlite
  config:
    path: ':memory:'
    openAt: never

    - id: tools
```

语义（`D:\...\@deepseek-ai\dsh-session-query-sqlite\lib\types\index.d.ts:26-43`）：

<!-- src: D:\Dev\Path\nodejs_25.0.0\npm-cache\_npx\1e7f6d9597241db0\node_modules\@deepseek-ai\dsh-session-query-sqlite\lib\types\index.d.ts:26-27 -->
```ts
/** SQLite module/handle opening phase; `never` disables full-text search entirely. */
export type OpenAt = 'startup' | 'first-search' | 'never';
```

<!-- src: D:\Dev\Path\nodejs_25.0.0\npm-cache\_npx\1e7f6d9597241db0\node_modules\@deepseek-ai\dsh-session-query-sqlite\lib\types\index.d.ts:36-43 -->
```ts
    /**
     * Open the SQLite module and handle at service activation or the first
     * search, or `never` to disable full-text search: the inherited exact
     * reads, filters, and traces stay available, while `searchSessions` and
     * `searchEvents` fail with `SESSION_QUERY_SEARCH_DISABLED` and SQLite is
     * never imported or opened. Defaults to `startup`.
     */
    openAt?: OpenAt;
```

→ 本机**没有**可用的跨会话全文检索；精确读取 API 仍在，但没有暴露成模型工具（`dsh-session-query` 与其 sqlite 后端中无 `defineTool`/`ctx.tools.register` 命中）。消费方是 API/会话控制器与 UI（`dsh-api-session-controller` 53 处、`dsh-client-ui-reference` 2 处），不是模型工具。

### 1.4 版本/续聊语义：跨会话"继承"只对 **fork 血缘**成立

`session/end-seed` 是唯一被持久标注的继承切点（第一轮 t3 已证）：

`D:\...\@deepseek-ai\dsh-session-persistence-jsonl\lib\types\format.d.ts:38-41`：

<!-- src: D:\Dev\Path\nodejs_25.0.0\npm-cache\_npx\1e7f6d9597241db0\node_modules\@deepseek-ai\dsh-session-persistence-jsonl\lib\types\format.d.ts:38-41 -->
```ts
/**
 * The current physical header stored as the first JSONL record. The exact
 * inherited cut lives on the last tagged `session/end-seed` event.
 */
```

本机 58 个会话中 `session/end-seed` 共 **53 次**，而 5 个 AgentTeams 成员会话均为 `isSeeded:false`（第一轮 t3 已测）——即"新会话继承旧会话上下文"在本机只发生在 **`subagent_fork` 血缘**上，而 dsh-agent-teams 用的是 `spawn`（无继承）。

### 维度 1 结论

**部分存在（显式引用式）**：格式全局可读、引用通路存在且受预算约束，但**没有自动召回**，**全文检索被关闭**，跨会话继承只对 fork 血缘成立。

---

## 维度 2：dsh-agent-teams 插件持久化的内容边界

### 2.1 三个持久化产物的真实结构（本机实测）

```
I:\VMsShare\.agent-teams\context-health-codex-vs-dsh\
  team.json                 94,614 B   （12 个任务、4 名成员）
  inbox\captain.jsonl       32,516 B   （12 条消息）
  inbox\dsh-researcher.jsonl 2,099 B   （1 条）
  inbox\synthesizer.jsonl    5,941 B
  inbox\verifier.jsonl       8,621 B
```

- `team.json` 顶层键：`name, id, description, captainSessionId, createdAt, members, tasks, taskSeq, phase, approvedAt`；`captainSessionId = session-6680b4d6-…`（**captain 的 durable session id**）。
- `inbox/*.jsonl` 每行一条消息，字段：`id, from, to, content, ts, taskId, attemptId, deliveredAt, readAt`（captain 侧另有 `sourceTaskId, sourceAttemptId, sourceTaskStatus`）。
- `retired-members.json`：**本机不存在**（`Test-Path` 为 false，无团队被 delete/remove 过）。其设计位置见【插件】源码 `src/state.ts:55-56`（`RETIRED_MEMBERS_FILE = 'retired-members.json'`）。

### 2.2 哪些是"跨会话可读"，以及模型在什么条件下读到

**磁盘上是跨会话可读的**（纯 JSON/JSONL，任何会话都能用文件工具读）：

【插件】`src/state.ts:1-14`：

<!-- src: I:\VMsShare\_src-compare\dsh-agent-teams\src\state.ts:1-14 -->
```ts
/**
 * Team state persistence and pure team-logic rules.
 *
 * State lives on disk under `<workspace>/<stateDir>/<teamId>/`:
 * - `team.json` — the durable {@link TeamState} record
 * - `inbox/<agentKey>.jsonl` — one JSONL mailbox per agent (`captain` or a
 *   member name), mirroring the Claude Code AgentTeams mailbox layout
 *
 * All mutations run through an in-process per-team queue so read-modify-write
 * stays serial; `fs/promises` is used directly because the plugin owns this
 * bookkeeping (host-plane state, like session persistence) and the abstract
 * `fs` service offers no directory deletion.
 * @module dsh-agent-teams/state
 */
```

**但"进入模型上下文"必须经过渲染**，共 3 条通路：

| 通路 | 条件 | 形态 | 证据 |
|---|---|---|---|
| 派发提示 | 调度器把 ready 任务派给成员 | 任务全文 + 依赖输出（2000/12000 字符截断） | 【插件】`src/scheduler.ts:210-269`（t2 §2.1） |
| 状态工具 | captain/成员显式调 `agent_teams_status` | team 摘要 + 任务 output（300 字符）+ inbox 前 10 条 | 【插件】`src/tools.ts:2282-2877`（t2 §5.2） |
| mailbox 投递 | 消息被投递到对方 step | 消息**全文** + provenance 前缀 | 【插件】`src/mailbox.ts:22-31`（t2 §2.3） |

**身份限制：新的会话身份默认读不到旧团队状态。** 插件启动时用 durable session id / fork 血缘判定"我属于哪个团队"：

【插件】`src/capabilities.ts:40-48`（注意 `archive` 目录被显式跳过）：

<!-- src: I:\VMsShare\_src-compare\dsh-agent-teams\src\capabilities.ts:40-48 -->
```ts
  let found: TeamState | undefined
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === 'archive') continue
    const team = readTeamSync(root, entry.name)
    if (team === undefined || (!teamLeadMatch(team, lead)
      && !team.members.some(member => member.id === agent.id))) continue
    if (found !== undefined) throw new Error('ambiguous AgentTeams membership')
    found = team
  }
```

`teamLeadMatch` 只沿 `parentSession`/fork 血缘匹配（【插件】`src/lineage.ts:44-148`）。因此：**换一个全新的 captain 会话，它既不是 `captainSessionId` 也不是任何成员的 fork 后代 ⇒ `currentTeam` 返回 `undefined`**，团队工具对该会话不可用；模型只能靠**通用文件工具**直接读 `.agent-teams/**`（该目录并未被 fs sandbox 保护，本会话即可读）。

### 2.3 归档：为"后来的会话复盘"而设计，但只对面板可见

【插件】`src/state.ts:1152-1157`：

<!-- src: C:\Users\ZYX\.dsh\profiles\web\node_modules\@nanmicoder\dsh-agent-teams\lib\state.js:1095-1100 -->
```ts
/**
 * Archive a team instead of deleting it: the whole directory (team.json with
 * tasks and dependency graph, plus the mailboxes) moves under
 * `<stateRoot>/archive/<teamId>/` so later sessions can review how tasks were
 * planned and rebuild dependency relationships. The archive directory has no
 * team.json of its own, so the live activity scan skips it naturally.
```

注意末句：**归档目录里没有 team.json**（它被移进 `archive/<id>/`，而 `readTeam` 只读 `<root>/<id>/team.json`），所以归档内容**不可能**通过插件身份判定或团队工具进入模型上下文；唯一读法是 Web 面板的 HTTP 路由：

【插件】`src/index.ts:271-273`：

<!-- src: I:\VMsShare\_src-compare\dsh-agent-teams\src\index.ts:271-273 -->
```ts
      // ?archived=1 serves teams moved to archive/ (post-delete review).
      const snapshots = url.searchParams.get('archived') === '1'
        ? await collectArchivedTeamsActivity(ctx, roots)
```

本机 `I:\VMsShare\.agent-teams\archive` **不存在**（无团队被归档）。

### 2.4 插件事件写入是只读旁路，不构成记忆

【插件】`src/events.ts:39-54`（事件只在宿主认识该类型时才写）：

<!-- src: I:\VMsShare\_src-compare\dsh-agent-teams\src\events.ts:39-54 -->
```ts
  // Out-of-repo events are not in the harness's generated vocabulary today.
  // Mutating that ReadonlySet would make readability depend on which plugins
  // happen to be loaded. Until Session.append exposes the official
  // `ignorable: true` writer surface, omit these informational records unless
  // the running harness already recognizes them. Disk state remains the
  // authoritative source for the activity panel.
  const known = (dshSession as unknown as {
    KNOWN_SESSION_EVENT_TYPES?: ReadonlySet<string>
  }).KNOWN_SESSION_EVENT_TYPES
  if (known?.has(type) !== true) {
    if (!skippedEventTypes.has(type)) {
      skippedEventTypes.add(type)
      ctx.logger.debug(`agent-teams: session event "${type}" omitted because this harness does not recognize it`)
    }
    return
  }
```

本机全量实测：`team/*` 事件**确实落盘了**，但数量极少 —— `team/task` 12 条、`team/member` 6 条、`team/message/queued` 3 条、`team/message/delivered` 3 条，且**只存在 captain 会话日志里**。它们面向 UI 折叠树，不作为记忆被回读（capabilities 只读 `team.json`）。

### 维度 2 结论

`team.json` / `inbox/*.jsonl` / `retired-members.json` **磁盘上跨会话可读**，但**进入模型上下文有严格条件**：(a) 必须由插件渲染（派发 / status / mailbox）；(b) 渲染要求调用会话与团队存在 durable 身份或 fork 血缘；(c) 归档内容连 (a)(b) 都不满足，仅面板可见。**这是"状态持久化"，不是"跨会话记忆"**——它不携带对话历史，也不会被新会话自动加载。

---

## 维度 3：宿主压缩栈是否产生可跨会话复用的记忆产物

### 3.1 压缩检查点**持久留在原会话日志内**，但不存在跨会话索引

检查点落盘为一次事务事件（第一轮 t3 已实测）：

`D:\...\@deepseek-ai\dsh-compaction\lib\types\checkpoint.d.ts:17-24`：

<!-- src: D:\Dev\Path\nodejs_25.0.0\npm-cache\_npx\1e7f6d9597241db0\node_modules\@deepseek-ai\dsh-compaction\lib\types\checkpoint.d.ts:17-24 -->
```ts
declare const COMPACT_CHECKPOINT_MARKER: Readonly<{
    readonly kind: "compact-checkpoint";
}>;
/** Message source carried by a concrete compaction checkpoint. */
export type CompactionCheckpointSource = typeof COMPACT_CHECKPOINT_MARKER & {
    readonly compactionId: CompactionId;
    readonly sourceCommandId?: CommandId;
};
```

本机实测（58 个会话）：`compaction/start` 27、`compaction/summary` 26、`compaction/end` 27 —— **全部位于各自会话日志内部**，形态是一条 `user/message`（`source.kind='compact-checkpoint'`）。

**能否被新会话回读？** 只能走维度 1 的引用通路（用户显式引用该会话才有快照），**没有**任何"检查点索引/跨会话复用"机制：

- 没有把检查点写入独立存储：`compaction-basic` 只 append 会话事件（t3 §7.2）。
- 没有被压缩摘要的跨会话聚合：`ctx.sessionQuery` 的 FTS 已被关闭（§1.3）。
- spill 文件虽在磁盘（`dsh-spill-policy`，t3 §4.1），但**属单会话内**的外置（locator 由会话内消息持有）。

### 维度 3 结论

**未产生可跨会话复用的记忆产物。** 压缩检查点是**会话内**的上下文治理产物；跨会话可读性仅继承维度 1 的显式引用通路（且需要用户主动引用）。

---

## 维度 4：是否存在"从会话/工作区提炼长期记忆"的机制

### 4.1 全量事件词表：不存在任何 note / memory / feedback 事件类型

命令 `node memories/event-vocabulary.mjs 'C:\Users\ZYX\.dsh\sessions'`（58 个会话、35,652 条记录、44 种类型）：

```
sessions=58 records=35652 distinctTypes=44
   6263  tool/call        6262  tool/result      5260  step/start
   5258  step/end         5222  assistant/message 1351 agent/inbox/spliced
   1293  user/message       590  tool/ptc-dispatch-start  590 tool/ptc-dispatch
    ...（中略）...
     32  subagent/catalog    31  command/run        31  command/done
     27  compaction/start    26  compaction/summary 21  model/selection
     17  goal/change         12  team/task            6  team/member
      3  team/message/queued  3  team/message/delivered  1 agent-preset/selected

note/memory/feedback event types: (none)
```

**本轮的自我纠错留痕**：初版子串扫描曾报出 `session/note in --I-VMsShare--/5555841f-…`，逐字符复核（`type=assistant/message seq=1570/1575`、`tool/call seq=1571/1576`）确认那是**我自己的命令与推理文本**里出现的字面量，不是事件类型。按类型精确统计后为 0。

### 4.2 所有"可能像记忆"的宿主机制都不满足跨会话记忆定义

| 机制 | 归属 | 持久在哪 | 是否跨会话记忆 | 证据 |
|---|---|---|---|---|
| `dsh-agent-instructions`（AGENTS.md/CLAUDE.md） | harness 核心 | 工作区文件（可提交） | **否，属项目指令**（"Workspace context loader"）；且 web-app 层 `disabled: true`，standard preset 才启用 | `dsh-agent-instructions/package.json` description；`@deepseek-ai/dsh-web-app/cordis.patch.yml:549-550`（disabled）、`@deepseek-ai/dsh-web-app/presets/cordis.patch.yml:19-22`（preset enabled, maxBytes 65536） |
| `dsh-goal` / `tool-goal` | harness 核心 | **仅拥有它的会话日志** | **否**（"Same-session" / "backed exclusively by the owning session log"） | `dsh-goal/lib/types/index.d.ts:2`、`:54`；`dsh-tool-goal/package.json`：`Model-facing same-session goal tools` |
| `dsh-message-feedback`（`maxNoteBytes: 8192`） | harness 核心 | 逐条消息的反馈事件 | **否**（真正的 `message-feedback` 事件本机 0 条） | `@deepseek-ai/dsh-web-app/cordis.patch.yml:69-72` |
| `dsh-session-title*` | harness 核心 | 会话日志 + 投影缓存 | **否**（标题用于列表/引用候选，不是记忆内容） | `@deepseek-ai/dsh-base/cordis.patch.yml:55-63` |
| `dsh-session-projection-cache` | harness 核心 | `storages\session_projcache\sessions\*.json` | **否**（只存 latest 投影，供 UI/引用列表显示标题，不可回放历史） | `@deepseek-ai/dsh-base/cordis.patch.yml:182-185` |
| `dsh-session-log-deepseek` | harness 核心 | 会话日志水位线 | **否**（把日志增量上传给官方 API 的请求扩展 + 重启续传，不是本地记忆） | `dsh-session-log-deepseek/package.json`；`lib/types/index.d.ts:1-5,16-24` |
| `dsh-session-log-export` | harness 核心 | 用户下载 | **否**（导出，非记忆） | `@deepseek-ai/dsh-web-app/cordis.patch.yml:74-76` |
| `dsh-skill*` / `tool-skill` | harness 核心 | `skills/` 目录 | **否**（预置任务指引；web-app 层 host 行 `disabled: true`） | `@deepseek-ai/dsh-web-app/cordis.patch.yml:484-485`、`@deepseek-ai/dsh-web-app/presets/cordis.patch.yml:143-144` |
| dsh-agent-teams `.agent-teams/**` | **【插件】** | 工作区 `.agent-teams/` | **状态持久化，非对话记忆**（无对话内容，需身份/渲染才进上下文） | §2 |

**无任何"提炼"环节**：全量 44 种事件类型里没有 extraction/consolidation/summary-to-store 类事件；宿主压缩栈的摘要是**会话内替换**（t3 §7.2）；插件不发起 LLM 调用做提取（t2 §6.1）。

### 维度 4 结论

**未实现。** 不存在从会话或工作区提炼长期记忆的机制（宿主插件、harness 核心、profile 配置层三者皆无）。

---

## 维度 5：与第一轮结论的衔接（notes / history 检索 / spill 的定位）

| 第一轮结论 | 跨会话维度下的定位 | 与"跨会话记忆"的区别 |
|---|---|---|
| notes（无） | 本机 58 会话 0 条 note/memory/feedback 事件；`message-feedback.maxNoteBytes` 属逐消息反馈，且 0 条实例 | 「笔记」若要成为记忆，必须落在会话之外并被新会话读取 —— 两者都不满足 |
| history 检索（无） | 插件不检索会话历史（t2 §6.1）；宿主 FTS 被 `openAt: never` 关闭；引用服务只做"被引用时的快照" | 检索是**读取手段**，不是记忆**存储**；本机连读取手段都被关闭（仅剩显式引用） |
| spill 文件外置（有，单会话内） | `dsh-spill-policy` 把超大工具结果写盘并给出路径（t3 §4.1），但 locator 只存在于**产生它的会话消息**里 | 外置解决**单会话内**的上下文体积；跨会话不会自动发现这些文件，也不构成可召回的知识 |

**三者都不等于"跨会话记忆"。** DSH 侧目前唯一把"上一个会话的信息"带进新会话的受控通路是**用户显式引用**（`session-reference`），其余皆为会话内治理或工作区文件。

---

## 6. 跨会话记忆能力矩阵（本报告结论汇总）

| 能力 | 本机状态 | 层级 | 决定性证据 |
|---|---|---|---|
| 新会话自动读取上一会话内容 | **未实现** | harness 核心 | 无自动加载路径；引用服务仅在 mention 时工作（`dsh-session-reference/.../index.d.ts:30-38`） |
| 显式引用旧会话（快照进上下文） | **存在**（受 3 引用 × 64 KiB 约束） | harness 核心 | `config.d.ts:1-17`；`@deepseek-ai/dsh-web-app/cordis.patch.yml:94-95` 已装载 |
| 跨会话全文检索 | **未实现（本机为 bundle 默认关闭）** | harness 核心 | `@deepseek-ai/dsh-base/cordis.patch.yml:149-153` + `@deepseek-ai/dsh-web-app/cordis.patch.yml:27-31` + `dsh-session-query-sqlite/.../index.d.ts:36-43` |
| 跨会话继承对话历史 | **仅 fork 血缘** | harness 核心 | `format.d.ts:38-41`；本机 53 个 `session/end-seed`，成员会话 `isSeeded:false` |
| 插件状态跨会话可读 | **磁盘可读，上下文需渲染+身份** | 【插件】 | `state.ts:1-14`；`capabilities.ts:40-48` |
| 归档团队可被后来会话复盘 | **仅面板；模型不可达** | 【插件】 | `state.ts:1152-1157`；`index.ts:271-273` |
| 压缩检查点跨会话复用 | **未实现** | 宿主压缩栈 | 检查点在会话日志内（`checkpoint.d.ts:17-24`），无跨会话索引 |
| 长期记忆提炼机制 | **未实现** | 三层皆无 | 44 种事件类型无 note/memory；§4.1–4.2 |

---

## 7. UNVERIFIED（含检索位置；不用未取证行为填空）

1. **`session-query` 精确读取 API 是否有未装载的模型工具封装**：仅验证了 `dsh-session-query` / `-sqlite` 包内无 `defineTool`/`ctx.tools.register`，以及消费方为 API/UI 包。检索位置：`node_modules\@deepseek-ai\dsh-session-query*\lib\**`、`dsh-api-session-controller\lib\**`。
2. **UI 是否提供"把某个历史会话插入当前会话"的一键操作**：`dsh-client-ui-reference` 只有 2 处 `sessionReferenceResolver` 命中，未读其界面代码。检索位置：`node_modules\@deepseek-ai\dsh-client-ui-reference\lib\**`。
3. **`dsh-session-log-deepseek` 的 `dsh_session_log` 字段是否在服务端形成可被后续会话利用的记忆**：本任务只取证本地行为，未验证服务端。检索位置：该包 `lib/types/index.d.ts`（本地契约）+ 服务端行为（本地不可见）。
4. **`archive` 归档目录在真实归档后的完整可读性**：本机无归档实例（`archive` 目录不存在），仅由源码契约推断。检索位置：`I:\VMsShare\.agent-teams\**`、`src\state.ts:1152-1160`、`src\snapshot.ts:283-305`。

---

## 8. 复核命令

```text
# 全量事件词表（44 种类型 / 35,652 条记录；确认无 note/memory 类型）
node memories\event-vocabulary.mjs 'C:\Users\ZYX\.dsh\sessions'

# 会话头与 fork 继承切点
node ..\t3-evidence-tools\survey-session-headers.mjs 'C:\Users\ZYX\.dsh\sessions\--I-VMsShare--'

# 插件状态目录（本机实例）
Get-ChildItem 'I:\VMsShare\.agent-teams' -Recurse -Force
node -e "const j=require('I:/VMsShare/.agent-teams/context-health-codex-vs-dsh/team.json');console.log(Object.keys(j))"

# profile 关键行：FTS 关闭 / agent-instructions / message-feedback / 引用服务
Select-String -Path 'C:\Users\ZYX\.dsh\profiles\web\cordis.yml' -Pattern 'openAt|session-reference|agent-instructions|maxNoteBytes'
```
