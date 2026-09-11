# Development

中文：[README.md](./README.md)

## What Belongs Here

- Environment setup;
- Development workflow;
- Testing;
- Linting;
- Formatting;
- Build;
- Release;
- Debugging.

## What Does Not Belong Here

- Stable technical reference (goes to `../reference/`);
- Requirements, architecture, or plans.

## Current State

The project's technology stack has not been defined yet.

Do not generate commands or tooling instructions for things that do not exist yet; add them once the development environment and workflow are established.

## Established Tooling Facts

- Package manager: pnpm.

## Documentation Check

Project documentation must satisfy the structural and consistency rules defined in this repository.

The package scripts are already initialized; run:

```bash
pnpm docs:check
```

For the full documentation maintenance rules, see the [`Documentation Skill`](../../.agent/skills/documentation/SKILL.md).

## Naming Convention

Use lowercase kebab-case, for example:

```text
<topic>.md
```
