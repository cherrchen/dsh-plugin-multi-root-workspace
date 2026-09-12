# dsh-plugin-multi-root-workspace

DSH（DeepSeek Harness）的外部插件 bundle：把 Workspace 的可写范围从"一个目录"扩展为"一个主根 + N 个附加根"，且**不修改上游仓库任何包**。

插件只回答一个问题："哪些目录属于当前 Workspace"，然后用上游同款机制（进程内 fence + 内核 runner 方言）把它们安全地放开；Agent 继续使用原生 `read` / `write` / `edit` / `bash` 工具。

## 项目状态

- **M1（组合与空根直通）已完成并验证**：插件可经 `dsh plugin` 安装，替换 `fs-sandbox` 与 `sandbox` 两行 provider，且在未配置附加根时与未装插件的行为逐项一致。证据见 [`M1 开发计划（completed）`](./docs/plans/completed/2026-09-12-m1-composition-and-passthrough.md)。
- **M2（多根能力）与 M3（Root 管理与 UI）尚未开始**：附加根的注册、内核方言 grant 拼接与客户端界面属于后续里程碑。

## 快速开始

```sh
pnpm install
pnpm lint && pnpm typecheck && pnpm test
pnpm build
pnpm smoke            # 组合门禁 + 空根直通行为门禁
pnpm docs:check
```

安装到运行时：

```sh
dsh plugin --profile web add <本仓库路径>
dsh --profile web --dump-config
```

命令、冒烟机制、双运行时矩阵与升级流程见 [`docs/development/plugin-development-workflow.md`](./docs/development/plugin-development-workflow.md)。

## 文档

项目长期文档位于 [`docs/`](./docs/README.md)：

- [需求](./docs/requirements/multi-root-workspace.md)
- [目标架构](./docs/architecture/multi-root-workspace.md)
- [上游调研](./docs/reference/multi-root-workspace-research.md)
- [决策记录](./docs/decisions/README.md)
- [计划](./docs/plans/README.md)

Coding Agent 的仓库级规则定义于 [`AGENTS.md`](./AGENTS.md)。

English documentation: [`README.en.md`](./README.en.md)
