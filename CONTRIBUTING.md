# 贡献指南

English: [CONTRIBUTING.en.md](./CONTRIBUTING.en.md)

感谢你愿意改进 `@dsh-electron/dsh-plugin-multi-root-workspace`。本仓库是一个 out-of-tree 的 DSH 插件 / bundle，所有功能都通过插件与 profile patch 组合实现，不修改上游仓库。

> **硬约束：不修改上游仓库 `deepseek-harness` 的任何包。** 扩展只发生在本仓库。

## 可以怎么贡献

- 报告可复现的缺陷，补充平台、版本和复现条件。
- 提出功能建议；涉及授权、沙箱、进程围栏的改动请先开 Issue 对齐设计。
- 改进文档、翻译或故障排查条目。
- 在你的平台上验证受支持的 DSH 版本（macOS / Linux / Windows）。
- 直接提交代码、测试或打包 / CI 改进。

## 开始之前

1. 阅读 [README](./README.md)、[`AGENTS.md`](./AGENTS.md)、[开发工作流](./docs/development/plugin-development-workflow.md) 和 [架构文档](./docs/architecture/README.md)。
2. 搜索现有 Issue 和 PR，避免重复。
3. **安全漏洞不要开公开 Issue**，按 [SECURITY.md](./SECURITY.md) 私下报告。
4. 较大的行为变更、公开接口变更、授权模型变更或支持矩阵变更，先开 Issue 说明目标、影响面和验证计划，再开始实现。
5. 涉及多根授权、沙箱、进程围栏、Registry 或兼容层的改动，先读对应的 ADR；不要凭猜测扩大授权范围。

## 开发环境

- Node.js `^22.19.0 || >=24`；`0.2.2` 及以后的车道要求 `>=24.9`。
- pnpm `11.25.0`（建议用 corepack 启用）。
- 开发 pin 的 DSH 为 `0.2.2-rc.4`；受支持版本是[精确 allowlist](./src/compat/dsh-version.ts)，不是范围。

```sh
pnpm install
pnpm build          # 先构建，再跑测试：部分测试读取 lib/ 制品
pnpm test
```

PR 前至少运行：

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

`pnpm verify:all` 覆盖更完整的本地门禁（含 `kernel:probe`、`pack:check`、`smoke:packed` 与 Auto Review 联合检查），但它**不包含** `compat:check` 和 `docs:check`，所以仍需单独运行。

`smoke` 需要可用的内核方言。在嵌套沙箱中无法运行时，脚本会显式 skip 并打印原因；不要把 skip 当成通过。完整命令、平台差异与已知环境限制见[开发工作流](./docs/development/plugin-development-workflow.md)。

## 分支、提交与 PR

- 从 `main` 拉分支；一个 PR 只做一件逻辑上的事。
- 提交信息遵循 conventional commits，例如 `fix(registry): ...`、`feat(client): ...`、`docs: ...`、`test: ...`。
- 不要在提交信息里添加 `Generated with ...` 或 `Co-Authored-By` 尾注（本仓库维护者约定）。
- PR 描述使用 [PR 模板](./.github/PULL_REQUEST_TEMPLATE.md)，并关联对应 Issue。
- 保持工作区干净；不要提交 `lib/`、`.dsh-smoke/`、`.temp/` 或任何凭据。
- 维护者可能会要求拆分 PR、补充测试或缩小范围；合并前 CI 必须通过。

## 代码规则

- TypeScript `strict`；ESM；源码内相对导入带 `.ts` 后缀。
- 跨包使用包名导入；不要 deep import 上游内部实现。
- 行为变更同时更新测试；测试描述行为，而不是“证明正确”。
- 授权、沙箱、进程围栏、Registry、生命周期与并发改动，先读 [`AGENTS.md`](./AGENTS.md) 的约定与对应 ADR。
- 版本相关代码只放在 `src/compat/`，并且探测结构而不是比较版本字符串。
- 不新增 `as unknown`；不要用运行时校验替代同进程的静态类型。
- 错误处理使用结构化失败与可操作信息；不要空 `catch`。
- 新增可配置项必须是校验过的 `Config` 字段，不能是硬编码常量。
- 文档与注释遵循[文档维护规则](./.agent/skills/documentation/SKILL.md)。

## 文档、兼容性与许可

- 行为、配置、公开接口或开发流程变化时，同一 PR 更新对应文档；不要只写在 PR 描述里。
- 根目录 README 维护 8 种语言，中文为准；修改任意一份要同步其余七份，并保持标题层级与代码块结构。
- 面板文案跟随 DSH 的 8 种语言词典；不要在组件里硬编码用户可见文案。
- 工程取舍新增 ADR；不要为局部实现细节写 ADR。
- `CHANGELOG.md` / `CHANGELOG.en.md` 由维护者在发版准备时更新，功能 PR 通常不要改。
- DSH 支持矩阵是精确版本 allowlist；新增受支持版本属于人工契约变更，需要完整证据，不能只改 `package.json`。
- 新增运行时依赖、把第三方代码内联进 `lib/client.js`，或新增上游源码 fork 时，运行 `pnpm licenses:update` 并提交生成的 `THIRD_PARTY_LICENSE`；不要手改该文件。`pnpm licenses:check` 在 CI 中验证。

## 发版

发版由维护者执行：更新发布状态与 CHANGELOG、由 `scripts/bump-version.mjs` 改版本并打 tag，GitHub Actions 完成发布。细节见[发版流程](./docs/development/release-workflow.md)。

## 许可

本仓库以 [MIT](./LICENSE) 发布。提交贡献即表示你同意以同一许可发布该贡献。
