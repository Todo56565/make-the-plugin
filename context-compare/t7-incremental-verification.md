# T7 — 增量独立核验报告：定稿版（t4 226 行 / t6 / README）

- 核验对象（只读，均未修改）：
  - `I:\VMsShare\context-compare\t4-mechanism-matrix.md`（定稿版，226 行 / 52,714 字节）
  - `I:\VMsShare\context-compare\t6-improvement-plan.md`（122 行）
  - `I:\VMsShare\context-compare\README.md`（50 行）
  - 交叉参考 `t5-verification-report.md`（基准 = t4 初版 116 行）
- 基准提交：Codex `a07c8ebd57feedc4cf5dfe854c8e9101de54186b`；插件 `1094b84add6f2fb19edf659367fe2fd5f7f14154`（v0.1.23）；宿主 `0.2.0-rc.2`
- 方法：每条断言回源逐字读取；附录片段用脚本做**逐字符比对 + 精确行号命中**（`t7-appendix-verify.ps1`）；全表引用做机械审计（`t5-anchor-audit.ps1`）。
- 结论先行：**定稿可用于决策**。发现 **3 处必须修正**（1 处行号 off-by-one、1 处自定格式未遵守、1 处 t5 修正未同步的回退），**无一处影响机制事实结论**。

---

## 0. t7 发现与 t5 结论的冲突/失效对照（合同点名项）

| # | t5 原结论 | 对定稿版是否仍成立 | 说明 |
|---|---|---|---|
| C1 | M15 的 Codex 侧"证据不足" | **已失效**（被定稿版正确取代） | t4 §5 附录 + M15 改写已补齐取证；t5 报告 §4 要求的"§4 证据边界表删除该条"已落实（t4:103-106） |
| C2 | "必须修正 5 处"（含第 5 处全表补 token 锚点） | **部分失效** | 第 5 处于 t6 §1 第 5 行**明确只做部分落实**并在 t6 §5.1 列为未完成待办；t5 §2 的其余 4 处于定稿中 3 处完全落实、1 处留下外围回退（见 F3） |
| C3 | "M12 依据链有错（默认值 vs profile 显式）" | 仍成立且**已修复** | t3:692-704、t3:827、t4:30、t4:50、t4:137 均改写为「profile 显式写入 `cordis.yml:1274`」 |
| C4 | 抽查 18 条的机制事实判定 | 仍成立 | 本次对定稿版的机械审计：引用文件缺失/越界 **仅 1 处**，且是 t4 引用 t5 报告文本的误报（t4:118），非死链 |
| C5 | （t5 未覆盖）M15 改写、§5 附录、t6 建议落点 | **不适用** | 均为定稿版新增，t5 明确未覆盖，即本次核验范围 |

---

## 1. 核验重点 (1)：M15 改写后的结论

**定稿原文分句逐条判定（t4:33；t4:51、t4:65、t4:224-226 为同一表述的复述）**：

| # | 分句 | 判定 | 证据 |
|---|---|---|---|
| 1.1 | "无按角色分档：`AgentRoleOverrides` 只含 `developer_instructions/model/model_reasoning_effort/model_reasoning_summary/model_verbosity/personality/service_tier/features/skills`，**无任何上下文窗口或压缩字段**（`role.rs:36-48`）" | **成立** | `codex-rs/core/src/agent/role.rs:36-48` 逐字 13 行，与定稿所列字段**完全一致**且不含 `model_context_window` / `model_auto_compact_token_limit` / retain 类字段；全仓仅 3 处 `AgentRoleOverrides`（`:37` 定义、`:80` 构造、`:180` 引用） |
| 1.2 | "**有子代理共享配置闸门**：`build_agent_shared_config` 在 `Feature::SubagentDefaultContextLimits` 启用时 `model_context_window = None; model_auto_compact_token_limit = None;`（`child_config.rs:132-141`）" | **成立** | `child_config.rs:132` 函数定义、`:135-141` 覆写、`:114`/`:125` 两个调用方；引用写法「函数 `:132-165`」为拓扑范围，不含造假事实 |
| 1.3 | "该 feature `default_enabled: false`（`features/src/lib.rs:1481-1486`）" **且** t4:226 明确"**默认关闭**"、t6:35 明确"有闸门但默认不生效，不是现成就在按成员分档" | **成立（限定无条件到位）** | `features/src/lib.rs:1481-1486` 逐字 `stage: Stage::UnderDevelopment` + `default_enabled: false`；t4 M15 适用性列、t6 建议 1、README §1.2 三处**均带该限定**，未出现"Codex 有分档预算"的写法 |
| 1.4 | "同一模式在跨模型评审复现（`guardian/review.rs:151-153`）" | **部分成立** | 事实正确（`review.rs:151-153` 是 `if review_model.model != context.model_info.slug {` + 两行 `None`），但代码块**含第 154 行收尾 `}`**，正确区间是 `:151-154`（见 §2 F1） |
| 1.5 | "DSH 宿主**无分流，且不感知 agent 维度**：全文对 `origin/delegationDepth/parentSession/subagent` 命中 0（2 处为文案误命中）" | **成立** | `dsh-compaction-basic/lib/index.js`（1027 行）：`delegationDepth` 0 / `parentSession` 0 / `subagent` 0 / `isSeeded` 0 / `origin ===` 字面 0；`origin` 子串 2 处均为文案（L249 摘要模板、L880 错误文案） |
| 1.6 | "**共同空白**，差异在'配额覆写闸门的有无'"；分类 = ①同一问题不同解法 | **成立** | 由 1.1–1.5 合成；分类从 ③ 改判为 ① 与 t4:65 的说明自洽，且 t4:128 在修订台账中留痕 |
| 1.7 | 反向检查：是否被写成"Codex 有分档预算" | **未被写歪** | 全文检索 t4/t6/README，无该表述；t4:226 明确"差异在'**配额覆写闸门的有无**'，不在'是否分档'" |

**核验重点 (1) 小结：M15 改写成立**，唯 1.4 的行号区间需从 `151-153` 改为 `151-154`。

---

## 2. 核验重点 (2)：§5 附录逐字片段

脚本 `t7-appendix-verify.ps1` 对 5 个 `rust` 代码块做**逐字符比对 + 严格定位到被引用行号**（不是"文件里存在"）：

| 片段 | 引用 | 比对结果 | 片段行数 ≤15 |
|---|---|---|---|
| 5.1 `child_config.rs:135-141` | `:135-141` | **VERBATIM@CITED-POSITION** | 7 ✅ |
| 5.3 `role.rs:36-48` | `:36-48` | **VERBATIM@CITED-POSITION** | 13 ✅ |
| 5.4 `lib.rs:1481-1486` | `:1481-1486` | **VERBATIM@CITED-POSITION** | 6 ✅ |
| 5.5 `child_config.rs:142-145` | `:142-145` | **VERBATIM@CITED-POSITION** | 4 ✅ |
| 5.2 `review.rs:151-153` | `:151-153` | **VERBATIM 内容一致，但位置区间 off-by-one** | 4 ✅ |

- **F1（低-中，必须修正）**：`t4:163` 的引用区间 `codex-rs/core/src/guardian/review.rs:151-153` 与 `t4:33`、`t6:35` 的同一引用**均少一行**。正确事实：`review.rs:151-154` 才是完整块——
  ```rust
  151:    if review_model.model != context.model_info.slug {
  152:        spawn_config.model_context_window = None;
  153:        spawn_config.model_auto_compact_token_limit = None;
  154:    }
  ```
  附录代码块**逐字完整**（含 `}`），只是引用区间没跟上。改法：三处 `151-153` → `151-154`。
- 另核：t4:159 声明"仓库内无该 feature 的文档"——`features/src/lib.rs:1481-1486` 确无 doc 注释，`SubagentDefaultContextLimits` 全仓仅 3 处出现（枚举 `:231`、spec `:1481-1486`、`child_config.rs:137` 使用点）；该"不推断产品意图"的边界声明**成立**。
- 另核 t4:194 的量化学断言：非测试代码中 `model_auto_compact_token_limit` 的赋值点**只有 `child_config.rs:140` 与 `guardian/review.rs:153` 两处**（其余 70+ 处全在 `*/tests*`、`guardian/tests.rs`、`step_settings_tests.rs` 或 `Some(...)` 测试构造中）⇒ **成立**，这条正是"无按角色分档"最强有力的否定证据。

---

## 3. 核验重点 (3)：t5 §2 五处修正在定稿中的落实情况

| # | t5 要求 | 定稿状态 | 证据 |
|---|---|---|---|
| 1 | t3 profile 依据改写 | ✅ **已落实，无回退** | `t3:692-704`「本机实际解析为 spawn 的依据不是'走了默认值'，而是 profile 显式写入」+ `cordis.yml:1270-1274` 代码块；`t3:827` §8 表同步；`t4:30`、`:50`、`:133`、`:137` 同步 |
| 2 | M16 引用区间 | ✅ **已落实** | `t4:34`：action 枚举 `tools.rs:37-41`、name/namespace `:71-82`、`tool_name()` `:290-292`、上限在 `:28`；与源码逐字对照一致（notes 5 个 action 在 `:37-41`，`:28` 是 `NOTES_DESCRIPTION`） |
| 3 | M17 `read_item` 死指针 | ✅ **已落实** | `t4:35`：schema `tools.rs:166-176`、required 在 `:175`，并写明全文件 `read_item` 字面仅 `:75`（名称映射）与 `:89`（endpoint）——回源核对**全部正确** |
| 4 | M6 定义/调用点 | ⚠️ **主表已落实，类别④留下回退**（见 F3） | `t4:24`（主表）已写"**定义** `compact.rs:574`、**调用** `:384`、透传 `:386`→`:677-688`" ✅；但 `t4:72`（类别④）**仍写** `compact.rs:574,677` 并称"注释过的用户消息集合"，语义回到修订前 |
| 5 | 全表补 token 锚点 | ⚠️ **按 t6 声明为部分落实**（非隐瞒） | `t6:20` 标"⚠️ 部分落实"、`t6:22` 给出理由、`t6:112` 列为待办、README:47 同步标注"全表 132 处历史引用未逐一补锚点" |

**F3（低-中，必须修正）**：t4 类别④第 1 条（`t4:72`）与 t4 §4.2 修订台账（`t4:136`，写明已改为"定义 `:574` / 调用 `:384` / 透传 `:386`→`:677-688`"）**自相矛盾**。同一份文档两处对同一个引用给出不同写法，属"修正未同步"。改法：把 `t4:72` 的 `compact.rs:574,677` 改为 `compact.rs:574`（定义）与 `:384`（调用）。

---

## 4. 核验重点 (4)：t6 改进建议的落点真实性

| 建议 | 声称落点 | 回源结论 |
|---|---|---|
| **1** 子代理维度降档闸门 | **宿主压缩栈** `dsh-compaction-basic/lib/index.js:128-134`；并明言"插件层不是可行落点（不持有该公式、也没有压缩栈的注入句柄）" | **成立**。① `lib/index.js:124-134` 确是 `resolveCompactSpec` 的 `thresholdTokens`/`retainTokens` 计算处；② 该文件对 agent 血缘维度**零命中**（§1.5）；③ 插件侧 `src/**.ts` 对 `ctx.compaction` **0 命中**，且 `package.json` **无 `dependencies` 字段**（仅 35 个 devDependencies）⇒ 插件确实拿不到压缩句柄，落点必须在宿主/上游 |
| **2** 收敛队长收件箱正文 | **插件层** `src/tools.ts:2405-2409`（+可选 `mailbox.ts:22-25`） | **成立**。`tools.ts:2405-2409` 逐字 `captain_inbox: captainInbox.slice(0, 10).map((message) => ({ from, content: mailboxContent(message), ts }))`；`:2415-2421` 同批 id 全量 ack；`mailbox.ts:22-25` 仅前置标签不截断正文 ⇒ 问题描述与改法都指向真实代码 |
| **3** 用户原话保留配额 | **宿主** `lib/index.js:128-134`（`retainTokens`）与 `:927-934`（溢出路径先 prune 再选区间） | **成立**，且**必带口径限定已带全**（`t6:59`：20k 仅本地文本压缩；远程 v2 为 64k/单条 10k） |
| **4** 契约压缩后可廉价重读 | **插件层**，引用 `tools.ts:2842` 的 300 字符 output 截断 | **成立**。`tools.ts:2842` 逐字 `task.output.slice(0, 300)`；`capabilities.ts:56-59`、`scheduler.ts:225-241` 亦核对存在 |
| **5** 压缩失败/溢出救援可观测 | **宿主** `lib/index.js:861-872`、`:927-934` | **成立**。`:861-872` 是 `agent/request-error` + `CONTEXT_WINDOW_EXCEEDED_CODE` 分支；`:927-934` 是 overflow 先 prune、重测、选区间；t3 §9 第 3 项确记"是否发生过 `context-overflow` 救援**无独立落盘证据**" |
| §3 不建议照搬 4 条 + "照搬无效" 1 条 | 各附 Codex 行号 | **成立**。`turn.rs:1473` 分流、`compact_remote_v2.rs:78-79` 与 `:499`、`tools.rs:181`/`:166-176`/`:175`、`extension.rs:30-31`/`:140`/`:46-52`、`get_context_remaining_spec.rs:8`、`spec_plan.rs:1401-1404`、`features/src/lib.rs:1889-1894`、`turn.rs:1304,1316`/`:609,621`/`:719-737`、`config/mod.rs:4355-4357`、`dsh-compaction-basic/lib/index.js:839` —— 逐一命中 |
| §2 建议 3 的"输入" | `dsh-session-persistence-jsonl/lib/types/format.d.ts:38-53`（称 header 已具备 `origin`/`delegationDepth`） | **成立**。`:42-53` `interface HeaderLine` 含 `parentSession?`、`isSeeded`、`origin?: 'subagent'`、`delegationDepth`、`agentPreset?` ⇒ "截面选择器可用的维度已存在"这一前提为真 |

**约束声明核验**：t6:37 / t6:113 / README:49 均声明建议 1/3/5 的落点是第三方 npm 包、本机不宜改写构建产物、**未声称已实现**；t6:114 声明建议 2/4 只是设计说明、未改任何插件源码。全程核对被测两仓 `git status` 与本轮只读操作一致：**未发现"把设计写成已实现"的表述**。

---

## 5. 核验重点 (5)：t3 的 4 项 UNVERIFIED 是否被当作已生效断言

- `t4:107` 完整照抄 4 项（pruner 真实触发为 0；压缩前后压力对比不可得；`context-overflow` 救援无独立落盘证据；`image-offload` 阈值未取证），并明令"**禁止**在本表基础上断言 pruner/溢出救援在本机实际起过作用"。
- `README:48` 再次标注"62 条 spill notice / 18 处截断 / pruner 真实触发 0 次"均为**运行态观测**，不可当规范常量。
- 抽查 M4/M9 行（`t4:22`/`t4:27`）：均只陈述"机制存在 + 运行态未观测到触发"，未把 UNVERIFIED 说成生效；`t4:22` 写明"pruner 在 56 个会话中未观测到真实触发（t3 §4.2 UNVERIFIED→收敛）"。
- **结论：未发现残留误用。** 唯一需要注意的是 t6:77 把"26 次压缩 1 次失败（额度不足）"当运行态事实引用——该数值来自 t3 §2.3 脚本统计，t3 与 t6 均标明为运行态，**不违反口径**。

---

## 6. 船长交办的 3 条锚点更正：独立复核结果

| 船长的说法 | 我的复核 | 判定 |
|---|---|---|
| `memberProvider` 在整个 profile 目录树只有两处，且都在插件包自身（`cordis.yml:1274`、`profiles/web/node_modules/@nanmicoder/dsh-agent-teams/cordis.patch.yml:21`）；此前写的 `dsh-web-app\cordis.patch.yml:21` 是错的 | **两者都成立**。`profiles/web` 全树 277 文件检索 `memberProvider`：4 处命中——`cordis.yml:1274`（`memberProvider: spawn`）、插件 `cordis.patch.yml:21`（同行内容，注释注明 `'spawn' or 'fork'`）、插件 `lib/index.js:60`（`z.string().default('spawn')`）与 `:121`（`?? 'spawn'`）。`dsh-web-app\cordis.patch.yml:21` 实际是**空行**（该 patch 的 `personaPrefix/personaSuffix` 在 `:18-20`）⇒ 船长自纠**正确** | ✅ 成立 |
| captain 协议块正确锚点是 `src/index.ts:179`（`return \`AgentTeams captain protocol:`），整块 `:179-190`；我在 README 写的 `:185` **不对**，应列为必须修正 | **前半成立、后半不成立**。`:179` 确为 `return \`AgentTeams captain protocol:`，`:190` 为 `Tools: ${toolNames}...` ⇒ 整块 `:179-190` **正确**。但 README:9 的鉴别特征是 `every takeover is one ready task at a time` 与 `never yield with captain-owned work open`，**这两条短语都在 `:185`**（协议第 6 条），`:189` 才是第 10 条。故 README 用 `:185` 精确锚定这两条短语**没有错**，**不应列为必须修正**；建议只作清晰度增强（可写成 `:179-190 中的 :185`） | ⚠️ 部分成立 |
| 三个实验版包对两段协议文本零命中；NanmiCoder 插件 `src/index.ts:179-190` 逐字命中 | **成立**。以 `.js/.cjs/.mjs` 检索 `Deployment requires explicit user confirmation` 与 `Wait for all required tasks to be terminal`：`dsh-experimental-agent-team`（19 个 js 文件）、`dsh-experimental-tool-agent-team`（1）、`dsh-experimental-client-ui-agent-team`（2）、以及 `-profile`（1）**四包全零命中**；插件侧 `src/index.ts:188`/`:189`（`lib/index.js:114`/`:115`）逐字命中 | ✅ 成立 |

---

## 7. 其他发现

- **F2（低，必须修正）**：`t4:6` 自定规则"凡引用 §5 附录的格，都在格内标注'来源：§5'"，但 M15 单元格（`t4:33`）写的是"**来源**：本格证据由船长补充取证提供……"——**没有**出现字面 `§5`（同文档 `t4:104` 才写了"来源：§5 附录"）。属自定格式未遵守，建议 `t4:33` 补 `§5` 字样。
- 结构自检（脚本）：`t4` 共 226 行、19 行 `M*` 主表行、7 列表头齐全；机械引用审计对该版 t4 报"越界/缺失 1 处"，经查为 `t4:118` 引用 `t5-verification-report.md` 文本（正确文件名，审计脚本的 bare-name 解析误报），**非死链**。
- README 与 t6 的文件清单/命名说明一致（`t7-incremental-verification.md` 已列为待产出核验件，本文件即其交付）。

---

## 8. 总体判定

**定稿（t4 226 行 + t6 + README）可用于决策。** 理由：

1. **机制事实层**：M15 改写（1.1–1.7）、§5 附录 5 段逐字证据、t6 建议 1–5 的落点、§3 不建议照搬清单，**全部回源成立**；t6 的"默认不生效"限定、第三方包约束、"未声称已实现"声明均无条件到位。
2. **引用层**：3 处待修正均不影响任何机制结论 ——
   - **F1** `review.rs:151-153` → `151-154`（t4:33、t4:163、t6:35 三处）；
   - **F2** `t4:33` 补"来源：§5"字样以符合 `t4:6` 自定规则；
   - **F3** `t4:72` 的 `compact.rs:574,677` 未同步主表修订，与 `t4:136` 台账自相矛盾，应改为 `:574`（定义）/`:384`（调用）。
3. **口径层**：t3 的 4 项 UNVERIFIED 未被当作生效断言；运行态数值处处标注来源；无"已实现"虚报。
4. **t5 失效范围**：仅"5 处必须修正"中的第 5 处（全表补锚点）对定稿版**部分失效**（已被 t6 显式降级为待办）；t5 的 M15"证据不足"、M12"依据链有错"两条结论均**已被定稿版正确取代或修复**。t5 对定稿版的 §5 附录、M15 改写、t6 建议落点**无覆盖**，以本报告为准。

**优先级建议（若只修一处）**：先修 F1（3 处 `151-154`）——它是唯一"引用区间与逐字内容不匹配"的硬伤；F3 次之（同文档自相矛盾）；F2 再次（格式规则未遵守）。

---

## 9. 复现方式

- `pwsh -NoProfile -File I:\VMsShare\context-compare\t7-appendix-verify.ps1`
  → 输出 5 个 rust 代码块在**被引用行号处的逐字命中**结果（5.2 报 `range-length mismatch`，即 F1）。
- `pwsh -NoProfile -File I:\VMsShare\context-compare\t5-anchor-audit.ps1`
  → 定稿版 t4 的 132+ 处引用机械审计（唯一"缺失"为 `t5-verification-report.md` bare-name 误报）。
- 关键反证命令（本次实际使用）：
  - `Select-String -Path ...\review.rs -Pattern 'model_auto_compact_token_limit'` → 命中 `:153`；`:154` 为块收尾 `}`
  - `Select-String -Path ...\dsh-compaction-basic\lib\index.js -Pattern 'origin ===' -SimpleMatch` → 0
  - `Get-ChildItem profiles\web -Recurse | Select-String 'memberProvider'` → 仅 `cordis.yml:1274` + 插件包内 3 处
  - 四实验版包 `Deployment requires explicit user confirmation` → 全零命中
