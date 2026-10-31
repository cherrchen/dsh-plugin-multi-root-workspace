# ADR-0026: Registry 权威后台恢复与故障诊断

## Status

Accepted（合同定案；实现已完成并经 macOS 本机验证，三平台 CI 与真实 TUI soak 未完成）。本 ADR 在 ADR-0025 合同内增加"降级后自动恢复"的调度与通知保证，不改变 lease、准入、撤权、epoch 或 unknown-state 语义；F4 专项计划 rev.4 经技术评审通过后立项，rev.5 吸收实施前源码审核门的发现（第 8 条）。执行证据按批次记入[路线账本](../plans/active/2026-09-12-multi-root-workspace.md)。

## Date

2026-10-31

## Context

ADR-0025 的共享权威服务把恢复做成按需路径：contended、follower 断线、可重试的 `storage-failed` 都汇入 `ensureAuthority()`，但只有用户操作或 `refresh()` 才驱动它——owner 退出后 follower 在下一个操作之前保持降级，满足"保守拒绝"却不满足"无需用户操作即恢复"。F4 技术评审（[专项计划](../plans/active/2026-10-31-f4-background-recovery.md) rev.1–rev.4）对当前实现做了实机核对，确认恢复引擎本身可复用，但五处缺口会在后台重试下变成真实缺陷：

1. follower `hello` 成功后无任何投影同步，已跟踪主根可能无限期 withheld；
2. `remoteUnavailable`/`enterStorageFailed` 写 withheld 后清 `published`，使空快照签名 `''` 撞缺省值、旧 scope 边界清不掉（实机复现：发布 0 次、scope 残留 read-only 拒绝边界）；
3. `openDomain()` 先逐 key 发布再 listen，listen 失败整轮产生 `available → withheld` 通知振荡（实机复现两轮 4 次发布），且中途写 `cache` 会让 `list()`/Files/`withPrimaryOperation` 读到半提交状态；
4. 提交顺序反转后，同步回调仍能在 `publish()` 内观察到"新 scope、旧 cache"——`notifyShared()` 的 `snapshotOf()` 与监听器 `list()` 都读 `cache`，且 `setAdditionalRoots()` 同步通知 `subscribe()` 订阅者（Skills/Files）；
5. `unref()` 定时器不构成握手取消：POSIX channel 是持事件循环引用的 `Socket`，未 adopted 的 client 无法被 dispose 关闭；`storage-failed` 把可重试、须改配置、quarantine 三类压成一个 kind。

Issue #24 的教训是本批的边界条件：后台恢复绝不能再造一个通知反馈循环。

## Decision

1. **唯一恢复入口与结构化重试资格。** 后台重试仍只走 `ensureAuthority()`（`authorityChain` 串行、幂等、`disposed` 检查不变）。降级入口携带结构化分类：`retryable`（acquire 非争用失败、domain open 失败、server listen 失败、follower 连接失败、contended）、`config`（leasePath 缺失/非绝对、介质与锁配置错配，须改配置后重载）、`quarantine`（unknown-state，隔离至重启不变）。不得解析错误文本判资格。
2. **调度不变量。** 每实例最多一个待执行 timer、一个在飞尝试；下一轮从本轮完成后计时；重复降级通知不重置退避、不叠加排队，并发恢复请求合并；退避约 1s ×2 封顶约 30s ±20% jitter，timer `unref`；可恢复故障持续低频重试不设次数上限；默认开启、patch 行布尔开关可关。`dispose` 使恢复代次失效：清 timer、取消在途握手、拒绝晚到连接（沿用 `connectionGeneration`/`adopted`）。
3. **恢复完成 = 连接 + 已跟踪主根投影同步。** `hello` 成功不算恢复。连接建立后离开 `authorityChain` 逐 key `remoteSnapshot` 同步本 Host 已跟踪主根（`cache` 键集）；空快照也必须应用以清除旧投影；只要失败 key 集合非空就有界重同步（仅失败 key，不重连），全部落地才清恢复任务、重置退避。同步只恢复投影，绝不授权——每个新操作仍逐次 admission。
4. **scope 真值签名。** 发布去重签名必须代表 scope 实际持有内容，而非 `publish()` 上次算出的值。`published` 语义收拢为"写入 scope 的投影签名"，由 `publish`、两处 withheld republish、`withdrawPublished` 经同一 helper 统一维护（withheld 签名永不等于 `publish()` 签名）；`metadataPublished` 表示"最近一次已通告的 Registry 视图"，只由 `publish` 与 `withdrawPublished` 维护。空快照因此能真正清掉旧 withheld 边界。
5. **整轮失败零通知与提交顺序。** shared `openDomain()` 的 migrate+classify 结果写入本轮私有暂存，不动 `cache`/`published`/scope；listen/open 失败 → `domain.close()` + 降级 + 丢弃暂存，上一轮投影原样保留。listen 成功后提交是一段同步代码：先保存旧键集并算并集，再以暂存结果整体替换 `cache`，随后对并集逐 key 写 scope（磁盘已删 key 显式 `publish([])`）——**期间不触发任何通知**：`multiRootScope` 增加通知批处理机制，`setAdditionalRoots()` 保持根表唯一写口但批处理期订阅者调用入队，`subscribe()` 订阅者（Skills/Files）与 Registry 侧 `notifyShared` 广播、监听器调用、revision 通知一起延后；全部根发布完才 `setRegistryAuthority(true)`，最后统一冲刷。任一同步回调观察到的 `cache`、scope 投影与 authority 均属于本轮提交。
6. **降级路径去重。** `enterStorageFailed` 的 withheld republish 加与 `remoteProjectionReady` 同等效力的门控（实现为第 4 条真值签名的按 key 同值跳过）；`openDomain` 失败日志按 reason 去重。同一降级状态下重复降级调用至多一轮通知。
7. **在途握手本地取消与退出上限。** `AuthorityClient.connect` 增加本地取消能力（内部 API，协议帧不变）；registry 记录在途握手 cancel，`releaseAuthority`/换代即销毁候选 channel。client request 定时器**保持 ref**（实施期修正：原拟 `unref()` 兜底，但 Windows `Pipe` 以 unref 的轮询定时器收包、不持事件循环句柄，在途请求只能靠该定时器保活；Windows CI 上 unref 使子进程在 hello 期间事件循环清空、以退出码 13 结束）。取消与关闭都同步清除它，取消未命中时残余上限为 request 超时 5 秒——这即是本条要求写明的合同上限。
8. **介质绑定校验不得被重试绕过（2026-10-31 实施前审核修订）。** shared 模式的介质/锁绑定校验全部通过后才记录介质；校验失败属于 `config` 类，`ensureAuthority()` 在按需与后台两条路径上都早退。审核在当前源码复现：首次校验失败后第二次调用跳过校验、以错误锁名接管同一介质，得到两个 active owner——后台恢复会把它变成自动触发，因此作为 F4 的阻塞前置项先行修复。同次审核还确定：`openDomain()` 的 active 状态、table 与 epoch 只在提交段赋值（暂存期同步读不得惰性写 cache/scope）；scope 批处理按深度嵌套、仅最外层在 `finally` 中冲刷；follower 逐 key 同步也在同一批处理接缝内应用。细则见专项计划 rev.5。
9. **诊断面。** 只读 getter 暴露 `{ authorityState, epoch, connectionFailure, recoveryClass, recovery.phase, attempts, nextRetryAt }`；phase 必须区分 waiting / attempting / disabled / requires-restart——quarantine 不得显示为"自动重试中"。状态转换记一条去重日志。

## Alternatives Considered

- **心跳期主动故障检测（owner SIGSTOP 而空闲）**：本期排除。无心跳时空闲健康连接不会因对端暂停而关闭，`ensureAuthority` 见健康 client 直接返回；主动检测要新增心跳面，列 F4b 另行决定，不得混入本批验收。
- **unknown-state 重开对账**：本期保持隔离至重启。single 布局下几乎不可达；重开机制可行但扩合同，列 F4b 另立 ADR。
- **抢占/TTL/PID 判定 lease**：违反 ADR-0007/0025 的内核锁合同；暂停 owner 不许被夺锁。
- **自动重放结果不明的 mutation**：违反 ADR-0024；unknown result 语义原样保留。
- **独立 daemon（F1）或 daemon 级恢复**：架构分离收益不抵部署复杂度，维持本进程恢复；评审已确认可复用既有入口。
- **只缓冲 Registry/IPC 通知**：不足以满足提交一致性——scope `subscribe()` 订阅者同样被 `setAdditionalRoots` 同步通知，必须纳入批处理。

## Consequences

降级中的 Host 在可重试故障下自动恢复，不再依赖用户操作；恢复是 best-effort——任何授权仍以当次 admission 为准，文档与诊断面不得写成保证。`multiRootScope` 增加通知批处理接缝，`setAdditionalRoots()` 仍是唯一根写口；`AuthorityClient.connect` 增加内部取消参数；`ensureAuthority` 接受调用来源参数以分流后台 tick 的单次连接尝试（on-demand 保留三次有界循环）。Windows 下 owner 死亡后的残留 semaphore 语义由周期 acquire 天然覆盖（waiter 无需第二次用户操作）。

owner 挂起时单次 tick 仍占 `authorityChain` 约 5 秒（单次连接超时），用户操作可能短暂排队；这是接受的上限。心跳与 unknown-state 重开留作 F4b 候选。Phase 1 前置修复（真值签名、暂存与提交、去重、握手取消、资格分类）独立可合入且各带"先红后绿"回归；调度器、投影同步、诊断面与多进程/平台验收随后。未通过验收前不得宣称能力已实现。

## Related Documents

- [F4 专项计划](../plans/active/2026-10-31-f4-background-recovery.md)：评审记录、设计与验证表
- [共享服务架构与协议](../architecture/registry-authority-service.md)
- [ADR-0025](./ADR-0025-shared-registry-authority.md)：共享权威服务合同
- [ADR-0024](./ADR-0024-registry-operation-admission.md)：撤权与在飞操作语义
- [ADR-0007](./ADR-0007-registry-authority-lease.md)：内核 lease 合同
