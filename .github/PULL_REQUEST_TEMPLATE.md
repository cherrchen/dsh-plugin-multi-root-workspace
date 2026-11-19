<!--
感谢贡献。请保持一个 PR 只做一件逻辑上的事，并先阅读 CONTRIBUTING.md。
Thanks! Keep one logical change per PR, and read CONTRIBUTING.md first.
-->

## Summary / 摘要

<!-- What problem does this solve, and what changed? / 这个 PR 解决什么问题，改了什么？ -->

## Related issue / 关联 Issue

<!-- Closes #123, or "none" with a short reason. -->

## Type / 类型

- [ ] Bug fix / 缺陷修复
- [ ] Feature / 新功能
- [ ] Refactor or performance / 重构或性能
- [ ] Documentation / 文档
- [ ] Test or tooling / 测试或工具链
- [ ] DSH compatibility / DSH 兼容性（新增或变更受支持版本）

## Verification / 验证

<!-- List the commands you actually ran and their results. Do not check unrun items. -->

- [ ] `pnpm compat:check`
- [ ] `pnpm lint`
- [ ] `pnpm typecheck`
- [ ] `pnpm build`
- [ ] `pnpm test`
- [ ] `pnpm docs:check`
- [ ] `pnpm licenses:check`（在 `pnpm build` 之后）
- [ ] `pnpm smoke`（注明平台与内核用例 skip 情况）
- [ ] Focused tests / 定向测试：______

## Documentation and compatibility / 文档与兼容性

- [ ] User-visible behavior is documented under `docs/`; the eight root README editions stay in sync.
- [ ] A decision with long-term trade-offs has an ADR.
- [ ] Authorization, sandbox, process, or compatibility behavior changed; tests and docs cover it.
- [ ] The DSH support matrix is unchanged, or this PR includes the required evidence.
- [ ] No third-party code was added; or `THIRD_PARTY_LICENSE` was regenerated with `pnpm licenses:update`.
- [ ] This is a breaking change and an upgrade-guide entry is included.
- [ ] No documentation change is needed (explain why): ______

## Risk / 风险

<!-- Anything reviewers should scrutinize: security boundaries, concurrency, teardown, platform behavior. -->
