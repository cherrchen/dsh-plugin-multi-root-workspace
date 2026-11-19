# Contributing

中文：[CONTRIBUTING.md](./CONTRIBUTING.md)

Thanks for improving `@dsh-electron/dsh-plugin-multi-root-workspace`. This repository is an out-of-tree DSH plugin and bundle: every feature is composed through plugins and profile patches, without modifying the upstream repository.

> **Hard constraint: never modify any package in the upstream `deepseek-harness` repository.** Extensions live in this repository only.

## Ways to contribute

- Report a reproducible defect with its platform, versions, and reproduction conditions.
- Propose a feature. Open an issue first when the change touches authorization, sandboxing, or the process fence.
- Improve documentation, translations, or troubleshooting entries.
- Verify a supported DSH release on your platform (macOS / Linux / Windows).
- Contribute code, tests, or packaging and CI improvements.

## Before you start

1. Read the [README](./README.en.md), [`AGENTS.md`](./AGENTS.md), the [development workflow](./docs/development/plugin-development-workflow.md), and the [architecture documents](./docs/architecture/README.en.md).
2. Search existing issues and pull requests to avoid duplicates.
3. **Do not open a public issue for a security vulnerability.** Report it privately as described in [SECURITY.en.md](./SECURITY.en.md).
4. For a large behavior change, public-interface change, authorization-model change, or support-matrix change, open an issue with the goal, impact, and verification plan before implementing.
5. Before changing multi-root authorization, sandboxing, the process fence, the Registry, or the compatibility layer, read the relevant ADRs. Do not widen authority by guesswork.

## Development environment

- Node.js `^22.19.0 || >=24`; the `0.2.2` lanes require `>=24.9`.
- pnpm `11.25.0` (corepack is recommended).
- The development pin is DSH `0.2.2-rc.4`. Supported releases are an [exact allowlist](./src/compat/dsh-version.ts), not a range.

```sh
pnpm install
pnpm build          # build first: some tests read the lib/ artifacts
pnpm test
```

Run at least these before a pull request:

```sh
pnpm compat:check
pnpm lint
pnpm typecheck
pnpm build
pnpm test
pnpm docs:check
pnpm licenses:check
pnpm smoke
```

`pnpm verify:all` covers the wider local gate (including `kernel:probe`, `pack:check`, `smoke:packed`, and the joint Auto Review checks), but it deliberately **does not include** `compat:check` or `docs:check`; run those separately.

`smoke` needs a usable kernel dialect. When the host cannot run it (for example, a nested sandbox), the scripts explicitly skip the affected cases and print the reason. Do not treat a skip as a pass. The complete command set, platform differences, and known environment limits are in the [development workflow](./docs/development/plugin-development-workflow.md).

## Branches, commits, and pull requests

- Branch from `main`; keep one logical change per pull request.
- Follow conventional commits, for example `fix(registry): ...`, `feat(client): ...`, `docs: ...`, or `test: ...`.
- Do not add `Generated with ...` or `Co-Authored-By` trailers (the maintainer's convention for this repository).
- Describe the change with the [pull request template](./.github/PULL_REQUEST_TEMPLATE.md) and link the related issue.
- Keep the working tree clean; never commit `lib/`, `.dsh-smoke/`, `.temp/`, or credentials.
- Maintainers may ask for a split, more tests, or a narrower scope. CI must pass before merge.

## Code rules

- TypeScript `strict`; ESM; relative imports inside the source carry the `.ts` suffix.
- Import other packages by package name; never deep-import upstream internals.
- Behavior changes update their tests. Tests describe behavior, not correctness.
- Before changing authorization, sandboxing, the process fence, the Registry, lifecycle, or concurrency, read the conventions in [`AGENTS.md`](./AGENTS.md) and the relevant ADRs.
- Version-dependent code belongs only in `src/compat/`, and it probes structure instead of comparing version strings.
- Do not add `as unknown`; do not replace same-process static typing with runtime validation.
- Use structured failures and actionable reports; never leave an empty `catch`.
- A new configurable choice must be a validated `Config` field, not a hardcoded constant.
- Documentation and comments follow the [documentation rules](./.agent/skills/documentation/SKILL.md).

## Documentation, compatibility, and licensing

- When behavior, configuration, a public interface, or the development workflow changes, update the matching documentation in the same pull request. Do not leave it only in the pull request description.
- The root README ships in eight languages, with Chinese as the canonical edition. When one edition changes, synchronize the other seven and keep the same heading levels and fenced-code-block structure.
- Panel copy follows DSH's eight-language dictionaries; never hardcode user-visible copy in a component.
- Record engineering trade-offs in an ADR. Do not add an ADR for a local implementation detail.
- Maintainers update `CHANGELOG.md` / `CHANGELOG.en.md` during release preparation; feature pull requests normally do not touch them.
- The DSH support matrix is an exact-version allowlist. Adding a supported release is a human-owned contract change that needs complete evidence; editing `package.json` alone is not enough.
- Adding a runtime dependency, inlining third-party code into `lib/client.js`, or adding an upstream source fork requires `pnpm licenses:update` and the regenerated `THIRD_PARTY_LICENSE`. Never edit that file by hand. `pnpm licenses:check` verifies it in CI.

## Releases

Maintainers handle releases: update the release state and CHANGELOG, let `scripts/bump-version.mjs` change the version and create the tag, and GitHub Actions publishes the package. See the [release workflow](./docs/development/release-workflow.md).

## License

This repository is released under the [MIT license](./LICENSE). By submitting a contribution, you agree to release it under the same license.
