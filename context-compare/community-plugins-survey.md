# 社区插件调研：只读「先前窗口原文」工具（Codex `history.*` 等价）与压缩摘要替换

> 调研日期：2026-10-14。宿主基线：本地 `src/deepseek-harness` @d7432673（packages 0.2.1-alpha.2）。
> 证据分级：【源码】= 已打开源文件并给出 `path:line`；【推断】= 未运行验证或依赖间接证据。
> 社区仓库浅克隆于 `src/community/<repo>/`（仅供阅读，未复制进插件源码；本工程目录不是 git 仓库，无提交/推送）。社区仓库路径以 `community/<repo>/…` 简写，宿主源码以 `dsh/…` 简写（= `src/deepseek-harness/…`）。

---

## 0. 结论速览

| 仓库 (commit) | 定位 | 宿主版本要求 | 许可 | 给模型的历史工具 | 原文读取方式 | 替换压缩摘要 | 平面 |
|---|---|---|---|---|---|---|---|
| hoyyang/dsh-smart-compact (b5a074e) | Codex 式换窗 + notes + history | peer `>=0.1.5-rc <2` | BSD-3 | ✅ `ctx_history` list/read/search | `session.snapshotEvents()`（**已弃用**） | ✅ 子类化 `BasicCompactionEngine`，`summarize()` 返回零模型调用模板 | 主机平面（与 web 预设的 compaction 冲突，见 §1.1） |
| chenproton/dsh-history (ecb474e) | Web 侧栏：查看/跳转自己发过的消息 | peer `<0.2.0-0` | MIT | ❌（仅 HTTP 路由给 UI） | `snapshotEvents()` → 回退 `sessionQuery.readSession` | ❌ | 主机平面 |
| TsFreddie/dsh-compaction-instant (f688029) | 确定性「编译」压缩引擎 + recall/search 工具 | peer `^0.1.0-rc.6` | MIT | ✅ `recall` / `search` | `session.events`（**0.2.x 已不存在**，实际已失效） | ✅ 自有 `CompactionEngine` 子类，替代 compaction-basic | 主机平面 |
| Contexera/dsh-agent-team (22d2506) + `@contexera/dsh-context-continuity`@0.4.0 | 持久 agent team；续航引擎（rollover=新会话） | continuity peer `>=0.2.0-rc.1 <0.2.1`（**不含** 0.2.1-alpha.2） | MIT | 引擎内有 `context_search`/`context_read`，但 Team 0.2.3 **未注册** | `ctx.sessionQuery`（search 需全文索引）；`sessionPersistence.open('read')` | ✅ `summarize()` 优先返回 agent 自写摘要，否则 LLM | 引擎在**预设平面**；主机经 `agentPresets.serviceFor` 取 |
| MimicHunterZ/dsh-agent-compact (cd87ba6) | `context_compact`：agent 自写检查点 | peer `0.2.0-rc.2` | MIT | ❌（原文落 spill 文件，无读取工具） | `sessionQuery.readSurface` + `spillStore.saveText` | ✅ 运行时 monkey-patch `engine.summarize` | 主机平面，`serviceFor` 取预设引擎 |
| Zoria-Lind/dsh-token-optimizer (95ca622) | 分层 token 优化/压缩调度 | `dsh.compatibility <0.2.0-0`（自称兼容 0.2.0-rc.2） | MIT | ❌ | `snapshotEvents()` 只数 turn | ❌（只驱动 `compactNow`） | 主机平面 |
| dream12347/dsh-session-manager (37d7517) | 会话管理 + 全局压缩阈值 | peer `^0.1.0-rc.6 \|\| ^0.2.0-rc.1` | MIT | ❌ | `sessionPersistence.open('read').read()`（统计） | ❌（只改阈值） | 主机平面，`serviceFor` 改预设引擎 config |
| **mudaoYLW/dsh-compaction-scroll** (9d3ec06) 【新增强命中】 | notes + 原始历史找回 + 显式换窗 | 精确 peer `0.2.0-rc.2` | MIT | ✅ `scroll_history` windows/list/search/read | **`ctx.sessions.flush` + `sessionPersistence.open('read').read(from,count)`**（非弃用） | 不用 compaction 引擎，自行换窗 | 预设平面（自带 Minimal Notes 预设） |
| **windwhiterain/dsh-history-access** (1cf47de) 【新增】 | 模型回查压缩前历史 | 未声明 peer（JS） | MIT | ✅ `history_outline/read/search` | `ctx.sessionQuery.filterEvents` | ❌ | 主机平面，`{global:true}` 监听 + 懒注册到 `agent.ctx.tools` |
| overact/dsh-context-management (b4b2582) 【新增，略读】 | 换窗 + notes + 分页历史 | — | MIT | ✅ history 工具 | `session.eventAt()`（**已弃用**） | 自有 window engine | — |
| fengshenx/dsh-remind (cc2a9a3) 【新增，略读】 | `remind` 工具读全日志 | peer `^0.1.0-rc.6` | MIT | ✅ | `sessionQuery` | ❌ | — |

**核心判断**

1. 社区里做「只读先前窗口原文」工具的有 5 家（smart-compact、instant、scroll、history-access、context-management），其中**只有 dsh-compaction-scroll 走的是宿主弃用说明里要求的非弃用路径**（异步、可分页的持久化读取）。其余用的是已弃用的同步读取（`snapshotEvents`/`eventAt`）、已删除的 `session.events`，或 `sessionQuery`（它内部仍调用已弃用的 `snapshotEvents`）。
2. **没有一家**拦截 `llm/stream` 去改写压缩请求。替换摘要的做法只有三种：①子类化 `BasicCompactionEngine` 并覆写 `summarize()`（smart-compact、Contexera）；②运行时 monkey-patch `engine.summarize`（agent-compact）；③另写一个压缩后端整体替换（instant）。
3. 主机平面的插件要拿到 web 预设里的 `ctx.compaction`，社区的共同答案是 **`ctx.agentPresets.serviceFor(agent, 'compaction')`**（Contexera、agent-compact、session-manager 都这么做，宿主源码已确认，见 §3.4）。
4. 推荐方案（§4）：以 **`sessionPersistence.open(id,'read').read(offset,len)`** 为唯一权威来源（读之前先 `ctx.sessions.flush(session)`），用 `compaction/summary` 事件切分窗口编号，内存里只放一份轻量窗口索引；**不另写 JSONL 镜像**，也**不直接解析磁盘文件**。

---

## 1. 逐仓库详情

### 1.1 hoyyang/dsh-smart-compact v0.5.3（BSD-3-Clause）

**功能**：用 Codex 式「硬换窗」替代 LLM 摘要。提供 `get_context_remaining`、`ctx_notes`（跨压缩保留的笔记）、`ctx_history`、`new_context` 和 `/smart-compact` 命令。
**宿主依赖**：peer `@deepseek-ai/dsh-compaction(-basic)/llm/session-query/token-meter/tools >=0.1.5-rc <2`【源码】`community/dsh-smart-compact/package.json:27-37`。

(a) **原文读取 + 工具**
- `ctx_history` 工具注册【源码】`src/index.ts:337-369`，提供 action `list | read | search`，参数为 `seqs`、`keyword`、`archivedOnly`。
- 数据源是 `session.snapshotEvents()`，取不到时报错退出【源码】`src/history.ts:40-47`。注意：这个 API 在 0.2.1-alpha.2 已标为弃用（见 §3.3）。
- 窗口切分：每个 `compaction/summary` 事件算一个已归档窗口，用 `data.shadowedSeqs` / `shadowedRange` / `shadowedTokenCount` 标出范围【源码】`src/history.ts:113-126`。
- 文本投影复用宿主的 `extractSessionEventText`（来自 `@deepseek-ai/dsh-session-query`）【源码】`src/history.ts:7,71-85`。宿主侧确有导出【源码】`dsh/packages/session-query/session-query/src/index.ts:73`。
- 搜索默认只查已归档 seq，最多 50 条命中，输出按 token 截断【源码】`src/history.ts:146-166`。
- 列表说明里写明「seq 有空洞属正常」：只有 surface 事件会被归档【源码】`src/history.ts:184-193`。这一句值得照抄进我们的工具说明。

(b) **替换摘要**（最接近我们「插件自建短摘要」的设想）
- `RolloverCompactionEngine extends BasicCompactionEngine`，只覆写 `summarize()` 和 `compactIfNeeded()`【源码】`src/rollover.ts:15,305-318`。
- `summarize()` 不调用模型，直接返回 `{summary:[{type:'text',text:buildHandoffCheckpoint(...)}], provider:'rollover-template', model:'none'}`【源码】`src/rollover.ts:376-423`。
- 模板内容【源码】`src/rollover.ts:213-247`：窗口编号、「上一窗口已完整归档」、`Task:`（取自最新的 `session/title`）、`Last action:`、notes 指针（读 `ctx_notes`）、「缺的细节用 `ctx_history` 回查」，外加 notes 过期检测（`deriveNotesFreshness`，`:119-133`）和脱敏（`redactText`，`:408-413`）。
- 约束：压缩事务要求框好的检查点在 token 上**严格小于**被遮蔽内容，因此预估最坏情况（`handoffCheckpointWorstCaseText`，`:261-270`）。
- 隔离 `toolResultPruner`，防止滞后版本的 pruner 中断换窗【源码】`src/index.ts:82-91`。

(c) **阈值**：`thresholdRatio` 默认 0.85，`fallbackBufferTokens` 默认 8192，`retainRatio` 可选，校验区间为 (0,1)【源码】`src/config.ts:27-28,38-63`。三段策略【源码】`src/rollover.ts:491-517`：低于阈值不动作；在阈值到阈值+buffer 之间提醒写 notes（grace 带）；超过则强制换窗。

(d) **平面**：主机平面。在 `apply()` 里直接 `new RolloverCompactionEngine(ctx)`，由构造函数 `provide('compaction')` 抢占服务槽；被占用时降级为只装工具【源码】`src/index.ts:73-135`。
- 【源码】宿主 web-app bundle 禁用了根层 `compaction-basic`（`dsh/packages/bundle/web-app/cordis.patch.yml:527-528`），web 预设在自己的隔离 group 里另有 compaction（见 session-manager 注释 `community/dsh-session-manager/src/index.ts:190-196`）。
- 【推断】因此在 web 预设会话里，预设平面自己的 compaction 可能遮蔽 smart-compact 的主机级引擎，模板摘要只对没有预设 compaction 的会话生效。dsh-agent-teams 成员会话属于前者，所以我们**不能照搬**这种「主机平面 provide compaction」的做法。

### 1.2 chenproton/dsh-history v0.1.25（MIT）

**功能**：Web UI 面板，列出、搜索、跳转用户自己发出的消息，不给模型用。
**宿主依赖**：peer `>=0.0.1-rc.1 <0.1.0 || >=0.1.0-rc.1 <0.2.0-0`【源码】`community/dsh-history/package.json:63-70`，不覆盖 0.2.x。
- (a) 只注册 HTTP 路由 `/history/api/list-user-messages`【源码】`src/index.ts:271-302`。读取顺序【源码】`src/index.ts:207-240`：先取活会话的 `sessions.get(id).snapshotEvents()`，取不到再用 `sessionQuery.readSession(id)`。只过滤 `user/message` 且 `source.kind==='user'` 的事件【源码】`:244-258`。**不暴露给模型。**
- (b) 不涉及摘要替换；(c) 无阈值设置；(d) 主机平面。
- 参考价值：低，只能借鉴「活会话优先、持久化回退」的思路和用户消息的识别方式。

### 1.3 TsFreddie/dsh-compaction-instant v0.1.4（MIT）

**功能**：「VCC 式」确定性压缩引擎，把旧区间「编译」成近无损的单行摘要，不调用 LLM；另带 `recall`/`search` 工具和 `/recall` 命令。
**宿主依赖**：peer `^0.1.0-rc.6`【源码】`community/dsh-compaction-instant/package.json:70-81`。

(a) **原文读取 + 工具**
- `recall` 工具按 `seq`、`result N` 或 `checkpoint N` 取回原文；`search` 按关键词或正则查日志【源码】`src/tool.js:38-40,75-114,131-141`。
- 数据源是 **`session.events`**【源码】`src/recall.js:126,157,212`、`src/search.js:58`、`src/region.js:42,155`，并配合 `session.deriveEventMessage`。
- 【源码】本地宿主的 `Session` 已经没有 `events` getter：`dsh/packages/core/session/src/index.ts` 里没有 `get events`，只有已弃用的 `eventAt`/`snapshotEvents`/`ownEvents`（`:704-744`）。⇒ **该插件在 0.2.x 上的 recall/search 已失效**（smart-compact 注释也提到 `Session.events` 被移除，`community/dsh-smart-compact/src/history.ts:25-29`）。

(b) **替换摘要**
- `InstantCompactionEngine extends CompactionEngine`【源码】`src/index.js:398-430`。
- bundle patch 禁用 `compaction-basic` 行，再插入自己的引擎【源码】`cordis.patch.yml`（`- id: compaction-basic / disabled: true` + insert `compaction-instant`）。
- 自动触发挂在 `agent/pre-step` 和 `agent/request-error` 上【源码】`src/index.js:531-560`。区间事务复制了 basic 的实现，只把摘要步骤换成 compiler【源码】`src/region.js:6-12,377-408`。

(c) **阈值**：`DEFAULT_THRESHOLD_RATIO = 0.5`【源码】`src/index.js:26`。支持按 provider/model 设置 `modelPolicies`【源码】`:171-188`，也可以注册 `settings` 命名空间供用户在 UI 修改【源码】`:438-508`。
(d) **平面**：主机平面（直接替换根层 compaction 行）。web 预设场景下同样会遇到 §1.1 的遮蔽问题【推断】。

### 1.4 Contexera/dsh-agent-team v0.2.3（MIT）+ `@contexera/dsh-context-continuity` v0.4.0（MIT，仓库 contexera/dsh-plugins，已克隆到 `community/contexera-dsh-plugins/`）

**功能**：持久 agent team（台账、线程、收件箱）。上下文续航由独立的 continuity 引擎负责：`context_rollover` 开一个**新的物理会话**（新 sessionId）作为下一代，`context_checkpoint` 记录可回退锚点，另有 `context_status`/`context_compact`。
**宿主依赖**：Team 依赖 continuity `^0.4.0`【源码】`community/dsh-agent-team/package.json:66`。continuity 的 peer 是 `@deepseek-ai/dsh-* >=0.2.0-rc.1 <0.2.1`（npm view 结果）。⇒ **严格来说不兼容 0.2.1-alpha.2**。

(a) **原文读取 + 工具**
- 引擎提供 `context_search` / `context_read`【源码】`community/contexera-dsh-plugins/packages/context-continuity/src/search-tools.ts:55-59,145-152,257-260`，底层走 `ctx.sessionQuery` 的 `searchSessions/searchEvents/filterEvents/readSession`【源码】`src/search.ts:57-71`，跨多个「代」会话检索，并按 `inheritedEventCount` 把继承事件归到记录它的那一代【源码】`src/search.ts:369-399`。
- 但 Team 0.2.3 只注册了 `rollover/checkpoint/status/compact` 四个工具【源码】`community/dsh-agent-team/packages/tool-agent-team/src/context-tools.ts:134-140`，**没有注册 search 工具**。
- 【源码】宿主 base bundle 默认 `session-query-sqlite openAt: never`，全文搜索调用会报 `SESSION_QUERY_SEARCH_DISABLED`，只保留精确读（`dsh/packages/bundle/base/cordis.patch.yml:143-154`）。所以即便注册了，`searchSessions/searchEvents` 在默认 profile 下也不可用。
- 另有 `StoredSessionReader`，走 `ctx.sessionPersistence.open(sessionId,'read')` → `handle.read()`，并把错误分为 missing/refused/corrupt/io【源码】`src/stored-session-reader.ts:149-170`（`open(sessionId,'read')` 在 `:159`，`handle.read()` 在 `:161`）。这是持久化读接口的正规用法范例。
- Team 侧压力策略仍调用已弃用的 `agent.session.ownEvents()`【源码】`community/dsh-agent-team/packages/agent-team/src/context-continuity-host.ts:280`。

(b) **替换摘要**
- `ContinuityCompactionEngine extends BasicCompactionEngine`，只覆写 `summarize()`【源码】`community/contexera-dsh-plugins/packages/context-continuity/src/compaction-engine.ts:110,140-175`。
- 若 `pendingSummaryFor(agent.session)` 存在（agent 通过 `context_compact` 自己写的摘要），直接返回 `[{type:'text',text:authored}]`，不调用 LLM；否则用自有模板调用 `ctx.llm.stream`。
- 这正是「返回插件/agent 构造的摘要而非 LLM 摘要」的干净实现：一次性交接（`src/pending-summary.ts:44` `pendingSummaryFor`）+ 子类覆写。

(c) **阈值**：引擎自身的 auto 监听关闭（`auto: false`），由 Team 的 Host 协调器负责压力提示和硬上限强制压缩【源码】`community/dsh-agent-team/cordis.patch.yml:175-194`（group `isolate: {compaction:true, toolResultPruner:true}`，行 `compaction-basic` → `@contexera/dsh-agent-team/compaction-engine`，`auto: false`）。长间隔门控参数见【源码】`context-continuity-host.ts:196-200`（`tokens/idleMs/judgeTimeoutMs`）。

(d) **平面**：引擎在**预设平面**（team-member 预设的 compaction group），Host 协调器在主机平面。主机侧通过 `this.ctx.agentPresets.serviceFor(agent, 'compaction')` 拿到成员预设里的引擎【源码】`community/dsh-agent-team/packages/agent-team/src/index.ts:2685-2693`。源码注释明确说明：预设修订把服务发布在自己的 isolate 之后，从外部用 `agent.ctx.get` 看不到。

### 1.5 MimicHunterZ/dsh-agent-compact v0.2.0（MIT）

**功能**：`context_compact` 工具。agent 用首/尾锚点选区间并自己写 Markdown 检查点，引擎跳过 LLM 摘要；自动压缩仍走官方引擎。
**宿主依赖**：peer `dsh-compaction-basic 0.2.0-rc.2`、`dsh-llm/tools ^0.2.0-rc.2`【源码】`community/dsh-agent-compact/package.json:66-71`。

- (a) **不提供读取工具**。压缩前把原始区间文本存进 spill（`spillStore.saveText`，`$DSH_HOME/spill/...`）【源码】`src/index.ts:197-218`，`cordis.patch.yml` 把 `spill-local.root` 指到 `dshHomePath('spill')`。区间来源是 `sessionQuery.readSurface(sessionId)`【源码】`src/index.ts:160-163`。读用量时用了已删除的 `session.events`【源码】`:221-238`（catch 后静默）。
- (b) **替换摘要**：`patchEngine()` 在运行时把 `engine.summarize` 换成包装函数：若 `_externalSummary[sessionId]` 存在则一次性返回 `{summary, provider:'agent', model:'agent', llmStreamCall:false}`，否则调用原函数【源码】`src/optimizer.ts:43-71`。工具执行时写入 `_externalSummary`，然后调用 `engine.compactRegion(startSeq,endSeq,agent)`【源码】`src/index.ts:335-366`。
  - 这种 monkey-patch 比子类化更脆弱：依赖引擎实例的可写性，以及 `summarize` 通过 `this` 动态派发【推断】。
- (c) 无压缩阈值，只有 `volumeNudgeTokens`（默认 5 万），用于提醒模型压缩【源码】`src/index.ts:31,265-288`。
- (d) **主机平面**。`resolveService()` 先 `ctx.get(name)`，取不到再 `agentPresets.serviceFor({ctx: agent.ctx}, name)`【源码】`src/index.ts:139-153`，用这种方式拿到 `compaction` / `sessionQuery` / `spillStore`。

### 1.6 Zoria-Lind/dsh-token-optimizer v2.2.2（MIT）

- 功能：输出阶梯、结果缓存、文件 diff、工具裁剪、压缩调度。`dsh.compatibility` 写的是 `<0.2.0-0`，但 `dshReleases` 自称兼容 `0.2.0-rc.2`【源码】`community/dsh-token-optimizer/package.json:29-38`。
- (a) 不提供读取工具。`snapshotEvents()` 只用来数 `turn/start`【源码】`src/modules/compactionDriver.js:23-27,126-138`。
- (b) 不替换摘要。只在 `agent/status === 'idle'` 时按自定义压力比调用 `compaction.compactNow(agent, signal)`【源码】`compactionDriver.js:144,175-200`。分层模式依次为 L1 `toolResultPruner.pruneSession`、L2 `compactNow`【源码】`src/modules/layeredCompact.js:5-13,114-118`。
- (c) 阈值：自定义 ratio（driver 默认 0.45；layered 为 0.4/0.5/0.65），不改引擎本身的阈值。
- (d) 主机平面，通过 `ctx.inject(['compaction','tokenMeter'])` 拿服务【源码】`compactionDriver.js:82-117`。源码注释提醒：web 部署要在 profile 里重新启用被禁用的 compaction-basic（`:117`）。也就是说它**不知道预设平面的引擎**。

### 1.7 dream12347/dsh-session-manager v0.2.3（MIT）

- 功能：会话删除/回收站/恢复/统计/fork，外加**全局压缩阈值**。peer `^0.1.0-rc.6 || ^0.2.0-rc.1`【源码】`community/dsh-session-manager/package.json`（peerDependencies 段）。
- (a) 统计功能通过 `ctx.sessionPersistence.open(id,'read')` → `handle.read()` 读事件，取最后 5000 条【源码】`src/index.ts:697-703,100`。用 `sessionPersistence.locate` 打开日志目录，源码注释写明 0.2.0 起这是私有 API，只是运行时仍存在【源码】`src/index.ts:83-87`。
- (b) 不替换摘要。
- (c) **阈值的设置与暴露**（最直接可借鉴）：
  1. 把 `thresholdRatio` 按行写回预设 `agent.cordis.yml` 的 `- id: compaction-basic` 块（仅限用户预设，系统预设只读）【源码】`src/index.ts:186-226,227-283`；
  2. 对已打开的会话：`agentPresets.serviceFor(agent,'compaction').config.thresholdRatio = ratio`【源码】`:335-360`；
  3. 每次 `agent/pre-step`（`prepend:true`）都重新施加一次【源码】`:401-424`。源码注释说明引擎每次决策都读 `this.config`，所以改完立即生效。
  - 阈值持久化在插件自己的 storageDomain 中（取值范围 0.17–0.9）【源码】`:130-138`。
- (d) 主机平面，通过 `serviceFor` 操作预设平面引擎。

### 1.8 mudaoYLW/dsh-compaction-scroll v0.1.0（MIT）【GitHub 搜索新增，强命中】

- 功能：notes + 原始历史找回 + 显式换窗，借鉴 Codex 的 history/notes，不另调模型生成摘要。精确 peer `@deepseek-ai/dsh* 0.2.0-rc.2`【源码】`community/dsh-compaction-scroll/package.json:38-41`；README 声明兼容基线为 0.2.0-rc.2。
- (a) **原文读取 + 工具**：`scroll_history`，`operation: windows|list|search|read`；`window_id` 取「检查点事件 seq」，`-1` 表示初始窗口【源码】`src/index.js:83-94`。
  - 读取层【源码】`src/log.js:1-72`，文件头注释为 *"Sparse live references plus on-demand durable reads; no synchronous Session log APIs."*：
    - 先 `ctx.sessions.flush(session)`，flush 失败则拒绝（`:18-22`）；
    - 再 `ctx.sessionPersistence.open(session.id,'read',{signal})` → `handle.read(from,count,{signal})`，并校验连续性：`events.length===count`，且每条 `seq===from+offset`（`:23-34`）；
    - `history()` 读 `[0, session.seq)` 全量后，包一层 `snapshotEvents`/`deriveEventMessage` 视图（`:61-70`）；
    - `session/event`（`{global:true}`）只缓存少量需要的活事件（`:11-16`）。
  - 窗口切分 `windowsOf()`【源码】`src/state.js:180-193`。
  - **这是社区中与宿主弃用决定最一致的实现，可作为我们的直接参考。**
- (b) 不用 compaction 引擎：发现 `ctx.get('compaction')` 存在就直接报错退出【源码】`src/index.js:29-30`、`src/admission.js:125`，换窗由 `agent/pre-step` 自行完成。挂 `llm/stream`（`{global:true}`）只是为了发请求前 flush 日志并检查预算，**不改写请求**【源码】`src/admission.js:206-217`。
- (c) 阈值：`contextBudgetTokens`【源码】`src/admission.js:214`。
- (d) **预设平面**：bundle 只插入一个独立的 Web 预设「Minimal Notes」【源码】`cordis.patch.yml:1-4`。

### 1.9 windwhiterain/dsh-history-access v0.1.0（MIT）【新增】

- `history_outline / history_read / history_search`【源码】`community/dsh-history-access/index.js:241,256,334`。只通过 `ctx.sessionQuery.filterEvents` 读取（「唯一与 sessionQuery 交互的模块」）【源码】`lib/query.js:2,95,213,299-300`。
- 首次检查点用 `snapshotEvents?.()` 定位【源码】`index.js:465-475`。
- **懒注册**：在 `compaction/end` 或 `agent/created`（会话已有检查点时）才执行 `agent.ctx.tools.register`，未压缩过的会话不承担工具 schema 的 token 开销；而且 agent 自己这一层不受 `tools.restrict()` 影响【源码】`index.js:18-38`。
- 监听加 `{global:true}`：插件挂在根层时，也能看到预设内 agent 的事件【源码】`index.js:596-605`。
- 压缩后用 `agent.inject` 给模型注入一个历史指针【源码】`index.js:508-575`。
- 参考价值：**懒注册**和 **`{global:true}`** 两点值得借鉴；数据源是 sessionQuery，我们改用持久化读即可。

### 1.10 略读两家
- overact/dsh-context-management v0.3.6（MIT）：分页历史，用的是已弃用的 `session.eventAt(seq)`【源码】`community/dsh-context-management/lib/history-store.js:127,151`。监听 `compaction/end`，并注明「seed（重放）事件不会发布到 session/event」【源码】`lib/index.js:137-141`。
- fengshenx/dsh-remind v0.3.4（MIT）：peer `^0.1.0-rc.6`，`remind` 工具读 `sessionQuery`【源码】`community/dsh-remind/src/index.ts:208`。未深入。

其他搜索结果（未克隆，按描述判断，【推断】相关度较低）：stgmt/dsh-smart-compaction、knighthongyu/dsh-handoff-compaction、john-walks-slow/dsh-clear-mind、treeseed-ai/dsh-chapters、mrbeandev/dsh-hypercompact、joao-paulo-santos/dsh-workspace-history。

---

## 2. 共性提炼（只看我们关心的三点）

### 2.1 「插件自建短摘要替代 LLM 摘要」的落地方式
1. **推荐：子类化 + 一次性交接**（Contexera 模式）。在 `summarize(input, agent, signal)` 里先查 `WeakMap<Session,string>`，有值就返回 `{summary:[{type:'text',text}], provider, model}`，否则 `super.summarize()`【源码】`compaction-engine.ts:140-152`。缺点是必须由我们**挂载**这个引擎类，要求能控制预设里的 compaction 行。
2. **monkey-patch 现有实例**（agent-compact 模式）：不用改预设组合，用 `serviceFor` 拿到实例后包一层 `summarize`【源码】`optimizer.ts:45-71`。缺点是依赖实例结构，宿主升级时容易失效；需要像它一样加 `PATCH_VERSION` 防止重复包裹。
3. smart-compact 的模板内容可直接借鉴：Task + Last action + notes 指针 + history 指针 + 过期提醒 + 脱敏，并预先按最坏情况估算 token，保证满足「检查点严格小于被遮蔽内容」的事务约束【源码】`rollover.ts:213-270`。
4. **没有人拦截 `llm/stream`**（全仓 grep 只有 scroll 用它做 flush 和预算检查）。【推断】在 `llm/stream` 里识别 `purpose:'compaction'` 并伪造流式返回可行，但会绕过 basic 的 usage/provider 记录，没有先例，不建议。

### 2.2 阈值
- 预设平面引擎可以通过 `serviceFor(agent,'compaction').config.thresholdRatio` 在运行时直接改，每步生效（session-manager 已在生产中使用）。持久化可以写回用户预设 yml，系统预设只读。

### 2.3 主机平面如何拿 `ctx.compaction`
- `ctx.agentPresets.serviceFor(agent, 'compaction')`：宿主实现在【源码】`dsh/packages/preset/agent-preset-registry/src/index.ts:324-327`，按 `agent.ctx` 找到所属预设 generation 的 mount，再 `serviceForMount`。Contexera 的注释（`index.ts:2685-2690`）与此一致。

---

## 3. 对照本地 DSH 源码核实自建方案的前提

### 3.1 `session/event` 是否对成员子代理会话的每次追加都触发？
**结论：对活追加（live append）是；对 seed（fork 继承前缀、resume 恢复时的整段旧日志）否。**

- 每次 `append` 最终调用 `commit()`：先 `this.log.push(event)`，再同步调用 `session/event` 观察者（逐个 try/catch 隔离）【源码】`dsh/packages/core/session/src/index.ts:871-898`、`:398-416`。user/assistant/tool/compaction 等所有事件都走这条路径。
- 分发 ctx 是 **SessionStore 自己的 ctx**（`emitCtx: this.ctx`），carrier 为 `scopeTarget(session, scopeOf(this.ctx))`【源码】`index.ts:1209-1220`。
- carrier 的过滤规则：**没有 scope 标签的监听者（主机平面根 ctx）全局放行**；带标签的监听者只在 key 匹配或为祖先时放行【源码】`dsh/packages/core/scope/src/index.ts:159-186`（`if (tag === undefined) return true`）。
- 成员（子代理）会话的创建链路：`subagent/manager.ts:909` 调用 `this.ownerCtx.agents.create(...)` → `core/agent-loop/src/index.ts:654` 调用 `agent.ctx.sessions.enter(session)` → 进入同一个 `sessions` store【源码】。
  - dsh-agent-teams 成员通过 `ctx.subagents` 派生【源码】`src/dsh-agent-teams/src/index.ts:65`、`src/harness-compat.ts:133-138,233`。
- 旁证：JSONL 持久化后端本身就是一个普通的主机平面 `ctx.on('session/event')` 监听者，靠它把**所有**会话（含子代理）落盘【源码】`dsh/packages/session/session-persistence-jsonl/src/storage.ts:534-539`。
- **例外**：seed 事件从不发布到 `session/event`；resume 时 seed 就是完整的已存日志【源码】`core/session/src/index.ts:550-560`（"Seed events never publish on `session/event`"）。所以镜像方案拿不到「插件安装前 / 进程重启前」的历史，也拿不到 fork 继承前缀。
- 监听者在 commit 内同步执行，期间**不能再对同一会话 append**（会抛 `session append cannot reenter`）【源码】`index.ts:862-869`。
- 社区插件在预设内挂载时加了 `{global:true}`（history-access、scroll）。我们是主机平面根层，本身就没有标签，可以不加；加上也无害【推断】。

### 3.2 会话日志在磁盘上的位置与格式；插件能否安全读取
- 根目录：`$DSH_HOME/sessions`（base bundle 中 `session-persistence-jsonl.config.root: dshHomePath('sessions')`）【源码】`dsh/packages/bundle/base/cordis.patch.yml:133-136`。
- 路径：`<root>/<projectKey(cwd)>/<encodeSegment(sessionId)>/session.v4.jsonl.zstd`
  - `projectDir`/`sessionDir`/`logPath`【源码】`dsh/packages/session/session-persistence-jsonl/src/format.ts:254-300`；
  - 文件名 `session.v${version}.jsonl` + 压缩后缀（v0 为 `session.jsonl`）【源码】`dsh/packages/session/session-format/src/filename.ts:14-17`、`format.ts:42-48,58-60`；
  - 当前 `SESSION_FORMAT_VERSION = 4`【源码】`dsh/packages/core/session/src/types.ts:89`；
  - cwd 为空时目录名是 `_no-cwd`（`format.ts:255`）。
- 格式：首行 header，之后每行一个事件；默认是**带校验的 Zstandard 帧**（`compression` 默认 zstd，`index.ts:89-101`），可能存在残缺尾巴（torn tail）、多代际（generation）迁移，以及 `session.lock`（POSIX `flock`）写租约【源码】`lease.ts:4-8,40`。
- **直接读文件不安全/不划算**：要自己实现 zstd 解码、残缺尾巴截断、代际选择和格式迁移；而且官方 `locate` 在 0.2.0 起已改为私有（session-manager 注释，`community/dsh-session-manager/src/index.ts:83-87`）。另外活会话的事件在 flush 前还在内存缓冲区，文件内容是滞后的。
- **正规读法是持久化服务**：`open(id, 'read')`「从不取得所有权，即使其他句柄或进程持有写权也能工作」【源码】`dsh/packages/session/session-persistence/src/index.ts:154-167`；`handle.read(offset?, length?, {signal})` 返回合法的连续前缀切片，不会读到残缺尾巴，同一句柄上的读取单调前进【源码】`dsh/packages/session/session-persistence/src/handle.ts:73-83`。
  - 新鲜度契约：`append/flush` resolve 之后再开始的读取，至少能看到那段前缀【源码】`session-persistence/src/index.ts:134-135`。所以读之前先调 `ctx.sessions.flush(session)`，这是 store 提供的唯一 flush 入口【源码】`core/session/src/index.ts:1305-1333`。
  - 成本：JSONL 后端每次读取会解码整个当前代际文件（按文件 revision 记忆化）【源码】`session-persistence-jsonl/src/index.ts:753-786`。工具按需偶尔调用可以接受；不适合每步都调用。

### 3.3 是否存在非弃用的读取 API
- 已弃用：`Session.eventAt / snapshotEvents / ownEvents`【源码】`core/session/src/index.ts:704-744`。宿主决策文档写明「新调用一律禁止；按需呈现的历史内容使用显式异步分页、渐进加载」【源码】`dsh/.agents/notes/implemented/architecture/2026-09-09-deprecate-synchronous-session-event-reads.md:15,25`。
- **非弃用、可用：**
  1. `ctx.sessionPersistence.open(id,'read')` + `handle.read(offset,len)`：与上述决策的「显式异步分页」完全一致（§3.2）。
  2. `ctx.sessionQuery.readSession / filterEvents / listEvents / readSurface`：公开 API，没有 `@deprecated`【源码】`dsh/packages/session-query/session-query/src/index.ts:179-310`。base bundle 默认挂载（`openAt: never` 时只关闭全文搜索）【源码】`bundle/base/cordis.patch.yml:143-154`。
     - 但它对活会话**内部仍调用已弃用的 `snapshotEvents()`**（带豁免）【源码】`session-query/src/corpus.ts:253-254,308-309`、`observation.ts:302-303`，并且每次加载、克隆整条日志再过滤。`searchEvents/searchSessions` 默认被禁用。
  3. `Session.deriveEventMessage(event)` 未弃用，可把事件投影成 Message【源码】`core/session/src/index.ts:1007-1015`；`extractSessionEventText` 为宿主导出的文本投影【源码】`session-query/src/index.ts:73`。
- 宿主自己的提案「recallable compaction」也计划新增 `dsh-tool-recall`，使用「显式异步分页历史读取」，**不新增存储、不加旁路索引**，依据 `compaction/summary.shadowedRange/shadowedSeqs` 定位【源码】`dsh/.agents/notes/proposed/feature/2026-07-06-recallable-compaction.md:42-49`。我们的方案与上游方向一致，将来可以平滑迁移过去。
- `compaction/summary` 事件字段：`compactionId`、`shadowedRange{start,end}`、`shadowedSeqs`【源码】`dsh/packages/compaction/compaction/src/types.ts:34-39`。

---

## 4. 推荐方案（dsh-token-budget 的只读 history 工具）

### 方案对比
| 方案 | 覆盖面 | 合规性 | 成本/风险 |
|---|---|---|---|
| **A. 持久化读（推荐）**：`sessions.flush` → `sessionPersistence.open(id,'read').read(off,len)` | 全量：含 resume、fork 前缀、安装前的历史，以及成员子代理会话（都会落盘） | ✅ 正是弃用决策指定的路径；scroll 已在 0.2.0-rc.2 上跑通 | 每次读取解码整个文件（有记忆化）；需要 flush；需处理 `inheritedEventCount` |
| B. `ctx.sessionQuery.filterEvents/readSession` | 同 A（live-preferred） | API 本身不弃用，但内部依赖已弃用的读取；用户反馈「可能不可靠」 | 每次克隆整条日志；全文搜索默认关闭 |
| C. 插件自写 JSONL 镜像（`session/event` → 按窗口打标签） | **缺 seed/resume/fork 前缀和安装前的数据**，最终还得退回 A 补齐 | ✅ | 双份存储（隐私、磁盘）；监听在 commit 热路径上同步执行；崩溃后一致性要自己保证 |
| D. 直接解析 `$DSH_HOME/sessions/.../session.v4.jsonl.zstd` | 全量，但 flush 前数据滞后 | ❌ 依赖私有格式（`locate` 已私有化） | zstd、残缺尾巴、迁移、租约都要自己处理；宿主升级就会失效 |

### 建议实现要点
1. **数据源**：A 为唯一权威；sessionPersistence 不可用时回退到 B（`sessionQuery.readSession`），两者都不可用就报错（fail-loud）。只读：工具里不 append、不改任何状态。
2. **窗口编号**：`window = 1 + 在该事件之前已提交的 compaction/summary 数`。`list_windows` 返回每个窗口的 `{window_id, seq 范围, 事件数, shadowedTokenCount}`，被遮蔽范围取自 `compaction/summary.data.shadowedSeqs`（smart-compact `history.ts:113-126`、scroll `state.js:180-193` 同理）。默认只返回被遮蔽（已不在当前窗口）的事件，可选包含当前窗口。
3. **轻量索引而非镜像**：主机平面 `ctx.on('session/event')` 只记录 `compaction/summary` 的 seq，以及每个会话的 `session.seq`（无标签监听，能覆盖成员会话，§3.1）。首次调用工具或遇到 resume 时，用 A 读一遍重建索引。内存中按 sessionId 做 LRU 缓存渲染结果，以 `stat().revision` 判断是否失效（`session-persistence/src/index.ts:181-196`）。**不落盘副本。**
4. **工具形态**：对齐 Codex（`list_windows / list_items / read_item / search_contents`，`codex/codex-rs/ext/history-notes/src/tools.rs:57-80,143-190`）。参数包括 `window_id`、`role`（user/assistant/tool）、`tool_name`、`limit`、`recent_first`、`max_chars_per_item`、`offset_chars`。文本用 `extractSessionEventText` 投影；需要还原 Message 时用 `session.deriveEventMessage`。输出全部按 token 截断，说明里注明「seq 有空洞属正常」。
5. **fork 前缀**：成员会话若带 fork seed，`handle.inheritedEventCount` 之前的事件属于父会话（队长）。默认只读 `seq >= inheritedEventCount`，或者标注为 `inherited`，避免越权读取队长上下文（Contexera 的归属折叠可参考，`search.ts:369-399`）。
6. **可见性**：参考 history-access 的懒注册：在 `compaction/end` 或 `agent/created`（已有检查点时）执行 `agent.ctx.tools.register`，未压缩过的会话不承担 schema 开销，也绕开 `tools.restrict()` 和 web bundle 对主机平面工具行的屏蔽（Contexera 注释 `community/dsh-agent-team/cordis.patch.yml:143-146` 提到 web bundle 会禁用主机平面面向模型的工具行）【推断：需在成员预设上实测工具是否可见】。
7. **与摘要替换配合**：若采用「插件构造短摘要」，用 Contexera 的一次性交接模式，通过 `serviceFor(agent,'compaction')` 拿到引擎后 patch `summarize`（agent-compact 模式，因为我们不控制成员预设的组合）。摘要里写入任务契约 + notes 指针 + 「细节用 history 工具按 window_id 回查」，并按最坏情况保证小于被遮蔽内容（smart-compact `rollover.ts:213-270`）。阈值仿照 session-manager，在 `agent/pre-step` 中对 `engine.config.thresholdRatio` 赋值。

### 风险与待验证
- 【推断】`sessions.flush` 依赖持久化后端监听 `session/flush`。在没有持久化后端的 profile（如纯内存 SDK）中返回 false，这时应回退 B。
- 【推断】超长会话（数万事件、zstd 文件数十 MB）每次缓存失效都要整文件解码。可按 revision 做缓存，并只在工具调用时触发。
- 【推断】0.2.1-alpha.2 与 scroll 声明的 0.2.0-rc.2 之间，`sessionPersistence.open/read` 签名未见变化（本地源码 `handle.ts:83`、`index.ts:167` 与 scroll 的调用一致），仍需在真实 profile 上冒烟测试一次。
- Contexera 的 continuity peer 上限是 `<0.2.1`，不能作为运行时依赖，只作设计参考。
