# dsh-token-budget

`dsh-token-budget` 是 [DeepSeek Harness（DSH）](https://github.com/deepseek-ai/deepseek-harness) 的独立插件，作为社区插件 [`@nanmicoder/dsh-agent-teams`](https://github.com/NanmiCoder/dsh-agent-teams)（基线 `0.1.23`）的**补丁插件**：

- **不修改原插件源码**，与社区原版并存；原版升级不会覆盖本插件。
- **只作用于团队会话**（队长与成员），普通会话不受影响。
- 插件整体由 DSH 插件管理面板启停。

> 状态：**0.5.1 已完成**（2026-10-20，tag `v0.5.1`，未发 Release）：headless profile 下可启动、锁/写入/结束代收尾/信件可见性等鲁棒性修复，见 [`docs/design/0.5.1.md`](docs/design/0.5.1.md)。0.5.0（tag `v0.5.0`）：兼容 DSH 0.2.1-rc.2 与 agent-teams 0.1.25、w1 交接只发一次、普通子会话隐藏本插件工具，设计见 [`docs/design/0.5.0.md`](docs/design/0.5.0.md)。0.4.0（workspace 双层记录）见 tag `v0.4.0` 与 [`docs/design/0.4.0-workspace-notes.md`](docs/design/0.4.0-workspace-notes.md)，0.3.0（换窗交接）见 tag `v0.3.0`。权威设计见 [`docs/design/plugin-design.md`](docs/design/plugin-design.md) 与各版本设计文档。

## 它解决什么

团队成员长时间工作时上下文会被塞满，宿主压缩后成员常常丢掉进度。本插件：

1. **提前提醒**：成员上下文占用 37%、40% 各提醒一次，提示把进度写进笔记；第一次提醒说明可以调用 `context_new_window` 自己换窗。
2. **换窗不调模型**：成员到 45% 后（经下面的兜底）换到新窗口。换窗不发摘要请求，摘要位置换成一段【交接】：身份、任务与当前 `attempt_id`、笔记位置与更新状态、团队信件和上一窗口的回看指针。宿主约 80% 的自动压缩、手动 `/compact` 在团队会话里也用这段【交接】。
3. **兜底**：成员到 45% 时一律先注入一次强提示并多给 16384 token 额度（不论本窗口是否写过笔记，对齐 Codex）：把最新进展补记进笔记（尽量一次 `team_notes`），然后调用 `context_new_window`；额度用完照样换窗。【交接】里注明笔记状态：兜底开始后写的算已更新；额度用完时标「可能未写完」；只在兜底前写过标「可能未含最新进展」；没进兜底时，只有模型自己调用 `context_new_window` 换窗（成员提前换、队长主动换）才标已更新，宿主约 80% 自动压缩（含队长）即使本窗口写过也标「可能未含最新进展」；没写标「未更新」。成员看不到 `team_notes` 时不兜底，直接换窗。
4. **队长不强制**：队长只在 45%、48% 各提醒一次（不催促），不强制换窗。
5. **笔记**：每个成员一份独立笔记，团队共享一份 `workspace.md`（只有队长能写；成员任务结束时的笔记快照进入待合并清单，由队长或外接模型合并进去）。
6. **记录**：任务终态全文、成员笔记快照、`workspace.md` 每次修改前的快照都留在 `records/`，只读可查；团队代结束后自动归档。
7. **只读历史**：成员可以回看本会话先前窗口里被隐藏的原始消息，以及团队来往的信。

## 功能

| 能力 | 开关 | 说明 |
|---|---|---|
| 换窗交接 | 无（插件本体） | 成员 37% / 40% 提醒，45% 先兜底再换窗；队长 45% / 48% 提醒。换窗经宿主压缩服务的 `compactIfNeeded`，接管 `summarize()` 返回【交接】，零模型请求。`context_new_window` 工具（无参数，随时可调；本窗口没写笔记时拒绝一次）。常驻说明只讲规则，第一个窗口注入一次精简【交接】 |
| 团队笔记 | `notes`（默认开） | `team_notes` 工具：读（可给 `start_line` / `stop_line`，大文件不给范围时返回末尾 + 总行数）、写、追加、搜索、`resolve`（队长删待合并清单条目）。成员写自己的笔记，只有队长能写 `workspace.md`；队友笔记与 `records/…` 只读。【交接】里的笔记指针与元数据 |
| 记录 | 随 `notes` | 终态任务全文（分卷 1 MB、单条 32 KB）、成员笔记快照（换窗与终态时拍，坐标 `<会话>/w<n>/e<seq>`）、`workspace.md` 修改前快照（`records/workspace-snapshots/`，编号越小越旧）。团队代结束时归档在用笔记，可选按天清理 |
| 历史工具 | `history`（默认开） | `history_list_windows` / `history_list_items` / `history_read_item` / `history_search_contents`；窗口编号 `w1`、`w2`…，只读，不落盘 |
| 团队信件回看 | `teamHistory`（默认开） | `team_history` 工具：回看团队信件，含已读和已作废的信。队长看全队（包括成员之间的信），成员看发给自己和自己发出的信。只读，不落盘 |
| 剩余上下文 | `contextTool`（默认开） | `context_remaining` 工具：返回已用比例与距离主动压缩的余量 |
| 笔记合并 | `notesMerge`（默认关） | 待合并清单非空时，用所选模型把清单条目指向的成员笔记快照合并进 `workspace.md`，成功后删掉已合并的条目；可附带近期任务全文（材料 a）与历史快照（材料 b，实验性），超出模型上下文时自动裁剪。关闭时由队长读清单、整理后 `resolve` |

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
| `remindAtRatio` | `0.37` | 成员开始提醒的占用比例（最低 `0.01`，须小于 `compactAtRatio`） |
| `compactAtRatio` | `0.45` | 成员换窗的占用比例；队长在此处与再后一个步长各提醒一次（最低 `0.03`） |
| `bucketStep` | `0.03` | 提醒档位步长。成员档位 = `remindAt + k × step` 且小于 `compactAt`，不整除时去掉最后一档（只剩一档时保留）：默认 37% / 40% |
| `fallbackBufferTokens` | `16384` | 成员到换窗点后补记笔记的额外额度（token） |
| `notesMerge` | `false` | 由外接模型合并待合并清单 |
| `mergeProvider` / `mergeModel` / `mergeReasoningEffort` | 空 | 合并所用模型；`notesMerge` 开启且选了模型才会合并 |
| `mergeRecentTasks` | `false` | 材料 a：附上次成功合并以来的任务全文（至多 16,000 字节，超出保留最新） |
| `mergeSnapshots` | `off` | 材料 b（实验性）：`off` / `cosine`（在历史快照上余弦取样）/ `custom`（指定编号） |
| `mergeSnapshotCount` | `5` | `cosine` 取样份数 |
| `mergeSnapshotPicks` | 空 | `custom` 时的快照编号，如 `1,5,12`；这些编号精简时额外保留 |
| `workspaceSnapshotKeep` | `0` | `workspace.md` 快照保留份数：`0` 全部保留；否则累计到 100 份时按余弦精简到该份数（最少 2） |
| `recordsCleanupDays` | `0` | 已结束团队代超过 N 天后删除其快照、搬入的笔记与待合并清单；`0` 不清理。全文记录始终保留 |
| `maxFileBytes` | `10000` | 成员 / 队长单个笔记字节上限 |
| `workspaceMaxBytes` | `20000` | `workspace.md` 字节上限 |
| `readMaxBytes` | `24000` | 读笔记 / 记录单次返回字节上限 |
| `hintMaxBytes` / `hintRecentNotes` | `4000` / `5` | 【交接】的字节上限（最低 4000）与列出的最近改动笔记数。超限先少列最近笔记，再截断过长的团队名 / 任务标题；身份、任务、自己的笔记、上一窗口永远保留 |
| `historyMaxResults` / `historyMaxReadChars` / `historyMaxListItems` | `200` / `20000` / `2000` | 历史工具单次返回上限 |

## 使用

不需要额外操作。建团队、派任务即可：

- 成员会在上下文里看到以【上下文预算】开头的提示，按提示写笔记，可以调用 `context_new_window` 自己换窗；到 45% 会看到【上下文已用尽】提示，补记笔记后调用 `context_new_window`。
- 换窗后，新窗口开头是【交接】（在摘要位置），列出身份、任务（含 `attempt_id`）、笔记和回看工具；成员用 `team_notes` 读回笔记，缺的用 `history_*` / `team_history` 查原文。
- 成员完成或失败的任务（带成员笔记快照）会进入待合并清单（虚拟文件 `workspace.pending.md`，读 `workspace.md` 时附带）。保持 `notesMerge` 关闭时，队长读清单指向的快照、整理进 `workspace.md` 后用 `resolve` 删除条目；打开 `notesMerge` 并选模型后由插件自动合并，队长只需处理剩下的条目。
- 成员笔记里「仍在处理的请求」记为 `w<n>/e<seq>`，换窗后可用 `history_*` 按坐标查原文。

成员工具策略：agent-teams 允许部署方在它的配置里声明 `toolPolicies`，再给成员挑一个策略。策略若写了 `allow`，成员就**只看得到列出的工具**（agent-teams 会自动补上它自己的 4 个协调工具，但不会补本插件的）。这时要把本插件的工具名一起列进去，否则成员看不到它们：

```yaml
toolPolicies:
  researcher:
    allow: [read, glob, grep, team_notes, team_history, context_new_window, context_remaining, history_list_windows, history_list_items, history_read_item, history_search_contents]
```

只用 `deny`、或成员没选策略时，不需要处理。成员看不到 `team_notes` 时，到换窗点不兜底，直接换窗。

运行时文件都在工作区 `.agent-teams/.context/` 下（agent-teams 默认把 `.agent-teams` 排除在交付审计之外）：`notes/`（在用笔记）、`shared/`（`workspace.md`、待合并清单、锁）、`records/`（全文、快照、已结束团队代）、`state/`（游标与序号）。物理路径按团队代分目录，模型看到的虚拟路径不变。历史工具只读会话文件，不另存数据。

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
│   ├── client/                    浏览器端设置页（DSH 插件管理面板 → 配置）：表单状态、模型目录下拉、中英文文案
│   ├── context/                   `.context` 目录布局（各区路径、团队代）、跨插件文件锁、原子写
│   ├── records/                   全文记录（终态任务追加到 records/full 分卷，游标缓存与重建、首次运行基线）；已结束团队代的发现、归档与按天清理
│   ├── window/                    窗口投影（history 口径）、换窗状态与决策、context_new_window 工具
│   ├── budget/                    占用计算、提醒与兜底文本、换窗压缩与 summarize() 接管
│   ├── prompt/                    常驻规则 section、【交接】模板（完整版 / w1 精简版）
│   ├── notes/                     笔记存储与虚拟路径、team_notes 工具（含行范围读）、成员笔记快照、workspace.md 修改前快照与余弦取样、待合并清单（shared/pending/nanmi/<团队>@<代>.jsonl → 虚拟 workspace.pending.md）、自动合并与合并材料裁剪
│   ├── history/                   persistence 只读读取、窗口索引、history 工具
│   └── team-history/              团队信箱只读视图与 team_history 工具
├── test/                        单元测试（node --test），目录结构与 src/ 对应
├── docs/
│   ├── design/                    设计文档
│   │   ├── plugin-design.md         权威设计规格（实现以此为准）
│   │   ├── 0.3.0-handoff.md         0.3.0 换窗交接设计（已发布）
│   │   ├── 0.4.0-workspace-notes.md 0.4.0 workspace 双层记录设计与实现拆分
│   │   ├── future-ideas.md          远期想法（共议会、客户端数据通道、快照看板等）
│   │   └── 临时记录.md              设计讨论记录（只保留当前结论）
│   ├── research/
│   │   ├── 0.3.0-poc-results.md     0.3.0 设计 PoC 实测
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
- **运行时数据不入库**：插件运行时数据写在用户工作区的 `.agent-teams/.context/`，history 不落盘。

## 许可

待定。
