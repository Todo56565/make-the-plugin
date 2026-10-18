# DSH 技能机制对本项目、agent-teams 与补丁插件的帮助

> 2026-10-18，只读源码探索（DSH 0.2.1-rc.2 编译后 JS、@nanmicoder/dsh-agent-teams 0.1.25、本仓库 src）。前置：`dsh-skill-loading.md`。
> 路径简写：宿主＝`@deepseek-ai/`；AT＝`@nanmicoder/dsh-agent-teams/lib`。行号指编译后 JS（本仓库为 TS 源码）。

**结论**：省 token 最多的是 agent-teams 常驻 system 的长协议和 14 个全局工具；本插件自身能省的不多，但 w1 交接有一处重复发送值得修。宿主允许从外部按会话遮掉别的插件的 section 和工具，不必改其源码。

## (a) dsh-token-budget

1. **【高】w1 交接随整段 runtime context 快照重发。** 预算提醒和 w1 交接都是 `systemPrompt.context`（`src/index.ts` 中 `BUDGET_CONTEXT_NAME`、`HANDOFF_CONTEXT_NAME` 两处注册）。宿主把所有 context 拼成一整段快照，在 pre-step 默认分支作为 user 消息加在尾部（`dsh-agent-loop` L909-917）；快照任一部分变化即整段重发（`RuntimeContextProjection.project`，L297-340），旧快照由 “supersedes” 作废。
   - 后果：预算每升一档，或其他插件的 context 变化，最多约 4KB 的交接（`hintMaxBytes` 默认 4000）跟着再发一次。
   - 改法：交接改为 pre-step 里只发一次的尾部消息（自定义 `source.kind`，digest 去重，压缩后补发，照抄 tool-skill）；预算提醒短，留在 context。
   - 缓存：只往尾部加，前缀不动。
2. **【中】非团队会话：提示词已为零，工具仍可见。** section 与 context 在非团队会话返回空串，但 8 个工具始终可见（`plugin-design.md`）。
   - 可用 `agent.ctx.tools.restrict({ deny })`（`dsh-tools` L2991-3004，需 agent 作用域 ctx）。
   - 限制：成员创建时尚未写入 team.json，判断时机不可靠；之后放开工具会改 tools 字段，缓存影响无法核实。工具描述合计约 1.5K 字符，收益有限。
3. **【低】规则说明挪成技能基本不划算。** 常驻规则约 0.6–0.9K 字符，只在团队会话出现且每会话冻结一次；是必须遵守的规则，按需加载后模型可能不读。
   - 可挪的只有队长细则（快照怎么查、待合并清单怎么处理）。
   - `agent.ctx.skills.register(...)` 登记到该会话自己的层（`dsh-skill` L193-214 `scopeOf`；菜单按 `scope: agent` 计算，`dsh-tool-skill` L938），可只对团队会话可见。代价是多一条菜单消息。

## (b) 给上游 agent-teams 的建议

1. **【高】队长协议约 4.8K 字符，所有会话都带。** 常驻 system section `agent-teams:usage`（AT `capabilities.js` L96-100，正文在 `index.js` 的 `usageSectionText`，约 4833 字符）。非成员会话一律拿到队长协议，包括普通会话和普通子代理（L99）。
   - 建议：system 只留激活那一句；完整协议在 `/agent-teams` 手势处理处（`command.js` L120 的 pre-step）或已有团队时追加到尾部，或注册成技能。
   - 仍满足它自己“不改写队长 system/tools 前缀”的约束（`capabilities.js` L44 起注释），因为 system 不变。
2. **【高】14 个工具全局可见，只对成员禁 10 个**（`capabilities.js` L84-87）。普通会话和子代理也带着 10 个队长工具的长描述（`tools.js` 共 161KB）。
   - 建议：非团队会话默认禁掉，`/agent-teams` 时放开（改一次 tools 字段）。
   - schema 有 `deferLoading` 字段（`dsh-system-prompt` L370-374），但 DeepSeek 的 llm 包中找不到读取处，无法核实是否生效。
3. **【中】成员规则约 1K 字符，可拆细则成技能**（`members.js` L725 起）。量小，优先级低。

## (c) 未来给 agent-teams 做补丁插件（不改其源码）

1. **能从外部按会话遮掉它的 section。** 同名 section 用 agent 作用域注册会盖过全局那份（`dsh-system-prompt` L349-363 “Scoped sections… shadow globals”；L203 报错文字提示 per-agent override 经 `agent.ctx` 注册）。组装 scope 为 agent（`dsh-agent` L291-296），空文本渲染时丢弃（L118）。
   - 用法：对判定为非团队的会话，在其首次组装前注册空的 `agent-teams:usage` 并冻结。
   - 或监听 `system-prompt/assemble` waterfall（L397；本插件已在用）过滤 sections 与 tools。
   - 风险：依赖 agent-teams 内部 section 名与工具名，其改名时要能静默失效。
2. **按需给队长补协议。** pre-step 识别 `/agent-teams` 后往尾部追加协议细则，或 agent 作用域注册技能再 `invalidate()`；前缀不受影响。
   - 限制：中途撤掉 section 遮罩会改 system；路由支持时为追加，否则改写第一个 system 节点、缓存失效（`SystemPromptProjection`，`dsh-agent-loop` L231-238）。所以遮罩应一直保留，协议靠尾部消息补。
3. **能隐藏它的工具。** `agent.ctx.tools.restrict({ deny: CAPTAIN_TOOL_NAMES })`，restrict 可叠加取交集（`dsh-tools` L2987 注释）。
   - 限制：工具名须已注册否则抛错（L3004），需先确认 agent-teams 已加载；中途放开改 tools 字段，缓存影响无法核实；成员判定时机要与其 `isPendingMember` 一致，但它不导出，只能近似。

## 建议优先做的 3 件事

1. 修 (a)1：w1 交接从 runtime context 移到只发一次的 pre-step 尾部消息。
2. 做 (c)1 + (c)2：补丁插件对非团队会话遮掉 `agent-teams:usage`，`/agent-teams` 时尾部追加协议；每个普通会话/子代理约省 5K 字符。
3. 把 (b)1、(b)2 整理成上游 issue：协议改为激活时追加或做成技能；非团队会话默认禁队长工具。
