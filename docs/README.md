# 项目文档

该目录保存项目的长期文档与工程知识。

English: [README.en.md](./README.en.md)

## 文档地图

| 目录 | 用途 |
| --- | --- |
| [`requirements/`](./requirements/README.md) | 产品、功能和非功能需求 |
| [`architecture/`](./architecture/README.md) | 当前架构、目标架构和系统设计 |
| [`decisions/`](./decisions/README.md) | Architecture Decision Records |
| [`plans/`](./plans/README.md) | 当前与已完成的实施计划 |
| [`development/`](./development/README.md) | 开发流程与工程实践 |
| [`reference/`](./reference/README.md) | 稳定技术参考 |
| [`troubleshooting/`](./troubleshooting/README.md) | 已知问题、诊断方法和解决方案 |

## 当前文档

当前项目围绕 DSH Multi-root Workspace 插件展开，硬约束为**不修改上游仓库（deepseek-harness）任何包**——全部产物是外部插件/bundle，经 `dsh plugin add` 或 profile patch 组合安装。四份核心文档如下：

| 文档 | 位置 |
| --- | --- |
| 开发需求 | [`requirements/multi-root-workspace.md`](./requirements/multi-root-workspace.md) |
| 架构设计（Target） | [`architecture/multi-root-workspace.md`](./architecture/multi-root-workspace.md) |
| 开发路径（Plan） | [`plans/active/2026-09-12-multi-root-workspace.md`](./plans/active/2026-09-12-multi-root-workspace.md) |
| 上游仓库现状调研（Reference） | [`reference/multi-root-workspace-research.md`](./reference/multi-root-workspace-research.md) |

## 基本原则

### Single Source of Truth

同一个项目事实不要在多个文档中独立维护。

优先通过链接引用唯一真源。

### 当前事实与未来设计分离

当前已经实现的系统状态，必须与 Proposal、Target Design 或未来规划明确区分。

### 文档与代码共同演进

实现变化导致文档事实失效时，应在同一变更中更新文档。

### 保存重要决策

重要架构和工程决策应逐步记录在 `decisions/` 中。

### 保存开发计划

大型开发任务后续应使用 `plans/active/`。

任务完成后迁移至 `plans/completed/`，而不是直接删除。

## 语言

项目以中文文档为主。

所有 README 同时维护：

- `README.md`
- `README.en.md`

其中 `README.md` 为中文主版本。修改任意一个语言版本时，应检查另一个版本是否需要同步；如发生冲突，以中文版为准。
