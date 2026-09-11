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

项目技术栈尚未定义。

不要在本目录生成任何尚未存在的命令或工具说明；待开发环境与流程确定后再补充。

## 已确定的工具链事实

- 包管理器：pnpm。

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
