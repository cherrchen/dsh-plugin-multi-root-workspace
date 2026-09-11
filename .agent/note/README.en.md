# Agent Notes

中文：[README.md](./README.md)

This directory is where Coding Agents progressively deposit durable project knowledge.

## What Belongs Here

- Repository observations;
- Recurring implementation patterns;
- Compatibility notes;
- Upstream integration notes;
- Migration context;
- Important facts that Agents tend to rediscover repeatedly;
- Long-lived code archaeology results.

The core test:

> Only knowledge that future Agents are likely to need again, and that is costly to rediscover, belongs here.

## What Does Not Belong Here

- Chat log backups;
- Scratchpads;
- Chain of Thought;
- Temporary TODOs;
- Per-task journals.

## Bilingual Requirement

Every formal document in this directory must be maintained bilingually:

```text
<name>.md       canonical Chinese version
<name>.en.md    English companion
```

For example, a future document might be:

```text
upstream-integration.md
upstream-integration.en.md
```

When updating either version, check whether the other needs to be synchronized; in case of conflict, the Chinese version prevails.

Do not create empty `.en.md` files automatically; create both files only when a document is established as formal knowledge.

## Naming Convention

Use lowercase kebab-case, for example:

```text
<topic>.md
```
