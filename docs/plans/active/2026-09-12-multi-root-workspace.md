# 开发路径文档：Multi-root Workspace（不改上游）

> 状态：active（**进度总账 + 里程碑概览**）。MVP-v0.1.0（M1/M2/M3）已实施并以 `v0.1.0` 发版（2026-09-13）；v0.1.1 硬化批次（H1–H4）已实施、全绿并随 `v0.1.1` 发版（2026-09-16）；v0.1.2 支持矩阵提升（`0.1.6-alpha.2`、`0.1.7-alpha.1`）已实施并随 `v0.1.2` 发版（2026-09-22）；v0.1.3 支持矩阵提升（`0.1.7-alpha.2`、`0.1.7-rc.1`）已实施并随 `v0.1.3` 发版（2026-09-24）；v0.1.4 支持矩阵提升（`0.1.7-rc.2`）已实施并随 `v0.1.4` 发版（2026-09-25）；v0.1.5 DSH 0.2 支持矩阵提升已完成发版准备（2026-09-30，待打 tag）；第二期（B 系列）范围见[需求文档 §4/§7](../../requirements/multi-root-workspace.md)。
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
| v0.1.5 | compat | DSH 支持矩阵扩展至 `0.2.0-rc.1` / `0.2.0-rc.2`，开发 pin 升级，全部支持版本 × OS 的持续矩阵 | [本次记录](#dsh-02-兼容提升2026-09-30) | [0009](../../decisions/ADR-0009-dsh-compat-contract.md) | `135af7f` | 发版准备完成，待打 tag |
| 第二期 | B 系列 | Windows 内核级多根、per-root 权限、`workspace-files` 多根、LSP 路由等 | 见[需求文档 §4/§7](../../requirements/multi-root-workspace.md) | — | — | 未开始 |

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
| 6 | Windows 内核级多根缺失（pwsh 方言） | Windows bash 场景 | 第一期 fs fence 覆盖 Windows 写路径；非空 scope 下 `confine` 保持上游 wrap 并输出一次告警，文档明示限制；列入第二期（见需求 §4/§7） |
| 7 | `isPathUnder` 等价实现的正确性 | fence 语义漂移 | 深导入不可用（发布包不含 `src/`，ADR-0002）⇒ 本地实现 + 注明出处 + M1 差分 parity 套件钉住；M2 起另由方言矩阵复验 |
| 8 | 拓扑快照进入 context 对 prompt cache 的影响 | 长会话成本 | 已落地：空根 / 只读 / 无 agent 时零输出（逐字节快照断言）；根集变化频率 = 用户增删根频率，可接受 |
| 9 | ~~nested roots 态度未最终拍板~~（已关闭） | — | 已拍板**拒绝**（[ADR-0004](../../decisions/ADR-0004-root-registry-persistence-and-validation.md)） |
| 10 | 桌面端（apps/desktop）插件安装形态与 CLI profile 的差异 | M3 e2e | 已安装桌面 app 用的是 `web` profile（其自带 runtime 0.1.2-rc.1）；M3 的面板因此落在两个运行时都有的 `sidebar.footer.action` 上，Electron 车道仍未建立（人工验证） |
| 11 | Linux CI 上 bwrap 可能不可用（用户命名空间受限） | 真实执行用例被跳过 | 内核链有第二个 rung（Landlock）；矩阵与冒烟只在 runner 真的不可用时显式 skip，并在输出里说明原因，不把"没跑"记成通过 |
| 12 | ~~附加根 nested instructions 未实现（H4 Phase 2）~~（已关闭） | — | 已实现（H4 Phase 2）：触碰取自持久化的 `session/event`（`tool/call` + `tool/result` 配对，只认成功的 `read` / `write` / `edit`），不使用 `SessionMessageProjection`；语义与边界见 [ADR-0010](../../decisions/ADR-0010-additional-root-instruction-scope.md) |
| 13 | 触碰识别只覆盖 `read` / `write` / `edit` | 其他写文件工具（`str_replace_editor` 等）触碰的目录不会立刻发现其 nested 指令 | 记录为已知限制（需求文档 §5「已知限制」、README 已知限制）；上游同样只认这三个名字，扩大集合需要先有让插件识别工具类别的 seam |
| 14 | 桌面端自带的旧 runtime（`0.1.2-rc.1`）不在 `v0.1.1` 的 allowlist 上 | 已安装的桌面端在升级自带 runtime 之前，插件的四行**不启动**（fail loud，组合退化为"未装插件"），即相对 `v0.1.0` 的功能回退 | 属 [ADR-0009](../../decisions/ADR-0009-dsh-compat-contract.md) 有意的收窄（范围承诺换成了实测清单）；已在 [CHANGELOG](../../../CHANGELOG.md) / [README](../../../README.md) 的「升级注意 / 环境要求」里明示，桌面端升级自带 runtime 后自动恢复；Electron 车道仍未建立 |
| 15 | 生产依赖 `koffi`（Windows lease 的 FFI）带构建脚本，pnpm ≥10 默认不运行它 | 四种安装来源的**第一次** `dsh plugin add` 都会失败一次（可恢复：回答 profile 里留下的 `allowBuilds` 待决项）；`v0.1.0` 只在 git 来源有这一步 | 已写入 [README §安装](../../../README.md)、[CHANGELOG 升级注意](../../../CHANGELOG.md) 与[故障排查：安装停在构建授权](../../troubleshooting/install-stops-at-build-approval.md)。根治要重新设计 Windows Authority 的原生依赖（例如按需可选加载），属第二期 |

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
| 发布状态与 CHANGELOG | 路线账本登记为 `v0.1.5` 待打 tag；README（中英）的支持版本、tarball 与 tag 示例对齐 `v0.1.5`；[`CHANGELOG.md`](../../../CHANGELOG.md) / [`CHANGELOG.en.md`](../../../CHANGELOG.en.md) 新增 `0.1.5` 条目 |
| 本地门禁 | frozen install、`compat:check`、lint、typecheck、build、`test`（347 passed / 4 skipped）、`smoke:compose` 40/40、`smoke:behavior` 91/91（4 项真实内核断言因宿主无可用 runner 跳过）、`smoke:journey` 52/52（2 项真实内核断言同因跳过）、`docs:check` 通过；`verify:all` 退出码 0（2026-09-30，macOS） |
| 跨平台矩阵 | 上方 PR #6 记录的 CI run `36690954880` 已验证九个 DSH 版本 × Linux / macOS / Windows，共 27 个 verify job 全绿；Windows 车道按既有范围不运行 POSIX 冒烟或内核断言 |

版本号仍为 `0.1.4`，尚无 `v0.1.5` tag；正式发版提交由 `pnpm release patch --tag` 产生。
