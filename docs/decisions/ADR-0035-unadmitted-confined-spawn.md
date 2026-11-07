# ADR-0035: 准入外受限 spawn——铸造台账与外部服务准入

## Status

Accepted：修补 [ADR-0024](./ADR-0024-registry-operation-admission.md) / [ADR-0025](./ADR-0025-shared-registry-authority.md) 引入的准入闭环对第三方消费者的误伤。实验性 forge bundle（`@deepseek-ai/dsh-experimental-forge-bundle`）的面板 Git 检查与 worktree 服务在该修复前被进程围栏硬性拒绝。

## Date

2026-11-07

## Context

`v0.1.12`（commit `abdb5c6`）落地逐操作准入后，`ctx.subprocess.spawn` 对带受限 profile 的 argv 要求「本进程存活准入帧内铸造」的证明。准入证明是 AsyncLocalStorage 里的进程内状态，只能由本插件包装过的接缝（工具派发、shell/PTC 执行入口、agent PTY、fs 写、OPS）签发——这是一个枚举出来的**封闭消费者集合**。

forge bundle 走的是上游完全合法的 `ctx.sandbox.confine(...) → ctx.subprocess.spawn(...)` 直组合：面板构造时的 `inspectOnce` 后台检查、`follow` 等异步生成器驱动的重检、`worktrees` 服务的创建与恢复。这些路径不经过插件包装的任何接缝，拿不到证明，spawn 现场无法区分「刚由本进程 provider 铸出的 argv」与「来源不明的缓存 argv」，被 fail-closed 拒绝——面板把错误渲染为「无法读取 Git 信息」。不变量 6 记载的设计语义本是「仅主根可写」的降级，实际表现却是硬失败。

同时，`resolve()` 在无存活准入时本来就返回 `authority: 'unavailable'` 的收窄 scope，即无归属的 `confine` 铸出的**已经是主根钳制 profile**——拒绝 spawn 并不带来额外安全收益，只是把降级变成失败。

## Decision

1. **铸造台账承认本进程刚铸出的、无帧的 profile。** scope 维护单调递增的 `publicationVersion`，在根表发布内容变化或权威可用性翻转时递增并清空台账。每条 mint 在其**同步入口处**（`confine`/`clampedExecution`/`restrictedExecution` 的 `resolve()` 同一时刻）捕获 `captureMint()` 戳记 `{version, capped}`——异步 probe 完成后才落账的 mint 必须带着「铸造时」而非「写入时」的发布代次，否则一个跨发布的 in-flight mint 会以新版本重新入账、绕开版本闸。`rememberProfile` 按 `operationFrameState` 三态分流：`active` 照旧记帧（绑帧死亡）；`expired` **直接丢弃**——过期准入绝不留存后代 profile，携带真实附加根授权的 mint 与其操作同生死，不会「晋升」成台账项；`absent`（真正无帧）才把 `{argv, capped, version}` 记入进程内有界台账（上限 256 条，溢出丢最旧）。`permitsProfile` = 帧内匹配 **或** 台账中 argv 前缀匹配 + `capped` 一致 + `version` 等于当前发布。

2. **可达的外部服务入口照常拿真准入。** `ctx.inject` 按 `src/compat/forge-entrypoints.ts` 持有的上游清单（已核对基线 `@deepseek-ai/dsh-experimental-forge-bundle@0.2.2-rc.1`）包装 `worktrees` 服务的 `create`/`restore` 与 `forgePanel` 的全部以 Session 为首参的公开方法，按首参的 `Session`（或携 `.session` 的 `Agent`，结构探测 `sessionOf`）解析 `sandboxPolicy` 后进入 `withRegistryAdmission(..., 'process', ...)`。这些 RPC 驱动的路径获得完整的「有序快照 + 存活期」语义，与既有 wrapped executor 相同；服务未挂载时 `inject` 不触发，无成本。覆盖边界要精确：`requestWorktree` 的包装只覆盖同步记账——真正的 worktree 创建发生在 RPC 返回之后、由面板隔离组内**私有** `forge-worktree` 实例的 `holdCreation` 路径执行（根 `worktrees` 服务的包装触达不到隔离实例），它继续走台账（主根钳制）；`restoreWorktree` 在 RPC 帧内 `await` 整个恢复，隔离实例的 `confine`/`spawn` 经 ALS 继承外层帧，**恢复是准入的**。异步生成器（`follow`/`changeRequestStates`）无法持有同步准入，其驱动的 detached 检查走台账。

3. **OPS 执行域不享受台账，OPS 保护窗口对台账 mint 同样严格。** OPS 侧 spawn 判定用 `permitsOperationProfile`（只认存活准入帧内铸造）。OPS 维护守卫的 launch-permit 判定同样改用 `permitsOperationProfile`：台账 mint 平时照常启动，但**在 OPS 兼容保护激活、存在 deny 根期间，被维护守卫按「无归属 spawn」拒绝**——台账可证明「argv 是本进程所铸」，不可证明「它是准入所付」。

4. **台账不扩大任何授权。** 有 `admissionProof` 时无帧 `resolve()` 必然返回 `unavailable`，进入台账的 mint 天然只有钳制（或 read-only 不可写）形态；放行它等价于「此刻重新 confine 同一条命令」。台账项随任何真实发布失效（重复发布同一内容不算发布），伪造 argv、他进程 argv、被超越发布的 argv、过期帧遗留的 argv 依旧拒绝；`danger-full-access` 无 profile，不受影响。

## Alternatives Considered

- **只包装消费者（纯方案 A）**：可达入口能拿准入，但面板 `inspectOnce` 构造期分离发起、`follow`/`changeRequestStates` 异步生成器在消费者上下文内执行、面板组内隔离挂载的 `forge-worktree` 实例插件上下文不可注入——枚举式包装覆盖不了，仍需台账兜底。
- **spawn 现场补准入**：`spawn` 是同步函数，`withOperation` 是异步的，无法在等待中保持返回形状。
- **放宽 `resolve()` 让无归属调用也拿到附加根**：等于把「re-resolving 不是 re-authorizing」的不变量 1 打破，未知调用边界一律收窄的现状是刻意的。
- **台账不过版本闸（永久有效或仅 consume-once）**：前者让一份 mint 可以穿越撤权长期存活；后者对「mint 后多次 spawn」的合法上游用法（forge 不这样做，但 API 不禁止）不兼容，而「发布稳定期内可启动」语义已经够用且更易证明。

## Consequences

- 无归属 `confine→spawn` 恢复为记载中的降级：**以主根钳制 profile 正常启动**，forge 面板 Git 检查、`worktrees` 直用、以及任何同样组合的第三方插件不再被硬拒。
- 被包装的 forge 入口获得比其他外部路径更强的语义（有序快照 + 存活期帧内 profile，可携带真实附加根授权）；台账路径永远是钳制形态。
- 台账是**进程内可信边界**而非逐调用授权：条目按 `argv` + `capped` + 铸造时版本绑定，不绑定发起调用方、primary 根或 mode——同一进程内任何调用方持有同一 argv 即视为同源 mint。这在「provider 只铸自己认可 profile」的前提下不引入跨调用方授权，但不提供逐调用归因。
- 台账进程内、有界、随发布失效：profile 可用期从「operation 存活」放宽为「授权基线未被超越」，对钳制 profile 而言能力等价；容量按**条目数**计（上限 256），一次 unadmitted `confine` 写 prefix 与 prefix+command 两条，有效容量约 128 次 mint——突发淘汰按 FIFO，等待中的条目可能被挤出（此后 spawn 被拒，调用方重新 confine 即可）。
- 包装纯状态 RPC 的代价：`dismiss`/`markReady` 这类本可纯本地完成的方法现在也要经 `withOperation` 的 lease/IPC 队列排队，并在 registry 已 dispose 时抛错——属可接受的激活成本，换「任何 Session 首参入口都可能藏 confined spawn」的统一覆盖。
- 过期准入不再间接续命：异步 mint 在其操作结束后完成 → 直接丢弃；携带真实授权的 profile 与其操作同生死。
- 上游新增未枚举的服务入口不崩溃也不放行——退化为台账语义，兼容清单按结构探测（`isAsyncProcessEntry`）而非版本号；getter 形态暴露的目标方法跳过并告警而非拖垮包装。

确定性回归在 `tests/shared-consumers.spec.ts` 与 `tests/ops-compat.spec.ts`：台账放行/发布失效/伪造 argv 拒绝、铸造时戳记（跨发布 in-flight mint 被拒）、过期帧 mint 不落账（带真实授权的 profile 随操作死亡）、成员重定向下无授权 mint 不可失效且 argv 明文断言、forge 形服务入口准入与生成器/未列名入口的旁路、OPS 保护窗口对台账 mint 的拒绝与解除后的放行。

## Related Documents

- [ADR-0024：Registry 操作准入与撤权顺序](./ADR-0024-registry-operation-admission.md)
- [ADR-0025：共享 Registry 权威服务](./ADR-0025-shared-registry-authority.md)
- [ADR-0029：OPS 文件授权与活动适配](./ADR-0029-ops-file-authorization-and-activity-adapter.md)
- [共享 Registry 权威服务设计提案](../architecture/registry-authority-service.md)
