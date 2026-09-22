# 开发路径文档：Multi-root Workspace（不改上游）

> 状态：active（**进度总账 + 里程碑概览**）。MVP-v0.1.0（M1/M2/M3）已实施并以 `v0.1.0` 发版（2026-09-13）；v0.1.1 硬化批次（H1–H4）已实施、全绿并随 `v0.1.1` 发版（2026-09-16）；第二期（B 系列）范围见[需求文档 §4/§7](../../requirements/multi-root-workspace.md)。
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

### 支持矩阵提升（未发版，2026-09-22）

`0.1.6-alpha.2` 按 [ADR-0009](../../decisions/ADR-0009-dsh-compat-contract.md) 的人工提升流程写入 allowlist（`peerDependencies` 同步为三项精确或）。开发 pin 与 lockfile 仍是 `0.1.5-rc.2`。`confine` 仍是带可选 `signal` 的 `Promise`，instruction renderer 仍是 `renderAgentInstructions`，journey 的 Messages 端点未改。**客户端 Session 目录删掉了 `current`**，面板必须走 `src/compat/client-session.ts` 同时认旧的 `list.current` 与新的 `retainedBy.mainView`。用户可见变更记在 [CHANGELOG](../../../CHANGELOG.md) 的 Unreleased。

| 项 | 结果 |
|---|---|
| 纳入前（pin 在 `0.1.6-alpha.2`，`DSH_MULTI_ROOT_COMPAT=warn`） | `pnpm verify:all` 全绿：321 passed / 3 skipped，compose 40/40，behavior 99/99，journey 55/55。macOS，seatbelt 可用，bwrap / landlock 不可用 |
| 纳入后 enforce（同一棵 `0.1.6-alpha.2` 树） | `pnpm compat:check` + `pnpm verify:all` 全绿，计数相同 |
| 基线回归（pin 回到 `0.1.5-rc.2`，enforce） | `pnpm compat:check` + `pnpm verify:all` + `pnpm docs:check` 全绿，计数相同 |

### 支持矩阵提升（未发版，2026-09-22）：`0.1.7-alpha.1`

`0.1.7-alpha.1` 按 [ADR-0009](../../decisions/ADR-0009-dsh-compat-contract.md) 的人工提升流程写入 allowlist（`peerDependencies` 同步为四项精确或）。开发 pin 与 lockfile 仍是 `0.1.5-rc.2`（cordis 仍是 `4.0.2`）。`confine` 与 instruction renderer 的形状没变，journey 仍走 `/v1/messages`。客户端 Session 目录与 `0.1.6-alpha.2` 一样没有 `current`，面板继续走 `src/compat/client-session.ts` 的 `retainedBy.mainView` 探针。适配层有改动：session format 4 拒绝 `kind: 'plugin'`（改投 `multi-root-workspace`）、工具失败位移到消息上、面板图标改为 Regular、进程内启动改为 `PluginPackages`、bash 改为 `execute().result()`。探测时 cordis 必须钉到 `4.0.3`，否则两份 `dsh-tools` 让调度 Symbol 对不上。用户可见变更记在 [CHANGELOG](../../../CHANGELOG.md) 的 Unreleased。

| 项 | 结果 |
|---|---|
| 纳入前（pin 在 `0.1.7-alpha.1`，cordis `4.0.3`，`DSH_MULTI_ROOT_COMPAT=warn`） | `pnpm verify:all` 全绿：329 passed / 3 skipped，compose 40/40，behavior 99/99，journey 55/55。macOS，seatbelt 可用，bwrap / landlock 不可用（rebase 前、尚未带 `client-session`） |
| 纳入后 enforce（同一棵 `0.1.7-alpha.1` 树） | `pnpm compat:check` + `pnpm verify:all` 全绿，计数相同 |
| 基线回归（pin 回到 `0.1.5-rc.2`，cordis `4.0.2`，enforce） | 同一次数：测试 329 passed / 3 skipped，compose 40/40，behavior 99/99，journey 55/55。`pnpm docs:check` 通过 |
| rebase `main` 后重跑（含 PR #4 的 Session 目录探针，2026-09-22） | 0.1.7 客户端目录仍无 `current`，`retainedBy.mainView` 谓词未变。enforce 在 `0.1.7-alpha.1` + cordis `4.0.3` 与基线 `0.1.5-rc.2` + cordis `4.0.2` 上都是 343 passed / 3 skipped，compose 40/40，behavior 99/99，journey 55/55。`pnpm docs:check` 通过 |

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
