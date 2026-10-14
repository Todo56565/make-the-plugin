# T3 — dsh-agent-teams 所依赖的宿主侧上下文基础设施（DSH harness 压缩栈）

> 定位（按船长范围更正）：本报告不讲 DSH 实验版"智能体团队"，而是把 **dsh-agent-teams 把对话历史/压缩外包给的那一层** 讲清楚。
>
> **三层标注纪律**（全文遵守）：
> - **【插件】** = `NanmiCoder/dsh-agent-teams` 自身（t2 已取证：不实现压缩/摘要/笔记/检索）
> - **【宿主压缩栈】** = `dsh-compaction` / `-basic` / `-tool-result-pruner` / `-command-compact`（+ `dsh-spill-*`、`dsh-token-meter`）
> - **【harness 核心】** = 会话/子代理/请求装配的宿主基础（`dsh-session*`、`dsh-subagent*`、`dsh-agent*`）

## 取证环境（只读取证，未修改任何被测文件）

| 项 | 值 |
|---|---|
| DSH 安装 | `D:\Dev\Path\nodejs_25.0.0\npm-cache\_npx\1e7f6d9597241db0\node_modules\@deepseek-ai\`（包版本均 `0.2.0-rc.2`） |
| DSH_HOME | `C:\Users\ZYX\.dsh` |
| 活动 profile | `web`（`DSH_PROFILE=web`，`DSH_PROFILE_DIR=C:\Users\ZYX\.dsh\profiles\web`） |
| 本会话 | `DSH_SESSION_ID=5555841f-4f2e-49c4-b100-cf9f51835249` |
| 只读性 | 两个取证根均无 `.git`；相关包文件 mtime 全为 `2026/10/7 1:42`（会话开始于 2026-10-11），未写入 |

---

**只读性核验**：取证期间未被任何命令写入 —— 对两个取证根按 mtime 扫描，
`D:\Dev\Path\nodejs_25.0.0\npm-cache\_npx\1e7f6d9597241db0` 自会话开始（2026-10-11 22:40）起 **0 个文件**被修改；
`C:\Users\ZYX\.dsh` 下 14 个文件有更新，全部是**运行中的 Harness 自身**的实时写入（本会话日志 `5555841f-…` + 其他活动会话的 `session.v4.jsonl.zstd` 追加、
投影缓存、以及 profile 启动时重写 `cordis.yml`/`package.json`），非同源取证写入；引用的配置内容核对后逐字未变。

**证据自检（可复现）**：报告中每条源码引用前都有 `<!-- src: 路径:起始-结束 -->` 标记，
`node t3-evidence-tools/check-t3-evidence.mjs t3-dsh-host-context-infrastructure.md <dshNodeModulesRoot> <dshHome>`
逐字节复核 **46/46 段全部一致（299 行参与比较，failures=0）**；另有 12 个未加标记的代码块是
**运行态/命令输出证据**（会话解帧结果、命令 stdout），由文中的命令与来源说明定位，不对应源码行。

## 1. 压缩组件栈：四个包各自职责

### 1.1 `dsh-compaction` — 与后端无关的压缩**服务缝**（不是策略实现）

`node_modules/@deepseek-ai/dsh-compaction/lib/types/index.d.ts:1-8`：

<!-- src: D:\Dev\Path\nodejs_25.0.0\npm-cache\_npx\1e7f6d9597241db0\node_modules\@deepseek-ai\dsh-compaction\lib\types\index.d.ts:1-8 -->
```ts
/**
 * Compaction Service Definition (`ctx.compaction`): providers decide when to
 * compact and replace a history range with one summary node by subclassing
 * {@link CompactionEngine}. This interface necessarily depends on session and LLM
 * vocabulary; the rationale is in the
 * [compaction Agent Note](../../../../.agents/notes/implemented/feature/2026-06-18-compaction-capability-seam.md).
 * @module @deepseek-ai/dsh-compaction
 */
```

`node_modules/@deepseek-ai/dsh-compaction/lib/types/index.d.ts:25`（触发类只有两种）：

<!-- src: D:\Dev\Path\nodejs_25.0.0\npm-cache\_npx\1e7f6d9597241db0\node_modules\@deepseek-ai\dsh-compaction\lib\types\index.d.ts:25-25 -->
```ts
export type CompactionTrigger = 'pressure' | 'context-overflow';
```

`node_modules/@deepseek-ai/dsh-compaction/lib/types/index.d.ts:116,137,157`（抽象 API 三个入口）：

<!-- src: dsh-compaction/lib/types/index.d.ts:116-116 -->
```ts
    abstract compactIfNeeded(agent: CompactionAgentContext, trigger: CompactionTrigger, signal: AbortSignal): Promise<CompactionResult | null>;
```

<!-- src: dsh-compaction/lib/types/index.d.ts:137-137 -->
```ts
    abstract compactNow(agent: ManualCompactAgentContext, signal: AbortSignal, sourceCommandId?: CommandId): Promise<CompactionResult | null>;
```

<!-- src: dsh-compaction/lib/types/index.d.ts:157-157 -->
```ts
    abstract compactRegion(start: SessionSeq, end: SessionSeq, agent: CompactionAgentContext, signal?: AbortSignal): Promise<CompactionResult>;
```

检查点消息源（替换用户消息的持久标记）：

`node_modules/@deepseek-ai/dsh-compaction/lib/types/checkpoint.d.ts:17-24`：

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

### 1.2 `dsh-compaction-basic` — 策略 + LLM 摘要后端

`node_modules/@deepseek-ai/dsh-compaction-basic/package.json` description：

<!-- src: dsh-compaction-basic/package.json:3-3 -->
```json
  "description": "Token-meter-driven compaction policy and LLM summarization backend for the DeepSeek Harness",
```

### 1.3 `dsh-compaction-tool-result-pruner` — 无模型、可重放的**工具结果裁剪**

`node_modules/@deepseek-ai/dsh-compaction-tool-result-pruner/package.json` description：

<!-- src: dsh-compaction-tool-result-pruner/package.json:3-3 -->
```json
  "description": "Replay-safe model-free head/middle/tail pruning for tool-result surface nodes",
```

### 1.4 `dsh-command-compact` — 人面向的 `/compact` 入口

`node_modules/@deepseek-ai/dsh-command-compact/lib/index.js:4-9`：

<!-- src: D:\Dev\Path\nodejs_25.0.0\npm-cache\_npx\1e7f6d9597241db0\node_modules\@deepseek-ai\dsh-command-compact\lib\index.js:4-10 -->
```js
/**
* Human-facing `/compact` command over the backend-independent compaction seam.
* @module @deepseek-ai/dsh-command-compact
*/
const name = "command-compact";
const inject = ["commands", "compaction"];
const USAGE = "Usage: /compact (no arguments)";
```

`node_modules/@deepseek-ai/dsh-command-compact/lib/index.js:55-64`（唯一动作：调用 `compactNow`）：

<!-- src: D:\Dev\Path\nodejs_25.0.0\npm-cache\_npx\1e7f6d9597241db0\node_modules\@deepseek-ai\dsh-command-compact\lib\index.js:55-64 -->
```js
		const result = await ctx.compaction.compactNow(invocation.agent, invocation.signal, invocation.commandId);
		if (result === null) return {
			kind: "success",
			text: "No compactable history yet."
		};
		return {
			kind: "success",
			text: `Compacted ${result.shadowedSeqs.length} history items (~${result.shadowedTokenCount} tokens).`,
			sourceEventSeq: result.summarySeq
		};
```

`node_modules/@deepseek-ai/dsh-command-compact/lib/index.js:93-98`（命令注册名 `compact`）：

<!-- src: D:\Dev\Path\nodejs_25.0.0\npm-cache\_npx\1e7f6d9597241db0\node_modules\@deepseek-ai\dsh-command-compact\lib\index.js:93-98 -->
```js
		yield ctx.commands.register({
			definitionId: CommandDefinitionId("@deepseek-ai/dsh-command-compact"),
			name: "compact",
			description: "Compact older conversation history",
			handler
		});
```

### 1.5 本机 profile 是否装载它们（决定"是否真的在跑"）

`@deepseek-ai/dsh-web-app/cordis.patch.yml:509-516`（**bundle 层是 disabled**）：

<!-- src: D:\Dev\Path\nodejs_25.0.0\npm-cache\_npx\1e7f6d9597241db0\node_modules\@deepseek-ai\dsh-web-app\cordis.patch.yml:509-516 -->
```yaml
- id: compaction-basic
  disabled: true

- id: command-compact
  disabled: true

- id: tool-result-pruner
  disabled: true
```

`@deepseek-ai/dsh-web-app/presets/standard.patch.yml:63-79`（**preset 的 compaction 组把它们重新启用**，且 pruner 用固定预算）：

<!-- src: D:\Dev\Path\nodejs_25.0.0\npm-cache\_npx\1e7f6d9597241db0\node_modules\@deepseek-ai\dsh-web-app\presets\standard.patch.yml:63-79 -->
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

该组属于 **`standard` preset**：`@deepseek-ai/dsh-web-app/presets/standard.patch.yml:5-9`：

<!-- src: D:\Dev\Path\nodejs_25.0.0\npm-cache\_npx\1e7f6d9597241db0\node_modules\@deepseek-ai\dsh-web-app\presets\standard.patch.yml:5-9 -->
```yaml
    - id: preset-standard
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: standard
        order: 1
```

**本会话与全部 AgentTeams 会话确认跑在该 preset 下**（运行态）：会话投影缓存 `C:\Users\ZYX\.dsh\storages\session_projcache\sessions\5555841f-4f2e-49c4-b100-cf9f51835249.json` 的 `record.rows.agentPreset.val` = `standard`；会话日志首行头亦为 `"agentPreset":"standard"`（见 §3.1）。对照：`preset-minimal`（`@deepseek-ai/dsh-web-app/presets/minimal.patch.yml`，全 61 行）内 compaction 相关行数为 **0**，即 minimal preset 下没有压缩栈。

---

## 2. 触发条件与阈值常量

### 2.1 `auto`：默认开启的自动触发（两步边界 + 溢出救援）

`node_modules/@deepseek-ai/dsh-compaction-basic/lib/index.js:59-86`（默认值解析）：

<!-- src: D:\Dev\Path\nodejs_25.0.0\npm-cache\_npx\1e7f6d9597241db0\node_modules\@deepseek-ai\dsh-compaction-basic\lib\index.js:59-67 -->
```js
function resolveConfig(config = {}) {
	validateKeys(config, BASIC_COMPACT_CONFIG_KEYS, "BasicCompactionConfig");
	validatePolicy(config, "BasicCompactionConfig");
	if (config.auto !== void 0 && typeof config.auto !== "boolean") throw new Error("BasicCompactionConfig: auto must be a boolean");
	const headroomTokens = config.headroomTokens ?? 65536;
	const maxTokens = config.maxTokens ?? headroomTokens;
	assertPositiveInteger("BasicCompactionConfig.maxTokens (explicit or from headroomTokens)", maxTokens);
	const thresholdRatio = config.thresholdRatio ?? DEFAULT_THRESHOLD_RATIO;
	const retention = resolveRetention(config, { retainRatio: DEFAULT_RETAIN_RATIO });
```

`node_modules/@deepseek-ai/dsh-compaction-basic/lib/index.js:15,17`（两个比例常量）：

<!-- src: D:\Dev\Path\nodejs_25.0.0\npm-cache\_npx\1e7f6d9597241db0\node_modules\@deepseek-ai\dsh-compaction-basic\lib\index.js:15-15 -->
```js
const DEFAULT_THRESHOLD_RATIO = .8;
```

<!-- src: D:\Dev\Path\nodejs_25.0.0\npm-cache\_npx\1e7f6d9597241db0\node_modules\@deepseek-ai\dsh-compaction-basic\lib\index.js:17-17 -->
```js
const DEFAULT_RETAIN_RATIO = .16;
```

`node_modules/@deepseek-ai/dsh-compaction-basic/lib/index.js:82-85`（重试与 auto 缺省）：

<!-- src: D:\Dev\Path\nodejs_25.0.0\npm-cache\_npx\1e7f6d9597241db0\node_modules\@deepseek-ai\dsh-compaction-basic\lib\index.js:82-85 -->
```js
		compactionRetries: config.compactionRetries ?? 1,
		maxOverflowRetries: config.maxOverflowRetries ?? 1,
		modelPolicies,
		auto: config.auto ?? true
```

`node_modules/@deepseek-ai/dsh-compaction-basic/lib/index.js:827,839-855`（自动监听器：step 边界压力量 + idle 复位）：

<!-- src: D:\Dev\Path\nodejs_25.0.0\npm-cache\_npx\1e7f6d9597241db0\node_modules\@deepseek-ai\dsh-compaction-basic\lib\index.js:827-827 -->
```js
		if (this.config.auto) this._registerAutomaticCompaction();
```

<!-- src: D:\Dev\Path\nodejs_25.0.0\npm-cache\_npx\1e7f6d9597241db0\node_modules\@deepseek-ai\dsh-compaction-basic\lib\index.js:834-841 -->
```js
	_registerAutomaticCompaction() {
		const { ctx } = this;
		const logResult = (result, trigger) => {
			ctx.logger.info(`compaction (${trigger}): shadowed ${result.shadowedSeqs.length} surface nodes (seqs ${result.shadowedRange.start}-${result.shadowedRange.end}, ~${result.shadowedTokenCount} tokens)`);
		};
		ctx.on("agent/pre-step", async ({ agent, signal }, next) => {
			if (!signal.aborted) try {
				const result = await this.compactIfNeeded(agent, "pressure", signal);
```

`node_modules/@deepseek-ai/dsh-compaction-basic/lib/index.js:861-868`（第二触发：上下文溢出错误 + 重试上限）：

<!-- src: D:\Dev\Path\nodejs_25.0.0\npm-cache\_npx\1e7f6d9597241db0\node_modules\@deepseek-ai\dsh-compaction-basic\lib\index.js:861-868 -->
```js
		ctx.on("agent/request-error", async ({ agent, failure, signal }, next) => {
			if (failure.code !== CONTEXT_WINDOW_EXCEEDED_CODE || signal.aborted) return next();
			this.overflowAgents.set(agent.session, agent);
			const target = routedTarget(agent.session);
			if (target === void 0) return next();
			const policy = resolveTargetPolicy(this.config, target);
			const retries = this.overflowRetries.get(agent) ?? 0;
			if (retries >= policy.maxOverflowRetries) return next();
```

### 2.2 具体阈值怎么算出来（含本机实际数字）

`node_modules/@deepseek-ai/dsh-compaction-basic/lib/index.js:128-134`：

<!-- src: D:\Dev\Path\nodejs_25.0.0\npm-cache\_npx\1e7f6d9597241db0\node_modules\@deepseek-ai\dsh-compaction-basic\lib\index.js:128-133 -->
```js
	const messageBudgetTokens = contextWindow - reservedCompletionTokens;
	if (messageBudgetTokens <= 0) throw new TargetPressureConfigError(targetKey, `compaction-basic: ${targetKey} reserves ${reservedCompletionTokens} completion tokens of its ${contextWindow}-token context window, leaving no message budget; configure the adapter model's contextWindow above the effective request maxTokens`);
	const pressureBudgetTokens = messageBudgetTokens - policy.headroomTokens;
	if (pressureBudgetTokens <= 0) throw new TargetPressureConfigError(targetKey, `compaction-basic: ${targetKey} reserves ${reservedCompletionTokens} completion tokens and ${policy.headroomTokens} headroom tokens of its ${contextWindow}-token context window, leaving no pressure budget; reduce the effective request maxTokens or compaction headroomTokens, or configure a larger adapter model contextWindow`);
	const thresholdTokens = Math.floor(Math.min(contextWindow * policy.thresholdRatio, pressureBudgetTokens));
	const retainTokens = policy.retainTokens === void 0 ? Math.floor(messageBudgetTokens * policy.retainRatio) : policy.retainTokens;
```

按本机路由（`cordis.patch.yml:23-30`：`provider=cc`、`model=deepseek/deepseek-v4.1-flash`、`contextWindow: 1000000`、`maxTokens: 200000`；会话投影实测 `contextWindow=1000000`）代入上式计算：

- `messageBudgetTokens = 1_000_000 − reservedCompletion`（会话实测 `contextPressure` 的 `pressure − surface = 55,910 ≈ 65536 − 9,626`，与 headroom 一致）
- `pressureBudgetTokens = messageBudget − 65,536 ≈ 803,392`
- `thresholdTokens = floor(min(1_000_000 × 0.8, ≈803,392)) = ≈803,392`
- `retainTokens = floor(messageBudget × 0.16) ≈ 139,000`

即**本机自动压缩要等到约 80 万 token 才会触发**（≈ 窗口的 80%）。

### 2.3 运行态判定：自动触发从未发生（26 次全部是手动 `/compact`）

命令 `node t3-evidence-tools/classify-compactions.mjs 'C:\Users\ZYX\.dsh\sessions'`（读取 zstd 多帧 JSONL，按 `sourceCommandId` 区分手动/自动）结果：

```
TOTALS manualSummaries=26 automaticSummaries=0 failedCompactions=1
shadowedNodes=6706 shadowedTokensSum=5679166
```

- `compaction/summary` 事件带 `sourceCommandId` ⇒ 由 `/compact` 手动触发（§1.4 的 `compactNow(..., invocation.commandId)`）。
- 唯一的失败记录：`--I-A_need-cmdc…/session-5c54badf…` 的 `compaction/end` 带 `error: "400: ... insufficient credits ..."`，即摘要调用额度不足。
- 全部 56 个会话的最大 `contextPressure.pressureTokens` 为 **394,485**（`session-e038b78a-…`），不到 803,392 阈值的一半 ⇒ **自动压缩在本机从未触发**（这是运行态事实，不是推断）。

---

## 3. 会话持久化格式（运行态 + 源码）

### 3.1 真实文件与真实头部

一个会话 = 一个目录，目录内唯一文件：

```
C:\Users\ZYX\.dsh\sessions\--I-VMsShare--\session-6680b4d6-e2c4-4400-a087-754f1238cb5c\session.v4.jsonl.zstd   238744 bytes
```

首 4 字节 = `28 B5 2F FD`（Zstandard 魔数）。用只读脚本分帧解压 `node t3-evidence-tools/read-session.mjs <file>` 得到首行头：

```json
{"type":"session","version":4,"id":"session-6680b4d6-e2c4-4400-a087-754f1238cb5c","createdAt":1791728967519,"cwd":"I:\\VMsShare","isSeeded":false,"delegationDepth":0,"agentPreset":"standard"}
```

同一会话的完整事件类型统计（真实数据）：

```
tool/call=44, tool/result=44, step/start=29, assistant/message=29, step/end=29, user/message=14,
agent/inbox/spliced=13, turn/start=4, turn/end=4, system/message=2, request/header=2, request/context=1, ...
```

### 3.2 源码侧格式契约

`node_modules/@deepseek-ai/dsh-session-persistence-jsonl/lib/types/format.d.ts:12-19`（物理编码与后缀）：

<!-- src: D:\Dev\Path\nodejs_25.0.0\npm-cache\_npx\1e7f6d9597241db0\node_modules\@deepseek-ai\dsh-session-persistence-jsonl\lib\types\format.d.ts:12-19 -->
```ts
/** Physical encoding selected for JSONL session artifacts. */
export type JsonlCompression = 'zstd' | 'none';
/**
 * Return the artifact suffix for one physical encoding.
 * @param compression - configured JSONL artifact encoding.
 * @returns `.jsonl.zstd` for Zstandard or `.jsonl` for plaintext.
 */
export declare function logSuffix(compression: JsonlCompression): '.jsonl.zstd' | '.jsonl';
```

`node_modules/@deepseek-ai/dsh-session-persistence-jsonl/lib/types/format.d.ts:39-53`（头行字段）：

<!-- src: D:\Dev\Path\nodejs_25.0.0\npm-cache\_npx\1e7f6d9597241db0\node_modules\@deepseek-ai\dsh-session-persistence-jsonl\lib\types\format.d.ts:38-53 -->
```ts
/**
 * The current physical header stored as the first JSONL record. The exact
 * inherited cut lives on the last tagged `session/end-seed` event.
 */
interface HeaderLine {
    type: 'session';
    version: number;
    id: SessionId;
    createdAt: number;
    cwd?: string;
    parentSession?: SessionId;
    isSeeded: boolean;
    origin?: 'subagent';
    delegationDepth: number;
    agentPreset?: string;
}
```

`node_modules/@deepseek-ai/dsh-session-persistence-jsonl/lib/types/zstd.d.ts:1-6,30-40`（**多帧容器**：追加式写入，逐帧独立可解）：

```ts
/**
 * Zstandard frame primitives for the JSONL persistence backend. The backend
 * owns a concatenated-frame container so it can append and recover batches
 * without exposing compression mechanics through the persistence seam.
 * @module @deepseek-ai/dsh-session-persistence-jsonl/zstd
 */
```

<!-- src: D:\Dev\Path\nodejs_25.0.0\npm-cache\_npx\1e7f6d9597241db0\node_modules\@deepseek-ai\dsh-session-persistence-jsonl\lib\types\zstd.d.ts:29-34 -->
```ts
/**
 * Compress one independently decodable, checksummed Zstandard frame.
 * @param input - JSONL bytes for a header or durable event batch.
 * @returns the complete encoded frame.
 */
export declare function compressZstdFrame(input: Buffer | string): Promise<Buffer>;
```

本机实测：单个会话文件包含 **114 个完整 zstd 帧 → 229 条 JSONL 记录**（`read-session.mjs` 输出），印证"每批一个帧"的追加模型。

### 3.3 压缩是**在文件之上改写表面**，还是重写文件？

不是截断文件，而是向日志**追加**新的 `tool/result` 事件并声明 surface 替换（§4.2）。会话文件只增不减，历史可回放。

---

## 4. 工具输出截断策略（两条独立机制 + 一条工具自身截断）

### 4.1 `spill-policy` — 按 **token** 预算把超大工具结果**外置到文件**

`@deepseek-ai/dsh-base/cordis.patch.yml:404-410`（本机唯一显式预算）：

<!-- src: D:\Dev\Path\nodejs_25.0.0\npm-cache\_npx\1e7f6d9597241db0\node_modules\@deepseek-ai\dsh-base\cordis.patch.yml:404-410 -->
```yaml
- id: spill-local
  name: '@deepseek-ai/dsh-spill-local'
- id: spill-policy
  name: '@deepseek-ai/dsh-spill-policy'
  config:
    maxInlineTokens: 12500
```

`node_modules/@deepseek-ai/dsh-spill-policy/lib/index.js:184-199`（超预算即落盘，再只保留头尾）：

<!-- src: D:\Dev\Path\nodejs_25.0.0\npm-cache\_npx\1e7f6d9597241db0\node_modules\@deepseek-ai\dsh-spill-policy\lib\index.js:183-199 -->
```js
			const price = pricing(exec, images);
			if (content.reduce((total, block) => total + price(block), 0) <= maxTokens) return void 0;
			const owner = exec.agent?.session.header.id;
			if (owner === void 0) throw new Error(`no session owner for ${toolName} ${label}`);
			const spillStore = ctx.get("spillStore");
			if (spillStore === void 0) throw new Error("no ctx.spillStore backend loaded");
			const ref = await spillStore.saveText({
				owner: { sessionId: owner },
				source: {
					kind: "tool",
					toolName,
					callId,
					label
				},
				suggestedName: `${toolName}.txt`,
				content: fullText(content)
			});
```

`node_modules/@deepseek-ai/dsh-spill-policy/lib/index.js:216-224`（模型看到的替代形态：head + GAP + tail + notice）：

<!-- src: D:\Dev\Path\nodejs_25.0.0\npm-cache\_npx\1e7f6d9597241db0\node_modules\@deepseek-ai\dsh-spill-policy\lib\index.js:216-224 -->
```js
			const result = retained.head.length + retained.tail.length === 0 ? [footer] : [
				...retained.head,
				GAP,
				...retained.tail,
				{
					type: "text",
					text: `\n\n${footer.text}`
				}
			];
```

`node_modules/@deepseek-ai/dsh-spill-policy/lib/index.js:24-27`（notice 文案，含取回指引）：

<!-- src: D:\Dev\Path\nodejs_25.0.0\npm-cache\_npx\1e7f6d9597241db0\node_modules\@deepseek-ai\dsh-spill-policy\lib\index.js:24-27 -->
```js
function formatSpillNotice(omitted, ref, images = 0) {
	const imageNotice = images > 0 ? ` Omitted ${images} images.` : "";
	return `${OPEN}${describeOmitted(omitted, "bytes")}${imageNotice}${LOCATION}${ref.locator}${GUIDANCE_SEPARATOR}${ref.retrievalHint}${CLOSE}`;
}
```

`node_modules/@deepseek-ai/dsh-spill-policy/lib/index.js:237-242`（作用范围：**除 `read` 外**的所有工具结果与 PTC 派发日志）：

<!-- src: D:\Dev\Path\nodejs_25.0.0\npm-cache\_npx\1e7f6d9597241db0\node_modules\@deepseek-ai\dsh-spill-policy\lib\index.js:237-242 -->
```js
	ctx.on("tools/post-execute", async (exec, result, next) => {
		const decision = await next();
		if (decision.kind !== "accept" || Object.hasOwn(decision, "value") || exec.name === "read") return decision;
		const content = decision.content ?? result.content;
		const hasImages = content.some((block) => block.type === "image");
		if (exec.parent !== void 0 && !hasImages) return decision;
```

落盘位置与保留期（`node_modules/@deepseek-ai/dsh-spill-local/lib/types/index.d.ts:21-39`）：

<!-- src: D:\Dev\Path\nodejs_25.0.0\npm-cache\_npx\1e7f6d9597241db0\node_modules\@deepseek-ai\dsh-spill-local\lib\types\index.d.ts:21-39 -->
```ts
export interface Config {
    /**
     * Root directory for spill files. Omitted uses a lazily-created private
     * (0700) per-process directory under the OS temp dir — the safe default for
     * a local deployment. Set it to keep spill files under a known location.
     */
    root?: string;
    /**
     * Age in days after which a spill file is eligible for the one-shot startup
     * cleanup sweep. Defaults to `30`; `0` disables cleanup entirely. Files whose
     * `mtime` is strictly older than the cutoff are deleted and emptied
     * directories are pruned; fresh files, symlinks, and unrelated entries are
     * left untouched. On POSIX, cleanup skips roots and session directories that
     * another local user could modify or replace. Retention is deliberate — a
     * resumed or forked session may still reference an older locator until it
     * ages out.
     */
    cleanupPeriodDays?: number;
}
```

**运行态实证**（真实会话日志 `session-5c54badf…` 的 `tool/result` seq=965，字符数 49,930）：

```
(Omitted 14430 bytes. Full formatted result stored at: C:\Users\ZYX\AppData\Local\Temp\dsh-spill-r4jv3f\session-51e85b101f70\19c38177f6a1-pwsh.txt. Use read with offset/limit, or grep this path to search within it.)
```

统计（命令 `node t3-evidence-tools/scan-real-artifacts.mjs 'C:\Users\ZYX\.dsh\sessions'`）：**56 个会话中 62 条 spill notice**，另 18 处工具自身的 `[output truncated; full output: …\Temp\dsh-subprocess-…-stdout.log]`。

### 4.2 `compaction-tool-result-pruner` — 按 **code point** 裁剪中间段（head/middle/tail）

`node_modules/@deepseek-ai/dsh-compaction-tool-result-pruner/lib/index.js:7-14`：

<!-- src: D:\Dev\Path\nodejs_25.0.0\npm-cache\_npx\1e7f6d9597241db0\node_modules\@deepseek-ai\dsh-compaction-tool-result-pruner\lib\index.js:7-14 -->
```js
/** Fixed marker substituted for every removed middle span. */
const PRUNE_MARKER = "\n\n[... tool result middle pruned ...]\n\n";
/** Low-friction defaults for coding-agent tool output. */
const DEFAULTS = deepFreeze({
	thresholdChars: 8192,
	headChars: 4096,
	tailChars: 1024
});
```

`node_modules/@deepseek-ai/dsh-compaction-tool-result-pruner/lib/index.js:91-95`（触发条件 = 全文 code point 数 > 阈值；按 Unicode code point 切，不会劈开代理对）：

<!-- src: D:\Dev\Path\nodejs_25.0.0\npm-cache\_npx\1e7f6d9597241db0\node_modules\@deepseek-ai\dsh-compaction-tool-result-pruner\lib\index.js:91-95 -->
```js
	pruneContent(blocks) {
		const totalChars = this.measureContent(blocks);
		if (totalChars <= this.config.thresholdChars) return null;
		const removedStart = this.config.headChars;
		const removedEnd = totalChars - this.config.tailChars;
```

`node_modules/@deepseek-ai/dsh-compaction-tool-result-pruner/lib/index.js:137-146`（只作用于当前 surface 上的 `tool/result`）：

<!-- src: D:\Dev\Path\nodejs_25.0.0\npm-cache\_npx\1e7f6d9597241db0\node_modules\@deepseek-ai\dsh-compaction-tool-result-pruner\lib\index.js:137-146 -->
```js
	pruneSession(session) {
		const candidates = [];
		for (const seq of [...session.surface.nodes]) {
			const event = session.eventAt(seq);
			/* v8 ignore next -- surface seqs are validated contiguous log references. */
			if (event?.type === "tool/result") candidates.push({
				seq,
				event
			});
		}
```

`node_modules/@deepseek-ai/dsh-compaction-tool-result-pruner/lib/index.js:159-177`（**追加而非修改**：先写定价事件 `compaction/prune`，再追加替换事件并声明 surfaceOp=replace）：

<!-- src: D:\Dev\Path\nodejs_25.0.0\npm-cache\_npx\1e7f6d9597241db0\node_modules\@deepseek-ai\dsh-compaction-tool-result-pruner\lib\index.js:159-177 -->
```js
			session.append("compaction/prune", {
				shadowedRange: {
					start: seq,
					end: seq
				},
				shadowedSeqs: [seq],
				shadowedTokenCount: this.ctx.tokenMeter.estimateMessage(original)
			});
			const replacement = session.append("tool/result", {
				...event.data,
				message
			}, {
				surfaceOp: {
					op: "replace",
					startSeq: seq,
					endSeq: seq
				},
				sourceEventSeqs: [seq]
			});
```

**它与压缩的耦合**：只有当 `compactIfNeeded` 准备压缩时才先跑 pruner，然后**重新测量**，若已降到阈值以下就直接返回、不做 LLM 摘要。

`node_modules/@deepseek-ai/dsh-compaction-basic/lib/index.js:941-946`：

<!-- src: D:\Dev\Path\nodejs_25.0.0\npm-cache\_npx\1e7f6d9597241db0\node_modules\@deepseek-ai\dsh-compaction-basic\lib\index.js:941-946 -->
```js
		if (measurement.totalTokens < spec.thresholdTokens) return null;
		if (prune !== void 0) {
			prune.pruneSession(agent.session);
			measurement = meter.measure(agent.session);
		}
		if (measurement.totalTokens < spec.thresholdTokens) return null;
```

溢出路径同样先裁后压：`node_modules/@deepseek-ai/dsh-compaction-basic/lib/index.js:927-934`：

<!-- src: D:\Dev\Path\nodejs_25.0.0\npm-cache\_npx\1e7f6d9597241db0\node_modules\@deepseek-ai\dsh-compaction-basic\lib\index.js:927-932 -->
```js
		if (trigger === "context-overflow") {
			if (prune !== void 0) {
				prune.pruneSession(agent.session);
				measurement = meter.measure(agent.session);
			}
			const range = selectCompactableRange(agent.session, measurement, 0);
```

**运行态判定（UNVERIFIED→已收敛）**：56 个会话中，**未观测到一次真实的 pruner 触发**。初版扫描报出的 2 处命中经逐字符核对为**我自己的输出引用了 pruner 源码里的 `PRUNE_MARKER` 常量字面量**（命中上下文 `prev:"n" next:"\\"`，即 `"...pruned ...]"\n` 的定义行），不是裁剪产物。即：本机数据里 pruner 的**独立证据缺失**，其存在与规则由源码契约证明（§4.2），运行态未触发。

### 4.3 三层截断的预算对照表

| 机制 | 度量单位 | 阈值 | 保留策略 | 触发方式 | 依据 |
|---|---|---|---|---|---|
| spill-policy | token（模型路由计价） | `maxInlineTokens: 12500` | head + `\n\n[...]\n\n` + tail，各占一半预算，末尾附 omitted bytes + 文件路径 | 每次工具执行后（`read` 除外） | `@deepseek-ai/dsh-base/cordis.patch.yml:407-410`；spill-policy `index.js:184-224` |
| tool-result-pruner | Unicode code point | `thresholdChars: 8192` | head 4096 + 标记 + tail 1024 | 压力量/溢出压缩**之前**一步 | `@deepseek-ai/dsh-base/cordis.patch.yml:418-423`；pruner `index.js:7-14,91-95` |
| compaction-basic | token（token-meter 估算） | ≈803,392（本机） | 保留最近 `retainRatio 0.16`（≈139k），旧段被摘要替换 | `agent/pre-step`（pressure）/ 请求溢出 | `index.js:15,63,128-134,839` |

---

## 5. 子代理上下文继承边界（harness 核心）

### 5.1 fork provider：继承"已完成轮次"前缀，**不含进行中的轮次**，且是一次性快照

`node_modules/@deepseek-ai/dsh-subagent-fork-in-process/lib/index.js:4-11`：

<!-- src: D:\Dev\Path\nodejs_25.0.0\npm-cache\_npx\1e7f6d9597241db0\node_modules\@deepseek-ai\dsh-subagent-fork-in-process\lib\index.js:4-11 -->
```js
/**
* The in-process FORK subagent backend: registers a {@link SubagentProvider} on
* `ctx.subagents` that runs each child as a child {@link Agent} SEEDED with a prefix of the
* parent's session log — so the child inherits the parent's conversation context instead of
* starting fresh. The seed ends at the last `turn/end`: the current tool-call turn is
* unbalanced and cannot be replayed as a valid child session.
* @module @deepseek-ai/dsh-subagent-fork-in-process
*/
```

`node_modules/@deepseek-ai/dsh-subagent-fork-in-process/lib/index.js:23-28`（边界算法，只有 3 行）：

<!-- src: D:\Dev\Path\nodejs_25.0.0\npm-cache\_npx\1e7f6d9597241db0\node_modules\@deepseek-ai\dsh-subagent-fork-in-process\lib\index.js:23-28 -->
```js
function completedTurnPrefix(parent) {
	const events = parent.session.snapshotEvents();
	const lastEnd = events.findLast((e) => e.type === "turn/end");
	if (lastEnd === void 0) return [];
	return events.slice(0, lastEnd.seq + 1);
}
```

`node_modules/@deepseek-ai/dsh-subagent-fork-in-process/lib/index.js:44,49-55`（能力声明 + 一次性捕获）：

<!-- src: D:\Dev\Path\nodejs_25.0.0\npm-cache\_npx\1e7f6d9597241db0\node_modules\@deepseek-ai\dsh-subagent-fork-in-process\lib\index.js:44-44 -->
```js
	inheritsParentContext = true;
```

<!-- src: D:\Dev\Path\nodejs_25.0.0\npm-cache\_npx\1e7f6d9597241db0\node_modules\@deepseek-ai\dsh-subagent-fork-in-process\lib\index.js:48-55 -->
```js
	start(request) {
		const seed = completedTurnPrefix(request.parent);
		return startInProcessRun(request, { ...seed.length > 0 ? { seed } : {} });
	}
	prepareContinuable(request) {
		const seed = completedTurnPrefix(request.parent);
		return Promise.resolve(seed.length > 0 ? { seed } : {});
	}
```

### 5.2 spawn provider：**明确不继承**父上下文

`node_modules/@deepseek-ai/dsh-subagent-spawn-in-process/lib/index.js:30`：

<!-- src: D:\Dev\Path\nodejs_25.0.0\npm-cache\_npx\1e7f6d9597241db0\node_modules\@deepseek-ai\dsh-subagent-spawn-in-process\lib\index.js:30-30 -->
```js
	inheritsParentContext = false;
```

该标志的语义（普通能力声明，不是校验项）见 `node_modules/@deepseek-ai/dsh-subagent/lib/types/types.d.ts:332-337`：

<!-- src: D:\Dev\Path\nodejs_25.0.0\npm-cache\_npx\1e7f6d9597241db0\node_modules\@deepseek-ai\dsh-subagent\lib\types\types.d.ts:332-337 -->
```ts
    /**
     * Whether the child sees the parent's completed-turn prefix. This is descriptive, not a
     * service-validated start capability: the model-facing tool derives truthful wording from it.
     * It says nothing about tool registration, injected services, or authority inheritance.
     */
    readonly inheritsParentContext: boolean;
```

### 5.3 **dsh-agent-teams 用 spawn（profile 显式指定），不是 fork** ⇒ 成员零继承

`【插件】` 的配置与 Schema 默认：`I:\VMsShare\_src-compare\dsh-agent-teams\src\index.ts:133` 是 Schema 默认（`memberProvider: z.string().default('spawn')`），`:196` 是运行时回退表达式（`memberProvider: config.memberProvider ?? 'spawn'`）。

**本机实际解析为 spawn 的依据是「插件包自带 patch 层显式写入 `memberProvider`」，而不是"走了运行时回退"**：`@nanmicoder/dsh-agent-teams/cordis.patch.yml:19-21`：

<!-- src: C:\Users\ZYX\.dsh\profiles\web\node_modules\@nanmicoder\dsh-agent-teams\cordis.patch.yml:19-21 -->
```yaml
    stateDir: .agent-teams
    memberProvider: spawn
```

⇒ 本机是**显式选择** spawn（可改为 `fork`），不是"未覆盖默认"。

**运行态确证**（对本机 5 个 AgentTeams 成员会话解头）：

```
21b70605-… | 115190 | depth=1 | seeded=false | origin=subagent | parent=session-0423cee6-… | preset=standard
5555841f-… | 834133 | depth=1 | seeded=false | origin=subagent | parent=session-6680b4d6-… | preset=standard
a3554bee-… | 368350 | depth=1 | seeded=false | origin=subagent | parent=session-6680b4d6-… | preset=standard
aecac4e1-… | 142531 | depth=1 | seeded=false | origin=subagent | parent=session-0423cee6-… | preset=standard
e753b90e-… | 102405 | depth=1 | seeded=false | origin=subagent | parent=session-0423cee6-… | preset=standard
```

（命令 `node t3-evidence-tools/survey-session-headers.mjs 'C:\Users\ZYX\.dsh\sessions\--I-VMsShare--'`）

→ **`seeded=false` 且 `delegationDepth=1`**：成员既不是 fork 种子，也不继承 captain 的对话；它只拿【插件】注入的 persona + 派发提示（t2 §2.1）。继承边界 = **无继承**。

同时，`session/end-seed` 事件是"继承切点"的持久标记（`format.d.ts:39-40`：*The exact inherited cut lives on the last tagged `session/end-seed` event*）；member 会话中该事件数量与是否 seeded 一致。

---

## 6. 成员 durable session 与压缩栈的交互（有无按成员区分的预算？）

### 6.1 结论：**同一套策略、无成员专属预算、无血缘分流**

`node_modules/@deepseek-ai/dsh-compaction-basic/lib/index.js` 全文对 `origin` / `delegationDepth` / `parentSession` / `subagent` 的检索命中为 **0**（仅有两处 `origin` 相关词出现在摘要提示词文本与日志文案里）：

```
$ Select-String -Path ...\dsh-compaction-basic\lib\index.js -Pattern 'origin|delegationDepth|parentSession|subagent'
249: "- [the user's original and evolving goals; quote verbatim where the exact wording matters]",
880: ctx.logger.warn(`context-overflow compaction failed: ...`);
```

自动监听器（`index.js:839`）对 `agent/pre-step` 的每个 agent 生效，不区分父/子。

**运行态确证**：5 个成员会话的头部 `agentPreset=standard`（= captain 同一 preset），因此它们加载同一套 compaction 组；成员会话同样产生 spill notice（例如 `aecac4e1-…`、`5555841f-…` 均在 §4.1 的统计内）。成员 `5555841f-…` 当前 `pressure=348,245 / surface=280,941 / nodes=483`，仍**远低于** ≈803,392 的自动压缩阈值——即它承接了同一份"未压缩"风险，而没有按成员收紧的预算。

### 6.2 成员"被唤醒"时的上下文装配

- **【插件】** 只投递一条新 turn（queue=独立 FIFO turn / steer=最近 step 边界），不重写历史（t2 §2.1、§5.1）。
- **【harness 核心】** 该 turn 进入成员**同一个 durable session**，请求由当前 surface 装配；surface 是可被压缩栈改写的投影，而非原始事件流。
- **【宿主压缩栈】** 在 `agent/pre-step` 阶段对任何 agent（含成员）做压力检查（`index.js:839`）。

⇒ 成员请求的上下文 = 自身 session 的全部事件，经 surface 投影（含 spill / pruner / 摘要替换）后的结果；**captain 与成员各有一份独立预算，但预算公式与阈值相同**（按各自路由的 `contextWindow` 与 `maxTokens` 计算，`index.js:128-134`）。

---

## 7. 压缩发生时到底改了什么（运行态 + 源码）

### 7.1 摘要提示词与检查点外壳

`node_modules/@deepseek-ai/dsh-compaction-basic/lib/index.js:243-247`（固定章节结构）：

<!-- src: D:\Dev\Path\nodejs_25.0.0\npm-cache\_npx\1e7f6d9597241db0\node_modules\@deepseek-ai\dsh-compaction-basic\lib\index.js:243-248 -->
```js
const COMPACTION_INSTRUCTION = [
	"You are now acting as a compaction engine for this AI coding assistant. Condense the conversation ABOVE into a structured checkpoint that lets another model resume the work with no loss of essential context.",
	"",
	"Output EXACTLY the Markdown structure below: keep every section, in order. Use terse bullets, not prose paragraphs. Write \"(none)\" for an empty section — never drop a section.",
	"",
	"## Primary Request and Intent",
```

`node_modules/@deepseek-ai/dsh-compaction-basic/lib/index.js:280`（替换用户消息的外壳）：

<!-- src: D:\Dev\Path\nodejs_25.0.0\npm-cache\_npx\1e7f6d9597241db0\node_modules\@deepseek-ai\dsh-compaction-basic\lib\index.js:280-280 -->
```js
const CHECKPOINT_PREAMBLE = "This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. Treat the captured context as established background and build on it without restating it. Continue the task directly from the messages that follow, without acknowledging this checkpoint.";
```

摘要复用 KV 前缀的动机：`node_modules/@deepseek-ai/dsh-compaction-basic/lib/types/summarizer.d.ts:14-19`：

<!-- src: D:\Dev\Path\nodejs_25.0.0\npm-cache\_npx\1e7f6d9597241db0\node_modules\@deepseek-ai\dsh-compaction-basic\lib\types\summarizer.d.ts:14-19 -->
```ts
/**
 * The replayed conversation surface the summarizer condenses. Reproducing the
 * last routed request's system prompt, tools, and leading messages verbatim
 * lets the auxiliary call reuse the provider's warm prefix cache; the trailing
 * compaction instruction is then the only novel input.
 */
```

### 7.2 一次真实压缩的完整事件序列（会话 `session-5c54badf-…`）

`node t3-evidence-tools/inspect-compaction.mjs <file>` 输出节选：

```
seq=1268 compaction/start   data={compactionId, sourceCommandId:"cmd-f44ad741-1", turn:null}
seq=1270 compaction/summary data={compactionId, sourceCommandId, summary, rawOutput, llmStreamCall,
                                  shadowedRange, shadowedSeqs, shadowedTokenCount, provider, model, maxTokens, usage}
seq=1272 compaction/end     data={compactionId, sourceCommandId, turn:null}
```

摘要正文以 `<compacted-summary>` 开标签开头（`summary[0].text`），随后由 §7.1 的 `CHECKPOINT_PREAMBLE` 包成一条 `user/message` 落在原区间位置：

```
seq=1271 type=user/message
"This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. …\n\n<compacted-summary>"
```

失败也有持久记录（同会话 seq=2689-2690）：

```
seq=2690 compaction/end data={..., "error":"400: {\"message\":\"You have insufficient credits …\",\"code\":\"BAD_REQUEST\"}"}
```

### 7.3 关键限制（写进报告的诚实边界）

- `compaction/summary` 里**没有"压缩前 token 数"字段**；能拿到的量化只有 `shadowedTokenCount` 与 `shadowedSeqs.length`（本机 26 次合计 6,706 个 surface 节点、5,679,166 tokens 被遮蔽）。
- 因此"压缩后压力降到多少"在**本机可用数据里无法直接给出**：投影缓存只保留最新值（`contextPressure` 为 last-write），历史值不落盘。**UNVERIFIED**。

---

## 8. 与 Codex 对应机制的初步标注（哪些 Codex 有 / DSH 有或不同）

> 说明：Codex 侧结论引自本团队 t1 取证与视频报告口径，此处只做维度级标注，不做实现细节断言。

| 维度 | Codex（据 t1/视频报告） | DSH（本报告，运行态+源码） | 差异标注 |
|---|---|---|---|
| 截断（确定性、无模型） | 有：工具输出截断 | **有，且有两层**：spill-policy 按 token 外置（12500）+ pruner 按字符裁中间（8192/4096/1024） | **DSH 多一层"外置文件 + 可检索路径"**；Codex 以截断为主 |
| 摘要式压缩 | 有：自动摘要 | **有**：`compaction-basic`，阈值 ≈80% 窗口，保留 16%，摘要复用 KV 前缀 | 机制同类；DSH 的阈值**按路由模型 contextWindow 动态算**（`index.js:128-134`） |
| 自动触发 | 有（阈值触发） | **有，但本机从未触发**：56 会话最大 pressure 394,485 vs 阈值 ≈803,392；26 次压缩全部手动 `/compact` | **运行态差异显著**：DSH 自动压缩在本机实质休眠，实际靠人工 `/compact` |
| 手动压缩入口 | 有（/compact 类命令） | **有**：`command-compact` 注册 `compact` 命令（`index.js:93-98`） | 同类 |
| 会话持久化 | 有（rollout/JSONL 类） | **有**：`session.v4.jsonl.zstd`，多 zstd 帧追加，文件只增不改 | DSH 为**帧级追加 + 压缩**，且压缩是"追加替换事件"而非重写文件 |
| 子代理继承 | 子代理上下文隔离为主 | **两个 provider 明确二分**：`fork`=真继承（到最后一个 `turn/end`，一次性快照），`spawn`=不继承 | **DSH 把"继承/不继承"变成 provider 选择**；本机以 bundle 方式装载 agent-teams 插件，该插件自带 patch 层**显式写入** `memberProvider: spawn`（`@nanmicoder/dsh-agent-teams/cordis.patch.yml:21`）⇒ 本机成员零继承（是显式选择，非依赖默认值） |
| 按成员/子代理区分预算 | **无按角色分档**：`AgentRoleOverrides` 无任何上下文/压缩字段；另有子代理共享配置闸门（`child_config.rs:135-145` 的 `SubagentDefaultContextLimits`，默认关闭）——细节见 `t4-mechanism-matrix.md` §5 附录 | **没有**：压缩栈无 origin/depth 过滤，成员与 captain 共用同一策略与公式 | 两者都**没有**按成员分档；**DSH 侧连 agent 维度都不感知**（零 `delegationDepth/parentSession/origin/subagent` 命中），这点是当前最清晰的空白点 |
| 上下文外置可检索 | 有（工具结果落盘/读回） | **有**：spill 文件 0700 root、30 天清理、notice 给出路径与 read/grep 指引 | 同类，DSH 保留了检索指引 |

---

## 9. UNVERIFIED 清单（含检索位置，不用实验版团队填空）

1. **pruner 的真实触发实例**：56 个会话日志中未找到非自引用的 `[... tool result middle pruned ...]`。检索位置：`C:\Users\ZYX\.dsh\sessions\**\session.v4.jsonl.zstd`（命令 `scan-real-artifacts.mjs`）。其存在与规则由源码契约证明。
2. **压缩前后压力对比**：`contextPressure` 投影只保留最新值，`compaction/summary` 无压缩前 token 字段。检索位置：`storages\session_projcache\sessions\*.json`、各会话 `compaction/*` 事件。
3. **本机是否曾发生 context-overflow 救援**：`agent/request-error` 不落盘为独立事件，日志中未找到可判定证据。检索位置：`C:\Users\ZYX\.dsh\logs\`（仅 1 个文件）。
4. **image-offload（`dsh-compaction-image-offload`）行为**：本机已装载（`@deepseek-ai/dsh-base/cordis.patch.yml:427-428`），但本次证据中未观测到图片卸载实例；未取证其阈值。

---

## 10. 复核命令

```text
# 1) 只读解帧读取任一真实会话（不修改任何文件）
node t3-evidence-tools/read-session.mjs 'C:\Users\ZYX\.dsh\sessions\--I-VMsShare--\session-6680b4d6-e2c4-4400-a087-754f1238cb5c\session.v4.jsonl.zstd' 3

# 2) 会话头部与子代理继承边界
node t3-evidence-tools/survey-session-headers.mjs 'C:\Users\ZYX\.dsh\sessions\--I-VMsShare--'

# 3) 全量扫描：手动/自动压缩分类 + 真实截断产物
node t3-evidence-tools/classify-compactions.mjs 'C:\Users\ZYX\.dsh\sessions'
node t3-evidence-tools/scan-real-artifacts.mjs 'C:\Users\ZYX\.dsh\sessions'

# 4) 上下文压力排行（含 AgentTeams 成员会话）
node t3-evidence-tools/survey-pressure.mjs 'C:\Users\ZYX\.dsh\storages\session_projcache\sessions'
```
