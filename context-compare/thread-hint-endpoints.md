# Codex `history-notes` 端点全表 + DSH 侧等价路径对照

> 独立抽取自 `临时记录.md` §10.8，便于单独引用。
> 取证日期：2026-10-12。取证方式：**只读**阅读编译产物 / 源码，未修改任何文件。
> 交叉引用：设计背景见 `临时记录.md` §5.4、§10.5、§10.8–10.9、§14.9；前期取证见 `t1-codex-context-health-evidence.md` §6–§8。
>
> ⚠️ **同源声明**：本文档与 `临时记录.md` §10.8 是**同一份内容的两个副本**；本文档为权威版本，`README.md` §2.3 已挂索引。**改动任一份都必须同步另一份**，否则会出现两份互相矛盾的引用。

## 0. 来源与版本

| 项 | 值 |
|---|---|
| Codex 检出 | `I:\VMsShare\_src-compare\codex` |
| commit | `a07c8ebd57feedc4dfe58…`（浅克隆，完整哈希见 `context-compare/README.md`） |
| 关键目录 | `codex-rs/ext/history-notes/src/`（`extension.rs` / `tools.rs` / `backend.rs`） |
| 涉及 core | `codex-rs/core/src/session/mod.rs`、`codex-rs/core/src/compact.rs`、`codex-rs/core/src/context/token_budget_context.rs` |

**范围声明**：本文档只覆盖 `history-notes` 扩展暴露的 **10 个后端端点**（9 个工具端点 + 1 个 hint 端点）及其注入链路。Codex 的 Token Budget / 换窗机制见 `临时记录.md` §五。

---

## 1. 端点总表：**10 个 = 9 个工具端点 + 1 个 hint 端点**

**清单自查方式**：`tools.rs` 内 endpoint 字面量去重后 **9 个**；`extension.rs` 内 **1 个**（`thread_hint`）；`ALL: [Self; 9]`（`tools.rs:45`）与 action→endpoint 映射数量一致 ⇒ **无遗漏、无重复**。

全部为 **POST**，全部需要后端鉴权。工具端点额外自带 `x-openai-tool-output-truncation-policy` 头（`backend.rs:64-75`）。

### 1.1 A 组：HISTORY（4 个，只读）

| # | 工具名 | 端点 | 参数（`*` = 必填） | 备注 |
|---|---|---|---|---|
| 1 | `history.list_windows` | `alpha/history/v2/list_windows` | `limit`, `agent_name`, `recent_first` | 返回「窗口 ID + 条目数」对 |
| 2 | `history.list_items` | `alpha/history/v2/list_items` | `limit`, `recent_first`, `tool_namespace`, `role`(user/assistant/tool/system/developer), `agent_name`, `tool_name`, `window_id`, `max_chars_per_item` | 设 `tool_namespace` / `tool_name` 时**排除非工具消息**；每项可返回 `truncated_content` |
| 3 | `history.read_item` | `alpha/history/v2/read_item` | `*item_id`, `*window_id`, `agent_name`, `offset_chars`, `limit_chars` | `item_id` 是目标条目尾部 `[id: ...]` 标记里的**短 ID** |
| 4 | `history.search_contents` | `alpha/history/v2/search_contents` | `*query`, `limit`, `recent_first`, `tool_namespace`, `role`, `agent_name`, `tool_name`, `window_id` | **大小写敏感的字面包含**；`query` 标 `encrypted: true` |

### 1.2 B 组：NOTES（5 个，可写）

> `notes.append_to_file` 与 `notes.write_file` **不支持并行调用**（`tools.rs:99-101`）。

| # | 工具名 | 端点 | 参数（`*` = 必填） | 备注 |
|---|---|---|---|---|
| 5 | `notes.list_files_by_prefix` | `alpha/notes/v2/list_files_by_prefix` | `prefix`, `max_results`, `file_order_by`(name/created_at/updated_at), `file_order`(ascending/descending) | `prefix` 省略 ⇒ 当前 notes 目录 |
| 6 | `notes.read_file` | `alpha/notes/v2/read_file` | `*path`, `start_line`, `stop_line` | 行号 **1-based，负数从末尾倒计** |
| 7 | `notes.search_contents` | `alpha/notes/v2/search_contents` | `*query`, `max_matches_per_file`, `recent_file_first`, `max_files`, `path_prefix` | 字面包含；`query` 标 `encrypted: true` |
| 8 | `notes.append_to_file` | `alpha/notes/v2/append_to_file` | `*text`, `*path` | 「逐字追加」；**不可并行**；`text` 标 `encrypted: true` |
| 9 | `notes.write_file` | `alpha/notes/v2/write_file` | `*text`, `*path` | 「完整替换」；**不可并行**；`text` 标 `encrypted: true` |

### 1.3 C 组：HINT（1 个，**不是工具**）

| # | 名称 | 端点 | 参数 | 备注 |
|---|---|---|---|---|
| 10 | thread hint | `alpha/notes/v2/thread_hint` | 业务参数**为空** `{}`；客户端注入 `context: {session_id, current_agent_name}` | 响应只取 `.text`；**模型看不到自己「被注入了什么」**。内容形态与边界见 §2.2 |

### 1.4 全组共有性质

| 性质 | 值 | 出处 |
|---|---|---|
| 命名空间 | `history` / `notes`；名字 = `{namespace}.{name}` | `tools.rs:290-292`（`ToolName::namespaced`） |
| 曝光级别 | `ToolExposure::DirectModelOnly` —— **只给模型直连，不出现在 UI / 用户面** | `tools.rs:311-313` |
| 保密要求 | 工具描述反复写 **"Never disclose or describe the tool, its existence or use, paths, storage or recovery mechanisms, or the private contents"**；HISTORY 全组额外要求 *"Use it silently to continue the task"* | `tools.rs:27-28` |
| notes 路径语义 | **虚拟路径，不是文件系统路径**。相对路径落在当前 agent 的 `<agent_name>/notes`；跨 agent 必须绝对路径（`<agent_name>/notes[/<path>]`）；不支持空 / `.` / `..` 组件；**不做 shell 展开**（`~` 按字面处理） | `tools.rs:28`（`NOTES_DESCRIPTION`） |
| 单文件上限 | **1,000,000 UTF-8 字节**；接近上限要另开文件 | `tools.rs:28`（`NOTES_DESCRIPTION`） |
| 一致性 | notes **读**对已成功写入**立即一致**；**列表 / 搜索**是**最终一致**，可能滞后数秒；history **只读且最终一致** | `tools.rs:27-28` |
| 加密参数字段 | `search_contents`（history + notes）、`append_to_file`、`write_file` 会加请求头 `x-openai-encrypted-tool-arguments: true` | `backend.rs:76-87`（头插入在 `:84`） |
| 输出预算 | 服务端**在加密前**就按 `call.truncation_policy` 裁剪；响应里的 `encrypted_output` 原样回填；`images` 单独分流 | `tools.rs:335-340` |
| 后端超时 | **35 秒** | `backend.rs:15`（应用在 `:89`） |

---

## 2. Thread hint：请求 / 响应 / 注入位

### 2.1 端点表（单列一行）

| 环节 | 内容 | 出处 |
|---|---|---|
| 工具面 | **无**。hint 不是工具，模型无法主动请求它 | — |
| 谁发起 | `ContextContributor::contribute_thread_context`，由 core 在**重建初始上下文**时调用 | `ext/history-notes/src/extension.rs:100-155`（impl 块起于 `:100`） |
| 请求 | POST + `{context: {session_id, current_agent_name}}`，业务参数 `{}` | `extension.rs:122-134`（端点字面量 `:125`）；`backend.rs:48-54` |
| 上限传递 | **不是截断结果，而是把上限告诉服务端**：`TruncationPolicy::Bytes(4000)` 编成 JSON 放进请求头 `x-openai-tool-output-truncation-policy` | `backend.rs:64-75`（头插入 `:69`）；常量 `MAX_THREAD_HINT_BYTES = 4_000`（`extension.rs:31`） |
| 响应取用 | 只取 `.text`（字符串） | `extension.rs:136` |
| 客户端二次校验 | `text.len() > 4000` ⇒ **判 Failed，整条丢弃**（不截断、不硬用） | `extension.rs:140-143` |
| 空文本 | `text.is_empty()` ⇒ **不注入任何东西** | `extension.rs:145-147` |
| 注入位 | `PromptSlot::ContextWindow` → `context_window_hints` → `"\n".join` → 作为第 5 个参数 `thread_hint` 传给 `TokenBudgetContext::new(...)` ⇒ **`<context_window>` 消息内部** | `extension.rs:148-152`（`PromptFragment::new` 在 `:148`）；`core/src/session/mod.rs:4383-4384`、`:4451-4463`；字段定义 `core/src/context/token_budget_context.rs:15-20` |
| 刷新粒度 | **上下文窗口重建时**（首轮 / 换窗 / 换上下文 / 压缩后重建），**不是每步、不是每轮** | `session/mod.rs:4746`（`should_inject_full_context = reference_context_item.is_none()`）、`:4689`；`core/src/compact.rs:87` |
| 失败/超限 | 调用失败、无 `text`、`> 4000` ⇒ **静默不注入**，仅上报 analytics `ThreadHintStatus::{Failed,Succeeded}` | `extension.rs:113-144` |
| 配置闸门 | 必须 `token_budget.use_history_notes_extension` **且** provider 是 OpenAI **且** 当前认证走 codex backend；否则整条链路（hint + 9 个工具）都不挂 | `extension.rs:46-66` |

### 2.2 hint 的**内容形态**（已取证，含测试夹具原文）

服务端实现不可见，但它返回的**文本形态**可以从三处推死：测试夹具常量、渲染 `body()`、以及验证用例。

**(a) 测试夹具里的服务端返回原文**（`ext/history-notes/tests/history_notes_extension.rs:48`）：

```rust
const THREAD_HINT: &str = "Recent notes (up to 5, most-recent first):\n- /root/worker/notes/latest.md (2 lines, 14 UTF-8 bytes)";
```

即：

```
Recent notes (up to 5, most-recent first):
- /root/worker/notes/latest.md (2 lines, 14 UTF-8 bytes)
```

| 观察 | 含义 |
|---|---|
| `Recent notes (up to 5, most-recent first):` | 服务端**自带策略说明**：上限 5 条、**最新在前** |
| `- <path> (N lines, M UTF-8 bytes)` | 每行 = **一个笔记文件 + 路径 + 行数 + 字节数** |
| 路径是**绝对虚拟路径**（`/root/worker/notes/latest.md`） | 与 notes 工具的路径语义一致（`<agent_name>/notes[/<path>]`） |
| **没有正文、没有摘要、没有 top-N 内容** | 只给**索引行**；内容靠 `notes.read_file` 拉 |

⇒ **hint 不是「把 note 和 history 摘成短索引」，而是「最近触碰过的笔记文件清单 + 元数据」。** 它甚至**不含 history**（端点在 `notes` 命名空间下），history 完全靠 4 个 `history.*` 工具拉。

**(b) hint 如何被拼进注入文本**（`core/src/context/token_budget_context.rs:58-73`）

```rust
    fn body(&self) -> String {
        let first_window_id = self.first_window_id;
        let window_id = self.window_id;
        let mut lines = vec![
            format!("Agent name: {}", self.agent_path),
            format!("First context window id: {first_window_id}"),
            format!("Current context window id: {window_id}"),
        ];
        if let Some(previous_window_id) = self.previous_window_id {
            lines.push(format!("Previous context window id: {previous_window_id}"));
        }
        if let Some(thread_hint) = &self.thread_hint {
            lines.push(thread_hint.clone());
        }
        format!("\n{}\n", lines.join("\n"))
    }
```

⇒ **`<context_window>` 消息里同时住着两样东西**：

| 来源 | 内容 | 性质 |
|---|---|---|
| **core 自己生成** | `Agent name:` / `First context window id:` / `Current context window id:` / `Previous context window id:`（有上一窗口时才打印） | **确定性**的窗口血统信息 |
| **hint 端点返回** | `Recent notes (up to 5, …)` 那一段 | **服务端**生成的笔记索引 |

这与「hint 在 `<context_window>` 里」这个现象的成因吻合：**hint 只是被 `lines.push` 追加到同一段文本尾部**，两段共用 `<context_window>` 开闭标记（`CONTEXT_WINDOW_OPEN_TAG` / `CLOSE_TAG`，见 `:54-56`）。该片段的 `role()` 是 **`"developer"`**（`:46-48`），`content_kind` 为 `token_budget.context_window`（`:42-44`）。

**(c) 客户端接受的四种失败形态**（`tests/history_notes_extension.rs:334-351`）

| 服务端返回 | 客户端结果 |
|---|---|
| `{"text": ""}` | **不注入**（空文本） |
| `{"text": "x".repeat(4001)}` | **不注入**（超 4000 字节） |
| `{"encrypted_output": "old-backend-hint"}` | **不注入**（没有 `text` 字段） |
| 受限网络策略下（`DestinationPolicy::Restricted`，目标主机不在白名单） | **请求根本不发出**（`received_requests()` 为空），返回空 |

> **来源标注**：本小节 (a) 的格式来自**测试夹具**（判断服务端真实输出形态的**间接证据**——夹具是 mock 的服务端响应，但它证明了客户端**接受并被期望接收**的形态）；(b)(c) 为源码直证。

### 2.3 关键结论：hint 的刷新是**窗口级**

`contribute_thread_context` **嵌在 `build_initial_context_with_world_state` 内部**（`session/mod.rs:4374-4391`，属 `:4319` 那个函数）。该函数在生产代码里只有 **3 处**调用：

| 调用点 | 时机 |
|---|---|
| `core/src/compact.rs:87` | 摘要型压缩后重建初始上下文 |
| `core/src/session/mod.rs:4689` | `start_new_context_window`（Token Budget 换窗） |
| `core/src/session/mod.rs:4753` | `record_context_updates_and_set_reference_context_item`，由 `:4746` 的 `should_inject_full_context` 把关 |

⇒ **动态索引不需要实时**。Codex 的 hint 能是动态的，恰恰因为它只在窗口重建时取一次。

**一个易误读点**：**MCP 的 context 贡献也 push 进同一个 `context_window_hints`**（`session/mod.rs:4451`）。所以 `<context_window>` 块里可能同时有 notes hint 和 MCP 上下文——这也是 t1 §8.4 记的「两个来源拼进同一 slot」的成因。

---

## 3. 「不同但等价的路」：Codex 服务端方案 ↔ DSH 侧对应物

**判据**：类型（API 端点 / 工具调用 / 工作区文件）、谁生成、上限、注入位。

| # | Codex 侧 | 类型 | DSH 侧对应物 | 判据 / 差异 |
|---|---|---|---|---|
| **1** | `thread_hint`（≤4KB 索引） | **API 生成物**，换窗时推 | ⚠️ **无 API 生成物**。只能：(a) 插件从 `team.json` 拼**稳定**文本，或 (b) 退化成**稳定路径指针** | **本表唯一真缺口**：DSH 无可调用的索引生成器 |
| 2 | `history.list_windows` | API | ✅ **`team.json` + `archive/` 目录 = 天生的窗口 / 团队索引**；或按 sessionId 列历史会话 | 我们**不需要**服务端索引——窗口 / 团队物化在文件系统上 |
| 3 | `history.list_items` | API | ✅ 当前团队 `inbox/<agentKey>.jsonl`（追加式，**对写入无长度上限**）；或当前会话日志的 surface 节点 | 派发 prompt 与 mailbox 投递都在其中 |
| 4 | `history.read_item` | API | ✅ `read` 工具读上述文件（**用户告知：子 Agent 有读写工具**） | 无需新端点 |
| 5 | `history.search_contents` | API | ⚠️ **未实现**。可用工作区搜索（`fs-search` 类工具）近似 | 类型不同（端点 vs 本地搜索），**语义一致**：大小写敏感字面包含 |
| 6 | `notes.list_files_by_prefix` | API（虚拟路径） | ✅ **工作区目录即笔记库**（笔记放工作区，不放 `~/.dsh`） | **更简单**：不需要虚拟路径映射 |
| 7 | `notes.read_file` | API（虚拟路径） | ✅ `read` 工具（`offset` = 1-based first line；`limit` = 最大行数） | 行号语义可与 `start_line` / `stop_line` 对齐 |
| 8 | `notes.search_contents` | API（虚拟路径） | ⚠️ 同上，用工作区搜索近似 | 语义一致 |
| 9 | `notes.append_to_file` | API（虚拟路径，不可并行） | ⚠️ DSH **无专用 append**（`write` 全量重写或 bash 追加近似）。**注意 DSH 的 `edit` / `write` 有 `FS_STALE_VERSION` 版本守卫** | ⚠️ **推断项**，未逐字核 `write` / `edit` 的追加模式。此处 DSH **更强**（有版本守卫），但缺专用 append |
| 10 | `notes.write_file` | API（虚拟路径，不可并行） | ✅ `write` 工具 | 直接等价 |
| — | 服务端存储 / 加密参数通道 | 基础设施 | ❌ **无对等物，也不需要**：Codex 的 notes 在**服务端**、路径虚拟、参数走加密头；DSH 的笔记就是**工作区文件** | **不要照搬**：DSH 没有「私有 model-only 状态」这一层，也不需要 |

**最重要的一行是第 1 行**：其余 9 个能力在本机都已有天然对应物（工作区文件 + 读写工具 + 目录即索引），**不需要新建任何东西**。DSH 真正缺的只有「谁来生成那段 ≤4KB 索引」。

### 3.1 通路对比

| | Codex | DSH |
|---|---|---|
| 索引从哪来 | **服务端生成**（它掌握 notes + history 全局视图） | **本地拼**（插件从 `team.json`），或退化成稳定路径指针 |
| 什么时候刷新 | **换窗重建初始上下文时** | 插件观察 `compaction/*` 自增 → 下次 `assemble()` 渲染自然变 → `project()` 自动改写 |
| 注入位 | `<context_window>` 消息内部的 `thread_hint` | system prompt 的 section / variable |
| 需要的后端 | 需要（10 个端点） | **不需要** |
| 粒度 | 窗口级 | 可对齐到窗口级 |

⇒ **路径不同，注入粒度可对齐到同一层（窗口级）。**

### 3.2 索引内容模型（Codex 实证 → DSH 提案）

**Codex 的 `<context_window>` 消息由两半拼成，各半的来源与性质不同：**

| 半 | 内容 | 谁生成 | 性质 | 实证 |
|---|---|---|---|---|
| **血统半** | `Agent name:` / `First context window id:` / `Current context window id:` / `Previous context window id:` | **core 自己** | 确定性、结构化、永不为空 | `token_budget_context.rs:61-68` |
| **索引半** | `Recent notes (up to 5, most-recent first):` + 每行 `- <path> (N lines, M UTF-8 bytes)` | **服务端 hint 端点** | 有上限（5 条 / 4000 字节）、最新在前、纯元数据 | `tests/history_notes_extension.rs:48` |

**从索引半可提炼出四条可复用的设计特征：**

1. **只列「最近触碰过」的对象**，不做全量目录，不做语义筛选 —— `most-recent first` 是**排序键**而不是相关性打分。
2. **每条只给元数据**（路径 + 行数 + 字节数），**不给正文**。元数据的作用是让模型**判断值不值得去读**。
3. **有硬上限且服务端自带策略说明**：上限 5 条写在文本里（`up to 5`），模型看得到边界。
4. **正文靠工具拉**：`notes.read_file` / `history.*` 共 9 个端点。

⇒ **这就是「注入与库规模解耦」在 hint 层的具体形态**：笔记库可以无限增长，进上下文的那段恒定 ≤5 行 / ≤4000 字节。

**对 DSH 的提案（按同一模型，字段待确认）**

| 半 | DSH 候选内容 | 来源 | 备注 |
|---|---|---|---|
| **血统半** | 团队 id / 本会话角色 / `task_id` / `attempt_id` / 窗口序号 | 插件注入的 system prompt variable（**稳定**） | 与 Codex 的 `Agent name` + 三个 window id 同构；窗口序号由插件观察 `compaction/*` 自增 |
| **索引半** | 未完成任务清单（`team.json` 里 `status != completed` 的 task，给 `id` + `subject` + `assignee`） | 插件读 `team.json` | 对应 Codex 的「最近笔记清单」 |
| **索引半（续）** | 最近触碰的笔记文件（路径 + 行数 + 字节数） | 插件扫工作区笔记目录 | 对应 `- <path> (N lines, M UTF-8 bytes)` |
| **指针** | 笔记库路径 + `team.json` 路径 | 稳定字符串 | 让模型能自己拉 |

**需要你确认的两个设计点**（这两个 Codex 没给先例，因为它的库在服务端）：

1. **「最近触碰」的判据**：Codex 是笔记文件的**修改时间**。DSH 侧该用笔记文件 mtime，还是 `team.json` 里任务的更新时间，还是本会话最后一次 `read`/`write` 该文件的时刻？**三者语义不同**，且 DSH 有稳定文件路径而 Codex 只有虚拟路径。
2. **上限取几条**：Codex 是 5 条笔记 / 4000 字节。DSH 的未完成任务数可能远超 5（`team.json` 里任务可以很多）。是照抄「5 条 + 最新在前」，还是改成「**用 `agent_teams_status` 拉全量，hint 里只放计数器 + 路径**」？

> **边界声明**：Codex 索引半的形态来自**测试夹具**（间接证据）；它**没有文档**（全仓 `thread.hint|thread_hint` 检索 **0 命中**，`"Recent notes"` 字面量 **0 命中**）。**不得声称服务端只会产出这一种形态。**

---

## 4. 注入位的等价表（粒度对齐）

| 能力 | Codex 的粒度 | DSH 的粒度 | 是否等价 |
|---|---|---|---|
| hint（索引） | **窗口级**：换窗重建初始上下文时取一次 | **可做到窗口级**：插件观察 `compaction/*` 自增 → `assemble()` 渲染变 → `project()` 自动改写 | ✅ 等价，且**不需要后端** |
| 契约 / developer 指令 | **窗口级**：`build_initial_context_with_world_state` 重渲染（`session/mod.rs:4326-4345`） | **每步**：`assemble()` 每步跑，但**文本不变则零事件**；换窗后由 `contentGeneration` 变化触发改写 | ✅ 等价（DSH 更细，实际只有变化才落事件） |
| 笔记内容 | **拉取**：9 个工具端点 | **拉取**：读写工具读工作区文件 | ✅ 等价 |
| 每步动态内容 | Codex **无此机制**（不做每步刷新） | **可做**（消息 append），但推 / 拉在**事件数上中性** | Codex 不给先例；DSH 可自行选择 |

---

## 5. 本文档的自查记录（2026-10-12）

| 断言 | 核实结果 |
|---|---|
| Codex 侧行号：`tools.rs:25-28`、`:45`、`:99-101`、`:290-292`、`:311-313`、`:335-340`、`backend.rs:15`、`:48-54`、`:64-75`、`:76-87`、`extension.rs:31`、`:100`、`:122-134`、`:136`、`:140-147`、`:148-152` | ✅ 逐字命中（全部经 `Select-String` 精确定位，非目测） |
| `tools.rs` 端点字面量数量 | ✅ 去重后 **9 个**；`ALL: [Self; 9]`（`:45`）一致 |
| notes 单文件上限出处 | ✅ **`tools.rs:28`（`NOTES_DESCRIPTION`）**。⚠️ **本条曾经两次出错**：先误写 `:28`→ 又"修正"为 `:27`（那是 `HISTORY_DESCRIPTION`）→ 现改回 `:28`。教训：行号必须用 grep 定位，不能目测偏移 |
| `ToolName::namespaced` 出处 | ✅ `tools.rs:290-292`（`fn tool_name` 在 `:290`，调用在 `:291`） |
| DSH `read` 支持 `offset` / `limit` | ✅ `dsh-tool-fs`：`offset` = 「1-based first line to return」、`limit` = 「Maximum number of lines to return」 |
| DSH 工作区搜索工具存在 | ✅ `@deepseek-ai/dsh-tool-fs-search` 存在 |
| DSH `FS_STALE_VERSION` 版本守卫存在 | ✅ 2 处命中 |
| DSH `archive/` 目录概念存在 | ✅ `capabilities.ts:42` 显式 `continue` 跳过 `archive`；`index.ts:271` 有 `?archived=1` |
| 第 3 节第 9 行「DSH 无专用 append」 | ⚠️ **推断**（按工具清单推），**未实测** |
| hint 内容形态：`Recent notes (up to 5, most-recent first):` + `- <path> (N lines, M UTF-8 bytes)` | ⚠️ **测试夹具原文**（`tests/history_notes_extension.rs:48`），是**间接证据**——它证明客户端接受并期望该形态，**不等于**服务端只会产出该形态 |
| hint 拼接位：`Agent name` / `First|Current|Previous context window id` + hint，共用 `<context_window>` 标记，`role()=="developer"` | ✅ 源码直证：`core/src/context/token_budget_context.rs:41-73`（`body()` 在 `:58-73`，markers 在 `:50-56`，role 在 `:46-48`） |
| 四种失败形态（空 / 4001 字节 / 无 `text` / 受限网络不发出请求） | ✅ 源码直证：`tests/history_notes_extension.rs:334-372` |
| 用户告知项（子 Agent 有读写工具；本机 `cc` 路由不用缓存） | ⚠️ **用户口述，我方未独立实测**，仅在本文档中标注使用 |
| 全仓文档对 thread hint 的覆盖 | ❌ **零命中**（搜索范围：`docs/*.md`、`codex-rs/*.md`、`codex-rs/**/*.md`，正则 `thread.hint|thread_hint`；另搜 `**/*.rs` 的 `"Recent notes"` 字面量 → **0 命中**）⇒ **hint 的内容策略没有任何文档，只能靠夹具与客户端契约推断** |

**否定性结论的搜索范围**：
- 「DSH 无可调用的索引生成器」—— 依据为 DSH 侧无任何「返回 ≤N 字节索引」的端点；未逐个枚举全部 `@deepseek-ai` 包，**属推断**。
- 「Codex 9 个工具端点之外无其他 history/notes 端点」—— 搜索范围 `codex-rs/ext/history-notes/src/*.rs` 全部 endpoint 字面量 + `backend.rs` 的加密头路径列表，**已穷尽该扩展**；未验证是否存在其他扩展暴露同类端点。
