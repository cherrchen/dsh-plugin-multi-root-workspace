# ADR-0014: 附加根数量上限与 Provider 冲突检测

## Status

Accepted

## Date

2026-10-11

## Context

第二期评审（需求 §4 P2）补充了两条失效面：

1. **根数量无界**：每条记录都要付 realpath/stat、方言 argv/profile 字节与 prompt 预算；无界增长会把授权面拖垮。
2. **Provider 替换冲突**：本插件 disable 上游 `fs-sandbox` / `sandbox` 两行并以自己的 provider 顶替。若第三方插件也替换 `ctx.fs` / `ctx.sandbox`，结果取决于装载顺序，外来的 provider 可能完全绕开我们的 scope——一个静默的更宽授权面。

对 cordis 的实测结论（`@deepseek-ai/cordis` `reflect.provide`）：同一 service key 被第二次 `provide` 时**同步抛错**——先提供者胜出，后挂载方的 fiber 响亮地死掉；`[Service.init]` 抛错经 `ctx.logger.error` 记录并传播到 `ctx.plugin()` 的 await；`reflect.notify` 在 unprovide/reprovide 时刷新依赖该服务的 fiber——注入门禁会在迟到替换时**重跑检查**。patch 中 disable/insert 的顺序不改变这条规则：赢家是"先挂载的 provider"，与 patch 文件顺序无关。

## Decision

### B6：按主根的存储记录上限

- 行配置 `maxAdditionalRoots`，默认 `16`（`DEFAULT_MAX_ADDITIONAL_ROOTS`），硬顶 `64`（`MAX_ADDITIONAL_ROOTS_CEILING`）。构造时校验整数 1..64；非法值不抛错，注册表进入 `config-invalid` fail-closed：不授予任何根、mutation 响亮拒绝并命名坏值。
- 计数 = 该主根下**全部存储记录**（含 missing / redirected / invalid）——与文件系统无关的稳定口径。
- 新增记录达上限即 `root-limit-reached`；revive/重复登记既有记录不占新额度。检查在序列化队列内、reclassify 之后。
- **超限存量永不截断**：历史超出上限的 store（例如上限被调低）照常被分类与授予，只有新增被拒绝，并每主根 warn 一次。`RootsView` 暴露 `limit` / `count`，命令与面板如实显示并禁用/解释 Add——但面板只为"新增"禁用控件：withheld / invalid 行的重新登记入口在到限时保持可用，因为 revive 不占新额度（外部审查返工，PR #10）。
- 默认值的证据：`scripts/bench-root-scale.mjs`（`pnpm bench:roots`）对 0–64 根测量分类耗时与三方言 argv/profile 字节，结果存档于 `docs/reference/bench-root-scale-darwin.json`。
- 面板 wire 的 `limit` / `count` 允许缺省，以兼容上限功能之前的宿主；缺省 count 按全部返回行计数，缺省 limit 在解析后的视图中以 `Number.MAX_SAFE_INTEGER` 表达旧宿主未报告上限，避免凭空施加默认 16 的客户端限制。显式给出的坏值仍拒绝解析，新宿主仍必须返回实际配置与计数。行配置只有 `undefined` 使用默认值，`null` 属于非法值。

### B7：品牌 + provider 门禁行

- 两个 provider 在构造时打上不可枚举的 `Symbol.for('@dsh-electron/dsh-plugin-multi-root-workspace/provider')` 品牌（值为 `'fs'` / `'sandbox'`）；判定走 `isMultiRootProvider`，不依赖 instanceof（重复安装的包）或 cordis 私有字段。
- 新服务行 `multi-root-providers`（service `multiRootProviders`，inject `multiRootCompat, fs, sandbox`）在 `[Service.init]` 检查 `ctx.fs` / `ctx.sandbox` 是否是我们的品牌；任一方为外来者即 log error 并 throw，使本行响亮失败。cordis 的 notify 机制保证迟到替换会重跑该检查。
- 注册表、指令、LSP、workspace-files 均 inject `multiRootProviders`：任何外来 provider 下这些行不存在 ⇒ scope 空 ⇒ 无任何授予——与行序无关，确定性 fail closed。

### B5：mutation 前先 reclassify（ADR-0004 修订）

所有 mutation 在序列化队列内先以存储记录重新分类再校验，不读缓存状态；revive 判定同样基于 fresh 分类（缓存 `available` → symlink 换向 → 重加原路径时必须 revive 同一条记录而非新建第二条）。详见 [ADR-0004 修订](./ADR-0004-root-registry-persistence-and-validation.md)。

## Alternatives Considered

- 上限按"可用根"计数：随目录生灭抖动，操作者无法预期；改按存储记录计数。
- 超限时删除最旧记录：静默改变授权集，拒绝——只拒新增。
- 非法上限时构造抛错：整棵 cordis 树会因一行配置起不来，选 fail-closed 服务态（与 storage-unavailable 同型）。
- 冲突检测用 instanceof 或 cordis 私有 entry 字段：跨重复安装失真，且私有面不属上游承诺，选符号品牌。
- 冲突时只 warn 继续：外来 provider 可能已带自己的授权语义，继续跑等于接受未知宽化，选 fail closed。

## Consequences

- 授权集只增不减的路径只剩 operator 显式操作；容量成本有上界且可配置。
- 任何外来 `ctx.fs` / `ctx.sandbox` 下组合响亮失败而非静默宽授权；代价是合法的第三方 provider 组合也被拒绝——这是刻意的偏严，放行需要本插件显式适配。
- `toolAccess` / `maxAdditionalRoots` 这类行配置成为宿主可调参数，其校验失败一律 fail closed 且不抛错。

## Related Documents

- [B4–B8 开发计划](../plans/active/2026-10-11-b4-b8-p2.md)
- [ADR-0004 注册表持久化与校验](./ADR-0004-root-registry-persistence-and-validation.md)
- [ADR-0009 DSH 兼容性代码契约](./ADR-0009-dsh-compat-contract.md)（门禁行同一模式）
- [根数量基准](../reference/bench-root-scale-darwin.json)
- [provider 冲突回归](../../tests/provider-conflict.spec.ts)
