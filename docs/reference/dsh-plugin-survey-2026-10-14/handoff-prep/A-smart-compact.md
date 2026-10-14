# A. dsh-smart-compact 的「零模型交接模板（rollover）」实现调研

> 用途：给 dsh-token-budget 设计交接模板做参考。
> 源码：
> - **H 版** = `/workspace/work/hoyyang_dsh-smart-compact`，v0.5.3，HEAD `b5a074e`（2026-09-29，hoyyang）
> - **L 版** = `/workspace/work/Liangebra_dsh-smart-compact`，v0.1.0，HEAD `051bfb3`（2026-08-15，Liangebra Hao）
> - 宿主基类：`H/node_modules/@deepseek-ai/dsh-compaction-basic/lib/index.js`（0.1.5-rc.2，下文记作 **basic**）
>
> 两个仓库都只有 1 个提交（历史已压平），`git log` 查不到逐次演进，演进信息只能从 H 版 `CHANGELOG.md` 和代码注释里的事故编号拿。
> 下文 `文件:行号` 若不写仓库前缀，就是 H 版。

---

## 0. 一句话结论

- **只有 H 版有零模型交接模板。** L 版是完全不同的插件（同名不同实现）：一种 DCP 风格的「模型自己写摘要 + 引擎 LLM 兜底」压缩引擎，**没有模板、没有 notes、也没有覆写 `summarize()`**（它直接继承 `CompactionEngine`）。
- H 版的模板是一段**单行英文**文本，由固定句子加上 3 条从会话日志里机械提取的定向行拼成（Task / Last action / 笔记之后的工具活动），**根本不把 ctx_notes 的内容放进模板**：它只探测笔记「有没有」「新不新鲜」，再让新窗口自己调用 `ctx_notes` 去读。
- H 版**完全没有回退到 LLM 的路径**。所谓「回退」只是模板措辞降级（有笔记 → 没笔记 → 笔记过期）。唯一会用到 LLM 摘要的情形是：压缩槽位被别的引擎占了，这时 H 版的引擎根本没挂上。

---

## 1. 模板的完整内容与结构（H 版）

### 1.1 构造函数原文

`src/rollover.ts:213-247` `buildHandoffCheckpoint(generation, notesAssured, context?, staleness?)`：

```ts
  const stale = staleness?.stale === true
  const stamp = stale && staleness ? utcStamp(staleness.lastWriteAtMs) : ''
  const notesLine = !notesAssured
    ? 'Handoff: this session has no ctx_notes yet — there is nothing to read there.'
    : stale
      ? `⚠️ Handoff notes are STALE: last ctx_notes write ${stamp}; ${staleness!.eventsAfter} activity event(s) happened after that in the archived window.`
      : 'Handoff: current goal, decisions, and next steps live in ctx_notes (read it first).'
  const carryLine = !notesAssured
    ? "Continue the user's task; reconstruct missing context via ctx_history (and any persisted project memory) before assuming it."
    : stale
      ? `Do NOT treat the notes as current: reconcile with ctx_history search/read (and git / project memory) before continuing; the notes cover only up to ${stamp}.`
      : "Continue the user's task from the notes; do not assume anything not written there."
  return [
    `${ROLLOVER_TEMPLATE_MARKER} Context window #${openedWindowNumber(generation)} opened.`,
    'The previous window was archived in full — nothing was summarized away or lost.',
    'The newest exchange remains visible in this window; the archive covers everything older (nothing was dropped).',
    ...(context?.task ? [`Task: ${context.task}`] : []),
    ...(context?.last ? [`Last action: ${context.last}`] : []),
    ...(stale && context?.recent ? [`Mechanical activity after the last note: ${context.recent}.`] : []),
    notesLine,
    'Missing details: ctx_history search/read recalls exact original events on demand.',
    carryLine,
  ].join(' ')
```

- `ROLLOVER_TEMPLATE_MARKER = '[smart-compact rollover]'`（`rollover.ts:71`）
- `utcStamp()` 输出 `YYYY-MM-DD HH:MM UTC`，出错时给 `<unknown time>`（`rollover.ts:202-204`）
- 用 `.join(' ')` 拼接，**整段是一行，没有换行和 Markdown 结构**（`rollover.ts:246`）

### 1.2 逐段结构与数据来源

| # | 段落 | 是否条件出现 | 数据源 | 证据 |
|---|---|---|---|---|
| 1 | `[smart-compact rollover] Context window #N opened.` | 必有 | N = `generation + 2`；generation = 日志中 `compaction/summary` 事件的计数（`summarize()` 在本次 summary 提交**之前**运行，所以要 +2） | `rollover.ts:61-69`、`377-382` |
| 2 | `The previous window was archived in full — nothing was summarized away or lost.` | 必有 | 常量 | `rollover.ts:233` |
| 3 | `The newest exchange remains visible in this window; the archive covers everything older (nothing was dropped).` | 必有 | 常量。依据是基类 retain-last 语义（见 §5） | `rollover.ts:234-239` |
| 4 | `Task: <标题>` | 有标题时 | 最新一条 `session/title` 事件的 `data.title`，取首个非空行，截到 80 字符再加 `…`，然后**脱敏** | `rollover.ts:175-193`、`157-161`、`74`、`408` |
| 5 | `Last action: <文本>` | 有内容时 | 最新一条「内容事件」的 `eventText()` 首行，截 80 字符并脱敏。内容事件 = 类型不以 `compaction/ session/ request/ step/ turn/ agent/ model/ sandbox/ approval/ permission/` 开头，且不是 `system/message`；文本投影用宿主的 `extractSessionEventText` | `rollover.ts:163-168`、`185-188`、`history.ts:71-85`、`rollover.ts:409` |
| 6 | `Mechanical activity after the last note: a@HH:MM, b@HH:MM.` | **只在 stale 时出现** | 笔记最后写入时刻之后的 `tool/call` / `tool/ptc-dispatch` 事件：只取工具名（≤32 字符）加 UTC 时分，最多 3 条，按旧到新排列，脱敏；**不带参数，也不带结果** | `rollover.ts:141-155`、`92-95`、`403` |
| 7 | notesLine（三选一） | 必有 | `notesAssured` 来自 `hasNotes` 探针（notes 文件非空），stale 来自 `lastNoteWrittenAt` 与日志时间的比较 | `rollover.ts:221-225`、`387-395`、`425-433` |
| 8 | `Missing details: ctx_history search/read recalls exact original events on demand.` | 必有 | 常量 | `rollover.ts:244` |
| 9 | carryLine（三选一） | 必有 | 与第 7 段同源 | `rollover.ts:226-230` |

**模板不包含笔记正文**，只引导新窗口去调 `ctx_notes read`。笔记正文要等模型下一步自己调工具才会进入上下文。

### 1.3 实际渲染样例（用 vitest 调 `buildHandoffCheckpoint` 跑出来的真实输出）

**A. 有笔记、新鲜（经典锚点）**
```
[smart-compact rollover] Context window #2 opened. The previous window was archived in full — nothing was summarized away or lost. The newest exchange remains visible in this window; the archive covers everything older (nothing was dropped). Task: 重构计费模块 Last action: appended segment #3 (handoff) Handoff: current goal, decisions, and next steps live in ctx_notes (read it first). Missing details: ctx_history search/read recalls exact original events on demand. Continue the user's task from the notes; do not assume anything not written there.
```
**B. 没有笔记**
```
[smart-compact rollover] Context window #2 opened. The previous window was archived in full — nothing was summarized away or lost. The newest exchange remains visible in this window; the archive covers everything older (nothing was dropped). Handoff: this session has no ctx_notes yet — there is nothing to read there. Missing details: ctx_history search/read recalls exact original events on demand. Continue the user's task; reconstruct missing context via ctx_history (and any persisted project memory) before assuming it.
```
**C. 笔记过期（stale）**
```
[smart-compact rollover] Context window #3 opened. ... Task: 重构计费模块 Last action: x Mechanical activity after the last note: bash@06:18, edit@06:19. ⚠️ Handoff notes are STALE: last ctx_notes write 2026-09-29 02:12 UTC; 4 activity event(s) happened after that in the archived window. Missing details: ctx_history search/read recalls exact original events on demand. Do NOT treat the notes as current: reconcile with ctx_history search/read (and git / project memory) before continuing; the notes cover only up to 2026-09-29 02:12 UTC.
```
最坏情况模板 `handoffCheckpointWorstCaseText()` 长 957 字符（`rollover.ts:261-270`）。

### 1.4 模板落地前还会被基类再包一层

basic 的 `frameSummary()`（`basic index.js:323-335`）会把 `summary` 包成 3 个 text block：
1. `CHECKPOINT_PREAMBLE + "\n\n<compacted-summary>"`。PREAMBLE 原文是："This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. Treat the captured context as established background and build on it without restating it. Continue the task directly from the messages that follow, without acknowledging this checkpoint."（`basic index.js:257`）
2. 模板本身
3. `</compacted-summary>`

包好之后作为一条 `user/message`，通过 `surfaceOp: replace` 替换掉被归档的区间（`basic index.js:565-578`、`621-632`）。
⚠️ 注意：PREAMBLE 说的是「condensing」，模板却说「nothing was summarized away」，两者措辞矛盾，模板作者无法修改 PREAMBLE。

---

## 2. 如何覆写 `summarize()`，以及怎样接入 compaction 引擎

### 2.1 用子类，而不是实例补丁

- `export class RolloverCompactionEngine extends BasicCompactionEngine`（`rollover.ts:305`），构造时 `super(ctx as never, config)`（`313-318`）。
- `override async summarize(_input, agent, _signal)`（`rollover.ts:376-423`）**完全忽略 `input`**（基类重放出来的消息前缀），只读 `agent.session` 的日志。
- basic 官方把它定义为唯一扩展点：`summarize()` is the sole subclass customization hook（`basic types/index.d.ts` 类注释）、`Override this sole hook for a template or remote summarizer`（`basic index.js:852-853`）。
- 能动态分派到子类，是因为 `regionDependencies()` 返回的是 `summarize: (input, owner, abort) => this.summarize(input, owner, abort)`（`basic index.js:972-977`），压缩事务 `summarizeCompaction` 调的是 `dependencies.summarize`（`basic index.js:565-566`）。

### 2.2 返回值形状

```ts
return { summary: [{ type: 'text', text: buildHandoffCheckpoint(...) }], provider: 'rollover-template', model: 'none' }
```
（`rollover.ts:417-422`）

- 契约类型 `SummaryResult` 是 `{ summary: ContentBlock[]; provider; model; maxTokens?; usage? } & ({rawOutput; llmStreamCall: true} | {rawOutput?; llmStreamCall?: never})`（`basic types/summarizer.d.ts`）。
- H 版**不带** `usage`、`maxTokens`、`rawOutput`、`llmStreamCall`，走的是「未标记的模板摘要器」那一支。测试明确断言了 `llmStreamCall` 为 undefined、`streamCalls === 0`（`tests/engine.test.ts:82-95`）。
- 这些字段由 `commitCompactionBody` 写进 `compaction/summary` 事件：`provider/model` 原样写入，`maxTokens/usage` 缺省时省略（`basic index.js:599-620`）。所以在日志里能用 `provider==='rollover-template'` 识别模板换窗。
- 对比 basic 默认 LLM 路径的返回：`{summary, rawOutput, llmStreamCall:true, provider, model, maxTokens, usage?}`（`basic index.js:308-316`）。

### 2.3 怎样接入引擎（装配链）

1. `index.ts:94-116` 用 `new RolloverCompactionEngine(engineCtx, basicCfg, rolloverCfg, pending)` 构造。
   - `basicCfg = { thresholdRatio, auto, retainRatio? }`
   - `rolloverCfg` 注入 `hasNotes: notes.hasNotes`、`lastNoteWrittenAt: notes.lastWrittenAtMs` 两个探针（`index.ts:112-113`）以及 ops 回调。
2. `CompactionEngine` 本身是 cordis `Service('compaction')`（`dsh-compaction/lib/index.js:172-175`），构造时就会占用唯一的 `compaction` 槽位。如果已被占用，会抛 `service compaction has been registered`，插件捕获后降级为「只装工具和提醒」（`index.ts:123-135`）。
3. basic 构造时若 `auto=true`，就注册 `agent/pre-step`（触发 `compactIfNeeded('pressure')`）和 `agent/request-error`（上下文溢出时触发 `compactIfNeeded('context-overflow')` 再 retry）这两个监听（`basic index.js:783-847`）。H 版覆写的 `compactIfNeeded` 因为动态分派而生效（`rollover.ts:441`）。
4. 手动 `/smart-compact` 调用 `engine.compactNow()`（`command.ts:463`），H 版在 `compactNow` 上加了一层簿记（`rollover.ts:533-537`）。
5. `engineCtx = ctx.isolate('toolResultPruner')`（`index.ts:82-91`）：把第三方 pruner 屏蔽掉，不让基类在压缩前去调它（曾经有旧版 pruner 读已删除的 `session.events`，导致每次 rollover 都中止）。

### 2.4 压缩事务对模板的硬约束（尺寸不变量）

`summarizeCompaction` 要求包装后的 checkpoint 的 token 数**严格小于**被遮蔽区间的路由 token 数，否则抛 `summary is not smaller than the shadowed content (X estimated framed tokens >= Y)`（`basic index.js:571-572`）。
所以模板必须**有上界、可预估**。H 版的做法：
- 所有派生行都有硬上限（80 字符、32 字符、最多 3 条）。
- 导出 `handoffCheckpointWorstCaseText()`，用 98 号窗口、80 个「汉」字填充、STALE 措辞加满额活动尾来生成最坏情况（`rollover.ts:254-270`），供按钮可用性探针按最坏情况计价，再加 48 token 的余量（`state.ts:189-213`）。
- 手动路径一旦撞上这个约束，会解析出数字给出中文回执（`command.ts:353-369`）。

---

## 3. 何时用模板、何时回退 LLM

### 3.1 结论

- **H 版里，只要引擎挂上了，所有换窗都用模板，没有任何 LLM 回退**：pressure、overflow、new_context、手动 `/smart-compact` 都走 basic 事务，而事务都调 `this.summarize`，也就是模板。
- 唯一会走 LLM 摘要的情形是 **compaction 槽位被别的引擎占用**（`index.ts:133-135`）。这时用的是别人的引擎（比如 basic 或 glm），不是 H 版的回退逻辑。CHANGELOG 0.5.0 里记录的 billing-session 事故（"a hot session fell through to the host's LLM summarizer"）就是这种情况（`CHANGELOG.md` 0.5.0 段落）。
- 如果 `summarize()` 本身抛错（比如 `sessionEvents()` 发现宿主没有 `snapshotEvents` 就 fail-loud，见 `history.ts:40-47`，而 `rollover.ts:381` 没有 catch），basic 会写一条带 error 的 `compaction/end`，换窗失败但**不回退 LLM**（`basic index.js:470-490`）。

### 3.2 「新鲜度/质量判定」= 模板措辞的三档降级

| 判定 | 条件 | 阈值 | 模板变化 | 证据 |
|---|---|---|---|---|
| 笔记存在 | `hasNotes(sessionId)` 返回 false 时**才**算没有。探针不存在、抛错或返回 true，一律当作有；session.id 不是字符串时也当作有 | notes 文件内容 `!== ''` | B 变体：「no ctx_notes yet」，改走 ctx_history 重建 | `rollover.ts:387-388`、`425-433`、`notes.ts:102-104` |
| 笔记新鲜 | 只有 notesAssured 时才探测。`lastNoteWrittenAt` 取最新段头的 ISO 时间戳；探针抛错或返回 null 视为未知，按新鲜处理 | **严格 `event.time > lastNoteMs` 的内容事件 ≥ 1 条就算 STALE**，没有容差窗口。从尾部往前扫，遇到无 `time` 的事件就停（无法证明的不下结论） | C 变体：⚠️ STALE，附写入时间、事件数和机械活动尾 | `rollover.ts:391-395`、`119-133`、`414-416`、`notes.ts:112-118` |
| 定向行质量 | 没有内容就省略该行；任何异常都吞掉，返回空字符串 | 80 / 32 字符，3 条 | 少行而已 | `rollover.ts:175-193`、`141-155` |
| 脱敏 | 只作用于 Task / Last / recent；记一条日志（只含计数和标签） | 固定正则集：手机号、邮箱、证件号、中英文公司后缀 | 替换为 `【已脱敏:标签】` | `rollover.ts:403-413`、`redact.ts:242-277` |

### 3.3 什么时候触发换窗（三段策略）

`compactIfNeeded`（`rollover.ts:441-521`）：

- **有 new_context 挂起**（`pending.has(session)`）：先做预算预检（失败只计数，不拦截），然后 `super.compactIfNeeded(trigger)`；返回 null 时再以 `'context-overflow'` 重试（retain=0、绕过阈值）。成功才 `consumeRollover`，失败或拒绝则请求保持挂起，下一步重试，并调用 `onRolloverRefused`（`455-489`）。
- **pressure**（`491-517`）：
  - `total < contextWindow × thresholdRatio`（默认 0.85，`config.ts:396`）：什么也不做。
  - `total ≥ threshold + fallbackBufferTokens`（默认 8192，`config.ts:397`）：强制 `super.compactIfNeeded`。
  - 两者之间是**宽限带**：每个窗口代只记一次日志，提示该写 ctx_notes 了（模型看到的提醒来自 `reminder.ts`，见下）。
- **其他 trigger（overflow）**：直接交给 basic（`518-520`）。
- 预算测量失败：连续 5 次标记 `budgetDegraded`（`rollover.ts:272`、`344-356`）。

配套提醒（`reminder.ts`）：首次组装 prompt 时注入一次简报（`69-74`）；用量到 25/50/75% 各提示一次（`63-67`）；用量 ≥ thresholdRatio 或 remaining ≤ buffer 时，每个窗口代发一次「写 ctx_notes」的宽限提醒（`145-160`）。都是通过 `system-prompt/assemble` 追加到 system 或 developer 字段（`106-112`）。

---

## 4. 笔记和状态从哪里读、大小上限、怎么截断

### 4.1 存储位置
- 根目录：`cfg.notesDir`，默认 `dshHomePath('dsh-smart-compact/notes')`（`index.ts:61`）。
- 单文件：`<root>/<sanitizeSessionId(id)>/notes.md`，非 `[A-Za-z0-9_-]` 的字符替换为 `_`（`notes.ts:11-15`、`47-49`）。
- 格式：段头 `## notes <n> — <ISO时间> <标题>`，解析正则 `^## notes (\d+) — (\S+) (.*)$`（`notes.ts:24-41`）。
  - `write` = 原子性整体替换（先写 tmp 再 rename），重置为单段 `notes 1 ... (full replace)`（`notes.ts:61-73`）。
  - `append` = 追加新段，序号续接（`notes.ts:76-89`，**不是原子操作**，`appendFile`）。
- 引擎在换窗时只读两项元数据：`hasNotes`（整文件非空）和 `lastWrittenAtMs`（最后一段头的时间戳）（`notes.ts:102-118`）。**正文不进入模板。**
- 其他状态：`<dsh home>/dsh-smart-compact/engine-state.json`，只用于运维观测，引擎不读（`index.ts:179-209`）；new_context 的挂起状态放在内存 `WeakSet`（`new-context.ts:525-536`）；窗口代数从日志实时计算（`rollover.ts:61-64`）。

### 4.2 大小上限与截断
- **写入没有上限**：`write/append` 只校验非空（`index.ts:311`、`316`）。
- **读取上限** = `maxToolOutputTokens`，默认 8192，最低 256（`config.ts:398`、`420-421`）。token 按 `chars/4` 估算（`config.ts:436-438`）。
- `truncateToTokens`（`config.ts:441-447`）：超过 `budget×4` 字符就**保留头部**，在最后一个换行处截断（但最多回退 200 字符），并追加 `…[truncated: <what> exceeded the N-token output budget; narrow your query]`。
- `ctx_notes read`（不带段号）对整个文件调用这个函数（`notes.ts:95`）。⚠️ 由于保留的是头部，**追加式笔记超过 32K 字符时，被截掉的恰恰是最新的段**（见 §7）。按段号读取或 search 时同样截断（`notes.ts:98`、`132`）。
- 模板内的定向行另有硬上限（80 / 32 字符 × 3 条），见 §1.2。

---

## 5. 原文保留策略，以及与最后一个节点/工具配对的关系

### 5.1 原文永不删除
- 被换窗的区间只是从 surface 上「遮蔽」，原事件仍留在 append-only 日志里。`compaction/summary` 事件记录 `shadowedRange`、`shadowedSeqs`、`shadowedTokenCount`，替换消息的 `sourceEventSeqs = [startSeq, summarySeq, ...shadowedSeqs]`（`basic index.js:605-632`）。
- `ctx_history` 直接读日志：list 按 `compaction/summary` 列出窗口，read 按 seq 投影原文，search 默认只搜已归档内容（`history.ts:103-172`）。**这部分原文不做脱敏**（`redact.ts:211-214`）。

### 5.2 区间选择（basic 的 `selectCompactableRange`，`basic index.js:393-416`）
- surface 的第 0 个节点如果是 `system/message`，永远不进区间（`firstIdx`）。
- 从尾部往前累加 token，直到达到 `retainTokens`，得到 `keepFromIdx`；接着往前挪，直到 `toolPairingBalancedBefore(keepFromIdx)`（不切断 assistant tool-call 与 tool-result 的配对）；区间 = `[firstIdx, keepFromIdx-1]`。
- **retain=0 时（手动、overflow、new_context 回退）**：循环第一次迭代就满足 `accumulated >= 0`，`keepFromIdx` = 最后一个下标，所以**最新一个 surface 节点永不被遮蔽**（即 retain-last）。H 版在 `state.ts:215-226` 和 `history.ts:174-183` 里都把这一点写成了「承重」注释，模板第 3 句就是在向新窗口声明这件事（`rollover.ts:234-239`）。
- **工具配对**：如果最后一个节点是 tool/result，配对检查会让 `keepFromIdx` 继续前移到对应的 assistant tool-call 之前，于是整组 call+results 都留在新窗口。`validateSurfaceRegion` 再对两端做一次平衡校验（`basic index.js:540-541`）。step 未闭合时 `toolPairingBalancedAfter` 失败，不能换窗。
- **pressure 路径**：retain = `floor(contextWindow × retainRatio)`，默认 0.16（`basic index.js:17`、`112`，H 的 `index.ts:96` 只在用户配置时透传）。也就是说**自动换窗会保留大约 16% 窗口的原文尾部**，而模板第 3 句「The newest exchange remains visible」在这种情况下低估了保留量（措辞固定，不区分路径）。
- **按钮可用性探针**复刻了 retain=0 的区间计价（`state.ts:227-249`）。

### 5.3 事务与锁
`compaction/start`（持久锁）→ summarize → 稳定性校验（自动路径要求整个 surface 不变，手动路径只要求所选区间不变）→ `compaction/summary` + replace 消息 → `compaction/end`；任何失败都会补一条带 error 的 end（`basic index.js:433-505`、`579-597`）。

---

## 6. 两版之间的差异

| 维度 | H 版（hoyyang v0.5.3） | L 版（Liangebra v0.1.0） | 证据 |
|---|---|---|---|
| 定位 | Codex 式「硬换窗」，零模型交接模板 | DCP 式：模型用 `compress` 工具自己写摘要，引擎 LLM 兜底 | H `rollover.ts:1-14`；L `src/index.ts:1-22`、`docs/design.md` |
| 继承关系 | `extends BasicCompactionEngine`，只覆写 `summarize/compactIfNeeded/compactNow` | `extends CompactionEngine`（抽象层），自己实现整个事务 | H `rollover.ts:305`；L `index.ts:71` |
| 覆写 summarize | 是，返回固定模板 | **否**，`summarizeRange()` 直接调 `llm.stream` | L `summarize.ts:29-62` |
| 模板 | 有（见 §1） | **无**。只有一个可配置的 LLM 摘要提示词 `DEFAULT_SUMMARY_PROMPT`（6 个 Markdown 段：Context / Files and Code / Decisions and Rationale / Errors and Fixes / Pending Work / Next Step），`{content}` 占位 | L `prompt.ts:70-91` |
| LLM 使用 | 从不 | `/compact`、强制线（mandatory）兜底、overflow 一律走 LLM；模型主动用 compress 时引擎不调 LLM（摘要由主模型在当前轮里写） | L `index.ts:389-470`、`383-387` |
| summary 事件字段 | `provider:'rollover-template', model:'none'` | provider/model 取 agent.options；LLM 路径标 `llmStreamCall:true`，但 `rawOutput: summary`（**并非真正的原始输出**）；没有 usage | L `index.ts:309-323` |
| 包装 | 由 basic `frameSummary` 加 PREAMBLE 和 `<compacted-summary>` | **不包装**，摘要原文直接作为 checkpoint 消息 | L `region.ts:110-117` |
| 尺寸不变量 | 有（由 basic 强制） | **无**（不检查摘要是否小于原文） | — |
| 笔记 | ctx_notes（文件）加存在性和新鲜度门 | **无** | — |
| 原文召回 | ctx_history 工具 | `dcp_status` 只展示块账本，**没有 read 原文工具**（原文在日志里，模型拿不到） | L `compress-tool.ts:454-496` |
| 阈值 | threshold 0.85 + buffer 8192 tok；基于 `totalTokens` | threshold 0.5（提示）/ mandatory 0.9（每轮兜底一次）；基于 `surfaceTokens`；窗口探测失败时回退 128000 | L `config.ts:126-137`、`index.ts:165-192` |
| 原文保留 | 只保留最新 1 个节点（retain=0）或 16% 尾部，外加工具配对平衡 | `preserveRecent=5` 个节点、最新一条真实用户消息、所有 checkpoint、`protectedTools` 配对，可选保留全部用户消息；`resolveSurfaceRange` 先向内收缩、不行再向外扩展以求配对平衡 | L `region.ts:217-341`、`index.ts:217-247` |
| 选哪段 | 从头（system 之后）到保留尾之前，一次性全部归档 | 选 **token 最多**的可压缩段（`ranges[0]`，按 tokens 降序） | L `region.ts:340`、`index.ts:391-393` |
| 宿主 API | `session.snapshotEvents()`（dsh ≥ 0.1.5-rc）；surfaceOp `{startSeq,endSeq}`（由 basic 写） | `session.events[...]`、surfaceOp `{start,end}`；锁定 `0.1.0-rc.6` | H `history.ts:24-47`；L `region.ts:79`、`115`、`package.json` |
| token 计数 | 宿主 tokenMeter | 自制 `countTokens`（CJK 1 字算 1 token，其余 4 字符算 1 token） | L `tokens.ts:211-221` |
| 测试 | 123 项（实测 122 通过，1 项超时，见 §7） | 33 项（`tests/*.ts`，本地没有 node_modules，未运行） | — |

**对 token-budget 的含义**：L 版对「交接模板」**没有可借鉴的实现**。可借鉴的只有它的保护区间策略（最新用户消息、checkpoint、`protectedTools` 永不遮蔽）和向内收缩/向外扩展的配对平衡算法。

---

## 7. 已知的坑

### 7.1 代码里明确写出的警告、事故和限制
1. **尺寸不变量导致刚换完窗时无法再换**：新窗口内容太少时 `215 ≥ 193` 这类拒绝在线上实测过 3 次（`state.ts:149-161`、`221-224`；README:113）。模板越长，可换窗的门槛越高。
2. **锚点诚实性事故**：会话从未写过笔记，模板却让新窗口去读空的 ctx_notes，于是加了 `hasNotes` 探针（`rollover.ts:35-42`、`383-386`）。
3. **过期笔记事故（Incident 2026-09-29）**：模板为过期笔记背书，于是加了新鲜度门（`rollover.ts:97-102`；`notes.ts:106-111`）。⚠️ 时长说法不一致：`rollover.ts:100` 写「~27 hours」，`notes.ts:110` 写「by a day」，`CHANGELOG 0.5.2` 写「~4 hours」。
4. **任务盲**（2026-09-16）：最初的模板不带任务信息，于是加了 Task / Last action 行（`rollover.ts:76-82`）。
5. **新窗口误判「丢失了最后回复」**：于是在模板里声明 retain-last（`rollover.ts:234-239`、`history.ts:174-183`）。
6. **pruner 隔离的副作用**：手动路径同样不做剪枝（`index.ts:76-88`；README:200「已知限制」）。
7. **宿主 token meter 遇到悬挂的 `step/start` 会让会话「砖化」**：需要在每次 dsh 升级后重跑 `scripts/patch-token-meter.mjs`（CHANGELOG 0.5.1）。
8. **提醒传错对象**：曾经把裸 Session 传给 `measureBudget`，导致提醒全部失效（`index.ts:211-217`；CHANGELOG 0.5.0）。
9. 宽限带的引擎侧提醒**只写日志**，模型可见的提醒来自 reminder（CHANGELOG 0.5.0「Documented」）。

### 7.2 读代码推断出的潜在问题（未在运行时验证，标为推断）
1. **STALE 很可能几乎总是触发**（推断）：`ctx_notes append/write` 在 execute 内打时间戳，随后宿主才记录 `tool/result`（文本是 "appended segment #N" 之类，非空，属于内容事件）。这条事件的 `time` 大于等于该时间戳，而判定是严格 `>` 且没有容差（`rollover.ts:129`、`notes.ts:65`/`82`），加上模型写完笔记后通常还会再回复一句，所以 eventsAfter ≥ 1 的概率很高。测试只构造了笔记晚于所有事件的「新鲜」场景（`tests/engine.test.ts:401-438`），没有覆盖「刚写完笔记就换窗」这一真实时序。
2. **「Last action」行价值低或重复**（推断）：它取最新一条内容事件，而这条事件恰好就是 retain-last 留在新窗口里的那个节点。由 new_context 触发的换窗，这一行大概率是 new_context 的工具结果 "Rollover requested. Finish the current step…"（`new-context.ts:529`），或是 ctx_notes 的回执。
3. **new_context 连续调用两次会取消请求**：`index.ts:383-386` 先调 `consumeRollover`（删除挂起项）再返回 "a rollover was already requested"，结果是第二次调用反而**撤销了**第一次的请求。没有测试覆盖。
4. **笔记读取截断保留头部**：追加式笔记最新的段反而被截掉（`config.ts:444-446`、`notes.ts:95`）；写入也没有上限。
5. **pressure 路径可能一次换多个窗**：basic 在 `compactionRetries`（默认 1）内循环，最多可连续换 2 次，第二次的模板窗口号会 +1；如果仍高于阈值就抛错，由 basic 的 pre-step 监听器 catch 并记 warn（`basic index.js:907-919`、`803-808`）。
6. **措辞与实际路径不符**：pressure 路径保留约 16% 尾部，模板却固定写「newest exchange remains visible」；stale 的 eventsAfter 统计的是全部日志（包括保留尾），措辞却是「in the archived window」（`rollover.ts:224`、`119-133`）。PREAMBLE 说「condensing」，与模板的「nothing was summarized away」矛盾（`basic index.js:257`）。
7. 注释过时：`state.ts:190-193` 说最坏情况是「no-notes wording」，实际用的是 notesAssured=true 加 STALE（`rollover.ts:269`）。
8. `summarize()` 中 `sessionEvents()` 抛错没有兜底（`rollover.ts:381`），宿主没有 `snapshotEvents` 时换窗直接失败（这是有意的 fail-loud）。

### 7.3 TODO 与 issue
- 两个仓库的 `src/` 里都**没有** `TODO/FIXME/XXX`（grep 结果为空）。仓库只有一个压平的提交，本地看不到 issue。

### 7.4 测试覆盖
- H 版：10 个测试文件、123 项（`README.md:190`、CHANGELOG 0.5.3）。本次 `npx vitest run` 的结果是 **122 通过、1 失败**：`tests/notes.test.ts:66`「write errors name the session and root」写 `/proc/...` 时在本沙箱超时（5s），属于环境问题。
  - 模板相关测试集中在 `tests/engine.test.ts:72-157`（编号、零 LLM、无笔记、定向行、上限、最坏情况计价、探针容错）、`376-395`（脱敏）、`397-469`（新鲜度门）。
  - **缺口**：所有 `compactIfNeeded` 测试都 mock 了 `BasicCompactionEngine.prototype.compactIfNeeded`（如 `engine.test.ts:188`），**没有一项把模板跑进真实的 basic 事务**（尺寸不变量、retain-last、工具配对都没有在单测里与模板联测）。README 声称有端到端和真机实证（`README.md:195-196`）。new_context 双击、笔记截断方向、stale 时序也都没有测试。
- L 版：33 个 `test()`（config/region/dcp/engine/tools），本地没有 node_modules，未运行；README/PR 声称全部通过。

---

## 8. 给 dsh-token-budget 交接模板的设计启示（个人归纳）

1. **用子类覆写 basic 的 `summarize()`** 是官方唯一认可的扩展点，可以白拿锁、事务、配对平衡、retain-last 和 overflow 重试。返回 `{summary:[{type:'text',text}], provider:'<自定义标识>', model:'none'}`，不要带 `llmStreamCall`。
2. **模板必须有上界**，并且要导出最坏情况文本，供可用性和尺寸预检使用（严格小于被遮蔽区间的 token 数）。
3. **只放机械可得、可证明的信息**；探针失败就降级措辞，不要编造。新鲜度判定要**给容差**，或者排除笔记工具自身的回执事件（避开 §7.2-1）。
4. 「Last action」应排除留在窗口内的最新节点和插件自身的工具回执，或者改取「最后一条用户指令」。
5. 笔记截断应**保留尾部**（最新的段），或者给模板一个「笔记段数 / 最新段标题」作为提示。
6. 措辞要按触发路径区分（retain=0 和 16% 尾部），并注意 basic 的 PREAMBLE 写死了「condensing」。
7. 自动生成的文本（标题、首行）要过固定的脱敏器；原文归档保持不脱敏。
