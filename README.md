# dsh-token-budget

`dsh-token-budget` 是 [DeepSeek Harness（DSH）](https://github.com/deepseek-ai/deepseek-harness) 的独立插件，作为社区插件 [`@nanmicoder/dsh-agent-teams`](https://github.com/NanmiCoder/dsh-agent-teams)（基线 `0.1.23`）的**补丁插件**：

- **不修改原插件源码**，与社区原版并存；原版升级不会覆盖本插件。
- **只作用于团队会话**（队长与成员），普通会话不受影响。
- 插件整体由 DSH 插件管理面板启停。

> 状态：**设计已定稿，尚未开始实现。** 权威设计见 [`docs/design/plugin-design.md`](docs/design/plugin-design.md)。

## 功能

| 能力 | 开关 | 说明 |
|---|---|---|
| token budget | 无（插件本体） | 上下文占用达到 37% 起提示，每 3% 一档（37% / 40% / 43%）；达到 45% 时插件只对团队会话主动压缩（`compactIfNeeded` overflow 分支）。两个阈值均可配置 |
| notes | `notes`（默认开） | 成员独立笔记 + 团队共享 `workspace.md`；窗口切换后注入笔记指针 hint（任务 id/标题 + 最近 ≤5 个笔记的元数据） |
| history | `history`（默认开） | 只读工具，读取本会话先前窗口中被压缩隐藏的原始消息：`list_windows` / `list_items` / `read_item` / `search_contents` |

可选设置 `notesMerge.enabled`（默认关）：开启后由用户选择 DSH 账户中的模型与推理强度，自动合并共享笔记。

## 目录规划

```
make-the-plugin/
├── README.md                    本文件：项目总览与目录规划
├── package.json                 【待建】npm 包 dsh-token-budget（files 白名单只发布 lib/、cordis.patch.yml、README）
├── cordis.patch.yml             【待建】DSH 装载补丁：把插件行挂到宿主层
├── tsconfig.json                【待建】
├── src/                         【待建】插件源码（TypeScript）
│   ├── index.ts                   入口：name / inject / Config / apply()
│   ├── config.ts                  配置 schema（Schemastery）与默认值
│   ├── team/                      团队身份解析、team.json 缓存读取
│   ├── window/                    窗口计数（session projection）
│   ├── budget/                    占用计算、37/40/43 提示、45% 压缩（D1）
│   ├── prompt/                    稳定的 system prompt 指针 section
│   ├── notes/                     笔记存储、team_notes 工具、hint、可选自动合并
│   └── history/                   persistence 只读读取、窗口索引、history 工具
├── test/                        【待建】单元测试，目录结构与 src/ 对应
├── docs/
│   ├── design/                    设计文档
│   │   ├── plugin-design.md         权威设计规格（实现以此为准）
│   │   └── 临时记录.md              设计讨论记录（只保留当前结论）
│   ├── research/
│   │   └── context-compare/         Codex 与 DSH 上下文机制取证、社区插件调研、探针脚本
│   └── reference/                 外部参考资料（Codex 上下文压缩文章）
├── .agent-teams/                DSH 团队运行留下的归档（由 dsh-agent-teams 写入，勿手改）
└── _src-compare/                对照源码的 gitlink（codex、dsh-agent-teams），不随仓库检出
```

放置规则：

- **插件代码**只放 `src/`，一个能力一个子目录；跨能力共用的放 `team/`、`window/`。
- **设计变更**先改 `docs/design/plugin-design.md`，再改代码；讨论过程写进 `临时记录.md`。
- **调研与取证**（报告、探针脚本、运行输出）放 `docs/research/`，按课题建子目录。
- **构建产物** `lib/` 与 `node_modules/` 不入库（见 `.gitignore`）。
- **运行时数据不入库**：插件运行时把笔记写在用户工作区的 `.agent-teams/.context/notes/`，history 不落盘。

## 兼容性

| 组件 | 版本 |
|---|---|
| `@nanmicoder/dsh-agent-teams` | `0.1.23` |
| DSH 宿主源码基线 | `d7432673`（`0.2.1-alpha.2`） |

## 可选：关闭会话文件压缩（实验）

DSH 会话文件默认是 zstd 压缩（不是加密）。若想降低 history 工具的解码成本，可在 profile 中把 `session-persistence-jsonl` 的 `compression` 设为 `'none'`。这是全局存储配置，本插件不会自动修改；详见设计文档 §4.4。

## 许可

待定。
