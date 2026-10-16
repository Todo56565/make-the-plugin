# dsh-token-budget

`dsh-token-budget` 是 [DeepSeek Harness（DSH）](https://github.com/deepseek-ai/deepseek-harness) 的独立插件，作为社区插件 [`@nanmicoder/dsh-agent-teams`](https://github.com/NanmiCoder/dsh-agent-teams)（基线 `0.1.23`）的**补丁插件**：

- **不修改原插件源码**，与社区原版并存；原版升级不会覆盖本插件。
- **只作用于团队会话**（队长与成员），普通会话不受影响。
- 插件整体由 DSH 插件管理面板启停。

> 状态：**功能完成，待发布。** 全部能力已在真实 DSH `0.2.0-rc.2` + agent-teams `0.1.23` 团队会话中验证（PoC-1、4–9，见[设计文档 §6](docs/design/plugin-design.md)）。权威设计见 [`docs/design/plugin-design.md`](docs/design/plugin-design.md)。

## 它解决什么

团队成员长时间工作时上下文会被塞满，宿主压缩后成员常常丢掉进度。本插件：

1. **提前提醒**：上下文占用达到 37% 起，每涨 3% 提示一次（37% / 40% / 43%），提示成员把关键进度写进笔记。
2. **提前压缩**：达到 45% 时主动压缩团队会话，避免等到上下文溢出才压缩。
3. **笔记**：每个成员一份独立笔记，团队共享一份 `workspace.md`；压缩后的新窗口会自动带上笔记指针和当前任务。
4. **只读历史**：成员可以回看本会话先前窗口里被压缩隐藏的原始消息。

实测（阈值调低到 3% / 5%）：成员在没有任何关于笔记或压缩的指令时，收到预算提示后会主动把数据写进笔记，压缩后任务结果完整正确。

## 功能

| 能力 | 开关 | 说明 |
|---|---|---|
| token budget | 无（插件本体） | 37% 起提示、每 3% 一档；45% 时主动压缩团队会话（宿主压缩服务的 `compactIfNeeded`）。阈值可配置 |
| 团队笔记 | `notes`（默认开） | `team_notes` 工具（读、写、追加、搜索自己的笔记与 `workspace.md`）；系统提示中的笔记指针；每个新窗口开头的 hint（任务 id/标题 + 最近笔记元数据，为窗口开始时的快照） |
| 历史工具 | `history`（默认开） | `history_list_windows` / `history_list_items` / `history_read_item` / `history_search_contents`；窗口编号 `w1`、`w2`…，只读，不落盘 |
| 团队信件回看 | `teamHistory`（默认开） | `team_history` 工具：回看团队信件，含已读和已作废的信。队长看全队（包括成员之间的信），成员看发给自己和自己发出的信。只读，不落盘 |
| 剩余上下文 | `contextTool`（默认开） | `context_remaining` 工具：返回已用比例与距离主动压缩的余量 |
| 笔记合并 | `notesMerge`（默认关） | 成员任务完成时用所选模型把其笔记合并进 `workspace.md`；关闭时由队长维护 |

所有开关和数值在设置页保存后**即时生效**，无需重启 DSH；已打开的会话在下一次请求时就会增减对应工具。

## 安装

需要 DSH `0.2.0-rc.2` 或更新版本，并已安装 `@nanmicoder/dsh-agent-teams`。

从源码安装（当前方式）：

```bash
git clone https://github.com/Todo56565/make-the-plugin.git
cd make-the-plugin
pnpm install && pnpm build          # 生成 lib/（含浏览器端 lib/client.js）
dsh plugin --profile <profile> add file:$(pwd)
dsh --profile <profile>             # 或 dsh web --profile <profile>
```

发布到 npm 后可直接 `dsh plugin --profile <profile> add dsh-token-budget`。

安装后在 DSH 插件管理面板确认 `dsh-token-budget` 已启用。更新源码后重新 `pnpm build` 并重启 DSH 即可。

## 设置

入口：插件 → `dsh-token-budget` → 组件行的「配置」（行名旁的 `>`）。模型为下拉选择（提供方 → 模型 → 推理强度）。保存后写入 profile 的 `cordis.patch.yml`；与默认值相同的项不会写入。

也可以直接编辑 profile 的 `cordis.patch.yml`：

```yaml
- id: dsh-token-budget
  config:
    remindAtRatio: 0.37
    compactAtRatio: 0.45
```

| 配置项 | 默认 | 说明 |
|---|---|---|
| `stateDir` | `.agent-teams` | 须与 agent-teams 的 `stateDir` 一致。放在 `.agent-teams` 之外时，笔记可能被质量闸门计入交付审计（启动时会告警） |
| `notes` / `history` / `teamHistory` / `contextTool` | `true` | 四个能力开关 |
| `remindAtRatio` | `0.37` | 开始提示的占用比例 |
| `compactAtRatio` | `0.45` | 主动压缩的占用比例（仅团队会话） |
| `bucketStep` | `0.03` | 提示档位步长 |
| `notesMerge` | `false` | 任务完成时自动合并笔记 |
| `mergeProvider` / `mergeModel` / `mergeReasoningEffort` | 空 | 合并所用模型；`notesMerge` 开启且选了模型才会合并 |
| `maxFileBytes` | `10000` | 单个笔记文件字节上限 |
| `hintMaxBytes` / `hintRecentNotes` | `4000` / `5` | 窗口 hint 的字节上限与列出的最近笔记数 |
| `historyMaxResults` / `historyMaxReadChars` / `historyMaxListItems` | `200` / `20000` / `2000` | 历史工具单次返回上限 |

## 使用

不需要额外操作。建团队、派任务即可：

- 成员会在上下文里看到以【上下文预算】开头的提示，并按提示写笔记。
- 压缩后，新窗口开头会有【团队上下文】段落，列出当前任务和最近笔记；成员可用 `team_notes` 读回笔记，或用 `history_*` 工具查原文。
- 想让队长统一整理共享笔记，保持 `notesMerge` 关闭，在任务说明里让队长维护 `workspace.md`；想自动合并，打开 `notesMerge` 并选一个模型。

成员工具策略：agent-teams 允许部署方在它的配置里声明 `toolPolicies`，再给成员挑一个策略。策略若写了 `allow`，成员就**只看得到列出的工具**（agent-teams 会自动补上它自己的 4 个协调工具，但不会补本插件的）。这时要把本插件的工具名一起列进去，否则成员看不到它们：

```yaml
toolPolicies:
  researcher:
    allow: [read, glob, grep, team_notes, team_history, context_remaining, history_list_windows, history_list_items, history_read_item, history_search_contents]
```

只用 `deny`、或成员没选策略时，不需要处理。

运行时文件：笔记写在工作区 `.agent-teams/.context/notes/` 下（agent-teams 默认把 `.agent-teams` 排除在交付审计之外）；历史工具只读会话文件，不另存数据。

## 可选：关闭会话文件压缩（实验）

DSH 会话文件默认是 zstd 压缩（不是加密）。若想降低 history 工具的解码成本，可在 profile 中把 `session-persistence-jsonl` 的 `compression` 设为 `'none'`。这是全局存储配置，本插件不会自动修改；详见设计文档 §4.4。

## 兼容性

| 组件 | 版本 |
|---|---|
| DSH | `0.2.0-rc.2` 实测；源码基线 `d7432673`（`0.2.1-alpha.2`） |
| `@nanmicoder/dsh-agent-teams` | `0.1.23` |

## 开发

```bash
pnpm test        # node --test
pnpm typecheck
pnpm build
```

## 目录规划

```
make-the-plugin/
├── README.md                    本文件：项目总览与目录规划
├── package.json                 npm 包 dsh-token-budget（files 白名单只发布 lib/、cordis.patch.yml、README）
├── cordis.patch.yml             DSH 装载补丁：把插件行挂到宿主层
├── tsconfig.json
├── src/                         插件源码（TypeScript）
│   ├── index.ts                   入口：name / inject / Config / apply()
│   ├── config.ts                  配置 schema（Schemastery）与默认值
│   ├── team/                      团队身份解析、team.json 缓存读取
│   ├── window/                    窗口计数（session projection）
│   ├── budget/                    占用计算、37/40/43 提示、45% 压缩（D1）
│   ├── prompt/                    稳定的 system prompt 指针 section
│   ├── notes/                     笔记存储、team_notes 工具、hint、可选自动合并
│   ├── history/                   persistence 只读读取、窗口索引、history 工具
│   └── team-history/              团队信箱只读视图与 team_history 工具
├── test/                        单元测试（node --test），目录结构与 src/ 对应
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

## 许可

待定。
