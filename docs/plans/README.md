# 开发计划（Plans）

English: [README.en.md](./README.en.md)

## 这里存放什么

大型开发任务的实施计划，例如：

- feature；
- refactor；
- migration；
- architectural change。

## 目录结构

```text
active/     正在执行或尚未开始的计划
completed/  已完成的计划
```

任务完成后，将计划从 `active/` 迁移到 `completed/`：

```text
active/
→
completed/
```

有长期参考价值的计划不应删除。

## 不应该存放什么

- 小型任务的临时 TODO；
- 已被放弃且无参考价值的草稿（可直接删除）；
- 正式设计文档（放入 `../architecture/` 或使用 `../../.agent/templates/design.md`）。

## 当前状态

active：

- [2026-11-22-remote-copy-stream-budget.md](./active/2026-11-22-remote-copy-stream-budget.md) — PR #73 Codex 评审 P2：`remote_copy` 的两条上传路径只在源绑定时检查 `maxBytes`，源在 `stat` 后增长时会把超限字节先写入远端 staging，再由 `source-changed` 收尾；修复为 `RemoteStage.write` 的累计写入前检查（`transfer-too-large`），两条上传循环共用，含红/绿回归与退出验收。

- [2026-11-16-sidebar-footer-row-alignment-and-coexistence.md](./active/2026-11-16-sidebar-footer-row-alignment-and-coexistence.md) — 侧栏 footer 入口的 workspace tree 图标与跨两代几何对齐（旧 19 版 / 新 5 版，分界 `0.2.2-alpha.2`；rail 圆角按其更早的 `0.1.6-alpha.2` 分界处理，22/24 对齐、最老 2 版已知偏差），以及同槽出现第二行时的纵向共存规则：一份带 fallback 的 CSS 配方、`:has()` 作用域的 slot anchor 纵向列、不隐藏/不读槽账本/不改他人行；含复刻取证、测试与文档清单。决策见 [ADR-0044](../decisions/ADR-0044-sidebar-footer-row-alignment-and-coexistence.md)。
- [2026-11-16-additional-root-preview-navigator-search.md](./active/2026-11-16-additional-root-preview-navigator-search.md) — 附加根文件预览右侧 Folder 导航树（FileTree）的工作区搜索：复用既有 `search` 端点与 `FilesPane`（新增 preview 模式），补齐结果当前行、隐藏项默认、设置回焦、焦点交接、Escape 顺序与旧宿主降级；DSH `0.2.2-rc.2` 起可用，Host 零改动。决策见 [ADR-0043](../decisions/ADR-0043-additional-root-preview-navigator-search.md)；**实施完成（P1–P4 已提交），P5 本机门禁与隔离环境交互目检完成（截图待维护者复核）**。

- [2026-11-15-files-page-takeover-notice.md](./active/2026-11-15-files-page-takeover-notice.md) — Issue #47 限定范围：Files 页被第三方插件整页接管时，以官方瞬时 Toast（info 级、无警告图标、数秒消失）弹一次提示；检测经 `sidebarRightTabs.get('files')` 的生效实现（不依赖 `slots.inject`/`spec`），不含对话框/命令文案与 fallback 入口；含进入/退出验收机制。决策见 [ADR-0015](../decisions/ADR-0015-files-tab-plugin-owned-browsing.md#修订files-页被整页接管时的可见提示2026-11-15)。

- [2026-11-15-worktree-toast-close.md](./active/2026-11-15-worktree-toast-close.md) — 收回「没有单独关闭按钮」：在常驻提示右上角加回正圆「×」，圆心压在卡片角上并允许外凸；语义为纯关闭（不发 snooze/resolve、不写提醒状态，靠 `seen` 认领保证本 Host 不再自动提示）；决策见 [ADR-0039 第二十五次修订](../decisions/ADR-0039-worktree-aware-root-suggestions.md#第二十五次修订2026-11-15)。

- [2026-11-15-workspace-toast-implementation.md](./active/2026-11-15-workspace-toast-implementation.md) — Worktree 发现提示位置与形态重构的最终实施计划与退出验收：Hero 顶部居中 / 对话页 Header 下水平居中、主题自适应浅色/深色卡片、删除「×」并以「稍后提醒」Menu 关闭、primitives 控件、两行粗指针形态与官方 Toast 避让；决策见 [ADR-0039](../decisions/ADR-0039-worktree-aware-root-suggestions.md#第二十一次修订2026-11-15)。

- [2026-11-15-workspace-toast-placement.md](./active/2026-11-15-workspace-toast-placement.md) — 上述重构的需求同步、现状缺点分析（位置遮挡、控件混用、a11y、浮层配方）与初始修改意见，2026-11-15 评审完成。

- [2026-11-15-worktree-dialog-redesign.md](./active/2026-11-15-worktree-dialog-redesign.md) — Worktree 确认 Dialog 加宽、候选连续列表、删除 inherit 说明行、逐行权限选择器（默认 inherit，扩 `accesses` 契约与 Registry grant）、Git 分支展示与 footer primitives 下拉；决策见 [ADR-0039](../decisions/ADR-0039-worktree-aware-root-suggestions.md#第二十二次修订2026-11-15)。

- [2026-11-15-worktree-review-fixes.md](./active/2026-11-15-worktree-review-fixes.md) — PR #60 评审修复：follower 的 `addNew` IPC 接受 `read-only`/`read-write`、Files 管理器透传 Worktree 手动入口 props、复用候选记录时刷新主 checkout 分支展示（`mainHead` 仍不参与授权）；含核验账本与退出验收机制。

- [2026-11-14-hero-entry-adaptive-width.md](./active/2026-11-14-hero-entry-adaptive-width.md) — 新会话 Hero 入口按行内可用宽度自适应：探针测量行内剩余空间、`max-width` 夹取到余量、余量 < 88px 退化为 28×28 图标；不改 DSH、探针失败回落到 `v0.1.19` 形态。决策修订见 [ADR-0037](../decisions/ADR-0037-conversation-hero-workspace-folders-entry.md)。

- [2026-11-09-worktree-aware-root-suggestions.md](./active/2026-11-09-worktree-aware-root-suggestions.md) — P1–P7 实施 worktree 附加根建议、实验性默认关闭的插件开关与手动清理（B），P8–P10 实施 linked worktree 的主 checkout 授权（A）；第十九次修订加入单/多候选提示分流。决策见 [ADR-0039](../decisions/ADR-0039-worktree-aware-root-suggestions.md)，进度见路线账本；随 `v0.1.17` 发版。

- [2026-11-08-workspace-menu-folders-dialog.md](./active/2026-11-08-workspace-menu-folders-dialog.md) — 工作区 `...` 菜单新增「管理工作区目录…」：复用 footer 对话框的 controller、`workspace` context-menu 贡献（order 150）、先切换/复用目标工作区 blank 再打开并固定 session；`RootSwitcher` 与上游 `WorkspaceBrowser` 零改动（决策见 [ADR-0038](../decisions/ADR-0038-workspace-menu-folders-dialog.md)）。

- [Issue #32 多执行环境实施与验证计划](./active/2026-11-06-multi-environment-gates.md) — Accepted（外部评审通过，尚未实施）；含 PR 依赖、实施细节、故障注入与回滚验收。

- [2026-10-31-f4-background-recovery.md](./active/2026-10-31-f4-background-recovery.md) — F4 后台恢复与故障诊断专项计划（**rev.4 评审通过、ADR-0026 已立项；已实施并经三平台 CI 验收，真实 TUI soak 暂缓，随 `v0.1.13` 发版**）：复用 `ensureAuthority` 的恢复调度、投影同步完成条件、整轮失败通知原子性（含 scope 订阅者批处理）、握手本地取消与诊断面；批次已登记总账。

- [2026-10-30-shared-registry-authority.md](./active/2026-10-30-shared-registry-authority.md) — Issue #24 原始 Long-term 全目标、已发布基线与共享服务初版对照、六项 P1 审计、后续能力演进与退出条件；初版已随 `v0.1.12` 发版，剩余 Ubuntu 报告环境长跑复测与进度见总账。

- [2026-10-16-branch-security-review-and-hardlink-isolation.md](./active/2026-10-16-branch-security-review-and-hardlink-isolation.md) — 分支安全审查证据与拟议修复：负授权、Windows 祖先改名、pnpm 硬链接隔离；Phase A（R2/R3 负授权）、B（R1 祖先钉扎）、C1（全根硬链接预检）与 C2（`/workspace-folders isolate-profiles` 命令、迁移与冒烟）已实施并验收，随 `v0.1.7` 发版。

- [2026-09-12-multi-root-workspace.md](./active/2026-09-12-multi-root-workspace.md) — Multi-root Workspace 开发路径与**进度总账**：MVP `v0.1.0` 的 M1/M2/M3 已实施并发版；`v0.1.1` 硬化批次 H1–H4 已实施并随 `v0.1.1` 发版；`v0.1.2` 支持矩阵提升已实施并随 `v0.1.2` 发版；`v0.1.3` 支持矩阵提升（`0.1.7-alpha.2` / `0.1.7-rc.1`）已实施并随 `v0.1.3` 发版；`v0.1.4` 支持矩阵提升（`0.1.7-rc.2`）已实施并随 `v0.1.4` 发版；`v0.1.5`（DSH `0.2.0-rc.1` / `.2`）已发布；`v0.1.6`（DSH `0.2.1-alpha.1` / `.2`、B1–B3 与动态 cwd）已发布；`v0.1.7`（第二期 B 系列、Files 页签附加根浏览、DSH `0.2.1-alpha.3`–`0.2.1-rc.2`）已发布；`v0.1.8`（DSH 0.2.0 `permissionPresets/catalog` 修复）已发布；`v0.1.9`（Auto Review 主包内置可选行）已发布；`v0.1.10`（附属根 Skills、Workspace Folders 面板对齐与 DSH `0.2.1-rc.3`）已发布；`v0.1.11`（DSH `0.2.1-rc.4` 与 `0.2.2-alpha.2` 兼容提升、Issue #24 Registry／Skills 刷新循环 hot-fix）已发布；`v0.1.12`（多 Host 共享 Registry 权威、逐操作授权与 DSH `0.2.1-rc.5`）已发布；`v0.1.13`（F4 后台恢复与 Files 页签根选择修复）随该版本发版；`v0.1.14`（Issue #30 依赖单例修复与 koffi 宿主锚定、DSH `0.2.2-alpha.3`/`0.2.2-rc.1` 兼容提升、插件详情页设置卡 Auto Review 开关与富文本详情）随该版本发版；`v0.1.15`（`/add-dirs` 别名、根授权安全修复与 OPS 默认关闭的实验性兜底及开启风险确认）随该版本发版；`v0.1.16`（准入外受限 spawn 修复、面板会话存在性细分与预览页 Folder 导航树附加根接管）随该版本发版；`v0.1.17`（Worktree 附加根建议与 linked worktree 主 checkout 授权、新会话 Hero 与工作区菜单 Workspace Folders 入口、已批准的一次性 Full-access 提权）随该版本发版；`v0.1.18`（精确支持 DSH `0.2.2-rc.2`，Files 页签搜索纳入共享准入与根边界）随该版本发版；`v0.1.19`（精确支持 DSH `0.2.2-rc.3`，支持合同扩至 24 个精确版本）随该版本发版。`v0.1.20`（附加根 Files 行右键与工作区搜索、Auto Review 两代共 9 个精确发布的联合支持、Worktree 提示与确认 Dialog 重构、新会话 Hero 入口宽度自适应）随该版本发版。`v0.1.21`（附加根预览导航树的工作区搜索、Files 页接管提示、koffi 宿主提供、Worktree 关闭按钮与清理面板 UX 收敛、侧栏 footer 行几何对齐与同槽共存）随该版本发版。`v0.1.22`（Files 页头 RootSwitcher 窄宽让位与三档根名显示、精确支持 DSH `0.2.2-rc.4`）随该版本发版。`v0.1.23`（面板与详情页 8 语言本地化、8 语言根 README 与逐功能用户指南、贡献与安全治理、精确支持 DSH `0.2.2-rc.5`）随该版本发版。`v0.1.24-beta.1`（SSH 远端环境个人模式，实验性、默认关闭；Workspace Folders 附加根列表滚动修复）随该版本发版。`v0.1.24-beta.2`（SSH 依赖修复引导与 Helper 安装诊断）随该版本发版。


completed：

- [SSH 环境与 Workspace Root 绑定拆分](./completed/2026-11-20-ssh-environments-and-workspace-bindings.md) SSH 环境与 Workspace Root 绑定独立管理，含旧配置迁移与同环境多 Root 验证。

- [2026-11-19-ssh-add-connection-two-step.md](./completed/2026-11-19-ssh-add-connection-two-step.md) 前一版两步向导，已由连接与绑定拆分取代。

- [2026-11-17-files-rootswitch-narrow-width.md](./completed/2026-11-17-files-rootswitch-narrow-width.md) — Files 页头 `RootSwitcher` 的窄宽让位优先级：`Menu` 的 anchor 包装 span 是外层 flex item，缺 `min-width: 0` 时把触发器钉在内容 min-content，窄栏/双栏/浮动小窗下溢出压住 reload、搜索与 open-in-app；修复为「固定控件 → 完整路径 → 根名 → 触发器图标」三级收缩（anchor 解钉、路径 `flex: 1 1 0` 先让、触发器 `overflow: hidden`），已完成（2026-11-17）：focused/全量 client 测试、隔离 Web 宿主三工况 299/323/220 与附加根接管态的 DOM 量测与截图目检；随后追加 P5 三档根名显示（全名 → 前几个…后几个 → 开头…，自适应并优先按分隔符断开），含 `root-name-fit`/`root-name-room` 与真实 GUI 逐档证据。决策见 [ADR-0046](../decisions/ADR-0046-files-header-rootswitch-shrink-priority.md)。

- [2026-11-16-worktree-cleanup-panel-ux.md](./completed/2026-11-16-worktree-cleanup-panel-ux.md) — Workspace Folders 面板的 Worktree 清理 UX 收敛（R1–R4）已完成并验收（2026-11-16）：批量清理入口移到「附属工作目录」标题行、确认改为覆盖在面板上的 primitives `Modal`、`cleanupEligible` 行收敛为 标题/权限/路径 + 红色删除 + `...`、手动发现空结果用官方 info Toast；纯客户端呈现层变更，无授权/协议/宿主变更。证据见[路线账本](./active/2026-09-12-multi-root-workspace.md#worktree-清理面板-ux-收敛2026-11-16)，决策见 [ADR-0045](../decisions/ADR-0045-worktree-cleanup-panel-ui.md)。

- [2026-11-14-auto-review-multi-baseline.md](./completed/2026-11-14-auto-review-multi-baseline.md) — Auto Review 联合合同从单一 `0.2.1-rc.2` 扩展为两个源码基线的 9 个精确发布：按基线保存逐字节 fork、按车道动态加载、按编译 pin 做实现类型检查、跨代测试/冒烟/CI 门禁与文档收尾；已完成并通过本机与基线 A 车道验收，决策见 [ADR-0040](../decisions/ADR-0040-auto-review-multi-baseline.md)，证据见[路线账本](./active/2026-09-12-multi-root-workspace.md#auto-review-多基线适配2026-11-14)。

- [2026-11-13-ssh-management-dialog.md](./completed/2026-11-13-ssh-management-dialog.md) — 把 Workspace Folders 面板内联的 SSH 管理抽离为独立四 Tab 对话框（添加连接 / 已有连接 / SSH Key / 模式设置），工作区面板只保留远端工作区列表与新增/管理入口；平台显示 Linux / macOS，托管档位决定添加引导。已完成（2026-11-13）：本机静态门禁、smoke 与特性测试通过，[CI run 43447653166](https://github.com/cherrchen/dsh-plugin-multi-root-workspace/actions/runs/43447653166) 26/26 job success；后续 UI 控件修复按维护者指示只跑本地门禁，不重复触发 CI。

- [2026-11-08-workspace-folders-hero-entry.md](./completed/2026-11-08-workspace-folders-hero-entry.md) — 新会话 Hero 行的 Workspace Folders 增量入口：`conversation.hero.options` 注册、与相邻选择器同几何但无 chevron、`≤560px` 视口图标降级；侧栏入口保留。已完成（2026-11-08）并通过完整门禁，随 `v0.1.17` 发版；决策见 [ADR-0037](../decisions/ADR-0037-conversation-hero-workspace-folders-entry.md)。

- [2026-11-05-root-authorization-security-fixes.md](./completed/2026-11-05-root-authorization-security-fixes.md) — 根授权安全修复限定范围完成：BYP-02、MRW-01、受保护目录登记边界与共享模式必填；排除项保留，实施证据和发布状态见[进度总账](./active/2026-09-12-multi-root-workspace.md#进度总账)。

- [2026-11-01-ops-compatibility-adaptation.md](./completed/2026-11-01-ops-compatibility-adaptation.md) — OPS 实验性保守兜底 P0–P6 限定范围实施与最终验收；P5 完整兼容恢复无限期延后，功能默认关闭，状态和证据见进度总账。

- [2026-10-23-multi-root-skills.md](./completed/2026-10-23-multi-root-skills.md) — ADR-0023 的 S1–S7 实施依赖、任务与退出条件：Registry、Session 发现与 native cwd 旁路、按需调用、缓存/RPC、Web/Settings 和完整发布验收；已实施并随 `v0.1.10` 发版，证据见路线账本。
- [2026-10-20-auto-review-in-package-review.md](./completed/2026-10-20-auto-review-in-package-review.md) — Auto Review 并入主包的需求评审：逐项可行性、loader 最小验证、接管与恢复边界、待验证合同及验收条件；已实施并随 `v0.1.9` 发版。
- [2026-10-18-auto-review-context-adaptation.md](./completed/2026-10-18-auto-review-context-adaptation.md) — Auto Review 多根上下文适配（Phase 0–2）：显式 companion fork、同源权限投影、当前约束、联合验证与正式接口迁移边界；状态和证据见路线账本。
- [2026-10-13-b9-root-access-and-sandbox-modes.md](./completed/2026-10-13-b9-root-access-and-sandbox-modes.md) — B9 专项计划：附加根继承 / 只读 / 读写与跨 SandboxMode 执行一致性；包括迁移、进程入口、内核能力验证与验收方案。进度与发布状态见进度总账。
- [2026-09-12-m1-composition-and-passthrough.md](./completed/2026-09-12-m1-composition-and-passthrough.md) — M1 开发计划：bundle 骨架、两行 provider 替换、空根直通（2026-09-12 实施完成并验证，随 `v0.1.0` 发版）。
- [2026-09-12-m2-additional-roots-and-dialect-grants.md](./completed/2026-09-12-m2-additional-roots-and-dialect-grants.md) — M2 开发计划：方言 grant 拼接、parity 矩阵、拓扑快照与多根冒烟（2026-09-12 实施完成并验证，随 `v0.1.0` 发版）。
- [2026-09-12-m3-root-registry-command-and-ui.md](./completed/2026-09-12-m3-root-registry-command-and-ui.md) — M3 开发计划：root 注册表与持久化、`/workspace-folders` 命令、浏览器 Folders 面板、跨 repo 旅程 e2e（2026-09-12 实施完成并验证，随 `v0.1.0` 发版）。
- [2026-09-15-m4-registry-authority-lease.md](./completed/2026-09-15-m4-registry-authority-lease.md) — v0.1.1 批次 H1（路线图 M4）：跨进程 Registry Authority Lease（2026-09-15 实施完成，随 `v0.1.1` 发版）。
- [2026-09-15-panel-session-derived-authority.md](./completed/2026-09-15-panel-session-derived-authority.md) — v0.1.1 批次 H2：面板主根改为 host session 推导，删除客户端 `primaryRoot`（2026-09-15 实施完成，随 `v0.1.1` 发版）。
- [2026-09-15-dsh-compat-contract.md](./completed/2026-09-15-dsh-compat-contract.md) — v0.1.1 批次 H3 + H4 Phase 1：DSH 兼容性变成启动时执行的代码契约，并把 `0.1.6-alpha.1` 与附加根顶层指令注入一并纳入（2026-09-15 实施完成，随 `v0.1.1` 发版）。
- [2026-09-15-v0.1.1-review-rework.md](./completed/2026-09-15-v0.1.1-review-rework.md) — v0.1.1 批次发版前的 PR #1 评审返工（2 项 P1 + 3 项 P2）：authority 拆除顺序（排空 → close → release）、中间目录指令可达、`warn` 只放宽 `unsupported`、两个可选 peer 按需加载、缺失与求值失败分离（2026-09-15 实施完成，随 `v0.1.1` 发版）。
- [2026-10-12-files-header-root-browsing.md](./completed/2026-10-12-files-header-root-browsing.md) — Files 头部根浏览：P1 仅图标齿轮 launcher 前移，P2 根选择器 portal 接管树区，P3–P10 目检修正，P11 接管树换为逐字节复刻的上游 Files 树（`src/client/files-tree/`，自绘树与私有 `files`/`readFile` 端点下线；2026-10-12 实施完成，随 `v0.1.7` 发版；决策见 ADR-0015）。

### 编号口径

- **M1–M4** 是 MVP 路线图的里程碑编号（M4 = 跨进程 lease）。
- **H1–H4** 是 `v0.1.1` 硬化批次的编号：H1 = M4、H2 = 面板权威、H3 = 兼容性契约、H4 = 附加根指令（Phase 1 顶层 + Phase 2 nested 均已做）。
- **B 系列** 是第二期任务编号；B9 的实施阶段不另占 B 编号。
- 唯一真源：[路线图的进度总账](./active/2026-09-12-multi-root-workspace.md#进度总账)。

## 推荐命名

使用小写中划线命名，例如：

```text
YYYY-MM-DD-<short-title>.md
```

可参考 `.agent/templates/plan.md` 模板。
