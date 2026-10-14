# DSH 插件调研（2026-10-14）

| 文件 | 内容 |
|---|---|
| 00-summary.md | 总结论 |
| 01-smart-compact-vs-token-budget.md | hoyyang/dsh-smart-compact v0.5.3 与本仓库 dsh-token-budget 的完成度、共存性对比、选型建议；问题清单按设计文档分为「已定取舍」与「仍待处理」 |
| 02-agent-teams-vs-claude-code.md | dsh-agent-teams 0.1.23 与 Claude Code Agent Teams 的能力矩阵和补齐优先级 |
| 03-peer-messaging.md | 四个跨会话插件（dsh-conversation-link、dsh-agent-message、dsh-team-link、dsh-session-bridge）的合并评估 |
| 04-handoff-design.md | 已确认方案：45% 压缩改为"模板交接 + LLM 兜底"；对设计 §7-10 的修订建议与设计勘误 |
| evidence/ | 复现脚本 |

结论基于阅读源码和自带测试，均未在真实 DSH 宿主上运行；推断项在各报告中已标注。
