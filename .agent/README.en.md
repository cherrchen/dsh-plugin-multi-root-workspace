# .agent/

中文：[README.md](./README.md)

This directory holds supporting materials produced or needed by Coding Agents during their work.

Its responsibilities must stay separate from [`docs/`](../docs/README.md):

```text
docs/   = the project's long-term formal knowledge base
.agent/ = Agent working and context-engineering infrastructure
```

Formal project facts must not live only in `.agent/` or chat history; once a piece of knowledge has long-term value for the whole project, it should be promoted into the appropriate `docs/` directory.

## Directory Layout

| Directory | Purpose |
| --- | --- |
| [`note/`](./note/README.md) | Durable Agent-oriented project knowledge (formal documents, bilingual) |
| [`templates/`](./templates/) | Document templates used by Coding Agents (plan, adr, design) |

## Usage Rules

- Do not dump chat logs, scratchpads, or temporary TODOs into this directory;
- Content written to `note/` must be knowledge that future Agents are likely to need and that is costly to rediscover;
- When adding formal documents, follow the bilingual requirements in `note/README.md`.
