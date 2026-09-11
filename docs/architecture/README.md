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

项目尚未开始架构设计。

不要在本目录预先创建 `current.md` 或 `target.md` 等占位文档，等真正开始架构设计以后再创建。

## 推荐命名

使用小写中划线命名，例如：

```text
<subsystem-or-topic>.md
```
