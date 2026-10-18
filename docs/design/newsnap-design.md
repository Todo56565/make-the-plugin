# newsnap：团队时间回溯 设计草稿

> 状态：**草稿，待用户审**（2026-10-18）。未写实现代码、未做 PoC。
> 定位：单独插件 newsnap（仓库 `Todo56565/newsnap`，目前为空；当前 GitHub 授权对它**只读、无 push 权限**，故草稿暂放本仓库），另对 dsh-token-budget 与 agent-teams 做少量适配。
> 源码基线：deepseek-harness `dsh-v0.2.1-rc.2`（`687f282e`）、dsh-agent-teams `v0.1.25`（`cf11157`）、dsh-token-budget `40c3054`（含 0.5.0 E1/E4）。下文 `包/文件:行` 均指这些版本。
> 构想与初步可行性见 [`future-council.md`](future-council.md)。

## 0. 结论先行

1. **宿主不能在运行中卸载普通会话**：会话控制器 resume 后丢弃了 `AgentHandle`，没有释放入口 → 0.1 版只做「**停机恢复**」：界面登记恢复，用户退出 DSH 后由 newsnap 命令行在离线状态下替换文件，再启动。
2. **不用宿主 fork**：fork 生成新会话，继承前缀里的摘要不计窗口，w 会回到 1；要求「w/e 完全一致」只能**原地替换会话日志**。
3. **agent-teams 从磁盘重建基本完整**，唯一例外是「已停靠的进行中 attempt」（只在内存）——重启后会被当作丢失而自动重派新 attempt。所以**拍照条件 = 全队空闲且没有 claimed/in_progress 任务**；不用 halt（halt 会把未完成任务全部改成 cancelled）。
4. **dsh-token-budget 有几项只在内存、会改变下一次请求文本**（回退兜底提示、待换窗请求、E1 子会话工具隐藏决定、常驻说明冻结值），需要适配：落盘到 `.context/state/sessions/<id>.json`。另外笔记的新鲜度看文件 mtime，**恢复必须连 mtime 一起还原**；agent-teams 质量闸门也看产物 mtime，同理。
5. **界面按钮可行**：照 agent-teams 的做法，用客户端插槽 `conversation.session.header.actions` 放按钮，服务端用 `webServer.register` 挂 HTTP 路由。宿主的 Typert remote 列表是固定装配，插件加不进去。
6. **缓存**：DeepSeek 官方只说「不再使用后通常几小时到几天清除」，尽力而为。恢复后前缀逐字相同即可命中；插件文本重建一致是前提。
7. **社区没有团队级回溯**：现有 DSH rewind 插件都只管单会话、不管子代理（详见 §11）。可借鉴 PerryLink/dsh-checkpoint-rewind 的工作区快照、Anionex/dsh-turn-rewind 的「还原前救援点 + 校验 + 中断续做」。

## 1. 调研证据

### 1a. 宿主能否运行中卸载 / 重载会话

- `AgentHandle.dispose()` 存在，但只给创建者：`@deepseek-ai/dsh-agent` `core/agent/src/index.ts:147-163`（"The disposer is a CAPABILITY … only the holder can tear this agent down"）。
- 会话控制器 resume 时只取 `.agent`，把 handle 丢了：`api/session-controller/src/agent.ts:440-444`（`(await this.ctx.agents.resume({...})).agent`），创建同理 `:569`。全文无空闲回收（`grep evict|idle|unload` 无结果）。⇒ **普通会话加载后活到进程结束**；只有卸载 agent-loop 工厂插件才会整体拆掉（`core/agent/src/index.ts:150-151`），影响全部会话，不可用。
- 写锁：`session/session-persistence-jsonl/src/lease.ts:1-28`，`session.lock` 上的内核 `flock`，进程退出即释放；同进程再开描述符也会冲突。⇒ 离线替换前**先自己拿锁**，拿到即证明没有宿主持有。
- 日志：每会话一目录、不可变「代」文件，选编号最高的代（`index.ts:1533-1567`；`generation.ts:1-8`）。根目录来自配置 `bundle/base/cordis.patch.yml:138-141`（`dshHomePath('sessions')`），目录名 `projectKey(cwd)`（`format.ts:225-245`）+ `encodeSegment(id)`（`format.ts:265`）。**初步结论 1 成立**。
- 投影缓存：`session/session-projection-cache/src/index.ts:1-16`，启动时整域读进内存，行只会「旧」（seq 落后）不会「错」；没有失效接口。恢复后日志变短，缓存行的 seq 可能**超前**于日志，必须删除对应记录（`<DSH_HOME>/storages/session_projcache/` 下该会话的文档）。且因为启动时已读进内存，**只能在宿主未运行时删**。
- 「启动前替换」挂点：bundle patch 只有 `insert`，看不到排序控制（`boot/app-boot` 内未找到 before/after）；插件 `apply` 是否早于 storage-json 初始化**无法核实**（循环两次无果）。⇒ 选**离线命令行**，不依赖启动顺序。
- 宿主 fork：`api/session-controller/src/commands.ts:220-240`，新建会话；dsh-token-budget 窗口号不计继承前缀里的摘要（`src/window/counter.ts:5-9,53`）⇒ fork 后 w 变化，不满足要求。

### 1b. agent-teams 从磁盘重建

- 只在内存：
  - `parkedAttempts`（`src/scheduler.ts:274-279`）：成员空闲但仍持有未结束 attempt 时「停靠」，防止被重派。注释明说「冷进程从空表开始，所以磁盘上的进行中 attempt 重启后会被恢复」。恢复 = `beginTaskAttempt` 开**新** attempt 并重新派单（`:356-410`），team.json 与成员对话都会多出内容。
  - `memberQueues`（`:273`）、`withTeamLock` 的 `locks`（`src/state.ts:59`）：瞬时队列，空闲时为空。
- 队长持有的任务在队长空闲边沿退回公共池（`scheduler.ts:497-520`）。
- 信箱投递有租约，崩溃 60 秒后可重试（`state.ts:53-54`）。
- 不按团队分的共享文件：`.agent-teams/retired-members.json`（`state.ts:55-56,297-335`，被移除成员的拒绝恢复名单）、`.agent-teams/archive/<teamId>/`（`state.ts:1165`）。
- halt：`src/tools.ts:531-561`，把所有非终态任务 `cancelUnfinishedTask` 并置 `halted`。⇒ 不能当「拍照前暂停」用。
- 成员会话是子代理会话（`header.origin === 'subagent'`，`api/session-controller/src/agent.ts:110-120`），由 agent-teams 冷恢复投递。
- **回退到有进行中任务的时刻**：重启后第一次 kick 会把它当丢失、开新 attempt 重派（attempt+1、新 attemptId），不是「回到那一刻」。因此拍照前置条件里排除这种状态（§3）。

### 1c. dsh-token-budget 只在内存、影响请求文本的状态（`src/index.ts`）

| 状态 | 位置 | 影响 | 处理 |
|---|---|---|---|
| `SwitchStates.fallback` | `src/window/state.ts:41-70`，用于 `index.ts:240-241` | 兜底期间预算提示是 `FALLBACK_PROMPT`，重启后变回普通提示 | 落盘 |
| `SwitchStates.newWindow / refused` | 同上 | 成员已请求换窗、尚未执行 | 落盘 |
| `SwitchStates.lastWrite` | 同上，`index.ts:145-150` | 交接里「笔记是否最新」 | 落盘 |
| `FrozenText`（常驻说明） | `index.ts` `sections` | 进程内首次算出即冻结；文本只取决于角色与开关，重启后通常相同 | 落盘冻结值（保险） |
| E1 `hideDecisions` | `index.ts` `agent/created` 监听（40c3054） | 普通子会话是否隐藏本插件工具，按会话 id 记第一次的决定，**只在进程内**；重启后按当时的 team.json 与祖先链重算，可能与第一次不同 → **工具列表变化，整段前缀缓存失效** | 落盘 |
| w1 交接（0.5.0 E4 后） | `agent/pre-step` 尾部消息 + 投影 `handoffSent`（eec7a8d） | 已写进日志、随重放恢复 | **无需处理** |
| `CompactionGate` / `compact.ts` 的 `attempted` | `src/budget/compact.ts:19-20` | 本窗口是否已尝试过压缩，重启后可能再试一次 | 落盘 |
| 合并失败计数 `failures` | `index.ts:532` | 只影响外接合并模型，不影响成员请求 | 不管 |
| `switching`、`TeamDirectory` 缓存 | `index.ts:104,99` | 瞬时 | 不管 |
| 笔记 mtime | `src/prompt/handoff.ts:46-49`、`notes/store.ts:98` | 新鲜度、「最近改动的笔记」排序 | 恢复时还原 mtime |

宿主侧机制（说明为什么落盘就够）：系统提示与运行时上下文都写进日志，重放后与新渲染比较，相同不产生事件（`core/agent-loop/src/runtime-context.ts:65-103`、`:113-155`）。所以只要插件重渲染的文本与当时一致，恢复后第一次请求与原时间线逐字相同；不一致时：system 文本在支持的路由上**追加到尾部**（不破坏前缀缓存，但 e 会多一号），否则替换首条（整段缓存失效）；runtime context 是所有 context 拼成的一段快照，任一项变化整段在尾部重发（见 0.5.0 E4 的分析）；**工具列表**变化则整段前缀失效，最严重。

### 1d. 插件能否给客户端挂接口

- 服务端：agent-teams 用 `ctx.get('webServer')` 的 `register({ kind, path, handler })` 挂 `/plugins/dsh-agent-teams/state`、`/halt` 等（`src/index.ts:51,246-337`），外包一层 `authenticatedWebRoutes` 校验连接（`src/web-routes.ts`）。
- 客户端：`slots.inject('conversation.session.header.actions', …)` 在会话头放按钮（agent-teams `src/client/index.tsx:94-97`）；斜杠命令 `ctx.commands.register`（`src/command.ts:87-90`）。
- Typert remote：客户端 `api/remotes/src/client/index.ts:185-198` 是写死的列表，插件加不进去。⇒ 用 HTTP 路由。

### 1e. 影子 Git

- Codex ghost commit 已于 2026-04-28 移除（PR #19481；本地 codex `cec8c6f` 已无 `ghost_commits.rs`）。原实现：在用户仓库内用临时 index 生成无分支提交；未跟踪文件 >10 MiB 或目录内 >200 个未跟踪文件不纳入；恢复用 `git restore --worktree`，删除快照后新增的未跟踪文件。
- Cline：`globalStorage/checkpoints/<cwdHash>/.git`，`core.worktree` 指向工作区，排除规则写进 `info/exclude`，嵌套 `.git` 临时改名。Roo：每任务一库，恢复 `git clean -fd` + `reset --hard`，发现嵌套仓库即禁用。
- 本设计选择见 §2.3。

### 1f. 缓存保留

DeepSeek 官方《Context Caching》（api-docs.deepseek.com/guides/kv_cache，2026-10-18 读取）：尽力而为，不保证命中；「缓存不再使用后自动清除，通常在几小时到几天内」；命中要求**完整匹配**某个缓存前缀单元（请求的用户输入末尾、模型输出末尾、固定 token 间隔处各生成一个）；用 `usage.prompt_cache_hit_tokens` 查看。⇒ 隔几小时以上再恢复很可能不命中，这是**功能正确性无关的成本问题**。

## 2. 快照内容与格式

### 2.1 范围（一支团队 = 一个「回溯单元」）

| 部分 | 内容 |
|---|---|
| 会话 | 队长会话、`team.json` 里全部成员会话，以及以它们为祖先的子代理会话（按 `header.parentSession` 递归，同工作区项目目录内） |
| 团队状态 | `.agent-teams/<teamId>/` 整个目录；`archive/<teamId>/`（若有）；`retired-members.json` 中**本队成员 id** 的有无 |
| 插件状态 | `.agent-teams/.context/` 整个目录（笔记、workspace.md 及其快照、pending、records、state） |
| 工作区产物 | 影子 Git 一个提交 + mtime 清单 |
| 宿主缓存 | 不入快照；恢复时删除这些会话的投影缓存记录 |

**选择**：`.context/` 与 `workspace.md` 是工作区级（跨团队），工作区文件更是。只回退一个团队却保留别人改动做不到。规则定为：快照记录「当时工作区内的其他活动团队与它们的会话」；恢复时若发现快照之后**有其他团队或非本队会话**写过工作区（§4.1 检查），拒绝恢复并列出原因，用户可勾选「仍然恢复」。不做按团队拆分合并（复杂且易错）。

### 2.2 存放位置与格式

```
<DSH_HOME>/newsnap/<projectKey(cwd)>/
  repo.git/                       影子仓库（bare），所有快照共用，对象去重
  snaps/<snapId>/
    manifest.json                 见下
    sessions/<sessionId>/<代文件名>  会话日志原样复制
    agent-teams.tar               .agent-teams/<teamId>、archive/<teamId>、.context（tar，保留 mtime）
  pending-restore.json            已登记、待执行的恢复
  rescue/<时间>/                  恢复前的救援点（结构同 snaps）
```

- 放在 `DSH_HOME` 下、不放工作区：不污染工作区，不被 agent-teams 工作区审计看到，也不会被自己的影子 Git 收进去。
- `snapId` = 时间 base36 + 4 位随机，人读名称另存。
- `manifest.json`：schema 版本；cwd；teamId、团队 `createdAt`（代）；拍照时间与用户备注；每个会话的 id、代文件名、字节数、sha256、最后 seq、窗口号（只作显示）；影子提交 hash；mtime 清单路径；其他活动团队列表；DSH / agent-teams / dsh-token-budget 版本（不一致时恢复只警告不拒绝）。
- 会话日志选**整份复制**：最简单可靠。按「前缀长度 + 哈希、恢复时截断」更省空间，但遇到代文件迁移会失效，留作以后优化。

### 2.3 影子 Git

- 位置：上面的 `repo.git`，用 `GIT_DIR=repo.git GIT_WORK_TREE=<cwd> GIT_INDEX_FILE=<临时>`，**不碰用户的 `.git`**，也不改用户 index。
- 收录：已跟踪 + 未跟踪文件；遵守工作区 `.gitignore`（借 `core.excludesFile` 与工作区 `.gitignore` 规则；用户仓库的 `.git/info/exclude` 也读）；固定排除 `.git/`、`.agent-teams/`（由 tar 单独收）、`node_modules/` 等常见大目录不另加（交给 .gitignore，避免与用户期望不一致）。
- 大文件 / 二进制：单文件 > `maxFileBytes`（默认 50 MiB）不收，记入 manifest「未收录」清单并在界面提示；二进制照常收（Git 能存）。不做 LFS。
- 嵌套仓库（子目录里有 `.git`）：当普通目录收文件内容，跳过其 `.git/`；不像 Cline 那样改名。
- mtime：Git 不存 mtime，另存清单 `path → mtimeMs`（只存收录文件），恢复后 `utimes` 还原（§1c、agent-teams `quality-gates.ts:1380` 依赖 mtime）。
- 快照后新增的文件：恢复采用 **exact** 语义——删除快照里没有、且未被 .gitignore 排除的文件（被忽略的文件不动，如构建产物）。删之前全部进救援点。
- 用户自己 `.git` 的状态（分支、index、提交）**不回退**，写进已知局限。

## 3. 拍摄流程

1. 入口：会话头按钮「拍快照」或 `/newsnap snap [备注]`，在队长或成员会话里都可，按 team.json 找到团队。
2. 前置检查（任一不满足即拒绝并说明，不等待、不 halt）：
   - 本队所有会话的 agent 状态都是 idle（`ctx.agents.get(id)?.status`；未加载的会话视为空闲）；
   - 无 `claimed` / `in_progress` 任务；无投递中的信（`claimMailboxDelivery` 未释放）；
   - dsh-token-budget 不在合并中（`shared/locks/merge.lock` 未被占）。
   **选择**：拒绝而不是自动等待——团队空闲往往就是队长在等用户，等待可能永远不结束；拒绝提示更可控。
3. 冻结：快照期间对本队所有会话注册 `agent/pre-step` 拒绝新步骤（agent-teams 也用这个钩子，`members.ts:646`），防止拍到一半有人开工。拍完立即解除。
4. 复制：会话日志（宿主持有写锁时也能读，锁只排斥写者，`lease.ts:6-9`）→ tar `.agent-teams` 相关部分 → 影子提交 + mtime 清单 → 最后写 `manifest.json`（写完 manifest 才算快照成立）。
5. 复制后复核：再读一遍各会话最后 seq，与步骤 2 时一致才提交；不一致丢弃并报错。

## 4. 恢复流程（0.1 版：停机恢复）

### 4.1 运行中：登记

1. 界面选快照 → 「恢复到此」或 `/newsnap restore <snapId>`。
2. 检查并展示：快照之后本队新增的会话（恢复后将移入救援点）、其他团队 / 会话在快照后对工作区的写入（看工作区文件 mtime 晚于快照、其他活动团队的 team.json 变化），若有则需用户勾选确认。
3. 写 `pending-restore.json`，提示「退出 DSH 后运行 `npx newsnap apply`，再启动」。

### 4.2 停机：`newsnap apply`（命令行，不依赖宿主）

1. 对每个涉及会话 `flock session.lock`；任一拿不到 = DSH 仍在运行，退出并报错，不做任何修改。
2. 建救援点：当前的会话目录、`.agent-teams` 相关部分、影子提交（当前工作区）——即「恢复前一刻」也是一份可恢复的快照。
3. 替换：会话目录内换成快照的代文件（删除更高编号的代）；快照后新增的本队会话整目录移入救援点；解 tar 覆盖 `.agent-teams/<teamId>`、`archive/<teamId>`、`.context/`；改 `retired-members.json` 中本队 id；工作区 `git restore` + 删除新增文件 + 还原 mtime。
4. 删除这些会话在 `storages/session_projcache` 的记录。
5. 校验：会话文件 sha256、tar 内文件、工作区与影子提交一致；全部通过后删 `pending-restore.json`，释放锁。
6. 每步写进度到 `pending-restore.json`；中断后再次运行从断点续做（步骤幂等）。

### 4.3 重启后

- 宿主按需 resume 会话，重放日志，w/e 与拍照时相同；agent-teams 从 team.json 读出空闲团队，无进行中 attempt，不会自动重派；dsh-token-budget 从落盘状态恢复内存（§6.1 适配）。
- 第二阶段（不重启）留待以后：需要宿主提供释放会话的接口，或 PoC 证明卸载重载 session-controller 可行；目前不做。

## 5. 界面与命令

- 会话头按钮（插槽 `conversation.session.header.actions`）：仅在团队会话中显示；点击弹出面板：「拍快照」+ 快照列表（时间、备注、各会话 w/e、大小）+ 每份的「恢复到此」「删除」；有待执行恢复时面板顶部显示提示与 apply 命令。
- 服务端路由（经 `webServer.register`，鉴权照 agent-teams）：`GET /plugins/newsnap/snapshots?session=<id>`、`POST /plugins/newsnap/snap`、`POST /plugins/newsnap/restore`、`POST /plugins/newsnap/cancel-restore`、`DELETE /plugins/newsnap/snapshots/<id>`。
- 斜杠命令同名同功能，作为无网页界面时的入口。
- 命令行：`newsnap apply | list | cancel`。

## 6. 适配

### 6.1 dsh-token-budget（独立有益：普通重启也受益；0.5.0 范围已定为 E1/E3/E4，这项需你决定放 0.5.0 还是之后）
- `SwitchStates`、E1 `hideDecisions`、`FrozenText`（常驻说明）、压缩 `attempted` 落盘到 `.context/state/sessions/<sessionId>.json`（符合 0.4.0 §2.3「会话级 `sessions/<sessionId>`」），启动时懒加载。这样快照收 `.context/` 就自然带上。
- 不需要知道 newsnap 存在。

### 6.2 agent-teams（上游 issue，用户自己发）
- 建议把 `parkedAttempts` 落盘（如 team.json 的 member 上记 `parkedAttemptId`），这样「重启 / 回退到有停靠 attempt 的时刻」不会被误判丢失。没有这项，newsnap 继续用 §3 的前置条件绕开。
- 不要求其他改动。

## 7. 失败与中断

| 情况 | 处理 |
|---|---|
| 拍照中某步失败 | 删掉未写 manifest 的目录；解除冻结 |
| 拍照中 DSH 退出 | 无 manifest 的目录下次启动清掉 |
| apply 中断（断电、Ctrl-C） | 按 `pending-restore.json` 进度续做；也可 `newsnap apply --rollback` 用救援点回到恢复前 |
| 校验失败 | 不删 pending，提示用救援点回滚 |
| 快照文件缺失 / 损坏 | 登记时即校验 manifest 与文件 hash，拒绝登记 |
| 版本不一致（宿主 / 插件升级过） | 警告，可继续；会话格式代号不同则拒绝 |

## 8. 存储与清理

- 设置项：保留份数（默认 20，按团队代计）、单文件上限（50 MiB）、救援点保留天数（7）。
- 删除快照：删目录；影子仓库按「仍被引用的提交」定期 `git gc --prune`（拍照后若超过阈值触发，不阻塞）。
- 团队归档 / 删除后的快照：保留，列表里标「团队已结束」，可手动删。
- 面板显示总占用。

## 9. 缓存保持

- 前提：日志逐字恢复 + 插件重渲染一致（§6.1）+ 运行环境相同（模型、工具集、技能菜单、其他插件的系统提示片段）。
- 其他插件若也有只在内存的动态文本，同样会在尾部追加差异；文档列为局限。
- PoC 里用 `prompt_cache_hit_tokens` 验证。

## 10. 已知局限

- 需要重启 DSH，且要多一步命令行。
- 用户自己的 `.git`（分支、提交、index）、`.gitignore` 排除的文件、超限大文件、工作区外的文件、外部副作用（已发的请求、部署、数据库）都不回退。
- 有进行中任务、或成员停靠中时不能拍。
- 同工作区多团队时只能整体回退工作区，需用户确认。
- 其他插件的外部状态（如 compact 类插件的 `~/.dsh/spill`、附件存储）不回退；附件是内容寻址只增不减，不影响。
- 会话全文搜索索引（可选功能）会残留快照后的内容，直到宿主重建。

## 11. 社区现状（避免重复造轮子）

详细报告：项目工作目录 `team-rewind-prior-art.md`。要点：
- 无团队级回溯。单会话类：SiriLee/dsh-rewind（★142，不追踪子代理编辑）、Anionex/dsh-turn-rewind（★133，BSD-3）、PerryLink/dsh-checkpoint-rewind（★25，Apache-2.0，用 fork 回退）。
- Enosensu/dsh-fork-relink（MIT）：fork 后给子代理建冷副本——走 fork 路线，不满足 w/e 一致，只借鉴其「写租约冲突、读最高代」经验。
- JJXjustin/dsh-session-rewind 默认排除 `.agent-teams`，正是我们必须收的部分。
- 借鉴：救援点 + 校验 + 中断续做（turn-rewind）；exact/merge 两种恢复语义（zjukop time-machine，我们只做 exact）。

## 12. PoC 计划（需用户同意；不调用模型的部分先做）

1. **离线脚本 PoC（不调模型）**：用现有一份旧团队会话目录或人工构造的日志，跑「拍照 → 追加 → apply」，验证 flock 判活、代文件替换、投影缓存删除后宿主能正常打开、w/e 显示一致、mtime 还原。
2. **宿主启动顺序**（不调模型）：确认插件 `apply` 是否早于 storage-json 初始化；若早，可把 apply 并入插件启动，省掉命令行步骤。
3. **一次最小真跑**（需你批准）：队长 + 1 成员，跑一个短任务后拍照，继续跑一步，退出、apply、重启，向队长发同一句话，检查 `prompt_cache_hit_tokens` 与 agent-teams 不重派。

## 13. 待你决定

1. 同工作区有其他团队时：本稿选「检测到即需确认、整体回退」，是否同意？
2. 有进行中任务时：本稿选「直接拒绝拍照」，而不是自动等待。
3. 0.1 版用命令行 `newsnap apply` 停机恢复，能否接受？
4. newsnap 仓库目前无 push 权限，是否给当前账号加权限，之后把本稿移过去？
