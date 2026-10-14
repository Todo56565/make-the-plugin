# 03 · 同一 dsh 进程内平级顶层对话之间的横向消息：四个社区插件合并评估

- 合并来源（已删除）：原 `03-dsh-conversation-link.md`、`04-dsh-agent-message.md`、`05-dsh-team-link.md`、`06-dsh-session-bridge.md`，评估日期均为 2026-10-14，四个插件都没装进真实宿主。
- 对照对象：`NanmiCoder/dsh-agent-teams` v0.1.23 @ `1094b84`；Claude Code [agent-teams](https://code.claude.com/docs/en/agent-teams)、[cross-session-messaging](https://code.claude.com/docs/en/cross-session-messaging)。
- 用户既有结论直接引用、不重写：宿主扩展点和"不可用接口"见 `Todo56565_make-the-plugin/docs/design/plugin-design.md` §3.1–3.4；成员工具策略和 `restrict` 时机见同文件 §5-2、§5-3；agent-teams 只支持到 0.2.0-rc.2 见 §0-2；会话日志的非弃用读取方式见 `docs/research/context-compare/community-plugins-survey.md` §3.2–3.3。
- 下文路径前缀：CL = `duanyunlun_dsh-conversation-link/`，AM = `GengDaPeng_dsh-agent-message/`，TL = `shenhuanageshei_dsh-team-link/`，SB = `heartmove_dsh-session-bridge/`，AT = `NanmiCoder_dsh-agent-teams/`（都在 `/workspace/work/` 下）。

---

## 1. 一句话结论

**四个插件都不继续改，只借鉴设计。** 它们做的都是 Claude Code 的 *cross-session messaging*（平级顶层会话互发消息），不是 *Agent Teams*。四者都没法以受支持的方式触达 dsh-agent-teams 的成员（成员是续聊子代理，AT `src/members.ts:2-5`、`:911`）：CL、AM、TL 显式拒绝子代理；SB 没有过滤，但只是用 `ctx.agents.get` 直接投递，会绕过团队邮箱，还会把消息伪装成用户消息。所以**"用户直接与成员对话"必须在 agent-teams 内部实现**（走它自己的邮箱和 attempt 校验，来源标注为用户），不能靠装这些插件补上。

---

## 2. 对比总表

| | conversation-link | agent-message | team-link | session-bridge |
|---|---|---|---|---|
| 版本 / commit | v0.4.3 / `afc20ae`（2026-09-17） | v1.6.0 / `7993288`（2026-08-31） | 0.5.2 + 未发布批次 C–L / `3b4e867`（2026-10-14），**未发布到 npm** | v0.5.2 / `c79a266`（2026-09-29） |
| 0.2.0-rc.2 兼容 | 没声明（无 peer/engines.dsh）。API 形状大致对得上；`kind:'plugin'` 和 `conversation/deleted` 未确认 | **不兼容**：`import { installSettingsSection }` 在加载阶段就报 SyntaxError（AM `lib/index.js:4`）；peer 写死 `<0.2.0` | 声明 `^0.2.0-rc.1`，包含 rc.2；测试用的 rc.2 模块组合能跑通 | 支持：peer 只写下限 `>=0.1.7-0`，devDeps 锁 rc.2，typecheck、build、smoke 都实测通过 |
| 挂载点 | 7 个工具、pre/post-execute、pre-step、`conversation/deleted`、client（DOM 改写） | 3 个工具、`agent/disposed`、settings、client（DOM 改写）；**不用** pre-step 和 system prompt | 11 个工具、2 个 pre-step、systemPrompt section/context、webServer 2 条路由、命令、client、定时器 | 15 个工具、定时器；没有 pre-step、prompt、web、client |
| 状态存储 | `$DSH_HOME/conversation-link/state.json`，原子写但**无锁** | 插件状态只在内存；回执靠目标会话日志里的 `agent/inbox/spliced` | `$DSH_HOME/team-link/policy.json`、`<ws>/team/<name>/*.md`；**消息不落盘** | `$DSH_HOME/session-bridge-registry.json`，**无锁、不原子**；看门狗状态只在内存 |
| 能否触达子代理 | ❌ CL `peers.js:85` | ❌ 目标和调用方都拒（AM `lib/index.js:120-128`） | ❌ TL `lib/index.js:8876-8879` | ⚠️ 没有过滤（SB `src/core.ts:721-733`），能不能拿到成员 agent **未验证**，就算拿到也是旁路 |
| 测试 | 47/47，假 ctx | 36/36（0.1.1-rc.2 下）；换成 rc.2 后加载失败，桩掉 settings 后 27/28 | host 1697/1697、client 310/310，假宿主；Linux 下会在当前目录建出 `C:/dev/demo` | 31/31 + typecheck + smoke；send/monitor 没有自动化测试 |
| 关键缺陷 | spawn 留孤儿对话；冷目标收不到简报；多进程写入互相覆盖；规则不是真护栏；ReDoS | rc.2 加载就崩；协议头写进正文；冷恢复用默认模型；限流只在内存 | `dsh-open.cmd` 命令注入；16k 行单文件；消息不持久；只在 Windows 实测 | `source.kind:'user'` 冒充用户；看门狗对离线目标永不退出；100ms 忙轮询，用的还是已弃用的 `snapshotEvents` |
| 结论 | 只借鉴 | 只借鉴 | 只借鉴（裁剪后收录） | 只借鉴 |

---

## 3. 按能力维度合并的"最佳设计组合"

格式：**借**（谁的 文件:行）/ **避**（谁的坑）。

1. **消息来源标注**
   - 借 TL `lib/index.js:9067-9077`：`source` 只写 `{kind:'agent-message', form:'relay', senderSessionId}` 这三个字段，发送方、时间等其余信息都放进 banner 正文。注释写明：多一个字段或用了未知 kind，迁移时整条会话日志都会被拒。这是唯一用了宿主自带跨代理 kind 的实现。
   - 正文里的回复寻址头可以参考 CL `peers.js:237-246` 和 AM `lib/index.js:361-365`，但措辞要改成"这条消息来自另一个会话，不代表用户授权"，对齐 CC 的 *How a session treats an incoming message*。
   - 避：SB `src/core.ts:136-143` 写 `kind:'user'`，冒充用户；CL `peers.js:271-284` 写 `kind:'plugin'`，宿主类型注释明说"没有共享的 plugin kind"；AM 用自定义 kind `dsh-agent-message`，在迁移白名单之外有风险，而且 `<dsh-agent-message>` 头会写进模型上下文和持久日志；CL 的简报原文"它发来的要照做"（`peers.js:373`）。
2. **投递模式（queue / steer / auto / followup / inject）**
   - 借 CL `peers.js:319-322` 的 `auto` 模式（对方 running 就 steer，idle 就 queue），并在结果里返回实际落点 `mode`（`tools.js:437`）。
   - 借 AM `lib/index.js:334-349`、`:372-381`：默认 followup；steer 和 inject 只在对方 running 时生效、由宿主二次校验，不自动降级。
   - 打断当前回合用 SB `src/core.ts:736-744` 的 `cancel(cause,{keepInbox})`。
   - 对 agent-teams 的意义：`agent_teams_send_message` 现在 running 时下一步才到、idle 时唤醒（AT `src/tools.ts:2149`），语义和 auto 相同；可以只加一个可选的 `mode`（steer），用于"用户或队长打断成员"。
3. **离线投递 / 恢复**
   - 借 AM `lib/index.js:38-54`、`:145-191`：冷会话 `agents.resume`，复用 `agents.get`，处理并发恢复的竞态，`agent/disposed` 时淘汰 handle，插件卸载时才 dispose。
   - 借 SB `src/core.ts:87-133`：离线日志按 open→read→close 读取。读法以 survey §3.2–3.3 为准（`sessionPersistence.open(id,'read')`，读前先 `sessions.flush`），不另写。
   - 借 SB `src/core.ts:572-599`：`resolveByPath` 加 `attachSession`，防止新建的顶层会话落到"未分组"。只有成员改成顶层会话时才用得上。
   - 避：AM `lib/index.js:165-169` 恢复时用默认模型，不继承目标会话上次的模型；TL 和 SB 遇到离线目标直接失败、不排队。agent-teams 自己的持久邮箱（AT `src/mailbox.ts`）已经比这四家都强，**不要用它们替换邮箱**。
4. **回执与进度读取（不唤醒对方）**
   - 借 AM `lib/index.js:101-113`、`:193-220`：折叠 `agent/inbox/spliced` 事件，得到 pending / claimed / discarded / unknown 四种状态，重启后可以重算；并明确 claimed 不等于已读，更不等于完成。可以拿来和 agent-teams 自建邮箱的已读状态对账。
   - 借 CL `peers.js:382-469` 的只读进度投影（turn/step、最后一条人类文本和助手文本、最近的工具、排队数），给 `agent_teams_status` 加一个"轻量查看某成员"模式。
   - 借 SB `src/core.ts:648-701`：只有 running 才可能 stalled，状态快照字段可参考。
   - 避：SB `src/core.ts:446-513` 每 100ms 全量快照轮询，依赖已弃用的读取接口（plugin-design §3.2 已列为禁用）；SB `reasoningTailOf` 名字叫"尾巴"，实际取的是开头（`src/core.ts:373-378`）。`notify_when_idle` 应该做成订阅 `agent/status`，不要轮询。
5. **接收方策略（ask / accept / reject）**
   - 借 TL `lib/index.js:1098`（`POLICY_MODES`），加上 trusted/blocked 名单、成对屏蔽、配对；没有确认服务时直接拒绝（`:8907-8920`）。落地时改成 CC 的 accept / hold / refuse，并补一个 hold 队列（TL 的 ask 是同步弹窗）。
   - 避：CL 建连不需要对方同意，`scope:'all'` 能跨工作区读别的会话最近 40 条（`tools.js:171-175`、`:505`）；AM 和 SB 没有任何接收侧控制。
6. **限流与去重**
   - 借 AM `lib/index.js:61-88`、`:370-385`：按无向会话对限流（60 秒内最多 10 条），失败时回滚预留名额。
   - 需要自己补：接收侧去重、按发送方限速、队列上限（CC 是 50）、防循环。限流计数要持久化，AM 的计数只在内存。
   - 避：CL 只靠"一切都是显式工具调用"来防环（`index.js:29-30`）。
7. **广播**
   - 借 TL `lib/index.js:8552-8554`、`:8846-8852`：`targets` 展开，加上 `team:<name>/*`；单次最多 8 个表达式、展开后最多 24 行，每个目标单独过门，截断时标注。
   - 定位：CC 官方没有广播（原文 "To reach everyone, send one message per recipient"），所以这是增强项，**不算缺口**，优先级最低。
8. **删除与清理**
   - 借 CL `index.js:223-239`、`store.js:479-492`：`conversation/deleted` 时清掉 handle、双向连接和规则。用于队长会话被删时清理团队状态。先确认 0.2.0-rc.2 里真有这个事件，原评估没找到。
   - 借 AM `lib/index.js:38-54`：卸载时统一 dispose。借 TL `lib/index.js:15924-15935`：定时器挂在 `ctx.effect` 上，卸载时一起回收。
   - 避：CL `tools.js:540-554` 先建会话、后校验昵称，冲突时留下孤儿；SB 看门狗遇到离线目标永不退出（`src/monitor.ts:193-201`、`:290-296`）。正确做法是先校验、后创建，失败就回滚。
9. **测试方式（假宿主）**
   - 首选 CL `test/plugin.test.mjs:22-100`：用 Proxy 复刻 Cordis "没 inject 就抛错"的语义，`register` 时校验 JSON Schema 子集，又轻又准。
   - 辅助：AM `test/agent-message.test.js:405-600` 覆盖冷恢复竞态；SB `scripts/test-peer-floor.mjs` 守护 peer 下限；SB `pnpm smoke` 把构建产物挂到桩 ctx 上，断言工具数量。
   - 避：TL 测试 1.5 MB 的单文件，还硬编码 Windows 路径（`host-half.test.mjs:51`）。四家都没有真宿主 E2E，借鉴后要补 0.2.0-rc.2 真宿主冒烟测试。
10. **其他零散可借**
    - TL webServer 路由要等 `webServer` 和 `connection` 都在才挂，方法白名单，Host/Origin 围栏（`lib/index.js:15590-15790`），可以拿来对照 AT `src/index.ts:261-493`。
    - AM 把发送准入写进工具描述，不加全局 prompt（`lib/index.js:280-292`）。
    - prompt 通道怎么选以 plugin-design §3.3 为准，不再从 TL 借。

**不借**：CL/AM/TL 的 client DOM 劫持（MutationObserver、模拟点击 disclosure）；CL 的"自声明规则"护栏；TL 的换届（rotation，约 4k 行）、forensics、`/team_session`、`dsh-open.cmd`；SB `src/registry.ts` 和整包内联 DSH 的打包方式。

---

## 4. 与 dsh-agent-teams 共存时的注意事项（如果真要同装）

- [ ] **把对等消息工具加进成员的 deny 列表**。agent-teams 内置的拒绝列表只有队长专用工具加深度项（AT `src/tool-policies.ts:31`、`:41`），成员默认能看到全局工具。部署方在 `toolPolicies` 里给成员加 deny：`conversation_send`、`conversation_spawn`（最好整组 `conversation_*`）、`session_bridge_*`、`team_link_send`、`team_link_watch`。AM 自己会拒绝子代理调用方（`lib/index.js:124-128`），可以不加。用 `allow` 型策略时反过来，不要列这些名字（规则见 plugin-design §5-2）。
- [ ] **不要交叉操作团队会话**：不要用 `session_bridge_send`、`session_bridge_cancel`、`session_bridge_archive {stopActivity:true}`、`session_bridge_monitor_*` 碰队长或成员会话，否则会绕过邮箱和 attempt，调度也会打架，团队状态感知不到。
- [ ] **防止成员逃出深度限制**：成员调 `conversation_spawn` 或 TL 的 `/team_session` 能建出新的顶层会话，绕开 `memberMaxDepth`。
- [ ] **单向通道**：CL 下成员给队长发消息会自动建连，但队长回复时会被 `isAddressable` 拒绝（CL `tools.js:429-431`）。这种组合不要用。
- [ ] **两套团队协议冲突**：同一个会话不要既当 agent-teams 队长又当 TL 协调者，两边都会注入团队 prompt（TL 自己的 `docs/comparison-agent-teams-2026-09-26.md` §6 也承认这一点）。
- [ ] **client slot**：TL 占了通用的 `conversation.chat.node` key=`context`（priority -100），agent-teams 以后想定制 context 节点的渲染会冲突。
- [ ] **pre-step 顺序**：CL、TL 和 AT `src/mailbox.ts:63-66` 都用"先 `await next()` 再改写"的写法，不冲突，但注入顺序取决于 loader 顺序，没在真宿主上验证过。
- [ ] 工具名、命令、路由在四家和 agent-teams 之间**都不冲突**，可以技术上同时挂载。AM 在 rc.2 上加载不了，同装无从谈起。

---

## 5. 是否放进 `_src-compare`：统一建议

**四个都收，裁剪后只作阅读对照**：不进构建或安装链，不挂载。每个目录附一份 `SNAPSHOT.md`，写明 commit、"仅对照"、本文 §6 的缺陷摘要，以及"不能触达 agent-teams 成员"。

| 插件 | 钉的 commit | 保留 | 去掉 |
|---|---|---|---|
| conversation-link | `afc20ae`（v0.4.3） | `index.js`、`peers.js`、`tools.js`、`store.js`、`test/plugin.test.mjs`、`package.json`、`LICENSE` | `client.js`（DOM 劫持）、`.git` |
| agent-message | `7993288`（v1.6.0） | `lib/index.js`、`docs/architecture-v2.md`、`test/agent-message.test.js`、`package.json`、`LICENSE`；注明"仅兼容 dsh <0.2.0" | `lib/client.js` 可去掉（只留复制 ID 按钮思路的话保留 `:232-259` 片段即可）、`.git` |
| team-link | `3b4e867` | `lib/index.js`、`package.json`、`cordis.patch.yml`、`LICENSE`、`docs/comparison-agent-teams-2026-09-26.md` | 1.5 MB 测试、`.investigations/`、会诊纪要、364 KB CHANGELOG、`lib/client.js`、**`dsh-open.cmd`、`register-protocol.ps1`（有注入风险，必须删）**、`.git` |
| session-bridge | `c79a266`（完整 `c79a2660ffc64800d698ca612fc4e4f0618f6b25`） | `src/`、`scripts/test-peer-floor.mjs`、`AGENTS.md`、`README.md`、`package.json` | `lib/`（598 KB 内联产物）、`.git`。仓库**没有 LICENSE 文件**，附说明："package.json 声明 MIT，来源 github.com/heartmove/dsh-session-bridge" |

---

## 6. 安全与缺陷汇总

**安全类（优先）**
1. **TL `dsh-open.cmd` 命令注入**：第 12 行 `echo ... raw=%~1 target=...%u%` 没加引号（第 13 行的 `start` 也拼了 `%u%`）。恶意网页上的 `dsh://session/x&calc` 链接一旦被点开，就可能执行任意命令。`register-protocol.ps1` 把它注册到 HKCU，不需要管理员权限。这是静态分析结论，没在 Windows 上实测。处理：不收录，不运行。
2. **SB 把消息伪装成用户来源**：`source:{kind:'user'}`（`src/core.ts:136-143`），接收方分不清真用户和另一个 agent，违反 CC "跨会话消息不能代替用户批准"。
3. **CL 的隐私和越权**：建连不需要对方同意，可以跨工作区读别的会话摘要；简报要求"照做"对方发来的内容；规则可以被模型自己撤掉（`tools.js:629-631`）；模型自写的 `/regex/` 每次工具调用都会执行，没有超时（`index.js:125-139`，ReDoS 风险）。
4. **AM 协议头泄露**：`<dsh-agent-message>{...}` 写进真实正文和持久日志，防注入只拒绝完全相同的字面量（`lib/index.js:328-330`）。
5. 四家都没有接收侧 hold/refuse（TL 的 ask 弹窗最接近），也都没有持久化的限流或防环。

**正确性 / 兼容类**
6. **AM 在 0.2.0-rc.2 下加载即报错**：`installSettingsSection` 和 `settingsNamespace` 已被移除；client 注入的 `@deepseek-ai/dsh-client-runtime` 在 npm 上没有 0.2.x 版本。
7. **CL 孤儿对话**：`conversation_spawn` 遇到昵称冲突时，会话已经建出来了（探针结果 created=1）；冷目标首条消息收不到简报（`tools.js:144-145`、`:423-434`）。
8. **状态文件并发写**：CL `store.js:172-174`、`:279-288` 和 SB `src/registry.ts:78-121` 都是整份覆盖、不加锁（SB 还不原子，读坏时静默当成空表）；TL 的策略文件每个进程只读一次、写回时整份覆盖，历史上因此出过"一次拉黑，全员发不出"。CLI 和 Desktop 共用 `~/.dsh` 时会互相覆盖。agent-teams 已有 `withTeamLock`，不要退回到这些写法。
9. **SB 看门狗**：遇到离线目标永不退出；状态只在内存；`doneKeywords` 实际上几乎不起作用（`src/monitor.ts:205-225`）。
10. **TL 可维护性**：16k 行单文件；没发布到 npm；backlog B-3（往已换届的旧会话投递）、B-4 没有关闭；测试会在当前目录建出 Windows 路径。
11. **CL/AM 的 client** 依赖宿主 DOM 标记，宿主 UI 一升级就可能失效。CL 的 `conversation/deleted` 事件、`kind:'plugin'` 能否通过 rc.2 的持久化校验，都需要真宿主确认。

**未验证、需真宿主确认的事项**：rc.2 是否有 `conversation/deleted`；`ctx.agents.get` 能否拿到成员子代理（决定 SB 能不能旁路成员）；dsh web 里用户能否直接在成员会话里输入；TL 的注入能否在 Windows 上实际触发。
