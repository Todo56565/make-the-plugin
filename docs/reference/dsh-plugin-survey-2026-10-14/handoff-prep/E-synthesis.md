# E. 交接模板：多方对照与待定决策（写入设计 §7-10 之前的准备）

日期：2026-10-15。依据 A（smart-compact）、B（引擎契约，含 MimicHunterZ）、C（Codex / Claude Code）、D（本插件可得数据）。
现状：设计文档 §7-10 仍是旧结论（v1 不拦截、拦截点为 `llm/stream`，见设计:413、:426-430）。方案只写在 `04-handoff-design.md`。04 §4 草案有 13 处与实际数据对不上（D §3）。

## 1. 四方对照

| 维度 | smart-compact（hoyyang 0.5.3） | Codex | Claude Code | 04 草案 |
|---|---|---|---|---|
| 接入点 | 子类覆写 `summarize()` | 引擎内建，`new_context` 工具 | 引擎内建，有 PreCompact / PostCompact 钩子 | 对 `serviceFor` 实例打补丁 |
| 交接正文 | 只有指引，不含笔记正文 | 不带摘要，靠 notes 加 thread_hint（≤4KB） | Session Memory：**笔记正文本身就是摘要**（≤12k） | 指引加元数据 |
| 新鲜度 | 写入后事件数 >0 即过期，没有容差（几乎总判过期） | 不判；靠 6144 token 提醒和 16384 token 缓冲迫使先写笔记 | 笔记为空、只有模板、锚点丢失或压缩后仍超阈值时，退回 LLM | 事件数 ≤ 阈值；数据源已弃用 |
| 回退 | 没有，只降级措辞 | 普通 compact 摘要 | LLM 九段摘要 | LLM 摘要 |
| 身份块 | 窗口号 | Agent name、窗口 id | 身份重注入（教学仓库） | 成员、团队、任务、attempt |
| 原话保留 | 无 | 用户消息 ≤20k | 用户原话逐字、授权连同范围 | 无 |

## 2. 硬约束（源码已确认，B 与 D）

1. **签名**：`summarize(input, agent, signal?)`。最小返回 `{ summary: [{ type: 'text', text }], provider: 'team-handoff', model: 'none' }`，不带 usage 和 llmStreamCall。
2. **尺寸不变量**：包装后的检查点必须严格小于被遮蔽的 token 数，校验发生在 summarize **返回之后**，失败就消耗掉本窗口的 45% 尝试机会。钩子内必须先用 `tokenMeter.estimateMessage` 预估，不够就直接调原方法。
3. **引擎实例**：同一 preset 的所有会话共享一个实例，preset 换代或 HMR 后实例会换。补丁要：
   - 在原始实例上打 symbol 标记，不能用 `ctx.get` 返回的 Proxy；
   - 每次使用前懒检查，实例换了就重打；
   - 与其他插件的补丁链式共存，还原时确认自己仍在链顶；
   - 按 agent 分流，非团队会话原样调用原方法。
4. **调用路径**：45%、80%、手动 `/compact` 都会经过同一个 summarize。80% 路径还会重试多次。
5. **数据源**：不能用已弃用的 `snapshotEvents`。新鲜度依据要放进会话投影。

## 3. 建议的模板形态（与 04 的差别）

拿掉 04 里和 hint 重复的身份、任务元数据，以及多余的「上一步动作」，改为借鉴 Claude Code Session Memory：**笔记正文作为交接主体**。

```
[dsh-token-budget handoff] 上下文已换窗，旧窗口原文可用 history_* 工具按需读回。
当前任务：<task id> <标题>，attempt=<attemptId>（以 agent_teams_claim_task 返回为准）
你的笔记（写于 <时间>，覆盖本 attempt；之后约 <n> 步未记录）：
<自己笔记正文，保留尾部，上限约 6–8KB>
以工作区实际状态为准；笔记里没写的，先查再做，不要自行假设。
```

- 只放机械可得、能证明的信息。探针失败就降级或回退 LLM，不编造。
- 任务标题和笔记以外的引擎代写字段要脱敏。attempt_id、任务 id、路径保持原样。
- 不展示窗口编号（设计:276 的决议不变）。

## 4. 新鲜度：采用 D 的方案 C

`fresh ⇔` 在当前 attempt 内写过自己的笔记，且写笔记之后的「工作类工具调用」≤ K。

- 依据由投影记录：`lastNoteWrite`、`workSinceNote`、`lastClaim`。
- 投影不可用时降级为比较 mtime 与窗口起点。仍判不了，就走 LLM。
- 笔记不存在：走 LLM。
- 队长没有任务：恒走 LLM，或者只按方案 B 判定（待定）。

## 5. 落地前置改动（D §5）

1. `team-file.ts`：解析 `attempt`、`attemptId`、`updatedAt`、`description`（均为可选字段，宽容解析）。
2. `window/counter.ts` 投影：增加 `lastNoteWrite`、`workSinceNote`、`lastClaim`，`stateVersion` 升到 2。
3. `storeFor` 提到 `apply` 顶层。
4. 补丁内先 `teams.forget(agent.id)` 再读身份，保证模板和随后重算的 hint 用同一份快照。
5. 与 B3 联动：模板路径在钩子内预检尺寸，不让尺寸失败消耗掉本窗口的机会。

## 6. 需要用户拍板

1. **模板主体**：嵌入笔记正文（CC Session Memory 式，推荐），还是只放指引（smart-compact 式，更短，但新窗口第一步必须先调工具）？
2. **笔记是否加固定结构**：在 37/40/43% 提醒和成员规则里，要求按「目标 / 已做与决定 / 下一步 / 未决问题」四段写（Codex、CC 都这样做）。这会影响模板质量和「只有模板」的判定。
3. **适用范围**：手动 `/compact` 和 80% 兜底是否也走模板（补丁对三条路径都生效，可以按触发原因排除）？队长恒走 LLM 吗？
4. **K 值与配置项**：`handoff: hybrid | template | llm` 默认 hybrid，K 默认值另定（建议约 8 步工作类工具调用，待 PoC 校准）。

## 7. 待运行态验证

- 共享引擎下，summarize 收到的 agent 是否就是正在压缩的成员。
- 新 hint 在新窗口中的位置。
- `tokenMeter.estimateMessage` 对插件是否可用。
- 连续压缩（保留节点过大）时，模板替换模板的表现。
