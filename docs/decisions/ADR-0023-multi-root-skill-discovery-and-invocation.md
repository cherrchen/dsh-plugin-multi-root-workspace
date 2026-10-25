# ADR-0023: 附加根 Skill 发现、命名空间与按需调用

## Status

Accepted（2026-10-23，源码审查与架构原型验证后定案）

接受的是产品规则和下述实现方案。生产实现已落地并随 `v0.1.10` 发版；原型验证与生产验收分别记账。原 Proposed 中的 Session 绑定、内部 ID、Settings、迁移与加载生命周期问题已有明确方案；额外发现的 Effective CWD 原生发现旁路也纳入决策。源码事实见[接缝调研](../reference/multi-root-skills-seams.md)，实际执行结果与未覆盖范围只记[路线账本](../plans/active/2026-09-12-multi-root-workspace.md#multi-root-skills-架构验证2026-10-23)。最终验收与发布准备按[开发计划](../plans/completed/2026-10-23-multi-root-skills.md)完成，不能把架构原型通过写成功能已完成。

## Date

2026-10-23

## Context

[Issue #17](https://github.com/cherrchen/dsh-plugin-multi-root-workspace/issues/17) 报告：以 A 为主根、B 为附加根时，B 的 `.dsh/skills` 不进入原生 Skill Catalog 或 Slash Menu；以 B 新建会话则可以发现。现有插件为附加根补充了指令、LSP 和文件浏览，但尚无 Skill 发现行。文件访问许可与项目能力发现是不同的范围，不能仅因工具能够读取 B，就假定上游会把 B 的 Skills 当作该会话的项目能力。

本次拟增加附加根的原生 Skill 发现与按需调用。与 [ADR-0010](./ADR-0010-additional-root-instruction-scope.md) 的指令投递不同，Skill 首轮只提供名称、描述等目录元数据，正文在调用时加载；不依赖成功文件 touch 或 `working_directories()` 后才发现。

Issue 原提案建议默认关闭、主根优先处理同名，并预期 SkillProvider 可直接覆盖原生 Slash Command。后续产品讨论改为按登记权限初始化布尔开关、始终使用 Root 命名空间，并为 Web 提供独立补全与 Host 调用解析。本文采用后续规则，保留 Issue 作为问题来源。

本次以全部受支持 tag 的源码审查与开发 pin 的发布包原型检验接缝。源码定位、差异和公开 API 边界统一见[接缝调研](../reference/multi-root-skills-seams.md)；原型不修改上游，也不注册为生产插件。外部 CLI 仅为讨论背景，不构成本插件的兼容性或安全依据。

## Decision

### 1. 发现范围与首轮行为

- 仅从已登记、可用且启用 Skills 的附加根发现 `.dsh/skills` 和 `.agents/skills`。
- 范围由 Session Origin / Primary Root 决定，遵循 [ADR-0012](./ADR-0012-session-origin-and-effective-cwd.md)，不随 Effective CWD 改变。
- 启用根的 Skill Catalog 必须在首次模型步骤前可用；首轮不完整注入 `SKILL.md` 正文，也不自动执行 Skill。
- 优先复用原生 SkillProvider、`skill` 工具和按需加载能力，保留 `modelInvocable` / `userInvocable` 策略。两种发现目录内的元数据解析、同根同名优先级和异常文件处理须核对原生规则，不另起一套未经验证的解析语义。
- 不修改上游 `packages/**`；草稿高亮的已知限制不构成修改上游 `ui-conversation` 的理由。

### 2. Root Skill 开关

Registry 新增持久化布尔字段 `skillsEnabled`，只允许 `true / false`，不引入第三态 `auto`。新增 Root 按**登记权限**一次性初始化：

```ts
const skillsEnabled = access !== 'read-only'
```

| 登记权限 | 新增 Root 的 Skills 默认值 |
| --- | --- |
| `inherit` | 开启 |
| `read-write` | 开启 |
| `read-only` | 关闭 |

用户可以手动切换，包括为只读 Root 开启 Skills。该开关只控制 Skill 能力，不改变该 Root 的读写权限。

| 操作 | `skillsEnabled` 结果 |
| --- | --- |
| 手动切换 Skills | 持久化用户选择 |
| 实际修改 Root 登记权限 | 重置为新权限对应的默认值 |
| 显式设置与当前相同的登记权限 | 保留用户选择，不触发重置 |
| 普通会话 SandboxMode 改变 | 保留用户选择 |
| revive 不指定权限，或显式指定相同权限 | 保留用户选择 |
| revive 显式改为不同登记权限 | 重置为新权限对应的默认值 |
| 修改显示 Alias、排序、刷新或目录暂时不可用 | 保留用户选择 |

例如 `inherit + Enabled` 改登记权限为 `read-only` 后变为 Disabled；用户随后可以手动改回 Enabled。删除登记后重新新增按新增规则初始化；不能将其与保留稳定 Root 身份的 revive 混同。

### 3. 全局开关与配置入口

新增 `multi-root-skills` Host 行，其 Config 的 `enabled` 默认为 `true`。这里的 `enabled` 是功能配置，不是禁用整个 Multi-root Workspace bundle。

逻辑发现条件为：

```ts
function canDiscoverSkills(globalEnabled: boolean, root: RootStatus): boolean {
  return globalEnabled && root.state === 'available' && root.skillsEnabled
}
```

此式以可信 Session、可用 Registry Authority、兼容与 provider 门禁通过为前提，不能拿一个客户端 Root 对象直接作为授权证据。全局关闭不改写任何 Root 的持久化选择；重新开启后各根恢复原值。全局与 Root 开关均只影响附加根 Skills，不影响主根原生 Skills、`AGENTS.md`、LSP、文件浏览或既有沙箱权限。

| 设置 | 入口 | 归属 |
| --- | --- | --- |
| Enable additional-root Skills | Settings → Plugins → Multi-root Workspace 插件详情 | `multi-root-skills` Config |
| 每 Root 的 Skills 开关 | 现有 Workspace Folders Dialog | Registry |
| 查看、编辑 `aliasId` | 现有 Workspace Folders Dialog | Registry |

全局开关不在 Workspace Folders Dialog 重复。旧宿主的设置入口按 Compatibility 节适配。Config 修改必须让 Host 与各 Session 的 Client Catalog 失效并动态生效，不能以重启应用作为正常生效机制；关闭后也不能仅隐藏 UI 而继续允许旧引用调用。

### 4. Root Alias 与命名空间

在现有 Registry 中增加独立的 `aliasId`，职责与显示 Alias 分开：

| 字段 | 示例 | 用途 |
| --- | --- | --- |
| `id` | UUID | 稳定 Root 身份 |
| `alias` | `Repo A - Backend` | 用户显示名称 |
| `aliasId` | `repo-a-backend` | 用户可引用的 Skill 命名空间 |

`aliasId` 自动生成时对 Alias（缺省用目录名）作 NFKD、小写化，将非 ASCII 字母数字的连续片段换成 `-` 并去除两端连字符；基础名最长 32 字符，结果为空用 `root`。先保留全部已有合法值；对缺失值按稳定 Root id 的码点顺序分配，冲突时追加 `-` 加 Root id 的 SHA-256 前 12 位。若仍冲突则明确拒绝，不重命名已有登记。显示顺序保持原样。用户编辑值须为最长 48 字符的非空 kebab-case，并在同一主根内唯一；唯一性覆盖仍在册的不可用根。生成后持久化，修改显示 Alias 不自动改变它，刷新或重启不得重新分配。

用户调用格式固定为：

```text
主根：         /skill-1
附加根 repo-a： /repo-a:skill-1
附加根 repo-b： /repo-b:skill-1
```

附加根始终使用命名空间，即使没有重名；不覆盖主根或其他根的 Skill。增删其他 Root、排序和修改显示 Alias 不改变已有引用。显式修改 `aliasId` 后旧 Alias 不再解析到该登记；需要同步失效 Catalog、补全、预览及调用缓存，不能保留隐式重定向继续调用。历史消息只保留展示，不赋予当前调用权。

原生 Registry 和原生 `skill` 工具均拒绝冒号名称。内部 ID 定为 `mr-<digest>-<skillName>`，其中 digest 为 `SHA-256(canonicalPrimaryRoot + NUL + root.id)` 的完整小写十六进制摘要；不依赖 aliasId 或显示顺序。模型的原生 Catalog 与 `skill({ name })` 使用这个合法 ID，用户使用 `/aliasId:skillName`。内部 ID 因而会出现在模型 Catalog 及原生工具日志中；本决策只要求它不成为重复的原生 Slash 候选，不承诺从所有可见文本中隐藏它。

原生 Provider 投影保留真实 `modelInvocable`，将桥接条目的 `userInvocable` 固定为 false，从而退出原生人类目录和原生 `/internal-id` 注入入口。原始两项调用策略保存在受校验的发现记录中；自定义 Alias Resolver 和 Client Catalog 按原始 `userInvocable` 判断，因此 user-only Skill 仍可由用户调用，model-only Skill 不会经 Alias 开放。调用时以重新读取的策略再判断，内部 ID 本身不提供授权。

桥接候选使用最低优先级，不能覆盖任何已有原生 Skill；若精确内部 ID 被其他贡献占用，模型入口服从原生 winner 并对附加根的冲突给出诊断，不强行夺取名称。用户命名空间仍由稳定 Root 身份定位，不依靠原生 ID 反解文件路径。

## Architecture

### 1. 模块与数据流

| 模块 | 职责 |
| --- | --- |
| `multi-root-registry` | `aliasId`、`skillsEnabled`、唯一性、迁移、权限实际变化时重置 |
| `multi-root-skills` | 单一聚合 SkillProvider、受限的原生文件解析委托、正文加载、缓存与观察生命周期 |
| Host Skill Alias Resolver | 置前的 pre-step waterfall，在原生 listener 返回后追加用户显式调用正文；保留原始消息 |
| Client Slash Source | Session 级目录、补全与插入完整引用 |
| Client UserText Rule / Renderer | 完整识别命名空间引用，按普通文本显示 |
| Plugin Manager Settings | 包级详情卡片与 Host 行 Config 映射、实时失效 |

```text
可信 Session → Session Origin → Registry / 现有 Scope
  → 全局与 Root 开关筛选 → 元数据发现 → Session Skill Catalog（首步前）

模型 skill({ name }) 或用户 /repo-a:skill-1
  → Session / Alias 解析 → 重新检查 Root、开关与调用策略
  → 按需读取 SKILL.md → 异步读取后再次检查 → 原生 Skill 加载流程
```

Registry 继续是持久数据源，`setAdditionalRoots()` 继续是 Scope 的唯一根写入口；Skill Catalog 是投影和缓存，不建立第二份授权表。面板的新 metadata mutation 复用现有 Registry 串行写路径和 [Connection RPC 契约](./ADR-0005-out-of-tree-client-transport.md)，响应映射继续归 [src/contract.ts](../../src/contract.ts) 所有。

### 2. Session 隔离

使用 `ctx.skills.registerProvider()` 注册一个聚合 Provider。Provider 的声明参数虽只有 `cwd/signal`，Registry 实际传递原始 `SkillViewOptions`，其中 `scope` 是原生调用方传入的 Agent；首步 Catalog、工具执行和原生用户显式调用均带此值，缓存键含 scope chain。适配层将该公开 view 字段收窄为可选项，核验 `ctx.agents.get(scope.id) === scope` 后，从其 `session.header.cwd` 取得 Origin。非 Agent 的 preset key、缺失或已失效 scope 均不贡献附加根条目；不按 cwd 反查会话，不使用工具 dispatch ALS 近似首步身份。

Web 和冷会话的附加根目录、预览使用本插件 `/multi-root-workspace` 通道的 Session-addressed 新读端点，通过 `sessionQuery.observeSession(sessionId)` 取得可信 header Origin，结束后释放 observation；不创建 Agent，不使用 workingDirectory projection 作主根。现有根管理端点仍按 ADR-0008 要求 live Session，不改其 authority 合同。缺少 SessionQuery 能力时客户端读端点不可用，不猜主根；headless 的原生模型路径独立工作。

### 3. 封住 Effective CWD 的原生发现旁路

新版原生 `tool-skill` 把 effective cwd 交给 Registry，原生 filesystem Provider 会重新发现该项目。仅增加一个命名空间 Provider 会让进入附加根后的无前缀 Skill 绕过本插件开关。决定以现有 `wrapMethod` 包装 **SkillRegistry 的公开 `snapshot()` / `get()`**：可信 Origin 对应登记表非空，且请求 cwd 的词法路径或 canonical 路径位于任一在册附加根内时，仅把该次查询的 cwd 归回 Origin。关闭 Skills、missing、redirected 等登记也参与此路由判定，不能因不授予就失去封堵作用。其他 cwd、零登记、缺少可信身份的普通读请求保持原生参数。`list()` 经公开 `snapshot()` 自然继承该行为。

原生冷会话 `SessionSkillCatalog.list()` 可能只传 preset scope。另以公开方法包装该入口，先通过 SessionQuery 取 header，在专用于此请求的 AsyncLocalStorage 中携带 Origin，委托原方法；上述 Registry 包装从该上下文补足身份。这个 ALS 只绑定冷目录请求，不作为普通 Provider 猜测 Session 的替代，也不让冷 scope 获得模型加载身份。包装保留 receiver、signal 与原方法描述符，卸载恢复；不改原型、内部 provider map、Remote 元数据或生成 codec。

这样主根原生 Skills 仍由上游发现、附加根只由命名空间贡献。该情况下所有原生 cwd-sensitive Provider 都看到归回后的 Origin，这是本决策有意定义的项目能力范围；不修改工具的实际 cwd 或 Session header。Root 删除后其内部 ID 与 Alias 失效；不在册 cwd 恢复上游自身的发现语义，不建立一份永久拒绝发现的历史根表。相关接缝缺失或不可验证时应拒载本 Skill 功能，不能仅挂聚合 Provider 后留下绕过路径。

### 4. 生命周期、缓存与撤销

缓存以 Origin、Root id、登记边界、配置/Registry generation、文件观察版本区分，不仅按 effective cwd 或名称缓存。异步扫描、加载与客户端响应携带开始时的 generation，提交前重验；发生以下事件必须更新 generation 并调用 ProviderControl.invalidate()：

- Root 新增、移除、revive、登记权限实际变化、Skills 开关和 `aliasId` 修改；
- 全局开关、Registry Authority 失去/恢复，以及 Root 变为 missing、redirected 或 invalid；
- Skill 文件与元数据新增、修改、删除，目录或 symlink 变化；
- 会话切换/恢复、订阅结束、插件重载与卸载。

**2026-10-24 并发投递补充：** 一条用户消息调用多个 Skill 时，逐个加载成功不等于整批仍可投递。Alias Resolver 暂存正文及各自的加载凭据，所有加载、渲染与消息构造结束后并行重验全批凭据（包括文件身份），并在返回前同步核对批次开始时的 generation；任一凭据失效或 generation 改变，丢弃整批待投递正文。最终核对之后不得再 await，投递跟踪状态也只在该批获准时更新；原始消息及已构造的撤销通知保留。此补充落实既有「提交前重验」规则，避免等待后一个 Skill 时已撤销的前一个正文仍进入会话。

Host 与各 Session Client 同时失效；Client 通过同一插件通道的 generation 查询/订阅协议丢弃旧响应，不能只依赖上游 UI Skill 缓存的 plugin-manager 事件。每次 pre-step、客户端目录和正文加载边界都重验 Root 与开关；不能等待文件观察通知才撤销。已知关闭/撤销应返回权威空贡献而非 incomplete，防止原生 Catalog 保留旧视图；其他 Provider 不完整导致原生目录延后时，插件仍须独立告知本功能的撤销且拒绝加载。

文件解析复用公开 `FileSystemSkillProvider`，设置 `includeDefaultRoots: false`、显式两条 customSkillDirs、`watch: false`；同根先 `.dsh/skills` 后 `.agents/skills`，同名只保留前者。委托前为其注入仅限该登记根的 fs 读面，扫描前就拦截逃逸候选；不能等原生解析已读入根外文件后才过滤路径。正文读取用文件句柄与读取前后路径/状态检查，不向原 fs 写面授予任何权限。

原生 watcher 管理器是私有的，而且 customSkillDirs 不属于其 project LRU，不能声称可共享原生配额。第一阶段由本插件单一观察调度器负责：禁用所有委托 watcher，按 canonical Root 去重，最多观察 128 个活跃根（与上游默认 project 预算同数量级），以 2 秒轮询更新文件视图；LRU 淘汰即释放委托缓存。预算之外仍可在请求边界扫描，不影响首次发现或调用重验。具体平台 IO 与性能在实施计划中测量，禁止每个 Root 各开一套完整 watcher。

禁用或撤销要同时移出模型 Catalog、Slash Menu，并阻止模型、用户、内部 ID、旧 Alias 和旧预览入口的新加载。已进入会话的正文无法从历史中抹除；停止后续加载与权限重验不能宣称回收已启动进程或清除模型记忆。原生 tool-skill 不替插件执行正文，也没有可回收的执行句柄；已加载历史继续保留，下一次 Catalog 更新/插件撤销通知明确停用旧能力，后续新加载仍走重验。

### 5. Web UI 范围

使用独立 `InputTriggerSource` 提供冒号命名空间补全，`onPick` 插入完整 `/aliasId:skillName `。实际 Slash Trigger 保留冒号；草稿 `scanTextRefs()` 的固定 `[\w-]+` 无法识别完整引用，纯核已复现。具有 `uiConversation.userText` 接缝的宿主注册自定义 `UserTextRule`，完整匹配命名空间引用，Renderer 仅返回文字，避免原生规则把前缀当作裸名 Slash 引用；较早宿主保持已发送的原始文本。

**2026-10-24 产品修订：** 本节原先允许已发送引用的按钮展示与点击预览，现按用户要求收敛为普通用户输入的文字效果：不添加独立背景、高亮、按钮或弹窗，也不注册 InputTriggerSource 的引用打开回调。自动补全、完整插入与 Host 调用不变。既有受检预览 RPC 保留为读取接口，不作为聊天中的点击交互。

| Web 能力 | 第一阶段范围 |
| --- | --- |
| `/repo-a:` 自动补全 | 必须 |
| 菜单插入完整 Skill 引用 | 必须 |
| 手动输入引用并触发 Skill | 必须，由 Host 解析，不依赖客户端高亮 |
| 已发送引用展示 | 普通文字；具备 UserTextRule 接缝时完整匹配，旧宿主保留原文 |
| 点击引用预览 `SKILL.md` | 不提供 |
| 草稿内原生 Skill 高亮 | 暂不实现 |

不为该限制修改上游编辑器。补全按当前 live Session 隔离；没有活动 Session 时不猜主根。Host 调用路径也须覆盖 headless，不能让功能依赖 Web 文本规则。UI 继续使用宿主 token 与既有 `mrfw-` 样式约定。

## Security

1. **Root 身份不漂移。** 发现、调用和预览均从现有 Registry / Scope 重验可用性，核对当前 canonical 目录与该登记的授权目录相同；不能让缓存或 Alias 跟随已替换的 Root。只读或固定读写登记分别沿用其现有 grant 字段，不重新解释为 `recordedPath`。
2. **候选文件不得逃逸。** 扫描限定在附加根指定 Skill 目录，文件与目录 symlink 的 canonical 目标须在该 Root 内；不向祖先、主根或全局 Skill home 扩展发现。正文异步 I/O 后重验路径身份、Root 成员资格、开关和调用策略；中途关闭、撤销或重定向时丢弃结果。原型已验证读取中撤销时丢弃结果及扫描前拒绝逃逸；文件句柄与重复身份检查不声称为抵御任意祖先 rename 的原子事务（同 ADR-0012 的继承边界）。
3. **所有调用共用检查。** 模型入口遵守 `modelInvocable`，用户入口遵守 `userInvocable`；解析出内部 ID 后仍检查同一条件。客户端提交的路径、Root、名称或缓存不是授权来源。Skill 文件变化后不能沿用旧元数据绕过新的调用策略。
4. **Skills 不扩权。** 开启只读 Root 的 Skills 不增加 `writableRoots`，Skill 后续工具调用继续经过原 sandbox、per-tool cap 和进程 fence。关闭 Skills 不等于新增文件读取 ACL；普通工具能否读取该文件仍由既有读取语义决定。
5. **门禁与 authority 不旁路。** 新 Host 行须受 `multiRootCompat`、provider brand 和现有 Registry Authority 约束；争用、存储不可用或兼容拒载时不使用上次成功 Catalog 继续贡献附加根能力。主根原生 Skills 和宿主 profile 应保持可用。
6. **正文是用户上下文。** 不借 Skill 将仓库文本提升为 system authority；优先沿用原生 Skill 加载语义，Alias 调用正文在 pre-step 的 native Catalog 之后以本插件所有的 instructions-form 用户消息投递，适配 session format 3/4；只解析本批 `source.kind === user` 的原始消息，模型或外部注入文本不能伪造显式用户调用。

## Compatibility

### 1. 上游接缝与 Settings

支持集合继续以 [SUPPORTED_DSH_RELEASES](../../src/compat/dsh-version.ts) 为真源，不因本文自动扩大或缩小。SkillProvider、原生调用、Catalog、文本解析和 Settings 必须逐版本核实；不能把开发 pin 的接口视为全矩阵事实。版本差异归 `src/compat/`，用结构探测，不在业务代码比较版本号。可选服务缺席不能让 carrier barrel 静态加载新依赖并破坏最小组合。

Settings 采用 Git 插件已存在的结构适配：

- 有 `installSection` 的宿主：注册唯一 legacy namespace `multi-root-skills`，以行 Config 为 base，用 `setSource` / `onChange` 读取与失效。
- 有 Config 表单的宿主：`enabled` 通过可用的 `.volatile()` 标记并在每次准入时读取引用当前值；`settings/document-updated` 驱动 Catalog 失效，`settings.configure({ auto: false })` 避免重复自动页面。
- Client 有 `settingsScope` 时绑定上述 namespace；有 `configForms` 时用 `get('multi-root-skills')`。`plugins.bundle.config` 只注册一张包名为 key 的卡片；仅有 `settings.plugin.item` 的旧宿主用 namespace 注册旧入口。

**包名展示 key、legacy namespace、Host 行 ID 是不同身份。** 本功能后两者有意同名，不意味着可以用包名代替 Config entry。配置方法差异与各 UI 可用范围见[接缝调研](../reference/multi-root-skills-seams.md)。ConfigFields 的实时读取和 Host 失效不能仅靠组件重新渲染。

新增动态运行时解析依赖须加入兼容门禁的真实执行副本分类，host-mounted 服务则按宿主服务分类；不得从插件私有 dev 副本证明宿主版本。桥接包装失败应使 Skills 行拒载并诊断，不拆掉基础 fs/sandbox provider，不修改支持集合。

### 2. 旧记录迁移与降级

旧记录没有 `aliasId` / `skillsEnabled`。保持 domain v1，字段缺省表示需要补齐；由 authority 在 domain open 后、首次发布该主根 Skills 投影前，在现有 authority-transition / per-primary 序列化边界内完成迁移并先持久化。`refresh()` 不写盘。authority 不可用或迁移失败时不给该主根新增 Skill 能力，报告原因，不能靠默认内存值宣称迁移成功：

- 按旧记录**原有 grant 编码**推导登记权限，再初始化缺失的 `skillsEnabled`。现有 `inherit` 与固定 `read-write` 记录默认开始贡献 Skills，`read-only` 默认关闭；不能以当前 SandboxMode 推导。
- `aliasId` 对同一主根内记录唯一，生成与持久化幂等。重启、重复加载、刷新和并发 takeover 不重新分配既有值。
- 迁移不修复或重授原有无效 grant，不改 Root 的稳定 id、登记边界、顺序和访问权限。缺失字段与非法字段需区分，不能把损坏值按「旧记录」静默启用。
- 保留 store-wide lease、authority-transition queue 和 per-primary mutation queue 的既有顺序；contended 进程不得迁移或写盘。`refresh()` 仍是无写入的重验证入口，不能用它偷偷执行持久化迁移。
- 已证实旧 schema 会剥离未知 metadata。降级后若旧版写回记录，aliasId 与手动开关可能丢失；再升级按旧记录重新迁移，inherit/read-write 可能重新默认开启。保留 grant 的降级安全性，**不承诺 Skills metadata 无损降级**。需要保留选择的用户应在降级前备份 Registry，升级说明必须明确此边界。

功能发布前，应在对应双语 CHANGELOG 与升级说明中明确「旧 inherit / read-write 登记默认启用 Skills」、只读默认值及全局关闭方式；本 ADR 不改写已发布版本的变更内容。

## Alternatives Considered

| 方案 | 不采用的理由 |
| --- | --- |
| 所有附加根默认关闭、仅 opt-in | 与本次产品共识不符；采用登记权限决定初始值，保留用户独立控制 |
| Root 开关三态 `auto / true / false` | 增加状态与解释成本；两态持久值及权限实际变化时重置足够表达当前规则 |
| 持续按有效写权限计算 Skills 开关 | 会让 SandboxMode 或工具 cap 改变能力发现，并丢失用户手动选择 |
| 主根优先、附加根按登记顺序覆盖同名 | 增删和排序会改变引用指向；固定命名空间允许并存 |
| 用显示 Alias 直接作命名空间 | 改显示名称会破坏引用；独立 `aliasId` 可校验、可持久化 |
| 首轮完整注入所有 `SKILL.md` | 增加上下文成本，偏离原生按需加载，也混同指令与 Skill |
| 仅增加 SkillProvider，不做调用解析与 Web 接缝 | 原生名称拒绝冒号，而且 native effective-cwd 发现可以绕过单独的 Provider 开关 |
| 用禁用整个 bundle 实现全局开关 | 会同时关闭多根其他功能，偏离开关作用域 |
| 修改上游草稿扫描器或复制整套 Skill 执行系统 | 不满足出树边界，或承担不必要的双轨执行与权限维护成本 |

## Consequences

用户得到稳定、可预测的附加根命名空间；权限只决定初始值，后续可独立控制。代价是 Registry metadata、迁移、Session 传播、双端缓存、Settings 与原生 Skill 生命周期必须协同，不能只注册一个扫描器就宣称完成。

第一阶段接受草稿内没有原生高亮；已发送引用按普通文字展示（见 2026-10-24 产品修订）。默认启用的旧登记会产生用户可见行为变化，必须在功能发布时说明。观察、扫描与缓存使用统一预算；平台性能与完整集成成本仍需实施阶段验证。

本 ADR 不改变现有已发布功能的说明，也不新增已完成进度或发布承诺。实现及平台执行证据后续归现有[路线账本](../plans/active/2026-09-12-multi-root-workspace.md)，发布内容归双语 CHANGELOG。

## Acceptance Criteria

以下是功能交付的最终验收条件，不能与架构原型的通过项目混淆；执行进度只记路线账本。

| 编号 | 场景与预期 |
| --- | --- |
| A1 | 新增三种登记权限分别得到开启、开启、关闭；只读根手动开启后仍不可写；会话模式与工具 cap 不改持久开关 |
| A2 | 实际权限变化重置默认值，同值设置不重置；revive 的未指定/同值/不同值权限分别保留/保留/重置；重启保留选择 |
| A3 | 全局关闭移除所有附加根 Skill Catalog 条目并阻止新加载，但不改每根选择；恢复后按原值发现；主根、指令、LSP、浏览与沙箱不受影响 |
| A4 | 主根与多个附加根同名 Skill 并存；附加根始终显示命名空间且无内部 ID 重复项；Alias 修改、排序、其他根增删不改变既有引用；编辑 aliasId 后旧引用失效 |
| A5 | `.dsh/skills`、`.agents/skills` 均被发现，同根重复和无效元数据按核实后的原生规则处理；首个模型请求可见目录且无完整正文 |
| A6 | 两个不同主根的 Session 共享 effective cwd，并发发现/调用仍隔离；切 cwd、恢复、子 Agent、无活动 Session 不串用 Root 集合 |
| A7 | 模型与用户两种入口各自遵守调用策略；内部 ID、手输引用、旧 Alias、旧 Catalog 与预览不能绕过关闭或撤销；headless 可调用 |
| A8 | 读取进行中关闭全局/Root、移除 Root、替换目录、切 Session 或改变调用策略，旧结果不进入新目录或新加载；已加载状态协调有明确边界 |
| A9 | Skill 新增、修改、删除、symlink 变化与 Root missing/redirected/恢复触发正确失效；文件逃逸根外被拒；watcher 预算、回收与 teardown 可验证 |
| A10 | 旧存储迁移生成唯一稳定 aliasId 与正确开关；重复加载、写失败、并发 authority takeover、非法 metadata 和降级再升级有覆盖；grant 不被改写，refresh 不写盘 |
| A11 | 真实插件管理页正确映射包 key / 行 ID / namespace，legacy 与新版入口覆盖；切换后 Host 和各 Session Client 动态更新，无需重启；根管理入口无全局重复开关 |
| A12 | Web 补全、完整插入、手输触发通过；已发送引用为普通文字，点击不预览；接受草稿高亮缺失，全程不修改上游包 |
| A13 | 受支持版本上的 Skill 接缝、web/headless 与必要平台路径行为有明确矩阵；门禁拒载、可选服务缺席及零附加根保持宿主正常工作，旧 Catalog 不旁路失败关闭 |

### Proposed 阶段问题的结论

| 原待验证项 | 定案 |
| --- | --- |
| Session 绑定 | 原生借用 options.scope + live Agent 精确身份；自有客户端读端点使用 SessionQuery header；冷原生目录用请求级 ALS |
| 内部 ID 与重复菜单 | 完整摘要内部 ID；模型保留原生调用，原生 userInvocable 投影关闭，Alias 路径保留真实用户策略 |
| Settings 多行 bundle | 包 key 与行/namespace 分离；modern volatile Config 和 legacy installSection 两条结构适配 |
| 迁移 | 稳定排序分配 aliasId，authority 内先落盘，refresh 无写，旧 schema 丢失 metadata 的降级边界明确 |
| 读取与生命周期 | 受限 fs 委托原生解析，读取后 generation/身份/策略重验，禁用与原生替换 Catalog 协调；历史文本不声称可回收 |
| 新发现的 Effective CWD 旁路 | 包装公开 Registry 读取与冷 SessionSkillCatalog，附加根 cwd 的原生发现归回 Origin |

架构原型和源码审查支持上述选择。生产实现若需要改变这些决定，应补充修订理由与证据。A1–A13 的生产执行结果、平台覆盖与剩余项由路线账本记录，不能从本 ADR 的 Accepted 状态推导验收完成。开发阶段、依赖和各阶段退出条件见[实施计划](../plans/completed/2026-10-23-multi-root-skills.md)。

## Related Documents

- [Issue #17：附加根不参与技能发现](https://github.com/cherrchen/dsh-plugin-multi-root-workspace/issues/17)
- [ADR-0004：Registry 持久化与验证](./ADR-0004-root-registry-persistence-and-validation.md)
- [ADR-0005：出树 Client 传输](./ADR-0005-out-of-tree-client-transport.md)
- [ADR-0007：Registry Authority lease](./ADR-0007-registry-authority-lease.md)
- [ADR-0008：面板 Session authority](./ADR-0008-panel-session-derived-authority.md)
- [ADR-0009：DSH 兼容性契约](./ADR-0009-dsh-compat-contract.md)
- [ADR-0010：附加根指令范围](./ADR-0010-additional-root-instruction-scope.md)
- [ADR-0012：Session Origin 与 Effective CWD](./ADR-0012-session-origin-and-effective-cwd.md)
- [ADR-0017：三态登记权限与 SandboxMode](./ADR-0017-three-state-root-access-and-sandbox-modes.md)
- [Git 插件 Settings 适配源码](https://github.com/cherrchen/dsh-plugin-git/blob/main/src/compat/dsh-client-settings.ts)
