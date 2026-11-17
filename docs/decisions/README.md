# 决策记录（Architecture Decision Records）

English: [README.en.md](./README.en.md)

## 这里存放什么

Architecture Decision Records（ADR），用于记录重要架构与工程决策：

- Context（背景）；
- Decision（决策）；
- Alternatives（备选方案）；
- Consequences（影响）。

## 不应该存放什么

- 原始讨论或尚未整理成可评审 ADR 的提案（已形成明确产品规则、架构仍待验证的 ADR 可标为 Proposed）；
- 日常开发计划（放入 `../plans/`）。

## 当前状态

- [ADR-0001-provider-replacement-scope.md](./ADR-0001-provider-replacement-scope.md) — 只替换 `fs-sandbox` 与 `sandbox` 两个 provider 行（Accepted）。
- [ADR-0002-upstream-coupling-policy.md](./ADR-0002-upstream-coupling-policy.md) — 上游耦合策略：只允许包入口导入、精确 pin 版本、升级 smoke（Accepted）。
- [ADR-0003-dialect-grant-widening.md](./ADR-0003-dialect-grant-widening.md) — 方言 grant 拼接策略：结构识别 + 观测克隆 + 已授予跳过 + 识别失败即抛错（Accepted）。
- [ADR-0004-root-registry-persistence-and-validation.md](./ADR-0004-root-registry-persistence-and-validation.md) — Root 注册表：以 canonical 主根为键的 domain KV、校验顺序、嵌套拒绝、missing 不授予、存储损坏降级（Accepted）。
- [ADR-0005-out-of-tree-client-transport.md](./ADR-0005-out-of-tree-client-transport.md) — 出树 client 半部：Connection RPC 通道 + `sidebar.footer.action` 面板 + 复用上游目录选择能力，不用 Typert 远程命名空间（Accepted）。
- [ADR-0006-client-ui-host-tokens.md](./ADR-0006-client-ui-host-tokens.md) — 客户端 UI 复刻宿主原生样式：注入样式表消费宿主 `--dsw-*` token，插件零硬编码颜色（Accepted；2026-11-16 修订：确认层 `Modal`/瞬时 `Toast` 可直接 import primitives，见决策 7）。
- [ADR-0007-registry-authority-lease.md](./ADR-0007-registry-authority-lease.md) — 跨进程 Registry Authority：store-wide 内核 lease、争用 fail-closed、`refresh()` 接管（Accepted）。
- [ADR-0008-panel-session-derived-authority.md](./ADR-0008-panel-session-derived-authority.md) — 面板主根由 host session cwd 推导：删除客户端 `primaryRoot`，每个端点要求有效 `sessionId`（Accepted）。
- [ADR-0009-dsh-compat-contract.md](./ADR-0009-dsh-compat-contract.md) — DSH 兼容性代码契约：精确版本 allowlist、`multi-root-compat` 启动门禁、混装 fail loud、`src/compat/` 适配层、按周升级车道不自动扩大矩阵（Accepted）。
- [ADR-0010-additional-root-instruction-scope.md](./ADR-0010-additional-root-instruction-scope.md) — 附加根指令注入：顶层 + 本会话工作过的子目录、以 user-role 的 `form=instructions` 经 `agent/pre-step` 投递、预算全局共享、根离场显式撤销、文件消失显式撤回（Accepted）。
- [ADR-0011-multi-root-workspace-consumers.md](./ADR-0011-multi-root-workspace-consumers.md) — LSP 公共查询路由、Windows root-set SID runner、workspace-files 隔离与附加根文件树（Accepted）。

不要提前创建空的 ADR 文件；仅在做出真实决策时新增。

- [ADR-0012-session-origin-and-effective-cwd.md](./ADR-0012-session-origin-and-effective-cwd.md) — Session 原始项目与 effective cwd 分离、LSP 调用身份、指令 touch、Worktree 与进程快照（Accepted）。
- [ADR-0013-per-root-and-per-tool-access.md](./ADR-0013-per-root-and-per-tool-access.md) — 每根 read-write/read-only 访问级别的持久化编码（domain v1、降级 fail closed）、`setAccess` 升级门槛、Windows root-set SID、`toolAccess` per-tool 封顶与 ALS dispatch 上下文（Accepted）。
- [ADR-0014-root-limit-and-provider-conflict.md](./ADR-0014-root-limit-and-provider-conflict.md) — 每主根存储记录上限（默认 16、顶 64、超限存量照授）与 `multi-root-providers` 品牌门禁（外来 `ctx.fs`/`ctx.sandbox` fail closed）（Accepted）。
- [ADR-0015-files-tab-plugin-owned-browsing.md](./ADR-0015-files-tab-plugin-owned-browsing.md) — Files 页签根选择器：原生树不可重指，故经 `createPortal` 接管树区（现挂 `files-tree/` 逐字节复刻的上游 Files 树），`data-files-*` 钩子失效即静默退化（Accepted，2026-10-12 修订）。
- [ADR-0016-files-tab-native-tree-fork.md](./ADR-0016-files-tab-native-tree-fork.md) — 附加根树逐字节复刻上游 `ui-sidebar-files` 树体（外壳函数换根源、store/inject 声明、`workspaceFiles` 数据通路、私有 `files`/`readFile` 端点随之下线），替代自绘 `RootFileTree`（Accepted）。
- [ADR-0017-three-state-root-access-and-sandbox-modes.md](./ADR-0017-three-state-root-access-and-sandbox-modes.md) — B9 附加根三态权限（inherit/read-only/read-write）九格矩阵、`readWriteRecordedPath` 持久化编码、shell/pwsh/PTY/PTC 消费侧公开方法接缝（ALS + env 会话标记）、各方言受限 profile 构造与 Windows 单 SID 边界（Accepted，Phase 1 定案）。
- [ADR-0018-windows-ambient-write-denial.md](./ADR-0018-windows-ambient-write-denial.md) — B9 Windows Full-access 局部拒写：ambient deny token、显式 ACL、防 owner / parent / token 旁路、standing ACE 与 partial 边界（被 ADR-0019 替代）。
- [ADR-0019-windows-token-attributes-and-conditional-acls.md](./ADR-0019-windows-token-attributes-and-conditional-acls.md) — 替代 ADR-0018 的限制 SID 方案：继承的 mandatory local token attribute + 条件 deny ACE，让取交集后的 token 副本仍拒写，保留 PowerShell 身份查询；原生属性已读回但条件未兑现拒写，替代方案见 ADR-0020（Superseded）。
- [ADR-0020-windows-normal-deny-groups.md](./ADR-0020-windows-normal-deny-groups.md) — 铸造镜像调用方身份、仅增加普通 deny-only 组的 token，以普通 deny ACE 避开 local 属性条件；保留弱化 token 实际写入验证（Accepted）。

- [ADR-0021-auto-review-context-companion.md](./ADR-0021-auto-review-context-companion.md) — 可选 Auto Review companion、同源工具权限预览、当前约束快照、native 重叠与失败关闭、fork 同步（Accepted）。

## 推荐命名

```text
ADR-0001-short-title.md
ADR-0002-short-title.md
```

编号递增，标题使用小写中划线。ADR-0030–0034 已预留给 Issue #32，因此主线在 ADR-0029 后从 ADR-0035 起编号。合并 main 后，SSH 凭据代理与托管模式分别使用 ADR-0048 和 ADR-0049（分支原编号为 0040 和 0041）。新增 ADR 前扫描全部分支确认编号可用。

- [ADR-0022-auto-review-loader-entry.md](./ADR-0022-auto-review-loader-entry.md) — Auto Review 并入主包：默认关闭的单一 loader 行、运行时接管、并发导入防护、有序 owner 交接与单包构建（取代 ADR-0021 的交付结构）。

- [ADR-0023-multi-root-skill-discovery-and-invocation.md](./ADR-0023-multi-root-skill-discovery-and-invocation.md) — 附加根 Skills：登记权限初始化开关、aliasId 命名空间、可信 Session scope、原生内部 ID 桥接、Effective CWD 发现路由、Settings 与迁移边界（Accepted，架构定案，功能待实施）。

- [ADR-0024-registry-operation-admission.md](./ADR-0024-registry-operation-admission.md) — 操作准入与撤权顺序、允许在飞操作完成（Accepted）。

- [ADR-0025-shared-registry-authority.md](./ADR-0025-shared-registry-authority.md) — 多 Host 共享权威服务、IPC 权限隔离、同步消费与失败关闭接管（Accepted）。

- [ADR-0026-registry-background-recovery.md](./ADR-0026-registry-background-recovery.md) — Registry 权威后台恢复与故障诊断：结构化重试资格、恢复调度不变量、投影同步完成条件、scope 真值签名与提交通知原子性、握手本地取消、诊断面（Accepted，合同定案，功能待实施）。

- [ADR-0027-revive-target-and-protected-paths.md](./ADR-0027-revive-target-and-protected-paths.md) — revive 不改变授权目标；`$DSH_HOME`、Registry 介质与 lease 目录的登记边界与存量 withheld（Accepted，P1 合同）。

- [ADR-0028-upstream-primary-identity-and-shared-only-registry.md](./ADR-0028-upstream-primary-identity-and-shared-only-registry.md) — 主根身份以上游拼写为准（MRW-01），拒写优先于主根；Registry 只保留共享模式（Accepted）。

- [ADR-0029-ops-file-authorization-and-activity-adapter.md](./ADR-0029-ops-file-authorization-and-activity-adapter.md) — OPS 实验性保守兜底、Phase A live 与受限 Review 的限定接受范围；P5 完整兼容恢复无限期延后，不纳入本次最终验收。

- [ADR-0035-unadmitted-confined-spawn.md](./ADR-0035-unadmitted-confined-spawn.md) — 准入外受限 spawn：铸造台账（铸造时发布代次键控、进程内有界、过期帧不落账）恢复「仅主根可写」降级，外部服务入口（forgePanel/worktrees）照常取真准入；OPS 域与保护窗口对台账 mint 一律严格（Accepted）。

- [ADR-0036-approved-escalation-override.md](./ADR-0036-approved-escalation-override.md) — 用户单次批准的一次性 `danger-full-access` 提权只对该调用解除只读根与 per-tool 封顶拒绝（`$DSH_HOME` 与 authority-unavailable 除外）；standing Full-access、嵌套/后续调用与 OPS 派发不受影响（Accepted）。

- [ADR-0037-conversation-hero-workspace-folders-entry.md](./ADR-0037-conversation-hero-workspace-folders-entry.md) — 新会话 Hero 行的 Workspace Folders 增量入口：`conversation.hero.options`（`0.2.1-alpha.3+`）注册、与相邻选择器同几何但无 chevron、会话权威取槽属性；侧栏 `Folders` 入口保留，退役 Deferred。**2026-11-14 修订**：`.heroOptions` 是 `flex: none`，入口改为实测行内可用余量并夹取（余量 < 88px 只留图标），视口断点仅作探针失败时的兜底（Accepted，已实施并验证）。

- [ADR-0038-workspace-menu-folders-dialog.md](./ADR-0038-workspace-menu-folders-dialog.md) — 工作区 `...` 菜单的「管理工作区目录…」入口：经 apply 作用域的 dialog controller 复用 footer 对话框，当前 session 属于目标时直接打开、否则先经 `uiWorkspace.openWorkspace` 切换并确认 current；服务缺失置灰，`RootSwitcher` 零改动（Accepted，实施见计划）。

- [ADR-0039-worktree-aware-root-suggestions.md](./ADR-0039-worktree-aware-root-suggestions.md) — 先做 worktree 附加根建议与手动清理（B），再做 linked worktree 的主 checkout 授权（A）。共用实验性、默认关闭的插件设置；提示按可见候选数量分流为单确认或勾选列表。Accepted，2026-11-16 第二十六次修订；实施状态见路线账本。面板清理确认、`cleanupEligible` 徽标/副行呈现、路径复用提示位置拟由 [ADR-0045](./ADR-0045-worktree-cleanup-panel-ui.md)（Proposed，接受后生效）取代，授权、分类与生命周期结论不变。

- [ADR-0040-auto-review-multi-baseline.md](./ADR-0040-auto-review-multi-baseline.md) — Auto Review 联合合同从单一精确发布扩展为两个源码基线的 9 个精确发布：按基线保存逐字节 fork、按车道动态加载、按编译 pin 做实现类型检查、alpha.2 请求身份例外与约束插入位置（Accepted，修订 ADR-0021/0022 的单基线结论）。

- [ADR-0041-additional-root-workspace-search.md](./ADR-0041-additional-root-workspace-search.md) — 附加根工作区搜索：上游 wire 无法命名根，故在插件通道上新增 `search` 端点（rootId 由刷新后的 Registry 解析、单次主根准入、帧内复核授予）；客户端按 `workspaceFiles.search` 结构门控，状态按 (tab, root) 存 inject product，偏好沿用上游 localStorage 键；旧宿主零影响（Accepted，实施见计划）。

- [ADR-0042-additional-root-row-context-menus.md](./ADR-0042-additional-root-row-context-menus.md) — 附加根 Files 行右键菜单与 viewer 置灰：结构读取根级 `useContextMenu` 并把 `rowTriggerProps`/`canOpen` 转发进宿主 Factory（旧行同语义），target 用绝对路径；不新增 `ui-context-menu` 依赖（upgrade 矩阵会改写 devDep 致老 lane 安装失败）（Accepted，实施见计划）。

- [ADR-0043-additional-root-preview-navigator-search.md](./ADR-0043-additional-root-preview-navigator-search.md) — 附加根文件预览导航树的工作区搜索：复用 ADR-0041 的 `search` 端点与 Files 页搜索面（`FilesPane` 新增 preview 模式），接管期由插件面替代原生搜索栏（原生搜索根固定为 Session cwd）；结果当前行、隐藏项默认、设置回焦与焦点交接对齐原生；同批修复 `RootSwitcher` 换根搜索的过渡帧缺陷；旧宿主与主根零变化（Accepted，2026-11-16 外部评审 F1–F3 已并入；实施见计划）。
- [ADR-0044-sidebar-footer-row-alignment-and-coexistence.md](./ADR-0044-sidebar-footer-row-alignment-and-coexistence.md) — 侧栏 footer 入口改用 workspace tree 字形；一份「宿主 token + 旧值 fallback」的配方同时对齐 19 个旧几何版本与 5 个新几何版本（分界 `0.2.2-alpha.2`）；rail 圆角按其更早的 `0.1.6-alpha.2` 分界处理（22/24 对齐，最老 2 版已知偏差）；本入口挂载期间把 `sidebar.footer.action` 的 slot anchor 改为纵向列，使同槽第二行各占一整行（不隐藏、不读槽账本、不改他人行；让位方案与原因见 ADR 正文）；修订二让按钮高度跟随可见设置行 occupant（`0.2.0-rc.1` 起账号 launcher 未登录 32 / 登录 44，旧代 42 回退，rail 36），使 footer 两行 hover 药丸同尺寸（Accepted，实施见计划）。

- [ADR-0046-files-header-rootswitch-shrink-priority.md](./ADR-0046-files-header-rootswitch-shrink-priority.md) — Files 页头 `RootSwitcher` 的窄宽让位优先级：收缩能力必须写在参与 header 外层 flex 的 `Menu` anchor 包装上（`min-width: 0`）；固定控件不动，完整路径以零 basis 先让到 0，根名随后省略，触发器图标最后裁剪。取代「只给内层按钮写 `min-width: 0`」的无效写法；24 个受支持发布的 `Menu.className` 逐 tag 核对，无版本分支（Accepted，实施见计划）。

- [ADR-0045-worktree-cleanup-panel-ui.md](./ADR-0045-worktree-cleanup-panel-ui.md) — Workspace Folders 面板的 Worktree 清理 UI 与失效行收敛：批量清理入口移到「附属工作目录」标题行、确认改为覆盖在面板上的 primitives `Modal`、`cleanupEligible` 行只留标题/权限/路径 + 红色删除 + `...`（移除技能/reveal/重新登记与行内提示，路径复用披露移入确认层）、手动发现空结果用官方 info Toast；取代 ADR-0039 §3.2 的 deletion 徽标呈现（仅 cleanupEligible 行）、§6.2 的徽标/副行呈现与确认形态、§6.5 的提示位置与 Alternatives 的清理弹窗否决（Proposed；外部技术评审 2026-11-16 通过、无阻断项，转 Accepted 由维护者决定）。

## Issue #32 · 多执行环境架构决策

- [ADR-0030](./ADR-0030-environment-and-root-identity.md) — 一个 Session 的环境身份、根登记和有序准入 (Accepted).
- [ADR-0031](./ADR-0031-filesystem-routing.md) — 单一文件系统入口与消费者的环境归属 (Accepted).
- [ADR-0032](./ADR-0032-upstream-ssh-backend.md) — DSH 官方 SSH 后端的公开入口、分发与平台边界 (Accepted).
- [ADR-0033](./ADR-0033-remote-command-and-sandbox.md) — 显式远端命令、沙箱与取消语义 (Accepted).
- [ADR-0034](./ADR-0034-binary-transfer.md) — 跨环境二进制复制的授权、发布与失败语义 (Accepted).
- [ADR-0048](./ADR-0048-credential-broker.md) — 独立 OS 账户托管 SSH 连接的本机凭据代理、认证与证明条件 (Proposed).
- [ADR-0049](./ADR-0049-ssh-custody-modes.md) — SSH 远端环境的三档凭据托管：personal（Host 进程内直跑官方栈、用户凭据）、team（broker 托管、放宽部署证明）、hardened（ADR-0048 全量证据）(Accepted).
