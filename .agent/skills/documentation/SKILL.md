# Documentation Skill

本 Skill 定义 Coding Agent 如何创建、更新、移动、删除和验证本仓库的项目文档。

它不包含任何项目具体业务知识，只回答一个问题：

> 如何维护这个仓库的文档系统。

核心原则：

> Documentation is part of the implementation.

代码和文档必须共同演进。相关文档规则的总纲见根目录 [`AGENTS.md`](../../../AGENTS.md)。

---

## 1. 判断是否需要修改文档

在完成任何开发任务前，先判断当前变更是否影响：

- requirements；
- architecture；
- public interfaces；
- configuration；
- development workflow；
- build behavior；
- release behavior；
- module boundaries；
- important engineering decisions；
- recurring troubleshooting knowledge；
- durable Agent knowledge。

如果影响，应首先找到负责该信息的 **canonical document**（唯一真源），更新现有文档。

不要因为修改了一个功能就机械创建新的 Markdown。如果已有文档负责该信息，更新它。

## 2. 文档位置规则

| 目录 | 存放内容 |
| --- | --- |
| `docs/requirements/` | 产品需求、系统需求、functional / non-functional requirements、constraints |
| `docs/architecture/` | Current / Target Architecture、subsystem design、component boundaries、data flow、system-level technical design |
| `docs/decisions/` | Architecture Decision Records、重要工程决策、有长期后果的技术选择 |
| `docs/plans/active/` | 正在执行的大型 Feature / Refactor / Migration / Architecture Change / 长期开发任务 |
| `docs/plans/completed/` | 已完成但仍具历史参考价值的 Plan |
| `docs/development/` | environment setup、development workflow、testing、lint、build、release、debugging、engineering practices |
| `docs/reference/` | stable technical reference、API、schema、protocol、configuration reference、file format |
| `docs/troubleshooting/` | recurring issue、symptoms、root cause、diagnosis、verified solution |
| `.agent/note/` | 对未来 Coding Agent 有长期价值、且重新通过代码考古获得成本较高的知识 |

各目录的详细边界以该目录的 README 为准。

`.agent/note/` 适合：non-obvious repository behavior、upstream compatibility、hidden coupling、recurring integration knowledge、important repository archaeology results、migration context。

`.agent/note/` 不适合：Chain of Thought、chat history、scratchpad、临时 TODO、临时 debug log、未验证猜想、一次性报错记录。

## 3. Single Source of Truth

每一个重要项目事实都应拥有唯一的 canonical location。避免同一事实独立维护在 README、Architecture、ADR、Plan、Agent Note、Development Guide 等多个位置。

其他文档应 link to the source of truth，而不是复制完整内容。

创建新文档前，必须先检查是否已有文档拥有该信息。

## 4. 中英文与多语言文档规则

项目默认采用 **中文主文档 + 英文副文档**：

```text
foo.md       canonical Chinese document
foo.en.md    English counterpart
```

规则：

1. 中文版本是主要维护版本；
2. 英文版本保持相同的信息结构；
3. 不要求逐句直译；
4. 但不能存在重要的信息差异；
5. 中英文冲突时，以中文版本为准；
6. 发现冲突时应同步修复英文版本。

**根目录 README 例外**：与 DSH 内置界面语言一致，根目录 README 维护 8 种语言：

```text
README.md       中文（canonical，主版本）
README.en.md    English
README.ja.md    日本語
README.es.md    Español
README.fr.md    Français
README.de.md    Deutsch
README.ru.md    Русский
README.pt.md    Português（巴西葡萄牙语）
```

这 8 份视为同一个逻辑文档：修改任意一份时必须同步其余七份；所有版本保持相同的标题层级与围栏代码块结构；每种语言都必须与其余七种互相导航。中文版本是权威版本，译文冲突时修复译文，不得反向修改中文以迁就译文。非中文版本在没有对应译文时链接到英文文档；中文版本链接中文文档。不要为其他文档类型创建空的或纯占位的语言文件。

当前必须多语言的文档：

```text
根目录 README（8 种语言）
```

当前必须双语的文档：

```text
其他目录下的所有 README
.agent/note/ 下的正式 Markdown
```

暂时不强制双语的文档：ADR、Plan、Design、Reference、Troubleshooting Entry（除非未来规则改变）。

## 5. README Rules

README 的职责是 orientation、navigation、entry point：这个目录是什么、这里有什么、重要内容在哪里、如何进入更详细的文档。

README 不应逐渐变成完整的 Architecture Book、PRD、ADR 集合、Development Log 或巨型 Implementation Plan。

任何 `README.md` 必须有对应的 `README.en.md`，反之亦然，且必须互相导航：

```markdown
English: [README.en.md](./README.en.md)
```

```markdown
中文：[README.md](./README.md)
```

根目录 README 不走这条两两配对规则，而是按 §4 的 8 语言规则维护，语言选择器必须列出全部 8 种语言（当前语言显示为纯文本，其余为链接），例如：

```markdown
中文 | [English](./README.en.md) | [日本語](./README.ja.md) | [Español](./README.es.md) | [Français](./README.fr.md) | [Deutsch](./README.de.md) | [Русский](./README.ru.md) | [Português](./README.pt.md)
```

```markdown
[中文](./README.md) | English | [日本語](./README.ja.md) | [Español](./README.es.md) | [Français](./README.fr.md) | [Deutsch](./README.de.md) | [Русский](./README.ru.md) | [Português](./README.pt.md)
```

## 6. Current State 与 Future State

文档必须严格区分 Current、Proposed、Target、Planned、Deprecated、Completed。

禁止把"希望以后实现的设计"描述成"当前已经存在的系统"。

Current documentation 必须能通过当前 repository 验证。

## 7. ADR Rules

当一个工程决策存在多个合理方案、对未来架构有明显影响、带来兼容性或维护成本、且将来开发者可能需要知道"为什么这样设计"时，应创建 ADR。不要为简单实现细节创建 ADR。

命名：

```text
ADR-0001-short-title.md
```

内容通常包括：Status、Date、Context、Decision、Alternatives Considered、Consequences、Related Documents。模板见 `.agent/templates/adr.md`。

ADR number 必须唯一，不允许重复使用。已经 Accepted 的 ADR 不应被直接重写来隐藏历史；如果设计改变，应将旧 ADR 标记为 Deprecated / Superseded，必要时创建新 ADR。

## 8. Plan Lifecycle

大型 feature、refactor、migration、architecture change 可以建立 `docs/plans/active/foo.md`。任务完成并验证后，移动为 `docs/plans/completed/foo.md`。

不要长期把完成的 Plan 留在 active，也不要因为实现完成就删除 Plan——Plan 同时是项目历史的一部分。模板见 `.agent/templates/plan.md`。

## 9. 文件命名规范

普通长期文档使用 lowercase kebab-case：

```text
plugin-system.md
release-process.md
```

特殊文件遵循自身约定：`README.md`、`README.en.md`、`README.<language>.md`（仅限根目录）、`AGENTS.md`、`ADR-0001-short-title.md`、`SKILL.md`。

长期文档避免 `new.md`、`notes2.md`、`temp.md`、`final.md`、`final-final.md`、`test.md`、`draft2.md` 这类临时命名。

## 10. 链接规则

项目内链接优先使用相对链接：

```markdown
[Architecture](../architecture/README.md)
```

不要使用开发者机器的绝对路径：

```text
/Users/...
/home/...
C:\Users\...
file://...
```

移动或重命名文档时，必须更新相关 inbound / outbound links。

## 11. 文档任务完成清单

在完成涉及文档的任务前：

1. 判断当前变更影响哪些文档；
2. 找到 canonical documentation；
3. 更新文档；
4. 检查是否需要同步英文版本；根目录 README 还需同步其余七种语言版本；
5. 检查内部链接与语言导航；
6. 检查移动或重命名产生的失效链接；
7. 如果使用了 Plan，检查 Plan Lifecycle；
8. 运行 Documentation Check：

```bash
pnpm docs:check
```

`docs:check` 是稳定的逻辑入口，其内部实现（当前为 `node scripts/check-docs.mjs`）属于实现细节，不要直接依赖脚本内部文件名。

## 12. Skill 与自动化 Checker 的边界

本 Skill 负责"应该怎么维护文档，以及为什么"。

`scripts/check-docs.mjs` 负责机器可判定的结构不变量（双语配对、根 README 的 8 语言齐全与互链、根 README 之间的标题层级/代码块结构一致、链接有效性、命名规范等）是否被破坏。它不评价文档质量、架构正确性、翻译自然度或 Plan 是否真的完成——这些属于 semantic review，由 Coding Agent 和开发者判断。
