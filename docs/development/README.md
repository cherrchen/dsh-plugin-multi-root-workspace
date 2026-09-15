# 开发流程（Development）

English: [README.en.md](./README.en.md)

## 这里存放什么

- 环境搭建（environment setup）；
- 开发工作流（development workflow）；
- 测试（testing）；
- Lint；
- 格式化（formatting）；
- 构建（build）；
- 发布（release）；
- 调试（debugging）。

## 不应该存放什么

- 稳定技术参考（放入 `../reference/`）；
- 需求、架构或计划。

## 当前状态

开发环境、工具链与验证流程已确定，见：

- [plugin-development-workflow.md](./plugin-development-workflow.md) — 构建、测试、冒烟、运行时支持矩阵、上游耦合与升级流程。
- [release-workflow.md](./release-workflow.md) — 发版流程：版本号变更脚本、tag 规范、npm 发布与 GitHub Release。

## 已确定的工具链事实

- 包管理器：pnpm（`11.25.0`）。
- 语言与构建：TypeScript（strict，独立 host face）+ tsdown（逐入口 ESM bundle）。
- 门禁：oxlint、`tsc --noEmit`、vitest、两个冒烟脚本、文档检查。

## 文档检查

项目文档需要满足仓库定义的结构与一致性规则。

项目 package scripts 已初始化，请执行：

```bash
pnpm docs:check
```

完整文档维护规则参见 [`Documentation Skill`](../../.agent/skills/documentation/SKILL.md)。

## 推荐命名

使用小写中划线命名，例如：

```text
<topic>.md
```
