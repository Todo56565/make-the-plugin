# DSH 上下文压缩（compaction）是否会「回传」给父会话 —— 只读取证报告

- 取证时间：2026-10-12（Asia/Shanghai）
- 取证方式：只读。PowerShell `Get-ChildItem -Recurse` / `Select-String` / `Get-Content`，加临时 `node` 脚本解析多帧 zstd 会话日志。**未修改任何 DSH 安装文件、teams 插件仓库、profile 或既有交付文档。**
- 临时脚本已按要求置于 `I:\VMsShare\_probe-*.mjs`，**报告写作前已全部删除**（见 §3.4）。

## 路径简写

本报告正文与证据块一律使用完整绝对路径。为便于阅读，正文叙述中：

| 简写 | 展开 |
|---|---|
| `$DSH` | `D:\Dev\Path\nodejs_25.0.0\npm-cache\_npx\1e7f6d9597241db0\node_modules\@deepseek-ai\` |
| `$TEAMS_SRC` | `I:\VMsShare\_src-compare\dsh-agent-teams\src\` |
| `$TEAMS_INST` | `C:\Users\ZYX\.dsh\profiles\web\node_modules\@nanmicoder\dsh-agent-teams\` |
| `$SESS` | `C:\Users\ZYX\.dsh\sessions\` |

---

# 1. 结论摘要

| # | 问题 | 一句话结论 |
|---|---|---|
| 1 | 是否真的没有回传？ | **确认没有「子会话 → 父会话」的压缩回传通道。** 穷尽检索未发现任何代码路径把「阈值 / 压力 / 压缩发生 / stale 风险」从子会话带入父会话的上下文装配、事件流或提示注入。**但发现了唯一一条反向（祖先 → fork 后代）的压缩数据搬运：`SessionStore.fork()` 通过 `buildForkSeed` 把源会话的 `compaction/*` 事件与压缩检查点 `user/message` **逐字复制**进子会话日志。** |
| 2 | 子会话压缩后父会话能否感知？ | **运维/UI 可见：能（部分）。模型上下文可见：不能。** 父会话能通过 `list_agents` 看到子会话的 `id/label/status(running\|inactive)/parent/depth`，通过 `subagent/end` 与结算消息看到 `stopReason` 与子会话收尾文本；**看不到任何压缩状态**。无第一方机制把子会话的压缩结果告知父会话。 |
| 3 | 压缩器/裁剪器是否做 agent 维度分支？ | **完全不分支。** 五个压缩包对 `delegationDepth`、`parentSession`、`origin`、`subagent` 四词零命中（独立复核通过）；压缩的 agent 参数类型 `CompactionAgentContext` 只有 `{ session, options: { provider?, model? } }`。唯一「跨 agent」的事实是：**子 agent 会加入父 agent 的同一 preset 修订**，因此父子共享同一个压缩引擎**实例**（但每次都按显式传入的 `agent.session` 只写该会话）。 |
| 4 | `compaction/summary-error` 是否可能跨 session 触发？ | **它不是 session 作用域事件，而是进程级 waterfall：每个已注册监听器都会收到，与发起压缩的会话无关。** 但 payload 携带发起方 `session`，且唯一的恢复监听器只改 `payload.session` 的 surface；**恢复效果严格局限在压缩发起方会话内**，不跨 session 生效。（同时它不进任何会话日志、对模型不可见。） |
| 5 | 主会话侧对子会话历史是否有读通路？它被用于「查看成员状态」了吗？ | **有，且不止一条。** `ctx.subagents.listChildren/listDescendants`（读父会话**自己**的 `subagentCatalog` 投影）、`ctx.sessions` 存储、`ctx.sessionQuery`、`ctx.sessionReferenceResolver`。**被第一方用于模型可见「成员状态」的只有 `list_agents` 工具**（字段仅 id/label/status/parent/depth）。另一条更强的读通路是 `dsh-session-reference`：`@[label](dsh-session:<id>)` 提及会把**另一会话当前 surface 的投影正文**注入提及者上下文——**这是唯一能让某会话内容（含其压缩检查点的摘要文本）进入另一会话模型上下文的第一方通道**，但它是用户显式提及触发、且会把 `checkpoint` 标记剥掉。 |
| 6 | 阈值调低后会怎样？ | 现有机制**不会**让父会话看到子会话被压缩。子会话压缩仍只写子会话日志；父会话至多通过 `list_agents` 看到 `status` 在 `running/inactive` 间摆动。若要在父会话模型上下文里呈现「成员被压缩 / 上下文压力 / stale 风险」，**需要新通道**——可直接照抄已有先例（teams 插件的 `appendTeamEvent` 把成员侧变更事件写进 captain session，或 `settle` 路径已有的 `user/message` 注入）。 |

## 1.1 对「已确认事实」的复核结果

| 你的既述 | 复核结论 |
|---|---|
| ① `dsh-agent-teams` 不监听任何压缩事件 | **成立。** `$TEAMS_SRC` 全量检索 `compaction` 零命中；`$TEAMS_INST\lib\**` 全量检索 `compaction` 零命中。它订阅的是 `agent/pre-step`(×3)、`agent/created`、`agent/request`、`agent/error`、`agent/request-error`、`agent/status`、`internal/service`。**一处小差异**：`agent/session-start` 不是 DSH 内置事件名——它出现在 `$TEAMS_SRC\harness-compat.ts:116-118`，是该插件为兼容旧 harness 而声明的**兼容层事件名**，在新 harness 下走的是 `agent/created`。 |
| ② 四个压缩事件的类型注释写 log-only / no surfaceOp | **成立。** `$DSH\dsh-compaction\lib\types\types.d.ts` 第 3-4、16-20、26-34、69-72、79-87 行逐条注明。 |
| ③ 压缩事件只出现在执行压缩的那个 session 自己的日志里 | **大体成立，但表述过强。** 我解析了 `$SESS` 下**全部 60 个会话日志**：13 个会话含 `compaction/*`；**没有任何一个 `origin=subagent` 的会话产生过自己的压缩**。但 **`subagent_fork` 后代会话的日志里会出现祖先的 `compaction/*` 事件与压缩检查点，且逐字相同（同 seq、同 time、同 compactionId）**——详见 Q1 的 §2.1.7。方向仍是**祖先 → 后代**，不存在「子 → 父」。 |

---

# 2. 逐问题证据

## 2.1 问题 1 —— 是否存在子会话 → 父会话的压缩回传路径

### 2.1.0 结论

穷尽检索后：**不存在**。压缩引擎的对外契约只接受「一个 agent 的 session」，写入目标恒为 `agent.session`；四个压缩事件是**会话自有**事件，由 `Session.append` 写入该会话自己的日志；不存在把压缩元信息（阈值、压力、是否压缩、stale）投递给父 agent/父 session 的调用点。

### 2.1.1 压缩引擎契约里根本没有「父」这个概念

`D:\Dev\Path\nodejs_25.0.0\npm-cache\_npx\1e7f6d9597241db0\node_modules\@deepseek-ai\dsh-compaction\lib\types\index.d.ts:104-157`（节选 111、116、144-146、152 行）：

```ts
     * @param agent - agent context owning the session surface and routing options.
     * @param trigger - normal pressure or provider-confirmed context overflow.
     * @param signal - cancellation signal; model-backed implementations must forward it.
     * @returns the compaction result, or `null` if no compaction was needed.
     */
    abstract compactIfNeeded(agent: CompactionAgentContext, trigger: CompactionTrigger, signal: AbortSignal): Promise<CompactionResult | null>;
...
     * backed implementation forwards cancellation and rejects active, missing,
     * reversed, or unbalanced ranges. The target session is `agent.session`.
     * Its replacement user message must use {@link compactCheckpointSource} with
     * the transaction's `CompactionId`.
...
     * @param agent - context whose session is mutated and whose routing options guide summarization.
```

`agent` 的契约形状（同一事实的第二处声明）——`D:\Dev\Path\nodejs_25.0.0\npm-cache\_npx\1e7f6d9597241db0\node_modules\@deepseek-ai\dsh-tool-cordis\lib\types\api-catalog.js:4699-4701`：

```js
        name: 'CompactionAgentContext',
        declaration: 'export interface CompactionAgentContext {\n    session: Session;\n    options: {\n        provider?: string;\n        model?: string;\n    };\n}',
```

没有任何 `parent`、`parentSession`、`delegationDepth`、`origin` 字段。

### 2.1.2 唯一自动触发点：按「谁在走 pre-step」决定压谁的会话

`D:\Dev\Path\nodejs_25.0.0\npm-cache\_npx\1e7f6d9597241db0\node_modules\@deepseek-ai\dsh-compaction-basic\lib\index.js:834-852`：

```js
	_registerAutomaticCompaction() {
		const { ctx } = this;
		const logResult = (result, trigger) => {
			ctx.logger.info(`compaction (${trigger}): shadowed ${result.shadowedSeqs.length} surface nodes (seqs ${result.shadowedRange.start}-${result.shadowedRange.end}, ~${result.shadowedTokenCount} tokens)`);
		};
		ctx.on("agent/pre-step", async ({ agent, signal }, next) => {
			if (!signal.aborted) try {
				const result = await this.compactIfNeeded(agent, "pressure", signal);
				if (result !== null) logResult(result, "step pressure");
			} catch (error) {
```

`agent` 来自事件 payload（即有 agent 自己的 pre-step）。`logResult` 只写 `ctx.logger.info`（进程日志，非模型上下文）。

溢出恢复同理，`...\dsh-compaction-basic\lib\index.js:861-887`：

```js
		ctx.on("agent/request-error", async ({ agent, failure, signal }, next) => {
			if (failure.code !== CONTEXT_WINDOW_EXCEEDED_CODE || signal.aborted) return next();
			this.overflowAgents.set(agent.session, agent);
			const target = routedTarget(agent.session);
```

### 2.1.3 压缩结果只写「自己的」会话日志

`D:\Dev\Path\nodejs_25.0.0\npm-cache\_npx\1e7f6d9597241db0\node_modules\@deepseek-ai\dsh-session\lib\index.js:1441-1474`（节选）：

```js
	append(type, data, ...opts) {
...
		const entry = attachments.get(this);
		if (entry?.appending) throw new Error("session append cannot reenter while another append is being published");
		const event = deepFreeze({
			type,
			seq: SessionSeq(this.log.length),
			time: Date.now(),
			data: dataSnapshot,
			...surfaceMetadataSnapshot
		});
		validateSessionEventData(event, `session event "${type}" at seq ${event.seq}`);
		this.surfaceManager.validateNext(event);
		if (entry !== void 0) entry.appending = true;
		try {
			let callbacks;
			const callbackArgs = [this, event];
			if (entry !== void 0) callbacks = collectSessionCallbacks(entry.emitCtx, [
```

`this` 是 Session 实例，`compaction/*` 由压缩实现 append 到 `agent.session`。**没有任何分支会把它 append 到第二个 Session。**

### 2.1.4 四个压缩事件是「会话自有」事件（因此先验不可能出现在父日志里）

`D:\Dev\Path\nodejs_25.0.0\npm-cache\_npx\1e7f6d9597241db0\node_modules\@deepseek-ai\dsh-session\lib\types\known-event-types.js:21-34, 59-61`：

```js
export const KNOWN_SESSION_EVENT_TYPES = new Set([
    'agent-preset/selected',
    'agent/inbox/spliced',
    'approval/asked',
    'approval/decided',
    'approval/policy',
    'assistant/attempt',
    'assistant/message',
    'command/done',
    'command/run',
    'compaction/end',
    'compaction/prune',
    'compaction/start',
    'compaction/summary',
...
    'subagent/catalog',
    'subagent/descriptor',
    'subagent/model-selection-policy',
```

注意：`subagent/start` / `subagent/end` **不在此列表**，它们是 Host 事件（见 Q2）。

### 2.1.5 全树唯一会「因为别的会话压缩而动作」的第一方代码是遥测

`D:\Dev\Path\nodejs_25.0.0\npm-cache\_npx\1e7f6d9597241db0\node_modules\@deepseek-ai\dsh-client-product-analytics\lib\index.js:115-125`：

```js
			ctx.on("session/event", (session, event) => {
				if (event.type !== "compaction/start") return;
				this.report({
					eventName: "context_compression",
					timestamp: Date.now(),
					attributes: {
						session_id: session.id,
						trigger_type: event.data.turn === null ? "manual" : "auto"
					}
				});
			});
```

它确实能看到**任意**会话（含子会话）的 `compaction/start`（`session/event` 是 untagged 广播，见 §2.2.3），但只上报遥测，不写回任何 agent 上下文。

### 2.1.6 会话事件广播确实「全进程可见」——但那只到运维面

`D:\Dev\Path\nodejs_25.0.0\npm-cache\_npx\1e7f6d9597241db0\node_modules\@deepseek-ai\dsh-session\lib\index.js:1734-1742`：

```js
	enter(session) {
		const id = session.id;
		const carrier = scopeTarget(session, scopeOf(this.ctx));
		if (this.store.has(id)) throw new Error(`session "${id}" already exists`);
		if (attachments.has(session)) throw new Error(`session "${id}" is already attached to a store`);
		const entry = {
			id,
			session,
			carrier,
```

配合 `D:\Dev\Path\nodejs_25.0.0\npm-cache\_npx\1e7f6d9597241db0\node_modules\@deepseek-ai\dsh-scope\lib\index.js:327-338`：

```js
function scopeTarget(base, key) {
	const baseFilter = base[Context.filter];
	const carrier = { [Context.filter](ctx) {
		if (baseFilter !== void 0 && !baseFilter.call(base, ctx)) return false;
		const tag = scopeOf(ctx);
		if (tag === void 0) return true;
		for (let cursor = key; cursor !== void 0; cursor = scopeParents.get(cursor)) if (cursor === tag) return true;
		return false;
	} };
	carrierKeys.set(carrier, key);
	return carrier;
}
```

`session/event` 的 carrier key 是 **SessionStore 自身 ctx 的 scope**（通常 `undefined`）；`tag === undefined` 的监听器（即所有在 host/root 平面注册的插件）一律放行。**所以父子会话的 `compaction/*` 对运维面监听器都是可见的——这解释了 §2.1.5，也是你实测「能搜到」的另一半原因。** 但「可见」不等于「进入父会话模型上下文」：全树没有一个 untagged `session/event` 监听器把压缩事件写回某个 agent 的 inbox/messages（见 §3 关键词清单）。

### 2.1.7 ★ 唯一真实存在的跨会话压缩数据搬运：`fork` 的种子（方向是祖先 → 后代）

`D:\Dev\Path\nodejs_25.0.0\npm-cache\_npx\1e7f6d9597241db0\node_modules\@deepseek-ai\dsh-session\lib\index.js:924-933`：

```js
function buildForkSeed(events, boundary) {
	const prefix = events.slice(0, boundary + 1);
	prefix.push({
		type: "session/end-seed",
		seq: SessionSeq(boundary + 1),
		time: events[boundary].time,
		data: { inherited: true }
	});
	return prefix.concat(openTurnClosers(prefix, { kind: "forked" }));
}
```

`events.slice(0, boundary + 1)` **不做任何类型过滤**，因此 `compaction/start`、`compaction/summary`、`compaction/end`、以及带 `surfaceOp: replace` 的压缩检查点 `user/message` 都会被逐字复制。

该契约在设计上就是被预期的——`D:\Dev\Path\nodejs_25.0.0\npm-cache\_npx\1e7f6d9597241db0\node_modules\@deepseek-ai\dsh-session\lib\types\types.d.ts:423-428`：

```ts
     * An owner of a standalone open/close bracket (`compaction/start` …
     * `compaction/end`) reads it because seed history and live work are otherwise
     * byte-identical: an unmatched opening marker before this event belongs to
     * an ended lifecycle, whatever ended it. NOT a liveness signal about other
     * writers — a concurrently live session holds its own boundary elsewhere,
     * so tolerating concurrent writers needs a signal beyond the log.
```

**实测验证**（`$SESS\--I-googo--\session-94da6bb9-beca-4cf8-8460-7c70260cddfb` 与其 fork 子会话 `session-bc70523b-430c-482b-9b12-9d8e1aed89ce`，后者 header 为 `{"parentSession":"session-94da6bb9-...","isSeeded":true,"delegationDepth":0}`）：

| 事件 | 父会话 seq/time | 子会话 seq/time | 逐字相同 |
|---|---|---|---|
| `compaction/start` (`a8711ca1-…`) | 1043 / 1791249536400 | 1043 / 1791249536400 | 是 |
| `compaction/summary` (`a8711ca1-…`) | 1044 / 1791249559752 | 1044 / 1791249559752 | 是 |
| 检查点 `user/message` (`surfaceOp:{op:"replace",startSeq:10,endSeq:1036}`) | 1045 / 1791249559753 | 1045 / 1791249559753 | 是 |
| `compaction/end` (`a8711ca1-…`) | 1046 / 1791249559755 | 1046 / 1791249559755 | 是 |

同一条 `buildForkSeed` 链在 `--I-A_need-cmdc…` 工作区也能复现：`session-fec92f9e` 自有摘要 seq 1270/1733 → fork 出 `session-f9b5aa84`（`session/end-seed{inherited:true}` @1963）继承 1270/1733 并新增 2128/2375 → 再 fork 出 `session-5c54badf`（`inherited:true` @2266）继承 1270/1733/2128 并新增 2271。

**因此**：fork 出来的子 agent **从父会话的「已压缩后、有损」surface 起步**（原始被 shadow 的历史不在其 surface 上）。这是父 → 子，不是子 → 父；它不构成「压缩回传给父会话」，但确实是**既有的一条跨会话压缩数据通道**，写报告时必须与「没有回传」并列陈述，否则结论会被误读为「压缩数据永远不跨会话」。

### 2.1.8 子会话 → 父会话唯一的模型可见文本是结算消息，且不含压缩信息

`D:\Dev\Path\nodejs_25.0.0\npm-cache\_npx\1e7f6d9597241db0\node_modules\@deepseek-ai\dsh-subagent\lib\types\continuation-messages.js:56-105`：

```js
function settlementSummary(childId, stopReason) {
    const subject = `Background subagent ${childId}`;
    switch (stopReason) {
        case 'completed':
            return `${subject} finished and will do no further work unless you send it more.`;
        case 'aborted':
            return `${subject} was stopped before it finished.`;
        case 'max-tokens':
            return `${subject} ran out of room before it finished.`;
...
export function createSettlementMessage(childId, terminal) {
    const summary = settlementSummary(childId, terminal.stopReason);
    // Parent providers receive this notice as a user message and may reject
    // nontext assistant blocks. Keep this conversion local so SDK/UI consumers
    // retain the complete child output.
    const closingText = (terminal.output ?? []).flatMap(block => block.type === 'text' && block.text.length > 0 ? [block] : []);
    return createUserMessage({
        content: [
            { type: 'text', text: summary },
...
        source: {
            kind: 'subagent-settled',
            form: 'notice',
            summary: boundContextSummary(summary),
            senderSessionId: childId,
        },
    });
}
```

`stopReason` 取值只来自子会话自己的回合结束原因，**没有任何压缩维度**；最接近「上下文压力」的只有 `max-tokens` → `"ran out of room before it finished."`（那是**输出** token 上限，不是压缩）。

实测（`$SESS\--I-googo--\session-94da6bb9-…`）父会话日志里确实存在 7 条此类模型可见消息（节选 4 条）：

```
seq=1415 kind=agent-message  sender=1a8ee345-… 
seq=1429 kind=subagent-settled sender=1a8ee345-… summary="Background subagent 1a8ee345-… finished and will do no further work unless you send it more."
seq=1451 kind=subagent-settled sender=1ca19615-… 
seq=1925 kind=subagent-settled sender=377eae5d-… 
```

**没有一条提到任何子会话被压缩。**

### 2.1.9 关键否定实验：跨会话 compactionId 引用 = 0（真实为 0）

我对 `$SESS` 下 60 个会话日志做了如下判定：取出每个会话「自有」的 `compactionId`（来自 `compaction/*` 事件 + `compact-checkpoint` 检查点），再扫描**所有**会话里每个提到 UUID 的事件，判断是否引用了**别的**会话自有的 `compactionId`。

结果：**排除取证脚本输出被写进工具结果所产生的自指噪声后，结构化跨会话引用为 0**（最初脚本报 2 处，逐条核对发现两处都是 `tool/result` / `assistant/message` 的**纯文本**里带着早期 probe 的扫描输出——一处在本会话，一处在同族兄弟会话 `session-5555841f`——属于取证自污染，非结构性引用）。共享同一 `compactionId` 的会话集合，**全部符合 `buildForkSeed` 的祖先→后代传播模型**（§2.1.7），无反方向实例。

---

## 2.2 问题 2 —— 子会话压缩后父会话能否以任何方式感知

### 2.2.1 模型上下文可见面：无压缩信号

父会话模型能看到的、与子会话有关的东西，穷尽如下：

**(a) `subagent/catalog`（父会话自有投影）字段全集** —— `D:\Dev\Path\nodejs_25.0.0\npm-cache\_npx\1e7f6d9597241db0\node_modules\@deepseek-ai\dsh-subagent\lib\types\catalog.js:11-30`：

```js
const oneShotCatalogSchema = z.object({
    version: z.union([z.literal(0), z.literal(1)]),
    childId: sessionIdSchema,
    childCreatedAt: z.number().int().nonnegative(),
    mode: z.literal('one-shot'),
    label: z.string().optional(),
}).strict();
const continuableCatalogSchema = z.object({
    version: z.union([z.literal(0), z.literal(1)]),
    childId: sessionIdSchema,
    childCreatedAt: z.number().int().nonnegative(),
    mode: z.literal('continuable'),
    label: z.string(),
}).strict();
const unknownCatalogSchema = oneShotCatalogSchema.extend({ version: z.literal(1), mode: z.literal('unknown') });
const eventDataSchema = z.union([
```

`.strict()` —— 任何多余字段（例如压缩状态）都会**解析失败**。这是设计级别的排除。

实测父会话 `session-94da6bb9-…` 的三条 catalog：`{"version":0,"childId":"1a8ee345-…","childCreatedAt":1791278468705,"mode":"continuable","label":"Research Snow Shot tool"}` 等，与上述 schema 完全一致。

**(b) `subagent/start` / `subagent/end`（Host 事件，不进日志、不进 surface）** —— `D:\Dev\Path\nodejs_25.0.0\npm-cache\_npx\1e7f6d9597241db0\node_modules\@deepseek-ai\dsh-subagent\lib\types\lifecycle.js:56-77`：

```js
export function observeRun(emit, provider, parent, run) {
    const identity = {
        runId: SubagentRunId(randomUUID()),
        provider,
        id: run.id,
        local: run.localAgent !== undefined,
    };
    // Attach the terminal observer before dispatching start. Promise reactions
    // still run after this synchronous start emission, preserving start → end.
    void run.result.then((result) => {
        emit('subagent/end', {
            ...identity,
            stopReason: result.stopReason,
            // Omit the field when no output exists, matching continuable epochs.
            ...result.output.length === 0 ? {} : { lastAssistantMessage: result.output },
        }, parent);
```

payload 只有 `runId/provider/id/local/stopReason/lastAssistantMessage`。

**(c) `agent/status`** —— `D:\Dev\Path\nodejs_25.0.0\npm-cache\_npx\1e7f6d9597241db0\node_modules\@deepseek-ai\dsh-agent\lib\types\runtime-types.d.ts:90`：

```ts
export type AgentStatus = 'idle' | 'running';
```

**没有 `compacting` 之类的状态。**

**(d) 结算消息** —— 见 §2.1.8，无压缩信息。

### 2.2.2 运维/UI 可见面：有，且分三层

1. **进程内 untagged 事件监听器**能看到任意会话的 `compaction/*`（§2.1.6）。但这只被遥测（§2.1.5）、invariant、token-meter 面消费。
2. **UI（浏览器侧）** 按会话渲染压缩卡片/轨迹 —— `D:\Dev\Path\nodejs_25.0.0\npm-cache\_npx\1e7f6d9597241db0\node_modules\@deepseek-ai\dsh-client-ui-chat\lib\client.js:9043, 9098-9104`、`...\dsh-client-ui-trajectory\lib\client.js:1035-1057`。这些是**按被打开的会话**渲染的；父会话的聊天流不渲染子会话的压缩。
3. **API/投影**：`contextPressure` 是**每会话**投影 —— `D:\Dev\Path\nodejs_25.0.0\npm-cache\_npx\1e7f6d9597241db0\node_modules\@deepseek-ai\dsh-token-meter\lib\index.js:613-615`：

```js
		ctx.sessionProjections.register(tokenUsageProjectionDefinition);
		ctx.sessionProjections.register(contextPressureProjectionDefinition);
		ctx.sessionProjections.register(contextBreakdownProjectionDefinition);
```

同样在 `D:\Dev\Path\nodejs_25.0.0\npm-cache\_npx\1e7f6d9597241db0\node_modules\@deepseek-ai\dsh-token-meter\lib\types\usage-projection.d.ts:31-35` 中挂到 `SessionProjectionStateMap`，是**会话自有状态**，父会话读不到子会话的。

### 2.2.3 事件流层面：`session/event` 广播不等于「父会话感知」

见 §2.1.6。**判定：`session/event` 是进程级广播（运维面），不是父子通道。** 若将来有插件想在父会话模型上下文里呈现子会话压缩，它必须**显式** sink 到父 Session（例如 append 一条 `user/message` 或 `developer/message`），当前没有任何第一方代码这么做。

---

## 2.3 问题 3 —— 压缩器/裁剪器是否做 agent 维度分支

### 2.3.1 独立复核：四个词在五个压缩包内零命中

检索命令（对 `.js`/`.d.ts`/`.yml`/`.json` 全类型，含 `lib/types` 与 README）：

```powershell
foreach($p in @("dsh-compaction","dsh-compaction-basic","dsh-compaction-tool-result-pruner","dsh-command-compact","dsh-compaction-image-offload")){
  Get-ChildItem "$root\$p" -Recurse -File |
    Select-String -Pattern 'delegationDepth|parentSession|\borigin\b|subagent' -List
}
```

结果：**五个包全部 ZERO HITS**（与你的实测一致，我扩展到全部 5 个压缩包与全部文件类型）。

### 2.3.2 压缩包实际读取的 Session/Agent 表面

只有两处：`agent.options.provider/model` 与 `agent.session`。`D:\Dev\Path\nodejs_25.0.0\npm-cache\_npx\1e7f6d9597241db0\node_modules\@deepseek-ai\dsh-compaction-basic\lib\index.js:292-303`：

```js
async function summarizeWithLlm(ctx, config, input, agent, signal) {
	const latest = agent.session.requestHeader()?.config;
	const configured = config.summarizationProvider.length === 0 ? void 0 : {
		provider: config.summarizationProvider,
		model: config.summarizationModel
	};
	const agentTarget = agent.options.provider !== void 0 && agent.options.provider.length > 0 && agent.options.model !== void 0 && agent.options.model.length > 0 ? {
		provider: agent.options.provider,
		model: agent.options.model
	} : void 0;
	const target = configured ?? latest ?? agentTarget;
```

`session.header` / `isSeeded` / `depth` 在压缩包内同样零命中。

### 2.3.3 ★ 唯一「跨 agent」的事实：父子**共享同一个压缩引擎实例**（但仍只写各自 session）

这不是分支，但必须写清楚，否则「父子各自独立压缩」的说法不准确。

- 标准 preset 把压缩后端放在一个 `isolate` 组里，**按 preset 挂载**：`D:\Dev\Path\nodejs_25.0.0\npm-cache\_npx\1e7f6d9597241db0\node_modules\@deepseek-ai\dsh-web-app\presets\standard.patch.yml:63-79`：

```yaml
          - id: compaction
            name: cordis:group
            group: true
            isolate:
              compaction: true
              toolResultPruner: true
            config:
              - id: compaction-basic
                name: '@deepseek-ai/dsh-compaction-basic'
              - id: command-compact
                name: '@deepseek-ai/dsh-command-compact'
              - id: tool-result-pruner
                name: '@deepseek-ai/dsh-compaction-tool-result-pruner'
                config:
                  thresholdChars: 8192
                  headChars: 4096
                  tailChars: 1024
```

- 子 agent **加入父 agent 保留的同一个 preset 修订**：`D:\Dev\Path\nodejs_25.0.0\npm-cache\_npx\1e7f6d9597241db0\node_modules\@deepseek-ai\dsh-agent-preset-registry\lib\index.js:703-718`：

```js
		composeFrom(ctx, parent) {
			const mounted = standingMountFor(parent);
			if (mounted === void 0) return void 0;
			const generation = this.generations.get(mounted.key);
			if (generation === void 0) throw new Error("Parent preset revision is unavailable");
			const key = scopeOf(ctx);
			if (key === void 0) throw new Error("Child preset binding requires a scope");
			if (this.bindings.has(key)) throw new Error("Child already joined a preset");
			this.join(ctx, key, generation);
			return mounted.presetId;
		}
```

**含义**：子会话被压缩时，用的是**父会话那份阈值策略**（同一个 `compaction-basic` 实例、同一份 `config`），但压缩目标仍是派发事件的那个 `agent.session`（子会话）。**策略共享 ≠ 结果回传。**

---

## 2.4 问题 4 —— `compaction/summary-error` waterfall 的作用域

### 2.4.1 声明：waterfall，payload 携带发起方 session

`D:\Dev\Path\nodejs_25.0.0\npm-cache\_npx\1e7f6d9597241db0\node_modules\@deepseek-ai\dsh-compaction\lib\types\index.d.ts:71-91`：

```ts
    interface Events {
        /**
         * Recover a failed summary request by synchronously recording a durable
         * change to its selected input. Return true only after making progress;
         * the provider re-derives and re-prices the selection before retrying.
         * Call next() when the failure cannot be recovered. Decisions survive a
         * later summary failure or cancellation.
         * @param payload.session - session containing the selected input.
         * @param payload.sourceEventSeqs - selected message events in request order.
         * @param payload.error - failure thrown by the summarizer.
         * @param payload.signal - optional compaction cancellation signal.
         * @param next - delegate to the next recovery listener.
         * @mode waterfall
         */
        'compaction/summary-error'(payload: {
            session: Session;
```

### 2.4.2 唯一发射点：`session` 恒为压缩发起方的会话

`D:\Dev\Path\nodejs_25.0.0\npm-cache\_npx\1e7f6d9597241db0\node_modules\@deepseek-ai\dsh-compaction-basic\lib\index.js:1012-1024`：

```js
	/** Bind the effective token meter and dynamically dispatched summarizer hook. */
	regionDependencies() {
		return {
			meter: this.ctx.tokenMeter,
			summarize: (input, owner, abort) => this.summarize(input, owner, abort),
			recover: (error, agent, sourceEventSeqs, signal) => this.ctx.waterfall("compaction/summary-error", {
				session: agent.session,
				sourceEventSeqs,
				error,
				...signal === void 0 ? {} : { signal }
			}, () => false)
		};
	}
```

`agent.session` = 正在被压缩的那个会话。**发射点只有一个**（全树检索 `summary-error` 命中：`dsh-compaction`、`dsh-compaction-basic:1017`、`dsh-compaction-image-offload:146`、`dsh-tool-cordis` 目录条目）。

### 2.4.3 唯一监听器只改 payload 里的那一个 session

`D:\Dev\Path\nodejs_25.0.0\npm-cache\_npx\1e7f6d9597241db0\node_modules\@deepseek-ai\dsh-compaction-image-offload\lib\index.js:139-152`：

```js
function apply(ctx) {
	ctx.sessions.registerMessageProjection(imageOffloadProjection);
	ctx.on("agent/request-error", ({ agent, failure }, next) => {
		if (failure.code !== IMAGE_OFFLOAD_REQUIRED_CODE || failure.offloadImages === void 0) return next();
		if (!offloadOldestImages(agent.session, agent.session.surface.nodes, failure.offloadImages)) return next();
		return Promise.resolve({ kind: "retry" });
	});
	ctx.on("compaction/summary-error", ({ session, sourceEventSeqs, error, signal }, next) => {
		if (!(error instanceof LlmError) || error.code !== IMAGE_OFFLOAD_REQUIRED_CODE || error.failure.offloadImages === void 0) return next();
		signal?.throwIfAborted();
		if (!offloadOldestImages(session, sourceEventSeqs, error.failure.offloadImages)) return next();
		return true;
	});
}
```

`offloadOldestImages(session, …)` 只作用于 `payload.session`。

### 2.4.4 但它是**进程级**分发，不是会话作用域 —— 精确回答你的问题

**waterfall 不带 scope carrier。** 证据链：

**(i) `compaction/summary-error` 不在 scoped-event 表里** —— `D:\Dev\Path\nodejs_25.0.0\npm-cache\_npx\1e7f6d9597241db0\node_modules\@deepseek-ai\dsh-scope\lib\invariant.js:9-37` 的 `scopedSubjectResolvers` 冻结表列出的全部 scope-filtered 事件为：

```js
const scopedSubjectResolvers = Object.freeze({
	"agent/assistant-stream": (args) => args[0]["agent"],
	"agent/created": (args) => args[0]["agent"],
	"agent/disposed": (args) => args[0]["agent"],
	"agent/error": (args) => args[0]["agent"],
	"agent/inbox/claimed": (args) => args[0]["agent"],
	"agent/inbox/discarded": (args) => args[0]["agent"],
	"agent/inbox/inserted": (args) => args[0]["agent"],
	"agent/pre-step": (args) => args[0]["agent"],
	"agent/request": (args) => args[0]["agent"],
	"agent/request-error": (args) => args[0]["agent"],
	"agent/status": (args) => args[0]["agent"],
	"agent/turn-stopping": (args) => args[0]["agent"],
	"approval/request": (args) => args[0]["agent"],
	"goal/changed": (args) => args[0]["agent"],
	"session/created": null,
	"session/disposed": null,
	"session/event": null,
	"session/flush": null,
	"subagent/end": null,
	"subagent/start": null,
	"system-prompt/assemble": (args) => args[1]["scope"],
	"tools/execute": (args) => args[0]["agent"],
	"tools/post-execute": (args) => args[0]["agent"],
	"tools/pre-execute": (args) => args[0]["agent"],
	"tools/ptc-dispatch-log": (args) => args[0]["agent"],
	"tools/result": (args) => args[0]["agent"],
	"user-questions/request": (args) => args[0]["agent"]
});
```

**`compaction/summary-error` 不在其中。**

**(ii) cordis 的 `waterfall` 没有 carrier 参数位** —— `D:\Dev\Path\nodejs_25.0.0\npm-cache\_npx\1e7f6d9597241db0\node_modules\@deepseek-ai\cordis\lib\index.js:258-264`：

```js
	dispatch(type, args) {
		const thisArg = typeof args[0] === "object" || typeof args[0] === "function" ? args.shift() : null;
		const name = args.shift();
		if (!name.startsWith("internal/")) this.emit("internal/dispatch", type, name, args, thisArg);
		const filter = thisArg?.[Context.filter];
		return (this._hooks[name] || []).filter((hook) => hook.global || !filter || filter.call(thisArg, hook.ctx)).map((hook) => hook.callback.bind(thisArg));
	}
```

对 `ctx.waterfall("compaction/summary-error", payload, () => false)`：`args[0]` 是字符串 → `thisArg = null` → `filter = undefined` → **`!filter` 为真 → 所有监听器全部入选**（跨 scope、跨 preset realm）。

### 2.4.5 结论

- **分发层面：是进程级 waterfall，可能被任何监听器收到**（不限于压缩发起方 session 的所有者）。这是「是否可能跨 session 触发」的正确答案：**事件分发是跨 session 的，但语义与恢复效果不跨 session。**
- **效果层面：严格局限在压缩发起方会话内。** payload 的 `session` 是该会话；监听器改的也是它。
- **模型可见性：无。** 它不是 SessionEvent，不进任何日志、不进 surface、不进请求装配。

---

## 2.5 问题 5 —— 主会话侧对子会话历史的读通路，以及是否被用于「查看成员状态」

### 2.5.1 读通路清单（第一方）

| 通路 | 位置 | 读的是谁的日志/投影 | 是否第一方用于「成员状态」 |
|---|---|---|---|
| `ctx.subagents.listChildren(parentSessionId)` | `$DSH\dsh-subagent\lib\types\list-children.js:67-90` | **父会话自己的** `subagentCatalog` 投影 | ✅ 是（`list_agents`） |
| `ctx.subagents.listDescendants(rootSessionId)` | `$DSH\dsh-subagent\lib\types\list-children.js:99-158` | 逐级读各父会话自己的 catalog | ✅ 是（`scope: descendants`） |
| `ctx.sessions.get(id)` / `.list()` | `$DSH\dsh-session\lib\index.js`（SessionStore） | 活动会话对象 | ⚠️ 仅用于 `running/inactive` 判定 |
| `ctx.sessionQuery.observeSession/readSurface/listSessions` | `$DSH\dsh-session-query`（sqlite 后端） | 任意会话的日志与 surface | ✅ 是（跨会话引用） |
| `ctx.sessionReferenceResolver` | `$DSH\dsh-session-reference\lib\index.js` | 任意会话的 `readSurface` | ✅ 是（用户 `@` 提及） |

`listChildren` 实现（`D:\Dev\Path\nodejs_25.0.0\npm-cache\_npx\1e7f6d9597241db0\node_modules\@deepseek-ai\dsh-subagent\lib\types\list-children.js:67-90`）：

```js
export async function listChildren(ctx, parentSessionId, signal) {
    const env_1 = { stack: [], error: void 0, hasError: false };
    try {
        const query = ctx.get('sessionQuery');
        if (query === undefined) {
            throw new SubagentError('listing subagents requires the sessionQuery service (load @deepseek-ai/dsh-session-query)', 'SUBAGENT_CONTROL_QUERY_UNAVAILABLE');
        }
        const parent = __addDisposableResource(env_1, await query.observeSession(parentSessionId, {
            ...signal === undefined ? {} : { signal },
        }), false);
        const entries = parent.projections?.values.subagentCatalog;
```

`listDescendants` 的 `activity` 只做活动性判定（同文件 145-152）：

```js
            const { createdAt: _createdAt, ...identity } = entry;
            result.push({
                ...identity, kind: 'child', parentId, depth,
                activity: sessions.get(entry.id) === undefined ? 'inactive' : 'running',
                hasChildren: children.length > 0,
            });
```

### 2.5.2 唯一模型可见的「成员状态」工具：`list_agents`

`D:\Dev\Path\nodejs_25.0.0\npm-cache\_npx\1e7f6d9597241db0\node_modules\@deepseek-ai\dsh-tool-subagent-control\lib\types\list-agents.js:17-38`：

```js
/** Report turn activity without exposing whether the child is loaded. */
function statusOf(agents, id) {
    return agents.get(id)?.status === 'running' ? 'running' : 'inactive';
}
/** Project one service row into the model-facing entry, or omit a one-shot child. */
function project(agents, entry, position) {
    const at = position === undefined ? {} : { parent: position.parentId, depth: position.depth };
    if ('kind' in entry && entry.kind === 'diagnostic') {
        return { kind: 'diagnostic', id: entry.id, reason: entry.reason, ...at };
    }
    // One-shot children cannot be continued by send_message, so the model
    // never selects them; discovery still traversed them for descendants.
    if (entry.mode !== 'continuable')
        return undefined;
    return {
        kind: 'child',
        id: entry.id,
        label: entry.label,
        status: statusOf(agents, entry.id),
        ...at,
    };
}
```

输出 schema（同文件 58-88）严格限定 `child: {kind,id,label,status∈{running,inactive},parent?,depth?}` 与 `diagnostic: {kind,id,reason∈{corrupt,unsupported,unavailable},parent?,depth?}`。**没有任何上下文/压缩字段。**

⚠️ 注意：`list_agents` 是 **preset 行**（`D:\Dev\Path\nodejs_25.0.0\npm-cache\_npx\1e7f6d9597241db0\node_modules\@deepseek-ai\dsh-web-app\presets\standard.patch.yml:88-89`），host 平面上的同名行被禁用（`...\dsh-web-app\cordis.patch.yml:525-529`）。

### 2.5.3 ★ 最强的一条读通路：`dsh-session-reference`（可把别的会话内容注入本会话模型上下文）

它挂载在 web bundle 上（非默认关）：`D:\Dev\Path\nodejs_25.0.0\npm-cache\_npx\1e7f6d9597241db0\node_modules\@deepseek-ai\dsh-web-app\cordis.patch.yml:94-95`：

```yaml
    - id: session-reference
      name: '@deepseek-ai/dsh-session-reference'
```

它注册 `agent/pre-step` 并**改写本步消息**（`D:\Dev\Path\nodejs_25.0.0\npm-cache\_npx\1e7f6d9597241db0\node_modules\@deepseek-ai\dsh-session-reference\lib\index.js:468-475`）：

```js
			ctx.on("agent/pre-step", async ({ agent, signal }, next) => {
				const decision = await next();
				if (decision.kind === "reject") return decision;
				return {
					...decision,
					messages: await this.prepareDirectMessages(agent, decision.messages, signal)
				};
			}, { prepend: true });
```

它读的是**任意会话的当前 surface**（`...\dsh-session-reference\lib\index.js:617`）：

```js
			snapshot: await this.ctx.sessionQuery.readSurface(input.sessionId)
```

**并且它的投影显式识别并保留压缩检查点**（同文件 126-140）：

```js
function projectSessionConversation(snapshot) {
	const conversation = [];
	for (const event of snapshot.events) switch (event.type) {
		case "user/message": {
			const checkpoint = isCompactCheckpointSource(event.data.source);
			if (!checkpoint && event.data.source.kind !== "user") break;
			const text = textContent(event.data.content);
			if (text !== "") conversation.push({
				role: "user",
				text,
				checkpoint,
```

保留策略还**优先丢非检查点消息**（同文件 185-194）。但渲染给模型的数据只保留 `{role, text}`（同文件 178-181）：

```js
		conversation: retained.map(({ role, text }) => ({
			role,
			text
		}))
```

**因此判定**：这是**唯一**一条第一方「跨会话内容 → 模型上下文」通道，它能把**另一个会话的压缩摘要正文**带进来；但（a）由**用户显式 `@[label](dsh-session:<id>)` 提及**触发，不自动发生；（b）只带**正文文本**，`checkpoint` 布尔被剥掉，模型**不知道**那段来自压缩；（c）不携带任何阈值/压力/stale 元信息。它与「子会话压缩回传给父会话」不是同一件事。

### 2.5.4 反例排除：host/UI 的「服务寻址」不是模型读通路

`D:\Dev\Path\nodejs_25.0.0\npm-cache\_npx\1e7f6d9597241db0\node_modules\@deepseek-ai\dsh-agent-preset-registry\lib\index.js:177-188` 的 `serviceForAgent` 让宿主 RPC 按 agent 定位其 preset 内服务（浏览器读会话状态用），注释明确它**不是**通用的 session 内部句柄：

```js
function serviceForAgent(ctx, agent, name) {
	const mount = standingMountFor(agent.ctx);
	if (mount === void 0) return void 0;
	const store = ctx.reflect.store;
	for (const key of Object.getOwnPropertySymbols(store)) {
		const impl = store[key];
		/* v8 ignore next -- cordis deletes a store slot on disposal rather than clearing it */
		if (impl === void 0) continue;
		if (impl.name !== name) continue;
		if (withinFiber(impl.fiber, mount.fiber)) return impl.value;
	}
}
```

---

## 2.6 问题 6 —— 阈值调低后会怎样

### 2.6.1 阈值是可配的，且是**每模型路由**可配的

`D:\Dev\Path\nodejs_25.0.0\npm-cache\_npx\1e7f6d9597241db0\node_modules\@deepseek-ai\dsh-compaction-basic\lib\types\types.d.ts:8-41`：

```ts
export interface CompactionPolicyConfig {
    /** Window fraction for pressure; capped at context window minus reserved output and `headroomTokens`. Defaults to `0.8`. */
    thresholdRatio?: number;
    /** Additional pressure headroom beyond the routed output reservation. Non-negative integer; defaults to `65536`. */
    headroomTokens?: number;
    /** Recent context retained as a fraction of context window minus reserved output tokens. Defaults to `0.16`. */
    retainRatio?: number;
    /** Absolute recent-context budget; mutually exclusive with `retainRatio`. */
    retainTokens?: number;
    /** Summary provider; set together with `summarizationModel`, or inherit the conversation target. */
    summarizationProvider?: string;
    /** Summary model; set together with `summarizationProvider`, or inherit the conversation target. */
    summarizationModel?: string;
    /** Provider generation cap for summarization. Defaults to the resolved `headroomTokens`; an explicit cap must be positive. */
    maxTokens?: number;
    /** Extra attempts after the first compaction when pressure remains above threshold. Defaults to `1`. */
    compactionRetries?: number;
    /** Maximum retries after canonical context overflow; `0` disables recovery. Defaults to `1`. */
    maxOverflowRetries?: number;
}
/** Exact provider/model override merged over the default compaction policy. */
export interface ModelCompactPolicyConfig extends CompactionPolicyConfig {
```

当前 profile **没有**覆写压缩阈值：`C:\Users\ZYX\.dsh\profiles\web\cordis.patch.yml` 全文只有 `ui-settings-general`、`llm-pi-ai`、`agent-default-model`、`permission`、`locale`、`subagent(maxDepth: 2)`、`ui-chat`、`pwsh-sandbox` 与一个 `mcp-anysearch` insert —— **零 `compaction-basic` 行**。所以现在用的是默认 `thresholdRatio: 0.8` / `headroomTokens: 65536` / `retainRatio: 0.16`。

### 2.6.2 频繁触发后的既有可见性

| 观察者 | 会不会看到子会话被压缩 | 依据 |
|---|---|---|
| 父会话**模型上下文** | **不会** | §2.1、§2.2.1 |
| 父会话**日志** | **不会**（除 fork 种子，见 §2.1.7） | §2.1.3、§2.1.9 |
| 父会话侧**事件监听器**（进程内） | 会（`session/event` untagged 广播） | §2.1.6 |
| UI（打开该子会话时） | 会 | §2.2.2 |
| 遥测 | 会（`context_compression`） | §2.1.5 |
| 子会话自己的模型上下文 | 会（压缩检查点 `user/message` 落到自己的 surface） | §2.1.7 中 checkpoint 事件 |

### 2.6.3 「需要新通道」——明确结论

**要父会话模型上下文看到「子会话被压缩 / 压力 / stale 风险」，当前必须新增通道，没有既有机制。**

好消息是既有代码里已有**两个可直接照抄的先例**，都不需要改 DSH 内核：

**先例 A —— 把成员侧事件 append 进 captain 会话（跨会话写入）**：teams 插件 `I:\VMsShare\_src-compare\dsh-agent-teams\src\events.ts:1-9`：

```ts
/**
 * Durable AgentTeams session events and their emitter.
 *
 * Every team-state mutation appends one event to the captain's Session, so
 * the web client's Conversation Node mechanism can fold the tree view from
 * the session log deterministically (same mechanism as `tool-workflow`'s
 * `tool-workflow/*` record events). Events append to the captain's session
 * even when a member agent performed the mutation, so the captain's
 * conversation stream stays the single authoritative monitor surface.
 */
```

配合 `captainSessionOf`（同文件 71-78）解析 captain 的 live Session 并 `session.append(type, data)`（同文件 33-60，且对 harness 未注册的类型做优雅跳过）。**但注意：`compaction/*` 已在 `KNOWN_SESSION_EVENT_TYPES` 中（§2.1.4），所以若照抄该先例写自定义事件，还需要该类型亦被 harness 认知，或走 `ignorable` 机制。**

**先例 B —— 由 runtime 向父会话注入一条模型可见 `user/message`**：`D:\Dev\Path\nodejs_25.0.0\npm-cache\_npx\1e7f6d9597241db0\node_modules\@deepseek-ai\dsh-subagent\lib\types\continuation-messages.js:85-105` 的 `createSettlementMessage`（含 `source.kind: 'subagent-settled'` 归因），以及 `dsh-experimental-auto-review` 对 `origin/parentSession` 的读取范式（`D:\Dev\Path\nodejs_25.0.0\npm-cache\_npx\1e7f6d9597241db0\node_modules\@deepseek-ai\dsh-experimental-auto-review\lib\index.js:101-124`）：

```js
/** Whether this message was durably attributed to the child's direct parent. */
function isDirectParentInstruction(source, parentSession) {
	return parentSession !== void 0 && source.kind === "agent-message" && source.senderSessionId === parentSession;
}
/** Find the visible-role identity of the in-process child's creation prompt. */
function directParentInitialPromptSeq(agent, events) {
	const { session } = agent;
	if (session.header.origin !== "subagent" || session.header.parentSession === void 0) return void 0;
```

### 2.6.4 若真要做，最小可行通道形态（供后续设计参考，本次不实施）

在父会话侧注册 `agent/pre-step`（或 `session/event` + 过滤子会话 `compaction/*`），把一句话注入父会话消息流，例如 `source: { kind: 'subagent-settled' | 新 kind }`。注意两个已存在的约束：

1. `MessageSourceMap` 是封闭联合（`dsh-llm` 声明合并），新增 `kind` 需要同时改类型；
2. 该注入会改变父会话的 request 形状，可能影响 KV cache（fork 子会话注释里明确提到保持 provider/model/model-selection 一致以复用 KV cache，`D:\Dev\Path\nodejs_25.0.0\npm-cache\_npx\1e7f6d9597241db0\node_modules\@deepseek-ai\dsh-base\cordis.patch.yml:377-382`）。

---

# 3. 检索范围清单（用于支撑否定结论）

## 3.1 目录

| 目录 | 说明 |
|---|---|
| `D:\Dev\Path\nodejs_25.0.0\npm-cache\_npx\1e7f6d9597241db0\node_modules\@deepseek-ai\` | 全量 DSH 安装树（含 `dsh`、`dsh-*`、`libreoffice-kit*`、`cordis*`、`schemastery`、`node-addon-system`） |
| `I:\VMsShare\_src-compare\dsh-agent-teams\src\` | teams 插件源码（含 `client/` 子目录） |
| `C:\Users\ZYX\.dsh\profiles\web\node_modules\@nanmicoder\dsh-agent-teams\` | teams 插件实际安装（含 `lib/*.js` 构建产物与 `lib/client.js`） |
| `C:\Users\ZYX\.dsh\profiles\web\cordis.patch.yml` | 用户 patch 层 |
| `$DSH\dsh-base\cordis.patch.yml`、`$DSH\dsh-web-app\cordis.patch.yml`、`$DSH\dsh-web-app\presets\standard.patch.yml` | 三层 bundle patch |
| `C:\Users\ZYX\.dsh\sessions\` | 60 个会话日志（4 个工作区：`--I-VMsShare--` 12、`--I-googo--` 36、`--I-A_need-cmdc…--` 10、`--C-Users-ZYX-Documents-deepseek-harness-default-workspace--` 2） |

## 3.2 检索规模

- 全树文件扫描：**2938 个文件**（`*.js` / `*.d.ts` / `*.ts` / `*.yml` / `*.json`，排除部分 `lib/types` 重复实现）。
- 含 `compaction` 的文件：**约 110 个**（完整清单已获取；其中 UI/客户端/迁移/typert 声明占绝大多数）。

## 3.3 关键词与结果

| 关键词 / 模式 | 范围 | 结果 |
|---|---|---|
| `delegationDepth\|parentSession\|\borigin\b\|subagent` | 5 个压缩包（含 `lib/types`、README、`.d.ts`） | **ZERO HITS**（Q3 独立复核） |
| `session.header\|\.header\.\|isSeeded\|agent.parent\|depth` | 5 个压缩包 | 仅命中 `dsh-compaction-image-offload` README 里描述「depth-first image indexes」的无关措辞 |
| `compaction/(start\|summary\|end\|prune\|summary-error)` | 全树（排除 `dsh-compaction*` 自身与 `dist`） | 消费方 = 客户端 UI（chat/trajectory/conversation）、token-meter surface fold、session-format 迁移（v0→v1 / v1→v2 / v2→v3 / v3→v4）、session-log-export、product-analytics、api-session-controller（历史序列化）、`agent-preset-registry`/`commands`/`permission-presets`/`subagent`/`user-questions`/`cordis-host-runner` 的 typert 声明字符串。**无一是「子会话 → 父会话」的注入点。** |
| `summary-error` | 全树 | 仅 6 处：`dsh-compaction/lib/types/index.d.ts:85`、`dsh-compaction-basic/lib/index.js:1017`、`dsh-compaction-image-offload/lib/index.js:146`（+ `lib/types/index.js:29`）、`dsh-tool-cordis/lib/types/api-catalog.js:3876,3878` |
| `compactIfNeeded\|compactNow\|compactRegion` | 全树 | 外部调用点只有 1 个：`dsh-command-compact/lib/index.js:55`（`/compact`）。自动路径全在 `dsh-compaction-basic` 内部（`lib/index.js:841,872,934,956,971,985`） |
| `on("session/event"` / `on('session/event'` | 全树 | 52 处；其中只有 `dsh-client-product-analytics/lib/index.js:116` 检查 `compaction/start`（遥测）。**无一处把压缩事件写入另一个 agent 的 messages/inbox。** |
| `ctx.waterfall(` / `ctx.on(` | 全树 | `compaction/summary-error` 是唯一压缩相关 waterfall |
| `compactCheckpointSource\|isCompactCheckpointSource\|compact-checkpoint` | 全树 | 消费方 = UI（chat:8909/9248、trajectory:1032）、`dsh-experimental-auto-review:99`（评定自身可见历史角色）、`dsh-session-reference`（跨会话投影）、`dsh-compaction*` invariants、session-format v3→v4 |
| `stale` | 全树 | 命中集中在 websocket/UI/带 stale cursor 的查询/teams 自身的 verdict 陈旧度。**压缩包内零命中**；`dsh-compaction*` 无任何 stale 风险信号 |
| `agent/session-start` | 全树（DSH 包） | **ZERO HITS** in DSH；仅 `$TEAMS_SRC\harness-compat.ts:7,107,116,118,158` 的兼容层 |
| `compaction` | `$TEAMS_SRC` 全量（`.ts`/`.tsx`） | **ZERO HITS** |
| `compaction` | `$TEAMS_INST\lib\**`（`.js`） | **ZERO HITS** |

## 3.4 会话日志解析方法（可复现）

会话日志是**多帧 zstd**（magic `28 B5 2F FD`）。关键坑：`node:zlib` 的 `zstdDecompressSync` **只解第一帧**，对整文件调用会「成功」但只返回首帧（实测 5,457,836 B 文件只返回 189 B）。正确做法是先按 magic 切帧，再逐帧解：

```js
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
// 找到所有 magic offset；对每个 start，向后尝试各候选边界，
// 第一个能成功 zstdDecompressSync 的边界即该帧末尾（截断帧必然抛错）。
```

校验：`--I-googo--\session-94da6bb9-…` 解出 **1696 帧 / 20,331,314 B 文本 / 3158 行 / 0 行不可解析**，事件类型分布合理（`tool/call` 556、`tool/result` 556、`step/start` 502…）。

临时脚本（均已删除）：
`I:\VMsShare\_probe-zstd-frames.mjs`、`_probe-validate-decode.mjs`、`_probe-decode-sessions.mjs`、`_probe-scan-compaction.mjs`、`_probe-parent-child.mjs`、`_probe-foreign-compaction-id.mjs`、`_probe-fork-seed.mjs`、`_probe-fork-chain.mjs`。

## 3.5 已确认事实的实测复核数据（60 会话全量）

含自有 `compaction/*` 的会话（13 个）：

```
session-5c54badf-…  (--I-A_need-cmdc…--) start5 summary4 end5
session-afafb36e-…  (--I-A_need-cmdc…--) start4 summary4 end4
session-f9b5aa84-…  (--I-A_need-cmdc…--) start4 summary4 end4
session-fbdbb6e9-…  (--I-A_need-cmdc…--) start1 summary1 end1
session-fec92f9e-…  (--I-A_need-cmdc…--) start2 summary2 end2
session-4c3aac72-…  (--I-googo--)        start1 summary1 end1
session-6bd0da75-…  (--I-googo--)        start2 summary2 end2
session-94da6bb9-…  (--I-googo--)        start3 summary3 end3
session-a402c802-…  (--I-googo--)        start2 summary2 end2
session-bc70523b-…  (--I-googo--)        start1 summary1 end1  ← 全部为 fork 继承，非自有
session-e038b78a-…  (--I-googo--)        start1 summary1 end1
session-e7f4c33e-…  (--I-googo--)        start1 summary1 end1
session-dee7fe39-…  (--I-VMsShare--)     start1 summary1 end1
```

- `origin=subagent` 会话共 31 个：**全部 `comp={}`**（零自有压缩）。
- `--I-VMsShare--` 工作区共 12 个会话（你说的是 11，多出的应是本取证会话链新建的子会话）。
- 无 `compaction/prune` 事件出现在任何日志中（`tool-result-pruner` 的 prune 只在超阈值 tool result 上触发）。

---

# 4. 与「阈值调低后」相关的推论

1. **阈值调低 ⇒ 只改变「何时压」，不改变「压谁、结果给谁」。** 触发判定在 `agent/pre-step`（`$DSH\dsh-compaction-basic\lib\index.js:839-852`）与 `agent/request-error`（同文件 861-887），写入目标恒为 `agent.session`。
2. **父子共享策略、不共享结果。** 子 agent 加入父 agent 的 preset 修订（`$DSH\dsh-agent-preset-registry\lib\index.js:703-718`），因此子会话的阈值就是父会话那份配置；但压缩结果只落子会话日志。
3. **对父会话模型上下文的唯一影响是「间接且延迟」的**：子会话被压缩后，其后续回答可能变短/更聚焦 → 结算消息与其 `lastAssistantMessage` 文本变化 → 父会话读到的收尾文本变化。**父会话永远不知道这变化源于压缩。**
4. **父会话能观察到的唯一近似信号是 `stopReason: 'max-tokens'` ⇒「ran out of room before it finished.」**（`$DSH\dsh-subagent\lib\types\continuation-messages.js:64-65`）与 `list_agents` 的 `status` 摆动。两者都不是压缩信号。
5. **频繁压缩会放大一个重要既有风险（与回传无关，但值得并列）**：如果父会话在压缩**之后** fork 子会话，子会话的初始 surface 是父会话**已被 shadow 的有损上下文**（§2.1.7）。阈值越低，父会话越可能带着有损 surface 去 fork —— 这是**父 → 子**的信息损失传播，而非回传。
6. **因此**：任何「让父会话感知成员上下文健康」的能力都必须新建通道（§2.6.3/2.6.4）。现有第一方通道里，最接近的是 `list_agents`（只给 running/inactive）与 `dsh-session-reference`（用户显式 `@` 提及才跨会话）。

---

# 5. UNVERIFIED 清单

| # | 未能确证的事项 | 检索位置与原因 |
|---|---|---|
| 1 | **运行时实际加载的 `thresholdRatio` 值** | 我读到的是 config schema 默认值（`0.8`）与「profile 未覆写」这一事实；未在运行时读取 loader 生效配置（需起进程/inspect），因此「当前生效阈值恰为 0.8」属推断而非直接观测。检索：`C:\Users\ZYX\.dsh\profiles\web\cordis.patch.yml`（全文已读，无 compaction 行）、`$DSH\dsh-web-app\presets\standard.patch.yml:70-71`（preset 行无 config）、`$DSH\dsh-base\cordis.patch.yml:341-342`（host 行无 config，且被 web patch 禁用）。 |
| 2 | **`--I-A_need-cmdc…--` 工作区 4 个含压缩会话的精确 fork 边界** | 我只对该工作区 3 个会话核对了 `session/end-seed` 序列与 summary seq（`fec92f9e`→`f9b5aa84`→`5c54badf`），未做 `buildForkSeed` 边界的字节级逐事件比对（`--I-googo--` 的那一对已做全量字节比对）。检索：`$SESS\--I-A_need-cmdc…--\session-{fec92f9e,f9b5aa84,5c54badf}\session.v4.jsonl.zstd` 的 `session/end-seed` 与 `compaction/summary` 事件。 |
| 3 | **`compaction/prune` 从未出现** 是否因当前工作负载的 tool result 都低于 `thresholdChars: 8192`，还是因为 pruner 只在 compaction 路径被调用 | 我读到 pruner 的调用点只有 `$DSH\dsh-compaction-basic\lib\index.js:926-945`（`compactIfNeeded` 内），未独立验证「单独 `pruneSession` 是否可被其他路径触发」。检索：全树 `pruneSession`、实测 60 会话零 `compaction/prune`。 |
| 4 | **`ctx.waterfall` 派发的 listener 顺序（谁先拿到 `compaction/summary-error`）** 在多层 preset realm 共存时的确切插入序 | 我确证了「所有监听器都会入选」（`filter === undefined`），但未列举运行时实际注册了几份 `compaction-image-offload`（host 平面一份，preset 平面零份）。检索：`$DSH\dsh-base\cordis.patch.yml:427-428`（host 行 `image-offload`）、`$DSH\dsh-web-app\presets\standard.patch.yml`（preset 内无 image-offload）。 |
| 5 | **`list_agents` 在 `scope: descendants` 下是否会因中间会话日志损坏而静默降级**（影响「父会话能否稳定查看成员状态」） | 我读到 `list-children.js:128-141` 对 `SESSION_QUERY_CORRUPT_SESSION` / `SESSION_QUERY_SOURCE_CONFLICT` 产出 `diagnostic{reason:'corrupt'\|'unavailable'}`，但未构造损坏日志实测。检索：`$DSH\dsh-subagent\lib\types\list-children.js:99-158`、`$DSH\dsh-tool-subagent-control\lib\types\list-agents.js:109-133`。 |
| 6 | **`dsh-agent-teams` 的 `harness-compat.ts` 在新 harness 下是否真的完全不订阅 `agent/session-start`** | 我读到 `harness-compat.ts:116-118` 声明该兼容事件、`legacy.on('agent/session-start', …)` 的旧路径；未运行插件以确认 `legacy` 在 DSH v25 harness 下为 `undefined`（因此该订阅实际不注册）。检索：`$TEAMS_SRC\harness-compat.ts:100-170`；`$TEAMS_INST\lib\harness-compat.js` 对应段。 |
| 7 | **`dsh-experimental-agent-team`（DSH 内置 teams）是否也把成员状态写进 captain session 并在模型上下文可见** | 我确证它注册了 `ctx.on("session/event", …)` 与 `agent/status`（`$DSH\dsh-experimental-agent-team\lib\index.js:1720-1729`）并使用 `teamProjectionDefinition`；未逐字段核对 `team/member`、`team/task` 等事件的模型可见性。这与本次「压缩回传」问题正交，故未深挖。 |
| 8 | **README 级描述与本报告结论的一致性**（`dsh-compaction/README.md`、`dsh-subagent/README.md` 是否明文写「不通知父会话」） | 我读了 `dsh-session-reference/README.md:28-53,69`、`dsh-agent-preset/README.md` 的关键段，但未逐字通读全部压缩/子代理 README。若要引用官方措辞需要补读；本报告全部结论均基于**代码**，不依赖 README。 |

---

*报告结束。全文结论仅基于只读源码检索与只读会话日志解析；未修改任何被检视对象。*
