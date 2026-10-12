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

- [2026-09-12-multi-root-workspace.md](./active/2026-09-12-multi-root-workspace.md) — Multi-root Workspace 开发路径与**进度总账**：MVP `v0.1.0` 的 M1/M2/M3 已实施并发版；`v0.1.1` 硬化批次 H1–H4 已实施并随 `v0.1.1` 发版；`v0.1.2` 支持矩阵提升已实施并随 `v0.1.2` 发版；`v0.1.3` 支持矩阵提升（`0.1.7-alpha.2` / `0.1.7-rc.1`）已实施并随 `v0.1.3` 发版；`v0.1.4` 支持矩阵提升（`0.1.7-rc.2`）已实施并随 `v0.1.4` 发版；`v0.1.5`（DSH `0.2.0-rc.1` / `.2`）已发布；`v0.1.6`（DSH `0.2.1-alpha.1` / `.2`、B1–B3 与动态 cwd）已发布。

- [2026-10-13-b9-root-access-and-sandbox-modes.md](./active/2026-10-13-b9-root-access-and-sandbox-modes.md) — B9 专项计划：附加根继承 / 只读 / 读写与跨 SandboxMode 执行一致性；包括迁移、进程入口、内核能力验证与验收方案。进度与发布状态见进度总账。

completed：

- [2026-09-12-m1-composition-and-passthrough.md](./completed/2026-09-12-m1-composition-and-passthrough.md) — M1 开发计划：bundle 骨架、两行 provider 替换、空根直通（2026-09-12 实施完成并验证，随 `v0.1.0` 发版）。
- [2026-09-12-m2-additional-roots-and-dialect-grants.md](./completed/2026-09-12-m2-additional-roots-and-dialect-grants.md) — M2 开发计划：方言 grant 拼接、parity 矩阵、拓扑快照与多根冒烟（2026-09-12 实施完成并验证，随 `v0.1.0` 发版）。
- [2026-09-12-m3-root-registry-command-and-ui.md](./completed/2026-09-12-m3-root-registry-command-and-ui.md) — M3 开发计划：root 注册表与持久化、`/workspace-folders` 命令、浏览器 Folders 面板、跨 repo 旅程 e2e（2026-09-12 实施完成并验证，随 `v0.1.0` 发版）。
- [2026-09-15-m4-registry-authority-lease.md](./completed/2026-09-15-m4-registry-authority-lease.md) — v0.1.1 批次 H1（路线图 M4）：跨进程 Registry Authority Lease（2026-09-15 实施完成，随 `v0.1.1` 发版）。
- [2026-09-15-panel-session-derived-authority.md](./completed/2026-09-15-panel-session-derived-authority.md) — v0.1.1 批次 H2：面板主根改为 host session 推导，删除客户端 `primaryRoot`（2026-09-15 实施完成，随 `v0.1.1` 发版）。
- [2026-09-15-dsh-compat-contract.md](./completed/2026-09-15-dsh-compat-contract.md) — v0.1.1 批次 H3 + H4 Phase 1：DSH 兼容性变成启动时执行的代码契约，并把 `0.1.6-alpha.1` 与附加根顶层指令注入一并纳入（2026-09-15 实施完成，随 `v0.1.1` 发版）。
- [2026-09-15-v0.1.1-review-rework.md](./completed/2026-09-15-v0.1.1-review-rework.md) — v0.1.1 批次发版前的 PR #1 评审返工（2 项 P1 + 3 项 P2）：authority 拆除顺序（排空 → close → release）、中间目录指令可达、`warn` 只放宽 `unsupported`、两个可选 peer 按需加载、缺失与求值失败分离（2026-09-15 实施完成，随 `v0.1.1` 发版）。
- [2026-10-12-files-header-root-browsing.md](./completed/2026-10-12-files-header-root-browsing.md) — Files 头部根浏览：P1 仅图标齿轮 launcher 前移，P2 根选择器 portal 接管树区，P3–P10 目检修正，P11 接管树换为逐字节复刻的上游 Files 树（`src/client/files-tree/`，自绘树与私有 `files`/`readFile` 端点下线；2026-10-12 实施完成，未发版；决策见 ADR-0015）。

### 编号口径

- **M1–M4** 是 MVP 路线图的里程碑编号（M4 = 跨进程 lease）。
- **H1–H4** 是 `v0.1.1` 硬化批次的编号：H1 = M4、H2 = 面板权威、H3 = 兼容性契约、H4 = 附加根指令（Phase 1 顶层 + Phase 2 nested 均已做）。
- **B 系列** 是第二期任务编号；B9 的实施阶段不另占 B 编号。
- 唯一真源：[路线图的进度总账](./active/2026-09-12-multi-root-workspace.md#进度总账)。

## 推荐命名

使用小写中划线命名，例如：

```text
YYYY-MM-DD-<short-title>.md
```

可参考 `.agent/templates/plan.md` 模板。
