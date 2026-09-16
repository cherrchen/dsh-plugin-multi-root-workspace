# 决策记录（Architecture Decision Records）

English: [README.en.md](./README.en.md)

## 这里存放什么

Architecture Decision Records（ADR），用于记录重要架构与工程决策：

- Context（背景）；
- Decision（决策）；
- Alternatives（备选方案）；
- Consequences（影响）。

## 不应该存放什么

- 未形成决策的讨论或提案；
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

不要提前创建空的 ADR 文件；仅在做出真实决策时新增。

## 推荐命名

```text
ADR-0001-short-title.md
ADR-0002-short-title.md
```

编号递增，标题使用小写中划线。
