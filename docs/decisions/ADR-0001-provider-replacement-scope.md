# ADR-0001: 只替换 `fs-sandbox` 与 `sandbox` 两个 provider 行

## Status

Accepted

## Date

2026-09-12

## Context

不改上游仓库的约束下，多根 workspace-write 只能在 provider 层实现：允许根的判定全部发生在上游 provider 内部（fs fence 的 containment 检查、bash / PTY 的内核 runner 方言 profile），而 `fs/*` 事件与 `tools/pre-execute` 都无法改写策略或参数。

路线图与架构设计稿最初设定“disable `fs-sandbox` / `bash-sandbox` / `sandbox` 三行 + insert 三个 provider 子类”，其中 bash 侧对应一个新的 `MultiRootBashExecutor`。

实现前实测了 bash 与 PTY 的实际取根路径：

- `SandboxBashExecutor.confine` 只做一件事：`this.ctx.sandbox.confine(['bash','-c',command], policy)`（`packages/shell/bash-sandbox/src/index.ts` 约 177-179 行）。
- PTY 同理：`dsh-terminal-bash` 取 `ctx.get('sandbox').confine(argv, policy)`（`packages/terminal/terminal-bash/src/index.ts` 约 105-108 行），cwd 用 `policy.workspaceRoot`。
- `SandboxPolicy` 只有单值 `workspaceRoot`；`SandboxBashExecutor.resolve` 仅补 `sandboxPolicy: request.sandboxPolicy ?? ctx.sandboxPolicy.resolve()`。
- `LocalSandboxProvider.confine(argv, policy)` 是 public 方法，且其 `internals` 是公开测试钩子。

即：bash 与 PTY 的**全部** confinement 都委托给 `ctx.sandbox`，执行器本身不参与根集合计算，也不持有任何根状态。

## Decision

替换范围收窄为两行：

- disable：`fs-sandbox`、`sandbox`。
- insert：`multi-root-scope`、`multi-root-fs`、`multi-root-sandbox`（其中 scope 是插件自有 service，不是替换行）。
- `bash-sandbox`、`sandbox-policy`、`tool-fs`、`tool-bash`、`terminal-bash` 保持上游，一行不改。

多根 grant 只在 `ctx.sandbox` 一处表达：`MultiRootSandboxProvider.confine` 在空附加根时逐元素返回 `super.confine` 的结果，在多根时扩展 grant（M2）并原样透传 `enforcement` / `denialSignatures` / `runnerFailureRules`。

fs 侧仍必须替换：`LocalFileSystem` 自身不做 containment，`SandboxedFileSystem.checkedTarget` 是 TS-private 且单根，无法以类型安全方式复用或扩展。

## Alternatives Considered

| 方案 | 否决理由 |
| --- | --- |
| 按原设计替换三行，另写 `MultiRootBashExecutor` | 其全部增量逻辑（mode 解析、escalation 包装、denial/enforcement 上报）在多根下无需改动；重写等于把上游 pre-stable 的实现面复制一份并长期对齐，收益为零、风险为正 |
| 继承 `SandboxBashExecutor` 并覆写 `run` / `start`，绕过其私有 `confine` | 私有成员不可跨包复用，覆写等于整段重实现（含 process facts 与 runner 失败分类），与上一行同因否决 |
| `extends LocalBashExecutor` 自管 confinement | 需要自行重建 mode / escalation / facts 语义，且最终仍要调用 `ctx.sandbox.confine`，属于纯重复 |
| 保留 `bash-sandbox` 但同时新增一个 bash 层来做“根集合校验” | bash 不掌握根集合，新增层只能重复 scope 解析，违反“单一权限世界”的单一解析点 |

## Consequences

- 正面：替换面从三行降到两行，升级脆弱性直接下降；bash 与 PTY 的根集合与 fs fence **由构造相同**（都来自同一份 scope），不再依赖额外的 parity 实现；`terminal-bash` 的 PTY 路径自动获得多根能力，无需专属代码。
- 代价：bash 侧不新增拒绝层，因此“bash 能写而 fs 不能写”这类不对称只能通过 fs fence 与方言 grant 的正确性来保证——由差分 parity 与 argv 等价测试钉住。
- 代价：`policy.workspaceRoot`（= session cwd = 主根）仍决定 bash 的默认 workdir 与 PTY 的默认 cwd，这正是需求“不改 Session cwd 语义”的期望行为，但也意味着“以附加根为默认工作目录”不在第一阶段范围内。
- 影响文档：架构设计稿的 patch 示例、provider 小节与总览图需同步；需求文档中“多根 bash 执行器”的机制表述需改写。

## Related Documents

- [架构设计：Multi-root Workspace](../architecture/multi-root-workspace.md)
- [开发需求：Multi-root Workspace](../requirements/multi-root-workspace.md)
- [上游调研：Workspace / Sandbox / 插件体系](../reference/multi-root-workspace-research.md)
- [M1 开发计划](../plans/completed/2026-09-12-m1-composition-and-passthrough.md)
- [ADR-0002：上游耦合策略](./ADR-0002-upstream-coupling-policy.md)
