# C. Codex 与 Claude Code 的压缩与换窗交接结构

日期：2026-10-15。Codex 为浅克隆 `/workspace/work/openai_codex`（commit cec8c6f，2026-10-14），路径相对 `codex-rs/`。

## 1. Codex

### 1.1 摘要压缩
- **提示词**：`prompts/templates/compact/prompt.md:1-9`，开头为「CONTEXT CHECKPOINT COMPACTION… handoff summary for another LLM」。要求写出四项：
  1. 当前进度与关键决定；
  2. 上下文、约束与用户偏好；
  3. 剩余工作与下一步；
  4. 继续工作所需的关键数据和引用。
- **新窗口前缀**：`summary_prefix.md:1`，原文为「Another language model started… Use this to build on the work… avoid duplicating work」。
- **压缩后保留**（`core/src/compact.rs`）：
  - 用户原话从新往旧保留，上限 20k token（:64、:715-806），超出部分截断并标记 incomplete；
  - 摘要放在最后（:404、:808-816）；
  - 系统上下文重新注入到最后一条真实用户消息之前（:641-699）；
  - 每次压缩都会提示「多次压缩会降低准确度」（:443）。

### 1.2 不做摘要直接换窗（`token_budget` 功能开启时）
- **实现位置**：`core/src/compact_token_budget.rs:16-69`、`session/mod.rs:4810-4866`、`session/turn.rs:1534-1544`。
- **新窗口内容**：只带系统上下文和受保留的客户端消息（上限 64k），不带摘要。
- **触发方式**：模型调用 `new_context` 工具，返回文本为「A new context window will start without summarizing conversation history.」（`tools/handlers/new_context_window.rs:31`）。另有 `get_context_remaining` 工具。
- **默认配置**：见 `models-manager/models.json:104` 起。
  - 剩余 6144 token 时发提醒，要求先把以下内容写入 notes，再调用 `new_context`：goal、decisions、progress、learnings、next steps、未完成用户请求的 window/item ID、重要的工具调用。
  - 窗口耗尽时有 16384 token 的缓冲区，此时给出 fallback 提示：只许写一次 notes，然后调用 `new_context`。
  - `guidance_message`：
    - 要求边做边写笔记；
    - 若 `<context_window>` 里出现 "Previous context window id"，先读 checkpoint；
    - 用只读的 `history` 工具按 ID 读取（`read_item`）。
- **窗口身份块**：`context/token_budget_context.rs:84-96`，字段为 Agent name、First / Current / Previous window id。
- **笔记扩展**：`ext/history-notes/src/tools.rs:27-28`、`extension.rs:31,100-155`。
  - 笔记按 agent 分路径存放；
  - 可读其他 agent 的笔记，只能写自己的；
  - 新窗口注入不超过 4KB 的 thread_hint。
- **续跑模板**：`ext/goal/templates/goals/continuation.md:19-25`，核心是「以工作区和外部状态为准，不以对话为准」，并给出「无进展判定」。
- **新鲜度思路**：`ext/memories/templates/memories/read_path.md:51-73`，按「漂移风险 × 核验成本」决定是否重新核验。

## 2. Claude Code

### 2.1 官方文档
- **压缩后保留什么**：https://code.claude.com/docs/en/context-window#what-survives-compaction
  - CLAUDE.md、记忆和 plan 会重新注入；
  - 最近 5 个文件会重读，单个超过 5k token 的只留路径；
  - 技能单个上限 5k，合计上限 25k；
  - 后台任务会提醒，避免重复启动。
- **Hooks**：https://code.claude.com/docs/en/hooks
  - PreCompact 带 `trigger` 和 `custom_instructions` 字段，可阻止压缩；
  - PostCompact 能拿到 `compact_summary`；
  - SessionStart 的 matcher 为 `compact` 时可以补注入。
- **自定义压缩指令**：可在 CLAUDE.md 里写「Compact Instructions」段（https://code.claude.com/docs/en/how-claude-code-works）。

### 2.2 社区逆向提取的提示词（Piebald-AI/claude-code-system-prompts，可信度中高）
- **九段摘要（v2.1.271）**：
  1. Primary Request
  2. Key Concepts
  3. Files
  4. Errors
  5. Problem Solving
  6. All user messages：安全约束逐字保留
  7. Pending
  8. Current Work
  9. Next Step：需逐字引用原话，防止任务理解漂移
- **lean 变体（v2.1.290）**：
  - 用户原话只算本人亲手输入的内容；
  - 限制要逐字写明；
  - 授权要连同范围一起写。
- **SDK 续写摘要**：分五段，Task Overview、Current State、Discoveries、Next Steps、Context to Preserve。
- **新窗口开头语**：「This session is being continued from a previous conversation…」，后接转录本路径，并要求不提问、直接续做。来源为泄露源码镜像 codeaashu/claude-code `src/services/compact/prompt.ts:337-374`，可信度中。

### 2.3 Session Memory：笔记优先、摘要兜底（来源为泄露源码，可信度中）
- **笔记模板**：十段，每段上限 2k、总上限 12k，并要求始终更新「Current State」段（`SessionMemory/prompts.ts:10-82`）。
- **退回 LLM 摘要的条件**：压缩时优先直接使用笔记，满足以下任一条件就退回 LLM 摘要（`sessionMemoryCompact.ts:514-630`）：
  - 笔记为空；
  - 笔记只有模板；
  - `lastSummarizedMessageId` 找不到；
  - 压缩后仍超过阈值。
- **保留范围**：笔记之后的消息保留 10k 到 40k token。

### 2.4 教学仓库 learn-claude-code
- `s08_context_compact/code.py:475-496`：当前用户请求与摘要分开存放，摘要标为 reference only，并附转录本路径。
- `docs/zh/s11-autonomous-agents.md:109-118`：压缩后重新注入身份块。

## 3. 对团队成员场景的启示

值得借鉴：
1. 交接以笔记为主，摘要兜底。笔记用固定结构，并在预警档位留出缓冲区，提示「先写笔记」。Codex 是 6144 token 提醒加 16384 token 缓冲，CC 的 Session Memory 也是同一思路。
2. 换窗后注入身份块：任务 id、attempt、队长、上一窗口 id（Codex token_budget_context、learn-claude-code s11）。
3. 队长或用户的原话逐字保留，授权连同范围一起记（CC 九段的第 6、9 段，以及 lean 变体）。
4. 以实际状态为准，交接内容只当线索（Codex continuation.md）。
5. 换窗前后各有一个钩子点：换窗前写笔记，换窗后补注入。

不该照抄：
- Codex 的 history 依赖其后端，笔记对用户隐藏。
- 九段摘要太长，不适合作为零模型模板。
- 「不提问、直接续做」会绕过队长确认。
