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
- [ADR-0006-client-ui-host-tokens.md](./ADR-0006-client-ui-host-tokens.md) — 客户端 UI 复刻宿主原生样式：注入样式表消费宿主 `--dsw-*` token，插件零硬编码颜色（Accepted）。
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

编号递增，标题使用小写中划线。

- [ADR-0022-auto-review-loader-entry.md](./ADR-0022-auto-review-loader-entry.md) — Auto Review 并入主包：默认关闭的单一 loader 行、运行时接管、并发导入防护、有序 owner 交接与单包构建（取代 ADR-0021 的交付结构）。

- [ADR-0023-multi-root-skill-discovery-and-invocation.md](./ADR-0023-multi-root-skill-discovery-and-invocation.md) — 附加根 Skills：登记权限初始化开关、aliasId 命名空间、可信 Session scope、原生内部 ID 桥接、Effective CWD 发现路由、Settings 与迁移边界（Accepted，架构定案，功能待实施）。

- [ADR-0024-registry-operation-admission.md](./ADR-0024-registry-operation-admission.md) — 操作准入与撤权顺序、允许在飞操作完成（Accepted）。

- [ADR-0025-shared-registry-authority.md](./ADR-0025-shared-registry-authority.md) — 多 Host 共享权威服务、IPC 权限隔离、同步消费与失败关闭接管（Accepted）。
