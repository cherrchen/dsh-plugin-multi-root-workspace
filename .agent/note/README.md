# Agent 笔记（note）

English: [README.en.md](./README.en.md)

本目录是后续 Coding Agent 长期沉淀项目知识的位置。

## 这里可以保存什么

- repository observations（仓库观察结论）；
- recurring implementation patterns（反复出现的实现模式）；
- compatibility notes（兼容性说明）；
- upstream integration notes（上游集成说明）；
- migration context（迁移背景）；
- Agent 容易反复重新发现的重要事实；
- 长期有效的代码考古结果。

核心判断标准：

> 只有后续 Agent 很可能需要重新发现，并且重新发现成本较高的知识，才值得放入本目录。

## 当前状态

- [dsh-compat-contract.md](./dsh-compat-contract.md) — DSH 兼容性契约：allowlist 的唯一真源、`multiRootCompat` 门禁对测试的影响、`confine` 同步/异步保形、`src/compat/` 适配层规则、升级车道用法与两处曾踩过的安静坑。

## 不应该存放什么

- 聊天记录备份；
- scratchpad；
- Chain of Thought；
- 临时 TODO；
- 每次任务的流水账。

## 双语要求

本目录下的所有正式文档必须中英双语：

```text
<name>.md       中文主版本（canonical）
<name>.en.md    英文副文档
```

例如未来创建：

```text
upstream-integration.md
upstream-integration.en.md
```

修改任意一个语言版本时，必须检查另一个版本是否需要同步；如发生冲突，以中文版为准。

不要为普通笔记自动创建空的 `.en.md` 文件，只有确定为正式知识文档时才成对创建。

## 推荐命名

使用小写中划线命名，例如：

```text
<topic>.md
```
