# 架构文档（Architecture）

English: [README.en.md](./README.en.md)

## 这里存放什么

- Current Architecture（当前架构）；
- Target Architecture（目标架构）；
- 子系统设计（subsystem design）；
- 组件边界（component boundaries）；
- 数据流（data flow）；
- 接口（interfaces）。

## 不应该存放什么

- 需求（放入 `../requirements/`）；
- 决策记录（放入 `../decisions/`）；
- 实施计划（放入 `../plans/`）。

## 重要要求

不得将 Proposal 或 Target Architecture 描述成当前已经实现的系统事实。

描述未来设计的文档必须明确标注其状态。

## 当前状态

本项目只有一份架构文档，它同时承载**已实现部分（Current）**与**尚未实现部分（Target）**，边界在文档头部与各节内明确标注：

- [multi-root-workspace.md](./multi-root-workspace.md) — Multi-root Workspace 的不改上游设计：provider 替换 + 子类化。
  - 已实现（M1/M2）：§3 组合结构、§4 scope 解析、§5.1 fs provider、§5.2 不替换 `bash-sandbox`、§5.3 sandbox provider 的多根 grant、§6 拓扑快照与 parity 矩阵。
  - 仍为 Target（M3）：§7 Root 注册表、校验、`/workspace-folders` 命令与 client 半部；§8 的长期形态（上游 seam）与 §9 附录为备忘。

## 推荐命名

使用小写中划线命名，例如：

```text
<subsystem-or-topic>.md
```
