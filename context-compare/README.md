# context-compare — 总入口（两轮）

> **补丁插件的权威设计规格见仓库根 [`../plugin-design.md`](../plugin-design.md)**。本目录是它的取证与比对依据。注意：本目录的 DSH 侧引用基于安装版压缩栈 `0.2.0-rc.2` 构建产物（`lib/index.js:N`），源码 HEAD `d7432673` 已是 `0.2.1-alpha.2`，行号不可互换；`t6` §3「不建议照搬」中关于 thread hint 与模型可见额度的两条，已被用户后续决定与 `plugin-design.md` §8 的说明覆盖。

**课题**：比对 Codex（`openai/codex` @ `a07c8ebd`）与 dsh-agent-teams（`NanmiCoder/dsh-agent-teams` @ `1094b84a` / v0.1.23）+ 其依赖的 DSH 宿主组件（压缩栈 @ `0.2.0-rc.2`）在长程 team 任务中的上下文与记忆机制，产出逐项对照表与 dsh 侧可落地改进建议。

- **第一轮**：上下文健康（截断 / 压缩 / 交接 / 保留 / 预算 / 检索 / 跨窗口状态）→ `t4` + `t6`
- **第二轮**：跨会话记忆（提炼 / 存储 / 注入 / 生命周期）→ `memories/m3`

## 0. 比对边界（重要，先读）

- 本次比对的 DSH 侧主体是 **`NanmiCoder/dsh-agent-teams` 成品插件**（第三方 npm 包 `@nanmicoder/dsh-agent-teams`，**不在 DSH 依赖树内**），以及它把对话历史/压缩外包给的那一层宿主组件（`@deepseek-ai/dsh-compaction` / `-basic` / `-tool-result-pruner` / `dsh-command-compact`）。
- DSH 自带的 **`@deepseek-ai/dsh-experimental-agent-team*` 系列（实验版）不是本次比对对象，也不作为评价基准**。本机 `node_modules/@deepseek-ai/` 下存在该实验版族包（`dsh-experimental-agent-team`、`dsh-experimental-agent-team-profile`、`dsh-experimental-client-ui-agent-team`、`dsh-experimental-tool-agent-team`），但本机 profile 的 `agent-teams` 项指向成品插件（由插件自带 patch 层装载：`@nanmicoder/dsh-agent-teams/cordis.patch.yml:19-21`，**无任何实验版引用**）【运行态】。
- 本会话运行的是**成品版**：captain 协议文本的鉴别特征（`every takeover is one ready task at a time` 与 `never yield with captain-owned work open`）逐字命中 `dsh-agent-teams/src/index.ts:185`，且在 `dsh-experimental-agent-team*` 四个包内**零命中**【运行态】。
- 因此：对照表的"插件层"列 = 成品插件；"宿主"列 = 上述组件 + harness 核心。任何结论都不建立在实验版行为之上。

## 1. 结论摘要

### 1.1 第一轮（上下文健康，详见 `t4-mechanism-matrix.md`）

1. **宿主压缩栈无 agent 维度分流**：`dsh-compaction-basic` 全文对 `origin` / `delegationDepth` / `parentSession` / `subagent` 检索命中 0（2 处为文案误命中）；自动监听器对所有 agent 生效，成员与 captain 走同一 preset、同一公式、各自独立计。
2. **两边都没有"按成员/角色分档的压缩预算"**：Codex 侧亦无——`AgentRoleOverrides` 不含上下文/压缩字段；它只多一个可显式覆写子代理继承配额的闸门 `Feature::SubagentDefaultContextLimits`（`codex-rs/core/src/agent/child_config.rs:135-141`），且该 feature `default_enabled: false` / `Stage::UnderDevelopment`（`codex-rs/features/src/lib.rs:1481-1486`）。**不是**"Codex 现成就在按成员分档"。
3. **实际生效的压缩入口是手动 `/compact`**：本机 56 个会话共 26 次压缩、自动触发 0 次、失败 1 次（额度不足）；真正在跑的截断手段是 spill 外置（62 条 notice）与工具自身截断（18 处）。
4. **报告口径与代码不符之处已按代码落表**：保留用户原话 20k 只对本地文本压缩路径成立（远程 v2 为 64k / 单条 agent 10k）；history 工具真实名为 namespaced `history.list_windows` / `list_items` / `read_item` / `search_contents` 且检索为**区分大小写**字面包含；不存在"压缩后追加续作说明"。

改进建议见 `t6-improvement-plan.md`：① 宿主压缩栈引入子代理维度降档闸门（最高优先，落宿主组件）；② 收敛队长收件箱进入上下文的正文体量（插件层可独立完成）；③ 用户原话保留配额（宿主组件）；④ 契约在压缩后可廉价重读（插件层）；⑤ 压缩失败/溢出救援的可观测记录（宿主组件）。**不建议照搬**：远程 opaque 压缩、跨窗口 `history.*` 检索、thread hint、模型可见 token 额度。

### 1.2 第二轮（跨会话记忆，详见 `memories/m3-memory-comparison-matrix.md`）

1. **DSH 侧：有可读的持久存储，无记忆抽象与激活面**。存储层完整（多帧 zstd JSONL 按 workspace 聚簇、插件 `team.json`/inbox、压缩检查点均落盘），但不存在提炼机制——全量 **58 会话 / 35,652 条记录 / 44 种事件类型**中 note|memory|feedback 类型为 **0**；无自动召回；跨会话全文检索由 bundle 层默认关闭（`@deepseek-ai/dsh-base/cordis.patch.yml:149-153` 的 `openAt: never`）；跨会话继承仅对 **fork 血缘**成立；唯一受控通路是**用户显式引用**旧会话（`session-reference`，≤3 引用 / 每源 ≥64 KiB）。
2. **Codex 侧：后台两阶段提炼 + 独立 SQLite + 磁盘工件 + 摘要硬上限 + 注入与库规模解耦**。触发起于 root 会话新 turn 被接受后异步执行（`codex-rs/app-server/src/request_processors/turn_processor.rs:704-716`），与压缩是两条独立后台路径；存储为独立库 `memories_1.sqlite` / `memories_v2_1.sqlite`（`codex-rs/state/src/sqlite.rs:36,97-112`）与 `~/.codex/memories{,_v2}/` 工件目录；`memory_summary.md` 硬校验 < 10 000 字节（`codex-rs/memories/write/src/workspace.rs:105-129`）、注入再截 2 500 token（`codex-rs/ext/memories/src/lib.rs:16`）；feature `Feature::MemoryTool` 为 `Stage::Stable` 但 `default_enabled: false`（有意 opt-in）。
3. **核心对照（m3 的 N5）**：Codex 用"每实体一行 + 单次处理上限 + 时间淘汰 + top-N + 注入与产物双重硬上限"把**注入上下文与记忆库规模解耦**（记忆库可增长，进上下文的量恒定）。这与第一轮暴露的 DSH 问题——**全文投递、成员会话只增不减、无成员级预算**——是同一类问题的解法；差别在于 Codex 截断的是**已收敛的记忆**，DSH 截断的是**未收敛的原始记录**。
4. **两侧检索算法同构**：Codex memories 的 `search` 与 Codex history 的 `search_contents` **都是"区分大小写的字面包含"**（`codex-rs/ext/memories/src/local/search.rs:288` vs `codex-rs/ext/history-notes/src/tools.rs:181`），**双方均无语义/向量检索**。
5. **与第一轮的边界**：notes（`t4` M16）、history（`t4` M17）、compact（`t4` M5/M6/M9/M14）、spill（`t4` M4）**均不计入 memory**（判据：跨会话 / 有提炼 / 自动或半自动可召回，三者须同时满足）。`m3` 只写当前状态，改进建议归后续定稿。

## 2. 文件清单

### 2.1 第一轮（上下文健康）

| 文件名 | 类别 | 内容 | 作者 | 证据工具 |
|---|---|---|---|---|
| `t1-codex-context-health-evidence.md` | 取证件 | Codex @ `a07c8ebd` 的 10 维逐字取证 + 报告差异 + UNVERIFIED 清单 | codex-researcher | — |
| `t2-dsh-agent-teams-context-mechanisms.md` | 取证件 | 成品插件 @ `1094b84a` 六维取证 | dsh-researcher | `check-t2-evidence.mjs`、`t2-snippet-verification.log` |
| `t3-dsh-host-context-infrastructure.md` | 取证件 | 宿主压缩栈四包 + spill + 会话持久化 + 子代理继承边界 | dsh-researcher | `t3-evidence-tools/`、`t3-snippet-verification.log` |
| **`t4-mechanism-matrix.md`** | **正式交付** | 19 个机制行 M1–M19 × 三方列 + 四类分类 + 报告差异 + 证据边界 + Codex 逐字附录 | synthesizer | `t5-anchor-audit.ps1` |
| **`t6-improvement-plan.md`** | **正式交付** | 核验修正落实 + 5 条改进建议 + 不建议照搬清单 | synthesizer | — |
| `t5-verification-report.md` | 核验件 | 对 t4 的 18 条抽检（成立 15 / 部分成立 2 / 依据链有错 1）+ 修正项 | verifier | `t5-anchor-audit.ps1` |
| `t7-incremental-verification.md` | 核验件 | 对第一轮定稿版的增量核验（含 F1/F2/F3） | verifier | `t7-appendix-verify.ps1` |

### 2.2 第二轮（跨会话记忆）

| 文件名 | 类别 | 内容 | 作者 | 证据工具 |
|---|---|---|---|---|
| `memories/t9-codex-memories-evidence.md` | 取证件 | Codex memories 七维取证 + 端到端调用链 + 与 notes/history/compact 的四者边界 + UNVERIFIED 清单 | codex-researcher | — |
| `memories/t10-dsh-persistent-memory-forensics.md` | 取证件 | DSH 侧跨会话可读性 / 插件持久化边界 / 是否提炼 五维取证 | dsh-researcher | `memories/check-t10-evidence.mjs`、`memories/event-vocabulary.mjs`、`memories/t10-snippet-verification.log` |
| **`memories/m3-memory-comparison-matrix.md`** | **正式交付** | 18 个机制行 N1–N18 × 三方列 + 四类分类 + 适用性汇总 + 与第一轮的边界 + 证据边界 | synthesizer | `memories/t12-anchor-audit.ps1` |
| `memories/t12-verification-report.md` | 核验件 | 对 m3 的核验（含 F1/F2/F3） | verifier | `memories/t12-anchor-audit.ps1` |

> 命名约定：`t1-`/`t2-`/`t3-`/`t9-`/`t10-` 前缀为**取证件**（保留前缀以示来源与可追溯性）；`t4`/`t6`/`m3` 为**正式交付**；`t5`/`t7`/`t12` 为**核验件**；本 README 为**总入口**。

### 2.3 定稿后新增的专题件（第三轮起，独立于 t1–t12 编号）

| 文件名 | 类别 | 内容 | 上游/交叉引用 |
|---|---|---|---|
| **`thread-hint-endpoints.md`** | **专题件** | Codex `history-notes` 扩展的 **10 个后端端点全表**（9 工具 + 1 hint）+ thread hint 的请求/响应/注入位全链路 + **Codex 服务端方案 ↔ DSH 侧对应物对照表** + 注入位粒度对齐表 + 自查记录 | 抽取自 `../临时记录.md` §10.8；Codex 检出 `codex-rs/ext/history-notes/src/`。**两份同源，改动需同步** |

同批次的降阈值实测、复核记录等写在 `../临时记录.md` §十四（含 §14.5 阈值触发档位核验、§14.9 独立复核与更正登记）。

> **与 §1.1 第 3 条的一致性提醒**：§1.1 第 3 条记「本机 56 个会话共 26 次压缩、**自动触发 0 次**」——那是第一轮的**运行态快照，现已过期**。2026-10-12 用临时降阈值实测到**自动压缩 2 次**（`session-6680b4` seq 2397 / `session-f729634a` seq 270，`sourceCommandId` 均为空）。最新普查与时间线见 `../临时记录.md` §十二、§14.9；**临时改动与回退办法见 §十四**（配置当前仍处于改动状态）。

## 3. 阅读顺序

1. 本文件 §0–§1（边界 + 两轮结论摘要）
2. 第一轮：`t4-mechanism-matrix.md` §0–§2 → `t6-improvement-plan.md` §2 → `t4` §3–§5
3. 第二轮：`memories/m3-memory-comparison-matrix.md` §0–§2 → §3–§4（适用性与边界）
4. 核验件：`t5` / `t7` / `memories/t12-verification-report.md`
5. 原始逐字片段：`t1` / `t2` / `t3` / `memories/t9` / `memories/t10`
6. **专题件**：`thread-hint-endpoints.md`（端点全表 + DSH 等价路径对照）
7. **第三轮讨论与实测记录**：`../临时记录.md`（§5.4 压缩后是否重渲染 / §10.8 thread hint / §十四 降阈值实测与回退）
8. **设计规格（权威）**：`../plugin-design.md`

## 4. 已知边界与未覆盖项

### 4.1 仍在各报告 UNVERIFIED 清单内（不得当作已生效结论）

**第一轮（`t1` §12 的 5 项 + `t3` §9 的 4 项）**
- Codex 侧：压缩后追加"续作说明"（未找到）；报告所用 history flat 工具名（本 commit 全域零命中）；harness 强制"进度文件"约定（未找到）；报告所依据的具体 commit（未知）；`codex-rs/memories/**` 的完整语义（当时未取证）；`truncation.rs` 的逐工具最终预算（未逐 handler 核对）。
- DSH 侧：pruner 的真实触发实例（56 会话中 0）；压缩前后压力对比（投影只保留 latest）；是否发生过 `context-overflow` 救援（无独立落盘证据）；`image-offload`（未观测到实例、阈值未取证）。

**第二轮（`t9` §8 的 7 项 + `t10` §7 的 4 项）**
- Codex 侧：相位 1 重试策略边界；`skills/` 工件的生成与校验细节（已知**不**受 artifacts 校验约束）；`guard::rate_limits_ok` 判定逻辑；`extract_model` 的回落顺序；V2 下 `raw_memory` 为空的完整表现；`memories/read/src/lib.rs` 的导出面；README 中 `codex-rs/core/src/memories/` 路径不存在（文档与代码不一致）。
- DSH 侧：`session-query` 精确读取 API 是否有未装载的模型工具封装；UI 是否提供历史会话一键插入；`dsh_session_log` 服务端是否形成可用记忆（**若成立会改变 m3 的 N16/N18 结论，现按"未验证"处理**）；`archive` 真实归档实例的可读性（本机无归档实例）。

### 4.2 本轮未纳入 scope 的内容

- **DSH 内置实验版智能体团队**（`@deepseek-ai/dsh-experimental-agent-team*`）不作为比对对象或基准，其行为未被取证。
- **Codex 服务端/云端侧行为**（`alpha/notes/v2/*`、`alpha/history/v2/*`、remote compaction v2 的服务端实现）本地不可见，仅按客户端契约取证。
- **改进建议的落地**：`t6` 的建议为设计说明，未修改任何插件源码；被测仓库（`codex` / `dsh-agent-teams`）与 DSH 安装目录全程只读。
- **跨模型/多 provider 差异**：本机路由为单一 provider 配置下的观测，其他 provider/窗口尺寸下的阈值与行为未取证。
- **记忆机制的具体实现方案**：`m3` 的 N5 只给参数化思路，未给出实现设计。

### 4.3 口径说明（避免误读）

- `t3` §4.1 的「62 条 spill notice / 18 处子进程截断」与「pruner 真实触发 0 次」是**运行态观测**（脚本统计），非源码契约。
- `t6` 中建议 ①③⑤ 的落点为**第三方 npm 包**（`node_modules/@deepseek-ai/dsh-compaction*`），不宜改写其构建产物；正规路径为上游特性请求或 profile 层等效表达。
- `memories/t10` 的结论一律采信**按事件类型精确统计**口径，不据子串命中断言存在记忆事件。
