# T11 — 跨会话记忆机制对照表（第二轮）：Codex memories vs DSH 持久化能力

- 输入：`t9-codex-memories-evidence.md`（Codex @ `a07c8ebd`，824 行）、`t10-dsh-persistent-memory-forensics.md`（DSH 本机 + 插件 @ `1094b84a`，410 行）
- 组织方式：**按机制维度组织行**，不按仓库组织。列固定为 `Codex / dsh-agent-teams（插件层）/ DSH 宿主（压缩栈 + 核心）`。
- 证据引用：凡写 `t9 §X` / `t10 §X` 的，原文均含「路径:行号 + 逐字片段」；本表只写位置指针，不重复粘贴片段。**本表不引入 t9/t10 之外的新断言**（除下方 §0.1 明确标注的 4 条船长抽检项，均已由本轮回源复核），无支撑的格写 `证据不足`。
- 与第一轮 `t4-mechanism-matrix.md` 的边界（任务要求 4）：**本表只讲跨会话记忆**。`t4` 的 **M16（notes，模型可写持久笔记）** 与 **M17（history，跨窗口检索）** 已在第一轮各自归类，**不重复计入 memory**；`compact`（M5/M6/M9/M14）与 `spill`（M4）属**会话内**上下文治理，同样不计入。权威分界见 t9 §7 的四者对照表（载体 / 谁写 / 谁读 / 生命周期）。

## 0. 一句话定位（两侧机制的本质差异）

**DSH 侧的问题不是"没有持久存储"，而是缺少"记忆抽象 + 激活面"**：存储格式全局可读（多帧 zstd JSONL 按 workspace 聚簇）、`team.json`/inbox 可读、压缩检查点也落盘——但这些都**无法被新会话自动激活为记忆**。而 Codex 侧有一条完整的「后台两阶段提炼 + 独立 SQLite + 磁盘工件 + 每回合注入」流水线（t9 §0）。

| | Codex | DSH（三层合计） |
|---|---|---|
| 持久存储 | 有（本地 SQLite + 磁盘工件 + git 基线） | **有**（会话日志 / 插件状态 / 压缩检查点 / spill 全部落盘） |
| 记忆抽象 | 有（`stage1_outputs` 表 + Markdown 工件，含版本与硬校验） | **无**（三层皆无提炼机制，t10 §4） |
| 激活面 | 有（每回合 developer 指令注入，模型无需主动检索） | **无自动召回**；仅用户显式引用（快照式）与工作区文件（项目指令） |
| 结论 | 跨会话记忆子系统 | **有可读的持久存储，无记忆抽象** |

## 0.1 本轮回源复核的 4 条事实（船长抽检项，逐条已核）

| 复核项 | 结果 |
|---|---|
| `Feature::MemoryTool` 是 `Stage::Stable` 而非 `UnderDevelopment` | ✅ `codex-rs/features/src/lib.rs:1267-1272`：`key: "memories"`、`stage: Stage::Stable`、`default_enabled: false` ⇒ 是"**有意 opt-in**"，**不得**描述为"实验性" |
| 三条压缩路径与记忆**零耦合** | ✅ **机制层证据（主）**：数据源层显式过滤——`codex-rs/rollout/src/policy.rs:104-125` 的 `should_persist_response_item_for_memories` 把 `ResponseItem::Compaction` / `CompactionTrigger` / `ContextCompaction`（`:120-122`）与 `ConfigurationUpdate` / `ImageGenerationCall` / `Reasoning` / `Other` 一并显式返回 `false`（`:116-123`），同一函数还排除 `role == "developer"` 的消息（`:106`）⇒ 压缩相关条目**在设计上就不进入记忆数据源**。✅ **附带证据**：`memor` 在三文件中命中 **0/0/0**（`codex-rs/core/src/compact.rs`、`compact_remote_v2.rs`、`compact_token_budget.rs`，`git grep -i` 亦为 0） |
| 版本化目录常量的锚点 | ✅ 常量在 **protocol 侧** `codex-rs/protocol/src/memory_version.rs:19-20`（`Self::V1 => "memories"` / `Self::V2 => "memories_v2"`，文件共 23 行） |
| README 过期路径 | ✅ `codex-rs/memories/README.md:5-6` 称编排在 `codex-rs/core/src/memories/`，本 commit `Test-Path` = **False**（该目录不存在）；实际编排在 `codex-rs/memories/write/src/`（t9 §1.3 同结论） |

## 1. 主表：机制维度 → 三方做法

| # | 机制维度 | Codex（memories） | dsh-agent-teams 插件层 | DSH 宿主（压缩栈 + 核心） | 对我方是否适用（生效条件 / 前置依赖 / 能否照搬） | 分类 |
|---|---|---|---|---|---|---|
| N1 | **提炼触发：何时开始** | root 会话新 turn 被接受后**异步**触发；唯一调用点 `codex-rs/app-server/src/request_processors/turn_processor.rs:704-716` → `start_memories_startup_task`（`codex-rs/memories/write/src/start.rs:24`）。**不是**压缩后/会话结束/定时器；与压缩是两条独立后台路径（t9 §1.1、§1.4；本轮以"三压缩文件 `memor` 零命中"再证） | **未实现**：插件不发起任何提炼（t2 §6.1；t10 §4.2 末段"插件不发起 LLM 调用做提取"） | **未实现**：44 种事件类型中无 extraction/consolidation/summary-to-store 类事件（t10 §4.1 实测 `sessions=58 records=35652 distinctTypes=44`） | **不可照搬（DSH 无提炼层）**。Codex 的触发点依赖"有可提炼的数据源 + 有存放产物的库"，两侧在 DSH 都不存在。宿主已有"turn 提交"事件可挂载，但那是**新增子系统设计**，超出 t9/t10 取证范围，本表不提出 | ②Codex 有而 DSH 无 |
| N2 | **运行形态与闸门（生效条件）** | 两阶段**串行**（phase1 → phase2，`start.rs:89-91`）；四道闸门：非 ephemeral、`Feature::MemoryTool`、**非 subagent**、state DB 可用（`start.rs:33-38`、`:59-63`）；另有独立限流闸门 `guard::rate_limits_ok`（`start.rs:79-86`）。feature `stage: Stage::Stable` / `default_enabled: false`（`codex-rs/features/src/lib.rs:1267-1272`）⇒ **有意 opt-in，非未完成** | 不适用（不参与） | 不适用（不参与） | **依赖前提明确且很硬**：除 feature flag 外还有**独立限流闸门**（剩余额度阈值 `DEFAULT_MEMORIES_MIN_RATE_LIMIT_REMAINING_PERCENT = 25`，t9 §2.1）与**账号/凭据侧条件**（rate-limit 判定依赖 auth manager；t9 §8.3 将判定逻辑列为未逐行取证）⇒ 即使 feature 打开也不保证运行 | ②Codex 有而 DSH 无 |
| N3 | **数据来源：从什么里提炼** | 只处理**交互式会话 rollout**：`INTERACTIVE_SESSION_SOURCES` = Cli / VSCode / `Custom("atlas")` / `Custom("chatgpt")`（`codex-rs/rollout/src/lib.rs:88-95`）⇒ **排除子代理/内部会话**（t9 §2.1） | **未实现**（无提炼） | 会话日志在工作区聚簇、全局可读（`dsh-session-persistence-jsonl/lib/types/zstd.d.ts:1-6`；真实头 `session-….jsonl.zstd`，t10 §1.1）——**数据在，但没有消费者** | **部分可照搬（数据可得性已具备）**：DSH 侧"可读的会话日志"这一前置条件**已满足**（t10 §1.1）；缺的是**筛选规则与消费者**。Codex 的筛选规则中可直接借用的部分：只取交互式会话、排除子代理（DSH 侧对应字段为会话头 `origin`/`delegationDepth`，t3/t10 已实测），**不需要服务端依赖** | ①同一问题不同解法（数据源同构，消费者缺失） |
| N4 | **数据源筛选条件（取几条 / 多旧 / 多闲）** | `max_rollouts_per_startup` 默认 **2**、`max_rollout_age_days` 默认 **10**、`min_rollout_idle_hours` 默认 **6**（`codex-rs/config/src/types.rs:55-64`）；扫描上限 5000、并发 8、作业租约 3600 s（`codex-rs/memories/write/src/lib.rs:80-102`）；条目级白名单 `codex-rs/rollout/src/policy.rs:104-125`（排除 `developer` 角色消息，t9 §2.2） | **未实现** | **未实现**；该维度在 DSH 侧**无任何对应配置项**（t10 §4.2 表中所有"像记忆"的机制都不带此语义） | **不可直接照搬**：这些参数是"提炼流水线"的调参面，没有流水线就没有挂点。若照搬 N3 的筛选规则，**"空闲 ≥6 小时"在 DSH 侧无对应观测项**（t10 未取证会话空闲概念）⇒ 该子项标记 **证据不足** | ②Codex 有而 DSH 无 |
| **N5** | **【核心行】注入上下文与记忆库规模解耦** | **记忆库可无限增长，进入上下文的量恒定**，六重收敛：①每 thread 表内**仅一行**（`thread_id TEXT PRIMARY KEY` + `ON CONFLICT(thread_id) DO UPDATE` + 倒流保护 `codex-rs/state/src/runtime/memories.rs:908,924`、`codex-rs/state/memory_migrations/0001_memories.sql:1`）⇒ 记录数上限 ≈ **会话数**而非回合数；②每次启动最多处理 **2** 条 rollout、扫描上限 5000（`codex-rs/config/src/types.rs:55`、`lib.rs:86`）；③**30 天**未使用且未入选相位 2 的行淘汰，单批 **200**（`DEFAULT_MEMORIES_MAX_UNUSED_DAYS = 30`、`PRUNE_BATCH_SIZE = 200`，`phase1.rs:97-118`）；④相位 2 只取 **top-256**（`max_raw_memories_for_consolidation`，范围 1–4096，`codex-rs/config/src/types.rs:59,61-62`）；⑤`memory_summary.md` 硬校验 **< 10 000 字节**（`codex-rs/memories/write/src/workspace.rs:105-129`）；⑥注入时再截到 **2 500 token**（`codex-rs/ext/memories/src/lib.rs:16`、`prompts.rs:35-49`）（t9 §6.4、§2.3、§3.2、§5.1） | **该问题在插件层以"渲染层截断"形式存在但不解耦**：dependency 单条 2000 / 合计 12000 字符（超限**丢最旧**）、status task output 300 字符、inbox 预览 120/200 字符（t2 §5.2；t10 §2.2 表）——截断的是**当次渲染**，底下的 `team.json`/inbox **只增不减** | **同一类问题在这里最严重**：会话日志**只增不减**（多帧 zstd 追加，t3 §3.3），无任何收敛/淘汰机制；`session_projcache` 只保留 latest（t10 §4.2） | **这条是本轮最值得抄的一条，且与第一轮暴露的问题是同一类**：第一轮 t4 已实测 DSH 侧"全文投递（M13）、成员会话只增不减、无成员级预算（M15）"，本行给出的正是**同构解法**——"记录实体去重 + 单次处理上限 + 时间淘汰 + top-N 选择 + 产物与注入的双重硬上限"。⇒ **可借用设计参数**（尤其 ⑤⑥ 两个硬上限与 ① 的"每实体一行"）；**不可照搬实现**，因为 DSH 侧尚无可收敛的"记忆实体"（见 N8/N13） | ①同一问题不同解法（**限流思路相同，作用对象不同**：Codex 有记忆实体可收敛，DSH 只有只增不减的原始日志） |
| N6 | **产物形态（一）：结构化中间产物** | 相位 1 输出**严格 JSON**：V1 = `rollout_summary`/`rollout_slug`/`raw_memory`（三者必填），V2 = 去掉 `raw_memory`（`phase1_output.rs:61-82`）；V2 下 `rollout_summary` 截到 **9000 字节**（`:44-52`）；严格模式经 `prompt.output_schema_strict = true` 施加（`phase1.rs:313`）（t9 §3.1） | **未实现** | **未实现**（无结构化提炼产物；`session_projcache` 只存 latest 投影供 UI/引用列表，t10 §4.2） | **不可照搬**：需要"调模型产出结构化 JSON"的调用点 + schema 校验 + 落库，DSH 三层皆无。若未来引入，DSH 已有可复用的**基础设施**（结构化工具调用、zstd 追加式存储，t10 §1.1/§2.2），但那是基础设施不是机制 | ②Codex 有而 DSH 无 |
| N7 | **产物形态（二）：可读工件 + 硬校验** | 相位 2 产出自然语言 Markdown 工件集（`memory_summary.md` / `MEMORY.md` / `raw_memories.md` / `rollout_summaries/<slug>.md` / `skills/<name>/`，`codex-rs/memories/write/templates/memories/consolidation.md:20-35`）；**代码强制校验**：V1 必须有 `MEMORY.md`；`memory_summary.md` 首行必须为 `v1` 且 < **10 000 字节**；V2 还需四个固定二级标题（`workspace.rs:76-129`、`:105-129`）（t9 §3.2）。`skills/` **不受**该校验收束（t9 §8.2） | **未实现** | **未实现**；但存在语义相近的"文件形态"：`dsh-agent-instructions`（工作区 `AGENTS.md`/`CLAUDE.md`，`maxBytes 65536`，base 层 disabled、standard preset 启用，t10 §4.2） | **部分可照搬（形态而非机制）**："把长期信息写成工作区里一个被系统提示加载的文件"这条路在 DSH **已经存在**（`dsh-agent-instructions`），但它是**项目指令**而非对话记忆，且**不区分来源会话**。⇒ 不建议用"写 AGENTS.md"冒充记忆（语义不同，见 §2 类别④） | ④表面相似但语义不同 |
| N8 | **存储（一）：磁盘工件目录** | `~/.codex/memories/`（V1）与 `~/.codex/memories_v2/`（V2），目录名由 `MemoryVersion::directory_name` 决定（**`codex-rs/protocol/src/memory_version.rs:19-20`**）；根 = `codex_home.join("memories")`（`codex-rs/memories/write/src/lib.rs:118`）；子目录/文件常量见 `lib.rs:37-41`、`:112-116`（t9 §4.1） | `team.json` + `inbox/*.jsonl` 落盘于 `<workspace>/.agent-teams/<teamId>/`（`src/state.ts:1-14`，t10 §2.1/§2.2）——**磁盘上跨会话可读，但不含对话内容** | 会话日志 `<DSH_HOME>/sessions/<workspace>/<sessionId>/session.v4.jsonl.zstd`（多帧 zstd 追加，t10 §1.1；t3 §3.3） | **已适用（但用途不同）**：DSH 落盘层完整。插件层 `.agent-teams/**` 是**任务/协调状态**，不是记忆；宿主会话日志是**原始事件流**，无提炼与索引。⇒ "有地方存"≠"有记忆"（本表 §0 的核心判断） | ④表面相似但语义不同（状态持久化 vs 记忆工件） |
| N9 | **存储（二）：独立 DB 与表结构** | 独立于 state DB 的 **`memories_1.sqlite` / `memories_v2_1.sqlite`**（`codex-rs/state/src/sqlite.rs:36,97-112`），独立 migrator `./memory_migrations`（`codex-rs/state/src/migrations.rs:9`）；核心表 `stage1_outputs`（`thread_id TEXT PRIMARY KEY` + `raw_memory`/`rollout_summary`/`rollout_slug`/`usage_count`/`last_usage`/`selected_for_phase2`，`codex-rs/state/memory_migrations/0001_memories.sql:1`，增量迁移见 t9 §4.3）；历史遗留：记忆表**曾**在 state DB 内，后被 `codex-rs/state/migrations/0035_drop_memory_tables.sql` 删除（t9 §4.3） | **未实现**（插件用 JSON/JSONL，无 DB） | **未实现**（无记忆库；`dsh-session-query-sqlite` 的 FTS 被 `openAt: never` 关闭，见 N13） | **不可照搬**：需要新的持久化层与迁移体系。DSH 侧**并非没有 DB 能力**（`dsh-session-query-sqlite` 存在且可装载，t10 §1.3），但把它用作记忆库属**新增设计**，本表不提出 | ②Codex 有而 DSH 无 |
| N10 | **检索 / 注入接口（一）：默认主通道** | `memory_summary.md` 被读入并注入 **developer 消息**（**非工具**，模型无需主动检索）：`codex-rs/ext/memories/src/prompts.rs:35-49` 读取并截断到 `…SUMMARY_TOKEN_LIMIT = 2_500` token（`codex-rs/ext/memories/src/lib.rs:16`）→ `PromptFragment::developer_policy`（`extension.rs:95-98`）→ `codex-rs/core/src/session/mod.rs:4386-4388` 的 `developer_sections`；V2 按 **8900 字符**切分为多片段（`extension.rs:75-91`）；启用条件是**两个条件的与**：`Feature::MemoryTool` **且** `config.memories.use_memories`（`extension.rs:46-52`）；记忆目录加入沙箱可读根（`codex-rs/core/src/config/mod.rs:4237-4239`）（t9 §5.1） | **未实现**：`team.json` 进上下文的 3 条通路均为**插件渲染**（派发提示 / `agent_teams_status` / mailbox 投递，`src/scheduler.ts:210-269`、`src/tools.ts:2282-2877`、`src/mailbox.ts:22-31`，t10 §2.2），且**要求调用会话与团队存在 durable 身份或 fork 血缘**（`src/capabilities.ts:42-49`） | 宿主**有**"恒定注入"的能力位：`ctx.systemPrompt.section`（t2 §6.2 引 `capabilities.ts:101-106` 为插件用法）；但**没有任何记忆内容源**（t10 §4.1：44 种事件类型无 note/memory） | **场合适用、机制不可照搬**：DSH 侧"恒定注入"的位置在，但**没有可注入的记忆产物**。⇒ 前置依赖是 N6/N7/N8/N9 先存在；单靠改注入位得不到记忆 | ②Codex 有而 DSH 无 |
| N11 | **检索 / 注入接口（二）：模型可用的只读工具** | 4 个工具 `memories.add_ad_hoc_note` / `list` / `read` / `search`（命名空间 `memories`，`codex-rs/ext/memories/src/tools/mod.rs:35-52`、`lib.rs:18-22`）；**默认关闭**：`dedicated_tools: false`（`codex-rs/config/src/types.rs:384`）且受 `config.enabled` 门控（`extension.rs:146`）；配额：读取 20000 token、list 2000、search 结果上限 200（`lib.rs:11-16`、`tools/search.rs:106-116`）；`search`/`read`/`list` 声明 `supports_parallel_tool_calls() == true`（t9 §5.2） | **未实现**（插件不注册记忆类工具；回读手段只有 3 条渲染通路，t10 §2.2） | **未实现**：`session-query` 的精确读取 API 存在但**未暴露为模型工具**（包内无 `defineTool`/`ctx.tools.register` 命中；消费方是 API/会话控制器与 UI，t10 §1.3） | **不可照搬**：DSH 缺少"模型可调用的记忆检索工具"。**注意不要与 t4 M17 的 history 工具混淆**（第一轮已归类为跨窗口检索，且其真实存在性受 t1 §9.5 的 UNVERIFIED 限定） | ②Codex 有而 DSH 无 |
| N12 | **跨会话读取的通路（DSH 侧对位物）** | 新 thread 组装时**自动**注入（N10）——无需用户操作、不依赖血缘 | **未实现**（插件状态需身份匹配；新 captain 会话 `currentTeam` 为 `undefined`，t10 §2.2） | **两条受控通路**：①用户**显式引用**旧会话（`dsh-session-reference`：`MAX_REFERENCES = 3`、`DEFAULT_MAX_REFERENCE_BYTES = 65536`，`lib/types/config.d.ts:1-7`；仅在 mention 时替换/追加快照，`index.d.ts:30-38`，t10 §1.2）；②**工作区文件**（`AGENTS.md`/`CLAUDE.md`，t10 §4.2）。另：跨会话**继承**仅对 fork 血缘成立（`session/end-seed`，本机 53 次，成员会话 `isSeeded:false`，t10 §1.4） | **路径已存在、但非记忆语义**：引用是**用户驱动的快照**，不进记忆库、不跨会话累积。⇒ 可作为现有手段复用（**当前即生效，无需新增组件**），但**不要**宣称它提供记忆 | ③DSH 有而 Codex 无（**用户直接引用旧会话**；Codex 侧对应物为服务端 notes/history 后端，已在 t4 M16/M17 归类） |
| N13 | **检索匹配方式** | **字面包含**，无语义/向量检索：`local/search.rs:288` `.contains()`（t9 §5.3 作 `matched_query_flags` + `prepare` 只做 `to_lowercase`）；三种模式 `SearchMatchMode::{Any, AllOnSameLine, AllWithinLines{line_count}}`（`backend.rs:100-109`）；默认 `match_mode = Any`、`case_sensitive = **true**`、`normalized = false`（`tools/search.rs:106-116`） | **未实现** | **未实现且被 bundle 层默认关闭**：`@deepseek-ai/dsh-base/cordis.patch.yml:149-153` 把 `session-query-sqlite` 设为 `path: ':memory:'` + **`openAt: never`**（`@deepseek-ai/dsh-web-app/cordis.patch.yml:27-31` 复述同一默认；用户 patch 层无覆盖）；语义见 `dsh-session-query-sqlite/lib/types/index.d.ts:26-27,36-43`（`never` ⇒ `searchSessions`/`searchEvents` 以 `SESSION_QUERY_SEARCH_DISABLED` 失败，SQLite 从不导入）。**精确读取/过滤/追踪仍在**，只是检索被关（t10 §1.3） | **取决于是否先有记忆库**：匹配方式本身轻量，DSH 侧无技术障碍；但当前**连检索都不可用**。**与第一轮同构**：Codex 的记忆检索与 t1 §9.3 的 history 检索**都是"区分大小写的字面包含"**（t1 `tools.rs:181`；t9 `search.rs:288`）⇒ 说明这类系统的检索面普遍是**低成本字面匹配 + 靠注入摘要保证够用**，不值得为它引入向量检索 | ②Codex 有而 DSH 无（本机状态下连检索都被关闭）；检索算法本身与第一轮 history **同构** |
| N14 | **生命周期：更新 / 去重 / 淘汰** | 更新：`ON CONFLICT(thread_id) DO UPDATE` + 倒流保护 `WHERE excluded.source_updated_at >= stage1_outputs.source_updated_at`（`codex-rs/state/src/runtime/memories.rs:908,924`）；并发：DB 作业租约 + 三类作业键、相位 2 成功冷却 `PHASE2_SUCCESS_COOLDOWN_SECONDS = 6h`（`:21-27`）。淘汰：`max_unused_days` 默认 **30** 天（批 200，`phase1.rs:97-118`），`selected_for_phase2 = 1` 的行**不被剪**；相位 2 只取 top-N（默认 **256**）；过期 rollout summary 文件按 keep 集合删除、扩展资源保留 `RETENTION_DAYS = 7`（t9 §6.1、§6.2）；相位 2 是否运行由 **git 脏度**决定而非水位线（`phase2.rs:122`，t9 §6.3） | **未实现**（`team.json` 无淘汰；任务/成员只增不删，仅能归档整目录，t10 §2.3） | **未实现**：会话日志**只增不减**（t3 §3.3），无记忆级淘汰；`session_projcache` 只保留 latest（t10 §4.2） | **不可照搬**：DSH 缺乏"记忆记录"实体，无淘汰挂点。**但这条暴露了 DSH 侧的真实风险**：只增不减 + 无淘汰 + 无索引 ⇒ 历史越长可被检索的原始数据越多而没有任何收敛机制（本机 58 会话 / 35,652 条，t10 §1） | ②Codex 有而 DSH 无 |
| N15 | **容量上限（注入与产物的硬约束）** | 注入 ≤ **2 500 token**（`codex-rs/ext/memories/src/lib.rs:16`）；`memory_summary.md` < **10 000 字节**；V2 `rollout_summary` ≤ **9000 字节**；单工具输出 ≤ **2000 token**、单行 ≤ **10 000 字节**、整体 ≤ 有效窗口 **70%**（无窗口时回落 **150 000** token）；输出按 **8900 字符**切块（t9 §2.3、§3、§6.4） | 插件自有截断均为**渲染层**：dependency 单条 2000 / 合计 12000 字符（超限丢最旧）、status task output 300 字符、persona protocol 400 字符等（t2 §5.2；t10 §2.2 表） | 宿主截断与治理：spill `maxInlineTokens: 12500`、pruner `8192/4096/1024` code point、压缩阈值 ≈803,392（t3 §4.3、§2.2） | **已适用但不同轴**：DSH 的容量约束覆盖**单会话上下文**，**不覆盖跨会话记忆**（因为没有记忆）。⇒ 若要引入记忆，Codex 的"注入 ≤2500 token + 记忆文件 <10 000 字节"这对硬约束**可直接借用**（保证注入不随记忆库增长，即 N5 的 ⑤⑥） | ①同一问题不同解法（限流思路相同、作用对象不同） |
| N16 | **跨会话可读性（本表核心维度）** | **自动 + 全局**：任何新 thread 组装上下文时读 `<codex_home>/memories{,_v2}/memory_summary.md`（`codex-rs/ext/memories/src/prompts.rs:35-49`）⇒ 无需用户操作、不依赖血缘（t9 §5.1） | **磁盘可读，上下文需渲染 + 身份**：`team.json`/inbox 是纯 JSON/JSONL 任何会话都能读；但经 3 条渲染通路进上下文时要求 durable 身份或 fork 血缘（`src/capabilities.ts:42-49`）；归档目录**故意不含 `team.json`**（`src/state.ts:1152-1157`）⇒ 归档内容模型不可达，只走面板路由 `?archived=1`（`src/index.ts:271-273`）（t10 §2.2、§2.3） | **显式引用式**：用户引用旧会话时给快照（≤3 引用、每源 ≥64 KiB，t10 §1.2）；跨会话继承仅 fork 血缘（t10 §1.4）；自动召回**不存在**。压缩检查点在**会话日志内部**，跨会话只能靠引用通路（t10 §3.1） | **已适用（作为替代通路）**：DSH **已有**"把上个会话信息带进新会话"的手段（显式引用 + 工作区文件），**无需新组件**。与 Codex 的差别是**用户驱动 vs 自动**：自动召回给"稳定、去噪、有预算的摘要"，引用给"原文快照"。⇒ 长程 team 任务更适合前者，但引入成本高（见 §3） | ①同一问题不同解法（自动注入 vs 用户显式引用） |
| N17 | **写入权限：谁能写记忆** | **流水线写、模型默认不能写**：正常对话中模型不允许改记忆文件（`codex-rs/ext/memories/templates/memories/read_path.md:119`：`You can update the memories **only** when explicitly asked by the user.`）；模型只能写 `extensions/ad_hoc/notes/` 供 consolidation 应用（`read_path_v2.md:17-20`）；唯一例外是默认关闭的 `add_ad_hoc_note` 工具（t9 §5.2、§7 判断点 2） | **插件工具写**：任务/成员/消息经 `agent_teams_*` 工具落盘（t2 §3.2）；终态任务只允许 append-only 补充证据（`src/types.ts:151-160`，t2 §3.2） | **模型不写记忆**（无记忆实体）；会话日志由 harness 追加写入（t3 §3.3） | **已适用且方向一致**：DSH 与 Codex 在"**不让模型随意改长期状态**"上**同向**——DSH 用工具 + append-only 证据，Codex 用流水线 + 显式授权才可改。⇒ 这条不必改，是本表少见的"两侧设计同向"项 | ①同一问题不同解法 |
| N18 | **前置依赖与外部依赖（是否依赖服务端 / 账号 / 特定 provider）** | **多重硬依赖**：`Feature::MemoryTool`（`Stage::Stable` / `default_enabled: false`）**且** `config.memories.use_memories`（`extension.rs:46-52`）**且** 非 ephemeral **且** 非 subagent **且** state DB 可用（`start.rs:33-38,59-63`）**且** 限流闸门通过（`start.rs:79-86`，阈值 25%）。**产物与检索全部在本地**（本地 SQLite + 本地 git 基线 + 本地文件系统 `LocalMemoriesBackend`，`extension.rs:150-158`）——即**不依赖服务端**，但**依赖账号侧的额度信息**（t9 §2.2/§8.3） | **依赖工作区与身份**：无服务端依赖；前置 = 团队目录在工作区 + 调用会话具备 durable 身份或 fork 血缘（`src/capabilities.ts:42-49`） | **依赖 profile 装载**：引用服务需被 profile 装载（`@deepseek-ai/dsh-web-app/cordis.patch.yml:94-95`，t10 §6）；FTS 需 `openAt != never`（本机为 `never`，bundle 默认）；`agent-instructions` 需 standard preset 才启用（web-app 层 `disabled: true`，t10 §4.2） | **本条是"能否照搬"的判定依据**：Codex memories 虽**不依赖服务端**，但依赖**三重开关 + 账号额度**，默认状态下**不生效**。⇒ 把它当"现成可用的记忆能力"会误判。DSH 侧若要引入，**不需要**对应账号门槛（可省去 N2 的一半闸门），但需新建全部产物与存储（N6–N10） | ②Codex 有而 DSH 无 |

## 2. 四类情况分类

### 类别① 同一问题不同解法（机制同构、路径不同）
- **N3 数据源**：两侧"可供提炼的原始数据"同构（DSH 会话日志已全局可读，t10 §1.1），差别只是 Codex 有筛选规则与消费者。
- **N5 注入与规模解耦**（**核心行**）：两侧都在解"持久信息只增、上下文预算有限"这个同一问题——Codex 用"每实体一行 + 单次上限 + 时间淘汰 + top-N + 双重硬上限"（t9 §6.4），DSH 用**渲染层截断**（t2 §5.2）。**差别是关键**：Codex 截断的是**已收敛的记忆**，DSH 截断的是**未收敛的原始记录**。
- **N15 容量上限**：都设硬上限保护注入预算，但作用对象不同（记忆产物 vs 单会话渲染）；**数值不可互译**。
- **N16 跨会话可读性**：自动注入摘要 vs 用户显式引用原文快照。
- **N17 写入权限**：两侧都限制"模型随意改写长期状态"（**本表唯一两侧同向项**）。
- **N13 检索算法**：与第一轮 history 结论**同构**——都是"区分大小写的字面包含"（t1 `tools.rs:181` / t9 `search.rs:288`）。

### 类别② Codex 有而 DSH 无（本表绝对多数，说明 DSH 缺的是一整层）
- **N1 触发**、**N2 运行形态与闸门**、**N4 筛选参数**、**N6 结构化产物**、**N9 独立 DB**、**N10 默认注入通道**、**N11 记忆工具集**、**N13 检索（本机被关闭）**、**N14 淘汰**、**N18 依赖前提** = 10 条。
- 共同根因一句话：**DSH 不存在"记忆子系统"这一层**（t10 §4：插件、harness 核心、profile 配置层三者皆无提炼机制）。

### 类别③ DSH 有而 Codex 无
- **N12 用户直接引用旧会话**：`dsh-session-reference` 的"mention → 快照"通路是 DSH 独有的用户驱动机制（≤3 引用、每源 ≥64 KiB），且**当前即生效**（`@deepseek-ai/dsh-web-app/cordis.patch.yml:94-95` 已装载）。Codex 侧跨会话取回原文的对应物是**服务端 notes / history 后端**，已在 `t4` 的 **M16/M17** 归类——**本表不重复计入**。
- **N8 的"状态持久化"实体**：`.agent-teams/**` 的任务/协调状态跨会话可读，Codex 侧无"团队状态"实体。⇒ 属"DSH 有而 Codex 无的**实体**"，但**不是记忆**，故只在行内标注。

### 类别④ 表面相似但语义不同（**禁止强行对应**）
- **N7/N8 与"工作区文件即记忆"**：`dsh-agent-instructions`（`AGENTS.md`/`CLAUDE.md`，`maxBytes 65536`）与 Codex 的 `MEMORY.md` 形态相似，但它是**项目指令**（t10 §4.2 明确标注"属项目指令不是对话记忆"），**不区分来源会话、不携带对话内容、无提炼流程**。⇒ 不得把"写 AGENTS.md"当作 DSH 已有记忆。
- **N10 与压缩检查点**：Codex 注入的是**跨会话提炼产物**；DSH 侧最像的"注入进上下文的历史片段"是**压缩检查点**，但它是**会话内**替换产物、无跨会话索引（t10 §3.1）。⇒ `t4` M5/M14 已归类为会话内治理。
- **N12 与 memory**：引用给**原文快照**（用户驱动、一次性），memory 给**去噪摘要**（自动、持续）——解决不同问题（回查原文 vs 长期知识复用）。
- **N14 与 spill**：spill 也有"落盘 + 路径"形态，但 locator 只存在于**产生它的会话消息**里（t10 §5），跨会话不会自动发现。

### 不能归入四类的行
- **N2 的一半（限流闸门）**：判定逻辑在 t9 §8.3 被列为**未逐行取证**，"DSH 是否应引入限流"无法与 Codex 对照 ⇒ **不可类比**（证据不足，非能力差异）。

## 3. 对我方是否适用：结论与前置依赖（汇总）

| 判断 | 行 | 生效条件 / 前置依赖 | 在 DSH 架构里能否照搬 |
|---|---|---|---|
| **可照搬（已有基础设施）** | N3 数据源可得性、N12 跨会话引用通路 | N3：无需新组件，会话日志已全局可读（t10 §1.1）；N12：profile 已装载引用服务（t10 §6）、无服务端依赖 | **是**——两者**当前即生效**，可作"把上个会话信息带进新会话"的现成手段；但都**不构成记忆** |
| **可借用设计参数，不可照搬机制** | **N5（核心）**、N15、N17 | N5/N15：需先有可收敛的"记忆实体"才有挂点；N17：DSH 已同向 | 部分：**"每实体一行 + 单次处理上限 + 时间淘汰 + top-N + 注入与产物双重硬上限"这一整套参数化思路可直接借用**（它正是第一轮 M13/M15 问题的同构解法）；落地仍需 N6–N10 |
| **不可照搬（DSH 无对应层）** | N1、N2、N4、N6、N9、N10、N11、N13、N14、N18 | 共同前置：需**新建**提炼流水线（模型调用 + schema 校验）、持久化层（DB 或等效）、注入通道、工具面、淘汰策略 | **否（本轮取证范围内）**——不是"配置开关"而是**缺失的一整层**；Codex 实现可作设计参照（尤其 N4 筛选参数、N6/N7 两阶段产物形态、N5/N15 硬上限） |
| **不应照搬（语义会错）** | N7 的文件形态、N12 的引用、N8 的状态持久化 | —— | **否**：把工作区文件 / 引用快照 / 插件状态当记忆，会让"记忆"概念在团队内失去判别力 |
| **证据不足，无法判定** | N4 的"空闲 ≥6 小时"在 DSH 的对应观测项；N2 的限流判定逻辑 | —— | 需另行取证，不得据此下结论 |

## 4. 与第一轮 t4 的边界（明确不重复计入）

| 概念 | 第一轮归属 | 为何**不得**计入本表 memory | 本表如何引用 |
|---|---|---|---|
| **notes（模型可写持久笔记）** | `t4` **M16** | 由**模型主动写**、载体是**服务端后端**（`alpha/notes/v2/*`）；memory 由**后台流水线**生成、载体是**本地 SQLite + 本地 git 目录**（t9 §7 判断点 2/3） | 仅在 N4/N17/N18 作"生成主体不同"的对照提及，**无独立行** |
| **history（跨窗口检索）** | `t4` **M17** | history 是**同一 rollout 内跨 context window** 的只读检索，属服务端后端（t9 §7 判断点 1/3）；memory 跨**会话** | 仅在 N11/N13 作"检索能力对照物"提及（N13 并点出两者算法同构），**无独立行** |
| **compact（压缩）** | `t4` **M5/M6/M9/M14** | 压缩是**会话内**历史替换，连 context window 都不跨（t9 §7 判断点 1）；DSH 压缩检查点**无跨会话索引**（t10 §3.1） | 在 §2 类别④ 辨析，**无独立行** |
| **spill（工具结果外置）** | `t3` §4.1 / `t4` **M4** | locator 只存在于产生它的会话消息里（t10 §5） | 在 §2 类别④ 辨析，**无独立行** |

**入选判据（三条同时满足才算"跨会话记忆"）**：①**跨会话**（产物在新会话里可被读取）；②**有提炼**（不是原始记录的直接搬运）；③**自动或半自动可召回**（不要求每次用户手动引用）。按此：notes/history 只满足 ①（甚至只是同一 rollout 内跨 window）；compact/spill 只满足 ②（无跨会话）；DSH 引用通路只满足 ①（无提炼、非自动）⇒ **均不构成本表意义上的 memory**。

## 5. 证据边界（不得据此下结论的格）

- **证据不足**：N4 的"空闲 ≥6 小时"在 DSH 侧无对应观测项；N2 的限流判定逻辑（t9 §8.3 未逐行取证）；N14 中"DSH 无淘汰"是**由 t10 §4.2 事件词表与 §6 能力矩阵推断**（未实现），非"有淘汰但未观测"。
- **t10 §7 的 4 项 UNVERIFIED**（本表不展开）：`session-query` 是否有未装载的模型工具封装、UI 是否提供历史会话一键插入、`dsh_session_log` 服务端是否形成可用记忆、`archive` 真实归档实例的可读性。**其中第 3 项若成立会改变 N16/N18 的"DSH 无服务端记忆"结论——本表按"未验证"处理，不据此断言。**
- **t9 §8 的 7 项 UNVERIFIED**（相位 1 重试边界、`skills/` 校验、限流判定、`extract_model` 回落、V2 `raw_memory` 表现等）只在 N2/N4/N6 相关处标注，不展开。
- **假阳性纪律（t10 §4.1 教训）**：初版子串扫描曾报 `session/note` 命中，逐字符复核证明是命令/推理文本里的字面量；按**事件类型精确统计**为 0（58 会话 / 35,652 记录 / 44 种类型）。⇒ 本表一律采信"按类型精确统计"口径，**不据子串命中断言存在记忆事件**。
- 本表**未引入任何 t9/t10 之外的新断言**（§0.1 的 4 条均为船长抽检项且已回源复核）；所有"适用性/照搬"判断均为"已适用 / 可借用参数 / 不可照搬（缺层）/ 不应照搬（语义会错）/ 证据不足"五档，凡需新增设计处均标注为**超出本轮取证范围**。

## 6. 收口

Codex 的 memories 是一套**独立子系统**（两阶段后台流水线 + 本地 SQLite + 磁盘工件 + git 基线 + developer 注入 + 可选工具，t9 §0），`Stage::Stable` 但**默认关闭（opt-in）**、带多重闸门（t9 §1.2/§5.1）。DSH 侧**有完整且可读的持久存储，但没有记忆抽象与激活面**：不存在提炼（t10 §4 实测 0 个 note|memory 类型事件），不存在自动召回，跨会话全文检索被 profile 显式关闭（`openAt: never`），跨会话继承仅对 fork 血缘成立；现有两条通路（用户显式引用、工作区文件）可用但**不是记忆**——前者是原文快照、后者是项目指令。

**本轮最值得抄的一条是 N5**：Codex 用"每实体一行 + 单次处理上限 + 时间淘汰 + top-N + 注入与产物双重硬上限"把**注入上下文与记忆库规模彻底解耦**（记忆库可无限增长，进上下文的量恒定）。它与第一轮暴露的 DSH 问题——**全文投递（M13）、成员会话只增不减、无成员级预算（M15）**——是**同一类问题的解法**。因此本对照的有效结论是：DSH 侧若要获得跨会话记忆，缺的不是某个开关，而是 N1–N14 所描述的一整层；而 N5 提供的参数化思路**在不需要引入完整记忆子系统的前提下也值得借用**（对"只增不减"的会话/工件设收敛与上限），这一点留待后续定稿展开。
