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
