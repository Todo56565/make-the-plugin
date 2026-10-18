# 团队时间回溯（单独项目）

> 状态：构想 + 初步可行性分析（2026-10-18），未排期、未做 PoC。
> 定位：**单独项目**，不并入 dsh-token-budget 的 0.5.0。0.5.0 原 E2「队长 fork 后代识别」由本想法取代，暂不实现。

## 1. 想要什么

- 用户界面上一个按钮：点击后给**当前整个团队**拍一份快照。
- 点击某份快照：把整个团队**完整回退**到那一刻，约等于时间回溯：
  - 队长和全部成员的原始对话（DSH 保存的会话日志）一起回退；
  - 团队状态、任务、信箱、笔记、`workspace.md`、records 一起回退；
  - 工作区产物（代码等文件）一起回退；
  - 回退后的 w/e（窗口号/事件序号）与当时完全一样。
- 不需要「某方向已探索过、是死路」之类的提示，回退就是回到过去。

## 2. 快照内容

| 部分 | 位置 | 说明 |
|---|---|---|
| 原始对话 | `<DSH_HOME>/sessions/<工作区>/session-<id>/session.v4.jsonl.zstd` | 队长 + 全部成员（含成员会话）。日志只追加，恢复后 seq、压缩事件都一致，w/e 自然一致。`session.lock` 由宿主持有；`storages/session_projcache` 可删除让宿主重建 |
| 团队状态 | 工作区 `.agent-teams/` 整个目录 | team.json、信箱、归档，以及 dsh-token-budget 的 `.context/` |
| 产物 | 工作区文件 | 参考 Codex `git-utils` 的 ghost commit：用**影子 git 仓库**保存，含未跟踪文件，跳过 .gitignore；不碰用户自己的 git |
| 内存状态 | 宿主常驻 agent、agent-teams 调度、各插件内存（如换窗状态、冻结交接文本） | 不能直接保存；恢复后从磁盘重建。凡是影响下一次请求文本的内存状态，需要持久化进快照，否则缓存会断 |

## 3. 约束

- **拍快照必须全队空闲**：队长和成员都没有在请求模型、没有在跑工具，否则日志与产物对不上。做法：点按钮时等待空闲，或先暂停团队（agent-teams 有 halt）。
- **恢复必须先让这些会话离开宿主**：加载中的会话日志被宿主加锁、内存里有投影。
  - ① **重启后生效**：点恢复只登记请求；下次 DSH 启动、会话加载前替换文件。稳、简单，建议先做。
  - ② **不重启**：暂停团队 → 卸载相关会话 → 替换文件 → 冷恢复。需验证宿主能否卸载会话、agent-teams 能否干净地从磁盘重新加载（其已有冷 fork 恢复，可参考）。
- **UI 按钮**：客户端需要调用插件并取得快照列表，即插件能否挂自己的 remote 接口（宿主 `dsh-api-remotes` 挂载生成的 Typert contribution）。这与 future-ideas 中搁置的「客户端数据通道」是同一个问题，尚未调研。调研不通则退而用斜杠命令。
- 只回退本团队相关的会话和文件，不碰同工作区的其他会话。

## 4. 缓存

- DeepSeek 上下文缓存按请求内容的前缀匹配，与会话 id 无关。恢复后第一次请求与当时发过的前缀逐字相同，只要服务端仍保留那份缓存（尽力保留，一般几小时到几天，需复核官方说明），就能命中。
- 风险：插件每步注入的动态文本（预算提醒、冻结交接文本等）若只在内存，重建后可能有细微差异，从差异处往后不命中。解决：把这些状态一起放进快照。
- 是否命中需实测（看请求返回的缓存命中 token 数）。

## 5. 宿主与上游参考

- 宿主已有会话分支：`packages/api/session-controller/src/commands.ts` 的 `fork({ sessionId, atSeq })`；UI `packages/client/ui-chat/src/client/apply.ts` 的 `forkAt(seq)`（每轮底部「分支」）。只分支单个会话的对话，不回退文件和团队。
- 宿主会话持久化：`packages/session/session-persistence-jsonl`（含按字节截断的修复逻辑）。
- agent-teams `0.1.23`：队长身份跨 warm/cold、多跳 fork 保持（`src/lineage.ts` 的 `teamLeadMatch`、`nearestLiveLead`）。
- Codex：`codex-rs/git-utils` ghost commit（撤销用的工作区影子提交）。

## 6. 建议顺序（若立项）

1. 调研 + 手工 PoC：停掉 DSH，用脚本拍快照/恢复，确认 w/e 一致、agent-teams 能接着跑、缓存命中；同时查清宿主卸载会话接口与插件 remote 接口。一次小团队真跑。
2. 写设计文档。
3. 实现：先 ①（重启后生效），再考虑 ②。

## 附：给 agent-teams 的上游 issue 草稿（2026-10-18）

> 与时间回溯无关，按用户要求暂存于此。发往 https://github.com/NanmiCoder/dsh-agent-teams/issues ，由用户发帖。依据见 `docs/reference/dsh-skill-mechanism-applications.md`。

**标题**：建议：队长协议只在使用团队的会话里出现，普通会话不常驻

版本：dsh-agent-teams 0.1.25，DSH 0.2.1-rc.2

### 现象

- `agent-teams:usage` 这个 system section 对所有非成员会话都返回完整的队长协议（`capabilities.js` 约 L96-100，正文为 `index.js` 的 `usageSectionText`，约 4.8K 字符）。普通对话、普通子代理（例如 explore 子会话）即使从不使用团队，每个请求也都带着它。
- 14 个工具全局注册，只对成员禁用 10 个队长工具（`capabilities.js` 约 L84-87）。普通会话和普通子代理同样带着这 10 个工具的描述。

### 我们理解的约束

`installTeamCapabilities` 的注释写明：创建、归档团队都不能改写队长的 system/tools 前缀，因为任何普通会话之后都可能成为队长。下面的建议都不改动已发出的前缀。

### 建议

1. **协议改为激活时追加到尾部。** system section 只保留 `TEAM_ACTIVATION_PROMPT` 这一句（固定不变）。完整协议在 `agent/pre-step` 里追加为一条持久化的 user 消息：遇到 `/agent-teams` 手势（`command.js` 已有手势边界），或当前会话已经是某个团队的队长时追加一次；用自定义 `source.kind` 去重，压缩后不再可见时补发。做法与 DSH 自己的 `dsh-tool-skill` 发技能菜单相同：只往尾部追加，前缀不变，缓存不受影响。
   也可以把协议注册为技能（`ctx.skills.register`），普通会话只多一行菜单。
2. **普通子代理默认不带队长工具（可选配置）。** 在 `attach` 时一次性判定：子会话既不是成员、父会话也不是队长（按现有 `teamLeadMatch`）时，`restrict` 掉队长工具。若子会话按设计也允许自己建团队，可做成配置项，默认保持现状。
3. 如果担心行为变化，第 1 条也可以先做成配置项（例如 `usagePrompt: 'eager' | 'lazy'`，默认 `eager`）。

### 收益

每个不用团队的会话和子代理，每个请求约少 4.8K 字符的 system 文本和 10 个工具描述；使用团队的会话行为不变。
