# ADR-0040: Auto Review 多基线支持合同

## Status

Accepted

修订 [ADR-0021](./ADR-0021-auto-review-context-companion.md) 与 [ADR-0022](./ADR-0022-auto-review-loader-entry.md) 中“联合支持集合必须恰好是一个精确发布”的结论；两者的上下文、权限投影、来源身份、freshness、审查协议与生命周期决策继续有效。

## Date

2026-11-14

## Context

可选 Auto Review 集成把官方 `packages/experimental/auto-review/src/index.ts` 完整 fork 进主包，只允许固定的差异集；支持声明因此一直钉在单一精确发布 `0.2.1-rc.2`。普通支持合同已经覆盖 24 个精确版本，联合合同落后 8 个发布。

上游在这段范围里改了一次 reviewer 输入模型：`0.2.2-alpha.2` 把“五段单消息”换成“固定 system + 每条保留项一条 user message”，并新增逐项 schema、跨审查 schema 复用、失败错误码与卸载语义；`0.2.2-alpha.3` 又新增 `sessionId`/`purpose` 请求身份与 `LlmRequestPurposeMap` 声明合并。`0.2.1` 线在 rc.2 之后源码冻结，`0.2.2` 线 alpha.3 之后源码冻结。事实与逐项差异见[多基线接口审查](../reference/auto-review-0.2.2-migration.md)。

一次性把 fork 重做一遍无法同时保留两条线的官方语义：0.2.1 车道的 cordis 没有基线 B 需要的运行时符号，0.2.2-alpha.2 的 `purpose` 仍是闭集，`dsh-tool-executor-ptc/types` 在 0.2.1 车道不存在，而发布产物只有一个 tarball。

## Decision

### 基线分组与精确发布

`src/compat/auto-review-contract.ts` 是联合合同的唯一机器可读事实源，声明两个基线及其精确发布集合：

- `0.2.1`：`0.2.1-rc.2`、`0.2.1-rc.3`、`0.2.1-rc.4`、`0.2.1-rc.5`，fork 基线 `dsh-v0.2.1-rc.2`（`687f282e86`）。
- `0.2.2`：`0.2.2-alpha.2`、`0.2.2-alpha.3`、`0.2.2-rc.1`、`0.2.2-rc.2`、`0.2.2-rc.3`，fork 基线 `dsh-v0.2.2-alpha.3`（`05b1cae8db`）。

声明单位仍是精确发布，不是 semver 范围；每一项都要有该发布在 CI 车道上的真实安装树与完整门禁证据。`AUTO_REVIEW_RELEASES` 由两张表扁平化，`autoReviewBaseline(release)` 是运行时与全部脚本共用的唯一映射；`check-dsh-compat.mjs` 校验每个成员都在普通 allowlist 内。

每个基线有唯一的**编译 pin**：0.2.1 线取 `0.2.1-rc.5`（rc.2–rc.5 被消费包的源码与声明未变），0.2.2 线取 `0.2.2-rc.3`。实现类型检查只在开发 pin 等于当前基线的编译 pin 时执行；其余车道只做运行时验证（该发布 .d.ts 与编译 pin 的差异不构成运行时差异，而 `0.2.2-alpha.2` 的闭集 `purpose` 使同一源码无法在该发布下通过类型检查）。

### 两份实现、按车道动态加载

源码树按基线分目录保存：`src/auto-review/legacy/` 与 `src/auto-review/current/`，各自包含逐字节上游源码、`fork.ts`、`fork.patch`；`src/auto-review/partition.ts` 保存基线无关的 native/当前约束核对算法，`entry.ts` 是唯一 Loader entry。

两份实现分别成为独立 tsdown host entry，`entry.ts` 在确认发布属于合同后，按基线用 `new URL(..., import.meta.url)` 计算产物路径并动态 `import()` 选中的实现，对模块导出面做最小结构校验后 `ctx.plugin` 挂载。禁止静态同时导入两份实现：基线 B 的 `@deepseek-ai/dsh-tool-executor-ptc/types`、`LlmRequestPurposeMap` 与 `FiberState` 相关导入在 0.2.1 车道不存在或不成立。`FiberState` 是 `const enum`（类型层），发布包没有该运行时导出，因此基线 B 把 `FiberState.ACTIVE` 改写为带注释的字面量 `2`。

每个基线仍按 ADR-0021/0022 的差分规则维护：基线哈希、patch 重建、受保护函数（policy/身份/协议/注册与卸载尾部）不得漂移，`api.d.ts` 的公开导出面与 `entry.ts` 一致。

### 基线 B 的允许差异

除既有允许差异（只读 context builder、环境与当前 constraint、native 指令核对、freshness 复核、token 关联复核、执行副本检查）外，基线 B 新增：

1. constraint 项进入 history 前的核对：可证明为附加根来源且已陈旧的整帧降为 `fact`，由当前快照完全替代的帧丢弃，混合帧仍失败关闭。
2. `ENVIRONMENT` 消息合入多根环境与 `executionFence`；当前附加根约束作为 constraint 项插在环境消息之后、历史项之前（镜像基线 A 的 `PROJECT_INSTRUCTIONS` 位置），保持“环境固定、历史按 Session 顺序只追加、待审调用最后”的上游前缀缓存前提。
3. `0.2.2-alpha.2` 不发送 `sessionId`/`purpose`（该发布的官方行为与闭集类型），`alpha.3` 起发送；分支由 `autoReviewRequestIdentity(release)` 决定，版本知识只出现在 `src/compat/`。

### 测试、脚本与证据

官方回归副本、上下文测试与差分门禁按基线成对维护；`vitest.config.ts` 只收集当前开发 pin 对应基线的目录，`loader.spec.ts` 与 `overlap.spec.ts` 是基线无关的常驻回归。`scripts/lib/auto-review-development.mjs` 按基线维护开发包清单，`upgrade-dsh.mjs` 只为目标发布的基线安装清单。CI 在每个联合发布车道执行差分门禁、完整单测与联合冒烟；非联合车道继续显式跳过并退出 0。

## Alternatives Considered

- **只保留一份实现并用运行时探测切换语义**：0.2.1 与 0.2.2 的 reviewer 输入模型不同，一份实现必须同时包含两套协议与渲染路径，差分门禁与官方回归都将失去明确基线；拒绝。
- **把基线 B 重写成可在 0.2.1 编译**：需要删掉上游的 `FiberState`、PTC 类型与 purpose 声明，远离官方源码，差分规则退化为“大致一致”；拒绝。
- **每个发布一份实现**：9 份安全敏感副本，维护成本与漂移面不可接受；源码代际只允许 2 份。
- **放宽 `AUTO_REVIEW_RELEASES` 为 semver 范围**：违反 ADR-0009 的精确发布原则；拒绝。
- **在 0.2.2 车道继续只跑旧协议**：会让 reviewer 输入与官方语义分叉，并与上游新前缀缓存设计冲突；拒绝。

## Consequences

- 维护面从一份 fork 变成两份，但每份仍在冻结的源码代际内，且差分门禁按基线独立运行；上游再改 reviewer 输入模型时只需重做对应基线。
- 发布产物同时包含两份实现的 chunk；每个车道只执行匹配的一份，默认关闭行仍不加载任何 reviewer 或 provider 代码。
- 编译验证按基线的编译 pin 执行，其余联合发布车道提供运行时证据；支持声明的证据组合必须在路线账本逐项记录。
- 普通插件合同、默认 Auto 行为、fs/进程/kernel 围栏与 provider 门禁例外均不因本决策改变。

## Related Documents

- [多基线适配计划](../plans/completed/2026-11-14-auto-review-multi-baseline.md)
- [多基线接口审查](../reference/auto-review-0.2.2-migration.md)
- [ADR-0009](./ADR-0009-dsh-compat-contract.md)、[ADR-0021](./ADR-0021-auto-review-context-companion.md)、[ADR-0022](./ADR-0022-auto-review-loader-entry.md)
