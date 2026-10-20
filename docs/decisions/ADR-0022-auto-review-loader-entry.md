# ADR-0022: 主包内可选 Auto Review loader entry

## Status

Accepted

取代 [ADR-0021](./ADR-0021-auto-review-context-companion.md) 的独立包、bundle 排序与 configure 交付决策；其上下文、权限投影、来源身份、freshness、审查协议与卸载语义继续适用。

## Date

2026-10-20

## Context

companion patch 只能禁用前面已经插入的官方行，必须靠 configure 将 companion 排到 bundles 末尾。用户需要单一主包、默认关闭、通过现有插件管理器中的行开关启用，且不承担该排序契约。首次需求评审与最小复现见[评审记录](../plans/active/2026-10-20-auto-review-in-package-review.md)。

## Decision

### 交付和默认行为

fork 移入 `src/auto-review/`，主包导出 `./auto-review` → `lib/auto-review.js`。主 patch 插入唯一 id `multi-root-auto-review`，`disabled: true`、`required: true`。disabled entry 仅是可展示的配置元数据：没有运行时 context、reviewer 或接管 hook。carrier barrel 不导出该入口，不增加默认可选依赖求值。

入口保留 `multiRootCompat`、provider brand 与全部基础服务注入，启动前检查 `assertAutoReviewRelease` 和 fork 的实际执行副本。只有 DSH `0.2.1-rc.2` 可启用；普通主包支持集合不变。context 和 reviewer 在入口下面按需挂载，无第二个用户开关。

### 接管与恢复

`src/compat/auto-review-loader.ts` 封装 loader 接缝。接管只处理同组、模块名为官方 Auto Review 的 entries；不根据单独的 id 猜身份。旧 companion 共存时给出明确迁移诊断。

对已经存在的官方行，先设置运行时 disabled，再通过 `parent.remove()` 停止并移除，等待 disposer/drain 后启动 fork。禁止使用会写回配置的 tree-level remove/update。`internal/plugin` hook 在新 fiber 执行 apply 前停止官方 fiber，因而覆盖开始接管前已在进行的 import；不能仅依赖 remove 取消 import。

官方 bundle 未被选择时入口独立运行：fork 自身注册 Auto preset，没有可接管的 owner，不构成错误路径。

启用期间包装公开的 group update，记录原始 desired 配置并在运行时列表中暂时排除官方行，覆盖后续 reload。原方法保留 caller receiver，卸载恢复属性描述符。关闭时，Loader 的 entry disposal 必须在 update 调用内同步开始，因为 Include 不 await group update，loader.await 只跟踪 entries 的 import/inertia；不能把整个 update 推迟到另一个等待 drain 的 Promise 后面。

入口将接管 hook 与子插件 disposer 收进同一个有序 effect。Cordis 对同一 fiber 的独立 disposers 使用并发清理，不能依赖注册顺序保证排空。reviewer 先停止并排空，context 随后回收，然后按 desired 配置恢复原本应存在的官方行；官方原先 disabled 或未被选择时不会强行启用。完整 profile 退出不恢复官方，注入服务失效也不主动恢复为官方 fallback。

卸载仍遵循官方 Auto → Full access 语义，不自动重新选择 Auto。没有 HMR 的 profile 保留管理器 restart-required 行为。

### 构建、维护与旧 profile

主包 bundle/prepare 总是生成子路径 JS，所有普通矩阵车道均保留公开声明；精确 fork 的实现类型检查与主 host 项目隔离。仅供 fork 开发和上游回归使用的依赖在旧版 probe 中移除，避免重指到未发布的包。独立 workspace、manifest、tarball、configure 和发布版本协调流程退役。

原始上游源码、MIT、显式 fork.patch 与安全函数差分校验保留；迁移没有改变 reviewer policy、授权来源或执行围栏。旧 profile 需先移除 companion bundle/依赖，再启用内置行；不在 apply 中自动改用户 manifest。用户操作见 [Auto Review README](../../src/auto-review/README.md)。

## Consequences

无需第二个包或 companion 排序，但仍承担 loader 生命周期接缝的测试和维护成本。`internal/plugin` 的执行前时点、异步 drain、Include 的重组等待语义，以及恢复原配置都必须由真实 loader 与真实 profile 回归钉住。平台执行、未覆盖项和发布状态仅维护于[路线账本](../plans/active/2026-09-12-multi-root-workspace.md#auto-review-内置入口迁移2026-10-20)。
