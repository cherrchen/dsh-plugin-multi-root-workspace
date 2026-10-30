# 开发路径文档：Multi-root Workspace（不改上游）

> 状态：active（**进度总账 + 里程碑概览**）。MVP-v0.1.0（M1/M2/M3）已实施并以 `v0.1.0` 发版（2026-09-13）；v0.1.1 硬化批次（H1–H4）已实施、全绿并随 `v0.1.1` 发版（2026-09-16）；v0.1.2 支持矩阵提升（`0.1.6-alpha.2`、`0.1.7-alpha.1`）已实施并随 `v0.1.2` 发版（2026-09-22）；v0.1.3 支持矩阵提升（`0.1.7-alpha.2`、`0.1.7-rc.1`）已实施并随 `v0.1.3` 发版（2026-09-24）；v0.1.4 支持矩阵提升（`0.1.7-rc.2`）已实施并随 `v0.1.4` 发版（2026-09-25）；v0.1.5 DSH 0.2 支持矩阵提升已发版；v0.1.6 已发版；v0.1.7（第二期 B 系列、Files 页签附加根浏览、DSH `0.2.1-alpha.3`–`0.2.1-rc.2`）已发版；v0.1.8（DSH 0.2.0 `permissionPresets/catalog` 修复：可选包分类取证 + provider 行去门禁化）已发版；v0.1.9（Auto Review 多根上下文以主包内置可选行交付，默认关闭，ADR-0022）已发版；v0.1.10（附属根 Skills、Workspace Folders 面板对齐与 DSH `0.2.1-rc.3`）已发版；v0.1.11（DSH `0.2.1-rc.4` 与 `0.2.2-alpha.2` 支持矩阵提升、Issue #24 Registry／Skills 刷新循环 hot-fix）已发版；第二期（B 系列）范围见[需求文档 §4/§7](../../requirements/multi-root-workspace.md)。
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
| 第二期 | B1–B3 加固与 Windows 全量验证 | 每个消费者补原生执行证据、Windows fail-closed、打包产物与 Windows 冒烟入全平台门禁 | [本节](#b1b3-加固与-windows-全量验证2026-10-11) | [0011 修订](../../decisions/ADR-0011-multi-root-workspace-consumers.md) | `9f9a1df`…`a385f06` | `v0.1.7` |
| 第二期 | B4 per-root / per-tool 权限 | 根自带 read-write / read-only 访问级别；`toolAccess` 按工具封顶附加根写权限（ALS 经 `tools/execute`）；命令与面板 surface | [B4–B8](./2026-10-11-b4-b8-p2.md) | [0013](../../decisions/ADR-0013-per-root-and-per-tool-access.md) | `99a443f`…`1758885`、`980b925`、`8e770c9`…`f4fc3df` | `v0.1.7` |
| 第二期 | B5 mutation 前重分类 | 每个 mutation 的 serialize job 以存储记录重新分类再校验；revive 只看 fresh 分类 | [B4–B8](./2026-10-11-b4-b8-p2.md) | [0004 修订](../../decisions/ADR-0004-root-registry-persistence-and-validation.md)、[0014](../../decisions/ADR-0014-root-limit-and-provider-conflict.md) | `a3240b1`、`395e32b` | `v0.1.7` |
| 第二期 | B6 附加根数量上限 | `maxAdditionalRoots` 默认 16、顶 64；按全部存储记录计数；超限存量照授只拒新增；非法配置 fail closed | [B4–B8](./2026-10-11-b4-b8-p2.md) | [0014](../../decisions/ADR-0014-root-limit-and-provider-conflict.md) | `067933f` | `v0.1.7` |
| 第二期 | B7 provider 冲突检测 | 品牌 + `multi-root-providers` 门禁；外来 `ctx.fs`/`ctx.sandbox` 下注册表缺席、scope 为空 | [B4–B8](./2026-10-11-b4-b8-p2.md) | [0014](../../decisions/ADR-0014-root-limit-and-provider-conflict.md) | `2a36d5f` | `v0.1.7` |
| 第二期 | B8 平台感知提示词 | `renderWorkspaceRootsContext` 纯函数化；按模式/平台/访问级别陈述授权；win32 附带 partial-enforcement 说明 | [B4–B8](./2026-10-11-b4-b8-p2.md) | [0013](../../decisions/ADR-0013-per-root-and-per-tool-access.md) | `a7f3d20` | `v0.1.7` |
| 第二期 | B9 附加根三态权限与跨 SandboxMode 执行一致性 | 继承 / 只读 / 读写；显式根权限覆盖会话模式默认行为，文件与新进程执行一致；先验证 Full-access 局部限权 | [B9 计划](../completed/2026-10-13-b9-root-access-and-sandbox-modes.md) | [0017](../../decisions/ADR-0017-three-state-root-access-and-sandbox-modes.md)；并修订 [0001](../../decisions/ADR-0001-provider-replacement-scope.md)/[0003](../../decisions/ADR-0003-dialect-grant-widening.md)/[0011](../../decisions/ADR-0011-multi-root-workspace-consumers.md)/[0012](../../decisions/ADR-0012-session-origin-and-effective-cwd.md)/[0013](../../decisions/ADR-0013-per-root-and-per-tool-access.md) | `55c6260` | B9 实施与原生验收完成；Windows 普通 deny-only 组与暂停赋值、Linux bubblewrap 补局部只读；保留 Windows partial 边界；随 `v0.1.7` 发版 |
| 第二期 | 分支安全审查修复（R1–R4） | 负授权规则统一（R2/R3）、Windows 祖先路径稳定性（R1）、硬链接失败关闭与 profile 隔离（R4） | [审查计划](./2026-10-16-branch-security-review-and-hardlink-isolation.md) | [0017 修订](../../decisions/ADR-0017-three-state-root-access-and-sandbox-modes.md)、[0004 修订](../../decisions/ADR-0004-root-registry-persistence-and-validation.md)、[0020 修订](../../decisions/ADR-0020-windows-normal-deny-groups.md) | `55c6260` | Phase A（R2/R3）、B（R1）、C1（全根硬链接预检）与 C2（`/workspace-folders isolate-profiles` 命令、迁移与冒烟）已实施，门禁已执行（771 通过 / 49 跳过，冒烟四项实跑通过）；POSIX 原生内核未验证；随 `v0.1.7` 发版 |
| 第二期 | Files 页签附加根浏览（P1–P11） | `RootSwitcher` 根切换器 + 复刻的 `RootFileTree` 接管树区；open-in-app fork 重定向到选中根；面板徽标、`PathCopy`、确认层与下拉选择器 | [P1–P11](#files-头部根浏览-p1p112026-10-12未发布) | [0015](../../decisions/ADR-0015-files-tab-plugin-owned-browsing.md)、[0016](../../decisions/ADR-0016-files-tab-native-tree-fork.md) | `79f6934`…`a43cbc0` | `v0.1.7` |
| compat | DSH 0.2.1 后续提升 | DSH 支持矩阵扩展至 `0.2.1-alpha.3`–`0.2.1-rc.2` 五个精确版本；storage-domain zod 分裂适配、warn 车道 allow-version 预授权 | [本次记录](#dsh-021-后续兼容提升2026-10-17) | [0009](../../decisions/ADR-0009-dsh-compat-contract.md) | `eaf2d8f` | `v0.1.7` |
| compat | DSH 0.2.1-rc.3 提升 | DSH 支持矩阵纳入 `0.2.1-rc.3`；上游差异全部为新增（sidebar 槽位、导航 pins、DeepSeek `/models`），无新适配分支；开发 pin 升级 | [本次记录](#dsh-021-rc3-兼容提升2026-10-23) | [0009](../../decisions/ADR-0009-dsh-compat-contract.md) | `bddeae3` | `v0.1.10` |
| compat | DSH 0.2.1-rc.4 与 0.2.2-alpha.2 提升 | DSH 支持矩阵纳入 `0.2.1-rc.4` 与 `0.2.2-alpha.2`；测试栈补 `sessionProjections` 注入与执行器结构探测；fork 基线前移 `f3803c9697`；CI 按版本分流 Node 22/24；升级脚本补 cordis 生态 pin 防混树；开发 pin `0.2.2-alpha.2` / cordis `4.0.6-alpha.1` | [本次记录](#dsh-021-rc4-与-022-alpha2-兼容提升2026-10-28) | [0009](../../decisions/ADR-0009-dsh-compat-contract.md) | `08795a1` | `v0.1.11` |
| compat | DSH 0.2.0 `permissionPresets/catalog` 修复 | 可选包按"谁加载副本、经哪个锚点"分三类取证（运行时加载 / 宿主服务 / runner 锚定），link: 检出不再幻影混装；两个 provider 行不再 inject 门禁，被拒安装退化为上游等价而非拖死 `ctx.fs`/`ctx.sandbox`/`ctx.shell`/`permissionPresets` | [本次记录](#dsh-020-permissionpresetscatalog-修复2026-10-18) | [0009 修订](../../decisions/ADR-0009-dsh-compat-contract.md) | `f6d81de` | `v0.1.8` |
| 第二期 | 后续 P3 项 | Registry observer 语义、TOCTOU 表述、workspace 导入导出、SDK API 等 | 见[需求文档 §4/§7](../../requirements/multi-root-workspace.md) | — | — | 未开始 |
| 兼容协作 | Auto Review 多根上下文 | 拓扑/有效访问权限/当前项目约束的可信输入；可选外部兼容层及联合验证 | [适配计划](../completed/2026-10-18-auto-review-context-adaptation.md)、[源码调研](../../reference/auto-review-compatibility.md) | [0021](../../decisions/ADR-0021-auto-review-context-companion.md) | `feat/compat-auto-review` | Phase 0–2 已实施；本机验收与旧版回归见[本次记录](#auto-review-多根上下文适配2026-10-18)；仅联合目标 `0.2.1-rc.2`；独立 companion 交付形态在发布前被 ADR-0022 取代，能力以内置行随 `v0.1.9` 发版；Phase 3 不在本批范围 |
| 兼容协作 | Auto Review 内置入口迁移 | companion 并入主包：`./auto-review` 导出 + 默认 `disabled` 的 `multi-root-auto-review` 行；loader 生命周期接管/恢复；configure、独立 manifest 与第二 tarball 退役 | [评审记录](../completed/2026-10-20-auto-review-in-package-review.md)、[迁移记录](#auto-review-内置入口迁移2026-10-20) | [0022](../../decisions/ADR-0022-auto-review-loader-entry.md) | `9138084`…`e4804fb` | `v0.1.9` |
| 第二期 | 附属根 Skills（S1–S7） | 附属根 `.dsh/skills` / `.agents/skills` 发现、`/alias-id:skill-name` 命名空间调用、每根开关与 `aliasId`、全局 Settings 开关；native effective-cwd 旁路封堵 | [实施计划](../completed/2026-10-23-multi-root-skills.md)、[本次记录](#multi-root-skills-架构验证2026-10-23) | [0023](../../decisions/ADR-0023-multi-root-skill-discovery-and-invocation.md) | `1218543`…`e2c6fb1` | `v0.1.10` |
| hot-fix | Issue #24 Registry／Skills 刷新循环 | `setRegistryAuthority()` 仅在实际状态变化时通知，阻断 Skills 失效 → `skills/change` → 客户端重查的无界反馈循环；lease 重试、接管与 fail-closed 语义不变 | [本次记录](#issue-24registryskills-刷新循环-hot-fix2026-10-29) | [0023 修订](../../decisions/ADR-0023-multi-root-skill-discovery-and-invocation.md) | `c53c8a9` | `v0.1.11` |
| Long-term | 多 Host 共享 Registry 权威服务 | 实现完成；本机与最早同步基线已验收，三平台/全版本矩阵待 CI | [专项计划](./2026-10-30-shared-registry-authority.md)、[本次记录](#多-host-权威服务开发2026-10-29) | [0025](../../decisions/ADR-0025-shared-registry-authority.md) | `c56fbb2` | 未发布 |


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

用户要求为第二期补充 B9，覆盖 P1 / P2 的沙箱与根权限问题。目标权限合同和完整实施路径见 [B9 专项计划](../completed/2026-10-13-b9-root-access-and-sandbox-modes.md)，本节不复制权限矩阵。

- **进度**：Phase 1 审查与定案完成（2026-10-13），决策写入 [ADR-0017](../../decisions/ADR-0017-three-state-root-access-and-sandbox-modes.md)，ADR-0001/0003/0011/0012/0013 已按修订节同步。定案：三档编码 `recordedPath`→`inherit`（旧 read-write 记录自动改为继承）、`readOnlyRecordedPath`→`read-only`、新增 `readWriteRecordedPath`→固定读写；新增根默认 `inherit`；PTC（run_code）纳入 B9。**Phase 2–4 实现已落地（2026-10-14）**：注册表三档 + 迁移、scope 有效权限与 deny 集投影、fs fence 三态化、命令 `--inherit` 与面板三态、`ctx.sandbox` 受限 confine（`restrictedArgvPrefix`）与四方言 profile 变换、新增 `multi-root-process-fence` 行以 ALS + `spawn`/`spawnTerminal` 包装覆盖 shell / PTC / PTY 的 Full-access bypass。**两个组合按定案显式拒绝（spawn 前 fail closed，不计为已实现）**：Landlock Full-access + 局部只读——「尝试扩展」结论为不可行，上游启动器只有 `--ro`/`--rw` allowlist union，无法对 `--rw` 祖先做子树减法；Windows ACL 同组合——上游 runner 只导出 grant 模型（`AclSandbox`/`AclWriteGrant`），无 deny ACE 或受限 token 原语，新机制延后并在 ADR-0017 标注。Windows read-only + 固定读写经独立 runner `--mode read-only` + `--additional-root` 实现，仅授权固定根。
- **首个关口**：已核对——全部 11 个支持版本的 bash / pwsh / PTY / PTC 在 Full-access 下绕过 `confine()`；接缝定案为公开方法包装（`ctx.shell.execute`/`ctx.ptcRuntime.execute` 注入 ALS、`ctx.subprocess.spawn` 按 ALS confine、`ctx.subprocess.spawnTerminal` 由 env 会话标记恢复策略），不新增替换行。
- **本轮证据范围**：文档规划、11 个支持版本的执行链源码核对、真实 composition dump；`pnpm vitest run` 575 通过 / 22 跳过（含新增 `tests/process-fence.spec.ts` 16 例：受限 prefix、ALS 注入、PTY 会话解析 fail-closed、撤销对下一进程生效、各后端 deny 边缘）；`pnpm docs:check` 通过。**Seatbelt 已获 macOS 原生执行证据**：`sandbox-exec` CLI 直接验证两种构造（`(allow default)+(deny file-write* (subpath R))` 下 R 内写 EPERM、ambient 写放行；deny-default + graft `(allow file-write* (subpath W))` 下 W 内写放行、其余写 EPERM；且验证 deny 必须拼 canonical 路径——`/tmp` 词法拼写不匹配 `/private/tmp` 实路径，这正是 deny 集取 `recordedPath` 的原因），`smoke:behavior` 105/105 在真实组合内端到端复验（只读会话下 inherit 根拒写、固定读写根经 fs/dialect/confined bash 三面可写，0 skip）。`smoke:compose` 48/48、`smoke:journey` 62/62、`pack:check` 与 `smoke:packed` 104/104（打包产物含 `multi-root-process-fence` 行）全绿。bwrap / Landlock / Windows ACL 的原生执行证据待对应平台补齐；结构确认不当作原生证据。不借用 B4–B8 的绿灯作为 B9 证据。
- **Windows 重新纳入（2026-10-13）**：用户撤回先前延后决定；新增 [ADR-0019](../../decisions/ADR-0019-windows-token-attributes-and-conditional-acls.md)，并按修订节更新 ADR-0017 / ADR-0011。独立 runner 的 ambient token-attribute 路径接入现有 shell / PTC / PTY fence；原生回归覆盖混合根九格、PowerShell / Node 后代、受保护 DACL、overwrite / delete / rename / ACL edits、弱化令牌仍拒写、ConPTY 与 fd 7。行为冒烟及 packed 冒烟增加真实 Full-access pwsh 的主根 / 未登记目录 / 固定读写允许、显式只读拒写、移除后新进程可写断言。本机开发 pin `0.2.1-alpha.2` 上 compat / lint / 双端 typecheck / build / docs:check / pack:check 全通过；测试 **574 passed / 33 skipped**，compose **48/48**，behavior **95 passed / 6 skipped**，journey **55 passed / 2 skipped**，packed behavior **94 passed / 6 skipped**。本机外层沙箱禁止 Seatbelt 嵌套（`sandbox_apply: Operation not permitted`），Windows 原生组按平台跳过，原生结果须由本次提交 CI 确认，不能以 macOS 结构测试代替。
- **Windows 原生开发结果（2026-10-13，尚未验收）**：PR #12 的原生 CI 已实际运行新九格 / pwsh / Node 后代 / ConPTY / fd 7。restricting deny SID prototype 能通过普通文件矩阵，但 WRITE_RESTRICTED 漏掉根重命名，改完整 restricting check 后重命名被拒；token 副本保护继续被 actual impersonation 写入证伪（CI [38341055967](https://github.com/cherrchen/dsh-plugin-multi-root-workspace/actions/runs/38341055967)，输出 escaped）。条件 ACL prototype 改用 mandatory local attribute，但设置 TokenSecurityAttributes 返回 **Win32 1314**（CI [38342020870](https://github.com/cherrchen/dsh-plugin-multi-root-workspace/actions/runs/38342020870)），普通宿主缺少 SeTcbPrivilege；启动 fail closed，条件 ACL 后续尚未取得原生证据。当前 Windows Full-access 局部只读不能记为已完成，是否引入需管理员安装的最小 SYSTEM broker 等待用户范围决定。ADR-0018 标记被替代，ADR-0019 保持 Proposed；不得去掉实际令牌弱化回归来获取绿灯。
- **发布状态**：未发布，未指定目标版本；本轮不修改兼容 allowlist、创建 tag 或发版。

### B9 审查修复批次（2026-10-13）

- 第一批：失效登记保留负授权边界，Registry 刷新/重启不解除只读；成员资格与写授权继续 withheld。新增缺失目录重建、刷新/重启与显式移除回归。同时补齐面板会话模式/有效权限/工具 cap、两向继承切换确认和三模式模型 cap 说明。开发 pin 的相关七文件测试 194 passed，lint、双端 typecheck 与 docs:check 通过。其余批次与原生矩阵继续执行，不据此将 B9 标记完成。

- 第二批：实现管理员安装的每用户 SYSTEM token-attribute broker；普通 runner 在 Win32 1314 时请求服务，并读回 mandatory/inheritable 属性后继续 ACL 与 spawn。服务只允许给同用户 restricted token ADD 固定拒写属性，资源限时限长，不接受命令或 ACL 操作；安装源码随 tarball 发布，Windows CI 原生验证前安装。用户已授权继续开发，先前等待范围决定的状态由本条取代；原生执行验收继续跟进。

- 第三批：Full-access shell/PTC 结果补齐实际后端诊断，保留 execution 身份/缓存，PTC 改用公开 run 接缝；Landlock 组合选择 bubblewrap 并保持 ambient 文件/进程/设备语义；bwrap 临时区的只读根保持可读。客户端样式与双语回归同步修正，真实组合/packed 冒烟扩展到各 OS 的 Full-access 与 PTC。实际执行证据随后记录。

- 第三批本机验收：开发 pin 0.2.1-alpha.2；compat / lint / 双端 typecheck / build / docs:check / pack:check 全通过。原生 Seatbelt probe 通过并强制执行对应内核断言：测试 593 passed / 26 skipped（其他平台不算本机证据），compose 48/48、behavior 126/126、journey 62/62、packed behavior 125/125，所有冒烟 0 skip。Windows broker 原生 CI 已通过编译和安装，已修复属性查询 ABI；完整 Windows 与 Linux bwrap 证据继续由当前提交矩阵确认。

- 第四批：矩阵发现并修复旧版 shell 的公开前台 run 入口绕过（不能只包 execute/start）、Windows 管道必须先读取再取得 impersonation 身份、跨平台 POSIX profile 路径比较，以及原生测试将 Landlock 成功运行的 partial warning 误判为 runner 失败。新增独立 runner 证据分类、九格 edit、三模式工具 cap 和真实 Koffi UTF-16 回归；兼容笔记双语同步。Windows 弱化令牌反绕过断言保留，新的矩阵继续验证。

### B9 暂停交接（2026-10-13）

用户要求暂停开发并准备交接。B9 **未完成、未验收、未发布**，继续工作需要用户恢复任务。用户此前已授权具体实现 Windows ADR-0019，不能把拒绝启动作为最终结果，也不能删除弱化令牌实际写入回归来获取绿灯。

- 仓库：`/Volumes/西数2T/Chen/deepseek-harness/dsh-plugin-multi-root-workspace`；分支 `feat/sandbox-permision-harden`；[PR #12](https://github.com/cherrchen/dsh-plugin-multi-root-workspace/pull/12)。最新开发提交 `e472de4` 已推送。此次交接前工作树干净；本节是暂停后唯一文件修改，尚未提交/推送。PR 已更新实现说明，但最后的测试数字和 Windows 失败事实尚需在恢复后同步。
- 已推送批次：`55cb262` 失效只读边界/有效权限；`1c822db` SYSTEM broker；`9f00548` Framework 编译歧义；`e946389` 属性查询 ABI；`598df54` 进程诊断/Linux 混合权限；`7c4e99f` UTF-16 指针解码；`e472de4` 旧 shell run/管道认证读取顺序/原生证据分类。
- 本机最终原生验证：开发 pin `0.2.1-alpha.2`，Seatbelt 内核断言强制运行；测试 **598 passed / 26 skipped**，compose **48/48**、behavior **126/126**、journey **62/62**、packed behavior **125/125**，冒烟全部 0 skip。compat、lint、双端 typecheck、build、docs:check、pack:check 通过。其他平台的跳过不是本机原生证据。
- 当前 [CI 38348496627](https://github.com/cherrchen/dsh-plugin-multi-root-workspace/actions/runs/38348496627) 对应 `e472de4`，暂停时仍在运行，不取消。已成功32个 job（包括 versions job），另有两个 macOS job 运行中。**全部11个 Windows 版本失败**；应在恢复后重新读取最终结果。Linux latest 和 Ubuntu 22.04 的原生执行已有通过结果，不能据此认为 Windows 完成。

**必须首先处理的 Windows 缺陷**：broker 已通过编译、管理员安装、管道认证、设置 mandatory/inheritable 属性与 runner 读回；进程可以启动，但条件 ACL 没有兑现拒写。`tests/windows-native.e2e.ts` 的完整矩阵、mutation/弱化令牌、ConPTY 三组失败：显式只读根返回 `allowed`；overwrite/delete/rename/弱化令牌组出现 `escaped`；ConPTY 只读写入也放行。代表 job `115135351095`（`0.1.7-alpha.2, windows-latest`），原始日志在本机 `/tmp/b9-broker-handshake.log`（约693–780行；临时文件可能在后续会话消失，以 CI 为准）。启动成功绝不能作为拒写验收。

排查入口：`src/windows-deny.ts` 的 token 构造/属性读回/`protect()`/child spawn，`src/compat/windows-native.ts` 的公开进程 seam，`scripts/windows-broker/service.cs`。目前条件表达式为 `(Exists DshMultiRootDeniedRoots && DshMultiRootDeniedRoots Contains "<root-id>")`，条件 deny 放在 ACL 首位。普通 token 设置 Win32 1314 已通过 broker 解决；新失败根因尚未证明。下一步应直接核验真正子进程 token 是否保留属性、条件 ACE 是否匹配，而不是继续修改无证据的兼容分支。Chromium 的公开属性实现使用本地属性名和 mandatory flags，可作为 ABI 参照；不要把 `@User` 属性与本地属性混为一谈。

**已修复的兼容风险（恢复后第一批提交）**：`src/compat/process-result.ts` 的 `decorateProcessOutcome()` 曾把旧 shell `start()` 返回的活跃后台 handle 交给 `stampProcessResult()` 展开复制，丢失原型、live 字段和方法身份——上游 `processOutcome(proc)` 与 `renderProcessRead(proc.readOutput(), proc.sandbox)` 都读同一对象，副本会冻结 `status`/`exitCode` 并脱离消费者持有的实体。现改为：handle 形态（`done` settle 钩子、可调成员或非平凡原型）保持身份原地返回，`sandbox` 戳记推迟到 `done` 结算时按上游 `onProcessDone` 语义原地写入；结算 stderr 由 `process-fence.ts` 的 spawn 包装器经 `SubprocessHandle.collected.stderr.readFrom(0)`（游标无关、全版本契约）捕获并作为 diagnostics 传入。回归覆盖 live handle 身份/取消/轮询、结算戳记、runner 失败分类与无 diagnostics 退化；本机 602 passed / 27 skipped。

恢复后顺序：读取本节与 ADR-0017/0019、双语兼容笔记；检查 Git/最终 CI 状态；修复以上两个问题；运行相应本机检查并分批提交推送；保留 Windows 原生反绕过测试，确认11版本×4系统完整 gate；更新本账本和 PR 最终证据后才能记完成。版本 allowlist、版本号和 tag 均未变更，用户没有要求发布。

CI 日志读取：`gh api --allow-escape-sequences repos/cherrchen/dsh-plugin-multi-root-workspace/actions/jobs/<job-id>/logs > /tmp/b9-job.log`。`gh run view --log-failed` 会尝试写受限制的默认 cache；上述 API 可避开。Git 写操作及本机脱离外层沙箱的 Seatbelt 原生执行需要工具的 `require_escalated`；前述提交/推送与测试已有授权。不要输出完整 journey/smoke 日志，其中可能含临时 web 认证令牌。

### B9 交接续作：普通 deny-only 组候选（2026-10-13）

收到外部 Agent 的交接并恢复开发。起点 `b947250` 干净且已推送；旧 start() 活句柄与 stderr 诊断改动保留。复核 CI 38376966866：UserClaimAttributes 写入在两种 token 上均返回 87；`@User` Exists 探针的 PowerShell 非终止 SDDL 错误导致 ACE 未装入，该探针不能证明求值。当前改用 [ADR-0020](../../decisions/ADR-0020-windows-normal-deny-groups.md) 候选：NtCreateTokenEx 镜像调用方身份，仅增加普通 deny-only groups，普通 deny ACE 不依赖属性求值；弱化测试增加 disable 全部普通组后的真实写入。B9 仍未完成、未发布，Windows 原生与完整门禁正在验证。

候选提交 `13af289` 的本机门禁：compat/typecheck/lint/build/docs 全通过；602 passed / 26 平台跳过，随后加入 broker 响应边界回归后 609 passed / 26 平台跳过；Seatbelt probe 通过，compose 48/48、behavior 126/126、journey 62/62、packed behavior 125/125，所有冒烟 0 skip。CI [38391229281](https://github.com/cherrchen/dsh-plugin-multi-root-workspace/actions/runs/38391229281) 的 Windows C# 编译通过、服务启动失败，尚未到达 token / 拒写断言。续作将 token-create 特权错误移到可回传的请求阶段，并让现有单版本 diag workflow 在相关 PR 编辑时运行；完整 CI 门禁不减少。弱化测试进一步要求实际激活成功且写返回 EPERM/EACCES，增加受限调用方向 broker 请求重建 token 的拒绝断言。

单版本 [diag 38391811054](https://github.com/cherrchen/dsh-plugin-multi-root-workspace/actions/runs/38391811054) 明确失败为 `EnablePrivilege(SeCreateTokenPrivilege) win32=1300`，LocalSystem 并不持有候选需要的 token-create 特权。续作改用 ADR-0020 的专用虚拟服务账户和仅该 SID 的固定 LSA rights；完整 CI 旧候选轮次已取消，继续保留全矩阵验收要求。

专用账户候选 `7d49dfb` 的 [diag 38393091968](https://github.com/cherrchen/dsh-plugin-multi-root-workspace/actions/runs/38393091968) 已通过账户 rights 配置及服务启动，实际请求在 `OpenProcessToken(client)` 返回 Win32 5。修正为仅在短暂模拟已认证 pipe caller 期间获取其 process-token QUERY/QUERY_SOURCE handle，随后恢复服务身份进行创建；不放宽 token DACL，也不接受客户端提供身份。

候选 `4969e15` 的 [diag 38393550613](https://github.com/cherrchen/dsh-plugin-multi-root-workspace/actions/runs/38393550613) 已越过 token handle 获取，下一处失败为信息查询 size 检查。空 claim/group 通道改为提供至少 16 字节的已清零 buffer 进行实际查询，必须确认第二次 API 调用成功；不能从 sizing 失败推断空集合。所有查询错误现在带信息类编号及 Win32 码。

候选 `f7c753e` 的 [diag 38394060369](https://github.com/cherrchen/dsh-plugin-multi-root-workspace/actions/runs/38394060369) 已越过全部 source 信息查询并执行 NtCreateTokenEx，返回 NTSTATUS c000000d / Win32 87。续作补齐 ObjectAttributes 的 SECURITY_QUALITY_OF_SERVICE（SecurityImpersonation）；另拒绝源 token 的可继承 local 属性，以免创建时丢掉原有属性约束。

候选 `5e65a2f` 的 [diag 38395468655](https://github.com/cherrchen/dsh-plugin-multi-root-workspace/actions/runs/38395468655) 给出参数对照：原始 groups 创建成功（base=0）；增加直接 deny-only groups 后 extended、no-policy、legacy 均 c000000d。改为仅在 broker 内创建普通组，随即以 CreateRestrictedToken 转成 deny-only 并移除 bypass privileges，服务不回传中间 token；runner 再过滤并验证普通组 deny-only / 非 enabled，不把 mandatory 位当作抗删除依据。普通组与可删除 restricting list 的区别仍由原生弱化测试验证。

候选 `83139a2` 的 [diag 38396216276](https://github.com/cherrchen/dsh-plugin-multi-root-workspace/actions/runs/38396216276) 已通过 NtCreateTokenEx、服务内转换 deny-only、runner 再过滤及组读回，失败移到 CreateProcessAsUserW / Win32 1314：broker 创建的 token 不属于 runner 自身的直接派生，不能享受免 SeAssignPrimaryTokenPrivilege 的启动例外。续作的本地候选新增仅对 caller-owned 初始暂停子进程设置 token 的 v3 操作；helper 创建 flag、parent PID、线程归属、源身份与实际 child token 回读均须验证，失败终止且不 Resume。专用服务账户需要另增 SeAssignPrimaryTokenPrivilege，用户已明确授权该新增权限及提交、推送、原生 CI 验证；不为宿主用户授予特权，不把 argv 或路径传给服务。

暂停赋值候选 `43e0a26` 的 [diag 38399814375](https://github.com/cherrchen/dsh-plugin-multi-root-workspace/actions/runs/38399814375) Windows 原生 18/18 全通过，包括真实弱化 token 激活后拒写及 broker 重建拒绝。完整矩阵同一提交发现 `0.1.5-rc.2` 的公开 process binding 缺少 GetFileType，fd 7 用例失败；兼容层通过公开 extension seam 补齐，保留原生回归，不缩小版本矩阵。补充安装、升级、卸载的真实 LSA policy 回读验证，要求预存服务权限与其他账户权限不变。完整门禁尚待最终结果。

### B9 最终验收（2026-10-13，未发布）

实现提交 `006637a` 的 [完整 CI 38400586253](https://github.com/cherrchen/dsh-plugin-multi-root-workspace/actions/runs/38400586253) 全部通过：11 个精确支持版本 × Windows / macOS / Ubuntu latest / Ubuntu 22.04 = 44 个 verify job，另加 releases 与总 gate，46/46 success。各版本执行 compat、lint、双端 typecheck、build、kernel probe、单元与原生测试、compose / behavior / journey、pack / packed smoke、docs；Windows 在安装 broker 后运行，结束卸载并撤销新增权限。全部 11 个 Windows job 的原生 ACL suite 18/18 通过；包括 overwrite / delete / rename / ACL reset、protected descendants、两种真实 token 激活后拒写、disable 全部普通组后的拒写、broker 重建拒绝、ConPTY / fd 7 与宿主写允许。

[diag 38400586259](https://github.com/cherrchen/dsh-plugin-multi-root-workspace/actions/runs/38400586259) 额外验证服务安装、升级、卸载的实际 LSA policy；预存服务登录权保留，其他账户权限不变。Mac 本机最终 618 passed / 26 其他平台跳过，Seatbelt probe 通过，compose 48/48、behavior 126/126、journey 62/62、packed behavior 125/125 全部 0 skip；compat / lint / typecheck / build / pack / docs 通过。

Phase 5 完成，专项计划移至 completed；ADR-0020 Accepted，ADR-0019 保留 Superseded 历史。用户已分别明确授权提交推送、专用服务账户及包括 SeAssignPrimaryTokenPrivilege 在内的固定权限集合。未合并 PR #12、未创建 tag、未发布；完整门禁不扩大 allowlist，Windows 仍报告 partial，授权快照、standing ACL、path-based TOCTOU 与 owner/parent 操作边界见 ADR-0020 及其链接的 ADR-0018。

### B9 外部审查返工（2026-10-14，PR #12 评审）

外部评审复现两个 Full-access P1 绕过，另有一项 Linux 可用性问题；三处修复设计经用户批准，合同与残余记录于 [ADR-0017 修订](../../decisions/ADR-0017-three-state-root-access-and-sandbox-modes.md#外部审查返工修订2026-10-14pr-12-评审) 与 [ADR-0007 第三轮修订](../../decisions/ADR-0007-registry-authority-lease.md#第三轮修订2026-10-14b9-评审返工)。

- **权限未知 ≠ 没有限制（P1）**：`registry-contended` 进程发布空 scope 后，Full-access 的 fs / 进程 fence 曾把空 deny 集当作「无限制」放行 ambient 写，可覆写另一进程登记的 `read-only` 根。修复：scope 新增 `authority: 'available' | 'unavailable'`（注册表在构造、contended、storage-failed、config-invalid、releaseAuthority 转场标 `unavailable`，`openDomain` 发布完全部记录后标 `available`）；不可用时 fs fence 以 `writableRoots({mode:'workspace-write'})` 判定（仅主根 + temp，不并入 scope 成员），进程 fence 用 `clampedExecution`（`workspace-write` 探针 + 原 profile 前缀）钳制 shell / PTC / PTY，`spawnTerminal` 不可解析会话经 `hasActiveDenyRoots()` 自动拒绝；模型拓扑在 Full-access + 不可用时固定陈述降级句。
- **Full-access 不再沿用旧 FsTarget（P1）**：`checkedTarget` 只在 Full-access 且 deny 集为空时返回调用方 target（零根逐字节保持上游）；其余一律重解析 displayPath、以新 `targetKey` 判 deny 并以新 target 执行 mutation——评审的「父目录被换成指向只读根的符号链接」绕过被关闭。
- **bwrap deny 根改用 `--ro-bind-try`（历史决定，已取代）**：此前 `--ro-bind <missing recordedPath>` 使 bwrap 启动即失败，一个被删除的只读根会打断全部 Full-access shell（或其位于 temp 时的 workspace-write 命令）。deny / restrict（含 landlock→bwrap）均改 `--ro-bind-try`；当时记录了命名空间内可重建目录的残余，后续 P1 确认 fs fence 无法兜底进程写入，以下修订撤回该决定。

回归：新增 `tests/b9-review-regressions.spec.ts`（反转的两条 P1 复现：争用进程写只读根与 ambient 区均拒写、接管后恢复；stale target 的 write/edit 均拒写）；scope / registry-lease 增加 authority 状态断言；process-fence 增加 clamped prefix（与上游 `workspace-write` confined argv 逐项一致）与不可解析终端断言；dialects 期望改 `--ro-bind-try`；prompt-context 增加降级句。本机门禁输出见交接报告；未发布，版本号与 allowlist 不变。

#### 用户终端直通与 `$DSH_HOME` 负授权（2026-10-14 第二批）

两项用户产品决策，合同记录于 [ADR-0017 修订节](../../decisions/ADR-0017-three-state-root-access-and-sandbox-modes.md#用户终端直通与-dsh_home-负授权修订2026-10-14)。

- **面板用户终端任何模式不受约束**：原 `spawnTerminal` 按 `env.DSH_SESSION_ID` 恢复会话的机制把面板用户终端（controller 同盖该标记）误伤为受限对象。判别改为 `DSH_PTY_SESSION_ID`：全部 11 个支持版本的 `dsh-terminal-bash` backend 启动 agent PTY 时经 `childEnvironment` 盖该标记（与 `DSH_SESSION_ID` 并列），面板 controller 不盖——env 无该标记即用户终端，任何模式直通；有则按 `DSH_SESSION_ID` 恢复会话与策略，会话不可解析且 `hasActiveDenyRoots()` 时 fail closed。`ctx.terminals` 不包装：`optional-persistent-terminals` 组 `isolate: terminals` 使 registry 在 web profile 不可达，env 判别同时覆盖隔离与未隔离挂载。
- **`$DSH_HOME` 受限 Full-access 负授权**：scope 新增 `dshHome` 配置（patch 行 `dshHomePath()`；非法值记 error 忽略）。`danger-full-access` 且（deny 集非空或 authority `unavailable`）时把 canonical home 追加进 `deniedRoots`（`protectedHome`），`workspace-write` / `read-only` 与零根健康 authority 不追加；主根在 home 内时 deny 胜出。fs 有专用拒写文案；`clampedExecution` 改收 deny 集并按 workspace-write 分支规则 graft（POSIX `denyProfileArgs`、Windows `widenWindowsProfile(…, [], denied, primary)`），不可表达 → `SandboxUnavailableError`；模型拓扑固定陈述 home 拒写。Windows 风险如实记录：该 deny 经 `runWindowsDenied` 对 home 整树写**持久化** deny ACE（含父目录守卫），ambient 进程不受影响但存在 ACL 写入量与节点失败面。

回归：process-fence agent/user 终端分轨断言（controller 形状直通、backend 形状受限/钳制、不可解析会话 fail closed）、scope `protectedHome` 触发矩阵、b9-review-regressions home 拒写（含主根位于 home 内）、patch 行 `dshHome`、prompt-context home 陈述句。未发布；版本号与 allowlist 不变。


#### 最新 P1：缺失拒写根的 bubblewrap 挂载（2026-10-14）

PR #12 的最新 Code Reviewer 指出 `--ro-bind-try` 会在只读根被删除时跳过挂载，使 Full-access 进程可重建并写入该路径。deny / restrict（含 Landlock fallback）统一改回强制 `--ro-bind`，源缺失时拒绝启动；workspace-write 可写父挂载同样失败关闭。决策、代价与回归场景见 [ADR-0017 缺失根修订](../../decisions/ADR-0017-three-state-root-access-and-sandbox-modes.md#缺失-deny-根必须失败关闭2026-10-14pr-12-最新-p1)。新增 `tests/missing-deny-root.spec.ts`；未发布，版本与 allowlist 不变。

验证：新增三项构造回归在旧实现上均失败，修复后通过；开发 pin 的 compat、lint、双端 typecheck、build、docs:check、pack:check 通过。原生 Seatbelt probe 通过；完整测试 643 通过 / 29 平台跳过（含新增的 3 项 Linux 原生用例）；compose 48/48、behavior 126/126、journey 62/62、packed behavior 125/125，全部冒烟 0 skip。本机为 macOS，bubblewrap / Landlock 不可用，Linux 原生缺失源执行证据待推送后的 CI，不把结构断言记为原生验证。

#### 四项审查修复（2026-10-15）

基于 PR #12 头部 `5103979` 复现并修复：未知 registry authority 保留共享 temp grant 的 fs/进程绕过；四后端遗漏 deny 祖先覆盖 grant 的反向相交；Windows broker 无法容纳 64 根加 home 与历史超限存量；安装记录写入失败未撤销新增 LSA rights。权限决定见 [ADR-0017 本轮修订](../../decisions/ADR-0017-three-state-root-access-and-sandbox-modes.md#临时区与反向包含修订2026-10-15)，有界 IPC、超预算显式拒绝与安装回滚见 [ADR-0020 本轮修订](../../decisions/ADR-0020-windows-normal-deny-groups.md#协议容量与安装回滚修订2026-10-15)。未发布，版本号与兼容 allowlist 不变。

本机 macOS 开发 pin：compat、lint、双端 typecheck、build、docs:check、pack:check 通过；原生 Seatbelt probe 与含新增回归的完整测试 **668 通过 / 33 平台跳过**；compose **48/48**、behavior **126/126**、journey **62/62**、packed behavior **125/125**，全部冒烟 0 skip。新增 Windows 原生 64/80 根加 home、primary-only 执行，以及真实 LSA/SCM 的三类失败注入随本次 CI 验证；本机不把平台跳过记为 Windows/Linux 原生证据。

#### 祖先改名解除拒写修复与文档/接缝收尾（2026-10-15）

PR #12 评审的又一处 P1：deny 根的祖先目录被改名即可把整棵树搬出 subpath deny（Seatbelt 只检查被操作路径，fs fence 的 deny 集仍记旧 `recordedPath`）。修复钉住每个祖先：Seatbelt deny 形式追加 `(literal A)`（restrict 与 workspace-write covered 根一致），bwrap 把祖先 `--bind A A` 自绑成挂接点使 `rename` 返回 EBUSY（restrict 全量钉扎、workspace-write 只钉可写 bind 目标内的祖先，tmpfs 内与挂载点自身不绑，ro-bind 仍在最后）；Windows deny ACE 随目录对象走，不受影响。代价：受限 Full-access 进程不能 rename/chmod/touch 被拒根与 `$DSH_HOME` 的祖先目录（目录内读写不变）。决定、复现与取舍见 [ADR-0017 本节](../../decisions/ADR-0017-three-state-root-access-and-sandbox-modes.md#祖先目录改名不得解除拒写2026-10-15pr-12-评审-p1)；Linux 侧由 bwrap 原生 CI 用例验证，本机无 Linux。

同批收尾：进程栅栏的入口形状探测收进 `src/compat/process-entrypoints.ts`（shell `execute`/`run`/`start` 与 PTC 公开 `run`，业务代码不再出现版本注释）；Full-access 拓扑在存在拒写根时补「授权变化只对后续操作与新进程生效」句；README/CHANGELOG/指南补齐 B9 三态合同与两条边界说明（Landlock 主机上受限 Full-access 需要 bwrap 否则拒绝启动；持久终端/已运行进程保留启动时 deny 集）。未发布，版本号与 allowlist 不变。

#### Windows 真机验证（2026-10-16）

Windows 实机（非 CI）验证暴露两个 CI 不可见的问题，处置经用户定案，决策细节见 [ADR-0020 本轮修订](../../decisions/ADR-0020-windows-normal-deny-groups.md#过滤令牌放行与打包子进程诊断2026-10-16windows-真机验证)：

- **UAC 过滤令牌被误拒**：`TokenHasRestrictions` 拒绝规则挡住全部非提权 UAC 管理员 runner（`Caller process must be an unrestricted installation identity`）。改判为拒绝 `IsTokenRestricted` 与 `TokenIsAppContainer`、放行 filtered token——minted token 逐位镜像调用方身份，放行不扩权。**升级后需 `install.ps1` 重装 broker**。
- **打包子进程保持 fail-closed，加诊断**：Store/MSIX 版 `pwsh.exe`（别名与包内真实 exe 均验证走打包激活，「直接执行包内 exe」候选证伪）携带包身份，`NtCompareTokens` 必不等。runner 在赋值前用 `GetPackageFullName` 探测，对打包子进程给出指向 MSI/ZIP 版的可操作诊断。

真机验证数字：

- **提权侧**（broker 按当前源码重装，ZIP 版 pwsh 7.6.0 居 PATH 首位）：`windows-native.e2e` **24/24**（含三条新增用例：filtered caller 放行、受限子进程嵌套 deny 集、打包子进程诊断；remint 用例改判为验证 deny-only 组被保留）；smoke:behavior **126/0/0**、smoke:packed **125/0/0**。
- **改动前的提权基线**：compat/lint/typecheck/build/kernel:probe/docs 通过；compose **48/0/0**。`working-directory.e2e`（2 用例）与 journey 的「pwsh saw the other repository's diff」仅在提权下失败（提权创建的目录归 Administrators，git 报 dubious ownership）；非提权下通过：**5/5**、journey **62/0/0**。
- **改动后的非提权侧**：探针矩阵——node `denied:EPERM`、Store 别名 exit 127 且报打包诊断、ZIP pwsh `denied:UnauthorizedAccessException`；smoke:behavior **126/0/0**（先清除上一提权运行留下的 Administrators 属主 `%TEMP%\dsh-multi-root-smoke` 残留后）、smoke:journey **62/0/0**、smoke:packed **104 通过 / 1 跳过**（见残余 2）；`windows-native.e2e` **22/24**，2 个失败均为仅提权可构造的夹具（另一驱动器 `C:\` 根的 ACL 写入、指定外国属主）；完整 `pnpm test` **676 通过 / 2 失败（同两条）/ 46 跳过**；compat/lint/typecheck/docs 通过。
- CI run 38767014622（commit 21369d9，win32 断言修复提交）：**47/47 全绿**。

残余（真机发现，未修改）：

- **属主残余**：runner 的 deny 遍历要求每个路径归调用方所有。提权会话创建的路径属主为 BUILTIN\Administrators，而 filtered token 仅以 deny-only 形式持有该组。此类路径若为只读根或位于 `$DSH_HOME` 内，非提权的受限 Full-access 启动会 fail-closed 报 `deny ACL requires caller-owned path`（安全但不可用，须先修正属主，例如 `icacls <path> /setowner <user> /T`）。
- **pnpm 硬链接残余**：pnpm 把全局 store（`%LOCALAPPDATA%\pnpm\store`）中的包文件硬链接进 `$DSH_HOME` 各 profile 的 `node_modules`，也链进其他项目。硬链接共享同一份安全描述符，因此 `$DSH_HOME` 的 deny 遍历会把常驻 deny ACE 写到 store 文件及其全部链接上。已用 `fsutil hardlink list` 验证：一个仓库文件与 store 及另两个项目共享链接。而 store 文件若是提权安装所建，遍历会 fail-closed（即非提权 `smoke:packed` 的跳过原因：`...\dsh-plugin-multi-root-workspace\CHANGELOG.md` 非调用方所有）。跳过硬链接不安全——文件内容写受文件自身 ACL 约束，跳过的链接会让受限子进程改动 `$DSH_HOME` 内的插件代码。留作用户的开放决策。

未发布，版本号与 allowlist 不变。

## 分支安全审查修复（2026-10-16 起，门禁已执行）

`feat/sandbox-permision-harden` 的分支安全审查（[2026-10-16 审查计划](./2026-10-16-branch-security-review-and-hardlink-isolation.md)）确认 R1–R4 四条发现；修复按计划的三阶段推进，本节记录进度与证据。

### Phase A：统一负授权规则（R2 + R3，已实施）

- **R2 修复**：`widenForScope` 的 read-only 分支在 graft 固定读写根之后同样应用 `denyProfileArgs`——Seatbelt 在 allow 之后追加 deny（last match wins），bwrap 沿用缺失根失败关闭决定使用强制 `--ro-bind`，Landlock 对不可表达的子树减法 fail closed（`SANDBOX_UNAVAILABLE`）；windows-acl 此前已拒绝同一重叠。同步/Promise 形状与上游 `enforcement` / `denialSignatures` / `runnerFailureRules` 不变。
- **R3 修复**：`classifyStoredRoots` 改两遍分类——第一遍逐条独立判定（recorded boundary 绝对性、以其判主根重叠先于 redirect），第二遍对全部结构有效记录的 recorded boundary 两两比较，任一重叠双方判 `membership-conflict` invalid：成员资格 withheld 但 recorded 边界仍作为 deny 发布，结果与展示顺序/重启无关。`registry.add` 改用 `reservedRootBoundary` 收集保留边界（missing、redirected、冲突记录都算），仅按索引豁免精确复活的同一行。结构损坏记录照旧不发布任何投影。
- **本批证据**：`pnpm exec vitest run tests/roots.spec.ts tests/registry.spec.ts tests/missing-deny-root.spec.ts tests/sandbox-multi-root.spec.ts tests/b9-review-regressions.spec.ts` —— 130 通过 / 27 跳过（平台与内核原生用例）；`pnpm typecheck`、`pnpm docs:check` 通过。新增回归：mocked 上游 `confine` 的四方言 read-only 组合（POSIX 形状在 Windows 上亦可跑，sync/Promise 两路）、missing/redirected 子根双向包含拒绝、redirected 保留原边界、legacy 重叠两种顺序均判冲突且 deny 保留、重建缺失只读子根后真实 `MultiRootFileSystem` writeText/edit 拒写且内容不变。
- **明确未做**：Phase B（R1）另行实施见下节；Phase C（R4，硬链接预检 + profile 隔离命令）未开始；完整门禁（compat:check、lint、build、完整 test、kernel:probe、三项 smoke、pack:check、smoke:packed）与 macOS/Linux 原生执行留待实施验收阶段统一运行——mocked 上游的 profile 构造验证不充当 POSIX 内核拒写证据。
- **发布状态**：未发布；版本号、tag 与版本 allowlist 不变。

### Phase B：Windows 祖先路径钉扎（R1，已实施）

- **机制**：`src/compat/windows-path-guard.ts` 经公开 `extendWin32ProcessBindings` 接缝绑定 CreateFileW 等原语，为每个 deny 根钉住从卷根到根本身的去重祖先链——每个目录持有 GENERIC_READ + 读/写共享（不含 delete sharing）的常驻句柄，实机探测否决了 FILE_READ_ATTRIBUTES 属性级句柄（不参与删除共享门）。同句柄校验目录属性、非重解析点、`HANDLE_FLAG_INHERIT` 清零、内核最终 DOS 拼写一致；任一环失败逆序释放并拒绝启动，不写任何祖先链持久 ACL。
- **runner 集成**：`runWindowsDenied` 在 token 请求与 ACL 编辑之前获取钉住；`closeSync(7)` 与 `waitForProcessExit` 包入子进程 try 后，先 `terminateWindowsJobAndWait`（TerminateJobObject + ActiveProcesses 轮询至零，无超时）排空 Job 再关句柄，钉住在全部资源清理中最后释放。runner 被强制终止为异常边界——句柄随进程消亡、后代由 kill-on-close 兜底。
- **本批证据**：`pnpm exec vitest run tests/windows-native-adapter.spec.ts` —— 26 通过（新增 mocked Job 排空：先 terminate 再轮询至 ActiveProcesses=0、Sleep(10) 间隔、Win32 失败不透传）；`pnpm exec vitest run tests/windows-native.e2e.ts -t "ancestor guard|preserves ConPTY output and the control descriptor"` —— 5 通过：真实受限子进程 rename deny 根父/祖父目录均拒绝、ambient 写仍可用，宿主 `MultiRootFileSystem` 对原拼写 writeText/editText 仍 `FS_SANDBOX_DENIED` 且内容不变；退出子进程的 Job 后代被排空（pid 死亡先于钉住释放、逃逸标记未写出）；ConPTY terminate 后钉住释放且无存活进程；祖先被 DELETE 独占句柄预占时发布版 runner 在 spawn 前 127 拒绝；ConPTY 输出与 fd 7 控制描述符回归不变。原型组「deny path guard」4 通过 / 1 跳过（本机无第二可写固定盘，第二驱动器钉扎未验证）。`pnpm build`、`pnpm typecheck`、`pnpm lint`、`pnpm docs:check` 通过。
- **明确未做**：Phase C（R4，硬链接预检 + profile 隔离）未开始；完整门禁与 macOS/Linux 原生执行仍留待实施验收阶段。
- **发布状态**：未发布；版本号、tag 与版本 allowlist 不变。

### Phase C1：Windows 全根硬链接预检（R4，已实施）

- **机制**：`src/compat/windows-deny-preflight.ts` 在祖先钉住之后、任何 token 请求 / ACL 编辑 / 锁工作之前，对全部 deny 根做只读递归预检——FILE_READ_ATTRIBUTES + 全共享打开、`GetFileInformationByHandle` 读身份、`GetFileType` 要求普通文件为磁盘类型，每个检查句柄在下行前关闭；任一打开 / 类型 / 身份 / 目录列出失败（含句柄关闭失败，聚合保留原始错误）都使启动在零副作用点拒绝并报出根与路径。任一普通文件 `links > 1` 一律拒绝：快照无法证明链接拓扑，保守不试图证明——不跳过 `node_modules`，不做全局重置。诊断区分「protected DSH home」（指向挂起的 `/workspace-folders isolate-profiles`）与登记根（建立独立副本）。
- **写侧收紧**：ACL 遍历消费快照（深度优先序），目录继承与否由快照属性决定；写目录继承 ACE 前比对即时 `readdir` 名单与快照名单；`protect` 在即将写 ACL 的活句柄上 `verifyHandle` 复核属性位 / 卷序列 / 文件索引 / link 计数；根父目录守卫（树外、无快照）是唯一豁免 `verifyContent` 的调用且不启用 OICI。非事务性如实记录：复核到写之间的恶意并发外部修改仍可能竞过，零副作用只承诺到预检失败点。
- **标签透传**：`--protected-home` 只做诊断标签——`scope.protectedHome` 经 `restrictedExecution` / `restrictedArgvPrefix` 第四可选参、`restrictWindowsProfile`、runner 契约解析（仅 standalone `danger-full-access`、须为 deny 根成员）传到 `runWindowsDenied`，不改变任何授权。
- **本批证据**：`pnpm exec vitest run tests/windows-native-adapter.spec.ts tests/windows-multi-root.spec.ts tests/process-fence.spec.ts` —— 73 通过（新增 7 项 mocked 预检用例：快照序 / 句柄协议 / 硬链接与 home 标签 / 重解析不下降 / 打开·读·列出·关闭失败与聚合 / verifyHandle 身份与 link 复核；parser 标签校验与 fence 标签转发）；`pnpm exec vitest run tests/windows-native.e2e.ts -t "hardlink preflight|ancestor guard"` —— 11 通过：深层硬链接、末根硬链接首根零变化、同树双名、protected home 标签拒绝、不可读文件拒绝、junction 目标未扫描未改写、独立副本成功且外部原件不变——SDDL 前后快照逐字节比对，全部失败都在任何 ACL 副作用之前 127 退出且子进程哨兵未创建。`pnpm build` 通过。
- **明确未做**：C2——`/workspace-folders isolate-profiles` 命令、profile 迁移与硬链接冒烟夹具未实施；完整门禁与 macOS/Linux 原生执行仍留待实施验收阶段。
- **发布状态**：未发布；版本号、tag 与版本 allowlist 不变。

### Phase C2：profile 硬链接隔离命令与冒烟夹具（R4，已实施）

- **命令与检查**：`/workspace-folders isolate-profiles` 落地为宿主侧维护命令（面板无端点），默认只读检查、`--apply` 迁移。`src/profile-isolation.ts` 只认 `profiles/` 下 `package.json` 可解析且 `dsh.profile` 为对象的真实目录；整 home 递归扫描统计目录 / 文件 / `nlink>1` 与不可检查项，任一不可读子树报 incomplete 不报干净；home 本身是重解析点即拒绝检查，profile 内重解析点只计数不下降。
- **保守 YAML 迁移**：不引入 yaml 运行期依赖——`parseWorkspaceYamlKeys` 是严格子集扫描器，拒绝缩进 tab、指令 / 文档标记、重复顶层键、非 `key:` 顶层行及 `&` `*` `!` `|` `>` `{` `[` 起始的复杂值；缺失文件用上游 `initProfile` 同款模板补 `packageImportMethod: copy`，标量值按原始 span 原地替换（注释、引号与 CRLF/LF 保留），其余一律 refused。写入走 `<file>.mrw-<pid>.tmp` + rename 原子就位，重解析点目标拒绝写穿；`cordis.patch.yml` 的 `multi-root-command` 行新增 `dshHome` 配置。
- **诊断与 remediation**：预检文案移除「pending」措辞，指向现已存在的命令；`--apply` 报告逐 profile 的 written / replaced / noop / refused，并在仍有多链接文件时给出 PowerShell 安全引用（`& 'path' -Verb RunAs` 风格单引号转义）的退出宿主 → 删 `node_modules` → 按 lockfile 重装步骤。copy 不隔离既有硬链接、不修复 Administrators 属主、不撤销历史 store ACE——三条边界在命令输出、ADR 与指南中一致声明。
- **冒烟夹具**：`scripts/lib/dsh-runtime.mjs` 新增 `ensureProfileCopyImport`，`installPluginProfile` 在首个 `dsh plugin add` 前落 copy 配置，journey / compose / behavior / packed 冒烟 profile 全覆盖（正向）；`smoke-behavior` 另建保持默认硬链接的 scratch profile，用真实 runner `--deny-root <home> --protected-home <home>` 断言 127 + 硬链接拒绝文案 + 子进程未运行（负向，不与正向夹具共享 home）。
- **本批证据**：`pnpm exec vitest run tests/patch.spec.ts tests/profile-isolation.spec.ts tests/command.spec.ts` —— 80 项执行，79 通过 / 1 跳过（新增 23 项隔离套件：YAML 子集接受/拒绝面、span 精确替换、确认 profile 过滤、重解析边界、整 home 多链接统计、incomplete 结论、模板创建 / 追加 / 替换 / noop / 拒绝矩阵、原子写失败、PowerShell 引用；命令解析、帮助、hint 与 handler 集成；patch `dshHome` 断言）。`pnpm run build:types`、`pnpm run bundle`、`pnpm typecheck`、`pnpm lint`、`pnpm docs:check` 通过。本机另以与冒烟负向相同的夹具形状实跑发布版 `lib/windows-runner.js`（scratch home + profile 内指向 home 外「store」文件的真实 `linkSync` 硬链接，`--deny-root <home> --protected-home <home>`）：退出 127，stderr 为 `windows-acl-run: hardlinked file inside the protected DSH home … has links=2; … run \`/workspace-folders isolate-profiles\` …`，子进程哨兵未创建——零副作用拒绝、文案指向 C2 命令，本机非提权会话实机验证。
- **明确未做 / defer**：非提权 CI lane 未新增——GitHub Actions `windows-latest` 全程提权，非提权进程需第二账户或计划任务，超出本批范围；预检拒绝本身发生在 token / broker 之前，非提权环境可本地回归（冒烟负向即此路径）。完整门禁（compat:check、完整 test、kernel:probe、三项 smoke 实跑、pack:check、smoke:packed）与 macOS/Linux 原生执行仍留待实施验收阶段。
- **发布状态**：未发布；版本号、tag 与版本 allowlist 不变。

### 实施验收（2026-10-17，门禁执行完毕）

- **套件与类型**：`pnpm typecheck`、`pnpm lint`（0 警告 / 0 错误）、`pnpm run build:types`、`pnpm run bundle`、`pnpm docs:check`、`pnpm compat:check`、`pnpm pack:check`（109 个打包成员）全部通过。完整 `pnpm test` 串行执行（`pnpm pack` 的 `prepare` 会清空重建 `lib/`，与测试并发会产生假象，不可并行）：49 个文件、771 通过 / 49 跳过 / 0 失败；其中 `windows-native.e2e.ts` 38 通过 / 2 跳过。
- **冒烟实跑**：`smoke:compose` 48 通过；`smoke:behavior` 112 通过 / 1 跳过；`smoke:journey` 62 通过；`smoke:packed` 111 通过 / 1 跳过。唯一跳过原因一致：本机 `pwsh.exe` 是 MSIX 商店版，受限 token 拒绝 packaged 子进程——上游既定限制，非本批缺陷。
- **内核探针**：`pnpm kernel:probe`——windows-acl 可用；seatbelt / bwrap / Landlock 本机不存在，POSIX 原生执行仍未验证（mocked profile 构造验证不充当内核拒写证据）。
- **验收期修复（测试/冒烟基础设施，非产品代码）**：`tests/windows-native.e2e.ts` 的 `secondDrive()` 盘符比较既有缺陷——`'C:\'` 与 `'C:'` 比较恒不等，单盘机把 C: 当作不同盘在卷根跑 xdrive 用例，撞上游 `grantWrite` 写 mandatory label 的 WRITE_OWNER 需求；归一化后本机如实跳过（CI 的 `D:` 仍会真跑）。`sddlOf` 改用 `icacls /save` 替代 `powershell Get-Acl`——本机混合 PowerShell 5.1/7 `PSModulePath` 与共享 ModuleAnalysisCache 使 spawn 的 `powershell.exe -NoProfile` 间歇性模块加载失败，属宿主环境抖动。`scripts/smoke-behavior.mjs` 清理识别进程内映射的 `.node` addon：packed 模式下 `boot()` 从 scratch profile `dlopen` `koffi.node`，映射期间所有者进程自身无法删除——残留仅当全部由映射 addon 解释（每个失败文件是 `.node`、每个失败目录是其祖先）且注入了 `DSH_SMOKE_HOME` 时移交父进程在子进程退出后删除；独立运行的严格清理语义不变。
- **复审修复（推送前）**：`isolate-profiles --apply` 两处复审发现已修——整体缩进的顶层 YAML 一律 refused（原先误判 `packageImportMethod` absent 并追加零缩进键，使合法文件失效）；临时文件改 `wx` 独占创建，既有文件 / 硬链接 / 符号链接不再被写穿或删除，仅清理本进程创建的临时文件。新增 4 项回归；修复后完整套件 49 文件 775 通过 / 49 跳过 / 0 失败，冒烟四项、`pack:check`、`docs:check` 重跑全绿。
- **边界如实记录**：macOS / Linux 内核原生执行本机不可用；xdrive 第二可写盘路径本机跳过（无第二固定盘）；非提权 CI lane 按 C2 节 defer。
- **发布状态**：未发布；版本号、tag 与版本 allowlist 不变。

### PR #12 复核与 Windows packed smoke 清理修复（2026-10-17）

- **旧审查逐项复核**：PR 四条意见均有对应修复及回归——缺失 deny 根使用强制 bwrap mount（`tests/missing-deny-root.spec.ts`）；broker 授权、记录落盘及启动共用回滚路径（诊断脚本真实注入 `Set-Content` / `Move-Item` / `Start-Service` 三类失败）；shell 入口探测集中在 `src/compat/process-entrypoints.ts`；中英文 README 与 Unreleased changelog 已说明 inherit 默认值及三态。R1–R4 的实现与测试亦复核；补齐 changelog 中仍称 Windows 仅靠对象 ACL 随改名移动的过时表述，并补记负授权与硬链接隔离行为，决定仍由 ADR-0017 / ADR-0020 维护。
- **远端基线证据**：`ba704b7` 的 [CI run 38937909169](https://github.com/cherrchen/dsh-plugin-multi-root-workspace/actions/runs/38937909169) 共 44 条平台/版本 verify 车道及最终 gate 全绿；[diag run 38937909410](https://github.com/cherrchen/dsh-plugin-multi-root-workspace/actions/runs/38937909410) 验证真实 broker 生命周期与三类授权后失败回滚。此处是旧提交证据，不替代本次修复的验收。
- **阻塞证据**：Windows `0.1.6-alpha.1` job `117098022247` 在北京时间 01:18:09 已打印 packed battery **132/0/0**，03:15:48 才移交清理；11 条 Windows 版本车道的 Packed smoke 均约 118–119 分钟。锁定文件为子进程加载的安装副本 `koffi.node`，旧 `rmSync(maxRetries: 10, retryDelay: 500)` 在递归祖先层层重试，等待无法在本进程退出前解除的模块映射。
- **修复与回归**：清理所有权和有界重试规则写入[开发工作流](../../development/plugin-development-workflow.md#ci)。新增真实 `.node` 加载的深层目录子进程回归（移交后退出、父进程严格删除、独立清理持久锁必须及时失败），以及普通目录、外部 junction 不跟随、显式移交和 CI 超时门禁回归；不靠扩展名豁免清理，不跳过行为断言。
- **本地执行**：Windows 非提权会话，开发 pin `0.2.1-alpha.2`、Node `24.14.0`；内核探针 windows-acl 可用。完整套件 **50 文件、781 通过 / 49 条件跳过 / 0 失败**，含新增回归；lint、双端 typecheck、build、compat:check 通过。compose **48/0/0**、behavior **133/0/0**、journey **62/0/0**、packed behavior **132/0/0**，pack:check **109 成员完整**；packed 含打包/安装/严格清理耗时 **50.04 秒**，四项冒烟加打包检查共 **101.99 秒**，无残留。docs:check 通过。
- **修复提交远端执行**：`033bbe6` 的 [CI run 39022484207](https://github.com/cherrchen/dsh-plugin-multi-root-workspace/actions/runs/39022484207) **44 条 verify 车道及最终 gate 全部 success**（含 releases 共 46 jobs）；11 条 Windows packed smoke 分别为 **31–67 秒**，不再等待模块映射解除。相同提交的 [diag run 39022484171](https://github.com/cherrchen/dsh-plugin-multi-root-workspace/actions/runs/39022484171) 同样 success，真实 Windows ACL 与 broker 生命周期通过。当前复核未发现新的合并阻断项；非提权 CI lane 与 Windows partial / 并发外部修改边界仍按既有决定记录，未扩大安全承诺。未合并、未发布。

## DSH 0.2.1 后续兼容提升（2026-10-17）

用户授权范围是 `dsh-v0.2.1-alpha.3` 至 `dsh-v0.2.1-rc.2` 的五个发布版本。上游本地 tag 与 npm `versions` 列表一致，逐 tag 与 `0.2.1-alpha.2` 做源码差分。支持合同保留全部旧版，再纳入这五个精确版本；开发 pin 与 lockfile 升到 `0.2.1-rc.2`，cordis 是 `4.0.5`。插件版本号不变（`0.1.6`），不创建 release tag。

| 上游 tag | commit |
|---|---|
| `dsh-v0.2.1-alpha.3` | `2fbf4359b82fb94c03dcce0b831660d87f12ea5c` |
| `dsh-v0.2.1-alpha.4` | `86a402200d95fecef4529d969836f1fe13c6cb0d` |
| `dsh-v0.2.1-alpha.5` | `1517a4dbca0a2789ff1d41ba439600f8547d23fa` |
| `dsh-v0.2.1-rc.1` | `1600d8a1e140dcde43a1a0941940a0480712c011` |
| `dsh-v0.2.1-rc.2` | `687f282e8625c6b8d11ff58211a90524be2e4317` |

#### 接口变更与风险

| 接缝 | 上游变化与影响 | 本次处理与证据 |
|---|---|---|
| registry storage / zod | `alpha.3` 起 `dsh-storage-domain` 把 `zod` 依赖从 `^4.4.3` 钉死为 `4.4.3`；本插件自身的 `^4.6.2` 解析成另一副本，`domainTable` 声明的 `ZodType` 与插件侧 schema 类型互不兼容（运行时仅调 `.parse`/`.safeParse`，是类型缝而非行为缝） | 新增 `src/compat/storage-zod.ts`：经 `createRequire` 从 `dsh-storage-domain` 自身解析路径取 zod 构建域 schema，值与声明同源，任何支持版本都成立；不 pin 本包 zod、不加 overrides、不做版本串分支。宿主/客户端 typecheck 与全部测试通过 |
| 插件安装门禁 | `alpha.4` 起 plugin-manager 优先读 `engines.dsh`，缺失时回退 `peerDependencies` 的 `@deepseek-ai/dsh*` 条目；本插件仍以 peers 为唯一版本契约 | peers 精确枚举 16 个版本；warn 车道在首个 `plugin add` 前授予精确 `allow-version` 豁免（覆盖 remove/add 激活回退路径），保留反应式回退，enforce 模式不依赖豁免 |
| cordis | `alpha.3`–`alpha.5` 依赖 `~4.0.5-alpha.2`；`rc.1`/`rc.2` 依赖 `~4.0.5`（解析为 `4.0.5`） | `cordis-pin.mjs`/`upgrade-dsh.mjs` 按候选版本分派；peer 声明补 `|| 4.0.5-alpha.2`（`4.0.5` 已在 `>=4.0.1 <5.0.0` 内），开发 pin `4.0.5` |
| fork 客户端文件 | `alpha.2`→`rc.2` 的 `src/client/` 子树逐字节零改动（含 files-tree 与 open-in-app 上游源）；locales 仅新增 market meta 键，与 fork 的 `SidebarFilesKey` 无关 | 按 FORK.md 核对后仅前移 revision 基线至 `687f282e86`，不重新拷贝 |
| Connection RPC / session / workingDirectory / LSP / workspaceFiles | `rpc.call` 签名不变；handler 新增第 4 个可选 `peer` 参数向后兼容；`sessions.list` 快照、`retainedBy.mainView`、working-directory 服务键与 LSP stdio 池形状均未变 | 不新增适配分支；行为/旅程冒烟在真实 profile 上验证 |
| `read` 等工具提示文案 | `dsh-tools` 个别工具 description 微调，事件名与 schema 未变 | 本插件不钉文案快照，无影响 |

#### 候选车道与验收

每个候选版本走完整 upgrade lane（`upgrade-dsh.mjs` repoint + 重装 + `DSH_MULTI_ROOT_COMPAT=warn pnpm verify:all`），cordis pin 按版本分派。本地宿主为 macOS：`pnpm kernel:probe` 实测 Seatbelt 可执行并作为必跑断言（`DSH_PROBE_VERIFIED_DIALECTS=seatbelt`）；bwrap / Landlock 本机不存在，Linux/Windows 原生证据由远端 CI 承担，不得把本地 skip 记为通过。

| 运行时 | 单测 | compose | behavior | journey | packed behavior | 结果 |
|---|---|---|---|---|---|---|
| `0.2.1-alpha.3` | 766 passed / 64 skipped | 48 | 126 | 62 | 125 | 通过 |
| `0.2.1-alpha.4` | 766 passed / 64 skipped | 48 | 126 | 62 | 125 | 通过 |
| `0.2.1-alpha.5` | 766 passed / 64 skipped | 48 | 126 | 62 | 125 | 通过 |
| `0.2.1-rc.1` | 766 passed / 64 skipped | 48 | 126 | 62 | 125 | 通过 |
| `0.2.1-rc.2` | 766 passed / 64 skipped | 48 | 126 | 62 | 125 | 通过 |

候选期间修复两处接缝（见上）：storage-zod 适配消除 zod 双副本类型不兼容；`installPluginProfile` 的 warn 预授权修复「构建审批中断后的 remove/add 激活路径撞上版本门禁」——该路径曾把插件装为依赖但未激活，行为断言以 `setAdditionalRoots` 空指针暴露，现已修复并有 rc.2 完整 packed battery 复验。

#### 正式提升

`SUPPORTED_DSH_RELEASES` 扩至 16 个精确版本；20 个 `@deepseek-ai/dsh-*` peer 同步枚举；cordis peer 补 `4.0.5-alpha.2`；开发 pin `0.2.1-rc.2`、cordis `4.0.5`；release-age 精确豁免重写为 rc.2 集合；probe overrides 与 `minimumReleaseAge: 0` 不落入提交。提升后 enforce 验收（`0.2.1-rc.2` / cordis `4.0.5` 开发树，本机 macOS）：`pnpm compat:check` 四方一致；`pnpm verify:all` 全绿——lint、双端 typecheck、build、`kernel:probe`（Seatbelt 实测可执行，bwrap / Landlock 本机不存在）、test **49 文件 766 passed / 64 skipped**、compose **48/0/0**、behavior **126/0/0**、journey **62/0/0**、pack:check **110 成员**、packed behavior **125/0/0**（enforce 下无豁免，peers 精确覆盖 rc.2 直接通过版本门禁）；`pnpm docs:check` 通过。远端 16 版本 × OS 矩阵由本分支 PR 的 CI 车道执行，未完成前不记为通过。

远端矩阵已完成：PR #13（head `40ff7dd`）的 [CI run 39029762518](https://github.com/cherrchen/dsh-plugin-multi-root-workspace/actions/runs/39029762518) **66/66 jobs 全部 success**（16 版本 × 4 OS verify 车道 + releases + gate），随后合入 `main`（`eaf2d8f`）。本批次与第二期 B 系列、Files 页签浏览一并随 `v0.1.7` 发版。

## DSH 0.2.0 `permissionPresets/catalog` 修复（2026-10-18，随 `v0.1.8` 发版）

用户报告：插件在 DSH `0.2.0`（宿主实际组合 `0.2.0-rc.2`）上把权限设置页拖死——`gateway/service-unavailable: permissionPresets/catalog: active Service "permissionPresets" is unavailable`。以 `dsh-app-boot@0.2.0-rc.2` 进程内复现基线（无插件正常）与含插件组合，还原出「检测误报 × 爆炸半径」双因：

1. **误报**：`classifyInstallation()` 对所有 optional 包一视同仁。`link:` 安装下 `dsh-lsp` / `dsh-lsp-stdio` / `dsh-working-directory` 从插件锚点解析到仓库自身 devDependencies（`0.2.1-rc.2`），版本统一的宿主被判 `mixed`。修法：`OPTIONAL_CORE_PACKAGES` 按"谁加载副本、经哪个锚点"拆为三类：`RUNTIME_OPTIONAL_PACKAGES`（插件动态 import，私有副本真会执行）、`HOST_SERVICE_PACKAGES`（只作宿主挂载服务/类型，插件根内命中计为缺席，宿主锚点回退受同一根边界约束）与 `RUNNER_ANCHORED_PACKAGES`（`dsh-sandbox-windows-acl` 由独立 runner 经上游 runner 自引用加载，只从 `dsh-sandbox-local` 锚点取证——Codex 评审 P2 指出，归 host-service 会让未受检 ABI 被判缺席）。
2. **爆炸半径**：上游 `fs-sandbox`/`sandbox` 被 patch 无条件禁用，而替身 provider 又 inject `multiRootCompat`；门禁一倒 `ctx.fs`/`ctx.sandbox` 消失 → `ctx.shell` → `permissionPresets` 全瘫。修法：两个 provider 行不 inject 门禁——放宽由 scope 驱动、被门禁的 registry 不可能在被拒安装上填充 scope，provider 空 scope 即上游等价。宽授权行（providers/registry/instructions/lsp/workspace-files/process-fence）门禁不变，`mixed`/`incomplete` 依旧 fail-closed。

落点：`src/compat/dsh-version.ts`、`src/fs.ts`、`src/sandbox.ts`、`src/compat.ts`、`cordis.patch.yml`、`scripts/check-dsh-compat.mjs`、`src/index.ts`、`tests/compat.spec.ts`；文档：ADR-0009 修订节（2026-10-18）、故障排查条目退化形态更正、`.agent/note/dsh-compat-contract.{md,en.md}` §2/§10、AGENTS.md 不变量 #7。同期观测的 `job/registered` 未知事件报错经查证为 0.2.1 线 harness 写入的 session 日志被 0.2.0 reader 读取，与本插件无关。

## Auto Review 多根上下文适配（2026-10-18）

工作分支 `feat/compat-auto-review` 从 `main` 的 `15c1d26` 创建，保留了调研、计划及导航的未提交修改。上游核对为 `dsh-v0.2.1-rc.2` / `687f282e8625c6b8d11ff58211a90524be2e4317`，没有编辑上游源码、安装包或检出其旧构建产物。实现设计和维护边界见 [ADR-0021](../../decisions/ADR-0021-auto-review-context-companion.md)，阶段范围见[已归档计划](../completed/2026-10-18-auto-review-context-adaptation.md)。本节工作完成时主包版本仍为 `0.1.8`，未创建 tag；独立 companion 从未发布——其交付形态随后被 [ADR-0022](../../decisions/ADR-0022-auto-review-loader-entry.md) 取代，同一能力并入主包内置行随 `v0.1.9` 发版（见下节）。普通支持 allowlist、provider 门禁例外与默认 Auto 行为不变。

### 装配与请求证据

Phase 0 先在隔离 profile 中验证官方 Auto Review / Multi-root 两种顺序：web 和 headless 均启动，fs/sandbox、Registry 和官方 Auto 可用。确认 Loader 的 id patch 只能作用于此前的 insert 后，采用显式 enable 顺序校验，不依赖碰撞或静默 patch 跳过。headless 装配探针禁用 launcher，避免自动发起无关任务；原有 headless journey 仍实跑。

`pnpm smoke:auto-review` 的 source/link 腿运行 web/headless × 两种顺序，共四组；packed 腿把主包和 companion **分别打包并实际安装**，运行 web/headless 两组。每组依次验证：普通安装不发布 Auto 或 context → 官方 owner → 安装 companion、执行安装副本的 enable CLI → 单一兼容 owner → 捕获两次真实 reviewer 请求 → 固定 allow 对可写根写入成功、对只读根拒写且原字节不变 → live disable 迁移存活 Auto 到 Full access 并恢复官方 → live re-enable 仍只有一个 owner且不自动重选 Auto → 重启恢复 → 实际移除 companion 包保留官方选择。总计 **6 组 / 12 次工具调用 / 12 次 reviewer 请求**；两包 packed 结构检查含入口、声明、bin、双语 README、MIT 和 FORK 文档。

### 本机完整门禁

执行环境为 macOS arm64 / Node 24，运行的是本仓库锁定的发布包，不是上游 checkout 的 node_modules。`pnpm compat:check` 四方一致；`DSH_PROBE_VERIFIED_DIALECTS=seatbelt pnpm verify:all`（本机为避免 pnpm 的依赖自检误触发重装，使用 `--config.verifyDepsBeforeRun=false`，不改变门禁内容）退出 0：

| 门禁 | 结果 |
|---|---|
| lint / 双端 typecheck / 主包与独立 companion build | 通过 |
| kernel probe | Seatbelt 可执行；bwrap 不存在；Landlock launcher 不存在 |
| test | **55 文件：54 passed / 1 skipped；828 passed / 64 skipped** |
| 官方 fork 行为回归 | 31 用例通过；覆盖 native/PTC 身份、风险协议、human/parent/constraint/checkpoint/fact、ask/never、下游 gate、取消和卸载 |
| 联合 context / fs / PTC | 17 用例通过；真实主根/cwd、三态注册、nested/首次目标/最终 file symlink、resume、更新/删除/撤销/redirect、authority、预算/故障、有界 stream 关闭、人工批准后复核、嵌套/并发 cap；不读取普通目标正文 |
| native instruction overlap | 6 用例通过；当前 baseline、纯附加帧替换、mixed 帧去重/失败、未登记 cwd 的 native 约束保留 |
| compose / behavior / journey | **48 / 126 / 62** passed，均 0 failed / 0 skipped |
| pack:check / packed behavior | **115 成员 / 125** passed，packed behavior 0 failed / 0 skipped |
| auto-review:fork / smoke:auto-review | 基线与允许差异通过；上述 source 与 packed 六组通过 |
| docs:check / git diff --check | 通过 |

Seatbelt 证明的断言强制实跑。PTC 联合用例用真实 Node runtime 与 SDK bridge：外层 run_code 不审查，内层 write 每次恰好一次；继承外层 run_code 的 cap；子进程直接 `node:fs` 覆写只读文件也被内核拒绝，原内容不变。人工批准同样不能解除 fs 围栏。成功路径与失败路径的 main Agent delivery bookkeeping 分离，审查发现没有伪造成功 touch。

### 旧版普通插件回归

使用仓库内隔离副本，经既有 upgrade 工具逐版本安装，不切换或回退主工作区。probe 已排除不匹配联合合同的独立 companion 项目，避免全局 overrides 误重指该 fork 的开发依赖；没有放宽普通插件 allowlist。每个已支持旧版运行 `compat:check`、双端 typecheck、build，以及 scope、instructions、tool-access、compat、optional peers、working-directory、durable activity 和 preview 差分八组回归。最终结果在下表记录。

| 运行时（现有 allowlist 中的精确条目） | 共享回归 | 类型 / 构建 / compat |
|---|---|---|
| `0.1.5-rc.2` 至 `0.2.1-alpha.1` 的 10 项 | 每项 131 passed / 7 skipped | 通过 |
| `0.2.1-alpha.2` 至 `0.2.1-rc.1` 的 5 项 | 每项 137 passed / 1 skipped | 通过 |

其中旧宿主缺失 workingDirectory/worktree 的用例按能力明确跳过，剩余 skip 属现有平台/能力条件；不记为原生通过。`0.2.0-rc.2` 还实跑原有完整普通插件路径：compose **48**、behavior **126**、journey **62**、packed behavior **125** 全过，pack:check 通过，确认可选新入口没有重现 `permissionPresets/catalog` 故障。旧版未启用、也不宣称联合 Auto Review 兼容。

### 未覆盖与维护边界

本批没有在 Linux bwrap/Landlock 或 Windows ACL/broker/pwsh/ConPTY 主机上原生执行；相关原有测试按本机平台跳过，已把新增联合 gate 接入现有 OS 矩阵，但没有把尚未运行的远端 CI 写成通过。真实模型语义质量未认证：脚本化 allow 只证明请求来源与内容、单一 owner及执行围栏独立，不能证明误拒绝/误放行率。Phase 3 普通目标源码自动读取未实施。

当前 mixed native 帧若含已失效附加指令，公开接口无法无损拆出其中的 global/primary 正文，本次 review 明确失败；需要重建 producer baseline，必要时用新 Session。指令/根/authority 在等待期间变化同样失败，不沿用旧 allow。已经启动的进程保留旧 kernel snapshot，多次复核不声称消除任意敌对文件系统 TOCTOU。fork 只维护精确基线；正式上下文 API 足够后删除 fork 的迁移合同见 ADR-0021 与 FORK.md。

### 远端 CI 首轮失败与修复

分支首 head `40ec946` 的 [CI run 39130958098](https://github.com/cherrchen/dsh-plugin-multi-root-workspace/actions/runs/39130958098)：releases 及全部 Linux/macOS verify 成功，**16 个 Windows verify job 全部失败**，gate 随之失败。三类失败均由本批 Windows 首跑暴露：

| 失败面 | 原因 | 修复 |
|---|---|---|
| `0.1.5-rc.2` 至 `0.2.1-alpha.1` 共 10 个 lane 的 install：`@deepseek-ai/dsh-working-directory@<旧版>` 不存在（该包自 `0.2.1-alpha.2` 才发布） | Windows 检出为 CRLF，`upgrade-dsh.mjs` 按字面 `\n` 删不掉 `packages:` 中的 `compat/auto-review` 行，companion 仍留在 workspace（日志 `Scope: all 2 workspace projects`），probe overrides 将其 devDependency 一并重指到不存在的旧版 | `.gitattributes` 增加 `* text=auto eol=lf` 统一 LF 检出；脚本的两处 `packages:` 行编辑同时容忍 `\r?\n` 作防御纵深 |
| `0.2.1-alpha.2` 至 `0.2.1-rc.1` 共 5 个 lane 的 `auto-review:fork`：`upstream baseline drift` | 同一 CRLF 检出；`check-auto-review-fork.mjs` 对 `upstream.ts` 原始字节计算 sha256 | 同上 `.gitattributes`；这些 lane 顺带验证了 companion 在场但被排除时普通插件门禁全绿 |
| `0.2.1-rc.2` lane 单测：`reviews real PTC inner fs calls …` 的 worker `Cannot find module` | 联合用例经 `src/sandbox.ts` 挂载 provider，`import.meta.url` 落在 `src/`，widen/restrict 产出的 `src/windows-runner.js` 不存在——与 2026-10-03 Windows 修复记录（PR #7）是同一陷阱 | win32 下该用例改从 `lib/sandbox.js` 挂载 provider，沿用 `tests/windows-multi-root.spec.ts` 的既定选择 |

非 joint 版本本就没有上游 Auto Review：companion 由 upgrade 脚本从 `packages:` 摘除（joint 仅 `0.2.1-rc.2`），`vitest.config.ts`、`build-auto-review.mjs`、`smoke-auto-review.mjs` 也只在精确 pin 下启用；本次修复恢复的是这条既定语义——旧版上该功能视为不存在，不安装、不构建、不验证。远端复验以下一次 CI run 为准，在此之前不把 Windows lane 记为通过。

`87fd7aa` 的 [CI run 39136285430](https://github.com/cherrchen/dsh-plugin-multi-root-workspace/actions/runs/39136285430)：三类修复全部生效——`0.1.5-rc.2` 等老版本 Windows install、fork 基线哈希、`0.2.1-rc.2` 联合单测均通过；但同一 lane 的 joint 冒烟暴露第四类失败：companion 启用后 `lib/index.js` 仍引用 `./compat/contract.ts`（`ERR_MODULE_NOT_FOUND …\lib\compat\contract.ts`）。原因是 `build-auto-review.mjs` 的 `neverBundle` 用「不以 `.`/`/` 开头」判定外部依赖，而 rolldown 会用**解析后绝对路径**再次调该谓词——macOS/Linux 的 `/Volumes/…` 以 `/` 开头被正确内联，Windows 的 `D:\…`/`D:/…` 被误判为外部依赖并原样保留 `.ts` specifier。修复改为与 `tsdown.config.ts` 相同的契约：按 companion manifest（dependencies + peerDependencies）枚举外部包名，任何解析形态都不会误伤自有源码；并在构建后断言 `lib/index.js` 不再残留相对导入（单文件产物的既定契约），把这类缺陷挡在本地而非依赖远端冒烟。

`ef6a26c` 的 [CI run 39137744875](https://github.com/cherrchen/dsh-plugin-multi-root-workspace/actions/runs/39137744875)：bundle 修复生效，companion 在 Windows 成功导入激活（不再出现 `did not activate`）；冒烟推进到 reviewer 请求断言后暴露第五类失败——`auto-review-battery.mjs` 用 `text.includes(primary)` 匹配 reviewer 文本中的根路径，但该文本经 `JSON.stringify` 渲染，Windows 路径 `D:\…` 被转义为 `D:\\…`（canonical 根另有 `\\?\` 前缀），POSIX 的 `/` 无转义问题故仅 Windows 失败。断言改为按 JSON 转义拼写匹配（去引号后仍为 `\\?\` canonical 形式的子串），产品代码不动。

`15637f8` 的 [CI run 39138769855](https://github.com/cherrchen/dsh-plugin-multi-root-workspace/actions/runs/39138769855)：路径断言修复生效，四种组合的完整 battery（装/启/审/停/卸）在 Windows 全部通过；冒烟推进到收尾清理时暴露第六类失败——packed 子进程从安装副本 `dlopen` `koffi.node`（`profiles/<name>/node_modules/@koromix/…/koffi.node`），进程内映射期间 `rmSync` unlink 报 `EPERM`——与 2026-10-17 记录的 smoke-behavior 缺陷同源，只是当时 joint 冒烟在更早的断言处已挂、从未走到清理。修复沿用既定契约：`smoke-auto-review.mjs` 收到 `DSH_SMOKE_DEFER_HOME_CLEANUP` 时把 home 清理移交父进程，`verify-auto-review.mjs` 为每个子进程注入 `DSH_SMOKE_HOME` 并在子进程关闭后以 `removeScratchTree`（有界重试）删除根目录；独立运行保持严格清理语义不变。

`df79b35` 的 [CI run 39139931861](https://github.com/cherrchen/dsh-plugin-multi-root-workspace/actions/runs/39139931861)：**66/66 jobs 全部 success**——releases、16 版本 × 4 OS 共 64 条 verify 车道及最终 gate。四轮 Windows 修复（CRLF 检出与行编辑、fork 基线哈希、源码侧 runner 路径、neverBundle 解析后谓词、reviewer 文本 JSON 转义、映射 addon 清理移交）在远端全部复验通过，joint 冒烟在 Windows 上完成 packed/unpacked 双形态全流程。

## Auto Review 内置入口迁移（2026-10-20）

用户授权将独立 companion 合并进主包。需求评审见[评审记录](../completed/2026-10-20-auto-review-in-package-review.md)，交付及生命周期方案见 [ADR-0022](../../decisions/ADR-0022-auto-review-loader-entry.md)。已实施并经 PR #16 合入 `main`（`9138084`，随后 README 收尾 `0851a28`/`e4804fb`），随 `v0.1.9` 发版。

已移入 `src/auto-review/`，增加主包 `./auto-review` 导出和默认 disabled 的 `multi-root-auto-review` 行；context/reviewer 共用一个开关。configure、独立 manifest/workspace、第二 tarball 与版本协调退役。精确 fork 仍仅支持 `0.2.1-rc.2`，普通 allowlist 未变。

最小真实 loader 验证已通过两种顺序、延迟 import、反复 reload、官方原有 disabled、官方后加入/移除与描述符恢复。真实 profile 联合回归（source 与 packed 双车道、web/headless × 官方前后序、默认零挂载、live 接管/恢复/再启用、真实 reviewer 请求）已通过；typecheck 双通道、全量 vitest、lint、docs:check、pack:check、compat/fork 门禁全绿。官方 bundle 未选择时入口独立运行（自身注册 Auto preset），已在 README/ADR-0022 写明。`verify:all` 全项在本机通过（含 kernel:probe、compose/behavior/journey/packed 与 auto-review 双车道 smoke）。合入后 `main` 的多 OS CI 已复验：`9138084` 的 [CI run 39399743823](https://github.com/cherrchen/dsh-plugin-multi-root-workspace/actions/runs/39399743823) 全绿（含各支持版本的 Windows/Linux/macOS 车道）。随 `v0.1.9` 发版。


## Multi-root Skills 架构验证（2026-10-23）

用户授权在 `feat/additional-root-skills` 上完成 Proposed ADR 的剩余工程验证，再定案并拆分计划。问题源为 Issue #17；[ADR-0023](../../decisions/ADR-0023-multi-root-skill-discovery-and-invocation.md) 已据此升级为 **Accepted（架构定案）**。源码事实归[接缝调研](../../reference/multi-root-skills-seams.md)，S1–S7 任务和退出条件归[实施计划](../completed/2026-10-23-multi-root-skills.md)。**生产实现与本批全平台 CI 验证已完成，随 `v0.1.10` 发版；S7 含发布准备全部完成，A1–A13 的生产证据与能力边界见下文。**

### 2026-10-24 交互修订

按用户反馈及 ADR-0023 的同日修订，命名空间引用改为普通文字，移除独立按钮样式和聊天点击预览入口；补全与 Host 调用保留。开发 pin 本地 `pnpm lint`、`pnpm typecheck`、`pnpm docs:check` 通过，`pnpm test -- tests/client-skills.spec.tsx` 实际执行全套：891 通过、90 跳过。DOM 回归覆盖 interactive 两态均输出文字节点，点击不打开弹窗、不调用预览 RPC；该结果不替代真实宿主浏览器目检。

### 2026-10-24 PR #18 并发投递修复

[P2 评论](https://github.com/cherrchen/dsh-plugin-multi-root-workspace/pull/18#discussion_r4367566103)指出：同一条用户消息调用多个 Skill 时，前一个正文通过准入后进入待投递数组，等待后一个加载期间即使被撤销，返回时仍会投递。现按 ADR-0023 的并发补充保留全批加载凭据，所有异步操作结束后统一重验，最后同步检查 generation，再更新投递跟踪并返回；任一失效即丢弃本批新正文。

新增 9 项回归：7 类后续加载期间的失效（Root 关闭、移除、文件内容、用户调用策略、aliasId、全局关闭、authority）和最终准入期间 generation 改变共 8 项在修复前失败、修复后通过；另有未变化批次保持顺序、重复引用只注入一次的正对照。调用测试共 18/18 通过。

本地为 macOS、开发 pin `0.2.1-rc.2`，未重指安装树或扩大支持集合。重新构建后移除预览导致的 `react-dom/client` 产物断言也已同步。`compat:check`、lint、双端 typecheck、build、`docs:check` 通过；外层沙箱禁止 Seatbelt 嵌套，改在可执行的环境运行探针并确认 Seatbelt 后，携带 `DSH_PROBE_VERIFIED_DIALECTS=seatbelt` 执行全套：**911 通过、79 平台相关跳过**。compose / behavior / journey 为 **52 / 126 / 76 通过，零失败、零跳过**；`pack:check` 完整，`smoke:packed` 的 behavior 为 **125 通过、零失败、零跳过**。`auto-review:fork` 与 `smoke:auto-review` 亦通过（source/link、packed，web/headless 与两种 bundle 顺序）。这不是重新执行全部版本或跨平台矩阵的证据。

### 执行范围与结果

上游只读检出为 `dsh-v0.2.1-rc.2` / `687f282e8625c6b8d11ff58211a90524be2e4317`，未修改上游文件或切换其版本。本地运行时从本插件的 DSH 安装锚点解析，版本 `0.2.1-rc.2`；没有重指主 manifest/lockfile 或扩大支持集合。

可复现命令：

```sh
node --experimental-transform-types scripts/probe-multi-root-skills.mjs --upstream <upstream-checkout>
```

macOS / Node `24.18.0`：**13 组检查通过**。其中一组对 `SUPPORTED_DSH_RELEASES` 当前全部 **16 个 tag** 进行源码契约审查并输出 source 摘要与能力标志；其余为当前 pin 的发布模块和 UI 纯核原型，不等于 16 个独立运行时或完整 OS 矩阵。

| 原型证据 | 结果 |
| --- | --- |
| 真实 Registry、首步 pre-step、原生 skill 定义 | 首步有目录而无完整正文；两 Origin 共用 effective cwd 并发加载隔离；带父 scope 的子 Agent 按自身 Origin 选择根；缺失 scope 不贡献 |
| 真实 SessionSkillCatalog 与 invocation | 内部候选退出原生人类目录；user-only 可经 Alias 加载而模型拒绝；model-only 不进入 Alias；原生冒号参数被拒绝 |
| Alias pre-step | 保留用户原文，正文追加在 native Catalog 后；只解析本批用户消息；外部来源不能伪造手势 |
| 失效与原生替换 Catalog | 全局关闭后空目录、新加载拒绝；有历史 Catalog 时产生空替换；恢复后重新发现 |
| 延迟读取竞态 | get 已读文件、返回前关闭 Root 并失效，最终不返回正文 |
| 动态可用性 | 元数据调用策略变化、Alias 更名、authority 丢失、Root missing 与 symlink redirect 均按当前状态判定 |
| 受限原生文件解析 | 根外 Skill symlink 在内容读取前拒绝；未把原生 provider 当成自带 confinement |
| native Effective CWD 负对照 | 未包装原生 snapshot 在附加根 cwd 暴露裸名；公开 snapshot/get 包装后不再暴露；主根 Skill 保留；live/cold Remote 与 cwd symlink 覆盖 |
| 迁移与降级 | 分配幂等、反转输入顺序身份稳定、重复别名和空名处理；同值权限不重置；真实旧 Registry schema 剥离新字段，证实降级写回可能丢失手动选择 |
| 真实 Loader/Settings 多行 profile | 表单只对 multi-root-skills 行暴露；启用/关闭可持久化并实时读取；modern volatile 修改不重挂 Skills fiber，不写 Registry 行 |
| UI 纯核与卸载 | 冒号 trigger 保留、草稿不高亮限制复现、自定义已发送 matcher 可用；Registry 方法原始实例属性描述符可恢复 |

### 验证后收敛的边界

发现两项必须加入实现的约束：只注册 Provider 不能防 native effective-cwd 再发现；不能承诺 domain v1 的未知 metadata 经旧版写回仍保留。旧宿主的设置和已发送 UI 也须按实际能力分支：legacy installSection 与 modern volatile Config 分开；UserTextRule 只在 `0.2.1-alpha.3` 及之后的本次审查集合出现。

架构原型结束时尚未执行：旧版隔离安装树上的动态验证、真实 Connection 传输、完整浏览器 DOM/交互、真实 agent-loop/LLM journey、新字段在生产 Registry lease/迁移队列中的集成、观察调度器资源测试，以及 Linux/Windows 原生路径与句柄测试。该阶段没有源码产品改动，未将全套 kernel/smoke/packed 门禁记为执行通过；后续生产验证见下文。文件句柄与前后检查也不声称可抵御任意祖先 rename 的原子事务。

### 后续进度

2026-10-23 开始连续实施，按阶段保存可分批应用的 checkpoint；不创建发布版本或 tag。

| 阶段 | 状态与证据 |
| --- | --- |
| S1 | 装配完成。新增独立 Skills entry / patch 行、可选 peer 分类、scope 身份与 Config 接缝。正式 `skills-compat.spec.ts` 随既有版本矩阵运行；本机 rc.2 的 4 个相关测试文件共 53 passed / 1 既有 skip，host typecheck、build、定向 lint、compat:check 通过。其余版本动态执行留在 S7，不扩大本机证据。 |
| S2 | 完成 metadata / 迁移、两项 mutation、命令与 Dialog。rc.2 真实 JSON Registry、lease、命令、wire、DOM 与 locale 共 7 文件 187 passed / 1 既有 skip；新增覆盖迁移写失败、重复加载、损坏字段、并发命名空间、takeover、降级写回与 revive。新 metadata 不改变 grant 三键或 writableRoots；refresh 无写。 |
| S3 | Provider / 受限原生解析 / live 与 cold Origin 路由已实现。rc.2 原生 pre-step 与公开 Remote 的回归验证两 Origin 共用 cwd、两目录发现、symlink 拒绝、冷 Session、裸名负对照、零根参数保持、reload 和描述符恢复。完整 Loader web/headless journey 与旧版动态运行仍在 S7 验收，不把本层测试称为完整组合验收。 |
| S4 | 按需模型 get、Host Alias pre-step、读取前后文件签名和 generation fence、独立撤销提示已实现。rc.2 的 8 个正式回归经真实 tools.execute / pre-step 覆盖默认/user-only/model-only、伪造 source、旧 Alias/内部 ID、读取中禁用/移除/策略变化/取消、其他 Provider incomplete、原生 exact-ID winner；通过。 |
| S5 | 共享 128 根 LRU 委托池与 2 秒单调度器、generation、冷 Session list/preview/changes RPC、Client epoch/取消围栏、ordered teardown 已实现。rc.2 8 个相关文件 86 passed（含真实 Connection localhost HTTP、实际文件增改删/Root missing、容量/去重/淘汰、排队取消、延迟 get 卸载排空、旧包丢弃）；typecheck 与定向 lint 通过。 |
| S6 | Slash Source、完整文本插入、conditional UserTextRule/Renderer、安全预览、双形状 Settings 卡片及 Host 动态配置已实现。rc.2 Loader/Settings 真实多行 profile 验证只改 Skills 行、volatile 不重挂；legacy installSection 到达/移除回归通过。DOM 覆盖 namespace 补全、原文插入、sent 引用预览 RPC、表单映射与 accessible checkbox。旧宿主动态验收及真实浏览器整页检查在 S7 继续。 |
| S7 | macOS 本机集成、Windows 与 Linux（WSL2）各 16 精确版本本机完整门禁完成；PR #18 的远端 16 版本 × 4 runner 矩阵及最终 gate 全绿，补齐 Windows 第二固定卷与 foreign-owner 两项能力缺口。发布准备完成，随 `v0.1.10` 发版，计划归档 completed；执行证据与能力边界见下文。 |

C0 保存既有架构文档与原型；C1 保存 S1，C2 保存 S2，C3 保存 S3 的实现与本层测试，C4 保存 S4，C5 保存 S5，C6 保存 S6 的实现与本层测试。checkpoint 为本机临时快照仓库中的增量 patch；上述阶段结束时正式仓库尚未提交，后续阶段继续基于同一工作树。本批提交状态见下文。


### 生产实现本机验收（2026-10-23）

主工作树保持 `0.2.1-rc.2` 开发 pin、原 16 项精确支持集合及 enforce 门禁。macOS / Node `24.18.0`，未修改上游；S1–S6 生产实现及本机整体验证完成，S7 保留必要平台门禁与发布准备。

| 本机门禁 | 结果 |
| --- | --- |
| compat:check、lint、typecheck、build | 通过；支持集合、peer 与安装树一致 |
| test | **891 passed / 65 skipped**，63 文件通过、1 文件平台跳过；skip 不计为原生通过 |
| kernel:probe | Seatbelt 实跑成功；本机无 bwrap/Landlock |
| smoke:compose / smoke:behavior / smoke:journey | **52 / 126 / 76 passed**，均 0 failed / 0 skipped |
| pack:check / smoke:packed | 通过；tarball behavior **125 passed / 0 failed / 0 skipped** |
| auto-review:fork / smoke:auto-review | 通过；source/link 与 tarball，web/headless × 两种官方 bundle 顺序，真实 reviewer 和写围栏回归通过 |
| 架构原型 | 更新为冻结旧记录 schema 后重新运行，仍 **13 组通过** |

journey 使用真实 Loader、preset、Agent loop、原生 skill 工具和本地脚本化 LLM 服务；web/headless 的首请求只有目录，模型调用后收到正文，第二轮用户 `/repo-b:journey-user` 保留原文并按 user-only 策略加载。web 动态关闭/恢复 Config 后旧内部 ID 拒绝，主根 Skill 与各 Root 手动选择保留；关闭 Root 后进入附加目录不能通过 native 裸名发现。测试环境须允许原生 watcher 和 Seatbelt：外层执行沙箱曾使上游文件 Provider 报 incomplete，原生工具因此正确拒绝整个 Catalog，不能用绕过 incomplete 来取得绿灯。

浏览器在隔离 home/仓库的真实 Web 页面完成：插件详情页只有一份全局 Skills 卡片、关闭/恢复；Root checkbox 关闭后候选消失、恢复后出现；`/repo-b:` 候选无内部 ID，选择插入完整 `/repo-b:review `；已发送引用显示并可打开受 Session RPC 重验的正文预览。浏览器的模型地址刻意指向不可用的本地端口，发送后的 transport failure 不作为模型调用成功证据；模型调用成功证据归上述 journey。草稿保持无原生高亮。末轮修正了普通会话 activity/title 更新误关闭预览的问题：Skills 现在只在当前 Session ID 实际变化时重置；现有根面板保持原订阅语义。

A1/A2/A10 由真实 Registry/lease/JSON 重启与命令/DOM 测试覆盖；A3–A8 由 native snapshot/get、真实 tools.execute/pre-step、Connection 及 journey 覆盖，另有子 Agent 自身 Origin、cwd symlink 与 reload 的正式回归；A9 由文件变化、受限读取、128 根池配额/去重/LRU、排队取消与卸载排空覆盖；A11/A12 由真实 Loader/Settings、DOM 和浏览器覆盖。A13 的跨版本动态接缝见下节；该轮尚缺的 Windows、Linux 原生证据已在下文补验，全平台退出条件仍未关闭，不能称 A1–A13 最终全部完成。

本机成本样本来自 `node --experimental-transform-types scripts/measure-multi-root-skills.mjs`：16 根 × 8 Skills，正文每项约 6 KiB；首次 metadata list **586.89 ms**，5 次重复 list **459.61–623.83 ms**，受检 preview **406.15–568.29 ms**。目录断言不含正文。这是同时执行其他回归时的本机 IO 样本，不是 UI 网络延迟、吞吐保证或跨平台性能认证；当前每次请求重验有可见扫描成本。

### 已支持版本的隔离动态验证

从 `SUPPORTED_DSH_RELEASES` 读取全部 **16 个版本**，在临时源码副本中依次通过既有 `upgrade-dsh.mjs` 重指，每项执行独立 install、`compat:check`、`typecheck`、`build` 和 10 个 Skills/Client/可选 peer/patch 定向测试文件。**16/16 通过**；每项 **58 passed / 1 skipped**。该 skip 为 legacy namespace Settings 与现代 ConfigEditor 两种互斥能力中的另一分支，实际对应形状均有运行，不是跳过整个 Settings 功能。临时树安装使用 `CI=true`，负对照 fixture 显式置于自动 temp grant 之外；主树 pin、lockfile 和安装树未参与重指。

这是 macOS 上的跨版本动态接缝验证，不能替代每个版本的完整普通插件/联合 smoke 或其他 OS 原生验证。完整本机门禁仅对主开发 pin 执行。后续补充的真实 Connection 延迟包回归，以及两种 Session store 形状下只在选择变化时关闭预览的回归，均在主 pin 通过；不将未重跑的旧版新增断言计入上面的 58 项。

### Windows 原生验证（2026-10-23）

Windows 11 `10.0.26200` / NTFS，Node `24.14.0`、pnpm `11.25.0`，非提权 UAC 令牌；已有 deny broker 正在运行，PATH 首位为非 MSIX 的 PowerShell。基于 `4faa6f1` 增加 Windows 专项回归，没有修改产品源码、支持集合或主树开发 pin。验证在外层 Agent 执行沙箱之外进行；`kernel:probe` 确认真实 `windows-acl` runner 可写工作区、拒写相邻目录，后续测试与冒烟均携带 `DSH_PROBE_VERIFIED_DIALECTS=windows-acl`。

| 开发 pin `0.2.1-rc.2` 门禁 | 结果 |
| --- | --- |
| compat:check、lint、typecheck、build | 通过；主树 manifest、lockfile 与精确支持集合保持原样 |
| test | **912 passed / 51 skipped**，65 文件通过；包含新增 7 项 Windows Skills 回归 |
| kernel:probe | `windows-acl` 实跑成功；Seatbelt/bwrap/Landlock 不在 Windows 上声明原生通过 |
| smoke:compose / smoke:behavior / smoke:journey | **52 / 133 / 76 passed**，均 0 failed / 0 skipped |
| pack:check / smoke:packed | **144 个成员**完整；安装 tarball 后 behavior **132 passed / 0 failed / 0 skipped** |
| auto-review:fork / smoke:auto-review | 通过；source/link 与 tarball、web/headless × 官方 bundle 两种顺序、真实 reviewer 写围栏与 owner drain 均执行 |

新增 `tests/skills-windows.e2e.ts` 在真实 Windows 文件系统上验证：大小写不同的 effective cwd 仍受 Root 开关约束（live/cold 两入口）；登记目录替换为根外 junction 后，旧内部 ID 与预览失效；Skill 目录 junction 改目标触发观察失效且根外正文不可发现；已打开的真实文件句柄读取中发生文件替换、删除、撤销或取消时，旧正文不返回且句柄关闭。读取竞态通过暂停 `FileHandle.readFile()` 的返回制造，保留真实 open/read/stat/close 与原生解析，不以 stub Provider 结果替代句柄证据。现有 Windows ACL/broker/pwsh/ConPTY 回归随全量测试和冒烟执行。

本机只有一个可写固定卷，当前非提权令牌不能把夹具属主设为 SYSTEM；既有“第二固定磁盘授权”和“非调用方属主拒绝”两例按原有本地能力规则跳过，不能记为通过，须由具备条件的 Windows CI/提权环境补验。首次误将本地测试设为 `CI=true` 时，这两个 CI 前提被强制检查并失败（905 passed / 49 skipped / 2 failed），不作为成功证据；后续保留原生方言强制断言、按本地能力重跑得到上表结果，没有修改或放宽测试门禁。其余 skip 为现有平台/宿主能力分支，不计作相应原生能力通过。

Windows 成本样本仍用 `measure-multi-root-skills.mjs` 的 16 根 × 8 Skills 夹具：首次 metadata list **1709.69 ms**，5 次重复 list **932.26–2308.76 ms**，受检 preview **962.29–1511.74 ms**；目录不含正文。采样时另有验证任务运行，不作为跨平台性能阈值。

#### Windows 精确版本完整本机矩阵

从 `SUPPORTED_DSH_RELEASES` 读取全部 **16 个精确版本，16/16 完成本机完整门禁**。开发 pin 使用上述主树结果，其余 15 个版本在独立源码副本中用 `upgrade-dsh.mjs` 重指、单独 install；副本既不位于其他安装树之下，也不在自动 temp grant 内，负对照夹具仍在非临时授权区域。主树不参与重指。安装使用 `CI=true`；本地测试保留上文两项能力限制，两个隔离车道各用 `pnpm test --maxWorkers=2` 限制并发。

每版逐项执行 compat:check、lint、typecheck、build、kernel:probe、test、三项 smoke、pack:check、smoke:packed、auto-review:fork、smoke:auto-review 和 docs:check，全部命令退出 0。每版均核实 `windows-acl: ok` 并强制该方言的原生断言；全程 enforce，没有使用 `DSH_MULTI_ROOT_COMPAT=warn`。`auto-review:fork` 在所有版本执行；Auto Review 联合 smoke 仅在其合同指定的 `0.2.1-rc.2` 执行并通过，其余 15 版明确报告可选集成跳过，不计为联合集成通过。

下表 smoke 列为通过数，**全部 0 failed / 0 skipped**；test 的平台/宿主能力跳过单独列出，不计作原生通过。新增 7 项 Windows Skills 用例进入每个版本的完整套件。

| DSH 精确版本 | test 通过 / 跳过 | compose | behavior | journey | packed behavior |
| --- | --- | --- | --- | --- | --- |
| `0.1.5-rc.2` | 836 / 57 | 52 | 125 | 76 | 124 |
| `0.1.6-alpha.1` | 836 / 57 | 52 | 133 | 76 | 132 |
| `0.1.6-alpha.2` | 836 / 57 | 52 | 133 | 76 | 132 |
| `0.1.7-alpha.1` | 838 / 55 | 52 | 133 | 76 | 132 |
| `0.1.7-alpha.2` | 838 / 55 | 52 | 133 | 76 | 132 |
| `0.1.7-rc.1` | 838 / 55 | 52 | 133 | 76 | 132 |
| `0.1.7-rc.2` | 838 / 55 | 52 | 133 | 76 | 132 |
| `0.2.0-rc.1` | 838 / 55 | 52 | 133 | 76 | 132 |
| `0.2.0-rc.2` | 838 / 55 | 52 | 133 | 76 | 132 |
| `0.2.1-alpha.1` | 838 / 55 | 52 | 133 | 76 | 132 |
| `0.2.1-alpha.2` | 843 / 50 | 52 | 133 | 76 | 132 |
| `0.2.1-alpha.3` | 843 / 50 | 52 | 133 | 76 | 132 |
| `0.2.1-alpha.4` | 843 / 50 | 52 | 133 | 76 | 132 |
| `0.2.1-alpha.5` | 843 / 50 | 52 | 133 | 76 | 132 |
| `0.2.1-rc.1` | 843 / 50 | 52 | 133 | 76 | 132 |
| `0.2.1-rc.2` | 912 / 51 | 52 | 133 | 76 | 132 |

逐命令日志、源码快照校验和与机器可读汇总保存在被忽略的 `.dsh-smoke/s7-windows-20261023/`；上述执行结论以本节为持久真源。完整 Windows 本机矩阵不替代下述剩余平台和 CI 验收，也不补记第二磁盘/foreign-owner 两例为通过。

### Linux 原生验证（2026-10-23，WSL2）

Ubuntu `24.04.4 LTS` / WSL2，内核 `6.6.87.2-microsoft-standard-WSL2`、x86_64，夹具位于 Linux ext4（非 Windows 挂载盘）；Node `24.13.0`、pnpm `11.25.0`。基于 `72d27d3` 增加 Linux 专项回归并修正 symlink 夹具，没有修改产品源码、上游包、支持集合或主树开发 pin。验证在外层 Agent 执行沙箱之外进行；每版 `kernel:probe` 均确认 **bwrap 与 Landlock 实跑成功**，后续测试与冒烟均携带 `DSH_PROBE_VERIFIED_DIALECTS=bwrap,landlock`，这两个方言的原生断言不能因 runner 不可用而跳过。

| 开发 pin `0.2.1-rc.2` 门禁 | 结果 |
| --- | --- |
| compat:check、lint、typecheck、build | 通过；主树 manifest、lockfile 与精确支持集合保持原样 |
| test | **901 passed / 69 skipped**，64 文件通过、2 文件平台跳过；包含新增 7 项 Linux Skills 回归 |
| kernel:probe | bwrap、Landlock 实跑成功；Seatbelt / Windows ACL 不计为 Linux 原生通过 |
| smoke:compose / smoke:behavior / smoke:journey | **52 / 126 / 76 passed**，均 0 failed / 0 skipped |
| pack:check / smoke:packed | **142 个成员**完整；安装 tarball 后 behavior **125 passed / 0 failed / 0 skipped** |
| auto-review:fork / smoke:auto-review | 通过；source/link 与 tarball、web/headless × 官方 bundle 两种顺序、真实 reviewer 写围栏与 owner drain 均执行 |

新增 `tests/skills-linux.e2e.ts` 在真实 Linux 文件系统上验证：大小写不同的两根不合并，关闭其中一根不会停用另一根，live/cold 查询均不能走 native 裸名旁路；登记目录替换为根外 symlink 后，旧内部 ID 与预览失效；Skill 目录 symlink 换目标触发观察失效且根外正文不可发现；已打开的真实文件句柄读取中发生文件替换、删除、撤销或取消时，旧正文不返回且句柄关闭。读取竞态只暂停 `FileHandle.readFile()` 的返回，仍执行真实 open/read/stat/close 与原生解析。既有原生沙箱、读写权限、进程围栏、Registry authority、Connection、DOM 和 agent-loop 回归随全量测试与冒烟执行。

本轮两类首跑失败均保留日志并在处理后重跑：

- 两项既有 Registry 测试使用 `rmSync()` 删除指向目录的 symlink，本机返回 `Path is a directory`，导致恢复目录前失败。改用 `unlinkSync()`，behavior battery 同一夹具操作同步修正；原有拒授/恢复断言保持不变。修正后所有版本的完整测试、source 与 packed behavior 均通过。新增 Linux symlink 用例也使用 `unlinkSync()`。
- 系统 Git `2.43.0` 不认识 `0.2.1-alpha.2` 原生 Worktree 使用的 `--no-lazy-fetch`，该版两个既有 Worktree 用例失败。由 kernel.org 的 Git `2.48.1` 与 zlib.net 的 zlib `1.3.1` 源码在忽略的验证目录内构建独立 Git，通过既有 `DSH_TEST_GIT_COMMAND` 指向它，重跑该版全部门禁通过；不删除安全参数、不修改上游、不增加 skip。其余 15 版使用系统 Git 完成完整门禁。

Linux 成本样本仍用 `measure-multi-root-skills.mjs` 的 16 根 × 8 Skills 夹具：首次 metadata list **356.25 ms**，5 次重复 list **237.01–269.07 ms**，受检 preview **233.66–264.99 ms**；目录不含正文。采样时另有版本车道运行，不作为 UI 网络延迟、性能阈值或跨平台性能认证。文件句柄与前后检查仍不声称提供对任意祖先 rename 的原子事务。

#### Linux 精确版本完整本机矩阵

从 `SUPPORTED_DSH_RELEASES` 读取全部 **16 个精确版本，16/16 完成本机完整门禁**。所有版本使用独立源码副本，副本既不嵌套在其他安装树内，也不在自动 temp grant 内；通过现有 `upgrade-dsh.mjs` 重指、单独 install。最多 **3 个版本车道并行**，每车道 `pnpm test --maxWorkers=2`；安装与测试使用 `CI=true`。全程 enforce，没有使用 `DSH_MULTI_ROOT_COMPAT=warn`。

每版逐项执行 compat:check、lint、typecheck、build、kernel:probe、test、三项 smoke、pack:check、smoke:packed、auto-review:fork、smoke:auto-review 和 docs:check，最终全部命令退出 0。每版均强制 bwrap / Landlock 原生断言，新增 7 项 Linux Skills 用例进入每版完整套件。Auto Review 联合 smoke 按既有合同仅在 `0.2.1-rc.2` 实跑，其余 15 版明确报告可选集成跳过，不计为联合集成通过。

下表 smoke 列为通过数，**全部 0 failed / 0 skipped**；test 的其他 OS、旧宿主缺席能力及互斥 Settings 等分支跳过单独列出，不计为相应原生能力通过。

| DSH 精确版本 | test 通过 / 跳过 | compose | behavior | journey | packed behavior |
| --- | --- | --- | --- | --- | --- |
| `0.1.5-rc.2` | 822 / 78 | 52 | 118 | 76 | 117 |
| `0.1.6-alpha.1` | 822 / 78 | 52 | 126 | 76 | 125 |
| `0.1.6-alpha.2` | 822 / 78 | 52 | 126 | 76 | 125 |
| `0.1.7-alpha.1` | 825 / 75 | 52 | 126 | 76 | 125 |
| `0.1.7-alpha.2` | 825 / 75 | 52 | 126 | 76 | 125 |
| `0.1.7-rc.1` | 825 / 75 | 52 | 126 | 76 | 125 |
| `0.1.7-rc.2` | 825 / 75 | 52 | 126 | 76 | 125 |
| `0.2.0-rc.1` | 825 / 75 | 52 | 126 | 76 | 125 |
| `0.2.0-rc.2` | 825 / 75 | 52 | 126 | 76 | 125 |
| `0.2.1-alpha.1` | 825 / 75 | 52 | 126 | 76 | 125 |
| `0.2.1-alpha.2` | 831 / 69 | 52 | 126 | 76 | 125 |
| `0.2.1-alpha.3` | 831 / 69 | 52 | 126 | 76 | 125 |
| `0.2.1-alpha.4` | 831 / 69 | 52 | 126 | 76 | 125 |
| `0.2.1-alpha.5` | 831 / 69 | 52 | 126 | 76 | 125 |
| `0.2.1-rc.1` | 831 / 69 | 52 | 126 | 76 | 125 |
| `0.2.1-rc.2` | 901 / 69 | 52 | 126 | 76 | 125 |

逐命令日志、失败尝试、源码快照 SHA-256、隔离 Git 构建记录与机器可读汇总保存在被忽略的 `.dsh-smoke/s7-linux-20261023/`，复跑调度器为其中的 `run-matrix.py`；最终汇总逐项核实了全部命令退出码、smoke 零失败/零跳过、双方言探针与执行源码校验和。上述结论以本节为持久真源。WSL2 的原生执行不替代远端 Ubuntu 两种 runner 镜像或其他 OS 的本批 CI，也不补记 Windows 两项能力缺口为通过。

### PR #18 远端 CI 验收（2026-10-23）

[CI run 39955314649](https://github.com/cherrchen/dsh-plugin-multi-root-workspace/actions/runs/39955314649)（run #176，attempt **1**）对应 [PR #18](https://github.com/cherrchen/dsh-plugin-multi-root-workspace/pull/18) 的 `c51f3efd5f1ec38caa052b15cfc3e79b8a1de1d0`，实际 checkout 为 PR merge tree `ac3de488927b727289dffb8341d1d168f7e979c4`。矩阵从既有 allowlist 读取 **16 个精确版本 × 4 个 runner 镜像 = 64 项**：`ubuntu-latest`、`ubuntu-22.04`、`macos-latest`、`windows-latest`。Node `22.19.0` / pnpm `11.25.0`，使用 enforce 门禁，未扩大支持集合或修改 Windows 前提检查。GitHub connector 的 jobs 入口只返回前 30 项，核对时通过 Actions API 分页取得全部任务，不能把第一页当完整矩阵。

该 run 于 **2026-10-23 20:58:09（Asia/Taipei）**结束，结论 **success**：**64/64 矩阵任务 success**，加上 releases 与[最终 gate](https://github.com/cherrchen/dsh-plugin-multi-root-workspace/actions/runs/39955314649/job/120426410563)，共 **66/66 任务 success**，没有失败、取消或整项跳过。每项均完成 compat、lint、双端 typecheck、build、kernel:probe、test、compose/behavior/journey、pack:check、smoke:packed、Auto Review 合同入口与 docs:check；Windows broker 安装与卸载也均成功。任务成功不等于其中所有平台/宿主能力断言均已执行，下表保留实际 skip。

开发 pin 的远端执行证据：test 列为通过 / 跳过；所有 skip 均不计作对应原生能力通过。

| runner / 任务日志 | test | compose / behavior / journey / packed behavior | 原生方言与边界 |
| --- | --- | --- | --- |
| [macos-latest](https://github.com/cherrchen/dsh-plugin-multi-root-workspace/actions/runs/39955314649/job/120419666897) | 891 / 79 | 52 / 126 / 76 / 125，均零失败、零跳过 | Seatbelt 实跑；无 bwrap/Landlock |
| [ubuntu-latest](https://github.com/cherrchen/dsh-plugin-multi-root-workspace/actions/runs/39955314649/job/120419667036) | 893 / 77 | 52 / 105 / 76 / 104，均零失败；behavior 与 packed behavior 各 1 skip | Landlock 实跑；bwrap 因 `setting up uid map: Permission denied` 不可执行，保留宿主策略，不补记 bwrap 通过 |
| [ubuntu-22.04](https://github.com/cherrchen/dsh-plugin-multi-root-workspace/actions/runs/39955314649/job/120419667109) | 901 / 69 | 52 / 126 / 76 / 125，均零失败、零跳过 | bwrap 与 Landlock 均实跑 |
| [windows-latest](https://github.com/cherrchen/dsh-plugin-multi-root-workspace/actions/runs/39955314649/job/120419666834) | 926 / 44 | 52 / 133 / 76 / 132，均零失败、零跳过 | Windows Server 2025 / `windows-2025-vs2026`；真实 windows-acl 探针、broker 安装与卸载、Auto Review 和任务收尾均成功 |

#### Windows 两项本机能力缺口的闭环

已检查其余 15 个 Windows 任务的完整日志及 rc.2 已上传的 `vitest-log-windows-latest-0.2.1-rc.2`、`smoke-log-windows-latest-0.2.1-rc.2`。**16 个版本均完成原生测试，第二固定卷与 foreign-owner 不再是待补验项**。rc.2 的 vitest 日志明确列出以下两例通过；其他版本同一套件通过，且 `CI=true` 下缺少第二固定卷、SYSTEM owner 或 deny ACE 都会使测试失败，不能走本地能力 skip：

- `grants an additional root on a different drive`：真实受限 Node 写探针断言主根、跨固定卷附加根为 `allowed`，第三目录为 `denied:*`。
- `refuses a root the caller does not own`：测试先核实 owner 为 `S-1-5-18`（SYSTEM）并读回 Everyone deny ACE。全部 Windows 日志均记录 `the grant was applied; asserting the child could not write either dir (status 0)`，实际走的是**受限子进程启动后两处写入均拒绝**的成功分支；不宣称本轮复现了启动前 exit 127。随后断言 foreign-owned 与第三目录均未生成 `owned.txt`。

每版 `tests/windows-native.e2e.ts` 为 **40 tests / 2 skipped**；上述两例不在 skip 内。每版 `tests/skills-windows.e2e.ts` 的 **7 项均执行通过**。完整套件按版本分组为：`0.1.5-rc.2`、`0.1.6-alpha.1`、`0.1.6-alpha.2` 各 **849 passed / 51 skipped**；`0.1.7-alpha.1` 至 `0.2.1-alpha.1` 的 7 个受支持版本各 **852 / 48**；`0.2.1-alpha.2` 至 `0.2.1-rc.1` 的 5 个受支持版本各 **857 / 43**；`0.2.1-rc.2` 为上表 **926 / 44**。这些远端计数独立于前述本机矩阵，不回写或覆盖本机的真实 skip。

最早支持版的复核日志为 [Windows 0.1.5-rc.2](https://github.com/cherrchen/dsh-plugin-multi-root-workspace/actions/runs/39955314649/job/120419666284)，开发 pin 的日志为上表 Windows 任务；其余版本任务均可由同一 run 的完整矩阵定位。Auto Review 的 fork 检查进入全部版本，联合 smoke 的真实集成范围仍仅限 `0.2.1-rc.2`，该版四个 runner 均完成 source/link 与 packed、web/headless × 两种官方 bundle 顺序；其他 15 版的可选集成退出 0 不计为联合集成通过。

### 剩余验收与 checkpoint

Windows、Linux（WSL2）本机各 16 版本完整门禁已执行；Windows 第二固定卷与 foreign-owner 两例及本批远端完整矩阵已补验，最终 gate 全绿。新测试已进入既有测试入口；本批已按 C0 → C7a 的 checkpoint 顺序分为 9 笔提交，Windows、Linux 验证另作独立提交。S7 剩余发布准备：按 release workflow 确定版本、同步发布状态并更新双语 CHANGELOG，说明旧 inherit/read-write 登记默认启用、read-only 默认关闭、全局关闭方式与 metadata 降级边界。当前未准备版本或 tag，不修改已发布历史，PR 保持 Draft，计划保留 active。上述 CI 结论只绑定记录的代码 SHA；后续提交的 CI 应另行核对，不能继承为已通过。

C7 保存本机集成、最终回归、浏览器/兼容性收敛和文档；C7a 保存浏览器末轮发现的预览生命周期修正及两形状回归。这些 checkpoint 只代表当时本机阶段完成，后续平台结果见上文。C0–C7、C7a 为按顺序应用的增量 patch；临时快照另备份在本工作区被忽略的 `.dsh-smoke/checkpoints-multi-root-skills-20261023/`，含基线与校验和 manifest，可用于后续分批提交。正式仓库已按 checkpoint 完成分批提交；原始补丁继续保留，最后一笔另同步本节提交状态。S7 全部退出条件（含发布准备）已满足；计划已归档 `completed/` 并随 `v0.1.10` 发版。

## DSH 0.2.1-rc.3 兼容提升（2026-10-23）

用户授权范围是 `dsh-v0.2.1-rc.3` 一个发布版本。上游本地 tag 与 npm `versions` 列表一致，与 `0.2.1-rc.2` 做源码差分。支持合同保留全部旧版，再纳入这个精确版本；开发 pin 与 lockfile 升到 `0.2.1-rc.3`，cordis 仍是 `4.0.5`（`dsh` 仍依赖 `~4.0.5`）。插件版本号不变，本提升不单独创建 release tag（随后随 `v0.1.10` 一并发版）。

| 上游 tag | commit |
|---|---|
| `dsh-v0.2.1-rc.3` | `1f81c047fc48fa190a683e469daa699857e9afe8` |

#### 接口变更与风险

| 接缝 | 上游变化与影响 | 本次处理与证据 |
|---|---|---|
| client slot catalog / navigation | 新增 `sidebar.panellist.actions` 与 `sidebar.right.tab.guide.actions` 槽位；navigation pins 与 selection 分离；导航/预设埋点 | 不相关：不占本插件 slot；`sidebar.footer.action` 与 `sidebar.right.tab.files.actions` 注册不变 |
| `dsh-llm` DeepSeek API-key 路由 | 模型列表改走官方 `/models` listing | 不相关：LLM 接缝只包装工具消息形状 |
| fork 客户端文件 | `rc.2`→`rc.3` 的 `src/client/` 子树逐字节零改动（`ui-sidebar-files/src/client` 与 `ui-open-in-app/src`） | 按 FORK.md 核对后仅前移 revision 基线至 `1f81c047fc`，不重新拷贝 |
| cordis / storage-domain zod / session format / install 门禁 | 均无变化 | 无新适配分支；storage-zod 与 peers 契约原样覆盖 |

#### 候选车道与验收

候选 `0.2.1-rc.3` 走完整 upgrade lane（`upgrade-dsh.mjs` repoint + `--config.minimumReleaseAge=0` 重装 + `DSH_MULTI_ROOT_COMPAT=warn pnpm verify:all`）。本地宿主为 macOS：`kernel:probe` 实测 Seatbelt 可执行；bwrap / Landlock 本机不存在，Linux/Windows 原生证据由远端 CI 承担，不把本地 skip 记为通过。

| 运行时 | 单测 | compose | behavior | journey | packed behavior | 结果 |
|---|---|---|---|---|---|---|
| `0.2.1-rc.3` | 841 passed / 79 skipped | 52 | 126 | 76 | 125 | 通过 |

候选期间无接缝修复——全部验证一次通过。

#### 正式提升

`SUPPORTED_DSH_RELEASES` 扩至 17 个精确版本；27 个 `@deepseek-ai/dsh-*` peer 同步枚举；开发 pin `0.2.1-rc.3`、cordis `4.0.5`；release-age 精确豁免重写为 rc.3 集合；probe overrides 与 `minimumReleaseAge: 0` 不落入提交。可选 Auto Review 联合合同保持 `0.2.1-rc.2` 不变（`AUTO_REVIEW_RELEASE` 未动）。提升后 enforce 验收（`0.2.1-rc.3` / cordis `4.0.5` 开发树，本机 macOS）：`pnpm compat:check` 四方一致；`pnpm verify:all` 全绿——lint、双端 typecheck、build、`kernel:probe`（Seatbelt 实测可执行）、test **59 文件 841 passed / 79 skipped**、compose **52/0/0**、behavior **126/0/0**、journey **76/0/0**、pack:check **144 成员**、packed behavior **125/0/0**；`pnpm docs:check` 通过。

#### 旧版回归

在正式 allowlist（enforce）下用 `upgrade-dsh.mjs` 重指并逐版重建安装树：覆盖最近一次支持的 `0.2.1-rc.2`（同时是 Auto Review 联合 pin，其开发包在该 pin 恢复）与 zod 分裂前最后的 `0.2.1-alpha.2`（覆盖 storage-zod 旧形状分支）。每版跑 `compat:check`、全量 test、compose、behavior：

| 版本 | resolved 树 | 单测 | compose | behavior | 结果 |
|---|---|---|---|---|---|
| `0.2.1-rc.2` | 65 包统一（含 Auto Review 开发包） | 911 passed / 79 skipped | 52 | 126 | 通过 |
| `0.2.1-alpha.2` | 49 包统一 | 841 passed / 79 skipped | 52 | 126 | 通过 |

回归后开发 pin 与安装树恢复 `0.2.1-rc.3`：可选 peer（`dsh-permission-presets` / `dsh-util-values`）曾被 lockfile 钉在旧版造成混装，`pnpm dedupe` 重指后 49 包统一 `0.2.1-rc.3`，frozen lockfile install 通过、`compat:check` 再次四方一致。该现象只发生在本地来回重指的工作流，不影响干净 checkout 的 frozen 安装。远端 17 版本 × OS 矩阵由本分支 PR 的 CI 车道执行，未完成前不记为通过。

## DSH 0.2.1-rc.4 与 0.2.2-alpha.2 兼容提升（2026-10-28）

用户授权范围是 `dsh-v0.2.1-rc.4` 与 `dsh-v0.2.2-alpha.2` 两个发布版本。上游本地 tag 与 npm `versions` 列表一致，分别与 `0.2.1-rc.3`、`0.2.1-rc.4` 做源码差分（接口审查见 [dsh-0.2.2-migration.md](../../reference/dsh-0.2.2-migration.md)）。支持合同保留全部旧版，再纳入这两个精确版本；开发 pin 与 lockfile 升到 `0.2.2-alpha.2`，cordis 随 `dsh` 声明升到 `4.0.6-alpha.1`；上游 root engines 自 0.2.2 起要求 Node `>=24.9.0`。插件版本号不变，本提升不单独创建 release tag。

| 上游 tag | commit | npm dist-tag |
|---|---|---|
| `dsh-v0.2.1-rc.4` | `504a01a9578abc2c6f1fb896b1dc322c9fe24f66` | `next` |
| `dsh-v0.2.2-alpha.2` | `f3803c96974ad4a94195fb97e5c637e9c2a3afe3` | `alpha` |

#### 接口变更与风险

| 接缝 | 上游变化与影响 | 本次处理与证据 |
|---|---|---|
| `AgentRegistry` 注入 | 新增 `inject = ['sessionProjections']`；挂缺 `ctx.agents` 为 `undefined` | 测试栈补挂 `SessionProjectionRegistry`（skills-stack、auto-review/parent）；插件源码不消费 `ctx.agents` |
| 工具执行拆分 | `ctx.tools.setExecutor`、批量 `execute({calls})`、`dsh-tools/pipeline` 仅 0.2.2 起存在 | `tests/support/tool-executor.ts` 按 `setExecutor` 存在性动态挂载；动态导入 specifier 非字面量（Vite 转换期会解析字面动态导入，旧版本直接炸 spec） |
| Sandbox `additionalWritableRoots` | 原生第三路可写根（Seatbelt/bwrap/Landlock/fs-sandbox 消费，windows-acl 拒绝） | 本插件不设该字段；`tests/upstream-additional-roots.spec.ts` 钉住原生根 X 与 scope 根 Y 在各方言同时授予、fs fence 与真实 Seatbelt 执行一致 |
| client fork | `ui-sidebar-files` hover 移入 `@media (hover: hover)`；`ui-open-in-app` 失败反馈改为 `shell.overlay` outcome toast | fork 基线前移 `f3803c9697`（见两个 FORK.md）；新增 `outcome.ts`/`device.ts` shim、`open-failure-toast.tsx` 删除；`Toast` 的 `tone`/`actions` 经 `upstream-surface.d.ts` 重载在 0.1.5 像素期上过 typecheck |
| session / storage / skills | session/created 完成前拒 append；storage 新增 deleteRecords/unknown-state；filesystem skills 报 incomplete observation | 均为新增面或语义微调，插件不受影响（skills incomplete 记为已知后续观察点） |
| Node / cordis | 0.2.2 起 engines `>=24.9.0`；cordis `~4.0.6-alpha.1` | CI verify 按已知旧版前缀分流：仅 `0.1.*`/`0.2.0`/`0.2.1` 用 Node `22.19.0`，其余用 `24.9.0`；`upgrade.yml` 升至 `24.9.0` |

#### 候选车道与验收

`0.2.1-rc.4` 探针一次全绿、零源码改动：单测 **841 passed / 79 skipped**，compose **52**、behavior **126**、journey **76**。

`0.2.2-alpha.2` 首跑 typecheck/build/三路 smoke 全绿；首轮 Vitest 为 **815 passed / 26 failed**——全部集中在 skills 测试栈（`AgentRegistry` 的 `sessionProjections` 注入 fixture 缺口），补齐后又暴露 `ToolExecutorUnavailableError`（执行器拆分），经 `tests/support/tool-executor.ts` 结构探测解决。修复后 alpha.2 enforce 验收（本机 macOS，Seatbelt 可执行）：`compat:check` 四方一致；lint、双端 typecheck、build、`kernel:probe` 全过；test **61 文件 855 passed / 79 skipped**、compose **52/0/0**、behavior **126/0/0**、journey **76/0/0**、packed behavior **125/0/0**；auto-review:fork 验证通过、smoke:auto-review 按设计跳过（仅 `0.2.1-rc.2` 目标）；`pnpm docs:check` 通过。`dsh plugin add` 在安装门禁下接受 `0.2.2-alpha.2`（peers 已含精确版本，无版本告警）。

#### 旧版回归

在正式 allowlist（enforce）下逐版重指重建：**回归期间发现升级脚本混树缺陷并已修复**——committed lockfile 偏好的 alpha 行 cordis 生态包（`cordis-plugin-loader@1.0.7-alpha.1` 等）会被旧版 peer 范围沿用，使 `0.2.1` 运行时混在 alpha loader 上、Settings volatile 写够不到 live Config（skills-settings 的 enabled 断言静默失败）；`upgrade-dsh.mjs` 现从目标版本自身 manifest 派生 `cordis-plugin-*`/`schemastery`/`cosmokit` 精确 pin。修复后每版跑 `compat:check`、双端 typecheck、build、全量 test、compose、behavior：

| 版本 | resolved 树 | 单测 | compose | behavior | journey | 结果 |
|---|---|---|---|---|---|---|
| `0.2.1-rc.4` | 统一 `0.2.1-rc.4`（loader `1.0.6` / cordis `4.0.5`） | 851 passed / 83 skipped | 52 | 126 | 76 | 通过 |
| `0.2.1-rc.3` | 统一 `0.2.1-rc.3`（loader `1.0.6` / cordis `4.0.5`） | 851 passed / 83 skipped | 52 | 126 | — | 通过 |
| `0.2.1-rc.2` | 统一 `0.2.1-rc.2`（loader `1.0.6` / cordis `4.0.5`，含 Auto Review 开发包） | 921 passed / 83 skipped | 52 | 126 | — | 通过；auto-review:fork 验证、smoke:auto-review **真跑**（行开关往返、bundle 顺序、reload、owner drain） |
| `0.2.1-alpha.2` | 统一 `0.2.1-alpha.2`（loader `1.0.6` / cordis `4.0.5-alpha.1`） | 851 passed / 83 skipped | 52 | 126 | — | 通过 |
| `0.2.0-rc.2` | 统一 `0.2.0-rc.2`（loader `1.0.6` / cordis `4.0.4`） | 845 passed / 89 skipped | 52 | 126 | — | 通过 |
| `0.1.7-rc.2` | 统一 `0.1.7-rc.2`（loader `1.0.6` / cordis `4.0.4`） | 845 passed / 89 skipped | 52 | 126 | — | 通过 |
| `0.1.5-rc.2` | 统一 `0.1.5-rc.2`（loader `1.0.6` / cordis `4.0.2`） | 842 passed / 92 skipped | 52 | 118 | 76 | 通过 |

回归后开发 pin 与安装树恢复 `0.2.2-alpha.2`：frozen lockfile install 通过、`--print-installed` 单一 `0.2.2-alpha.2`、`compat:check` 再次四方一致、workspace 无 probe 残留。

**未覆盖**：Linux 上 bwrap/Landlock 的真实内核执行（本机仅 Seatbelt）、Windows ACL 原生矩阵、fork 的浏览器目检（`data-*` 钩子由源码对照核对）、远端全版本 × OS 矩阵（由本分支 PR 的 CI 车道执行）。

## Issue #24：Registry／Skills 刷新循环 hot-fix（2026-10-29）

在 `fix/skill-lock-fix` 修复并经 PR #25 合入 `main`，随 `v0.1.11` 发版；问题机制与修复边界见[故障排查](../../troubleshooting/registry-owned-by-another-process.md#skills-查询导致持续刷新issue-24)，通知规则见 [ADR-0023](../../decisions/ADR-0023-multi-root-skill-discovery-and-invocation.md#4-生命周期缓存与撤销)。生产改动仅使 `setRegistryAuthority()` 对相同状态保持静默，保留现有 lease 重试、持续持锁、拆除顺序与 fail-closed 语义。

新增 `tests/skills-authority.spec.ts` 的四项集成回归，并加强 `tests/scope.spec.ts` 的相同状态通知断言。集成用例挂真实内核锁、生产 Registry、原生 Skills，模拟收到 `skills/change` 即自动重查的客户端，设 20 次硬上限。覆盖正常持锁、空根及有根时持续竞争失败、存储打开失败、故障期间继续持锁、原持有者释放后接管、介质修复后恢复、授权与 Skill 正文加载，以及不可用期间的空附加根授权。既有 `authority-boundaries` / `process-fence` 回归继续覆盖仅主根可写与不授予共享临时区的执行边界。

**先红后绿证据**：未改生产源码时，scope 单测因重复通知失败，两个竞争用例与存储故障用例均触及 20 次查询上限，共 **4 failed / 33 passed**。加入状态相等即返回的判断后，同一组 **37 passed**；持续竞争或存储故障下，初次查询为 1 次、变化事件为 0，重复刷新不增加事件；真实恢复仍通知，接管后稳定刷新不再失效。

本机 macOS、Node `24.18.0`、开发 pin DSH `0.2.2-alpha.2`：`pnpm verify:all` 完成，`compat:check`、lint、双端 typecheck、build 通过；全量 test **848 passed / 90 skipped**；compose **52 passed / 0 failed / 0 skipped**、behavior **95 / 0 / 7**、journey **69 / 0 / 2**、packed behavior **94 / 0 / 7**，`pack:check`、`auto-review:fork` 与 `pnpm docs:check` 通过。`smoke:auto-review` 按既有规则跳过（仅针对 `0.2.1-rc.2`）。`kernel:probe` 正常完成，但外层沙箱使 Seatbelt `sandbox_apply: Operation not permitted`，bwrap/Landlock 未安装，真实受限执行用例按既有能力探测跳过。packed 安装遇到 `koffi` 构建审批后，经既有脚本在隔离 profile 中授权并 remove/add 恢复，behavior battery 通过。

**20 分钟真实双 Host 观察通过**（20:31:56–20:51:57，Asia/Taipei，实际双实例时长 `1200.425s`）：两个独立进程挂完整 DSH `web` profile，共用隔离 `$DSH_HOME` 的登记存储；Skills 开启、真实 Agent/Session，每 5 秒查询、每 30 秒刷新 Registry，收到 `skills/change` 立即重查。约第 8 分半通过真实 HTTP/RPC 手动读取并修改附加根 Skill 正文，此后每 30 秒重复读取。没有 TUI 或模型调用，也没有强制 GC 或降低 V8 堆上限（实测每个 Host 上限 2240 MiB）；外部 RSS 超过 1 GiB 或查询失控即中止的保护均未触发。原定 30 分钟，按用户后续要求在控制器中把截止时间改为 20 分钟，仅调试控制器的截止变量，不重启或修改两个被测 Host；收尾接管观察为 5 秒。原始采样与汇总见[测量数据](../../reference/issue-24-registry-skills-soak-darwin.json)。

| 指标（双实例阶段） | 持锁方 | 竞争等待方 |
|---|---|---|
| 平均 CPU（去除前 30 秒，100% = 一个 CPU 核心，整个 Host 的 user + system 时间） | 0.8560% | 0.7119% |
| 5 秒窗口 CPU 峰值（去除前 30 秒） | 4.4424% | 4.1419% |
| 结束时 RSS / V8 已用堆 / old-space | 28.094 / 88.244 / 66.008 MiB | 30.516 / 86.500 / 65.177 MiB |
| 第 5–10 分钟 → 第 15–20 分钟已用堆中位数 | 83.908 → 87.704 MiB | 83.674 → 86.467 MiB |
| 定时与事件驱动的原生 Skills 查询 / 主动 Registry 刷新 | 242 / 40 | 241 / 40 |
| Skills 变化事件 | 1（修改 Skill 文件） | 0 |
| HTTP/RPC 正文读取 | 24 次成功，包含修改后的正文 | 24 次正确拒绝 |
| 运行错误 / 未预期退出 / OOM | 0 / 0 / 0 | 0 / 0 / 0 |

两个 Host 在 20 分钟内都未出现报告中的持续单核占用或高速内存增长；已用堆有少量漂移，不能据此声称绝无慢泄漏。双实例阶段结束后，持锁方正常退出（code 0），等待方在约 60 ms 后完成显式刷新，从 `contended` 恢复 `active`，附加根写权限和原生 Skills 目录恢复；真实根/authority 变化产生 3 次原生 Skills 事件及有限重查，收尾阶段事件数不再增加，随后也正常退出（code 0）。完整记录含 486 个采样点；该接管阶段验证目录恢复，正文恢复另由上述正式回归用例覆盖。

**未覆盖**：真实 `dsh-tui` 的 OOM 复现、Ubuntu 报告环境的原生复测、Windows 原生 ACL 和远端全版本 × OS 矩阵。


## 多 Host 权威服务开发（2026-10-29）

在 `feat/multi-instant-dsh-lock-upgrade` 开始分批开发。完整原始目标、初版能力对照、未完成项与后续演进见[专项计划](./2026-10-30-shared-registry-authority.md)；当前合同见[共享服务架构](../../architecture/registry-authority-service.md)，第一版撤权完成语义见 [ADR-0024](../../decisions/ADR-0024-registry-operation-admission.md)。A1 为最初基础；2026-10-30 已接入默认共享服务（[ADR-0025](../../decisions/ADR-0025-shared-registry-authority.md)），active/follower 均可逐操作使用附加根，唯一 owner 管理存储。实现完成与三平台/全版本验收分开记录。

| 批次 | 范围 | 状态 |
| --- | --- | --- |
| A1 | 确定撤权语义；store-wide mutation / refresh / fs 准入排序；write/edit 每调用独立快照、过期 handle、epoch 与 publication revision | 已实施并完成下述本机门禁；未发布 |
| A2 | async admission → sync confine/spawn；直接服务调用、shell/PTC/agent PTY 与旧进程边界 | 已实施；最早同步基线与开发基线本机验证，全版本矩阵待 CI |
| B | 唯一存储核心 / Host facade；store 身份、配置握手、本机 IPC 与调用者隔离、流控、幂等及结果不明 | 已实施；macOS 原生 peer 攻击测试通过，其他平台原生待执行 |
| C | LSP、Files/watch、instructions、Skills 等全消费者准入；断线保守拒绝、崩溃/竞选/接管、新 epoch | 已实施；本机真实服务及多进程回归通过 |
| D | 屏障控制的真实多进程交错、三平台、所有支持版本与 packed 安装验收 | 多进程/本机 packed 已验证；Windows/Linux 与其余精确版本由原生 CI 继续验收 |

A1 实现不改变 lock 路径、持锁时间、domain schema 或 provider 门禁。原有 hot-fix 保留；`setAdditionalRoots()` 仍是唯一根写口。测试使用真实 Registry / JSON backend / 内核锁，以 Promise 屏障固定“先准入后撤权”和“先撤权后准入”，并实际写入/编辑文件；不把通知、revision 或“连接活着”作为授权依据。

本机证据（macOS、Node `24.18.0`、已安装 DSH `0.2.2-alpha.2`；未重装依赖、未更改支持矩阵）：

| 检查 | 结果 |
| --- | --- |
| `compat:check`、lint、typecheck、build | 通过；compat enforce，allowlist / peer / dev pin / 实际树一致 |
| 完整 `test` | 63 文件通过 / 3 文件跳过；862 测试通过 / 90 跳过，包含原有 Registry、lease 和 Skills 循环回归 |
| 最后补强后的 `tests/registry-operation.spec.ts` | 15 项通过：跨主根排队屏障、detached async handle 失效、真实 fs 撤权交错、工具封顶、三态矩阵、路径替换与接管 |
| `kernel:probe` | 完成；Seatbelt 被外层沙箱拒绝（`sandbox_apply: Operation not permitted`），bwrap/Landlock 未安装；内核执行断言按既有规则显式跳过 |
| `smoke:compose` | 52 通过 / 0 失败 / 0 跳过 |
| `smoke:behavior` | 95 通过 / 0 失败 / 7 内核项跳过 |
| `smoke:journey` | 69 通过 / 0 失败 / 2 内核项跳过；web/headless 两条旅程 |
| `pack:check` | 149 成员完整性检查通过 |
| `smoke:packed` | 从 tarball 安装的 behavior battery：94 通过 / 0 失败 / 7 内核项跳过 |
| `docs:check` | 0 错误 / 0 警告 |

pnpm 的自动依赖自检最初尝试重装并因非交互环境中止；后续用 `pnpm_config_verify_deps_before_run=false` 运行仓库脚本以保留现有安装树，真实兼容门禁仍正常执行并通过。未执行真实 dsh-tui 双 Host；Windows/Linux、其他支持版本以及未来 IPC 行为均不能由本机测试代替。

### 共享服务与全消费者接入（2026-10-30）

默认 bundle 配置 `sharedStorageRoot`，owner 单独打开显式 JSON medium，follower 经内核认证 IPC；所有变更/admission 在核心排序，owner 无本地旁路。同步消费以短期上下文连接，复制的旧 argv 不再是后续新操作许可；agent PTY 新准入后重新生成 profile，用户控制器终端透传。fs、LSP、Files/watch、instructions、原生 Skills 缓存与加载已接入；失联保留拒绝边界，写入结果不明隔离，mutation 丢应答不自动重放。协议只缓存紧凑 mutation 结果，持续查询不积累整份 roots snapshot。behavior/packed battery 另以两个完整独立 boot 的 Host profile 验证实际安装产物的 IPC 共享、撤权和新 epoch 接管（同进程双 Host；进程隔离另由 e2e 覆盖）。具体合同与能力前提以[共享架构](../../architecture/registry-authority-service.md)为准。

本机 macOS / Node `24.18.0` / DSH `0.2.2-alpha.2`，当前开发依赖树保持原样；新增的旧版验证使用 `/private/tmp` 独立安装树，不变更当前 manifest pin 或 allowlist。Seatbelt 在外层沙箱外实测可用，完整回归显式要求已验证的 Seatbelt，不能以嵌套沙箱为由静默跳过。

| 验证范围 | 结果 |
| --- | --- |
| `compat:check`、lint、typecheck、build | 通过；enforce 模式及原精确支持列表保持 |
| 当前基线完整 `test` | 67 文件通过 / 3 文件跳过，900 测试通过 / 84 跳过；包含真实 IPC 与独立进程 |
| `kernel:probe` | Seatbelt 真实受限命令可执行；bwrap/Landlock 本机无 runner |
| compose / behavior / journey | 52 / 136 / 76 通过，各 0 失败、0 跳过；web/headless 真实工具旅程 |
| `pack:check` / `smoke:packed` | 157 成员检查通过；tarball 安装后 behavior 135 通过 / 0 失败 / 0 跳过 |
| `auto-review:fork` / `smoke:auto-review` | fork 检查通过；可选集成按既有精确 `0.2.1-rc.2` 规则跳过 |
| `docs:check` | 0 错误 / 0 警告 |
| 最早支持版本 `0.1.5-rc.2`（Cordis `4.0.2`） | 隔离树 enforce compat、typecheck、build 通过；6 个接缝/共享/命令测试文件 86 通过 / 5 平台项跳过；behavior 128 / journey 76 通过，各 0 失败、0 跳过 |

旧版 fixture 显式放在仓库既有 `.dsh-smoke` 物理目录，使用 `DSH_TEST_FIXTURE_PARENT`；隔离 smoke 仅修改 fixture 路径，避免 `/tmp` 自带 write grant 和 symlink 拼写使断言失真。没有对生产接缝加入测试豁免、没有放宽 compat。最早版本证明同步 confine/旧执行器与公开 JSON/domain 适配的实际兼容，不代替其余版本矩阵。

确定性故障用例：独立进程并发同/异主根修改不丢数据；在 fs 真正解析处暂停已准入写，然后另一 Host 撤权，旧操作可完成、新写被拒；SIGKILL 后多个候选仅一个 owner，从磁盘恢复；旧 holder 重启成为 follower；SIGSTOP 时超时拒绝新操作但不夺锁。另覆盖广播丢失、已提交应答丢失不重放、断线后的新嵌套调用不继承旧 grant、新 epoch、unknown-state 保留 lease、原生 Skills change→requery 有界、读缓存撤权、指令显式撤回、空闲 Files 流断线取消、hello/change 同批读取，以及受限 macOS 子进程知道 endpoint 仍不能调用管理方法。

**尚未执行的验收**：Windows 原生 pipe/token/ambient deny 与 semaphore 多候选崩溃恢复；Linux 原生 SO_PEERPIDFD、NoNewPrivs 与 bubblewrap 攻击用例（已编入测试）；三平台 × 所有精确版本远端 CI；真实 dsh-tui 的多 Host 长期运行/Ubuntu OOM 报告环境复测。此变更未发布，也未宣称这些平台/版本已通过；原先 Issue #24 hot-fix 的 20 分钟观察不能作为新共享服务的长期内存证据。
