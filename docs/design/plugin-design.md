# dsh-token-budget：dsh-agent-teams 上下文补丁插件设计规格（权威版）

本文件是补丁插件的**唯一权威规格**。`临时记录.md` 保留讨论结论与取证细节，`docs/research/context-compare/` 保留两轮比对报告；三者冲突时以本文件为准，并应回头修正另外两处。

**当前版本：0.1.0（v1 基线，2026-10-16 定）**，后续版本在此基础上推进。

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

给 `@nanmicoder/dsh-agent-teams` 做**独立第三方补丁插件**，名称 **dsh-token-budget**（用户 2026-10-14 定名）：

- 形态 = **另一个 dsh 插件**：同一功能两个插件，一个社区原版 agent-teams、一个本补丁包；原插件升级不会覆盖本补丁
- **不修改** agent-teams 源码，也不修改 DSH 任何包
- 以宿主层 Loader 行按 id 装载：**装上即有、卸下即无**；不装 = 原版社区 teams。整体启停由 DSH **插件管理面板**直接管理
- tokenBudget 是本插件的本体（插件启用即生效）；插件内的能力开关为 `notes` / `history`（用户 2026-10-14 决定）与实现时加的 `contextTool`（`context_remaining` 工具），**默认全开**，在设置页切换即时生效
- **只管团队会话**（用户 2026-10-14 决定），非团队会话一律不注入、工具返回说明性错误
- **命名统一为 `dsh-token-budget`**（包名、plugin id、section 名前缀、文档内一切隐式与显式引用；用户 2026-10-14 决定）

### 1.2 硬边界（已确认的用户决定，沿用 `临时记录.md` §二）

- **history 只读调用者自己的会话**（§4.4），成员不读队长继承来的上下文；团队信件回看（§4.3，0.2.0）只读当前团队信箱：不碰 `archive/`，不跨实例
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
    - id: dsh-token-budget
      name: 'dsh-token-budget'
      config:                       # 扁平结构，全部为即时字段（见 §2.2 实现更正）
        stateDir: .agent-teams      # 必须与 agent-teams 行的 stateDir 一致
        notes: true
        history: true
        teamHistory: true           # 0.2.0：团队信件回看（§4.3）
        remindAtRatio: 0.37         # 上下文已用 37% 起提示
        compactAtRatio: 0.45        # 已用 45% 强制换窗压缩（落点见 §2.4）
        bucketStep: 0.03
        contextTool: true
        notesMerge: false
        maxFileBytes: 10000
        hintMaxBytes: 4000
        hintRecentNotes: 5
        historyMaxResults: 200
        historyMaxReadChars: 20000
        historyMaxListItems: 2000
```

Loader 语义（`packages/preset/agent-preset/skills/cordis-composition-reference/SKILL.md:14-21`）：

- `insert: [rows]` 追加行；**只有** `group: true` 的行才接受「按 id 插入其内部」
- 不带 `insert`、只带 `id` 的补丁**整行替换**该行字段，`config` **整体替换、不深合并**
- `disabled` 接受布尔 / `!!js` 表达式，每次挂载决策时求值

由此得到：

| 操作 | 做法 |
|---|---|
| 安装 | `dsh plugin add`（bundle 层插入 `dsh-token-budget` 行） |
| 整体启停（保留安装） | DSH 插件管理面板（等价于 profile `cordis.patch.yml` 写 `- id: dsh-token-budget` + `disabled: true`） |
| 单项开关与数值 | DSH 插件管理面板 → 本行设置页，保存即时生效（宿主写入 profile 的 `cordis.patch.yml`，只写非默认值）。手写 profile 覆盖时注意 `config` 整体替换、不深合并，未写的键回到默认 |
| 卸载 | `dsh plugin remove`（或删除 bundle）【推断：命令名未在本次源码取证中核对】 |

**位置只能是宿主层**：本插件不能插进 preset 内部——preset 的插件列表是 `@deepseek-ai/dsh-agent-preset` 行 `config.plugins` 里的值，不是 Loader 的 `group: true` 行；要改它只能整份重述 preset 声明（`editing-cordis-compositions/SKILL.md:54-66`），这正是 `临时记录.md` §14.1 降阈值实验踩到的坑【运行态】。宿主层也是 agent-teams 自己的位置（`dsh-agent-teams/src/index.ts:14-17`「mounts this plugin row into the host composition … so the plugin needs no realm」）。

### 2.2 配置 schema（Schemastery）

```ts
export const name = 'dsh-token-budget'
export const inject = ['systemPrompt', 'tools', 'tokenMeter', 'sessionProjections', 'agents', 'agentPresets', 'sessions', 'sessionPersistence']
// agentPresets：方案 D1 经 serviceFor(agent,'compaction') 取压缩引擎（§2.4）；sessions / sessionPersistence：只读 history（§4.4）
// llm 不列入：只供可选的 notesMerge（§7-3），调用时 ctx.get('llm') 读取；cordis 4 的 inject 没有 optional 写法，列入即成为整插件的启动前提（2026-10-15，实现 3392547）
// 绝不能出现 'compaction'：宿主层没有该服务，见 §3.2

interface Config {
  stateDir: string            // 默认 '.agent-teams'；与 agent-teams 行保持一致
  notes: boolean              // 默认 true
  history: boolean            // 默认 true
  // 无 tokenBudget 开关：它是插件本体，由插件管理面板整体启停；只作用于团队会话
  budget?: {
    remindAtRatio: number            // 默认 0.37：P / W ≥ 37% 起提示（用户可改）
    compactAtRatio: number           // 默认 0.45：P / W ≥ 45% 换窗压缩（用户可改；落点见 §2.4）
    bucketStep: number               // 默认 0.03：提示文本按 3% 一档量化，只在跨档时变化（37/40/43%）
    tool: boolean                    // 默认 true：注册 context_remaining 工具
  }
  notesMerge?: {
    enabled: boolean                 // 默认 false = 由队长维护 workspace.md；true = 后台模型合并
    provider?: string                // 开启时由用户从 ctx.llm.listProviders() / listModels(provider) 中选
    model?: string
    reasoningEffort?: string         // 取自该模型的 LlmReasoningEffortInfo.efforts
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

- **实现更正（2026-10-14）：配置改为扁平、全部即时字段。** DSH 设置表单只投影 `.volatile()` 字段（`settings/src/schema.ts` `volatileForm`），共享表单模型 `SettingsFormModel` 只按顶层字段读写（路径 `[field]`）。所以对外配置为一层（另有开关 `notes / history / teamHistory`，`teamHistory` 为 0.2.0 新增）：`remindAtRatio / compactAtRatio / bucketStep / contextTool / notesMerge / mergeProvider / mergeModel / mergeReasoningEffort / maxFileBytes / hintMaxBytes / hintRecentNotes / historyMaxResults / historyMaxReadChars / historyMaxListItems`，插件内部换算回上面的分组结构（`src/config.ts` `toSettings`）。保存后宿主经 volatile HMR 更新，数值与合并开关/模型即时生效；`notes / history / contextTool` 开关也即时生效（2026-10-15 改：volatile 更新时注册或注销对应工具与 section，见 PoC-7）。设置页由插件 client 入口注册到 `plugins.row.config`（键 `dsh-token-budget#dsh-token-budget`），模型为级联下拉，选项来自 `ctx.remote.session.modelCatalog()`。已在真实 DSH 0.2.0-rc.2 web 中验证：页面出现、下拉有选项、保存写入 profile 的 `cordis.patch.yml`。
- **开关只决定「是否注册」**：启动时按开关注册，设置页保存（volatile 更新）时注册或注销对应工具与 section（PoC-7）；运行中**不按团队状态增删工具或 section**。理由：工具声明变化会迫使新 request series、头部合并（`packages/core/agent-loop/src/agent.ts:416-421` `startsSeries: … || (preparedCall?.toolUpdate === undefined && this.toolsChanged(assembly.tools))`）。【源码】
- 百分比的分母统一为路由容量 `W`（`contextPressure.contextWindow`），分子 `P` 与 compaction-basic 同源（`tokenMeter`）。compaction-basic 的 `thresholdRatio` 也是 `W` 的比例（`compaction-basic/README.md:62`），口径一致。
- D1 下宿主 compaction-basic 的 `thresholdRatio` 保持默认（约 80%）作兜底，`临时记录.md` §十四 的 0.5 测试覆盖已回退。

### 2.4 「已用 45% 强制换窗压缩」的落点【源码 + 推断】

**DSH 里「换窗」= 摘要压缩**：宿主没有内建的不做摘要、直接开新窗口的路径（`临时记录.md` §五）；但 `summarize()` 是 compaction-basic 公开的定制钩子（`lib/index.js:796`、`:893`），返回模板即可实现零模型换窗，这是 §7-10 的后续版本方案（2026-10-15 勘误）。所以 45% 的含义是「让 compaction-basic 在 `P ≥ 0.45 × W` 时自动压缩」。

**更正（2026-10-14）**：原先认为本插件触发不了压缩，依据是「宿主层拿不到 `ctx.compaction`」。社区调研发现官方通道 `ctx.agentPresets.serviceFor(agent, 'compaction')` 可按 agent 取到 preset 内的压缩引擎（`preset/agent-preset-registry/src/index.ts:319-327`；dsh-session-manager 即用此通道改阈值，`community/dsh-session-manager/src/index.ts:337-357`）。拿到引擎后的公共接口：

- `compactNow` 要求 agent 空闲 ⇒ 长 turn 中不可用
- `compactIfNeeded(agent, 'context-overflow', signal)` 是公共抽象方法（`compaction/src/index.ts:124-140`），但 basic 实现在 overflow 分支以 `retainTokens = 0` 选范围（`compaction-basic/src/index.ts:294-301`、`region.ts:117-121`）⇒ **不保留任何最近原文**，过猛
- `compactRegion(start, end, agent, signal)` 是公共抽象方法（`compaction/src/index.ts:168-190`），范围由调用方给 ⇒ 可按常规保留比例自己算范围

社区插件还有一种做法：直接改共享引擎的 `engine.config.thresholdRatio`（dsh-session-manager）。但 preset 修订被所有选用它的 agent 共享（`editing-cordis-compositions/SKILL.md`「Preset revisions are eagerly activated once and shared」），改了就作用于全部会话，且写的是 `readonly` 字段，不采用。

以下是原分析（方案 A/B/C 仍成立，新增方案 D）：

⇒ **45% 只能落在 compaction-basic 的 `thresholdRatio: 0.45`**。可选落点：

| 方案 | 做法 | 代价 |
|---|---|---|
| **A（用户已选，v1）** | 在 DSH「Agent presets」设置页把 standard preset 内 `compaction-basic` 的 `thresholdRatio` 改为 0.45（页面保存会写 profile 的 preset 覆盖，`bundle/web-app/README.md:89`） | ① **作用于该 preset 的所有会话**，不只团队会话；② 45% 存在两处（preset 与本插件 `compactAtRatio`），要手动保持一致；③ preset 覆盖会冻结整份插件列表，DSH 升级 standard 时需重做（§14.1 已踩） |
| B | 本插件 bundle 再插入一个**自带 preset**（如 `team-budget`），内容 = standard + `thresholdRatio` 取本插件配置；团队任务选这个 preset | 45% 只有一处；但要复制整份 standard 插件列表，上游一改就漂移；队长/成员是否继承 preset 需 PoC |
| C | `modelPolicies` 按模型设 0.45（`compaction-basic/README.md:75`），给成员单独用一个模型路由 | 只有成员与队长用不同模型时才能区分团队会话 |

| **D（用户已选，2026-10-14）** | 宿主层 `agent/pre-step`：仅对团队会话、`P / W ≥ compactAtRatio` 时取 `serviceFor(agent,'compaction')` 主动压缩，见下方「D 的两种调用」 | 45% 只配一处、只作用于团队会话、不改全局配置；宿主 80% 自动压缩保持不动作兜底；需 PoC |

**D 的两种调用**【源码】

| | D1：`compactIfNeeded(agent, 'context-overflow', signal)` | D2：`compactRegion(start, end, agent, signal)` |
|---|---|---|
| 范围 | basic 实现：先跑 tool-result-pruner（无模型裁大工具结果），再 `selectCompactableRange(session, measurement, 0)`（`compaction-basic/src/index.ts:294-301`） | 插件自己算：从 surface 第一个非 system 节点起，向前累加最新节点 token 直到达到保留预算，再回退到工具调用配对平衡的边界（照 `region.ts:117-160` 同法） |
| `retain = 0` 的真实含义 | 循环在第一次迭代就 break，**最后一个 surface 节点永远保留**，再回退到配对平衡处（`region.ts:133-147`）⇒ 不是「一条不留」，而是「只留最后一个节点及其配对」；system 头（节点 0）不动 | 保留量由插件配置 `retainRatio` 决定，设 0 即与 D1 相同 |
| 代码量 | 零范围代码，只用公共接口 | 要复刻范围选择与配对判断，或 import `@deepseek-ai/dsh-compaction-basic/src/region.ts`（包导出了 `./src/*`，但属内部实现，版本耦合） |
| 风险 | 语义借用「overflow」分支，只影响日志文案（`compaction/start` 事件不含 trigger 字段，`compaction/src/types.ts:24`）；若 preset 换了别的压缩引擎，overflow 行为可能不同 | 范围算错会被 `validateSurfaceRegion` 拒绝；自动压缩须在 open turn 内（`region.ts` `compactRegion: no open turn` 检查），pre-step 中满足 |
| 与理念 | 符合「换窗 = 只带摘要 + 笔记 + hint，细节用 history 工具回读」 | 可调成同样效果，也可留一点最近原文 |

**v1 采用 D1**（用户已确认，2026-10-14：与设计理念一致、零范围代码），D2 作为将来需要「保留最近 N% 原文」时的扩展。Codex 本地压缩会保留最近用户原话 ≤ 20,000 token（`codex-rs/core/src/compact.rs:63`）；团队成员的「原话」就是任务契约，已在 `team.json`，且 hint 会带任务 id 与标题，`history` 工具可回读原文，所以不保留最近原文可以接受。

触发点公式是 `floor(min(W × thresholdRatio, W − O − headroomTokens))`（`README.md:62`）：本机 `W = 1,000,000`、`O = 200,000`、`B = 65,536` ⇒ `min(450,000, 734,464) = 450,000`，**45% 起作用**；小窗口路由（如 128k）上 `W − O − B` 可能先于 45% 生效，届时实际触发点更早，插件提示文本里的「45%」会偏。

本插件侧（方案 D1）：`compactAtRatio` 驱动团队会话的主动压缩（`agent/pre-step` 达到 `W × compactAtRatio` 时调 `compactIfNeeded`），同时用于提示文本与 PoC-9 的偏差校验。（方案 A 时期写的是「不驱动压缩」，2026-10-15 勘误）

### 2.3 生效与热重载

- profile 配置默认热重载（`packages/bundle/base/cordis.patch.yml:28-32` `- id: hmr` 注释「Profile configuration reloads by default」）【源码】
- 「已存在的会话及其子会话保留启动时的插件修订」（`editing-cordis-compositions/SKILL.md:74`）指插件修订；本插件配置全部是即时字段，经 volatile 更新到达同一修订。PoC-7 实测：已打开的会话在设置页切换开关后，下一次请求的工具列表即变化。【运行态】

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
| `agent.ctx.tools.restrict({deny})` | agent-teams 范例 `dsh-agent-teams/src/capabilities.ts:93-95` | **不用**：成员创建时还不在 `team.json` 中（PoC-3），首次请求前无法判定身份，见 §4.0.2 |

### 3.2 不可用 / 不该用

| 扩展点 | 原因 | 锚点 |
|---|---|---|
| `inject: ['compaction']` | web profile 下宿主层 `compaction-basic` 行 `disabled: true`，真实实例在 preset 的 `isolate: { compaction: true }` 组里；宿主层插件 inject 它会**永远挂起**。**更正（2026-10-14 社区调研）**：按 agent 取 preset 内服务有官方通道 `ctx.agentPresets.serviceFor(agent, 'compaction')`（`preset/agent-preset-registry/src/index.ts:319-327`「Read a service supplied inside an Agent's isolated preset group」），见 §2.4 方案 D | `web-app/cordis.patch.yml:527-528`、`presets/standard.patch.yml:66-71`；`compaction/src/index.ts:111-119`「Load one implementation per context」 |
| 压缩专用 ctx 事件 | 宿主在 `Events` 上只声明了 `compaction/summary-error`；`compaction/start` / `summary` / `end` / `prune` 是**会话日志事件**（log-only） | `compaction/src/index.ts:88-107`、`compaction/src/types.ts:17-90` |
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
7. **实现（2026-10-15 勘误）**：宿主 0.2.0-rc.2 不认识 `agent-teams/*` 事件类型，下述失效信号收不到；实际改为按需解析并缓存，「非团队」结果只缓存 5 秒，以 `agent_teams_*` 工具调用返回作为失效信号（`src/team/directory.ts`）。原设计：解析在 `agent/created` 时做一次并缓存；之后由 `session/event` 中的 `agent-teams/member-added|member-removed|team-created|team-deleted`（`dsh-agent-teams/src/event-types.ts:111-161`，追加到**队长**会话，`events.ts:1-9`）触发失效重算

**失败回退**：任何读/解析异常 ⇒ 当作非团队会话、只打 warn。理由：section/context 的 `text()` 在 `assemble()` 内同步执行，**抛异常会让整步组装失败**（`system-prompt/src/index.ts:658` `typeof section.text === 'function' ? section.text(context) : …`，无 try/catch）。agent-teams 自己也是「damaged state must not disable ordinary conversation」（`capabilities.ts:73-77`）。【源码】

#### 4.0.2 工具可见性与「后来才成为队长」

工具集按 agent 在首次请求前一次定案（§5-3），而团队身份在那一刻可能还不可知：

- 队长通常是**先普通对话、后来才建团队**的顶层会话；
- 成员在 `agent/created` 时未必已写进 `team.json`——agent-teams 自己靠进程内的 `isPendingMember(agent)` 补这个时间差（`capabilities.ts:68`，来自 `registerAgentTeamsTools` 的运行时状态，`index.ts:96-100`），本插件拿不到这个内部状态。

因此 **v1 不做 `restrict`**：本插件工具在所有会话可见，无团队时调用返回「当前会话不属于任何 AgentTeams 团队」。代价是非团队会话的工具目录多出本插件的 7 个工具 schema（`team_notes`、`team_history`、`context_remaining`、4 个 `history_*`）。PoC-3 已证实成员在 `agent/created` 时**不在** `team.json` 中（agent-teams 在 `startContinuable` 返回后才写 `member.id`，`members.ts:942`），所以维持不做 `restrict`；将来要收紧，需另找身份时序（见后续版本）。

section / context 的 `text()` 对无团队会话返回空串；队长建团后文本变化**一次**（一次 head 改写或一次快照追加），属可接受代价，计入 §7-1 两个分支的成本。

#### 4.0.3 窗口计数

- 注册会话投影 `tokenBudgetWindow`（`src/window/counter.ts`）：`init` = 0，`apply` 遇到 `compaction/end` 且无 `error` 字段时 +1（事件形状 `compaction/src/types.ts:72` `{ compactionId, sourceCommandId?, turn, error? }`）
- 键 = 会话（投影天然按 session 隔离）⇒ 满足「窗口编号按 session 存」
- 手动 `/compact` 与自动压缩都计（两者同为 `compaction/start…end`，区别仅 `sourceCommandId`）
- fork 子会话的日志开头含祖先的压缩事件逐字副本（`packages/core/session/src/fork.ts:21-30` `events.slice(0, boundary + 1)`）⇒ 投影重放会把它们算进去。是否扣除继承部分见 §7-9
- v1 **不向模型展示窗口编号**（沿用 `临时记录.md` §八 6.1 的 v1 决定），只作为 notes hint 的刷新闸门；最终版是否展示、放哪条通道见 §7-1
- **口径差（已知）**：history 工具的窗口编号（§4.4）另按 `compaction/summary` 计数，且成员跳过继承前缀；本投影按成功的 `compaction/end` 计数且含 fork 继承部分。两者目前互不依赖；将来若向模型展示窗口编号，应统一到 history 的口径

### 4.1 tokenBudget

**目的**：让会话在自动压缩前知道「快到点了」，有机会先把进度写进笔记。DSH 压缩是静默的（摘要提示词要求「Do NOT mention … that the context was compacted」，`compaction-basic/src/summarizer.ts:64`；外壳要求「without acknowledging this checkpoint」，`:70-71`），模型自己不会知道。【源码】

**Codex 参照的真实形态**：不是常驻额度面板，而是**每窗口最多一次**的阈值提醒——`base_window_tokens_remaining <= reminder_threshold_tokens` 时追加一条 developer 消息 `TokenBudgetReminder`（`codex-rs/core/src/session/token_budget.rs:178-197`），`advance()` 换窗时复位（`codex-rs/core/src/state/auto_compact_window.rs:77-89`）；另有受 `Feature::TokenBudget` 门控的 `get_context_remaining` 工具。【源码】

| 项 | 设计 |
|---|---|
| 数据 | `P = ctx.tokenMeter.measure(session).totalTokens`；`W = stateOf(session, 'contextPressure').contextWindow`；已用比例 `u = P / W` |
| 阈值 | `remindAtRatio`（默认 0.37）起提示；`compactAtRatio`（默认 0.45）= compaction-basic 实际压缩点（§2.4） |
| 注入位 | `systemPrompt.context({ name: 'dsh-token-budget:budget', order: 130 })`（排在 `SUBAGENT_DELEGATION 120` 之后） |
| 文本 | `u < remindAtRatio` ⇒ **空串**（空 context 不贡献内容，`system-prompt/src/index.ts:84`）；否则按 `bucketStep` 向下取档，渲染「上下文已用约 {档}%，约 {compactAt}% 时会自动压缩」+（`notes` 开启时）「请现在用 team_notes 记下进度与下一步」。**只在跨档时文本变化** ⇒ 默认每窗口至多 3 次快照追加（37/40/43%） |
| 工具 | `budget.tool = true` 时注册 `context_remaining`：只读调用者自身会话（`exec.agent.session`），返回 `{pressure, contextWindow, estimatedTrigger, remaining, estimated: true}`；**不能指定其他会话**（与 Codex `get_context_remaining` 一致，`codex-rs/core/src/tools/handlers/get_context_remaining.rs:85-93`）。**实现**（`src/budget/tool.ts`）：无参数，仅团队会话；`estimatedTrigger = floor(W × compactAtRatio)`，`remaining = max(0, T − P)`；返回给模型的是一句中文文本（已用 P/W、约 x%、预计压缩点、剩余约 n token（估算值）），容量未知时说明原因 |
| 存储键 | 无持久状态（全部由 token-meter 与投影即时算出） |
| 作用域 | 单个 session；只对能解析出团队身份的会话生效（用户决定，无 `scope` 配置） |
| 与压缩交互 | 达到 `compactAtRatio` 时由本插件触发压缩（方案 D1，§2.4；在 `system-prompt/assemble` 瀑布里执行并就地重算本插件的 context）；压缩后 `P` 骤降 ⇒ 文本回到空串 ⇒ 追加一份「不含预算段」的快照（每窗口一次）。本插件不阻止、不改动压缩内容 |
| 失败回退 | `W` 缺失（路由未声明容量）或 `measure` 抛错 ⇒ 空串；工具返回 `remaining: null` 与原因 |

**口径声明**：token-meter 文档明说这些数值是「user-facing reference, not a billing or gating input」（`token-meter/src/projection.ts:25-28`）。t6 曾以「插件自算会与宿主双口径」为由不建议照搬（`docs/research/context-compare/t6-improvement-plan.md` §3 第 4 行）——本设计直接读宿主同一个 `tokenMeter`，`P` 与 compaction-basic 同源，**只有 `T` 是镜像估算**，这是唯一的口径差，已在工具返回里标 `estimated: true`。【源码 + 推断】

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
| 指针注入（稳定） | `systemPrompt.section({ name: 'dsh-token-budget:notes', order: 620 })`（紧随 `TEAM_POLICY 600`，`system-prompt/src/index.ts:135`）：渲染「你的笔记文件 `teams/<teamId>/<agentKey>.md`；共享笔记 `workspace.md`；用 team_notes 读写」。文本只依赖 `(teamId, agentKey)`，**每会话首次渲染后不再变** ⇒ 零事件 |
| hint（窗口级） | `systemPrompt.context({ name: 'dsh-token-budget:hint', order: 140 })`，内容 = 当前任务 id 与标题（缓存的 `team.json`，§7-4）+ 笔记元数据（自己的文件 + 队友最近 ≤ `hintRecentNotes` 个，带行数/字节数）+（`history` 开启时）一句可用 `history_*` 查原文；笔记部分形态照 Codex 夹具 `"Recent notes (up to 5, most-recent first):\n- … (2 lines, 14 UTF-8 bytes)"`（`codex-rs/ext/history-notes/tests/history_notes_extension.rs:48`）。**只在窗口计数变化时重算**（照 Codex hint 只在重建初始上下文时取一次，`临时记录.md` §10.8.3），超过 `hintMaxBytes` ⇒ **整条不注入**（照 Codex `text.len() > MAX_THREAD_HINT_BYTES` 判失败，`extension.rs:140-143`）。注入通道见 §7-1 |
| 不抄契约 | 契约以 `team.json` 为准，不复制进笔记（`临时记录.md` §八 6.2） |
| 作用域 | 读：同团队所有成员文件 + `workspace.md`（Codex 也允许跨 agent 读，`tools.rs:28`）；写：仅自己的文件 + `workspace.md` |
| 与压缩交互 | 笔记在磁盘，压缩不碰；指针在 system 头，压缩不碰；hint 在压缩后的下一次准入重算 |
| 失败回退 | 无团队身份 ⇒ 工具返回说明性错误（§4.0.2）；目录不可写 ⇒ 工具返回错误，不影响对话 |

**参照对象要分清**：Codex `notes.*` 是**单 rollout 内**跨窗口私有笔记（`tools.rs:28`「survive context-window transitions within this rollout」）；**跨会话**的是另一套 `memories`。本设计的分层借 memories（每实体一份 + 合并层 + 双重硬上限），注入形态借 notes hint（只给指针）。合并层 `workspace.md` 的**自动合并**（Codex phase2 consolidation）**v1 不做**，由模型显式维护；是否做见 §7-3。

### 4.3 团队信件回看 team_history（0.2.0）

> **状态**：v1（0.1.0）不含。用户 2026-10-16 确认 0.2.0 只做真正的增量：**队长能看到成员之间的信，大家能回查已读的信**。不做原草案里的任务列表/契约读取（`agent_teams_status` 已提供），也不做旧 attempt 结果与重派前会话的保存（不必要，且需要插件另写账本）。

**为什么需要**：agent-teams 每个收件人一个信箱 `inbox/<收件人>.jsonl`（队长为 `captain`，`state.ts:6`、`:436`），已读的信留在文件里（`readAt`），作废的信标 `discardedAt`。但它的工具只展示未读：`agent_teams_status` 给队长自己的未读、各成员信箱的未读条数与最新一条前 200 字，给成员最多 10 条自己的未读。读过的信只留在收件人会话的上下文里，压缩后只剩摘要；成员之间的信队长根本看不到。

| 项 | 设计 |
|---|---|
| 数据源 | 当前团队 `inbox/*.jsonl`，只读；不读 `archive/`、不跨团队。文件由 agent-teams 整文件原子替换，无锁读取只会读到完整版本；坏行跳过并在结果里计数 |
| 可见范围 | 队长：全队全部信件；成员：`to` 或 `from` 是自己的信（agent-teams 只给成员看自己的信箱，本插件另加自己发出的信）。成员看不到队友之间、队友与队长之间的信 |
| 工具 | **一个**工具 `team_history`，`action ∈ {list, read, search}`。`list` = 按「发信人 → 收信人」汇总封数、未读数、最近时间；`read` = 按时间正序（`recent_first` 倒序）分页读正文，`offset`/`limit`，或 `message_id` 读单封全文；`search` = 正文字面包含、区分大小写，返回片段。三者都可按 `from` / `to` / `task_id`（匹配 `taskId` 或 `sourceTaskId`）过滤；默认不含作废信，`include_discarded` 打开 |
| 信件状态 | 已作废（`discardedAt`）/ 已读（`readAt`）/ 已投递（`deliveredAt`）/ 未读 |
| 上限 | 复用 `historyMaxResults`（搜索结果）、`historyMaxReadChars`（单次读取字符，超出截断并给下一页）、`historyMaxListItems`（汇总组数、单页封数） |
| 开关 | `teamHistory`，默认开，设置页即时生效（与其他能力开关同法） |
| hint | 开启时窗口 hint 末尾加一句「团队来往的信（含已读）可用 team_history 回看」 |
| 存储 | 无。不写账本，不复制信件 |
| 与压缩交互 | 纯拉取，压缩无影响；队长中途的纠正（steer 投递的信）压缩后仍可从信箱读回原文 |
| 失败回退 | 无团队身份 ⇒ 说明性错误；信箱目录不存在 ⇒ 「没有信件」 |
| 实现 | `src/team-history/{mailbox,tool}.ts`，测试 `test/team-history/` |
| PoC | **通过**（2026-10-16，团队 th-test，DSH 0.2.0-rc.2 + agent-teams 0.1.23）：alice→bob 发暗号、bob 回信；bob 的 `read` 看到 2 封（收到的已读、自己发出的已投递），看不到 alice/bob 发给队长的信；队长 `list` 汇总 4 组、`search KIWI` 命中 4 封（含成员之间的 2 封），状态均为已读。之后时间加上时区后缀 |

**附：agent-teams 的信件投递（「插话」）**：`agent_teams_send_message` 发给运行中的收件人时走宿主 `steer`（`tools.ts:2149`、`:2260`；队长侧 `members.ts:200`），在其下一个步骤边界插入，同一轮次内生效、不打断正在进行的模型输出与工具调用（`agent-loop/src/agent.ts:167`、`agent/src/runtime-types.ts:225-229`）；空闲则唤醒；都不行时只落盘，调度器在下一个状态边界优先重投（`scheduler.ts:323-340`）。派任务走 `queue`（新轮次）。人只能经队长转发给成员。

### 4.4 本会话先前窗口原文（只读 `history.*` 等价工具，用户 2026-10-14 确认需要）

详见 `docs/research/context-compare/community-plugins-survey.md`。设计要点（用户已采纳，2026-10-14）：

| 项 | 设计 |
|---|---|
| 读取源 | `ctx.sessions.flush(session)` 后 `ctx.sessionPersistence.open(id, 'read').read(offset, count)` 分页读取（`session-persistence/src/index.ts:154-167` 只读句柄不抢写锁；`handle.ts:73-83`）；这是宿主弃用说明指定的替代路径。社区 `dsh-compaction-scroll` 同法（`src/log.js:18-34`）。persistence 不可用时退到 `sessionQuery.readSession`，都没有则返回明确错误 |
| 不做 | 不用已弃用的 `eventAt/snapshotEvents`；不自建 JSONL 镜像（`session/event` 不重放 fork 继承前缀与 resume 旧日志，`core/session/src/index.ts:550-560`，镜像会缺）；不直接解析 `session.v4.jsonl.zstd`（zstd 帧、校验、撕裂尾、迁移、写锁，定位函数已私有） |
| 窗口划分 | 窗口 N = 1 + 此前 `compaction/summary` 事件数；被隐藏范围取自 `shadowedSeqs` |
| 索引 | 只在内存记压缩事件位置；首次调用与 resume 后从存储重建；渲染文本缓存，存储修订变化即失效。不落盘、无第二份用户数据 |
| 工具 | 照 Codex：`list_windows` / `list_items` / `read_item` / `search_contents`（字面包含、区分大小写）；归入 `history` 开关 |
| 成员边界 | 成员会话只读 `inheritedEventCount` 之后的事件，不能读到队长继承过来的上下文 |
| 代价 | 每次读要先 flush，且整份会话文件解码一次（按文件修订缓存，`jsonl/index.ts:753-786`） |
| 降低解码成本（实验） | 会话文件是 **zstd 压缩，不是加密**。DSH 官方提供开关：`session-persistence-jsonl` 行的 `compression: 'zstd' \| 'none'`（`session-persistence-jsonl/src/index.ts:84-87`、`:254`；README 配置表 `compression` 行），设 `none` 后为纯文本 JSONL，省掉解压，但读取仍是整文件扫描 + JSON 解析。该行在宿主 base 层（`bundle/base/cordis.patch.yml:132-135`），覆盖时须重述 `root: !!js dshHomePath('sessions')`；作用于全部会话，已有 zstd 文件切换后的迁移行为需 PoC【推断】。因属全局存储配置，**不放进本插件 bundle**，作为文档里的可选 profile 片段由用户自行开启；插件代码两种格式都经 persistence 读取，无需改动 |
| 已验证 | 宿主层注册的本插件工具在成员会话中可见、可用（PoC-3、PoC-8）。0.2.1-alpha.2 上未测：agent-teams 0.1.23 不支持该宿主（§0-2） |

**实现（ba7a385 起）**：`src/history/{model,source,tools}.ts`。工具名用下划线（宿主要求标识符）：`history_list_windows` / `history_list_items` / `history_read_item` / `history_search_contents`，参数照 Codex（window_id、item_id、role、tool_name、recent_first、offset_chars/limit_chars），只读调用方自己的会话、仅团队会话。窗口 id `w<N>`，条目 id `e<seq>`；条目只收 user/assistant/tool/system/developer 消息，推理块不收录，工具调用写成 `[调用 name(args)]`，tool 结果按 callId 回填工具名；被 `compaction/summary.shadowedSeqs` 覆盖的条目标「已隐藏」。上限取 `historyMaxResults` / `historyMaxReadChars` / `historyMaxListItems`（即时生效）。

**persistence 只读 PoC（dsh 0.2.0-rc.2 真实 `session-persistence-jsonl`，zstd）**：写句柄持有写锁且未 flush 时，`persistence.flush()` 后 `stat` + `open(id,'read')` 能读到全部已 append 事件；再 append 后修订变化、缓存失效并读到新事件；读句柄与写锁并存无冲突。完整团队会话中成员调用 `history_*` 已通过（2026-10-15 压缩 PoC）。

---

## 5. 与 dsh-agent-teams 的耦合面与风险

1. **磁盘格式耦合**：本插件依赖 `team.json` 的 `captainSessionId / members[].id / members[].name / tasks[]`与信箱 JSONL 行格式（`types.ts:263-266`、`:310-333`、`:354-368`；信箱只在 §4.3 用到）。agent-teams 升级可能改格式 ⇒ `peerDependencies` **精确钉** `@nanmicoder/dsh-agent-teams@0.1.23`（已写入 `package.json`），升级时重跑 PoC-3/PoC-5。【源码】
2. **成员工具策略**：部署方可给成员配 `allow` 型 `toolPolicies`，只保留列出的全局工具（`tool-policies.ts:17-24`、`:54-57`）⇒ 未列入的 `team_notes` / `team_history` / `context_remaining` / 4 个 `history_*` 会被裁掉（agent-teams 只自动补它自己的 4 个协调工具）。README「使用」节已给出示例：用 `allow` 策略时把这些名字加进去。【源码】
3. **成员工具过滤的时机**：agent-teams 在成员首次请求前用 `restrict` 固定工具集，并强调「Team creation/archive must never rewrite the captain's system/tools prefix」（`capabilities.ts:65-67`、`:93-95`）。本插件若日后启用 `restrict`，也必须在 `agent/created` 时一次定案，不得事后增删。【源码】
4. **前缀稳定是上游的显式设计价值**（事实陈述，不作裁决）：agent-teams 把队长 prompt 一次性快照（`capabilities.ts:57-59`）；宿主 plan-mode 文案写明「The tool catalog stays the same across modes for request-cache stability」（`presets/standard.patch.yml:59`）；压缩摘要请求刻意复用前缀以命中 KV cache（`compaction-basic/src/summarizer.ts:28-31`）。这些是 §7-1 两个分支的背景事实。【源码】
5. **宿主版本**：agent-teams 0.1.23 不声明支持 `0.2.1-alpha.2`（§0-2）。本插件 PoC 必须在 agent-teams 支持的宿主（推荐 `0.2.0-rc.2`，即本机安装版）上做。【源码】

---

## 6. PoC 验证清单

每项给出可证伪的观测点。前置：**先按 `临时记录.md` §14.3 回退降阈值覆盖**；D1 下宿主 `thresholdRatio` 保持默认作兜底，45% 由插件的 `compactAtRatio` 驱动（2026-10-15 勘误，原文为方案 A 时期的「把 `thresholdRatio` 设为 0.45」），否则 PoC-4 / PoC-9 的数值无意义。

| # | 要证什么 | 观测 / 判据 | 依赖的推断 |
|---|---|---|---|
| PoC-1 | 宿主层插件按 §2.2 的 inject（含 `agentPresets`、`sessions`、`sessionPersistence`）能激活，不挂起 | `plugin_manager list_plugins` 显示 `dsh-token-budget` 已激活（`editing-cordis-compositions/SKILL.md:74`）；故意加入 `'compaction'` 的对照版应**不激活**。**注（2026-10-15）**：早先只验证过前 5 个服务；8 个服务版（c70be72 构建）已在 dsh 0.2.0-rc.2 web（profile poc）上激活：重启后新会话的投影缓存出现本插件注册的 `tokenBudgetWindow`。`'compaction'` 对照版未做 | §3.2 |
| PoC-2 | 宿主层注册的 section 与 context 出现在 **preset 会话**与**成员子会话**的请求里 | 解码会话日志：`system/message` 文本含 `dsh-token-budget:notes` 段；`source.kind='runtime-context'` 的 user 消息含预算段 | agent-teams usage section 同法工作（强推断） |
| PoC-3 | 团队身份解析与 agent-teams 判定一致；成员在 `agent/created` 时是否已写入 `team.json` | 对每个成员/队长会话，本插件解析出的 `(teamId, agentKey)` 与 `agent_teams_status` 一致；队长 fork 后代按设计判为非团队；记录成员 `agent/created` 时刻 `team.json` 中是否已有其 `members[].id` | §4.0.1-5、§4.0.2 |
| PoC-4 | 预算提示在跨档时出现、压缩后消失，且每窗口快照追加次数 ≤ 档数 + 1 | 低阈值下跑长任务：统计两次 `compaction/end` 之间 `runtime-context` user 消息条数 | §4.1 |
| PoC-5 | 运行时上下文被压缩替换后自动补回（本插件依赖的核心机制） | 压缩后的第一条请求前出现新的 `runtime-context` 快照，且其 seq 晚于 checkpoint 的 replace 事件 | §3.3-B（源码已读通，缺运行态） |
| PoC-6 | 笔记写入不影响交付审计 | 某任务通过质量闸门后，成员调用 `team_notes write`；再跑 `agent_teams_status`，审计结论不变 | §4.2.1 |
| PoC-7 | 开关切换对已存在会话是否生效 | 改 profile 覆盖关掉 `notes`，看**已存在**会话的下一次请求工具列表是否变化；新会话对照 | §2.3 |
| PoC-8 | 子会话在压缩后是否真的去用 notes / history（行为，不是能力） | 统计压缩后 N 步内 `team_notes read` / `history_*` 调用；对照组关闭预算提示 | `临时记录.md` §九-2、§十三-5 |
| PoC-9 | `compactAtRatio` 与实际压缩点一致 | 记录 `compaction/start` 前一步的 `P / W`；理想值接近 0.45（小窗口路由上可能更早，见 §2.4） | §2.4 |

**实测记录（2026-10-15，dsh 0.2.0-rc.2 web，profile poc，测试阈值 remind 0.03 / compact 0.05 / step 0.01，成员 carol）**

- PoC-4 通过：窗口 1 内预算提示只在跨档时追加（3%、4% 各一次），压缩后新窗口第一条快照不再带提示，新窗口再次到 3% 时重新出现。
- PoC-5 通过：压缩检查点之后的第一步即出现新的 runtime-context 快照。
- PoC-9 通过：设 5% 时 `compaction/start` 前一步约 4.9%–6.0%，压缩后约 2.3%–3.0%。
- 压缩后 `team_notes`、`history_*`（含 w99 报错）均正常。
- 实测发现并修复：宿主每步**先组装**（context 的 `text()` 只在这里求值一次），**后跑** `agent/pre-step`。原先在 pre-step 压缩，导致压缩后第一步仍带压缩前的「已用 5%」提示和旧窗口 hint。现改为在 `system-prompt/assemble` 瀑布里压缩，并就地重算本插件的两段 context；`agent/pre-step` 保留为兜底（同窗口只尝试一次）。复测通过。
- PoC-6 通过（代码级，用 agent-teams 0.1.23 真实的 `readArtifactScope`）：工作区范围 `./` 与 `src/` 下，写入 `.agent-teams/.context/notes/` 的成员笔记和 `workspace.md` 前后读取结果逐字节相同、无 gap；对照组在根目录写 `notes.md` 会被读到。`agent_teams_status` 的审计（`auditTeamWorkspace`）只由这个读取器和已记录路径的 mtime 组成，笔记路径不会进入任何契约（`isDefaultExcludedPath`），所以结论不变。前提是 `stateDir` 保持在 `.agent-teams` 下，否则插件启动时告警。
- PoC-7 通过（改实现后）：原实现中三个能力开关只在 apply 时决定是否注册，改了要重启 DSH。现改为 volatile 更新时注册/注销。实测：同一个已打开的会话，设置页关掉团队笔记后，下一次请求的 `request/header` 少了 `team_notes`，宿主自动插入 `tool-removal` 开发者消息；重新打开后新请求里 `team_notes` 回来。
- PoC-8 通过（2026-10-15，团队 poc8-test，成员 dave，阈值 3%/5%）：任务只要求分 7 段读 3714 行文件、最后给出每段首行与 function 次数表，没有任何关于笔记、历史或压缩的指令。dave 在收到【上下文预算】提示后主动用 team_notes 写入已统计数据，并注明“压缩后以此为准”；第 4 段读完时触发压缩，之后继续追加进度并完成，7 段数据全部正确（31/18/19/14/15/0/6）。压缩后没有调用 team_notes read 或 history 工具：所需数据已在压缩摘要和笔记里。结论：预算提示足以让成员主动写笔记；history 是兜底，正常任务里不一定用到。
- PoC-3 通过（2026-10-16，团队 poc3-test：队长 + alice + bob，另由队长 `subagent_fork` 派出一个分叉会话）：本插件解析的身份与 `agent_teams_status` 一致：队长 `teams/poc3-test/captain.md`，alice、bob 各自 `teams/poc3-test/<name>.md`，会话 id 与 team.json `members[].id`、`captainSessionId` 相符；成员 `context_remaining` 返回 1.4% / 预计 450000 token 压缩（W=1M × 0.45），与默认阈值一致。队长的 fork 后代调用 `team_notes` 得到「当前会话不属于任何 AgentTeams 团队」，符合 v1 设计（agent-teams 自己会把它认作队长，见 §4.0.1-5；识别 fork 后代留给后续版本）。成员在 `agent/created` 时**还不在** team.json 里：agent-teams 先 `subagents.startContinuable` 创建子会话，返回后才写 `member.id = start.childId`（`members.ts:942`），所以创建时不能用 `restrict` 收紧，§4.0.2 维持「不做 restrict」；成员 hint 从认领任务后的第 2 步起出现。
- PoC-2 未单独记录，已被间接覆盖：PoC-4/5 观测到成员会话的 runtime-context 快照含预算段，PoC-8 中成员按 notes section 指引写入自己的笔记文件。
- PoC-1 的 `'compaction'` 不激活对照版未做（§3.2 的源码结论未变）。
- 已知：成员会话第 1 步组装时团队身份尚不可知（认领任务前），hint 从第 2 步开始出现，不影响功能。

---

## 7. 决议与待确认（2026-10-14 两轮用户答复后）

### 已决议（用户）

| # | 议题 | 决议 |
|---|---|---|
| 7-2 | 「本任务是否经过压缩」回传 | **不记** |
| 7-5 | tokenBudget 作用域 | **只管团队会话** |
| 7-6 | 开关 | **`notes` / `history` 默认全开**（实现时另加 `contextTool`，同样默认开、即时生效）；tokenBudget 由插件管理面板整体启停 |
| 新 | 阈值 | 已用 **37% 提示**、**45% 强制换窗压缩**，两值可配（落点 §2.4） |
| 新 | 名称 / 形态 | **dsh-token-budget**（显式与隐式统一），独立 dsh 插件，与社区原版并存 |
| 7-8 | 本会话先前窗口原文 | **需要**：做只读的 `history.*` 等价工具；不依赖已弃用接口与 `session-query`，倾向自建（方案调研中：`docs/research/context-compare/community-plugins-survey.md`） |
| 7-9 | fork 窗口计数 | **不扣除**（同意建议） |
| §2.4 | 45% 落点 | **方案 D1**（替代 A）：插件仅对团队会话调用 `compactIfNeeded(agent,'context-overflow')` 主动压缩 |
| 7-8 / §4.4 | 只读历史实现 | **采纳 §4.4**：persistence 只读分页 + 内存索引；zstd→none 作为可选实验配置 |
| 7-10 | 摘要拦截 | **v1 不拦截**。**目标方案（后续版本）= 模板交接 + LLM 兜底**：笔记新鲜时返回插件自拼的短交接（任务契约 + 笔记指针），缺失或过期时走原 LLM 摘要；拦截点倾向 `serviceFor` 取得的引擎 `summarize()` 钩子，草案与待定项见 `docs/reference/dsh-plugin-survey-2026-10-14/04-handoff-design.md`、`handoff-prep/E-synthesis.md`。用户 2026-10-14 认为这是理想状态，2026-10-15 确认按原进度在后续版本加入 |
| 新 | 团队级历史 §4.3 | **v1 不做**（用户 2026-10-16）；以 0.1.0 为基线推进后续版本。0.2.0 只做信件回看：队长看到成员之间的信、大家回查已读的信；不存旧 attempt 结果与重派前会话 |
| 7-1 | 缓存论 | **分支 B**：窗口内会变的内容走运行时上下文；system 头只放每会话固定的指针 |
| 7-3 | 合并层 | 设置开关 `notesMerge.enabled`，**默认关 = 由队长维护** `workspace.md`；开启时由用户在设置页从模型下拉中选择模型与推理强度（实现：前端 `ctx.remote.session.modelCatalog()` 级联下拉，原设计为 `ctx.llm.listProviders()` / `listModels(provider)`），再经 `ctx.llm.stream()` 调用（`llm` 运行时 `ctx.get` 取得，不进 inject）。**触发时机（用户确认，2026-10-14）：成员任务完成时**合并该成员笔记。宿主 0.2.0-rc.2 不认识 `agent-teams/*` 事件类型，agent-teams 会跳过写入（`dsh-agent-teams/src/events.ts:45-54`），所以实现改为：每个 `agent_teams_*` 工具调用返回后重读 team.json，与快照比较找出新完成的成员任务；同一工作区排队执行，读 → 调模型 → 条件写入，冲突重试一次，超限或 `max-tokens` 截断则放弃 |
| 7-4 | hint 来源 | 任务 id + 标题（缓存的 `team.json`）+ 笔记元数据（自己的文件 + 队友最近 ≤5 个） |
| 新 | 提示档位 | `bucketStep` = **3%**（37/40/43%） |
| 7-7 / §2.4 | 45% 落点（已被方案 D 取代） | ~~方案 A~~：自动压缩是兜底；本质是把 compaction-basic 的触发配置交给用户在 DSH 现有的 Agent presets 设置页里调，本插件只在提示文本里镜像这个数 |

### 补充说明

**（已过时，被 §2.4 的 `serviceFor` 更正与方案 D1 取代）直接调自动压缩函数是否可行（7-7 追问）→ 不可行，有三道门。** ① 自动压缩的判定函数 `compactIfNeeded` 是 compaction-basic 引擎实例的内部方法，不是公共接口；公共接口只有 `ctx.compaction.compactNow / compactRegion`（`compaction/src/index.ts:139-190`）。② `ctx.compaction` 只在 preset 的 `isolate: { compaction: true }` 组内可见，宿主层插件注入它会永远挂起（§3.2）——这是最硬的一道。③ 即使拿到，`compactNow` 要求 agent 空闲，否则 `busy`；两者都受 `compaction/start…end` 持久锁约束。

**7-8 「原文」的含义。** 指上一个窗口里被摘要**替换掉的原始消息**（用户 / 助手 / 工具结果），不是摘要本身。它们仍在会话日志里，只是被 shadow。Codex 的 `history.*` 工具正是**只读**读取同一 rollout 里先前窗口的条目（`codex-rs/ext/history-notes/src/tools.rs:120`「Read a bounded range from private model-only history」，可按 `window_id` 过滤），从不修改。本插件若做，同样只读；非弃用读取接口已找到（`sessionPersistence` 只读句柄），用户已确认需要并采纳 §4.4 实现。

**7-10（新）DSH 自动压缩的摘要请求怎么处理。** 当前设计**不拦截**：摘要照常生成，作为检查点 user 消息进入新窗口，本插件的笔记是对摘要的补充。技术上存在拦截点：`llm/stream` 是宿主 `llm` 服务上的 waterfall 中间件，listener 可「yield your own chunks to short-circuit」（`llm/llm/src/index.ts:62-75`），`llm` 在宿主层，宿主层插件可以挂【推断：preset 隔离组内发起的调用是否经过宿主层 listener，需 PoC】。拦截后的选择：
- 直接丢弃 ⇒ 压缩以 `summary` 失败告终，历史不缩，最终撞上下文上限，**不可行**
- 返回插件自拼的短摘要（任务契约 + 笔记指针）⇒ 等于模拟 Codex「不做摘要直接换窗」，省掉摘要请求（输入约 0.45W，大部分命中前缀缓存；输出 ≤ `maxTokens` 65,536）。代价：识别摘要请求只能靠匹配 `COMPACTION_INSTRUCTION` 文本（`compaction-basic/src/summarizer.ts:32-66`），宿主一改就失效；而且新窗口的连续性完全依赖成员是否写好笔记
- 更稳的省钱手段是宿主现成配置：`summarizationProvider/summarizationModel` 把摘要交给更便宜的模型（`compaction-basic/README.md` 配置表）
- 建议：v1 不拦截；做完 PoC-8（成员压缩后是否真的用笔记）再决定是否加一个默认关闭的实验开关

**7-9 举例。** 队长会话 C 先后自动压缩两次（窗口 1→2→3），然后用 `subagent_fork` 派出子会话 F。fork 会把 C 到分叉点的日志逐字复制成 F 的开头（`fork.ts:21-30`），其中包含那两条 `compaction/end`。本插件的窗口计数是「重放日志数 `compaction/end`」，所以 F 一出生就算「第 3 窗」，尽管 F 自己一次都没压缩过。用 `subagent`（spawn）派出的成员日志从空开始，计数从 0 起，没有这个问题。影响：若把编号展示给模型，F 会看到一个莫名的「第 3 窗」；v1 不展示，只用「编号是否变化」来决定何时重算 hint，起始值是几都不影响。**建议维持不扣除。**

### 待用户确认

（无，全部已决。）

---

## 8. 与既有文件的关系

- **`临时记录.md` §八**：本文件取代其「初步设计」；§八保留为讨论结论，已在原处标注更正。
- **`临时记录.md` §九**：第 1 条已由源码回答（§3）；第 4 条已与 §5.4.1 对齐；第 2、3 条转为本文件 PoC-8。
- **`docs/research/context-compare/t6-improvement-plan.md` §3「不建议照搬」**：t6 当时以「DSH 无窗口 id」「宿主不暴露权威额度」为由不建议做 thread hint 与模型可见额度。用户其后明确要求这三个能力（`临时记录.md` §一）。两条理由的现状：窗口 id ⇒ 本插件以「每 session 压缩周期计数」自建（§4.0.3）；额度 ⇒ 直接读宿主 `tokenMeter`，只有触发点是估算（§4.1）。t6 的其余建议（宿主压缩栈按 agent 降档等）不在本插件范围；顺带：compaction-basic 已有**按模型**（非按 agent）的 `modelPolicies` 覆写（`compaction-basic/README.md:75` `modelPolicies` 行），可作为「给成员用的模型单独设阈值」的现成近似。
- **引用行号**：`临时记录.md` 与 `docs/research/context-compare/*` 中 `@deepseek-ai/*/lib/index.js:N` 形式的引用指向安装版 `0.2.0-rc.2` 构建产物。本次已逐条对照源码语义的有：`project()` 改写条件、`buildForkSeed`、压缩事件 log-only、`systemHead`、`COMPACTION_INSTRUCTION`、`CHECKPOINT_PREAMBLE`、session-reference 的 pre-step/readSurface/检查点识别、`dsh-time-context` 注入方式；语义均成立（`COMPACTION_INSTRUCTION` 段数与格式除外，已在 `临时记录.md` §六更正）。
