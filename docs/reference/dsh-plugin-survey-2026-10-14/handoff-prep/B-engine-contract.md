# B. compaction 引擎的 summarize() 契约与补丁安全性（compaction-basic 0.2.0-rc.2）

日期：2026-10-15。路径缩写：
- CB = `/workspace/work/pk/deepseek-ai-dsh-compaction-basic-0.2.0-rc.2/package/lib`
- NM = `Todo56565_make-the-plugin/node_modules/@deepseek-ai`
- MZ = `/workspace/work/MimicHunterZ_dsh-agent-compact`（commit cd87ba6）

## 1. summarize 契约

- **签名**：`summarize(input, agent, signal?)`，三个位置参数（CB/index.js:899；CB/types/index.d.ts:49）。
  - 没有 region 参数，也没有 measurement 参数。
  - 类型上是 `protected`，在 TS 里调用要强转。
  - 引擎内部经 `this.summarize` 动态派发（index.js:1016），所以对实例打的补丁会生效。
- **input**：`{ tools?, messages }`。messages 是可选的 system 头，加上由被压缩区间派生出的消息（index.js:695-704；summarizer.d.ts:103-108）。
- **返回 `SummaryResult`**（summarizer.d.ts:110-127）：
  - 必填：`summary: ContentBlock[]`、`provider`、`model`。
  - 可选：`maxTokens`、`usage`、`rawOutput`。
  - `llmStreamCall` 只用于 LLM 分支；非 LLM 分支应当省略。
- **落盘流程**：
  1. `summary` 经 `frameSummary` 包上前言和 `<compacted-summary>` 标签，再由 `createUserMessage` 生成检查点 user 消息（index.js:596-599、344-356）。
  2. **尺寸不变量**：包装后的 token 数必须严格小于被遮蔽的 route tokens，否则抛错（index.js:600-601）。
  3. `compaction/summary` 事件写入 summary、provider、model、maxTokens、usage、rawOutput；只有 `llmStreamCall===true` 时才写这一项（index.js:629-649）。
  4. 随后追加 `user/message`，带 surfaceOp replace（index.js:650-661）。
- **抛错时**：
  - signal 已中止：直接抛出。
  - 其他情况：先 `assertStable`，再走 `compaction/summary-error` waterfall（index.js:1017-1022，默认返回 false）。只有监听器返回 true 才会重新准备并重试；目前只有 image-offload 会这样做。其余情况不重试（index.js:586-594）。
  - 失败时追加 `compaction/end{error}` 并释放锁。如果连 end 也追加失败，会留下孤立的 start，锁一直不释放（index.js:487-506）。
  - 自动路径的 pre-step 只打 warn，然后继续（:839-851）；overflow 路径保留原错误（:871-881）。

## 2. 模板返回值的最小安全形态

- 返回 `{ summary: [{ type: 'text', text }], provider: '<自定义>', model: '<自定义>' }`，不带 `usage`、`llmStreamCall`、`maxTokens: 0`。
- token-meter 只消费 `assistant/message` 上的 usage，不读 summary 事件（NM/dsh-token-meter/lib/index.js:389-392、303-312）。
- invariant 只校验 id、seqs、shadowedTokenCount（NM/dsh-compaction/lib/invariant.js:128-145）。
- 先例：hoyyang 版返回 `{ summary, provider: 'rollover-template', model: 'none' }`（hoyyang_dsh-smart-compact/src/rollover.ts:376-423）。

## 3. 对实例打补丁的安全性

- `serviceFor` 返回 store 里的原始实例 `impl.value`；只要所在 fiber 存活，就是同一个对象（preset-registry/lib/index.js:177-188、731-733）。
- 同一 preset generation 下的所有 agent 共享这一个实例（mountPreset :262-285；bind/join :661-687）。因此只能在包装函数内部按 `agent.session.id` 或 agent 对象区分。
- `ctx.get` 每次返回一个新的 traceable Proxy（cordis lib/index.js:84-90、123-161）：
  - 往 Proxy 上赋值，最终落成原始实例的 own 属性；`delete` 这个 own 属性就能还原到原型方法（已在 Node 里实测）。
  - 不能用 Proxy 作 WeakMap 键，要用 symbol 标记打在原始实例上。
- 以下情况会换成新实例，补丁要在使用时懒检查、按需重打：
  - preset 重新注册或 generation 换代（:500-545、569-573）；
  - compaction 行的配置变化；
  - HMR。
- 与其他插件（如 MimicHunterZ）共存：链式包装，即保存打补丁前的 `summarize`；还原前先确认自己仍在链顶，不在链顶就不要删除。
- 附带发现：引擎的 `config` 经过 deepFreeze（index.js:75），社区里直接改 `config.thresholdRatio` 的做法在 rc.2 下存疑。

## 4. MimicHunterZ/dsh-agent-compact 的做法

出处：MZ/src/optimizer.ts:43-71；src/index.ts:139-153、335-366。

- **取引擎**：`resolveService` 先 `ctx.get`，取不到再用 `agentPresets.serviceFor`。
- **打补丁**：`patchEngine` 用 `PATCH_VERSION=3` 守卫，bind 原函数后替换成 own 属性。
- **使用与回退**：以 `_externalSummary[sessionId]` 一次性消费。命中时返回 `{ summary: [text], rawOutput: [], llmStreamCall: false, provider: 'agent', model: 'agent', maxTokens: 0 }`；未命中时回退到原函数。
- **问题**：
  - 没有还原或卸载逻辑；
  - `llmStreamCall: false` 违反类型；
  - 读 usage 用的 `session.events` 已被删除（index.ts:221-236）。
- **摘要内容**：由 agent 自己写，章节格式见 index.ts:295。
- 另见 `docs/research/context-compare/community-plugins-survey.md:115、:176`，与上述结论一致。

## 5. 可作模板素材的内容

- `input.messages`：system 头，被压缩区间内的 user、assistant（含 tool-call 块）、tool/result，以及之前的 `<compacted-summary>` 检查点。
- `input.tools`。
- `agent.session`：`requestHeader()`、`surface`、`deriveEventMessage`、`toolHistory()`、`id`。
- `agent.options`：provider、model。
- 拿不到的：被压缩的 seq 范围和 measurement。
