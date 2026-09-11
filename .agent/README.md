# .agent/

English: [README.en.md](./README.en.md)

本目录用于 Coding Agent 工作过程中产生或需要的辅助资料。

它与 [`docs/`](../docs/README.md) 的职责必须分离：

```text
docs/   = 项目的长期正式知识库
.agent/ = Agent 工作与上下文工程基础设施
```

正式的项目事实不能只存在于 `.agent/` 或对话历史中；一旦某个知识对整个项目具有长期价值，应沉淀到 `docs/` 对应目录。

## 目录结构

| 目录 | 用途 |
| --- | --- |
| [`note/`](./note/README.md) | Agent 长期沉淀的项目知识（正式文档，必须中英双语） |
| [`templates/`](./templates/) | Coding Agent 使用的文档模板（plan、adr、design） |

## 使用规则

- 不要把聊天记录、scratchpad、临时 TODO 直接存入本目录；
- 写入 `note/` 的内容必须是后续 Agent 很可能需要、且重新发现成本较高的知识；
- 新增正式文档时遵循 `note/README.md` 中的双语要求。
