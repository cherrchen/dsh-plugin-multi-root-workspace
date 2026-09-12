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

不要提前创建空的 ADR 文件；仅在做出真实决策时新增。

## 推荐命名

```text
ADR-0001-short-title.md
ADR-0002-short-title.md
```

编号递增，标题使用小写中划线。
