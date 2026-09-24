# 开发需求文档：DSH Multi-root Workspace（out-of-tree 插件，不改上游）

> 状态：MVP（M1/M2/M3）已实现并以 `v0.1.0` 发版（2026-09-13）；`v0.1.1` 硬化批次（H1–H4）已实现并随 `v0.1.1` 发版（2026-09-16）；第二期（B 系列）范围见 §4。编号口径见[路线图 §编号口径](../plans/active/2026-09-12-multi-root-workspace.md#编号口径)，进度与发布状态的唯一真源见[路线图 §进度总账](../plans/active/2026-09-12-multi-root-workspace.md#进度总账)。| 日期：2026-09-15 | 上游需求：用户提供的《DSH Multi-root Workspace 插件需求总结》
> **硬约束：不得修改上游仓库（deepseek-harness）中任何包**——全部产物是外部插件/bundle，通过 `dsh plugin add` 或 profile patch 组合安装。
> 事实依据：[multi-root-workspace-research.md](../reference/multi-root-workspace-research.md)（§8 为不改上游的补充调研）；设计：[multi-root-workspace.md](../architecture/multi-root-workspace.md)；排期：[路线图](../plans/active/2026-09-12-multi-root-workspace.md) 与 [M1 计划](../plans/completed/2026-09-12-m1-composition-and-passthrough.md)

## 1. 需求陈述

将 DSH 的 Workspace 语义从

```text
Workspace = 一个 canonical 目录
```

扩展为

```text
Workspace = 一个 Primary Root（既有 workspace.path，不改）+ N 个 Additional Roots
```

使 Agent 能在同一个 Session 中理解、读取、搜索和修改属于同一开发项目的多个独立 Git Repository，同时：

- Agent 继续只使用 DSH 原生工具（`read` / `write` / `edit` / `bash` / ...）；
- 所有路径安全与进程隔离继续由 DSH 原生 Sandbox 机制（Seatbelt / bwrap / Landlock / fs fence）提供，绝不退化为 danger-full-access 或提示词约束；
- 插件只回答一个问题："哪些目录属于当前 Workspace"。

## 2. 可行性结论（不改上游约束下）

**可以实现，但实现路径与"可改上游"的设想不同，且要接受两条明确的代价。**

可行依据（详见 [multi-root-workspace-research.md](../reference/multi-root-workspace-research.md) §8）：

1. **patch 层支持 disable 旧行 + insert 新行**，且外部 bundle 的 `dsh.bundle.patch` 会被 `dsh plugin add` 自动追加为组合层、可 patch base bundle 的行。上游单根语义虽然锁在 `writableRoots()` 与各方言内部，但其 provider 都是可 import、可子类化的公开类（`SandboxedFileSystem` / `SandboxBashExecutor` / `LocalSandboxProvider` / `LocalFileSystem`，无 `#` true-private 成员）。
2. **替换是完整的**：disable `fs-sandbox` 与 `sandbox` 两行后由插件提供同 key 服务（上游同 key 重复 provide 会抛错，所以必须先 disable）；`bash-sandbox` **无需替换**——bash 与 PTY 的 confinement 全部经 `ctx.sandbox.confine` 表达（见 [架构文档 §5.2](../architecture/multi-root-workspace.md)、[ADR-0001](../decisions/ADR-0001-provider-replacement-scope.md)）。上游的 `sandbox-policy`、`tool-fs`、`tool-bash`、`terminal-bash` 等消费者无需改动——它们继续向 `ctx.fs` / `ctx.shell` / `ctx.sandbox` 请求能力，只是拿到的实现变成了多根版本。
3. **被排除的捷径**：`fs/*` 事件（只决定版本守卫 intent，fence 在其后的 provider 内部）与 `tools/pre-execute`（设计上禁止参数改写）都不能放行额外根——多根必须发生在 provider 层。

两条代价（已写进风险与验收）：

- **方言 parity 责任转移**：上游用 `writableRoots()` 保证"write 工具能写的根 bash 一定能写（反之亦然）"并有 parity 测试钉住；替换后这条不变量由插件自己维护（bash 与 PTY 经同一个 sandbox provider 取根，因此它们的根集合与 fs fence 由构造相同）。
- **升级脆弱性**：上游 API 是 pre-stable（无 semver 承诺），子类依赖 `LocalFileSystem` / `LocalBashExecutor` / `LocalSandboxProvider` 的公开方法面，上游升级可能破坏插件；必须 pin dsh 版本并建立升级 smoke 检查。

若未来允许向上游贡献，[架构文档 §9](../architecture/multi-root-workspace.md) 给出了"通用 Filesystem Scope Seam"的目标形态：届时插件的子类实现退化为薄 provider，替换行撤销。

## 3. 逐条需求 → 实现机制映射

| 需求（原文节号） | 不改上游下的机制 | 结论 |
|---|---|---|
| §4 不重实现原生设施；不造 `workspace_*` 工具 | 原生工具链（tool-fs / tool-bash / terminal）不动；插件零工具（可选一个内省工具）。注意：插件会**子类化**上游 fs 与 sandbox provider——这是"扩展"，不是重实现；文件 IO、进程、内核 runner 全部复用上游 | 满足（含澄清） |
| §5.1 Root 管理 | 插件注册表 + `dsh-storage-domain` 持久化 + `canonicalPath` 校验；登记项带 `recordedPath`，授权需"当前解析 == 登记时授予的目录"；同一主根的变更整体串行；读取侧 `refresh` 重新校验但不写存储；跨进程由 store-wide 内核 lease 保证单写者（ADR-0007） | 插件职责 |
| §5.2 Workspace Folders UI | slot 洞 + `directoryPicker` + locale 字典 | 插件 client 半部 |
| §6 保留 Workspace.path 为 Primary Root | 现状即如此，不碰 | 零改动 |
| §7 不改 Session cwd 语义 | `header.cwd` 不可变 | 零改动 |
| §8 Agent 认知：稳定 topology | 插件自己的 `ctx.systemPrompt.context` 快照（快照随请求落 log，满足 model-visible ⟺ logged） | 插件职责 |
| （补充）附加根自己的指令文件 | `multi-root-instructions` 行：以每个附加根为 `projectRoot`（`cwd` 为被考察目录）发现顶层与**本会话工作过的子目录**里的 `AGENTS.md` / `CLAUDE.md`，经 `agent/pre-step` 以 `form: 'instructions'` 的 user 消息注入（format 3 的 source kind 是 `plugin`，format 4 起是 `multi-root-workspace`），全部附加根共享 64 KiB 预算，根离场即显式撤销、文件消失即显式撤回（[ADR-0010](../decisions/ADR-0010-additional-root-instruction-scope.md)） | H4 Phase 1 + Phase 2（均已实现） |
| §9 可选 `workspace_roots()` 内省工具 | `ctx.tools.register(defineTool(...))` | **删除条件已满足**：M3 的 session 旅程断言两个 profile 的模型请求里都包含拓扑快照（附加根路径 + "additional roots of this session's workspace" + cwd 不变），不再做该工具 |
| §10 Sandbox 原则：多 allow roots，不开 danger-full-access | 子类 provider 在同一内核机制内拼装多根 grant（Seatbelt 多条 allow form / bwrap 多个 writable mount / Landlock 多个 LAW path / fs fence any-of-roots） | 满足 |
| §11/§12 通用 seam、Core 不认识插件 | **不受约束时的理想形态**（架构文档 §9）；不改上游时以"多根 provider 子类"代位，seam 词汇（附加可写根贡献者）保留在插件内部接口上 | 部分满足，见 §2 代价 |
| §13 单一权限世界 | fs 直接取插件 scope；bash / terminal / PTY 经插件的 sandbox provider 取同一份 scope；插件自带 parity 测试钉住 | 满足，责任在插件 |
| §14 数据模型：插件只存 Additional Roots | `AdditionalWorkspaceRoot { id, path, alias?, addedAt }` per workspaceId | 插件职责 |
| §15 Root Path 规则 | `realpathSync.native` canonical 化 + 冲突校验（非绝对 / 不存在 / 非目录 / 等于主根 / 与主根双向重叠 / 与附加根重复或双向重叠）；读取侧另判 `recordedPath` 变化与重复 id | 插件职责 |
| §16 初版附加根继承 workspace-write | 附加根与主根同权，无 per-root mode | 第一期范围 |
| §17 `*.dsh-workspace.json` | 第一期不做；storage 为唯一数据源 | 后续阶段 |
| §18 兼容性：不装/无根 = 单目录行为 | 未安装：组合零变化。安装且根列表为空：子类行为与上游 byte-identical（子类在空附加根时直通上游实现路径） | 验收标准 |
| §19 其他插件经 Workspace Filesystem Capability 查询 scope | 插件暴露自己的 scope 查询 service（非私有数据库直读）；上游 seam 成熟后迁移 | 长期目标 |
| §22 用户体验 | 原生工具 + 扩展 allow-list，端到端验收 | 验收场景 |

## 4. 范围

### 第一期（MVP）

- 插件 host 半部：root 注册表（storage 持久化）、canonicalization 与冲突校验、scope 解析 service、`systemPrompt.context` 拓扑快照、`/workspace-folders` 命令。（原计划的"可选 `workspace_roots` 内省工具"已按 §3 判定**不做**，见 §7。）
- 插件 provider 半部（本约束下的核心增量）：多根 `fs`（进程内 fence）与多根 `sandbox` provider（Seatbelt / bwrap / Landlock 方言的附加 grant 拼装）；通过 bundle patch disable 上游两行并插入。bash 与 PTY 不需要专属实现——它们经 `ctx.sandbox` 取根（[ADR-0001](../decisions/ADR-0001-provider-replacement-scope.md)）。
- 插件 client 半部：Workspace Folders UI（侧栏底部动作 + 对话框）、复用组合好的 directory picker 能力、双语 locale（`ctx.locale.register(ns, { zh, en })`）。
- 平台范围：macOS（Seatbelt）、Linux（bwrap / Landlock）全量；Windows 的 fs fence 多根可用，内核级 bash 多根（pwsh 方言）**不在第一期**（fs 写路径已覆盖 Windows 大部分场景；文档明示）。
- profile 覆盖：`web`（含 Electron 桌面端）与 `headless` 验证；`sdk`/`acp` 天然受益（同一组合方式）。

### v0.1.1 硬化批次（H1–H4，已实现，已发版）

MVP 之后、第二期之前插入的一批"把已有能力做扎实"的工作。它不是新功能，而是把四个已知的边界缺口补上；编号与发布状态见[路线图 §进度总账](../plans/active/2026-09-12-multi-root-workspace.md#进度总账)。

- **H1（= 路线图 M4）跨进程 Registry Authority Lease**：多个 DSH 进程共用同一 storage root 时，只允许一个进程打开登记表并授予附加根；其余进程 fail-closed 并在对方退出/崩溃后经 `refresh()` 接管。见 [ADR-0007](../decisions/ADR-0007-registry-authority-lease.md)。
- **H2 面板权威收紧**：面板每个端点（含 `list`）只接受必填 `sessionId`，主根只来自 host 的 `session.header.cwd`；不再接受客户端指名的 `primaryRoot`，也不回退部署默认 workspace。见 [ADR-0008](../decisions/ADR-0008-panel-session-derived-authority.md)。
- **H3 DSH 兼容性代码契约**：支持矩阵是精确版本 allowlist（当前 `0.1.5-rc.2`、`0.1.6-alpha.1`、`0.1.6-alpha.2`、`0.1.7-alpha.1`、`0.1.7-alpha.2`、`0.1.7-rc.1`），启动时校验版本与混装，判定失败则四个安全相关行根本不启动；版本差异集中在 `src/compat/`。见 [ADR-0009](../decisions/ADR-0009-dsh-compat-contract.md)。
- **H4 Phase 1 附加根指令注入**：附加根**顶层** `AGENTS.md` / `CLAUDE.md` 进入模型上下文（user role 的 plugin instruction context），共享 64 KiB 预算，根离场即显式撤销。见 [ADR-0010](../decisions/ADR-0010-additional-root-instruction-scope.md)。
- **H4 Phase 2 附加根 nested instructions**：本会话**成功**的 `read` / `write` / `edit` 触碰过的子目录里的 `AGENTS.md` / `CLAUDE.md`，在同一份预算下于下一步之前补投；文件内容变化即重发该文件，文件消失即显式撤回。触碰取自持久化的 `session/event`（`tool/call` 与 `tool/result` 配对），不依赖 tool 层包，也不使用 `SessionMessageProjection`。见 [ADR-0010](../decisions/ADR-0010-additional-root-instruction-scope.md)。

### 第二期（不在第一期与 v0.1.1）

按优先级排列；"来源"列区分 MVP 时期就已登记的范围与后续评审补充的范围。

| 优先级 | 项 | 来源 / 说明 |
|---|---|---|
| P1 | Additional Root LSP workspace routing | 后续评审补充；LSP 仍固定使用 `session.header.cwd`，从属 repo 的 `tsconfig` / `pyproject` / rust workspace 无法成为真正的 LSP root |
| P1 | Windows 内核级多根（pwsh 方言 / ACL） | 第一期就已登记；当前 Windows 上 `ctx.fs` 可写附加根，但受限 PowerShell/PTY 不可写 |
| P1 | `workspace-files`（Client 文件树）多根 confine | 第一期就已登记；Client 文件浏览仍只展示主根，属已知限制 |
| P2 | Read-only root / per-root / per-tool 权限 | 第一期就已登记；初版附加根与主根同权（§16） |
| P2 | Mutation 前强制 reclassify | 后续评审补充；避免缓存的 `missing` / `redirected` 状态让 `add` 后立刻 invalid |
| P2 | Additional Root 数量上限 | 后续评审补充；防止 realpath/stat、sandbox argv 与 prompt 预算随根数量无界增长 |
| P2 | Provider replacement conflict detection | 后续评审补充；若另一插件也替换 `ctx.fs` / `ctx.sandbox`，应 fail loud，而不是依赖 patch 顺序 |
| P2 | Windows-aware model capability prompt | 后续评审补充；不再对 Windows 模型宣称"附加根与主根完全同权" |
| P3 | Registry observer 语义 | 后续评审补充；区分 grant change / metadata change，并隔离 listener 异常 |
| P3 | 收紧 TOCTOU 文档表述 | 后续评审补充；与 DSH 本地 path-based sandbox 保持同一 threat model，不声称消除 path race |
| P3 | `*.dsh-workspace.json` Import/Export | 第一期就已登记（§17）；storage 目前是唯一数据源 |
| P3 | SDK API；向上游贡献通用 Filesystem Scope Seam 并撤销子类替换 | 第一期就已登记（§19、架构文档 §9）；若政策放开则属长期目标 |

## 5. 验收标准

1. **不装插件**：组合与行为与现状完全一致（本条由"插件是外部 bundle"天然保证）。
2. **安装且根列表为空**：`fs` / `bash` / `sandbox` 的行为与上游一致（sandbox provider 空根时逐元素返回上游 `confine` 结果；fs provider 的 containment 语义由差分 parity 测试证明与上游逐项一致）；`dsh --dump-config` 仅显示两行被替换。
3. **多根生效**：添加附加根后的新 Session 中——对附加根内路径的 `write` / `edit` 成功；`bash` 在附加根内创建/修改文件成功（macOS Seatbelt、Linux bwrap 与 Landlock）；附加根外任意路径写入仍被拒绝并返回升级指引；`read-only` 模式下附加根同样不可写。
4. **单一权限世界**：插件自建 parity 测试——同一 scope 下 fs fence 与内核 runner 对附加根内外的写行为一致；不存在任一工具能写附加根而另一工具不能的组合。
5. **cwd 不变**：多根 Session 的 `header.cwd`、`workspace.path`、transcript cwd 显示均为主根；无虚拟 cwd。
6. **模型可见 ⟺ 已记录**：拓扑文案经 `systemPrompt.context` 快照落 log；快照回放能重建相同拓扑。
7. **Path 规则**：`~/p`、`/abs/p`、`/abs/../abs/p`、symlink 别名 canonical 化后判重；与主根相同（`equals-primary`）或与主根互相包含（`primary-overlap`）的候选被拒绝并给出明确错误；与其他根重复或互相包含同样拒绝；缺失目录添加时拒绝、启动时降级为"保留登记 + 不授予 + 用户可见通知"，不静默；同一条主根下重复 id 的记录全部报 `invalid` 且不授予，并可逐条移除。
7.1 **授权不可被本地替换转移**：登记目录（或其链接链）在登记后被替换成指向别处的符号链接时，该根变为 `redirected`、撤销授予，且**绝不**把写权限交给新目标；恢复原目录后由一次重新校验自动复原。
7.2 **刷新即重新校验**：命令 `list` 与面板刷新是同一条路径——重新 `stat`、重新解析、重新裁决并同步 scope，且只读刷新不写存储；目录删除后列表必须显示不可用并撤销授予，目录恢复后必须重新授予（不需要重启）。
7.3 **并发不丢操作**：同一主根上并发发起的增删改必须全部生效，且不得复活已删除的记录。
7.4 **异常记录不扩散损坏**：缺少 `recordedPath` 的旧记录经无关写操作后仍可在重启时读取；一次 remove/alias/move 只能作用于一条可唯一定位的记录，不能按重复 id 批量命中或隐式删除其他记录。
7.5 **实时 scope 不授予 missing 根**：目录在登记后被删除时，即使没有先执行 list/refresh，下一次 scope resolve 也必须排除它，不得通过写操作重建该目录。
7.6 **跨进程单写者**：两个 DSH 进程共用同一 storage root 时，只有持有 store-wide 内核 lease 的进程打开登记表并授予附加根；另一进程 fail-closed（空 scope、`registry-contended`），其 `list`/Refresh 在对方退出或崩溃后可接管并读回最后一次 durable 写。释放顺序：排空在飞 mutation → close domain → release lease，且与在飞 acquisition 不交错（继任者绝不会打开一份缺了最后一次写的快照）。见 [ADR-0007](../decisions/ADR-0007-registry-authority-lease.md)。
7.7 **面板主根由 host session 推导**：面板通道每个端点（含 `list`）只接受必填 `sessionId`；host 用 `resolvePanelPrimaryRoot` 取该 session 的 `header.cwd` canonical，不接受客户端 `primaryRoot`，也不回退部署默认 workspace。缺失或未知会话拒绝；浏览器没有当前 Session 时显示空态、不调用 host。`/workspace-folders` 仍用 `invocation.agent.session`。见 [ADR-0008](../decisions/ADR-0008-panel-session-derived-authority.md)。
7.8 **附加根指令注入（H4 Phase 1 + Phase 2）**：零附加根时该行一条 message 都不注入（空根与未装插件仍逐字节一致）；每个附加根**顶层**的 `AGENTS.md` / `CLAUDE.md` 在模型第一步之前可见，且以绝对路径标注（两个根的 `AGENTS.md` 不混淆）；**由成功工具调用到达的子目录**里的同类文件在其目录被考察到之后、下一步之前可见（触碰仅认成功的 `read` / `write` / `edit`，失败的调用不算）；每个文件恰好投递一次，内容变化才重发该文件；所有附加根共享同一份 64 KiB 预算；根被移除、消失或被替换（`redirected`）时注入**显式撤销**文案，已投递文件消失时注入**显式撤回**文案（点名绝对路径）；`$DSH_HOME`、主根自身与任何祖先目录的指令文件不被重复注入。触碰 `a/b/file` 时，`a/AGENTS.md` 与 `a/b/AGENTS.md` 都必须可见（被触碰路径的父目录及其每个祖先直到根都被考察）。见 [ADR-0010](../decisions/ADR-0010-additional-root-instruction-scope.md)。
8. **失败要响亮**：misconfiguration（非绝对路径、重复 id、patch 行未按预期生效）在装载或首次 resolve 时抛错。
9. **UI**：Folders 列表区分主根/附加根；Add Folder 走组合好的 `directoryPicker` 能力（面板 `uiWorkspace.pickDirectory()` / 命令侧 host native `pick`）；Remove/Reveal/Copy Path/Alias/排序可用；双语（zh/en 键集相等由 `tests/locale-parity.spec.ts` 钉住）。落点是侧栏底部动作 + 对话框，见 ADR-0005 与下方已知限制。
10. **升级韧性**：`package.json` pin dsh 精确版本；仓库 CI 含"升级 smoke"脚本（对上游 demo 行为差异报警）；provider 子类只依赖上游公开方法面（不触碰 TS-private、不做原型替换）。
11. **e2e**：需求 §22 场景实跑通过（跨 repo 读写、双 repo 测试、git diff），headless + web 双 profile —— 由 `pnpm smoke:journey` 覆盖：web 组合进程内启动 + 命令注册根 + 真实 agent 轮次，headless 组合以真实 CLI 子进程跑一次性任务，模型由内联的脚本化 OpenAI 兼容端点提供（无凭据）。受限 bash 在无法嵌套内核沙箱的宿主上显式 skip 并打印原因。

### 已知限制（v0.1.1）

- nested 指令文件只会在其目录**被考察到时**重新检查：根层每一步，子目录依赖"已经投递过"或"本次有触碰"；投递状态是进程内的，会话 resume 之后可能把已给过的指令再给一次。
- 触碰识别只认 `read` / `write` / `edit` 三个工具名，且只认成功的调用；其他写文件工具（例如 `str_replace_editor`）不会触发子目录指令的发现。
- 跨进程只有 single-writer 语义：同一 storage root 上不能并发写登记表；另一个进程要等到持锁者退出后经 `refresh()` 接管（这是刻意的 fail-closed，不是待修的竞态）。
- 支持矩阵是精确版本 allowlist：不在清单上、或核心包混装的宿主上，四个安全相关行根本不启动（组合退化为"未装插件"）。

### 已知限制（M3）

- 命令输出文案为英文（host 侧没有活动语言信息）；面板文案中英双语。
- 面板是"侧栏底部动作 + 对话框"：`sidebar.panellist` / keyed `main` 全屏面板只有部分上游运行时提供，因此面板固定在两个受支持版本都有的 `sidebar.footer.action` 上（M3 当时的理由是保住已安装桌面运行时 `0.1.2-rc.1`；该运行时后来不在支持矩阵内，见 [ADR-0009](../decisions/ADR-0009-dsh-compat-contract.md)，但结论不变——`footer.action` 才是交集）。
- 未接入 `sidebar.workspaces.directoryFlow` / `conversation.hero.workspace.directoryFlow`：那是"创建工作区"的洞，默认组合已有占用者（ADR-0005）。
- e2e 的模型轮次由脚本驱动（用于断言世界状态），不能替代"真实模型能否自行发现附加根"的观察；拓扑快照的模型可见性由请求体断言覆盖。
- 重新校验与内核调用之间仍存在 TOCTOU 窗口：本插件保证"按当前可见的解析结果授权"，不保证一个目录在 `stat` 之后被原子替换时内核仍按旧目标执行（那需要内核侧 fd 语义）。
- 主根自身被解析到别处（例如 `policy.workspaceRoot` 指向的路径被替换）属于上游 `sandboxPolicy` 的行为，不在本插件的重新授权范围内。

## 6. 非目标（明确不做）

- 不实现任何 `workspace_read/write/edit/bash/exec` 工具。
- 不通过 danger-full-access、System Prompt 约束、DOM patch、虚拟 cwd、fork `dsh-workspace` 实现多根。
- 不修改上游仓库（deepseek-harness）任何包（含 vendor/、apps/、scripts/）；其仓库 gates（`verify-cordis-config` 等）按 out-of-tree 形态不适用于插件仓库，插件仓库自建等价检查。
- 不 append 自有 session 事件类型（避免"未装插件的 dsh 拒绝打开日志"的兼容风险；会话级 scope 以插件存储按 canonical cwd 解析，见架构文档 §4）。
- 不改 `SandboxMode` 三值语义、escalation、approval。
- 不重新实现上游 `agent-instructions` 的 session projection / 增量 reconcile 机制：nested 投递用本插件自己的轻量差量实现，只依赖两个受支持版本都有的 `session/event`，不引入 `SessionMessageProjection`，也不复刻上游的版本缓存与消息组装（[ADR-0010](../decisions/ADR-0010-additional-root-instruction-scope.md)）。

## 7. 开放问题（详见 [开发路径文档 §风险](../plans/active/2026-09-12-multi-root-workspace.md)）

已关闭：

- ~~bash 子类化的落点~~ → 不替换 `bash-sandbox`，全部经 `ctx.sandbox`（[ADR-0001](../decisions/ADR-0001-provider-replacement-scope.md)）。
- ~~profile 构建函数是否公开导出~~ → 发布包不含 `src/`，深导入不可用；改为克隆 `super.confine` 的 grant 模板 + 识别失败即抛错（[ADR-0002](../decisions/ADR-0002-upstream-coupling-policy.md)）。
- ~~`sandbox` 行替换对 terminal/PTY 的影响面~~ → 已确认 terminal/PTY 只消费 `confine` 与 `policy.workspaceRoot`（架构文档 §5.2/§5.3）；M1 以 PTY 用例实跑复验。

M3 关闭：

- ~~nested roots 最终态度~~ → **拒绝**（双向），理由与实现见 [ADR-0004](../decisions/ADR-0004-root-registry-persistence-and-validation.md)。
- ~~可选 `workspace_roots` 工具~~ → **不做**（删除条件由 M3 旅程的拓扑快照断言满足，见 §3 映射表）。
- ~~出树 client 半部的通道~~ → Connection RPC 通道 + `sidebar.footer.action` 面板，见 [ADR-0005](../decisions/ADR-0005-out-of-tree-client-transport.md)。

v0.1.1 关闭：

- ~~两个 DSH 进程共用 storage root 时的 stale grant~~ → single-writer 内核 lease + 争用 fail-closed，见 [ADR-0007](../decisions/ADR-0007-registry-authority-lease.md)（§5 验收 7.6）。
- ~~面板主根可以被浏览器指名~~ → 面板权威改为 host session 推导，见 [ADR-0008](../decisions/ADR-0008-panel-session-derived-authority.md)（§5 验收 7.7）。
- ~~支持矩阵只是文档承诺~~ → 编译期 + 启动期双重契约，见 [ADR-0009](../decisions/ADR-0009-dsh-compat-contract.md)。
- ~~附加根的 `AGENTS.md` 对模型不可见~~ → 顶层注入 + nested 注入 + 显式撤销/撤回，见 [ADR-0010](../decisions/ADR-0010-additional-root-instruction-scope.md)（§5 验收 7.8）。

仍然开放：

- 命令输出文案的 host 侧本地化（需要 host 侧的语言来源）。
- 第二期的全部范围（LSP 路由、Windows 内核级多根、`workspace-files` 多根等）见 §4 的优先级表与[路线图 §风险](../plans/active/2026-09-12-multi-root-workspace.md#风险与开放问题)。

