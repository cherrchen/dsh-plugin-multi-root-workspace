# 根目录登记被另一个 DSH 进程占用

## 症状

- 第二个 DSH 进程（例如 Desktop 已开着，又启动了 `dsh --profile web` / headless，且共用同一个 `$DSH_HOME`）里，Folders 面板或 `/workspace-folders list` 显示根目录登记不可用，文案类似「owned by another DSH process」/「正由另一个 DSH 进程占用」。
- 该进程的附加根**全部不授予**（沙箱退化为仅主根）；添加/删除会失败，错误码 `registry-contended`。
- 第一个 DSH 进程里登记与授予仍正常。

## 根本原因

JSON storage 的 `multi_root_workspace` domain 是整文件 rewrite、打开后内存 authoritative，没有跨进程 CAS。插件因此为整个 store 持有一把内核 lease（POSIX `flock` / Windows named semaphore）：同一时刻只有一个 Registry Authority Process 可以打开 domain 并 grant。这是 fail-closed，见 [ADR-0007](../decisions/ADR-0007-registry-authority-lease.md)。

## 诊断方法

1. 确认是否有第二个 DSH 进程共用 `$DSH_HOME`（桌面端 + CLI、两个 profile 指向同一 home）。
2. 看 `$DSH_HOME/storages/multi_root_workspace.lock` 是否存在（POSIX 锁文件；Windows 上真正的锁是 named semaphore，文件可能不在）。
3. 在等待方点面板「重试」或跑 `/workspace-folders list`：这会调用 `refresh()` → `ensureAuthority()`。

## 已验证的解决方案

1. 关掉占用登记表的那个 DSH 进程（正常退出即可；崩溃也行，kernel 会释放锁）。
2. 不必重启等待方：再 list / 点重试，它会重新拿 lease、从磁盘读回最后一次 durable 状态并恢复授予。
3. 若自定义了 `storage-json.root`，把插件行的 `leasePath` 改到**同一个目录**下的 `multi_root_workspace.lock`，否则两把锁可能对不齐。

## Skills 查询导致持续刷新（Issue #24）

[Issue #24](https://github.com/cherrchen/dsh-plugin-multi-root-workspace/issues/24) 报告第二个 `dsh-tui` Host 在空闲时持续占用约一个 CPU 核心、内存增长并最终 V8 OOM。报告环境为 Ubuntu、`dsh-tui 0.17.0`、DSH `0.2.1-rc.2`、Node `24.22.1`，插件版本未明确。正常的锁竞争只应使等待方收缩权限，不应持续产生 Skills 变化事件。

根因是附加根 Skills 查询调用 `registry.refresh()` 重试 lease；失败后 `setRegistryAuthority(false)` 即使仍为 `unavailable` 也通知监听者，使 Skills 缓存失效并发出 `skills/change`；客户端收到事件立即重查，形成反馈循环。零附加根也能触发。相同问题还存在于重复进入 `storage-failed` 的路径。authority 重复通知早于 Skills 功能存在，Skills 查询与失效链随 `v0.1.10` 接入后才构成此回归。

修复点是 `setRegistryAuthority()`：仅在 `available` / `unavailable` **真正改变**时通知监听者。`refresh()` 继续重试 lease，持锁方释放后仍能接管；存储故障仍保留已持有的 lease，修复后可重试打开。持续持锁、拆除时「排空 mutation → close domain → release lease」以及不可用期间仅主根可写的规则不变。不能通过跳过后续竞争重试、无锁授权或延时掩盖此循环。

回归入口为 `tests/skills-authority.spec.ts`：真实内核锁、生产 Registry 与原生 Skills 服务，模拟收到 `skills/change` 后自动重查的客户端，并用 20 次查询硬上限防止旧代码失控；scope 通知语义由 `tests/scope.spec.ts` 覆盖。执行证据与未覆盖范围见[路线账本](../plans/active/2026-09-12-multi-root-workspace.md#issue-24registryskills-刷新循环-hot-fix2026-10-29)。
