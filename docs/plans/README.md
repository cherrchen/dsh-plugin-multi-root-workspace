# 开发计划（Plans）

English: [README.en.md](./README.en.md)

## 这里存放什么

大型开发任务的实施计划，例如：

- feature；
- refactor；
- migration；
- architectural change。

## 目录结构

```text
active/     正在执行或尚未开始的计划
completed/  已完成的计划
```

任务完成后，将计划从 `active/` 迁移到 `completed/`：

```text
active/
→
completed/
```

有长期参考价值的计划不应删除。

## 不应该存放什么

- 小型任务的临时 TODO；
- 已被放弃且无参考价值的草稿（可直接删除）；
- 正式设计文档（放入 `../architecture/` 或使用 `../../.agent/templates/design.md`）。

## 当前状态

active：

- [2026-09-12-multi-root-workspace.md](./active/2026-09-12-multi-root-workspace.md) — Multi-root Workspace 开发路径（里程碑概览：M1、M2、M3 均已完成）。

completed：

- [2026-09-12-m1-composition-and-passthrough.md](./completed/2026-09-12-m1-composition-and-passthrough.md) — M1 开发计划：bundle 骨架、两行 provider 替换、空根直通（2026-09-12 实施完成并验证）。
- [2026-09-12-m2-additional-roots-and-dialect-grants.md](./completed/2026-09-12-m2-additional-roots-and-dialect-grants.md) — M2 开发计划：方言 grant 拼接、parity 矩阵、拓扑快照与多根冒烟（2026-09-12 实施完成并验证）。
- [2026-09-12-m3-root-registry-command-and-ui.md](./completed/2026-09-12-m3-root-registry-command-and-ui.md) — M3 开发计划：root 注册表与持久化、`/workspace-folders` 命令、浏览器 Folders 面板、跨 repo 旅程 e2e（2026-09-12 实施完成并验证）。
- [2026-09-15-m4-registry-authority-lease.md](./completed/2026-09-15-m4-registry-authority-lease.md) — M4 开发计划：跨进程 Registry Authority Lease（2026-09-15 实施完成）。

## 推荐命名

使用小写中划线命名，例如：

```text
YYYY-MM-DD-<short-title>.md
```

可参考 `.agent/templates/plan.md` 模板。
