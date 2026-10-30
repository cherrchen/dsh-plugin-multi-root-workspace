# ADR-0024: Registry 操作准入与撤权顺序

## Status

Accepted：撤权语义与本地操作准入合同。A1 最初仅接入 fs；后续共享服务与全消费者接缝由 [ADR-0025](./ADR-0025-shared-registry-authority.md) 采纳，替代 ADR-0007 的单持锁进程消费限制。

## Date

2026-10-29

## Context

[共享权威服务提案](../architecture/registry-authority-service.md)的首要问题是撤权成功的保证，以及新操作怎样与 mutation 排序。仅广播版本不能保证其他 Host 不从旧缓存授权；将同步 `confine` / `spawn` 直接改成 RPC 也破坏兼容合同。

先在当前单权威实现中建立可执行的 fs 准入边界，以真实持久化和确定性屏障验证顺序，再迁移其他消费者和 IPC。准入不能成为另一份根数据源，不能改变 session origin、三态访问矩阵、工具上限或未知权威时的主根限制。

## Decision

1. **采用“新准入有序，在飞短操作可完成”的撤权语义。** 准入被定义为操作开始。撤权成功后发起的新准入使用撤权后的权限；先前已准入的操作可以稍后完成检查、写入或启动。因此撤权应答不是“从此不会再出现旧操作的效果”的屏障，不等待失联 Host 或长期进程结束。
2. **本地 `withOperation(policy, kind, body)` 与所有 mutation / refresh 共用 store-wide 工作队列。** 整个 mutation 仍是读 → 重分类 → 校验 → 落盘 → 发布，准入在同一队列内取得唯一登记状态，再由 scope 计算当次权限。实际 fs 检查和 I/O 在队列外执行，慢操作不阻塞撤权。原每主根队列提升为整个 store 的顺序，不改变持久化 schema。`refresh()` 仍是重新分类的唯一公共读取入口；准入不写根表、不隐式重新登记，也不覆盖测试和冒烟使用的 `setAdditionalRoots()`。
3. **一个 fs write/edit 调用就是一次准入。** 不依赖 `tools/execute` 必定存在；直接 `ctx.fs.writeText/editText` 同样进入 Registry。scope 捕获保留真实调度 ALS 中的工具封顶；调度外仍按既有未知工具身份规则收窄。没有 gated Registry 的组合继续走原 scope fence，provider 不增加 compat 硬注入。
4. **执行身份与快照分开。** 本地 operation 身份含随机 `operationId`、Host 推导的 fs kind、每次成功打开介质新建的 `authorityEpoch` 和本轮 publication revision。snapshot 按值复制并冻结；operation handle 的 scope 仅在 callback 内可读取，成功、失败后均失效。这些身份不是可序列化、可复用的远程授权凭证；共享协议另以 store/epoch 与认证连接核验当次 admission。
5. **revision 表示有效 publication，不代表完整远程授权协议。** scope grant/deny 或 Skills metadata 的真实 publication 才递增；重复刷新不增版、不通知。路径身份每次 scope 捕获仍重新检查；未触发 publication 的 filesystem 变化不依赖 revision 发现。未知权威的 operation 不带 epoch，scope 按原规则收窄。拆除开始后拒绝新的 operation，不再读取已经卸载的服务；原有排空 mutation → close domain → release lease 顺序不变。
6. **进程继续遵循既有快照合同。** 旧 PTY 的下一条命令和旧进程派生的子进程仍可能继承旧权限；需要回收时必须结束或重建进程。不能把一个 turn、PTY 或缓存 profile 当作无限次新操作的许可。

## A1 的历史边界与后续接入

A1 最初只有本地 fs 基础，不是多实例一致授权的完成证据。后续共享服务已接入同步 `confine/spawn`、shell/PTC/agent PTY、LSP、Files/watch、instructions 和 Skills，补充 IPC 管理权限隔离、store 身份、断线保守拒绝、epoch 与结果不明协议；当前合同见 [ADR-0025](./ADR-0025-shared-registry-authority.md) 和[共享架构](../architecture/registry-authority-service.md)。本节不把未来平台矩阵标为已验证。

## Alternatives Considered

- 撤权等待所有旧操作完成：承诺更强，但失联 Host 会阻塞撤权；第一版不采用。
- 用 scope revision 或通知放行新操作：消息可能延迟或丢失，不能与 mutation 建立顺序。
- 把整个文件 I/O 或子进程生命周期放入 store 队列：慢操作会阻断所有项目的管理操作。
- 只包工具调度：绕过直接 fs 服务调用，且旧宿主并无该调度接缝。

## Consequences

单独使用 A1 时仍只有持锁进程使用附加根；配置 ADR-0025 的共享模式后 follower 可以取得本次 grant。store 级队列降低了跨项目 mutation 的并行度，这是为后续单权威排序付出的明确代价。路径检查继续保留现有 TOCTOU 边界，不能宣称是对任意恶意 rename 的原子事务。

确定性测试在 `tests/registry-operation.spec.ts`：用真实 JSON backend 和内核 lease，在落盘、准入后的路径解析处设置 Promise 屏障，验证撤权两侧的效果、跨主根顺序、callback 生命周期、接管 epoch、三态矩阵和工具封顶。平台及完整执行结果只记[路线账本](../plans/active/2026-09-12-multi-root-workspace.md#多-host-权威服务开发2026-10-29)。

## Related Documents

- [ADR-0007：Authority Lease](./ADR-0007-registry-authority-lease.md)
- [ADR-0012：Session origin 与进程快照](./ADR-0012-session-origin-and-effective-cwd.md)
- [ADR-0013：工具写权限上限](./ADR-0013-per-root-and-per-tool-access.md)
- [共享 Registry 权威服务设计提案](../architecture/registry-authority-service.md)
