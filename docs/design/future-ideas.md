# 远期想法（不属于任何已排期版本）

> 状态：构想，未排期、未调研到可实现程度。新想法统一追加到本文件。
> 已排期版本的设计见 `0.3.0-handoff.md`、`0.4.0-workspace-notes.md`。

## 1. 同工作区主 Agent「共议会」与常驻合并助手（另一个兼容插件）

### 1.1 想法

- **共议会**：同一工作区里多个独立主 Agent 能互相发现、发消息、讨论方案，而不只是各自带团队干活。
- **常驻合并助手**：一个常驻（悬浮）的 Agent 专门做 workspace 合并：读 `workspace.pending.md`，更新 `workspace.md`，删掉已处理的清单行。可替代或补充 0.4.0 里「合并模型（无工具单次调用）/ 队长」两种合并者。

### 1.2 与本插件的关系

- 做成**另一个插件**，与 dsh-token-budget 兼容，不并入本插件。
- 兼容点是 0.4.0 定下的**待合并清单协议**：插件加行，合并者只能删既有行（插件校验），读 `workspace.md` 时附带清单。0.4.0 只负责把清单与合并者接口定稳，不实现共议会。

### 1.3 可参考的现有插件

| 插件 | 可借鉴 |
|---|---|
| `dsh-conversation-link` | 平级会话发现、通信、状态、常驻规则 |
| `dsh-agent-message` | 跨会话消息、离线投递、回执 |
| `dsh-session-bridge` | 创建/发送/等待/读取会话、监控与看门狗 |
| `dsh-team-link` | 跨会话团队、共享黑板、协调者守则；其协调者提醒「读黑板/任务板，不读队员完整会话历史」，避免撑爆自身上下文 |

### 1.4 风险

- 多 Agent 相互唤醒形成循环。
- 多个合并者并发写 `workspace.md`。
- 协调者/合并助手读太多历史，自己的窗口先耗尽。
- 依赖 client/UI 的方案可能随宿主升级失效。

## 2. 其他待排期想法

- **LLM 摘要作为可选项加回**：0.3.0 换窗默认不调用模型（对齐 Codex token-budget），以后作为可选项加回，届时再做模型选择。
- **适配 `@deepseek-ai/dsh-experimental-agent-team-profile`**：暂缓。

## 3. 上游 NanmiCoder/dsh-agent-teams：问题与可优化点

> 依据 agent-teams 0.1.23（commit `1094b84`）源码。issue 由用户自己发，不代发。

### 3.1 issue 草稿要点：发信后紧接 completed，信被静默作废

- 现象：成员先发报告信、紧接着把任务标为 `completed`，这封信被作废（标 `discardedAt`，无 `readAt`），发信人和队长都不知道。实测见 `0.3.0-handoff.md` 中 PING-8 的观测。
- 原因：`mailbox.ts:11-19` `isCurrentMail`。信带 `sourceTaskId/sourceAttemptId` 时，记下发信那一刻的 `sourceTaskStatus`；任务之后进入终态（completed/failed/cancelled）且与信上记的状态不一致，该信就不再算「当前代」，被丢弃。
- 建议：把作废的信和作废原因告诉发信人（以及队长），而不是静默丢弃。
- 完整草稿正文在用户手里，此处只记要点。

### 3.2 完成回报流程的可优化点

现状：成员完成任务要写两份几乎重复的东西：先 `agent_teams_update_task` 填 `output`（质量类任务还要填 acceptanceResults、commandsRun 等），再按提示发「one short report」给队长（`scheduler.ts:265`、`members.ts:824`）。队长上下文只收到这封信；`output` 只写进 `team.json`，`agent-teams/task-updated` 事件只是信息性会话记录。

1. **完成通知由系统生成**：`update_task` 进入终态时，自动给队长投递一条结构化通知（taskId、attempt、status、verdict、output 开头）。成员不再手写完成信，信只用于阻塞、提问或补充。失败兜底路径（`members.ts` 约 355-395）已经是系统自动写信并唤醒队长，机制现成。顺带消除 3.1 的作废问题，也省掉成员一轮重复生成与两份内容不一致的风险。
2. **output 给写法指引**：现在只说「concise」。可约定「交付物／结论／遗留问题」结构和建议长度，让前 300、2,000 字符的截取也有用。
3. **status 标截断并给全文入口**：`agent_teams_status` 每任务只显示 `output.slice(0, 300)`（`tools.ts:2842`），且不标截断。建议加 `[truncated]`，并支持按任务读完整 output。
4. **下游派单不静默丢依赖**：`formatDependencyOutputs`（`scheduler.ts:151-171`）单条超 2,000 字符会标 `[truncated]`，但合计超 12,000 字符时 `selected.slice(1)` 从最前面整条丢弃依赖，不留任何提示。建议列出被省略的依赖 id。

我们这边：0.4.0 全文记录已补上「完整 output 可回查」；1、3、4 属上游，可与 3.1 一并整理成 issue。

- workspace 快照编号看板：设置页列出现存快照（编号、时间、大小）勾选，替代 `mergeSnapshotPicks` 文本框；同时显示 records 占用。需要插件向客户端暴露数据接口，0.4.0 不做（2026-10-18）。
