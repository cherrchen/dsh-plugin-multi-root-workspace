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

The development environment, toolchain, and verification workflow are defined:

- [plugin-development-workflow.md](./plugin-development-workflow.md) — build, test, smokes, the two-runtime matrix, upstream coupling, and the upgrade procedure.

## Established Tooling Facts

- Package manager: pnpm (`11.25.0`).
- Language and build: TypeScript (strict, standalone host face) + tsdown (per-entry ESM bundles).
- Gates: oxlint, `tsc --noEmit`, vitest, two smoke scripts, and the documentation check.

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
