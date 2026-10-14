# dsh-agent-teams 上下文补丁插件：设计规格（权威版）

本文件是补丁插件的**唯一权威规格**。`临时记录.md` 保留讨论结论与取证细节，`context-compare/` 保留两轮比对报告；三者冲突时以本文件为准，并应回头修正另外两处。

**只写当前结论**。证据分级沿用仓库口径：

- **【源码】**：逐字可复核（`路径:行号` + token 锚点）
- **【运行态】**：本机会话日志 / `--dump-config` 实测（引用自 `临时记录.md`，本文件未重测）
- **【推断】**：由前两者推导、尚未实测 ⇒ 必须进 §6 PoC 清单

---

## 0. 取证基线与版本漂移

| 对象 | 版本 | 本文件锚点写法 |
|---|---|---|
| DSH 宿主 | `deepseek-ai/deepseek-harness` @ `d7432673`（2026-10-09），各包 `0.2.1-alpha.2` | `packages/<组>/<包>/src/<文件>.ts:行` |
| 被补丁插件 | `NanmiCoder/dsh-agent-teams` @ `1094b84a`（v0.1.23） | `dsh-agent-teams/src/<文件>.ts:行` |
| 参照实现 | `openai/codex` @ `a07c8ebd` | `codex-rs/<路径>:行` |

**版本漂移（必须知道）**：

1. 前期研究与运行态实测基于本机**安装版** DSH 压缩栈 `0.2.0-rc.2`，引用的是构建产物 `lib/index.js:行`。源码 HEAD 已是 `0.2.1-alpha.2`，**构建产物行号与源码行号不可互换**。本文件一律给源码锚点；`临时记录.md` 中仍带 `lib/index.js:N` 的引用视为「安装版产物行号」，语义已逐条对照源码（见 §8），行号未逐条换算。
2. `@nanmicoder/dsh-agent-teams@0.1.23` 的 `peerDependencies` 只声明到 `0.2.0-rc.2`（`dsh-agent-teams/package.json` 各 `@deepseek-ai/*` 项 `"0.2.0-rc.2 || 0.1.7-rc.2 || …"`；`compatibility.json` `"recommendedHost": "0.2.0-rc.2"`）。**源码 HEAD 的 `0.2.1-alpha.2` 不在其支持范围内。** 本插件的兼容范围必须跟随 agent-teams 的 `supportedHosts`，不得单方面放宽。【源码】
3. 已漂移的配置行号：`standard.patch.yml` compaction 组 `:63-79` → `:66-82`；`web-app/cordis.patch.yml` 压缩组件禁用 `:509-516` → `:527-534`；`base/cordis.patch.yml` spill-policy `:407-410` → `:409-412`；`dsh-agent-loop/README.md` consolidation 段 `:121` → `:122`。【源码】

---

## 1. 目标与边界

### 1.1 目标

给 `@nanmicoder/dsh-agent-teams` 做**独立第三方补丁插件**（暂定包名 `@your/dsh-agent-teams-context`，plugin id `agent-teams-context`）：

- **不修改** agent-teams 源码，也不修改 DSH 任何包
- 以宿主层 Loader 行按 id 装载：**装上即有、卸下即无**；不装 = 原版社区 teams
- 三个能力**各自独立开关**：`tokenBudget` / `notes` / `history`

### 1.2 硬边界（已确认的用户决定，沿用 `临时记录.md` §二）

- **history 作用域不超过当前团队**：只读当前 `team.json` + 当前团队 `inbox/*.jsonl`；不碰 `archive/`，不跨实例
- **主会话不查看子会话预算**：只保证子会话静默压缩后仍能干活
- **笔记按工作区/团队存**（跨会话）；**窗口编号按 session 存**（不跨聊天界面）；两者键不同
- **检索语义 = 区分大小写的字面包含**，不引入向量检索（Codex 两套检索同为 `.contains()`：`codex-rs/ext/memories/src/local/search.rs:288`、`codex-rs/ext/history-notes/src/tools.rs:181`）【源码】

### 1.3 不做

- 不替换、不包装宿主压缩服务（宿主层根本拿不到，见 §3.2）
- 不写 `team.json`（它由 agent-teams 在进程内锁 `withTeamLock` 下原子重写，`dsh-agent-teams/src/state.ts:294` `atomicWriteText(join(stateRoot, state.id, 'team.json'), …)`；外部写会与之竞态）【源码】
- 不发明服务端索引生成器（DSH 无对等物，`临时记录.md` §10.8.4）

---

## 2. 装载方式与配置 schema

### 2.1 装载形态【源码】

照抄 agent-teams 自身的装载形态：

- `package.json` 声明 `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`（agent-teams 同款：`dsh-agent-teams/package.json` `dsh.bundle.patch`；宿主文档模板 `packages/preset/agent-preset/skills/editing-cordis-compositions/SKILL.md:20-30`）
- 安装：`dsh plugin --profile <name> add <包名或本地路径>`，由它 pnpm 安装并把包写进 profile 的 `dsh.profile.bundles` 层列表（`dsh-agent-teams/cordis.patch.yml:7-9` 注释原文）
- 本插件自带的 `cordis.patch.yml`：

```yaml
- insert:
    - id: agent-teams-context
      name: '@your/dsh-agent-teams-context'
      config:
        stateDir: .agent-teams      # 必须与 agent-teams 行的 stateDir 一致
        tokenBudget: true
        notes: true
        history: true
```

Loader 语义（`packages/preset/agent-preset/skills/cordis-composition-reference/SKILL.md:14-21`）：

- `insert: [rows]` 追加行；**只有** `group: true` 的行才接受「按 id 插入其内部」
- 不带 `insert`、只带 `id` 的补丁**整行替换**该行字段，`config` **整体替换、不深合并**
- `disabled` 接受布尔 / `!!js` 表达式，每次挂载决策时求值

由此得到：

| 操作 | 做法 |
|---|---|
| 安装 | `dsh plugin add`（bundle 层插入 `agent-teams-context` 行） |
| 整体关闭（保留安装） | profile 的 `cordis.patch.yml` 写 `- id: agent-teams-context` + `disabled: true` |
| 单项开关 | profile 里按 id 覆盖该行，**必须重述完整 `config`**（含 `stateDir` 与三个开关），否则未写的键回到默认 |
| 卸载 | `dsh plugin remove`（或删除 bundle）【推断：命令名未在本次源码取证中核对】 |

**位置只能是宿主层**：本插件不能插进 preset 内部——preset 的插件列表是 `@deepseek-ai/dsh-agent-preset` 行 `config.plugins` 里的值，不是 Loader 的 `group: true` 行；要改它只能整份重述 preset 声明（`editing-cordis-compositions/SKILL.md:54-66`），这正是 `临时记录.md` §14.1 降阈值实验踩到的坑【运行态】。宿主层也是 agent-teams 自己的位置（`dsh-agent-teams/src/index.ts:14-17`「mounts this plugin row into the host composition … so the plugin needs no realm」）。

### 2.2 配置 schema（Schemastery）

```ts
export const name = 'agent-teams-context'
export const inject = ['systemPrompt', 'tools', 'tokenMeter', 'sessionProjections', 'agents']
// 绝不能出现 'compaction'：见 §3.2

interface Config {
  stateDir: string            // 默认 '.agent-teams'；与 agent-teams 行保持一致
  tokenBudget: boolean        // 默认 true
  notes: boolean              // 默认 true
  history: boolean            // 默认 true
  scope: 'team' | 'all'       // 默认 'team'：三能力只对能解析出团队身份的会话生效；'all' 仅影响 tokenBudget（见 §7-5）
  budget?: {
    remindAtRemainingRatio: number   // 默认 0.2：距「压缩触发点」剩余 ≤ 20% 时开始提示
    buckets: number[]                // 默认 [0.2, 0.1, 0.05]：提示文本只在跨档时变化
    thresholdRatio: number           // 默认 0.8 —— 镜像 compaction-basic 默认（`compaction-basic/README.md:62`）
    headroomTokens: number           // 默认 65536 —— 同上
    outputReserveTokens?: number     // 缺省时触发点只按 W × thresholdRatio 估算
    tool: boolean                    // 默认 true：注册 context_remaining 工具
  }
  notesOptions?: {
    maxFileBytes: number             // 默认 10000（照 Codex memory_summary 硬上限）
    hintMaxBytes: number             // 默认 4000（照 Codex thread hint 上限）
  }
  historyOptions?: {
    maxResults: number               // 默认 200
    maxReadChars: number             // 默认 20000
    maxListItems: number             // 默认 2000
  }
}
```

- **三个开关只决定「是否注册」**：注册发生在插件 `apply()` 时，一次性完成；运行中**不按团队状态增删工具或 section**。理由：工具声明变化会迫使新 request series、头部合并（`packages/core/agent-loop/src/agent.ts:416-421` `startsSeries: … || (preparedCall?.toolUpdate === undefined && this.toolsChanged(assembly.tools))`）。【源码】
- 镜像阈值的局限：插件在宿主层**读不到** preset 内 compaction-basic 的实际配置（`modelPolicies`、`thresholdRatio` 等）。镜像值与实际不一致时，提示的「剩余」会偏。**`临时记录.md` §十四 的 0.5 测试覆盖目前仍在 profile 里**，PoC 前必须先回退或在镜像里同步填 0.5。【推断】

### 2.3 生效与热重载

- profile 配置默认热重载（`packages/bundle/base/cordis.patch.yml:28-32` `- id: hmr` 注释「Profile configuration reloads by default」）【源码】
- 但「已存在的会话及其子会话保留启动时的插件修订」（`editing-cordis-compositions/SKILL.md:74`）。§14.5 实测「阈值改动热生效」是**运行期配置**，与「插件修订」可能不是一回事（`临时记录.md` §14.9.3 未证死）⇒ **开关切换对已存在会话是否生效，列为 PoC-7**。【推断】

---

## 3. 宿主扩展点（逐个核对）

### 3.1 可用

| 扩展点 | 锚点 | 本插件用途 |
|---|---|---|
| `inject` 声明依赖 | agent-teams 范例 `dsh-agent-teams/src/index.ts:56` `export const inject = ['tools', 'llm', 'subagents', 'systemPrompt', 'agents']` | 同法声明 |
| `ctx.systemPrompt.section({name, order, text})` | `packages/core/system-prompt/src/index.ts:474`；`PromptSection` `:53-77`；`text` 可为 `(context) => string` `:66` | 稳定文本（角色化的工具用法、笔记路径指针） |
| `ctx.systemPrompt.context({name, order, text, required?})` | `system-prompt/src/index.ts:509`；`PromptContext` `:78-90`「Dynamic model context materialized as a durable user-role snapshot」 | 窗口级/阈值级动态文本（预算提示、笔记 hint） |
| `AssembleContext.agent` | `packages/core/agent/src/runtime-types.ts:18-23` `agent?: Agent` | 在 `text(ctx)` 里区分会话 |
| `ctx.tokenMeter.measure(session).totalTokens` | `packages/llm/token-meter/src/index.ts:94-97`（`declare module`）、`:146`（`measure`）；宿主层（`packages/bundle/web-app/cordis.patch.yml:520-525`） | 当前压力（与 compaction-basic 同源：`compaction-basic/src/index.ts:277-278`） |
| 会话投影 `contextPressure` | `token-meter/src/projection.ts:30-48`（`pressureTokens` / `projectedTokens` / `contextWindow`）、键 `:68-75` | 取路由容量 `W`（同步） |
| `ctx.sessionProjections.register / stateOf` | `packages/session/session-projection/src/index.ts:233-291`、`:320`；范例 `packages/session/working-directory/src/index.ts:82-89` | 每会话窗口计数（可随日志重放） |
| `ctx.on('session/event', (session, event) => …)` | `packages/core/session/src/index.ts:74`；compaction-basic 同款监听 `compaction-basic/src/index.ts:184` | 观察 `compaction/end`、`agent-teams/*` 事件 |
| `ctx.on('agent/created', …)` | `runtime-types.ts:261`；agent-teams 兼容封装 `dsh-agent-teams/src/harness-compat.ts:110-121` `onAgentReady` | 首次请求前确定会话角色 |
| `ctx.tools.register(defineTool({...}))` | agent-teams 范例 `dsh-agent-teams/src/tools.ts:923`（`import { defineTool } from '@deepseek-ai/dsh-tools'` `:17`）；工具执行上下文 `exec.agent`（`tools.ts:161-166`） | notes / history / context_remaining 工具 |
| `agent.ctx.tools.restrict({deny})` | agent-teams 范例 `dsh-agent-teams/src/capabilities.ts:93-95` | v1 **不用**（团队身份在首次请求前可能不可知，见 §4.0.2）；留作 PoC-3 之后的收紧手段 |

### 3.2 不可用 / 不该用

| 扩展点 | 原因 | 锚点 |
|---|---|---|
| `ctx.compaction` | web profile 下宿主层 `compaction-basic` 行 `disabled: true`，真实实例在 preset 的 `isolate: { compaction: true }` 组里；宿主层插件 inject 它会**永远挂起** | `web-app/cordis.patch.yml:527-528`、`presets/standard.patch.yml:66-71`；`compaction/src/index.ts:111-119`「Load one implementation per context」 |
| 压缩专用 ctx 事件 | 宿主在 `Events` 上只声明了 `compaction/summary-error`；`compaction/start|summary|end|prune` 是**会话日志事件**（log-only） | `compaction/src/index.ts:88-107`、`compaction/src/types.ts:17-90` |
| `session.ownEvents()` / `snapshotEvents()` / `eventAt()` | 宿主标为 `@deprecated`：「new calls are prohibited」 | `packages/core/session/src/index.ts:706-742` |
| developer 角色通道 | DSH 没有；对等物是 `systemPrompt.context()` 的 user 角色快照 | `system-prompt/src/index.ts:78` |
| agent-teams 内部函数（`readTeamSync`、`leadIdentityOf`…） | 包 `exports` 只有 `.` 与 `./client`，入口只导出 `name/inject/Config/usageSectionText/apply`；内部函数**不是公共 API** | `dsh-agent-teams/package.json` `exports`；`src/index.ts:55-193` |

### 3.3 两条注入通道的精确行为【源码】

**A. system section**（`systemPrompt.section`）

- 每步 `assemble()`（`agent-loop/src/agent.ts:272`），渲染后由 `SystemPromptProjection.project` 决定是否改写（`agent-loop/src/runtime-context.ts:88-103`）
- 非 in-history 路由 / 新 series：清空后续 system 节点，`head.text !== rendered` 才改写 head（`:95-99`）
- 压缩**从不**把 surface 第 0 个 system 节点纳入范围（`compaction-basic/src/region.ts:121-131`），也不主动触发改写（`临时记录.md` §5.4.1【运行态】）
- 改写 head = 该节点从第一个 token 起与旧请求不同（`agent-loop/README.md:164`）

**B. 运行时上下文**（`systemPrompt.context`）

- 所有已注册 context 按 `order` 合并为**一条** `source.kind = 'runtime-context'` 的 user 消息（`runtime-context.ts:152-163`）
- 准入时 `refreshContext` 重算 provider 文本（`system-prompt/src/index.ts:578-604`；调用点 `agent.ts:411-413`），**与上次保留值相同则不追加**（`runtime-context.ts:155`）
- 不同则**追加**一份新快照（`agent.ts:436-438` `surfaceOp: 'append'`）；**旧快照不删除**，留在历史直到被压缩
- 被压缩替换后 `retained` 置空（`runtime-context.ts:134-143`），下次准入**自动补回**（README `:120`「restores removed runtime context」）
- 已占用的 order：`WORKING_DIRECTORY 100`、`SANDBOX_POLICY 110`、`APPROVAL_POLICY 115`、`SUBAGENT_DELEGATION 120`（`system-prompt/src/index.ts:170-175`）
- 部署可设 `includeRuntimeContext: false` 压掉非 `required` 的 context（`system-prompt/README.md:47`；`index.ts:610-686`）

⇒ **两条通道都跨压缩存活，都在文本不变时零事件**。区别：A 改动会改写 system 头；B 改动会追加一份完整快照（含工作目录、沙箱等全部 context）。**所以每步都变的数值两条都不能直接放，必须量化成「只在跨档时变」**——这一条与缓存论无关，只由负载累积决定。

### 3.4 插件自行 append 消息（不采用）

`agent/pre-step` 返回 `messages: [...decision.messages, createUserMessage(...)]`（`dsh-time-context` 范例：`packages/context/time-context/src/index.ts:185-240`）可以注入，但这类消息被压缩替换后**不会补回**。本插件不用它承载任何需要跨窗口的内容。

---

## 4. 三个能力

### 4.0 公共底座

#### 4.0.1 会话 → 团队身份解析

agent-teams 没有公共 API，本插件**按其磁盘格式自行解析**（只读）：

1. `stateRoot = join(agent.session.header.cwd ?? process.cwd(), config.stateDir)`（与 agent-teams 完全一致：`capabilities.ts:27-29`；注意用的是会话头 `cwd`，不是后来 `working-directory/change` 后的目录）
2. 列 `stateRoot` 下目录，跳过 `archive` 与以 `.` 开头的目录（agent-teams 跳过 `archive`：`capabilities.ts:42`）
3. 读 `<dir>/team.json`；无文件即跳过（agent-teams 同样把 ENOENT 当「不是团队」：`state.ts:271-286`）
4. **成员判定**：`team.members.some(m => m.id === agent.id)` ⇒ 成员，`agentKey = m.name`（`types.ts:263-266`：`id` = 持久子代理会话 id，`name` = 成员名）
5. **队长判定**：`team.captainSessionId === agent.id`（`types.ts:364`）⇒ `agentKey = 'captain'`（`state.ts:52` `CAPTAIN_KEY`）。agent-teams 还承认「队长的 fork 后代」为 lead（`lineage.ts:162-175` `teamLeadMatch`），本插件 v1 **不复刻祖先链**，只认精确 id；fork 后代按非团队处理【推断：影响面需 PoC-3 确认】
6. 命中多个团队 ⇒ 视为无团队并 `logger.warn`（agent-teams 在此抛 `ambiguous AgentTeams membership`，`capabilities.ts:46`）
7. 解析在 `agent/created` 时做一次并缓存；之后由 `session/event` 中的 `agent-teams/member-added|member-removed|team-created|team-deleted`（`dsh-agent-teams/src/event-types.ts:111-161`，追加到**队长**会话，`events.ts:1-9`）触发失效重算

**失败回退**：任何读/解析异常 ⇒ 当作非团队会话、只打 warn。理由：section/context 的 `text()` 在 `assemble()` 内同步执行，**抛异常会让整步组装失败**（`system-prompt/src/index.ts:658` `typeof section.text === 'function' ? section.text(context) : …`，无 try/catch）。agent-teams 自己也是「damaged state must not disable ordinary conversation」（`capabilities.ts:73-77`）。【源码】

#### 4.0.2 工具可见性与「后来才成为队长」

工具集按 agent 在首次请求前一次定案（§5-3），而团队身份在那一刻可能还不可知：

- 队长通常是**先普通对话、后来才建团队**的顶层会话；
- 成员在 `agent/created` 时未必已写进 `team.json`——agent-teams 自己靠进程内的 `isPendingMember(agent)` 补这个时间差（`capabilities.ts:68`，来自 `registerAgentTeamsTools` 的运行时状态，`index.ts:96-100`），本插件拿不到这个内部状态。

因此 **v1 不做 `restrict`**：本插件工具在所有会话可见，无团队时调用返回「当前会话不属于任何 AgentTeams 团队」。代价是非团队会话的工具目录多 2–3 个 schema（`scope: 'all'` 时 `context_remaining` 本就该全局可见）。PoC-3 若证实成员在 `agent/created` 时已在 `team.json` 中，可再对「非成员子代理」启用 `restrict`。

section / context 的 `text()` 对无团队会话返回空串；队长建团后文本变化**一次**（一次 head 改写或一次快照追加），属可接受代价，计入 §7-1 两个分支的成本。

#### 4.0.3 窗口计数

- 注册会话投影 `agentTeamsContextWindow`：`init` = 0，`apply` 遇到 `compaction/end` 且无 `error` 字段时 +1（事件形状 `compaction/src/types.ts:72` `{ compactionId, sourceCommandId?, turn, error? }`）
- 键 = 会话（投影天然按 session 隔离）⇒ 满足「窗口编号按 session 存」
- 手动 `/compact` 与自动压缩都计（两者同为 `compaction/start…end`，区别仅 `sourceCommandId`）
- fork 子会话的日志开头含祖先的压缩事件逐字副本（`packages/core/session/src/fork.ts:21-30` `events.slice(0, boundary + 1)`）⇒ 投影重放会把它们算进去。是否扣除继承部分见 §7-9
- v1 **不向模型展示窗口编号**（沿用 `临时记录.md` §八 6.1 的 v1 决定），只作为 notes hint 的刷新闸门；最终版是否展示、放哪条通道见 §7-1

### 4.1 tokenBudget

**目的**：让会话在自动压缩前知道「快到点了」，有机会先把进度写进笔记。DSH 压缩是静默的（摘要提示词要求「Do NOT mention … that the context was compacted」，`compaction-basic/src/summarizer.ts:64`；外壳要求「without acknowledging this checkpoint」，`:70-71`），模型自己不会知道。【源码】

**Codex 参照的真实形态**：不是常驻额度面板，而是**每窗口最多一次**的阈值提醒——`base_window_tokens_remaining <= reminder_threshold_tokens` 时追加一条 developer 消息 `TokenBudgetReminder`（`codex-rs/core/src/session/token_budget.rs:178-197`），`advance()` 换窗时复位（`codex-rs/core/src/state/auto_compact_window.rs:77-89`）；另有受 `Feature::TokenBudget` 门控的 `get_context_remaining` 工具。【源码】

| 项 | 设计 |
|---|---|
| 数据 | `P = ctx.tokenMeter.measure(session).totalTokens`；`W = stateOf(session, 'contextPressure').contextWindow`；触发点估算 `T = floor(min(W × thresholdRatio, W − outputReserveTokens − headroomTokens))`（公式照 `compaction-basic/README.md:62`；未配 `outputReserveTokens` 时取 `W × thresholdRatio`） |
| 剩余 | `R = max(0, T − P)`；比例 `r = R / T` |
| 注入位 | `systemPrompt.context({ name: 'agent-teams-context:budget', order: 130 })`（排在 `SUBAGENT_DELEGATION 120` 之后） |
| 文本 | `r > remindAtRemainingRatio` ⇒ **空串**（空 context 不贡献内容，`system-prompt/src/index.ts:84`）；否则按 `buckets` 取所在档，渲染「本窗口距自动压缩约剩 ≤{档位}%」+（`notes` 开启时）「请先用 team_notes 记录进度」。**只在跨档时文本变化** ⇒ 每窗口至多 `buckets.length` 次快照追加 |
| 工具 | `budget.tool = true` 时注册 `context_remaining`：只读调用者自身会话（`exec.agent.session`），返回 `{pressure, contextWindow, estimatedTrigger, remaining, estimated: true}`；**不能指定其他会话**（与 Codex `get_context_remaining` 一致，`codex-rs/core/src/tools/handlers/get_context_remaining.rs:85-93`） |
| 存储键 | 无持久状态（全部由 token-meter 与投影即时算出） |
| 作用域 | 单个 session；`scope: 'team'` 时只对能解析出团队身份的会话生效 |
| 与压缩交互 | 压缩后 `P` 骤降 ⇒ 文本回到空串 ⇒ 追加一份「不含预算段」的快照（每窗口一次）；本插件**不触发、不阻止、不改动**压缩 |
| 失败回退 | `W` 缺失（路由未声明容量）或 `measure` 抛错 ⇒ 空串；工具返回 `remaining: null` 与原因 |

**口径声明**：token-meter 文档明说这些数值是「user-facing reference, not a billing or gating input」（`token-meter/src/projection.ts:25-28`）。t6 曾以「插件自算会与宿主双口径」为由不建议照搬（`context-compare/t6-improvement-plan.md` §3 第 4 行）——本设计直接读宿主同一个 `tokenMeter`，`P` 与 compaction-basic 同源，**只有 `T` 是镜像估算**，这是唯一的口径差，已在工具返回里标 `estimated: true`。【源码 + 推断】

### 4.2 notes

#### 4.2.1 存储键与目录【源码】

```
<cwd>/.agent-teams/.context/
  notes/
    workspace.md                    ← 工作区共享层（跨实例；照 Codex memory_summary 的「合并层」）
    teams/<teamId>/<agentKey>.md    ← 每成员原始层（照 Codex 「每 thread 一行」的下层）
```

选址理由：

- `.agent-teams/` 前缀被 agent-teams 质量闸门**默认排除**（`dsh-agent-teams/src/quality-gates.ts:299-309` `segments[0] === '.agent-teams'`），制品审计不会走进去 ⇒ 写笔记**不会**让已通过的交付审计因「范围内出现新文件」而失效（审计会读取 verdict 绑定的整个 scope，`workspace-audit.ts` 头注释「a new file cannot slip into a broad scope」）
- `.context` 以 `.` 开头，`sanitizeKey` 产出的 teamId 永远不会以 `.` 开头（`state.ts:120-130`：非字母数字替换为 `-` 并去掉首尾 `-`）⇒ 不会与团队目录撞名
- 该目录无 `team.json`，agent-teams 的团队扫描把它当「不存在的团队」跳过（`state.ts:271-286`；活动面板 `snapshot.ts:252-262` 同理）
- 归档只搬 `<teamId>/` 目录（`state.ts:1153-1161` `archiveTeamDir`），`.context/` 不受影响 ⇒ 团队归档后笔记仍在工作区
- 键用 **成员名** 而非 sessionId：成员会话被重派/重生后（新 session）仍落同一文件，满足跨会话

#### 4.2.2 机制

| 项 | 设计 |
|---|---|
| 写入 | 注册**一个**工具 `team_notes`，`action ∈ {list, read, write, append, search}`（单工具多 action，控制工具目录规模；Codex 为 5 个 namespaced 工具，`codex-rs/ext/history-notes/src/tools.rs:37-41`）。相对路径落在调用者自己的 `teams/<teamId>/<agentKey>.md`；`workspace.md` 用固定名访问；禁止 `..` 与绝对路径（照 Codex 虚拟路径规则，`tools.rs:28`） |
| 为何不用通用 `write` | ① `write` 只有全量替换，无追加（`packages/fs/tool-fs/src/write.ts:76-82`）；② 成员若有 `allow` 型工具策略，通用 fs 工具可能被裁掉（`dsh-agent-teams/src/tool-policies.ts:17-24`）——本插件工具同样会被裁，见 §5-2；③ 走插件工具可在写入点强制大小上限 |
| 上限 | 单文件 `> maxFileBytes`（默认 10,000 B，照 Codex `memory_summary.md` `< 10_000` 硬校验，`codex-rs/memories/write/src/workspace.rs:120`）⇒ **拒绝写入**并提示精简，不静默截断 |
| 并发 | 同一文件的 write/append 在进程内串行；跨进程「最后写入赢」（`临时记录.md` §八 6.2 已接受）。DSH `edit/write` 的 `FS_STALE_VERSION` 守卫不覆盖本插件工具【推断】 |
| 指针注入（稳定） | `systemPrompt.section({ name: 'agent-teams-context:notes', order: 620 })`（紧随 `TEAM_POLICY 600`，`system-prompt/src/index.ts:135`）：渲染「你的笔记文件 `teams/<teamId>/<agentKey>.md`；共享笔记 `workspace.md`；用 team_notes 读写」。文本只依赖 `(teamId, agentKey)`，**每会话首次渲染后不再变** ⇒ 零事件 |
| hint（窗口级） | 「最近改动的笔记文件 ≤5 个 + 行数/字节数」，形态照 Codex 夹具 `"Recent notes (up to 5, most-recent first):\n- … (2 lines, 14 UTF-8 bytes)"`（`codex-rs/ext/history-notes/tests/history_notes_extension.rs:48`）。**只在窗口计数变化时重算**（照 Codex hint 只在重建初始上下文时取一次，`临时记录.md` §10.8.3），超过 `hintMaxBytes` ⇒ **整条不注入**（照 Codex `text.len() > MAX_THREAD_HINT_BYTES` 判失败，`extension.rs:140-143`）。注入通道见 §7-1 |
| 不抄契约 | 契约以 `team.json` 为准，不复制进笔记（`临时记录.md` §八 6.2） |
| 作用域 | 读：同团队所有成员文件 + `workspace.md`（Codex 也允许跨 agent 读，`tools.rs:28`）；写：仅自己的文件 + `workspace.md` |
| 与压缩交互 | 笔记在磁盘，压缩不碰；指针在 system 头，压缩不碰；hint 在压缩后的下一次准入重算 |
| 失败回退 | 无团队身份 ⇒ 工具返回说明性错误（§4.0.2）；目录不可写 ⇒ 工具返回错误，不影响对话 |

**参照对象要分清**：Codex `notes.*` 是**单 rollout 内**跨窗口私有笔记（`tools.rs:28`「survive context-window transitions within this rollout」）；**跨会话**的是另一套 `memories`。本设计的分层借 memories（每实体一份 + 合并层 + 双重硬上限），注入形态借 notes hint（只给指针）。合并层 `workspace.md` 的**自动合并**（Codex phase2 consolidation）**v1 不做**，由模型显式维护；是否做见 §7-3。

### 4.3 history

| 项 | 设计 |
|---|---|
| 数据源 | 当前团队的 `team.json` 与 `inbox/*.jsonl`；**不读** `archive/`、不读其他团队 |
| 工具 | **一个**工具 `team_history`，`action ∈ {list, read, search}`：`list` = 任务列表（id/subject/status/assignee/attempt）+ 各信箱条数；`read` = 单个任务的契约字段（`objective/inScope/acceptance/deliverables`，`types.ts:195-201`）与 `output`、或某信箱第 N..M 条；`search` = 在任务字段与信箱 `content` 上做**区分大小写字面包含** |
| 分页上限 | 结果 ≤ `maxResults`（200）、单次读 ≤ `maxReadChars`（20,000 字符）、列表 ≤ `maxListItems`（2,000）——数值沿用 `临时记录.md` §八 6.3 记录的 Codex 上限，单位从 token 改为字符（本地无分词器）【推断】 |
| 读一致性 | `team.json` 与信箱都由 agent-teams 以 `atomicWriteText` 整文件原子替换（`state.ts:294`、`:447`、`:514-542`）⇒ 无锁读取只会读到某个完整版本，不会读到半截 |
| 信箱字段 | `{id, from, to, content, ts, deliveredAt?, readAt?, taskId?, attemptId?, discardedAt?…}`（`types.ts:310-333`）；`discardedAt` 存在的条目默认不返回 |
| 已知缺口 | 重试会清空上一 attempt 的 `output/verdict/findings/changedPaths/acceptanceResults/commandsRun`（`state.ts:172-179` `clearAttemptResult`）⇒ history **拿不到旧 attempt 的结果**，只能从信箱回报里找 |
| 作用域 | 团队级（解析见 §4.0.1）；成员与队长读同一份 |
| 与压缩交互 | 纯拉取，无注入，压缩无影响；能力说明放在 notes 同一条稳定 section 里（或 history 自己的稳定 section，二者择一以免多一个 section） |
| 失败回退 | `team.json` 解析失败 ⇒ 返回错误与路径，不抛到组装层；单个信箱坏行 ⇒ 跳过并在结果里计数 |

**不在 v1 范围**：本会话被压缩掉的原始对话（只能经已弃用的 `eventAt/snapshotEvents` 或 `session-query` 读取），见 §7-8。

---

## 5. 与 dsh-agent-teams 的耦合面与风险

1. **磁盘格式耦合**：本插件依赖 `team.json` 的 `captainSessionId / members[].id / members[].name / tasks[]` 与信箱 JSONL 行格式（`types.ts:263-266`、`:310-333`、`:354-368`）。agent-teams 升级可能改格式 ⇒ `peerDependencies` **精确钉** `@nanmicoder/dsh-agent-teams@0.1.23`，升级时重跑 PoC-3/PoC-5。【源码】
2. **成员工具策略**：部署方可给成员配 `allow` 型 `toolPolicies`，只保留列出的全局工具（`tool-policies.ts:17-24`、`:54-57`）⇒ 未列入的 `team_notes` / `team_history` / `context_remaining` 会被裁掉。文档必须提示：用 `allow` 策略时把这三个名字加进去。【源码】
3. **成员工具过滤的时机**：agent-teams 在成员首次请求前用 `restrict` 固定工具集，并强调「Team creation/archive must never rewrite the captain's system/tools prefix」（`capabilities.ts:65-67`、`:93-95`）。本插件若日后启用 `restrict`，也必须在 `agent/created` 时一次定案，不得事后增删。【源码】
4. **前缀稳定是上游的显式设计价值**（事实陈述，不作裁决）：agent-teams 把队长 prompt 一次性快照（`capabilities.ts:57-59`）；宿主 plan-mode 文案写明「The tool catalog stays the same across modes for request-cache stability」（`presets/standard.patch.yml:59`）；压缩摘要请求刻意复用前缀以命中 KV cache（`compaction-basic/src/summarizer.ts:28-31`）。这些是 §7-1 两个分支的背景事实。【源码】
5. **宿主版本**：agent-teams 0.1.23 不声明支持 `0.2.1-alpha.2`（§0-2）。本插件 PoC 必须在 agent-teams 支持的宿主（推荐 `0.2.0-rc.2`，即本机安装版）上做。【源码】

---

## 6. PoC 验证清单

每项给出可证伪的观测点。前置：**先按 `临时记录.md` §14.3 回退降阈值覆盖**（或把镜像阈值同步为当前值），否则 PoC-4 的数值无意义。

| # | 要证什么 | 观测 / 判据 | 依赖的推断 |
|---|---|---|---|
| PoC-1 | 宿主层插件 `inject: ['systemPrompt','tools','tokenMeter','sessionProjections','agents']` 能激活，不挂起 | `plugin_manager list_plugins` 显示 `agent-teams-context` 已激活（`editing-cordis-compositions/SKILL.md:74`）；故意加入 `'compaction'` 的对照版应**不激活** | §3.2 |
| PoC-2 | 宿主层注册的 section 与 context 出现在 **preset 会话**与**成员子会话**的请求里 | 解码会话日志：`system/message` 文本含 `agent-teams-context:notes` 段；`source.kind='runtime-context'` 的 user 消息含预算段 | agent-teams usage section 同法工作（强推断） |
| PoC-3 | 团队身份解析与 agent-teams 判定一致；成员在 `agent/created` 时是否已写入 `team.json` | 对每个成员/队长会话，本插件解析出的 `(teamId, agentKey)` 与 `agent_teams_status` 一致；队长 fork 后代按设计判为非团队；记录成员 `agent/created` 时刻 `team.json` 中是否已有其 `members[].id` | §4.0.1-5、§4.0.2 |
| PoC-4 | 预算提示在跨档时出现、压缩后消失，且每窗口快照追加次数 ≤ 档数 + 1 | 低阈值下跑长任务：统计两次 `compaction/end` 之间 `runtime-context` user 消息条数 | §4.1 |
| PoC-5 | 运行时上下文被压缩替换后自动补回（本插件依赖的核心机制） | 压缩后的第一条请求前出现新的 `runtime-context` 快照，且其 seq 晚于 checkpoint 的 replace 事件 | §3.3-B（源码已读通，缺运行态） |
| PoC-6 | 笔记写入不影响交付审计 | 某任务通过质量闸门后，成员调用 `team_notes write`；再跑 `agent_teams_status`，审计结论不变 | §4.2.1 |
| PoC-7 | 开关切换对已存在会话是否生效 | 改 profile 覆盖关掉 `notes`，看**已存在**会话的下一次请求工具列表是否变化；新会话对照 | §2.3 |
| PoC-8 | 子会话在压缩后是否真的去用 notes / history（行为，不是能力） | 统计压缩后 N 步内 `team_notes read` / `team_history` 调用；对照组关闭预算提示 | `临时记录.md` §九-2、§十三-5 |
| PoC-9 | 镜像触发点与实际触发点的偏差 | 记录 `compaction/start` 前一步本插件算出的 `R`；理想值接近 0 | §2.2 |

---

## 7. 未决问题（需用户裁决）

### 7-1. 缓存论是否整体排除（`临时记录.md` §14.9.5.4，本文件**不下结论**）

它直接决定「窗口级变化的文本（窗口编号、notes hint）放哪条通道」。每步都变的数值不受影响——无论哪个分支都要量化，理由是 §3.3 的负载累积，与缓存无关。

| | 分支 A：缓存整体排除出设计依据 | 分支 B：只排除跨窗口缓存，窗口内前缀复用仍算 |
|---|---|---|
| 判据还剩什么 | 负载是否随变化累积、事件数 | 上述两条 + 窗口内前缀复用 |
| 窗口编号 / notes hint 放哪 | **system section 即可**：每窗口改写一次 head，一条事件，负载恒定（就地改写不累积） | **运行时上下文**：不动 system 头；每窗口追加一份快照（含全部 context），压缩时被一起收走 |
| 代价 | 每次压缩后 system 头从第一个 token 起与上次请求不同（`agent-loop/README.md:164`），抵消宿主「摘要复用前缀」的设计（`summarizer.ts:28-31`）；在 in-history 路由上则变为追加、每个版本都重发直到被压缩（README `:160`） | 每窗口多一份 context 快照的负载；运行时上下文可被部署整体压掉（`includeRuntimeContext: false`，需设 `required: true` 对抗） |
| 对 §八「稳定内容走 system」的影响 | 不变 | 不变；但「窗口编号属于稳定内容」这一归类不再成立，要改归「窗口级动态内容」 |

两分支下**相同**的部分：指针 section（只依赖 teamId/agentKey）走 system；预算提示走运行时上下文且量化。

### 7-2. 「本任务是否经过压缩」的回传落点（`临时记录.md` §十三-1）

候选原是 `team.json` 的 `supplementalEvidence` / `TaskEvidence.note` / 消息。**新约束**：本插件不能写 `team.json`（§1.3）。可选：(a) 本插件自有文件 `.agent-teams/.context/compactions/<teamId>.jsonl`（键 `sessionId + compactionId`），由 `team_history` 暴露；(b) 在预算/hint 文本里提示成员在 `agent_teams_update_task` 的证据字段里自报（依赖模型自律）；(c) 不做。

### 7-3. 笔记粒度与合并（`临时记录.md` §十三-2）

v1 = 每成员一份 + `workspace.md` 由模型显式维护。是否加「自动合并层」（照 Codex phase2：后台模型把各成员笔记合并进 `workspace.md`，带 `< 10_000` 字节硬上限）——会引入额外模型调用与费用。

### 7-4. 索引来源（`临时记录.md` §十三-6）

本设计默认组合：稳定路径指针（b）+ 窗口级「最近笔记」清单（从 notes 目录元数据生成，不读 `team.json`）。若用户坚持（a）「从 `team.json` 拼稳定文本」，需定拼哪些字段（任务 id/状态会变，不稳定）。

### 7-5. tokenBudget 是否作用于非团队会话

`scope: 'team'`（默认）只管团队会话；`'all'` 则所有会话都有预算提示。插件名是 teams 补丁，默认取 team。

### 7-6. 三个开关的默认值

「装上即有」⇒ 本文件默认全开。若用户希望「装上后逐项手动开」，默认改为全关。

### 7-7. 触发点镜像

镜像 compaction-basic 配置有漂移风险（§2.2）。替代：只报「距窗口上限 `W` 的剩余」，不估算触发点（不准但不会误导成「还早」）。

### 7-8. history 是否覆盖本会话被压缩掉的原文

需要读会话日志里被 shadow 的事件：宿主相关读接口已弃用（`session/src/index.ts:706-742`），可用的是 `session-query`。超出「团队级 history」的既定作用域，默认不做。

### 7-9. fork 子会话的窗口计数是否扣除继承部分

投影重放会把祖先的压缩事件算进 fork 子会话（§4.0.3）。扣除需要知道继承边界（`session/end-seed`，`fork.ts:24`）。仅影响「是否展示编号」，v1 不展示时可后置。

---

## 8. 与既有文件的关系

- **`临时记录.md` §八**：本文件取代其「初步设计」；§八保留为讨论结论，已在原处标注更正。
- **`临时记录.md` §九**：第 1 条已由源码回答（§3）；第 4 条已与 §5.4.1 对齐；第 2、3 条转为本文件 PoC-8。
- **`context-compare/t6-improvement-plan.md` §3「不建议照搬」**：t6 当时以「DSH 无窗口 id」「宿主不暴露权威额度」为由不建议做 thread hint 与模型可见额度。用户其后明确要求这三个能力（`临时记录.md` §一）。两条理由的现状：窗口 id ⇒ 本插件以「每 session 压缩周期计数」自建（§4.0.3）；额度 ⇒ 直接读宿主 `tokenMeter`，只有触发点是估算（§4.1）。t6 的其余建议（宿主压缩栈按 agent 降档等）不在本插件范围；顺带：compaction-basic 已有**按模型**（非按 agent）的 `modelPolicies` 覆写（`compaction-basic/README.md:75` `modelPolicies` 行），可作为「给成员用的模型单独设阈值」的现成近似。
- **引用行号**：`临时记录.md` 与 `context-compare/*` 中 `@deepseek-ai/*/lib/index.js:N` 形式的引用指向安装版 `0.2.0-rc.2` 构建产物。本次已逐条对照源码语义的有：`project()` 改写条件、`buildForkSeed`、压缩事件 log-only、`systemHead`、`COMPACTION_INSTRUCTION`、`CHECKPOINT_PREAMBLE`、session-reference 的 pre-step/readSurface/检查点识别、`dsh-time-context` 注入方式；语义均成立（`COMPACTION_INSTRUCTION` 段数与格式除外，已在 `临时记录.md` §六更正）。
