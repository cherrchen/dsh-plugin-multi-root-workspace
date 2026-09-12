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

不要提前创建空的 ADR 文件；仅在做出真实决策时新增。

## 推荐命名

```text
ADR-0001-short-title.md
ADR-0002-short-title.md
```

编号递增，标题使用小写中划线。
