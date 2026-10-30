# ADR-0025: 多 Host 共享 Registry 权威服务

## Status

Accepted。启用 `sharedStorageRoot` 时，替代 ADR-0007 中“只有持锁进程可使用附加根”的条款；唯一存储管理者、持续内核锁和拆除顺序继续有效。未配置此项的内部/旧组合保留 ADR-0007 行为。平台与版本执行证据仅见[路线账本](../plans/active/2026-09-12-multi-root-workspace.md#多-host-权威服务开发2026-10-29)。

## Date

2026-10-30

## Context

Issue #24 的重复通知 hot-fix 消除了刷新循环，但第二个 Host 仍不能使用附加根。JSON backend 在打开后以内存为真源；多个独立打开者即使轮流短持锁，仍会覆盖其他实例的更新。仅广播 scope 或版本也不能保证撤权后发起的新操作取得新权限。

原设计审计提出的六个问题——撤权时点、逐操作排序、同步消费接缝、断线负授权、旧 PTY 快照和 IPC 权限入口——必须同时解决。需要保持现有存储格式、每根访问三态、工具写权限上限、面板 session-derived authority 及 provider 门禁。

## Decision

1. **持锁 Host 承载唯一核心，其他 Host 使用 facade。** Registry 对外接口保持；仅 owner 通过公开 JSON/backend/domain API 打开显式绑定的 `sharedStorageRoot`。follower 不打开 domain。默认 bundle 配置该根及同目录固定名的 lease；拒绝介质/锁配置错配和替代锁名。
2. **沿用 ADR-0024 的撤权合同。** owner 的 store-wide 队列排列所有 mutation、重分类和 admission；owner 自己也走此队列。准入应答建立本次操作身份，实际 I/O 不占住队列。在飞调用可完成；撤权不等待旧进程和旧 PTY。
3. **本地短期上下文连接异步与同步接缝。** fs、异步 shell/PTC、agent PTY、LSP、Files、instructions、Skills 在各自入口重新准入；工具 waterfall 补足同步执行器的异步上层。同步 `confine/spawn` 保留返回形状；没有有效准入时只允许保守主根范围。直接使用同步 shell handle 的 Host 调用者须以异步 `registry.withOperation()` 包住启动和结算，不可保存 profile 作为未来许可。profile 必须由本次上下文生成，并绑定工具 cap；agent PTY 在新准入下重新生成 profile。
4. **内核认证连接，不发行可读凭据文件。** POSIX 连接检查实际 peer；Darwin 用 audit token 与 sandbox 状态，Linux 用 SO_PEERCRED、SO_PEERPIDFD 和 NoNewPrivs。Windows 本机 pipe 检查实际 impersonation token，拒绝其他用户、restricted/AppContainer/低完整性以及本插件 ambient-deny token。连接不继承到执行的子进程。不能证明 peer 身份时拒绝共享，不能仅凭同 UID 放行。具体能力前提和信任范围见[架构](../architecture/registry-authority-service.md#4-ipc-权限边界)。
5. **epoch 与全量快照维护投影，不替代授权。** store 身份绑定物理介质；每轮成功打开产生随机 epoch；有效根及 Skills metadata 变化递增 revision。新 epoch 必须重新握手/同步。通知可丢失，下一次 admission 仍从 owner 获取状态。
6. **有界协议与明确的不确定结果。** 版本化严格 NDJSON、连接/消息/请求/去重上限、5 秒请求超时。连接内 UUID mutation 去重（仅保留紧凑结果），参数不同的 ID 重用断线；不承诺跨崩溃 exactly-once。mutation 丢应答直接报告结果不明，不自动重放；先 refresh 对账再由调用者决定下一项操作。
7. **故障保留拒绝信息。** 断线撤销新 grant，保留在册/withheld 路径，Files 对未知外部路径也拒读；Full-access/Workspace-write 收窄到主根且不授予共享临时区。unknown-state 写入使已打开核心隔离至重启，并继续持锁。只靠内核 lease 竞选；超时不允许抢占暂停的 owner。新 owner 从磁盘重新打开，不复用旧快照。

## Alternatives Considered

- 缩短持锁时间、按项目锁同一 JSON、为同一文件配置不同锁：不能解决独立 backend 内存覆盖和跨实例授权顺序。
- 用通知、scope 版本或短租期放行：无法证明操作与 mutation 的顺序，暂停/失联期间存在旧授权。
- 同步 IPC 或把同步 API 改成 Promise：阻塞本进程承载的服务，或破坏受支持版本调用形状。
- 仅文件/同用户口令认证：受限 agent 能读取或复制时会成为 Registry 管理入口。
- 立即改独立 daemon：增加安装、升级和退出管理；首版接受 owner 停顿导致其他 Host 新授权暂停的可用性代价。

## Consequences

同机器、同用户、同锁命名空间的 Host 可同时使用附加根，只有一个存储管理者。新的 admission 增加本机 RPC 开销；主根和未知权威的安全行为仍可工作。共享模式的同步 scope 展示与执行 API 刻意分离，Host 集成者需要明确直接同步进程入口的异步上层。

已启动进程、池化 LSP server 和旧 PTY 的后续自主行为保留启动快照；立即回收须结束/重建进程，不在本次撤权成功承诺内。路径重新检查延续既有 TOCTOU 边界，不能声称文件系统 rename 与授权原子化。首版不支持网络共享介质、跨用户/机器或不同容器挂载视图；Windows 限同登录会话命名空间。原生平台和支持版本的未执行矩阵须如实保留在路线账本。

## Related Documents

- [共享服务架构与协议](../architecture/registry-authority-service.md)
- [ADR-0007](./ADR-0007-registry-authority-lease.md)：历史 lease 合同
- [ADR-0024](./ADR-0024-registry-operation-admission.md)：撤权与在飞操作语义
- [ADR-0011](./ADR-0011-multi-root-workspace-consumers.md)、[ADR-0012](./ADR-0012-session-origin-and-effective-cwd.md)：消费者与进程快照
