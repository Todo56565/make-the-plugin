# DSH 技能加载机制核对

> 2026-10-18。以 DSH 0.2.1-rc.2 编译后 JS 为准（包路径均相对 `@deepseek-ai/`），辅以 0.2.1-alpha.2 TS 源码。行号指编译后 JS。
> 起因：一份讲解图（技能书架 100–600、三种取正文方式、“只有菜单常驻”、插件端三种加载方式），逐条对照源码核对。

## 1. 逐条核对

### A. 书架优先级：部分正确

- 六个数字都对：100/200/300/400/500 在 `dsh-skill-filesystem/lib/index.js` L20-24；600 是 `dsh-skill` L23 的 `BUNDLED_SKILL_RANK`；运行时 `register` 的 250 在 `dsh-skill` L21。
- 三处更正：
  - **项目目录不是 cwd**：从 cwd 往上找 `.git`，用仓库根作为项目目录（`findProjectRoot` L810）。
  - **300 号不是“跟着 agent 走”**：`customSkillDirs` 只是 skill-filesystem 这个插件的配置（L35、L165）。只有某个 agent preset 用自己的配置挂载 skill-filesystem 时，才进入该 preset 自己的层（preset README 提到 creator mode 即如此）。
  - **“同名只认最靠前”只在同一层内成立**：注册表分全局层和 preset 层。同层按 rank 排（`collectLayer` / `compareIndexedCandidates`）；跨层时近层优先，直接覆盖（`collectFresh` L300 起，注释 L113-115）。所以 preset 层的 300 号技能可以盖过全局层同名的 100 号项目技能。

### B. 三种取正文方式：正确

- ① 模型调 `skill` 工具与 ② 用户输入 `/name`，输出的 `<skill_content>` 格式相同（`renderSkillContent`）。
- ② 在 `agent/pre-step` 扫描本轮用户消息里的 `/name`，空白分隔、出现在句中也算（`SKILL_GESTURE` L1101）。命中后另起一条 user 消息，追加在本轮新消息之后；只认 `userInvocable` 为真的技能（`dsh-tool-skill` 约 L925-958）。
- ③ UI 点选只是往输入框插入字面文本 `/name `（`dsh-client-ui-skill/lib/client.js` L469），与手打同一路径。
- ⑤ 正文末尾自带资源提示 “Base directory… Load referenced resources only as needed”（`renderResourceHint` L71）。

### C. “只有菜单常驻”：部分正确，“每轮”不对

- 菜单只有 `name: description`（描述最长 500 字，`whenToUse` 不放入；`catalogSourceEntries` L770），正文不在这层。
- 位置：菜单是一条用 `<system-reminder>` 包着的 **user 消息**，持久化进会话历史，**不在 system prompt 里**（`renderCatalogMessage` 约 L968）。
- 时机：每个 step 计算一次目录 sha256，与当前可见的已发布版本不一致时才发：
  - 第一次发完整目录；
  - 目录变化时在尾部追加 “catalog changed… replaces every earlier list”（`renderCatalogUpdate`）；
  - 压缩后旧菜单不可见时重发（`catalogHistory` L1051）。
- 只追加、不改写已发内容，对前缀缓存友好。

### D. 插件端三种加载：部分核实

- ① **正确**：`skills.register()` 进 250；`registerProvider()` 可自定 rank；或通过 skill-filesystem 的 `customSkillDirs` 进 300。之后与原生同一套菜单和加载方式。`registerProvider` 返回的 `control.invalidate()` 可触发目录重算。
- ② dsh-comfyui 的“披露阶梯”（自管 list 摘要 → skill 读 SKILL.md+清单签到 → read 逐文件 → 未签到 run 被拒）：**无法核实，本地无源码**。
- ③ hooks 推送（PreToolUse additionalContext，hooks-claude-code / hooks-codex）：**无法核实，本地无源码**。DSH JS、TS 和社区插件里都搜不到 PreToolUse、additionalContext。DSH 自己对应的机制是 `agent/pre-step` 消息注入（`dsh-time-context`、`dsh-repeat-tool-reminder` 在用）。

## 2. 对插件开发的启示

1. **中途注入内容不破坏缓存：照抄 tool-skill。** 在 `agent/pre-step` 里返回 `{ ...decision, messages: [...decision.messages, 新 user 消息] }`，只往尾部追加，不改已发消息；用 digest 去重，只在内容变化或压缩后重发；带自定义 `source.kind` 便于回读历史。常驻的菜单类内容也应放在**消息尾部并持久化**，不放 system prompt。
2. **中途“放开”内容，注册技能比加工具省。** `register` / `registerProvider` 挂上技能后 `invalidate()`，下一步只在尾部多一条目录变更提醒，前缀不动。新增工具会改变请求的 tools 字段；工具按 agent 和 scope 每步解析（tool-skill 用 `ctx.tools.get(name, agent)` 判断菜单是否要发），但 tools 字段在 DeepSeek 服务端缓存前缀中的位置源码看不出，**无法核实**，按常理推断会让整段缓存失效。
3. **system prompt 变化可能是追加。** `dsh-agent-loop` L231-238 的 `SystemPromptProjection`：路由支持时，变化的 system 文本追加在已缓存历史之后；不支持的路由才改写 node 0，缓存失效。取决于路由，不如第 1 条可靠。
