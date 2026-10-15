# DSH 插件调研总结（2026-10-14，2026-10-15 按设计文档修订）

设计依据：`Todo56565_make-the-plugin/docs/design/plugin-design.md`（下称「设计」，引用写 `设计:行`）和 `docs/design/临时记录.md`。设计已明确、并经用户确认的取舍，下文记为「已定取舍」。只有设计没有覆盖、或代码与设计不一致的条目，才列为待处理。

## 1. dsh-smart-compact（hoyyang v0.5.3） vs make-the-plugin（dsh-token-budget v0.0.1）
- 只能选一个时，用 dsh-token-budget 做底座，不安装 smart-compact。按「宿主适配和团队场景两项双倍权重」重新计算后，评分为 3.0 对 3.7（初版 2.6 无法由表中分数复现，见 01 §1.7）。
- smart-compact 在 dsh 0.2.0-rc.2 上的问题（代码事实）：
  - 提醒写进了不存在的 `assembled.system`/`developer` 字段，模型收不到，计数器却显示已送达（`src/reminder.ts:106-110`）；
  - `ctx_history` 读不到工具结果，换到 0.2.0-rc.2 后 `tests/history.test.ts` 有 3 个用例失败；
  - preset 自带的压缩在 80% 触发，大概率抢在它 85% 的换窗前面（推断）。
- 两者能同时安装，不报错，但会互相干扰：45% 先触发，smart-compact 的自动换窗用不上；成员工具目录多出 10 个功能重叠的工具；两个「剩余量」工具的分母不同。
- 移植计划：把 smart-compact 的零模型交接这一组（交接模板、脱敏、笔记新鲜度检查、`new_context`、运行状态文件）搬进 dsh-token-budget。核心约 4–5 人日；`/smart-compact` 命令和按钮另需约 2 天。
- 已定取舍（初版曾误列为缺陷，现撤回）：
  - 45% 走 overflow 分支、只保留最后一个节点及其配对：§2.4 方案 D1，用户 2026-10-14 确认（设计:165-173、:410）。
  - v1 不拦截摘要：§7-10（设计:412、:425-429）。
  - README 写 `0.2.1-alpha.2`、package.json 写 `0.2.0-rc.2`：前者是取证用的源码基线，运行宿主是后者（设计:17、:21-24），两者不矛盾。README 可以补一行「运行宿主」，但这只是措辞问题。
  - 队长的 fork 后代按非团队处理（设计:252）；小窗口路由上「约 45%」会偏，`context_remaining` 的压缩点是估算（设计:175、:289、:295）。
- 成本口径更正：摘要请求复用会话前缀，大部分输入会命中 KV cache（basic `lib/index.js:890-892`；设计:427）。零模型交接主要节省输出 token 和等待时间，不是「省掉一整次昂贵调用」。
- 后续版本目标方案（v1 不拦截；用户 2026-10-15 确认按原进度后续加入，见 `04-handoff-design.md`）：
  - 「原文不保留」维持现状；
  - 笔记新鲜时用固定交接模板，零模型调用；笔记缺失或过期时退回 LLM 摘要；
  - 拦截点选引擎的 `summarize()` 钩子：用 `serviceFor` 拿到 preset 引擎后打补丁，按 agent 用 `WeakSet` 判断是否为团队会话。不选 `llm/stream` 加 `COMPACTION_INSTRUCTION` 文本匹配。
- 设计勘误建议：设计:141「DSH 没有不做摘要直接换窗的路径」不完全准确。`summarize()` 是引擎公开的定制钩子（basic `lib/index.js:796,893`），smart-compact 就是靠覆写它实现零模型换窗的（`hoyyang_dsh-smart-compact/src/rollover.ts:376`）。另有几处 D1 之前的旧文字需要同步（设计:177、:381、:385、:421、:254），汇总在 04 §5。
- 已修（2026-10-15）：`inject` 已补齐 `agentPresets`、`sessions`、`sessionPersistence`（3392547）。`llm` 只供可选的 notesMerge 使用，保持 `ctx.get()` 软依赖，设计 §2.2 已注明（bd00a1e）。
- 仍待处理（设计未覆盖，或代码与设计不符；已读 `src/` 核实）：
  - 核心路径没有接线测试，PoC-2 到 PoC-9 未做（设计:379-393）；
  - 压缩调用本身失败（抛错）时，同一窗口不再重试，只能等 80% 兜底（`src/index.ts` pre-step）。取不到引擎的情况已在 2144e6b 改为每步重试；
  - （低优先级）非团队身份只缓存 5 秒（`src/team/directory.ts:31,39-52`）。超时后，下一次组装 prompt 或 pre-step 时会按需同步重扫 `.agent-teams/`，不是定时器。实现与设计:254 有出入，但有理由；建议更新设计文字，或改为按 mtime 失效；
  - README 没有提示 `allow` 策略要放行本插件工具（设计:372 要求提示）；history 没有 `sessionQuery` 回退（设计:353；flush 已在 3392547 改为 `sessions.flush(session)`）；
  - 发布形态：private、UNLICENSED、没有 CHANGELOG。

## 2. dsh-agent-teams 要不要继续向 Claude Code Agent Teams 看齐
- 不全面看齐。dsh 在这些方面已经更强：启动审批、六态任务加 attempt_id、质量门禁、冷恢复、按成员选模型、可视化。
- 用户的既定路线是不改 agent-teams 源码，用补丁插件 dsh-token-budget 增强（设计:33-40），不写 `team.json`（设计:52）。所以需要改 agent-teams 的项都属于向上游提的建议。
- 值得补的：
  - P0（上游建议）：用户直接与成员对话的受控通道（标记 `from=user`、抄送队长、受 attempt 约束）。补丁插件无法实现，因为邮箱由 agent-teams 原子重写（设计:340）；
  - P1：成员换窗后自动拿到当前任务和 attempt_id。由 dsh-token-budget 承担：hint 按窗口刷新（设计:325、:415），交接模板带 attempt_id（04）。不按步注入，也不放进 system section（设计:135、:232、:413）。上游只需在成员规则里加一句「丢失 attempt_id 时调 `claim_task` 取回」（`src/tools.ts:1794-1805`）；
  - P1（上游建议）：可选的任务级 worktree，Claude Code 本身也没有；
  - P2：队长广播。Claude Code 官方也是逐个发送。
- 不照抄：Claude Code 的关机握手、成员计划由 lead 自动批准、`/resume` 不恢复队友。
- 跨会话（非团队）消息属于宿主层能力，不该放进 agent-teams。

## 3. 跨会话插件评估
- dsh-conversation-link、dsh-agent-message、dsh-team-link、dsh-session-bridge 四个插件的评估已合并为 `03-peer-messaging.md`，结论和可借鉴的设计以该文件为准。
- 与第 2 节相关的一点：「用户直接与成员对话」需要在 agent-teams 内部实现，不能靠这些插件补上。

详细报告见 01、02、03-peer-messaging.md、04-handoff-design.md。
