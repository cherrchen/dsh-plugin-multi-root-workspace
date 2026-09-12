# dsh-plugin-multi-root-workspace

DSH（DeepSeek Harness）的外部插件 bundle：把 Workspace 的可写范围从"一个目录"扩展为"一个主根 + N 个附加根"，且**不修改上游仓库任何包**。

插件只回答一个问题："哪些目录属于当前 Workspace"，然后用上游同款机制（进程内 fence + 内核 runner 方言）把它们安全地放开；Agent 继续使用原生 `read` / `write` / `edit` / `bash` 工具。

## 项目状态

- **M1（组合与空根直通）已完成并验证**：插件可经 `dsh plugin` 安装，替换 `fs-sandbox` 与 `sandbox` 两行 provider，且在未配置附加根时与未装插件的行为逐项一致。证据见 [`M1 开发计划（completed）`](./docs/plans/completed/2026-09-12-m1-composition-and-passthrough.md)。
- **M2（多根能力）已完成并验证**：附加根经同一份 scope 同时进入进程内 fence 与内核方言 grant（Seatbelt / bwrap / Landlock），由 parity 矩阵、方言单测、拓扑快照与多根冒烟钉住；`read-only` 下附加根同样不可写，空根行为与未装插件逐字节不变。证据见 [`M2 开发计划（completed）`](./docs/plans/completed/2026-09-12-m2-additional-roots-and-dialect-grants.md)。
- **M3（Root 管理与 UI）尚未开始**：注册表持久化、校验规则、`/workspace-folders` 命令、Workspace Folders 面板与 e2e 属于后续里程碑。当前注册附加根的入口是插件服务 API（测试与冒烟注入），还没有用户界面。

## 已知限制（第一期）

- Windows 的内核级多根未实现：`fs` 写路径覆盖附加根，但受限 bash/PTY 写不进去（非空 scope 时插件输出一次显式告警）；详见[需求文档](./docs/requirements/multi-root-workspace.md)第一期范围。
- 附加根与主根同权（无 per-root read-only）；附加根不能作为 bash/PTY 的默认工作目录（session cwd 语义不变）。
- 附加根的存在性不在会话启动时 re-check（M3 随注册表一起落地）。

## 快速开始

```sh
pnpm install
pnpm lint && pnpm typecheck && pnpm test
pnpm build
pnpm smoke            # 组合门禁 + 空根直通与多根行为门禁
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
