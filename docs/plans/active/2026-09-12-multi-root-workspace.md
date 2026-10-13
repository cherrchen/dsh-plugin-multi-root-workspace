# 开发路径文档：Multi-root Workspace（不改上游）

> 状态：active（**进度总账 + 里程碑概览**）。MVP-v0.1.0（M1/M2/M3）已实施并以 `v0.1.0` 发版（2026-09-13）；v0.1.1 硬化批次（H1–H4）已实施、全绿并随 `v0.1.1` 发版（2026-09-16）；v0.1.2 支持矩阵提升（`0.1.6-alpha.2`、`0.1.7-alpha.1`）已实施并随 `v0.1.2` 发版（2026-09-22）；v0.1.3 支持矩阵提升（`0.1.7-alpha.2`、`0.1.7-rc.1`）已实施并随 `v0.1.3` 发版（2026-09-24）；v0.1.4 支持矩阵提升（`0.1.7-rc.2`）已实施并随 `v0.1.4` 发版（2026-09-25）；v0.1.5 DSH 0.2 支持矩阵提升已发版；v0.1.6 已发版；第二期（B 系列）范围见[需求文档 §4/§7](../../requirements/multi-root-workspace.md)。
> 设计依据：[multi-root-workspace.md](../../architecture/multi-root-workspace.md)；验收标准见 [multi-root-workspace.md](../../requirements/multi-root-workspace.md) §5。
> 产物是本仓库（`dsh-plugin-multi-root-workspace`，包 `@dsh-electron/dsh-plugin-multi-root-workspace`），经 `dsh plugin --profile <name> add <path|git>` 安装；对上游仓库（deepseek-harness）零改动。
> 插件仓库自建门禁（上游 `verify-cordis-config` 等仓库 gates 不适用）：lint + typecheck + vitest 全绿 + patch 快照测试。

## 编号口径

先读这一段，再读历史文档与评审材料。
本仓库同时存在「里程碑」与「批次」两套编号，历史文档、评审材料与 commit 各用其一，因此先约定：

- **M1 / M2 / M3** = MVP（`v0.1.0`）的三个里程碑（2026-09-12 实施，2026-09-13 发版）。
- **M4** = 跨进程 Registry Authority Lease（2026-09-15 加入路线图）。它与 v0.1.1 批次的 **H1 是同一件事的两个名字**：路线图叫 M4，批次叫 H1。
- **H1–H4** = v0.1.1 硬化批次的四项任务：H1 lease（= M4）、H2 面板主根改为 host session 推导、H3 DSH 兼容性代码契约、H4 附加根指令注入。
- **H4 分两期**：Phase 1（附加根**顶层** `AGENTS.md` / `CLAUDE.md`）与 Phase 2（nested instructions：由本会话**成功**触碰过的目录链增量补投）**均已实现**，见 [ADR-0010](../../decisions/ADR-0010-additional-root-instruction-scope.md)。
- 外部评审材料若用「M1–M4」指 v0.1.1 的四项，对应关系为：其 M1 = H1、其 M2 = H2、其 M3 = H3、其 M4 = H4。

## 进度总账

本表是**进度、编号与发布状态的唯一真源**；其他文档只链接到这里，不复制。

| 批次 | 编号 | 任务 | 详细计划 | ADR | commit | 发布状态 |
|---|---|---|---|---|---|---|
| MVP | M1 | 组合与空根直通：bundle 骨架、两行 provider 替换 | [M1 计划](../completed/2026-09-12-m1-composition-and-passthrough.md) | [0001](../../decisions/ADR-0001-provider-replacement-scope.md)、[0002](../../decisions/ADR-0002-upstream-coupling-policy.md) | `d9e5afb`…`faf0ef7` | `v0.1.0` |
| MVP | M2 | 附加根数据源、两个 provider 的多根逻辑、方言 grant、parity 矩阵 | [M2 计划](../completed/2026-09-12-m2-additional-roots-and-dialect-grants.md) | [0003](../../decisions/ADR-0003-dialect-grant-widening.md) | `852d2d4`…`f650143` | `v0.1.0` |
| MVP | M3 | root 注册表、`/workspace-folders`、Workspace Folders 面板、跨仓库旅程 e2e（含外部评审两轮返工） | [M3 计划](../completed/2026-09-12-m3-root-registry-command-and-ui.md) | [0004](../../decisions/ADR-0004-root-registry-persistence-and-validation.md)、[0005](../../decisions/ADR-0005-out-of-tree-client-transport.md)、[0006](../../decisions/ADR-0006-client-ui-host-tokens.md) | `ff235ae`…`fd1ab18` | `v0.1.0` |
| v0.1.1 | H1（= M4） | 跨进程 Registry Authority Lease：store-wide 内核 lease、争用 fail-closed、`refresh()` 接管 | [M4 计划](../completed/2026-09-15-m4-registry-authority-lease.md) | [0007](../../decisions/ADR-0007-registry-authority-lease.md) | `aa4b19e` | `v0.1.1` |
| v0.1.1 | H2 | 面板主根改为 host session 推导（删除客户端 `primaryRoot`） | [面板计划](../completed/2026-09-15-panel-session-derived-authority.md) | [0008](../../decisions/ADR-0008-panel-session-derived-authority.md) | `66375ca` | `v0.1.1` |
| v0.1.1 | H3 | DSH 兼容性从文档约定变成启动门禁 + `src/compat/` 适配层 + 按周升级车道 | [compat 计划](../completed/2026-09-15-dsh-compat-contract.md) | [0009](../../decisions/ADR-0009-dsh-compat-contract.md) | `d4b16ff` | `v0.1.1` |
| v0.1.1 | H4 Phase 1 | 附加根顶层 `AGENTS.md` / `CLAUDE.md` 以 `form=instructions` 注入模型上下文 | 同上 §5 | [0010](../../decisions/ADR-0010-additional-root-instruction-scope.md) | `d4b16ff` | `v0.1.1` |
| v0.1.1 | H4 Phase 2 | 附加根 nested instructions：本会话成功触碰过的子目录增量注入、变化重发、消失撤回 | 同上 §5b（该设计草案的实现） | [0010](../../decisions/ADR-0010-additional-root-instruction-scope.md) | `507c954`…`76c6377` | `v0.1.1` |
| v0.1.2 | compat | DSH 支持矩阵扩展至 `0.1.6-alpha.2` 与 `0.1.7-alpha.1`；`0.1.6-alpha.2` 面板 Session 目录 `retainedBy.mainView` 探针 | — | [0009](../../decisions/ADR-0009-dsh-compat-contract.md) | `318ff52`…`6e68a0b` | `v0.1.2` |
| v0.1.3 | compat | DSH 支持矩阵扩展至 `0.1.7-alpha.2` 与 `0.1.7-rc.1`；形状未变，`rc.1` 安装期 peer 门禁要求精确 peer | — | [0009](../../decisions/ADR-0009-dsh-compat-contract.md) | `10381fc` | `v0.1.3` |
| v0.1.4 | compat | DSH 支持矩阵扩展至 `0.1.7-rc.2`；相对 `rc.1` 形状未变，无新适配分支，cordis 仍是 `~4.0.4` | — | [0009](../../decisions/ADR-0009-dsh-compat-contract.md) | `f2a8f75` | `v0.1.4` |
| v0.1.5 | compat | DSH 支持矩阵扩展至 `0.2.0-rc.1` / `0.2.0-rc.2`，开发 pin 升级，全部支持版本 × OS 的持续矩阵 | [本次记录](#dsh-02-兼容提升2026-09-30) | [0009](../../decisions/ADR-0009-dsh-compat-contract.md) | `135af7f` | `v0.1.5` 已发布 |
| v0.1.6 | DSH 0.2.1 + B1–B3 + ADR-0012 | DSH `0.2.1-alpha.1` / `.2`；Session origin 与动态 cwd 分离；附加根 LSP、Windows ACL、文件树与 Worktree | [B1–B3](#b1b3第二期-p12026-10-02)、[DSH 0.2.1](#dsh-021-迁移与目录安全契约2026-10-10) | [0011](../../decisions/ADR-0011-multi-root-workspace-consumers.md)、[0012](../../decisions/ADR-0012-session-origin-and-effective-cwd.md) | `466b3bb` | `v0.1.6` |
| 第二期 | B4 per-root / per-tool 权限 | 根自带 read-write / read-only 访问级别；`toolAccess` 按工具封顶附加根写权限（ALS 经 `tools/execute`）；命令与面板 surface | [B4–B8](./2026-10-11-b4-b8-p2.md) | [0013](../../decisions/ADR-0013-per-root-and-per-tool-access.md) | `99a443f`…`1758885`、`980b925`、`8e770c9`…`f4fc3df` | 未发布 |
| 第二期 | B5 mutation 前重分类 | 每个 mutation 的 serialize job 以存储记录重新分类再校验；revive 只看 fresh 分类 | [B4–B8](./2026-10-11-b4-b8-p2.md) | [0004 修订](../../decisions/ADR-0004-root-registry-persistence-and-validation.md)、[0014](../../decisions/ADR-0014-root-limit-and-provider-conflict.md) | `a3240b1`、`395e32b` | 未发布 |
| 第二期 | B6 附加根数量上限 | `maxAdditionalRoots` 默认 16、顶 64；按全部存储记录计数；超限存量照授只拒新增；非法配置 fail closed | [B4–B8](./2026-10-11-b4-b8-p2.md) | [0014](../../decisions/ADR-0014-root-limit-and-provider-conflict.md) | `067933f` | 未发布 |
| 第二期 | B7 provider 冲突检测 | 品牌 + `multi-root-providers` 门禁；外来 `ctx.fs`/`ctx.sandbox` 下注册表缺席、scope 为空 | [B4–B8](./2026-10-11-b4-b8-p2.md) | [0014](../../decisions/ADR-0014-root-limit-and-provider-conflict.md) | `2a36d5f` | 未发布 |
| 第二期 | B8 平台感知提示词 | `renderWorkspaceRootsContext` 纯函数化；按模式/平台/访问级别陈述授权；win32 附带 partial-enforcement 说明 | [B4–B8](./2026-10-11-b4-b8-p2.md) | [0013](../../decisions/ADR-0013-per-root-and-per-tool-access.md) | `a7f3d20` | 未发布 |
| 第二期 | B9 附加根三态权限与跨 SandboxMode 执行一致性 | 继承 / 只读 / 读写；显式根权限覆盖会话模式默认行为，文件与新进程执行一致；先验证 Full-access 局部限权 | [B9 计划](./2026-10-13-b9-root-access-and-sandbox-modes.md) | [0017](../../decisions/ADR-0017-three-state-root-access-and-sandbox-modes.md)；并修订 [0001](../../decisions/ADR-0001-provider-replacement-scope.md)/[0003](../../decisions/ADR-0003-dialect-grant-widening.md)/[0011](../../decisions/ADR-0011-multi-root-workspace-consumers.md)/[0012](../../decisions/ADR-0012-session-origin-and-effective-cwd.md)/[0013](../../decisions/ADR-0013-per-root-and-per-tool-access.md) | — | 实现已落地（575 测试通过）；Windows Full-access 局部只读重新纳入 B9，deny-token 实现与原生 CI 验收中；Landlock 该组合仍显式拒绝，未发布 |
| 第二期 | 后续 P3 项 | Registry observer 语义、TOCTOU 表述、workspace 导入导出、SDK API 等 | 见[需求文档 §4/§7](../../requirements/multi-root-workspace.md) | — | — | 未开始 |

## 总体策略

MVP 三个里程碑加一个硬化批次，每一项都独立可验证，且**第一步就建立"空根直通 = 上游行为"的安全网**，之后所有增量都在安全网内：

- **M1 组合与直通（已完成）**：bundle 骨架 + 两行替换 + 空根直通。插件已可安装，行为与未装一致；组合、disable/insert 时序与 provide 冲突这三项结构性风险已清零。
- **M2 多根能力（已完成）**：附加根数据源 + 两个 provider 的多根逻辑 + 方言 grant + parity 测试。
- **M3 Root 管理与 UI（已完成）**：注册表、命令、client 半部、e2e。
- **H1（= M4）跨进程 Authority（已完成）**：store-wide 内核 lease，争用 fail-closed。
- **H2 面板权威收紧（已完成）**：面板主根只从 host session 推导，删除客户端 `primaryRoot`。
- **H3 兼容性代码契约（已完成）**：精确版本 allowlist + 启动门禁 + `src/compat/` 适配层 + 按周升级车道。
- **H4 附加根指令（已完成）**：Phase 1 让附加根顶层 `AGENTS.md` / `CLAUDE.md` 在第一步之前进入模型上下文；Phase 2 让本会话成功触碰过的子目录增量补投、内容变化重发、文件消失显式撤回。

## M1 — bundle 骨架、两行替换、空根直通（已完成）

> 任务清单、设计决定、验证判据、T0 探查结论与实施结果见 **[M1 开发计划（completed）](../completed/2026-09-12-m1-composition-and-passthrough.md)**；本文件只保留里程碑概览，不重复其内容。

相对首版路线的修正（已同步架构与需求文档）：

- 替换集合收窄为两行（`fs-sandbox`、`sandbox`）：bash 与 PTY 的 confinement 全部经 `ctx.sandbox`，`bash-sandbox` 保持上游（[ADR-0001](../../decisions/ADR-0001-provider-replacement-scope.md)）。
- scope 服务在 M1 落地（数据源为空表），provider 只经它取根；M2 只替换数据源，provider 结构不变。
- fs provider 在 M1 即实现 containment（空根时根列表长度为 1），并以差分 parity 测试证明与上游 `SandboxedFileSystem` 等价：`LocalFileSystem` 自身没有 fence，"直通 super"会丢掉 fence。
- 方言 builder 不可深导入（发布包不含 `src/`），M2 改为克隆 `super.confine` 的 grant 模板；识别失败即抛错（[ADR-0002](../../decisions/ADR-0002-upstream-coupling-policy.md)）。

验证（已完成）：`pnpm lint` / `typecheck` / `test`、`pnpm smoke:compose`（30/30）、`pnpm smoke:behavior`（54/54）、`pnpm docs:check`；两个冒烟在 `0.1.5-rc.2` 与 `0.1.2-rc.1` 双运行时上均通过。

## M2 — 附加根数据源与多根 provider（已完成）

> 任务清单、设计决定、验证判据与实施结果见 **[M2 开发计划（completed）](../completed/2026-09-12-m2-additional-roots-and-dialect-grants.md)**；本文件只保留里程碑概览，不重复其内容。

相对首版路线的修正（已同步架构与需求文档）：

- `MultiRootFileSystem` 的多根 containment 在 M1 就已实现，M2 的 fs 侧增量是「证明与方言授予集合逐项一致」的 parity 矩阵 + 多根 denial 文案回归。
- 方言 grant 的实现形态定为**结构识别 + 观测克隆 + 已授予跳过**（不给 win32 制造 ACL 副作用、不硬编码上游 flag），识别失败抛 `SandboxUnavailableError`（[ADR-0003](../../decisions/ADR-0003-dialect-grant-widening.md)）。
- 拓扑快照落在 scope 服务内（不新增 patch 行），仅 workspace-write + 非空根输出（空根/只读逐字节不变）。
- 不新增 `windows-latest` CI 腿：win32 行为用 `internals.chain` 在任意宿主上钉住。

验证（已完成）：`pnpm lint` / `typecheck` / `test`（79 项：3 项真实受限执行按宿主能力显式 skip）、`pnpm build`、`pnpm smoke:compose`（30/30）、`pnpm smoke:behavior`（69/69，4 项显式 skip）、`pnpm docs:check`；两个冒烟在 `0.1.5-rc.2` 与 `0.1.2-rc.1` 双运行时上均通过。

## M3 — Root 注册表、命令、client UI、e2e（已实施，且按外部审查返工后重新验收）

> 任务清单、设计决定、修正依据、验证判据与实施结果见 **[M3 开发计划（completed）](../completed/2026-09-12-m3-root-registry-command-and-ui.md)**；本文件只保留里程碑概览，不重复其内容。

相对首版路线的修正（依据见 M3 计划「对路线图 M3 段落的修正」表）：

- **不接入** `sidebar.workspaces.directoryFlow` / `conversation.hero.workspace.directoryFlow`：它们是 ui-workspace「创建工作区」流程的 single 洞且已被默认 picker 包占用；add 改走 host 侧 `ctx.directoryPicker` 与 client 侧 `ctx.uiWorkspace.pickDirectory()`。
- **不使用 Typert 远程命名空间**：出树契约生成不可用（generator 是 workspace 形状）、client 侧 remote 清单是上游静态表；面板改用 Connection RPC 通道（兄弟插件同款公开缝，双运行时可用）。
- 面板落在 `sidebar.footer.action`（两个运行时都存在）+ 自绘对话框；0.1.5 专属的 `sidebar.panellist`/`main` 全屏面板不在 M3。
- 注册表以 **canonical 主根** 为存储键（`ctx.workspaceRegistry` 在 headless 不存在）；nested roots **拍板拒绝**。
- e2e 用真实组合 + 无凭据脚本化模型在进程内驱动真实 agent turn（web 与 headless 各一轮），不引入 Playwright/Electron 车道。

**外部审查返工（2026-09-12）**：审查提出 8 项发现（3 项发布阻断）——登记根被替换为符号链接后授权转移、并发改注册表丢写/复活已撤销授权、CI 先测后构建、刷新不重查目录、手输路径被 picker 覆盖、Reveal 应答契约不一致、重复 id 未校验、主根未纳入嵌套校验。已全部修复并各带回归测试，取舍与语义写入 [ADR-0004](../../decisions/ADR-0004-root-registry-persistence-and-validation.md)（返工补充第 9–15 条）与 [架构 §4/§7](../../architecture/multi-root-workspace.md)；逐项证据见 M3 计划「外部审查返工」章节。

## v0.1.1 — 硬化批次（H1–H4，已实施，已发版）

> 任务清单、设计决定、验证判据与实施结果见各自的 completed 计划；本文件只保留批次概览，不重复其内容。

- **H1（= M4）跨进程 Registry Authority Lease**：[M4 计划](../completed/2026-09-15-m4-registry-authority-lease.md)、[ADR-0007](../../decisions/ADR-0007-registry-authority-lease.md)、commit `aa4b19e`。POSIX `flock` / Windows named semaphore 表达"同一时刻只有一个 Registry Authority Process"；争用进程 fail-closed（空 scope、mutation 抛 `registry-contended`），对方退出或崩溃后由 `refresh()` 接管。
- **H2 面板主根 host 推导**：[面板计划](../completed/2026-09-15-panel-session-derived-authority.md)、[ADR-0008](../../decisions/ADR-0008-panel-session-derived-authority.md)、commit `66375ca`。`PanelRequest` 删除客户端 `primaryRoot`、`sessionId` 变为每个端点必填；host 唯一 resolver 是 `resolvePanelPrimaryRoot(ctx, sessionId)`。
- **H3 DSH 兼容性代码契约**：[compat 计划](../completed/2026-09-15-dsh-compat-contract.md)、[ADR-0009](../../decisions/ADR-0009-dsh-compat-contract.md)、commit `d4b16ff`。精确版本 allowlist（`0.1.5-rc.2` / `0.1.6-alpha.1`）、`multi-root-compat` 启动门禁（四个安全相关行全部 inject `multiRootCompat`）、混装 fail loud、`src/compat/` 适配层、`upgrade.yml` 按周升级车道（不自动扩大支持矩阵）。
- **H4 附加根指令注入**：同一计划 §5/§5b、[ADR-0010](../../decisions/ADR-0010-additional-root-instruction-scope.md)。Phase 1：附加根**顶层** `AGENTS.md` / `CLAUDE.md` 经 `agent/pre-step` 以 `form: 'instructions'` 的 user 消息注入（format 3 的 source kind 是 `plugin`，format 4 起是 `multi-root-workspace`），共享 64 KiB 预算，根离场时显式撤销。Phase 2：本会话**成功**的 `read` / `write` / `edit` 触碰过的子目录里的同类文件，在其目录被考察到时补投（触碰取自持久化的 `session/event` 的 `tool/call` + `tool/result` 配对），内容变化只重发该文件，文件消失则显式撤回。Phase 1 的验收场景与证据见该计划 §5；Phase 2 的验收判据见需求文档 §5 的 7.8，端到端证据在 `pnpm smoke:journey` 两条腿。

第二轮审查（2026-09-16）的新增发现、修复和验证见同一[返工报告](../completed/2026-09-15-v0.1.1-review-rework.md#第二轮审查与修复2026-09-16)。

**PR #1 评审返工（2026-09-15）**：发版前的 Codex 自动评审（head `507c954`）提出 5 项发现（P1×2 / P2×3），已全部修复并各带「修复前红、修复后绿」的回归测试；逐项证据、验收判据与文档同步见 [v0.1.1 评审返工计划](../completed/2026-09-15-v0.1.1-review-rework.md)，语义写入 [ADR-0007](../../decisions/ADR-0007-registry-authority-lease.md) / [ADR-0009](../../decisions/ADR-0009-dsh-compat-contract.md) / [ADR-0010](../../decisions/ADR-0010-additional-root-instruction-scope.md) 的返工补充。一行摘要：

- **P1-1 lease 拆除顺序**：`releaseAuthority()` 原本先释放 lease 再 close domain，且未串入 store-wide authority 转场队列 —— 继任者可能读到缺最后一次写的快照，在飞 acquisition 还可能在拆除之后完成并泄漏 domain + lease；现改为在转场队列内「排空在飞 mutation → close domain → release lease」，并置 `disposed` 拒绝后续 acquisition（[ADR-0007](../../decisions/ADR-0007-registry-authority-lease.md)）。
- **P1-2 中间目录指令**：`planRoot()` 原本只考察被触碰文件的父目录，`<root>/a/AGENTS.md` 被精确目录过滤丢弃；现考察父目录及其每个祖先目录（直到该附加根），中间目录的规则才到得了模型（[ADR-0010](../../decisions/ADR-0010-additional-root-instruction-scope.md)）。
- **P2-3 warn 收紧**：`DSH_MULTI_ROOT_COMPAT=warn` 原本放宽所有非 `supported` 判定；现只放宽 `unsupported`，`mixed` / `incomplete` 两种模式都拒绝（[ADR-0009](../../decisions/ADR-0009-dsh-compat-contract.md)）。
- **P2-4 可选 peer 按需加载**：新增 `src/compat/llm-message.ts`，`@deepseek-ai/dsh-llm` 在真正构造消息时才 import；barrel 的加载期依赖集合等于必需包集合（旧形态下零附加根的最小组合会在加载 carrier 行时失败）（[ADR-0009](../../decisions/ADR-0009-dsh-compat-contract.md)）。
- **P2-5 缺失与求值失败区分**：新增 `isPackageInstalled()` 单独探测可解析性；「已安装但求值失败」不再被当作缺失缓存吞掉（旧形态下整个进程会静默停止投递附加根指令）（[ADR-0009](../../decisions/ADR-0009-dsh-compat-contract.md)）。

### 发版准备与跨平台回归（2026-09-16）

`fix/v0.1.1-hardening` 经 PR #1 合入 `main`（merge `6b4c796`）之后，发版前做了四件事；每一件都可复现，命令写在[开发工作流](../../development/plugin-development-workflow.md)与[发版流程](../../development/release-workflow.md)。

| 项 | 结果 |
|---|---|
| 发布状态与 CHANGELOG | 路线图、README（中英）、需求/架构/各目录 README 的版本句改为"随 `v0.1.1` 发版"；新增 [`CHANGELOG.md`](../../../CHANGELOG.md) / [`CHANGELOG.en.md`](../../../CHANGELOG.en.md) 记录 `0.1.0` 与 `0.1.1` 的使用者可见变更，并把"每个版本写 CHANGELOG"写进发版流程 |
| 基线运行时完整矩阵（`0.1.5-rc.2`） | `compat:check` + `lint` + `typecheck` + `build` + `kernel:probe` + `test`（321 passed / 3 skipped）+ compose 40/40 + behavior 99/99 + journey 55/55 + `docs:check` 全绿 |
| 第二运行时完整矩阵（`0.1.6-alpha.1`） | 按升级流程重指 pin、重装后 `DSH_MULTI_ROOT_COMPAT=warn pnpm verify:all` 全绿（同样的 321 passed / 3 skipped 与三个冒烟计数），随后回退三文件并 `pnpm install --frozen-lockfile` 回到基线 |
| Windows 验证腿 | 仓库是公开仓库、标准 runner 在公开仓库上不计费，因此把仓库变量 `DSH_WINDOWS_CI` 置 1；首次运行即抓到 `tests/scope.spec.ts` 两处期望值用 `/` 拼接路径（产品侧交回的是 `canonicalPath()` 的平台分隔符），修正后 [macOS / ubuntu / Windows 三条腿全绿](https://github.com/cherrchen/dsh-plugin-multi-root-workspace/actions/runs/35055445350) |
| 打包产物校验 | 按 `release.yml` 的做法 `pnpm pack` 并逐项校验 tarball，发现 `lib/` 里残留 4 份历史 `instructions-*` chunk 与陈旧的 registry / lease chunk（tsdown `clean: false` + 内容哈希命名），已由 `scripts/clean-lib.mjs` 在 `bundle` 前清掉上一轮的 JS 面；CI 在干净 checkout 上看不到这个问题，只有本地打包会 |
| 打包产物端到端安装 | 把 tarball 装进隔离 `$DSH_HOME` 并跑与 `smoke:compose` 同构的差分断言：首次 `add` **在四种来源下都会失败**——本批次新增的生产依赖 `koffi` 带构建脚本，pnpm ≥10 默认不运行它，`dsh` 因此判定 pnpm 失败并且**不回填** `dsh.profile.bundles`；按 profile 里留下的 `allowBuilds` 待决项回答 `true` 后重跑成功，装出的组合与预期逐项一致（8 行 insert、两行 disabled、顺序不变） |

**版本号与 tag 由发版提交完成**（`pnpm release patch --tag` → `chore(release): v0.1.1` + annotated tag `v0.1.1`）；推送 tag（进而触发 npm 发布与 GitHub Release）是人工动作，绿灯是证据、不是授权。桌面端（Electron）车道仍未建立，属人工验证。

## v0.1.2 — 支持矩阵提升（已实施，已发版）

> 用户可见变更见 [`CHANGELOG.md`](../../../CHANGELOG.md) 的 `0.1.2` 条目；设计取舍仍见 [ADR-0009](../../decisions/ADR-0009-dsh-compat-contract.md)。

### 支持矩阵提升（随 `v0.1.2` 发版，2026-09-22）

`0.1.6-alpha.2` 按 [ADR-0009](../../decisions/ADR-0009-dsh-compat-contract.md) 的人工提升流程写入 allowlist（`peerDependencies` 同步为三项精确或）。开发 pin 与 lockfile 仍是 `0.1.5-rc.2`。`confine` 仍是带可选 `signal` 的 `Promise`，instruction renderer 仍是 `renderAgentInstructions`，journey 的 Messages 端点未改。**客户端 Session 目录删掉了 `current`**，面板必须走 `src/compat/client-session.ts` 同时认旧的 `list.current` 与新的 `retainedBy.mainView`。

| 项 | 结果 |
|---|---|
| 纳入前（pin 在 `0.1.6-alpha.2`，`DSH_MULTI_ROOT_COMPAT=warn`） | `pnpm verify:all` 全绿：321 passed / 3 skipped，compose 40/40，behavior 99/99，journey 55/55。macOS，seatbelt 可用，bwrap / landlock 不可用 |
| 纳入后 enforce（同一棵 `0.1.6-alpha.2` 树） | `pnpm compat:check` + `pnpm verify:all` 全绿，计数相同 |
| 基线回归（pin 回到 `0.1.5-rc.2`，enforce） | `pnpm compat:check` + `pnpm verify:all` + `pnpm docs:check` 全绿，计数相同 |

### 支持矩阵提升（随 `v0.1.2` 发版，2026-09-22）：`0.1.7-alpha.1`

`0.1.7-alpha.1` 按 [ADR-0009](../../decisions/ADR-0009-dsh-compat-contract.md) 的人工提升流程写入 allowlist（`peerDependencies` 同步为四项精确或）。开发 pin 与 lockfile 仍是 `0.1.5-rc.2`（cordis 仍是 `4.0.2`）。`confine` 与 instruction renderer 的形状没变，journey 仍走 `/v1/messages`。客户端 Session 目录与 `0.1.6-alpha.2` 一样没有 `current`，面板继续走 `src/compat/client-session.ts` 的 `retainedBy.mainView` 探针。适配层有改动：session format 4 拒绝 `kind: 'plugin'`（改投 `multi-root-workspace`）、工具失败位移到消息上、面板图标改为 Regular、进程内启动改为 `PluginPackages`、bash 改为 `execute().result()`。探测时 cordis 必须钉到 `4.0.3`，否则两份 `dsh-tools` 让调度 Symbol 对不上。

| 项 | 结果 |
|---|---|
| 纳入前（pin 在 `0.1.7-alpha.1`，cordis `4.0.3`，`DSH_MULTI_ROOT_COMPAT=warn`） | `pnpm verify:all` 全绿：329 passed / 3 skipped，compose 40/40，behavior 99/99，journey 55/55。macOS，seatbelt 可用，bwrap / landlock 不可用（rebase 前、尚未带 `client-session`） |
| 纳入后 enforce（同一棵 `0.1.7-alpha.1` 树） | `pnpm compat:check` + `pnpm verify:all` 全绿，计数相同 |
| 基线回归（pin 回到 `0.1.5-rc.2`，cordis `4.0.2`，enforce） | 同一次数：测试 329 passed / 3 skipped，compose 40/40，behavior 99/99，journey 55/55。`pnpm docs:check` 通过 |
| rebase `main` 后重跑（含 PR #4 的 Session 目录探针，2026-09-22） | 0.1.7 客户端目录仍无 `current`，`retainedBy.mainView` 谓词未变。enforce 在 `0.1.7-alpha.1` + cordis `4.0.3` 与基线 `0.1.5-rc.2` + cordis `4.0.2` 上都是 343 passed / 3 skipped，compose 40/40，behavior 99/99，journey 55/55。`pnpm docs:check` 通过 |

### 发版准备（2026-09-22）

| 项 | 结果 |
|---|---|
| 发布状态与 CHANGELOG | 路线图、README（中英）的版本句与 tarball / tag 示例对齐 `v0.1.2`；[`CHANGELOG.md`](../../../CHANGELOG.md) / [`CHANGELOG.en.md`](../../../CHANGELOG.en.md) 新增 `0.1.2` 条目 |
| 本地门禁 | `compat:check` + `lint` + `typecheck` + `build` + `test`（342 passed / 4 skipped）+ `smoke:compose` 40/40 + `smoke:behavior` 91/91（4 项 seatbelt 不可用 skip）+ `smoke:journey` 55/55 + `docs:check` 全绿（2026-09-22，macOS） |

**版本号与 tag 由发版提交完成**（`pnpm release patch --tag` → `chore(release): v0.1.2` + annotated tag `v0.1.2`）；推送 tag（进而触发 npm 发布与 GitHub Release）是人工动作。

## v0.1.3 — 支持矩阵提升（已实施，已发版准备完成）

> 用户可见变更见 [`CHANGELOG.md`](../../../CHANGELOG.md) 的 `0.1.3` 条目；设计取舍仍见 [ADR-0009](../../decisions/ADR-0009-dsh-compat-contract.md)。

### 支持矩阵提升（随 `v0.1.3` 发版，2026-09-24）：`0.1.7-alpha.2` 与 `0.1.7-rc.1`

这两项按 [ADR-0009](../../decisions/ADR-0009-dsh-compat-contract.md) 写入 allowlist（`peerDependencies` 同步为六项精确或）。开发 pin 与 lockfile 仍是 `0.1.5-rc.2`（cordis 仍是 `4.0.2`）。相对 `0.1.7-alpha.1`，适配层没有新分支；`rc.1` 的安装期 peer 门禁要求 allowlist 与 `peerDependencies` 同时带上该精确版本。探测时 cordis 钉 `4.0.4`。

| 项 | 结果 |
|---|---|
| `0.1.7-alpha.2` 纳入前（cordis `4.0.4`，`DSH_MULTI_ROOT_COMPAT=warn`） | 343 passed / 3 skipped，compose 40/40，behavior 99/99，journey 55/55。macOS，seatbelt 可用，bwrap / landlock 不可用 |
| `0.1.7-rc.1` 纳入后 enforce（cordis `4.0.4`） | 同样 343 passed / 3 skipped，compose 40/40，behavior 99/99，journey 55/55 |
| 基线回归（pin 回到 `0.1.5-rc.2`，cordis `4.0.2`，enforce） | `compat:check` + `docs:check` 通过；343 passed / 3 skipped，compose 40/40，behavior 99/99，journey 55/55 |

### 发版准备（2026-09-24）

| 项 | 结果 |
|---|---|
| 发布状态与 CHANGELOG | 路线图、README（中英）的版本句与 tarball / tag 示例对齐 `v0.1.3`；[`CHANGELOG.md`](../../../CHANGELOG.md) / [`CHANGELOG.en.md`](../../../CHANGELOG.en.md) 新增 `0.1.3` 条目 |
| 本地门禁 | `compat:check` + `lint` + `typecheck` + `build` + `test`（342 passed / 4 skipped）+ `smoke:compose` 40/40 + `smoke:behavior` 91/91（4 项 seatbelt 不可用 skip）+ `smoke:journey` 55/55 + `docs:check` 全绿（2026-09-24，macOS） |

**版本号与 tag 由发版提交完成**（`pnpm release patch --tag` → `chore(release): v0.1.3` + annotated tag `v0.1.3`）；推送 tag（进而触发 npm 发布与 GitHub Release）是人工动作。

## v0.1.4 — 支持矩阵提升（已实施，已发版准备完成）

> 用户可见变更见 [`CHANGELOG.md`](../../../CHANGELOG.md) 的 `0.1.4` 条目；设计取舍仍见 [ADR-0009](../../decisions/ADR-0009-dsh-compat-contract.md)。

### 支持矩阵提升（随 `v0.1.4` 发版，2026-09-25）：`0.1.7-rc.2`

`0.1.7-rc.2` 按 [ADR-0009](../../decisions/ADR-0009-dsh-compat-contract.md) 写入 allowlist（`peerDependencies` 同步为七项精确或）。开发 pin 与 lockfile 仍是 `0.1.5-rc.2`（cordis 仍是 `4.0.2`）。相对 `0.1.7-rc.1`，适配层没有新分支。安装期 peer 门禁与 `rc.1` 相同。探测时 cordis 钉 `4.0.4`。

| 项 | 结果 |
|---|---|
| `0.1.7-rc.2` 纳入后 enforce（cordis `4.0.4`，peer 已含该版本） | lint / typecheck / build / kernel:probe 通过；343 passed / 3 skipped，compose 40/40，behavior 99/99，journey 55/55。macOS，seatbelt 可用，bwrap / landlock 不可用 |
| 基线回归（pin 回到 `0.1.5-rc.2`，cordis `4.0.2`，lockfile 保持基线，enforce） | `compat:check` 与 `docs:check` 通过；同样 343 passed / 3 skipped，compose 40/40，behavior 99/99，journey 55/55 |

### 发版准备（2026-09-25）

| 项 | 结果 |
|---|---|
| 发布状态与 CHANGELOG | 路线图、README（中英）的版本句与 tarball / tag 示例对齐 `v0.1.4`；[`CHANGELOG.md`](../../../CHANGELOG.md) / [`CHANGELOG.en.md`](../../../CHANGELOG.en.md) 新增 `0.1.4` 条目 |
| 本地门禁 | `compat:check` + `lint` + `typecheck` + `build` + `test`（343 passed / 3 skipped）+ `smoke:compose` 40/40 + `smoke:behavior` 99/99 + `smoke:journey` 55/55 + `docs:check` 全绿（2026-09-25，macOS） |

**版本号与 tag 由发版提交完成**（`pnpm release patch --tag` → `chore(release): v0.1.4` + annotated tag `v0.1.4`）；推送 tag（进而触发 npm 发布与 GitHub Release）是人工动作。

## 里程碑与仓库状态对照

进度、编号与发布状态的唯一真源是本文开头的[进度总账](#进度总账)；此处不再重复维护一份对照表。

## 测试与检查指引

```sh
# 插件仓库（自建门禁）
pnpm typecheck && pnpm lint && pnpm test          # vitest：方言单测、方言 grant 矩阵、空根差分 parity、patch 不变量、注册表/lease、契约往返、指令注入
pnpm smoke:compose                                 # dsh --dump-config 组合差分断言（只差两行禁用 + 八行 insert）
pnpm smoke:behavior                                # 空根直通 + 多根 battery + 注册表/命令 battery（隔离 $DSH_HOME，进程内 boot）
pnpm smoke:journey                                 # 跨两个 git repo 的 web/headless 旅程（脚本化模型，无凭据）
pnpm verify:all                                    # lint → typecheck → build → kernel:probe → test → smoke

# 升级检查（每次上游发版手动/CI 触发）
# 改 pin（精确版本）后重跑差分 parity + 方言矩阵 + smoke:compose + smoke:behavior；差异即报警（pre-stable API 风险）
```

**没有** `smoke:multiprocess` / `smoke:instructions` 这两个脚本，这是刻意的：跨进程争用与指令注入的正确性由 vitest 覆盖（`tests/registry-multiprocess.e2e.ts` 真的起第二个 OS 进程、`tests/instructions.spec.ts` 覆盖注入与撤销），因为它们需要夹具级的进程编排与断言，塞进 `--dump-config` 式的冒烟只会更难定位。

上游仓库（deepseek-harness）本身在此项目中的唯一用途是**阅读与对照**：不修改任何文件，不在其中跑本插件的 CI；smoke 通过环境内安装的 dsh 运行。

## 风险与开放问题

| # | 风险/问题 | 影响 | 处置 |
|---|---|---|---|
| 1 | 上游 pre-stable API 升级破坏子类（AGENTS.md 明言无 semver 承诺） | 插件可用性 | 精确 pin（`latest` dist-tag 陈旧，必须写死版本，见 ADR-0002）+ 启动门禁（ADR-0009）+ 按周升级车道；只允许包入口导入；M1 即建立差分对照测试 |
| 2 | 方言 parity 责任转移到插件 | 安全正确性 | 已落地：parity 矩阵测试（测试侧独立解析 argv 授予集合）+ 方言单测为核心资产；方言 grant 由 `super.confine` 输出克隆模板（上游 builder 在发布形态下不可达），识别失败即抛错（[ADR-0003](../../decisions/ADR-0003-dialect-grant-widening.md)） |
| 3 | ~~bash 子类落点未定~~（已关闭） | — | 不替换 `bash-sandbox`：bash 与 PTY 的 confinement 全部经 `ctx.sandbox`（ADR-0001） |
| 4 | provider 行替换影响未盘点的 Consumer | 隐藏回归 | 已盘点：`ctx.sandbox` 的消费者是 bash-sandbox / pwsh-sandbox / terminal-bash；`ctx.fs` 的消费者是 tool-fs / tool-str-replace-editor。全部只依赖 `confine`、`sandboxMode` 等结构化事实；M1 冒烟逐一实跑 |
| 5 | disable/insert 时序或 id 变化（上游 base patch 行 id 不是稳定承诺） | 组合失败 | duplicate-provide 天然抛错 + 插件身份断言 + `smoke:compose` 组合差分断言 |
| 6 | Windows 内核级多根缺失（pwsh 方言） | Windows bash 场景 | B2 已实现 root-set SID runner；2026-10-11 起 `kernel:probe` 在 Windows 上以真实上游 runner 验证 `windows-acl` 并导出方言，Windows 冒烟与原生用例在全部 11 个支持版本上原生执行，证据见 [B1–B3 加固记录](#b1b3-加固与-windows-全量验证2026-10-11)；网络/设备根在 Windows 上按 `unsupported-path` 词法拒绝 |
| 7 | `isPathUnder` 等价实现的正确性 | fence 语义漂移 | 深导入不可用（发布包不含 `src/`，ADR-0002）⇒ 本地实现 + 注明出处 + M1 差分 parity 套件钉住；M2 起另由方言矩阵复验 |
| 8 | 拓扑快照进入 context 对 prompt cache 的影响 | 长会话成本 | 已落地：空根 / 只读 / 无 agent 时零输出（逐字节快照断言）；根集变化频率 = 用户增删根频率，可接受 |
| 9 | ~~nested roots 态度未最终拍板~~（已关闭） | — | 已拍板**拒绝**（[ADR-0004](../../decisions/ADR-0004-root-registry-persistence-and-validation.md)） |
| 10 | 桌面端（apps/desktop）插件安装形态与 CLI profile 的差异 | M3 e2e | 已安装桌面 app 用的是 `web` profile（其自带 runtime 0.1.2-rc.1）；M3 的面板因此落在两个运行时都有的 `sidebar.footer.action` 上，Electron 车道仍未建立（人工验证） |
| 11 | Linux CI 上 bwrap 可能不可用（用户命名空间受限） | 真实执行用例被跳过 | 内核链有第二个 rung（Landlock）；矩阵与冒烟只在 runner 真的不可用时显式 skip，并在输出里说明原因，不把"没跑"记成通过 |
| 12 | ~~附加根 nested instructions 未实现（H4 Phase 2）~~（已关闭） | — | 已实现（H4 Phase 2）：触碰取自持久化的 `session/event`（`tool/call` + `tool/result` 配对，只认成功的 `read` / `write` / `edit`），不使用 `SessionMessageProjection`；语义与边界见 [ADR-0010](../../decisions/ADR-0010-additional-root-instruction-scope.md) |
| 13 | 触碰识别只覆盖 `read` / `write` / `edit` | 其他写文件工具（`str_replace_editor` 等）触碰的目录不会立刻发现其 nested 指令 | 记录为已知限制（需求文档 §5「已知限制」、README 已知限制）；上游同样只认这三个名字，扩大集合需要先有让插件识别工具类别的 seam |
| 14 | 桌面端自带的旧 runtime（`0.1.2-rc.1`）不在 `v0.1.1` 的 allowlist 上 | 已安装的桌面端在升级自带 runtime 之前，插件的四行**不启动**（fail loud，组合退化为"未装插件"），即相对 `v0.1.0` 的功能回退 | 属 [ADR-0009](../../decisions/ADR-0009-dsh-compat-contract.md) 有意的收窄（范围承诺换成了实测清单）；已在 [CHANGELOG](../../../CHANGELOG.md) / [README](../../../README.md) 的「升级注意 / 环境要求」里明示，桌面端升级自带 runtime 后自动恢复；Electron 车道仍未建立 |
| 15 | 生产依赖 `koffi`（Windows lease 的 FFI）带构建脚本，pnpm ≥10 默认不运行它 | 四种安装来源的**第一次** `dsh plugin add` 都会失败一次（可恢复：回答 profile 的 `allowBuilds` 后重跑）；实测（`0.2.1-alpha.2`，tarball）profile 的 `pnpm-workspace.yaml` 可能**没有**待决标记，且恢复后的 `add` 不激活 bundle，需要 remove+add（见故障排查）；`v0.1.0` 只在 git 来源有这一步 | 已写入 [README §安装](../../../README.md)、[CHANGELOG 升级注意](../../../CHANGELOG.md) 与[故障排查：安装停在构建授权](../../troubleshooting/install-stops-at-build-approval.md)（含激活验证与 remove+add 恢复）。根治要重新设计 Windows Authority 的原生依赖（例如按需可选加载），属第二期 |

## 与"可改上游"路线的关系

若未来允许向上游贡献，按架构文档 §9 的 PR 栈提交通用 Filesystem Scope Seam；合入后本插件撤销三个替换行、provider 子类退化为 scope contributor——`FilesystemScope` 接口自 M2 起即按该 seam 目标形态设计，迁移是删除而非重写。

### DSH 0.2 兼容提升（2026-09-30）

用户授权范围是 `dsh-v0.1.7-rc.2` 至 `dsh-v0.2.0-rc.2` 的所有发布版本。上游本地 tag 与 npm `versions` 列表一致：这个闭区间只有起点及 `0.2.0-rc.1` / `0.2.0-rc.2`。支持合同保留全部旧版，再纳入这两个精确版本；开发 pin 与 lockfile 升到 `0.2.0-rc.2`，cordis 是 `4.0.4`。这批已整理为 **v0.1.5** 发版内容并通过本地及远端门禁；当前仅完成发版准备，插件版本号仍是 `0.1.4`，尚未创建 release tag 或发布 npm 包。用户可见变更见双语 CHANGELOG 的 `0.1.5` 条目。

#### 接口变更与风险

对上游上述三个 tag 做源码差分，并用各自的 npm 发布包验证。版本形状判断继续集中在 `src/compat/`，没有新增版本字符串分支。

| 接缝 | 上游变化与影响 | 本次处理与证据 |
|---|---|---|
| fs / sandbox policy / profile dialect | `writeText` / `editText`、`confine`、Seatbelt / bwrap / Landlock profile 生成形状未变。0.2 的 Windows provider 新增 ACL diagnosis skill 的可选 `skills` 注册；rc.2 改进诊断脚本 | 继承上游 provider，保留软注册和空根透传；fs / sandbox / parity 差分套件及真实 Seatbelt 写入验证。Windows 内核多根仍不在承诺内 |
| 指令 discovery / renderer、runtime-context | 上游公开导出及本插件使用的事件接口未变 | 原适配器保留；顶层 / 嵌套发现、预算、显式撤销、空根零贡献的单测和 journey |
| agent-loop / session | `6a6f350b94` 新增 `ToolCallRecovery`：失败 step 关闭前补 `tool/result`，含纯文本 content、message `isError` 与 `data.error`；格式常量仍为 4 | 已有失败适配器能处理，新增 provider 回归分别覆盖旧 block 位、新 message 位、恢复事件，失败不能发现子目录指令。恢复结果缺少 call 配对时也不会创造 touch |
| 客户端 sessions / primitives / sidebar | fork 新增可选 `onCreated`；Input 改 forwardRef；sidebar 加遥测、rc.2 更新折叠布局；renderer 修复 factory ancestors 的引用稳定性 | 本插件不调用 fork；当前会话仍用 `retainedBy.mainView`，footer slot、Regular icons、Input / Modal 调用仍兼容。双面类型检查、客户端组件 / bundle 单测 |
| boot / profile / Connection RPC / registry storage | app-boot 增加可选 schedule bundle；`createRuntimeResolution` / `PluginPackages`、peer 精确校验、RPC 和 storage domain 接口未变 | 保留 bare-package carrier 行和 host-derived session authority；compose / behavior / journey 在真实 web 与 headless profile 上验证 |
| npm 安装树 / cordis / 升级脚本 | 旧上游的预发布范围可解析到同 minor 的更晚版本；`0.1.7-alpha.1` 首轮 boot 中 `dsh-client-connection` 被 runtime resolution 重定向到 `0.1.7-rc.2`，尽管顶层单测读到 alpha.1 | 门禁正确拒绝混装。`upgrade-dsh.mjs` 从现有精确 release-age 条目派生 workspace-only probe overrides，把整个已知 DSH 树与 cordis 固定到探测版，防止 `^4.0.3` 又解析出 `4.0.4` 并拆分调度 Symbol，拒绝覆盖自定义 overrides。probe 后恢复保存文件；生产门禁没有放宽 |
| Windows 矩阵安装 | 第一轮 CI 的八个旧版均在 `execFileSync('npm')` 报 `spawnSync npm ENOENT`，Windows 的 `npm.cmd` 不是直接可执行文件；开发版 frozen install 已通过 | 新增 shell-free npm launcher：Windows 通过当前 Node 执行随 Node 安装的 `npm-cli.js`，POSIX 保留原调用；回归覆盖带空格的 Windows 路径与参数边界，CI 重跑全部版本 |
| pnpm release age | pnpm 11 在 frozen install 和运行脚本前检查全部锁文件；0.2 传递 DSH 包及新 LibreOffice tooling 仍在年龄门禁内 | workspace 对当前开发版本逐包精确豁免，包含锁文件里的平台包；不使用跨版本包名通配。候选安装使用 `minimumReleaseAge=0`，临时重指后恢复 |

#### 持续矩阵与验证范围

CI 主车道从 `SUPPORTED_DSH_RELEASES` 派生版本轴，与 Linux / macOS / 启用的 Windows 做笛卡尔积；每个版本执行现有全部门禁，始终 enforce。开发 pin 验证 frozen lockfile，旧版用 upgrade 脚本重建一致安装树。日志制品同时包含版本与 OS，避免同名冲突。升级候选车道仍只给出证据，不自动扩大支持合同。

本次本地矩阵在 macOS 宿主运行，先以真实内核探针确认 Seatbelt，然后对每个版本传入 `DSH_PROBE_VERIFIED_DIALECTS=seatbelt`，因此 Seatbelt 不可执行会导致失败而非 skip。Linux bwrap / Landlock 与 Windows 本地未覆盖，由 PR 的对应 CI 腿验证；尚未完成的远端检查不得记为通过。矩阵期间逐版保存日志，结束后恢复 `0.2.0-rc.2` 的 manifest、workspace、lockfile、node_modules 与构建产物。

| 运行时 | 静态合同 / lint / 双面 typecheck / build | 单测 | compose / behavior / journey | 内核 |
|---|---|---|---|---|
| `0.1.5-rc.2` | 通过 | 346 passed / 3 skipped | 40/40、99/99、55/55 | Seatbelt 实际执行 |
| `0.1.6-alpha.1` | 通过 | 同上 | 同上 | 同上 |
| `0.1.6-alpha.2` | 通过 | 同上 | 同上 | 同上 |
| `0.1.7-alpha.1` | 通过 | 同上 | 同上 | 同上 |
| `0.1.7-alpha.2` | 通过 | 同上 | 同上 | 同上 |
| `0.1.7-rc.1` | 通过 | 同上 | 同上 | 同上 |
| `0.1.7-rc.2` | 通过 | 同上 | 同上 | 同上 |
| `0.2.0-rc.1` | 通过 | 同上 | 同上 | 同上 |
| `0.2.0-rc.2` | 通过 | 同上 | 同上 | 同上 |

单测三条 skip 是本机无 bwrap / Landlock 的两条真实执行断言，以及只适用于候选 warn 车道的一条互斥断言；没有把 macOS Seatbelt 跳过算通过。新版本不需要额外适配分支；升级风险集中在候选安装树一致性、异常恢复结果语义，以及未在本地运行的其他 OS。最终开发安装树已恢复；`pnpm install --frozen-lockfile`、`pnpm compat:check` 与 `pnpm docs:check` 均通过。

完整本地矩阵的计数对应 Windows npm launcher 修复之前的 349 项单测；launcher 另外新增两条回归，开发树在修复后重跑单测（348 passed / 3 skipped）。远端矩阵须以修复后的 PR head 为准。

远端验证（实现提交 `187d9ad`）：[CI run 36690954880](https://github.com/cherrchen/dsh-plugin-multi-root-workspace/actions/runs/36690954880) 的 releases job 与 **九个版本 × Linux / macOS / Windows 的 27 个 verify job 全部 success**。Linux/macOS 执行完整冒烟与按宿主能力验证的内核断言；Windows 按既有范围执行静态合同、lint、双面类型检查、构建、单测和文档检查，明确不运行 POSIX 冒烟或内核多根断言。前述其他 OS 的本地未覆盖现已由远端平台回归补齐，仍不把缺失的内核机制视作实际执行通过。

### v0.1.5 发版准备（2026-09-30）

| 项 | 结果 |
|---|---|
| 发布状态与 CHANGELOG | 路线账本曾登记为 `v0.1.5` 待打 tag；README（中英）的支持版本、tarball 与 tag 示例对齐 `v0.1.5`；[`CHANGELOG.md`](../../../CHANGELOG.md) / [`CHANGELOG.en.md`](../../../CHANGELOG.en.md) 新增 `0.1.5` 条目 |
| 本地门禁 | frozen install、`compat:check`、lint、typecheck、build、`test`（347 passed / 4 skipped）、`smoke:compose` 40/40、`smoke:behavior` 91/91（4 项真实内核断言因宿主无可用 runner 跳过）、`smoke:journey` 52/52（2 项真实内核断言同因跳过）、`docs:check` 通过；`verify:all` 退出码 0（2026-09-30，macOS） |
| 跨平台矩阵 | 上方 PR #6 记录的 CI run `36690954880` 已验证九个 DSH 版本 × Linux / macOS / Windows，共 27 个 verify job 全绿；Windows 车道按既有范围不运行 POSIX 冒烟或内核断言 |

后续已由 `657e6d1` 产生 v0.1.5 发布提交并完成发布；以上保留当时准备阶段的证据。

## B1–B3：第二期 P1（2026-10-02）

分支为 `feat/lsp-windows-feature`，范围为用户确认的全部三项 P1；功能未发布，不改版本号。设计、接口与安全边界的唯一真源为 [ADR-0011](../../decisions/ADR-0011-multi-root-workspace-consumers.md)。

| 项 | 实现 | 验证状态 |
|---|---|---|
| B1 Additional Root LSP routing | additive 公共 query 包装，按 canonical file target 选择根，上游 stdio provider 负责独立初始化与池化 | 真实协议服务器 e2e、路由与撤销、取消、卸载恢复通过；九个支持版本的构建、类型与全量测试通过 |
| B2 Windows kernel multi-root | 插件 runner 调用公开 AclSandbox，root-set capability SID、自有 private temp、保留失败签名与 payload | SID / argv / fail-closed 结构回归通过；2026-10-03 Windows 本机原生执行通过；2026-10-11 起 Windows CI 在全部 11 个支持版本上原生执行内核探针、冒烟与原生用例，证据见[加固记录](#b1b3-加固与-windows-全量验证2026-10-11) |
| B3 workspace-files / client tree | 公共 list 和新版 path-watch 按根隔离；Connection 新增 files/readFile；对话框 lazy tree + preview，原生 Files actions slot 提供入口（**2026-10-12 P11 修订**：面板 `files`/`readFile` 端点与对话框内树随后移除——浏览统一在 Files 页签由逐字节复刻的上游树体承担，数据源正是本行的 list/watch 路由，见下方 P1–P11 节） | 真实 registry/fs 的包含性、跨主根、symlink/redirect、I/O 中撤销与 caps 回归通过；客户端 lazy tree、响应校验与可选 Files 入口通过；全量本地 gate 通过 |

新增可选 peer 纳入原精确版本合同，allowlist 无变化。旧版会话级 watch 原样保留；附加根树手动刷新（P11 起为原生 watch 自动刷新，同条修订）。已启动的 Windows/其他内核子进程使用启动时 scope，根集合变更限制后续进程。Windows 的 partial enforcement 与 caller-owned 目录条件继承上游。

本地验收（macOS，2026-10-02）：

| Gate | 结果 |
|---|---|
| `pnpm compat:check`、lint、双端 typecheck、build | 通过，开发 pin 为 `0.2.0-rc.2` |
| `pnpm test` | 最终 29 文件、371 passed / 5 skipped；含真实 LSP stdio e2e |
| `pnpm smoke:compose` | 44/44 |
| `pnpm smoke:behavior` | 91/91；4 个内核执行断言因本机没有可用 Seatbelt runner 跳过 |
| `pnpm smoke:journey` | 52/52；web/headless 的 2 个内核执行断言同因跳过 |
| 八个旧版矩阵 | `0.1.5-rc.2`、`0.1.6-alpha.1`、`0.1.6-alpha.2`、`0.1.7-alpha.1`、`0.1.7-alpha.2`、`0.1.7-rc.1`、`0.1.7-rc.2`、`0.2.0-rc.1` 各通过 exact pin 安装、compat、双端 typecheck、build 与全量测试（370 passed / 5 skipped；此时尚未追加 Files actions 入口用例）；未重复计作每版 smoke 证据 |
| 最终增补复验 | 八个旧版均再次通过双端 typecheck、build 和三文件定向测试（58 passed / 1 skipped）；Windows 原生用例另以独立 tsc 命令检查，在九个版本全部通过，四个 portable Windows 用例也复验通过 |
| Windows 原生验证 | 已加入真实 restricted-token Node、PowerShell 与 ConPTY 用例，检查两根可写、第三根拒绝、read-only 拒绝、移除根后拒绝、PTY 退出码保留；本机明确 skip，由已有 Windows CI lane 执行，尚无实跑结论 |
| `pnpm docs:check` / `git diff --check` | 通过，文档 0 errors / 0 warnings |

矩阵发现的差异均已回归：早期 `changes(scope, signal)` 必须按实际 arity 透传；旧版目录列表会先把 symlink 报为 `not-directory`，测试保留该上游错误顺序，不要求新版的 `outside-workspace` 先出现。上述跳过项不能算作本机内核执行证据，也不代表 Windows 平台验收完成。

### Windows 修复与复验（2026-10-03）

PR #7 原 HEAD `1c914b5` 的 [CI run 36987457760](https://github.com/cherrchen/dsh-plugin-multi-root-workspace/actions/runs/36987457760) 中，九个 Windows job 均在测试阶段失败，18 个 Linux/macOS job 通过。开发基线和最早支持版的日志均显示 LSP 源码断言错误，以及原生用例启动不存在的 `src/windows-runner.js`；前者把 JSON 转义后的源码与原始 Windows 路径比较，后者从源码加载 provider，令 `import.meta.url` 落在 `src/`。

修复将 LSP 两个根的回传文本与完整磁盘源码比对，并让 Windows 原生用例加载发布产物 `lib/sandbox.js`、断言其实际启动 `lib/windows-runner.js`。本机全量复验还发现目录 symlink 无权限时，read-only 矩阵没有沿用 workspace-write 的条件，错误地访问未创建的链接；两种模式现使用同一夹具条件。未修改生产权限模型、兼容 allowlist 或 CI 的 Windows 必跑规则。

| 验证范围 | 结果 |
|---|---|
| 本机环境 | Windows 11 x64（`10.0.26200`），Node `24.14.0`，pnpm `11.25.0`，DSH `0.2.0-rc.2`，frozen lockfile 安装 |
| Windows 全量门禁 | `compat:check`、lint、双端 typecheck、build、`pnpm test`、`docs:check` 通过；29 文件，354 passed / 22 skipped；文档 0 errors / 0 warnings |
| 原生执行与 LSP 定向复验 | 两文件 6/6 通过；真实 restricted-token Node 和 PowerShell 可写两根、第三目录拒绝，ConPTY 两根写入及第三目录拒绝、退出码 `23` 保留，read-only 与移除根后拒绝；真实 LSP stdio 初始化和池化隔离通过 |
| 跳过范围 | 本机无目录 symlink 权限，以及不适用于 Windows 的 POSIX 内核执行和条件用例；Windows 原生 ACL 用例没有 skip。Windows 不运行 POSIX 冒烟和 `kernel:probe` |
| 修复后远端矩阵 | 修复提交 `41e4d1a` 的 [CI run 37118946523](https://github.com/cherrchen/dsh-plugin-multi-root-workspace/actions/runs/37118946523) 全部 success：releases job 及九个支持版本 × Linux/macOS/Windows 的 27 个 verify job；九个 Windows job 均执行原生 ACL 用例，Linux/macOS 完成各自内核探针、测试及完整冒烟 |

### B1–B3 加固与 Windows 全量验证（2026-10-11）

分支 `feat/b1-b3-hardening`（在 `v0.1.6` 之上），目标是：把 B1–B3 的实现推到"每个消费者都有原生执行证据"、在 Windows 上 fail-closed 而不是静默运行、并让打包产物与 Windows 冒烟成为全平台门禁。提交序列：`9f9a1df`（硬化 + 原生 Windows 用例）、`af962fd`（原生 Windows 冒烟门禁 + 打包产物验证 + CI/release 门控）、`a0cfe22` / `1f72fb5`（CI 暴露后的测试修正）。**本节记录的是分支工作，尚未发布。**

**审计分类（在 v0.1.6 HEAD 上）**：

- **已实现且有原生证据**：B1 真实 stdio LSP 路由/池化；B2 root-set SID runner（Node / PowerShell / ConPTY，双根可写、第三根拒绝、read-only、撤销）；B3 list/watch 路由、面板 `files` / `readFile`、客户端 lazy tree；注册表 lease 的 junction 别名归一。
- **已实现但欠测 → 本批补测**：LSP 并发会话（不同主根）、Unicode/空格根、飞行中取消、服务器崩溃（下一次查询上游重生）、真实服务器的 redirect、存活服务器下卸载、win32 大小写变体 + 第二盘；Windows 敌意名称（CJK、空格、`'&^%!();,`）、第二盘、大小写/8.3 别名、junction 重指、confine 与 spawn 之间根被移除（127，子进程不启动）、非调用者拥有的根、撤销快照语义、4 个并发进程各自独立 private temp 且退出后删除、退出码/stdout/stderr 镜像、ConPTY Ctrl+C、Git Bash；大小写变体/8.3 别名的 lease 名一致；三进程争用恰好选出一个 authority。
- **确认的缺陷并已修复**：
  1. **Windows 网络/设备根此前会被接受**（UNC `\\server\share`、`\\?\`、`\\.\`、映射网络盘——`realpathSync.native` 会把它解析成 UNC）：restricted token 的 capability SID / Low label 无法证明能绑定 SMB 访问，且 stat UNC 路径会触发 SMB 认证。新增 `unsupported-path` 错误码：注册表校验在任何 fs 触碰之前词法拒绝、存量记录判 `invalid`、profile 扩展与 runner 均 fail closed（`SandboxUnavailableError` / exit 127，绝不无约束执行）。
  2. **runner 现在在 ACL 授予之后、spawn 之前重新验证每个根**（仍是目录 + canonical 身份一致），并要求 `--temp` 是已存在的目录。
  3. **面板文件路径此前不拒绝反斜杠**（POSIX 上 `..\..\x` 会词法解析到根内）→ 现在拒绝。
  4. **Windows reveal 总报失败**：`explorer.exe` 成功时退出 1 → win32 接受 0/1。
  5. **文件树 RPC 现在可中止**：组件卸载 / 路径 / 会话变化时取消在飞调用（Connection RPC 支持 AbortSignal，host 早已转发该信号）。
  6. **CI `pnpm test | tee` 缺 `pipefail`**：单测红了也能报绿 → 已修。
  7. **安装副本的 Windows runner 在 `main()` 之前就死于 `ERR_MODULE_NOT_FOUND`**（CI run `38131613042` 由 `smoke:packed` 暴露，`7702ffb` 修复）：`lib/windows-runner.js` 是独立 Node 进程，宿主的进程内插件包解析不适用，它的静态图却 `import '@deepseek-ai/dsh-sandbox'`（roots/windows-profile chunk 也一样）——从插件安装目录解析不到。`0.1.5-rc.2` / `0.1.6-*` 通过是因为那些版本仍写 module-fallback 目录；`0.1.7-alpha.1+` 的受限 pwsh 全部失败。checkout 内测试看不到它（checkout 的 `node_modules` 带着 peers）。修复：runner 的静态图只许 `node:`（新模块 `src/windows-runner-contract.ts`），上游 ACL 包改为从 `--upstream-runner`（上游 runner 自身路径）按包自引用 `createRequire` 解析后动态 import；`check-pack` 与"拷到无 node_modules 目录运行"的可移植用例双重钉住。
- **保留的上游限制（已记录，不算回归）**：Windows enforcement 仍是上游 `partial`；Git Bash/MSYS 在 restricted Low-integrity token 下无法启动（0.2.x：`NtCreateDirectoryObject … 0xC0000022`；0.1.5-rc.2：`CreateFileMapping … Win32 error 5`，exit 256）——上游 runner 与插件 runner 表现完全一致，Windows 受限 shell 就是 pwsh；上游 runner 调 `SetConsoleCtrlHandler(NULL, TRUE)` 且 ignore 标志被子进程继承，所以上游 confine 的子进程（空附加根）收不到 Ctrl+C，而插件 runner（非空根）用 Node SIGINT handler（不被继承），Ctrl+C 能到达子进程并由 runner 镜像其退出码（测试中为 130）；每个根集合的 standing workspace ACE 只增不减且永不撤销（与上游一致）；已启动进程保留启动时快照；`Local\` 命名信号量作用域 = 每登录会话，网络共享上的 `$DSH_HOME` 被多台机器使用不受 lease 保护（与上游 SessionWriteLease 相同）；elevated host 上的 foreign-owned 根：admin token 可能仍能授权，因此接受两种结局（exit 127 fail-closed，或 exit 0 且所有未授权写被拒），并且 unconfined admin 进程不是有效探针（libuv `FILE_FLAG_BACKUP_SEMANTICS` + backup/restore 特权绕过 DACL，restricted token 不能）。
- **新增 CI / 代码门禁**：`kernel:probe` 以**真实上游 runner** 验证 `windows-acl`（一次允许写 + 一次兄弟目录被拒——不能拒绝的探针不算 sandbox）并导出该方言，Windows 内核断言因此不可 skip；`smoke:compose` / `smoke:behavior` / `smoke:journey` 在 Windows 原生运行（pwsh executor + pwsh 工具、两个真实 git 仓库、web + headless 两条腿）；新增 `pnpm pack:check`（tarball 成员含 `lib/windows-runner.js`、每个 `exports` 目标、`cordis.patch.yml` 引用的每个模块、传递依赖的共享 chunk、`lib/windows-runner.js` 全图只许 `node:` 导入；当前 71 个成员）与 `pnpm smoke:packed`（tarball 经 `dsh plugin add` 装进隔离 `$DSH_HOME`，再从**安装副本**跑完整 behavior battery 并断言其解析路径在 checkout 之外）；以上门禁在 Linux / macOS / Windows 三平台全部执行；冒烟日志 `if: always()` 上传；新增 `gate` job（`needs: [releases, verify]` + `if: always()`），矩阵被 skip/cancel 不再可能显示为成功；release 的 publish 依赖可复用 CI 的 gate 并使用 `check-pack`。

**koffi 安装路径实测**（本机 macOS，DSH `0.2.1-alpha.2`，tarball 来源，全新 scratch profile）：第一次 `dsh plugin add <tgz>` 装完依赖后以 `[ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: koffi@3.3.3` 失败；该 profile 的 `pnpm-workspace.yaml` **没有**留下 `set this to true or false` 待决标记；写入 `allowBuilds: { koffi: true }` 后重跑同一 `add` 退出 0，但插件**不在** `dsh.profile.bundles` 里（plugin-manager 的 reconcile 只激活本次运行中新增的依赖）；再做一次 `dsh plugin --profile <p> remove <name>` 加同一 `add` 才完成激活（`koffi install: Done`）。smoke 在 scratch home 内按此路径执行；对用户可见的处置见[故障排查：安装停在构建授权](../../troubleshooting/install-stops-at-build-approval.md)。

**本地验收**（macOS，DSH `0.2.1-alpha.2`，`DSH_PROBE_VERIFIED_DIALECTS=seatbelt`）：`compat:check` / lint / typecheck / build 通过；`pnpm test` 31 文件、412 passed / 18 skipped（12 = Windows 原生用例在 macOS 上的平台 gate）；compose 44/44、behavior 99/99、journey 55/55；`pack:check` 71 成员；`smoke:packed` 98/98；`docs:check` 通过。

**Windows CI 证据**：

| Run | 结果与暴露 |
|---|---|
| `38126361009`（`9f9a1df`） | 11 个 Windows job 同批失败 7 项，Linux/macOS 全绿：5 处测试前提错误（exit code 1 在 win32 是成功语义、`cmd /s` 引号破坏 8.3 查询、POSIX 断言在 win32 上跑、elevated runner 下"必须 127"前提不成立）、ConPTY Ctrl\C 超时、Git Bash MSYS 启动失败签名未覆盖 |
| `38127852508`（`af962fd`） | `kernel:probe` 验证 `windows-acl`；Git Bash parity 通过；仅剩两处：foreign-owned 用例的 icacls grant-only 锁定对 elevated 进程无效（admin 仍可写），PowerShell `Start-Sleep` 无交互时不响应 ConPTY Ctrl+C |
| `38128970508`（`a0cfe22`） | 仅剩断言修正：foreign-owned 改为 ACL 回读验证（unconfined admin 进程有 backup/restore 特权，不是有效探针）；Ctrl+C 结果 `upstream=timeout plugin=interrupted`——上游 runner 的 ignore-Ctrl+C 标志被子进程继承，改为断言插件侧被中断且镜像子进程退出码；Git Bash 在 `0.1.5-rc.2` 上是 `CreateFileMapping … Win32 error 5` / exit 256 的另一签名 |
| `38129713987` | Windows 上单测、compose 44/44、behavior 99/99 全绿；`smoke:journey` 50/5——断言在 JSON 序列化文本里找原始 Windows 路径（反斜杠被转义），改为按 `JSON.stringify` 转义拼写查找 |
| `38130676072` | Windows 上全部冒烟转绿；`pack:check` 无法 spawn `pnpm.cmd` → 改为经 `npm_execpath` 启动 |
| `38131613042` | `0.1.5-rc.2` / `0.1.6-*` 的 Windows 全绿（含 `smoke:packed`）；`0.1.7-alpha.1` 起 `smoke:packed` 暴露缺陷 #7：安装副本的 runner `ERR_MODULE_NOT_FOUND`（`@deepseek-ai/dsh-sandbox`）→ `7702ffb` 修复 |
| [`38134856191`](https://github.com/cherrchen/dsh-plugin-multi-root-workspace/actions/runs/38134856191)（`7702ffb`，最终代码 HEAD） | **全部 35 个 job success**：releases + 11 个精确 DSH 版本 × Linux / macOS / Windows 的 33 个 verify + `gate`。每个 job 的 `kernel:probe` 都实际验证了本机方言（macOS `seatbelt`、Linux `landlock`、Windows `windows-acl`）并设为必跑；33 个 job 均为 compose 44/0/0、behavior 99/0/0、journey 55/0/0、`pack:check` 71 成员、`smoke:packed`（安装副本）98/0/0。单测：Windows 414 passed / 18 skipped（`0.2.1-alpha.2` 419 / 13），Linux / macOS 408 / 24（`0.2.1-alpha.2` 414 / 18）。Windows 上 `windows-native.e2e.ts` 12/12 实际执行、无 skip；唯一的 Windows 侧条件跳过是 8.3 别名断言——runner 的 D: 卷关闭了短名生成，日志显式记录。实测结局：Ctrl+C `upstream=timeout`、`plugin=interrupted exit=130`；Git Bash 两侧同为 MSYS 启动失败；foreign-owned 根在 elevated runner 上走「授权成功但两处写均被拒」结局。Linux bwrap 仍因宿主 uid map 限制不可执行，Landlock 为 Linux 原生证据 |

## DSH 0.2.1 迁移与目录安全契约（2026-10-10，随 v0.1.6 发布）

分支 `feat/dsh-0.2.1-alpha.2-compat` 从 `main` 的 `f149fa4` 创建；本项现已包含于 `v0.1.6`。上游差异唯一真源是[接口审查](../../reference/dsh-0.2.1-migration.md)，目录、指令、LSP 和进程快照设计是 [ADR-0012](../../decisions/ADR-0012-session-origin-and-effective-cwd.md)。

| 项 | 当前证据 |
|---|---|
| 候选 `0.2.1-alpha.1` | 一致精确安装树，Cordis 4.0.4；lint、双面 typecheck、build；native Seatbelt test（381 passed / 8 skipped），compose 44/44、behavior 99/99、journey 55/55；该版本没有 workingDirectory/Worktree，所以四条新服务测试明确不适用 |
| 候选 `0.2.1-alpha.2` | 一致精确安装树，Cordis 4.0.5-alpha.1；真实 Host composition、web/headless Agent journey 和 native Seatbelt 测试通过；上游 install-time gate 拒绝候选 peers，隔离 profile 的 exact allow-version 豁免仅用于候选 lane |
| 正式精确合同 | allowlist 和所有 DSH peers 增加两个精确版本，开发 pin 为 alpha.2；Cordis prerelease 单独精确声明；生产仍 enforce，workingDirectory 为 optional service lookup，不成为旧 runtime 的必装模块 |
| 本地 alpha.2 enforce | compat、lint、双面 typecheck、build、test（389 passed / 4 skipped）、compose 44/44、behavior 99/99、journey 55/55，通过；无候选豁免 |
| Worktree / 目录 | Git 2.53 + 真实 Seatbelt 下 Primary/Additional 内的默认 pool 创建、访问、共享 gitdir、切回原项目、删除当前 checkout 后恢复、重复名称失败、取消、未授权 repository 拒绝通过；Registry 始终不由 Worktree mutation 改变 |
| 新旧进程 / PTY | 真实 Seatbelt 下旧 process 和 PTY 保留原 cwd 与 grant snapshot，撤销后新 confine 和 fs 写拒绝；没有修改已有 shell cwd |
| 继承的不变量 | fs / 三个 POSIX dialect 独立 grant parity、unknown dialect、mixed/incomplete gate、lease 争用/接管/拆除、symlink redirect、missing 恢复、LSP stdio、workspace-files caps/撤销、user-context 指令与 global 排除、同批 native 去重和 I/O 中撤销均由完整套件覆盖 |
| 本地未覆盖 | Linux bwrap/Landlock、Windows ACL/ConPTY 未在 macOS 本机原生执行；远端 Landlock 与 Windows 原生验收见下方，bwrap 仍未验证 |
| 上游限制 | Apple Git 2.39 不认识 `--no-lazy-fetch`，明确失败且不改 Registry；不删除该安全参数。native instruction baseline 的相对 project identity 可能在同构 cwd 间复用，插件不依赖它决定 authority；见接口审查。任意敌对 rename 的原子安全与即时撤销旧 kernel snapshot 不在既有机制保证内 |

支持矩阵扩大前已分别把两个版本作为候选跑过。正式 allowlist 下旧版矩阵和跨平台 CI 的最终结果见下方；任何 skip 均不计为该机制验收通过。

### 最终矩阵与平台验收

实现 HEAD `b32f452` 的 [CI run 38046100174](https://github.com/cherrchen/dsh-plugin-multi-root-workspace/actions/runs/38046100174) 全部 success：releases job + **11 个精确 DSH 版本 × Linux / macOS / Windows 的 33 个 verify job**。没有以候选 warn 或 installation exemption 运行正式矩阵。测试日志在成功时也上传，可核对执行与 skip，不能把 job success 解释为所有方言均原生验证。

| 范围 | 最终证据 |
|---|---|
| 本地全部旧支持版本与 alpha.1 | 十个版本分别重建一致安装树，compat/lint/typecheck/build/full test/compose/behavior/journey 全通过；该轮 382 passed / 10 skipped，44/44、99/99、55/55。六条 workingDirectory/Worktree 测试在这些版本不适用，其余 skip 为非 macOS 方言、Windows native 和候选专属断言。最终 LSP fallback 增补另由上述全部版本的 CI 全套复验覆盖 |
| 本地最终 alpha.2 | 标准 `pnpm compat:check`、lint、typecheck、build、kernel:probe、test、smoke、docs:check 通过；最终 31 文件、389 passed / 4 skipped；compose 44/44、behavior 99/99、web/headless journey 55/55；Seatbelt 必跑 |
| Linux alpha.2 原生 | 自带 Landlock launcher 探针实际执行并输出 `DSH_PROBE_VERIFIED_DIALECTS=landlock`；真实 grant parity 与六条 workingDirectory e2e 全执行，31 文件、389 passed / 4 skipped。包括两根 Worktree、外部 gitdir 拒绝、新旧进程和 PTY 的 cwd/grant snapshot。完整 Host/Agent 冒烟通过 |
| macOS alpha.2 原生 | Seatbelt 探针实际执行并设为必跑；六条 workingDirectory e2e 全执行，31 文件、389 passed / 4 skipped；完整 Host/Agent 冒烟通过 |
| Windows alpha.2 原生 | `windows-multi-root.spec.ts` 5/5 执行通过，含 restricted-token Node / PowerShell / ConPTY；workingDirectory e2e 5 passed / 1 skipped（仅 POSIX PTY 用例不适用），真实 Worktree 两根创建/失败/取消/未授权与外部 gitdir 拒绝、进程 snapshot 全通过。全套 31 文件、381 passed / 12 skipped；Windows 按既有设计不运行 POSIX smoke |
| bwrap 明确未验证 | Linux CI 已安装 bubblewrap，但实际 probe 返回 `bwrap: setting up uid map: Permission denied`。该宿主不允许原生执行，bwrap kernel assertion 明确 skip；没有关闭宿主限制来换取通过。结构/argv/独立 grant parity 通过，但不算 bwrap kernel 验收。Linux 平台原生保证来自实际执行的 Landlock |
| Registry / resume / 客户端 | 完整矩阵同时覆盖原 lease 争用、接管、Host stack restart、missing/redirect 恢复，native Session replay / cwd 恢复，LSP stdio pool、无 origin metadata 的 policy fallback、面板 Session 订阅/旧响应丢弃、workspace-files 隔离与指令撤销 |
| 开发树恢复 | 已恢复 alpha.2 的 manifest、workspace、lockfile、node_modules 与 lib；frozen install 通过，无临时 probe overrides，无上游修改。版本仍为 0.1.5；迁移已实施并验证、未发布 |

第一轮 `00afbce` 的 CI 虽全绿，但 Linux 探针只查 PATH，漏掉自带 Landlock；因此不采用它作为 Linux kernel 验收。改用公开 addon launcher 后 `77c0d30` 的 CI 如实暴露原生测试仍指向 inert launcher；原生组已在 `3691d00` 修正。最终上述 run 完成所有版本/平台复验。保留这段证据说明，避免未来再次把不存在 launcher 导致的 skip 当成原生安全验证。

后续建议：在允许 user namespace 的 Linux runner 补做 bwrap 原生验收；向上游报告相对 instruction baseline identity 在同构 cwd 切换中的协调风险；需要撤销旧进程权限时先终止旧进程，再使用新 scope 启动。以上均不通过扩大授权、禁用 sandbox 或重实现 Worktree 绕过。


### PR #8 P1 返工（2026-10-10）

[评审问题](https://github.com/cherrchen/dsh-plugin-multi-root-workspace/pull/8#discussion_r4237499560)指出 native 代投递的文件在 cwd 切换后被上游撤回，插件却保留完整 digest，导致仍获授权的指令不再补发。修复规则见 [ADR-0012 指令章节](../../decisions/ADR-0012-session-origin-and-effective-cwd.md#指令)。新增四条回归覆盖无 baseline identity 的 remove、baseline 替换、不同项目复用同名 scope，以及补发构造失败后无需新 touch 的重试；同时断言同批去重、插件投递不受 native remove 影响和根撤销仍生效。

本机 alpha.2 enforce 下 compat、lint、双端 typecheck、build、完整 test（31 文件，388 passed / 9 skipped）、docs:check 和 diff whitespace 检查通过；指令定向测试 53/53，web/headless journey 52/52。本次受限进程没有可用 kernel runner，journey 的两条 confined bash 断言明确 skip；不更新为 native 内核验收，也未复跑其他版本和平台。此前最终矩阵证据属于上述历史 HEAD，修复后的跨版本结果由新提交 CI 另行验证。

### v0.1.6 发版验证（2026-10-11）

`v0.1.6` 已通过 `pnpm release patch --tag` 生成，发版提交为 `466b3bb`，并推送至 `origin/main`，连同 annotated tag `v0.1.6`。本机 `pnpm verify:all`、`pnpm compat:check`、`pnpm docs:check` 均通过；本机 Test 为 393 passed / 4 skipped，compose 44/44、behavior 99/99、journey 55/55。GitHub [Release workflow run 38121365127](https://github.com/cherrchen/dsh-plugin-multi-root-workspace/actions/runs/38121365127) 全绿：11 个支持版本 × Linux/macOS/Windows 的 33 个 verify job，以及 npm publish 和 GitHub Release 创建均成功。

### PR #10 全面复核与第二轮返工（2026-10-12，未发布）

本轮修复内容见 [B4–B8 返工记录](./2026-10-11-b4-b8-p2.md#全面复核与第二轮审查返工2026-10-12pr-10)，接口与工程规则分别维护在 ADR-0013、ADR-0014 与开发工作流。

本机开发 pin `0.2.1-alpha.2`：compat、lint、双端 typecheck、build、docs:check 通过；Seatbelt 探针原生执行成功并通过 `DSH_PROBE_VERIFIED_DIALECTS=seatbelt` 约束完整测试，结果 **500 passed / 22 skipped**（35 文件通过、1 Windows 原生文件跳过）。compose **46/46**、behavior **99/99**、web/headless journey **62/62** 全通过；pack:check **73 个成员**通过，安装 tarball 的 packed behavior **98/98** 通过。外层 Agent 沙箱内的首次探针被 sandbox_apply 拒绝，该次不计原生证据；上述完整测试与冒烟在外层沙箱之外执行。

本机不能证明 Windows ACL 夹具修复有效，也不能验证 Linux 内核；本轮跨版本与原生平台证据采用下方修复后矩阵，不沿用历史 HEAD 的绿色结果。

首轮 [CI run 38153898876](https://github.com/cherrchen/dsh-plugin-multi-root-workspace/actions/runs/38153898876) 暴露新 SID 查询命中了 Git Bash PATH 中的 GNU whoami，所有 Windows 腿在夹具前置步骤失败；不将此轮计作修复验收。后续改为按 System32 绝对路径启动原生 whoami/icacls/takeown，继续完整矩阵验证。

最终实现 HEAD `9c2a27a` 的 [CI run 38154203689](https://github.com/cherrchen/dsh-plugin-multi-root-workspace/actions/runs/38154203689) **35/35 success**：11 个精确支持版本 × Linux/macOS/Windows 的 33 个 verify job，以及 releases/gate；没有整项自动 retry 或额外 skip。全部 Windows 版本均完成 kernel:probe、原生测试、三冒烟、pack:check 与 smoke:packed。`0.1.6-alpha.1` Windows 日志确认 foreign-owned 夹具成功、受限子进程实际执行且两个未授权写都被拒（不是仅靠 runner 127 早退通过）；该腿 **496 passed / 26 skipped**，compose **46/46**、behavior **99/99**、journey **62/62**、packed behavior **98/98**。一次完整矩阵通过是本轮验收证据，不等于证明所有未来环境都不再出现瞬态失败；后续诊断与有界重试规则见开发工作流。

### PR #10 第三轮返工（2026-10-12，未发布）

修复内容见 [B4–B8 第三轮记录](./2026-10-11-b4-b8-p2.md#第三轮审查返工2026-10-12pr-10)。修改前回归复现了实时 scope 顺序、发布次数与真实指令预算优先级三个失败，修复后注册表 / 指令套件 **107/107** 通过。

本机开发 pin `0.2.1-alpha.2`：compat、lint、双端 typecheck、build、docs:check 通过；完整测试在原生 Seatbelt 探针及 `DSH_PROBE_VERIFIED_DIALECTS=seatbelt` 约束下 **501 passed / 22 skipped**。compose **46/46**、原生 behavior **99/99**、原生 web/headless journey **62/62**、pack:check **73 个成员**、原生 packed behavior **98/98** 全通过。

同时在外层 Agent 沙箱内验证 runner 不可用路径：Seatbelt 返回 `sandbox_apply: Operation not permitted`，journey **55 passed / 0 failed / 2 skipped**，两条腿均明确跳过 shell cap 与命令产物，fs 与模型上下文检查仍执行。此记录只证明本机可用 / 不可用两种路径；本轮跨版本、Linux 与 Windows 结果须以本次推送触发的 CI 为准。

### Files 头部根浏览 P1–P11（2026-10-12，未发布）

实施计划见 [files-header-root-browsing](../completed/2026-10-12-files-header-root-browsing.md)（P1+P2 为原计划两阶段，P3–P11 为目检后追加，每阶段一个提交），决策见 [ADR-0015](../../decisions/ADR-0015-files-tab-plugin-owned-browsing.md)。

- **P1**（提交 `7e3232a`，后改写为 `79f6934`）：`files.actions` 的 launcher 改为仅图标齿轮钮并经 flex `order` 前移到 reload 左侧；footer 触发器同步换齿轮。
- **P2**（提交 `252b927`）：该 occupant 升级为 `RootSwitcher`——伪装成 PathLabel 的触发钮 + `Menu`（主根、`list` RPC 返回的附加根、footer 的「管理…」入口）；选中附加根时 `closest('[data-files-root]')` 定位 pane，`createPortal` 挂入 `RootFileTree` 接管树区，`:has()` 规则同条件隐藏原生 path/body/reload；owner 缺 `absolutePath` 时退回 P1 compact launcher。对话框行内 `RootFileTree` 与 `files.browse` 词条下线。`data-files-*` 钩子（非槽位契约）列入 `.agent/note` 升版目检与故障排查条目。
- **P3**：触发钮后随一个 `PathLabel`（`mrfw-switcherPath`）显示**选中根**的完整路径——主根即原标签的值，附加根为其 canonical 路径；复用上游同一组件，观感与原生一致。`.mrfw-rootSwitchBtn` 收敛为只缩不涨（`flex: 0 1 auto`），PathLabel 接管头部剩余宽度。
- **P4**：附加根态的刷新收进 header——`RootFileTree` 移除行内「刷新文件树」按钮，header 在原生 reload 位置出现同款 `.mrfw-switcherReload` 图标钮（28px tool 配方）；与 portal 同生同灭，纯菜单降级时不渲染。
- **P5**：刷新改原地重拉消除 loading 闪烁——`RootFileTree` 收 `reload` 计数 prop，各挂载目录 effect 依赖之；只有根或目录身份（`entry.id + path`）变化才清空当前列表，reload 重拉在现有行下后台进行、成功就地换数据，展开态与文件预览均保留。
- **P6**：对话框添加行的权限选择器从系统原生 `<select>` 换成 ui-primitives `Menu` 锚定下拉（胶囊触发钮 + 勾选行，与根选择器同一控件族）；`onSelect` 即显式选择，`accessChosen` 的「未触碰不携带 access」语义不变。权限字形（`IconWorkspaceWrite`/`IconReadOnly`）仅 0.1.7+ 存在，走新增的 `maybeIcon` 软探测，缺失版本回退为无图标行。
- **P7**：附属根行的权限徽标移到显示名右侧（`.mrfw-rootName` 改 flex 基线对齐，徽标 `flex:none`）；复制从独立 IconButton 变为路径本身——抽出的 `PathCopy` 组件（`.mrfw-pathCopy` 无边框按钮保持文本观感，`.mrfw-pathCopyIcon` 在流内 `opacity:0` → hover/focus 才可见、出现不回流，点击路径区任意处复制完整 canonical path，反馈沿用 copyPath↔copied 的可达名切换）随后推广到**全部路径展示**：主根行与「当前执行目录」行同一控件。
- **P8**：只读→读写升级的 `window.confirm` 换成 ui-primitives `Modal` 确认层——覆盖在工作区目录对话框之上，footer 为普通取消钮 + 红色确认钮（`.mrfw-btnDanger` 补实底配方）；Escape/遮罩即取消，portaled Modal 的 Escape 也纳入底层对话框的守卫；降级方向照旧无确认直接执行。
- **P9**：修复 open-in-app 分离按钮在附加根态仍路由到主根——上游 `files.actions` 槽位的 `absolutePath` 永远是原生树根。`:has()` 规则隐藏原生 `data-open-target="directory"` 元素（整项隐藏 + 内层兜底双选择器），`src/client/open-in-app/` 逐字节复刻上游 `ui-open-in-app` client 包（基线 `d743267388` = `0.2.1-alpha.2`，`FORK.md` 钉住清单与同步步骤）在原位渲染同款控件、`absolutePath` 换为选中根；宿主路由不校验根归属，locale `bind('open-in-app')` 复用上游词典，应用选择共享 `dsh.open-in-app.choice`。css 走 `*.module.css.ts` shim（类名前缀 `mrfw-open-`）；`*Regular` 图标族缺席的运行时不渲染按钮（同型降级）；`dsh-client-store` 因此进入 bundle module-table；`workspace.openLocal` 快捷键仍开主根（已知限制）。**遗留（P10 已修）**：复刻钮与窗口右缘间距仍有像素级偏差（容器 gap + 整项隐藏两轮修正后目检仍报残留，根因与修复见 P10）。
- **P10**：修复 P9 遗留的复刻钮 4px 左偏——根因查明：上游 `ui-renderer` 给每个槽位渲染点包 `<div data-slot="sidebar.right.tab.files.actions" style="display:contents">`，`.header` 的子项是该包装而非 occupant 的 Menu 锚 span，P9 的 `> * > *` 选择器命中包装自身、被其内联 `display:contents` 压成惰性；只有内层兜底生效，空锚 span 仍以零宽 flex 项多占一个 header gap。第一选择器改经 `data-slot` 锚点定位 occupant 项，`> * > *` 形态删除；新增 jsdom DOM 回归（`element.matches()` 钉住命中面：命中原生锚 span、不命中包装 / 选择器 / 复刻锚，主根态全不命中）。
- **P11**：自绘 `RootFileTree` 换成 `src/client/files-tree/` 下逐字节复刻的上游 `ui-sidebar-files` 树体（基线 `d743267388` = `0.2.1-alpha.2`；`directory-node`/`face`/`store`/`FilesBody.module.css` 字节级一致，行级 `Entry`/`Level` 逐字节，唯一改写是外壳函数——根由 `sessions.byId` cwd 换成选中根 prop、tab 身份经 `data-dockkit-content` 取得、生命周期由 takeover AbortController 供给、文件经 `fileAddressFor(sessionId, undefined, path)` + `sidebarRight.openResourceIn` 交给 viewer 打开）。`files.actions` 注册按上游同款声明 `store`/`inject`（session 域合法形态，`ui-open-in-app` 有先例）；列目录与 watch 直走 `remote.workspaceFiles.list/changes` 的按根路由，remote 缺席时 lazy proxy 折成 `gateway/internal` 失败。插件私有 `files`/`readFile` 端点、`browseRoot`、`FilesView`/`FilePreview`、`RootFileTree.tsx`、`panel-files.ts` 与对应词条整体删除。复刻体类名 `mrfw-ft*`、不携带 `data-files-root`/`data-files-body`；primitives 探针失败时整树不渲染（同型降级）。附带收益：附加根树获得原生 watch 自动刷新与按 tab 的滚动/展开记忆。新增 devDep `dsh-client-ui-dockkit`、`dsh-util-workspace-path`、`dsh-api-remotes`、`dsh-client-ui-session` 全部钉在 dev pin；清单与同步步骤见 `src/client/files-tree/FORK.md`。

本机开发 pin `0.2.1-alpha.2`：P1 与 P2 各自完成时 `pnpm lint` / `typecheck` / `test` / `build` / `docs:check` / `smoke`（compose 46、behavior 99、journey 62）全绿；P10 完成时 lint / typecheck / test / build / docs:check 全绿（未跑 smoke）；P11 完成时 lint / typecheck / test（37 文件 537 passed / 22 skipped）/ build / docs:check / smoke（compose 46、behavior 99、journey 62）全绿。web 组合三态（无附加根原生观感 / 附加根选中接管 / 切回主根还原）的目检见计划 Validation 记录。

本轮 PR #11 审查修复（2026-10-12，未发布）：四项修复与回归面见[计划的 Review corrections](../completed/2026-10-12-files-header-root-browsing.md#review-corrections2026-10-12)，关联读取约束见 ADR-0011。开发 pin `0.2.1-alpha.2` 上 compat / lint / 双端 typecheck / build / docs:check 全通过；原生 macOS 内核探针确认 Seatbelt 可用，并在 `DSH_PROBE_VERIFIED_DIALECTS=seatbelt` 下运行全套测试（**549 passed / 22 skipped**）、三冒烟（compose **46/46**、behavior **99/99**、journey **62/62**）、pack:check（**92 个成员**）与 packed behavior（**98/98**），全部通过。外层 Agent 沙箱中的探针仍报告 `sandbox_apply: Operation not permitted`，原生验证在该沙箱之外完成；本轮其他版本与 Linux / Windows 的执行证据以本次提交触发的 CI 为准。

## B9：附加根三态权限与跨 SandboxMode 执行一致性（2026-10-13）

用户要求为第二期补充 B9，覆盖 P1 / P2 的沙箱与根权限问题。目标权限合同和完整实施路径见 [B9 专项计划](./2026-10-13-b9-root-access-and-sandbox-modes.md)，本节不复制权限矩阵。

- **进度**：Phase 1 审查与定案完成（2026-10-13），决策写入 [ADR-0017](../../decisions/ADR-0017-three-state-root-access-and-sandbox-modes.md)，ADR-0001/0003/0011/0012/0013 已按修订节同步。定案：三档编码 `recordedPath`→`inherit`（旧 read-write 记录自动改为继承）、`readOnlyRecordedPath`→`read-only`、新增 `readWriteRecordedPath`→固定读写；新增根默认 `inherit`；PTC（run_code）纳入 B9。**Phase 2–4 实现已落地（2026-10-14）**：注册表三档 + 迁移、scope 有效权限与 deny 集投影、fs fence 三态化、命令 `--inherit` 与面板三态、`ctx.sandbox` 受限 confine（`restrictedArgvPrefix`）与四方言 profile 变换、新增 `multi-root-process-fence` 行以 ALS + `spawn`/`spawnTerminal` 包装覆盖 shell / PTC / PTY 的 Full-access bypass。**两个组合按定案显式拒绝（spawn 前 fail closed，不计为已实现）**：Landlock Full-access + 局部只读——「尝试扩展」结论为不可行，上游启动器只有 `--ro`/`--rw` allowlist union，无法对 `--rw` 祖先做子树减法；Windows ACL 同组合——上游 runner 只导出 grant 模型（`AclSandbox`/`AclWriteGrant`），无 deny ACE 或受限 token 原语，新机制延后并在 ADR-0017 标注。Windows read-only + 固定读写经独立 runner `--mode read-only` + `--additional-root` 实现，仅授权固定根。
- **首个关口**：已核对——全部 11 个支持版本的 bash / pwsh / PTY / PTC 在 Full-access 下绕过 `confine()`；接缝定案为公开方法包装（`ctx.shell.execute`/`ctx.ptcRuntime.execute` 注入 ALS、`ctx.subprocess.spawn` 按 ALS confine、`ctx.subprocess.spawnTerminal` 由 env 会话标记恢复策略），不新增替换行。
- **本轮证据范围**：文档规划、11 个支持版本的执行链源码核对、真实 composition dump；`pnpm vitest run` 575 通过 / 22 跳过（含新增 `tests/process-fence.spec.ts` 16 例：受限 prefix、ALS 注入、PTY 会话解析 fail-closed、撤销对下一进程生效、各后端 deny 边缘）；`pnpm docs:check` 通过。**Seatbelt 已获 macOS 原生执行证据**：`sandbox-exec` CLI 直接验证两种构造（`(allow default)+(deny file-write* (subpath R))` 下 R 内写 EPERM、ambient 写放行；deny-default + graft `(allow file-write* (subpath W))` 下 W 内写放行、其余写 EPERM；且验证 deny 必须拼 canonical 路径——`/tmp` 词法拼写不匹配 `/private/tmp` 实路径，这正是 deny 集取 `recordedPath` 的原因），`smoke:behavior` 105/105 在真实组合内端到端复验（只读会话下 inherit 根拒写、固定读写根经 fs/dialect/confined bash 三面可写，0 skip）。`smoke:compose` 48/48、`smoke:journey` 62/62、`pack:check` 与 `smoke:packed` 104/104（打包产物含 `multi-root-process-fence` 行）全绿。bwrap / Landlock / Windows ACL 的原生执行证据待对应平台补齐；结构确认不当作原生证据。不借用 B4–B8 的绿灯作为 B9 证据。
- **Windows 重新纳入（2026-10-13）**：用户撤回先前延后决定；新增 [ADR-0019](../../decisions/ADR-0019-windows-token-attributes-and-conditional-acls.md)，并按修订节更新 ADR-0017 / ADR-0011。独立 runner 的 ambient token-attribute 路径接入现有 shell / PTC / PTY fence；原生回归覆盖混合根九格、PowerShell / Node 后代、受保护 DACL、overwrite / delete / rename / ACL edits、弱化令牌仍拒写、ConPTY 与 fd 7。行为冒烟及 packed 冒烟增加真实 Full-access pwsh 的主根 / 未登记目录 / 固定读写允许、显式只读拒写、移除后新进程可写断言。本机开发 pin `0.2.1-alpha.2` 上 compat / lint / 双端 typecheck / build / docs:check / pack:check 全通过；测试 **574 passed / 33 skipped**，compose **48/48**，behavior **95 passed / 6 skipped**，journey **55 passed / 2 skipped**，packed behavior **94 passed / 6 skipped**。本机外层沙箱禁止 Seatbelt 嵌套（`sandbox_apply: Operation not permitted`），Windows 原生组按平台跳过，原生结果须由本次提交 CI 确认，不能以 macOS 结构测试代替。
- **Windows 原生开发结果（2026-10-13，尚未验收）**：PR #12 的原生 CI 已实际运行新九格 / pwsh / Node 后代 / ConPTY / fd 7。restricting deny SID prototype 能通过普通文件矩阵，但 WRITE_RESTRICTED 漏掉根重命名，改完整 restricting check 后重命名被拒；token 副本保护继续被 actual impersonation 写入证伪（CI [38341055967](https://github.com/cherrchen/dsh-plugin-multi-root-workspace/actions/runs/38341055967)，输出 escaped）。条件 ACL prototype 改用 mandatory local attribute，但设置 TokenSecurityAttributes 返回 **Win32 1314**（CI [38342020870](https://github.com/cherrchen/dsh-plugin-multi-root-workspace/actions/runs/38342020870)），普通宿主缺少 SeTcbPrivilege；启动 fail closed，条件 ACL 后续尚未取得原生证据。当前 Windows Full-access 局部只读不能记为已完成，是否引入需管理员安装的最小 SYSTEM broker 等待用户范围决定。ADR-0018 标记被替代，ADR-0019 保持 Proposed；不得去掉实际令牌弱化回归来获取绿灯。
- **发布状态**：未发布，未指定目标版本；本轮不修改兼容 allowlist、创建 tag 或发版。

### B9 审查修复批次（2026-10-13）

- 第一批：失效登记保留负授权边界，Registry 刷新/重启不解除只读；成员资格与写授权继续 withheld。新增缺失目录重建、刷新/重启与显式移除回归。同时补齐面板会话模式/有效权限/工具 cap、两向继承切换确认和三模式模型 cap 说明。开发 pin 的相关七文件测试 194 passed，lint、双端 typecheck 与 docs:check 通过。其余批次与原生矩阵继续执行，不据此将 B9 标记完成。

- 第二批：实现管理员安装的每用户 SYSTEM token-attribute broker；普通 runner 在 Win32 1314 时请求服务，并读回 mandatory/inheritable 属性后继续 ACL 与 spawn。服务只允许给同用户 restricted token ADD 固定拒写属性，资源限时限长，不接受命令或 ACL 操作；安装源码随 tarball 发布，Windows CI 原生验证前安装。用户已授权继续开发，先前等待范围决定的状态由本条取代；原生执行验收继续跟进。
