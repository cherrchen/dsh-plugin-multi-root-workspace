# ADR-0007: 跨进程 Registry Authority Lease

## Status

Accepted

## Date

2026-09-15

## Context

M3 把附加根登记进 `dsh-storage-domain` 的 `multi_root_workspace` domain（`single` layout，介质是 `$DSH_HOME/storages/multi_root_workspace.json`）。注册表用每主根一条 Promise 队列串行化「读快照 → 校验 → 落盘」，这足以覆盖**同一 DSH 进程内**的读—改—写竞争（ADR-0004 第 14 条）。

它覆盖不了两个 DSH 进程共享同一个 storage root 的情况。上游 JSON backend 的契约是：

- `open` 时把文档读入内存，之后**内存 state 是权威**；
- 每次写入都是整份 atomic rewrite；
- `JsonStorageBackend` 的 `open` / `opening` 排他只是**当前进程里的 Map**。

因此 Desktop 与 Web/headless 同时跑、或任何两个 DSH 进程共用 `$DSH_HOME` 时：A、B 各自读入旧版本，A 加 `root1`、B 加 `root2`，后一次整文件写覆盖前一次。更严重的是权限方向：B 删除一个 root 后，A 的内存 Registry/Scope 仍可能继续 grant；A 的 `refresh()` 重新分类的是自己 storage handle 里的内存状态，不会重新读磁盘。这已经不是「配置不同步」，而是一个进程认为权限已撤销、另一个进程仍在授予。

上游 Session JSONL persistence 已经用同一原则解决「同时只有一个写者」：POSIX 非阻塞 `flock(2)`（公开入口 `@deepseek-ai/node-addon-system/flock`），Windows named kernel semaphore；锁由 kernel 在进程死亡时释放，没有 TTL / stale-PID 算法。发布包不含 `src/`，不能深导入 `session-persistence-jsonl/src/win32.ts`（ADR-0002）。

## Decision

1. **同一时刻只允许一个 Registry Authority Process。** 锁是 **store-wide**，不是 per-primary-root：介质是整份 `multi_root_workspace.json`，两个进程分别操作不同主根最终仍会重写同一文件。
2. **生命周期固定为**：acquire lease → open domain → load records → publish scope →（运行）→ close domain → release lease。没有 lease 就绝不开 domain，因此不可能带着 stale snapshot grant。
3. **内核锁，沿用 session lease 的原则。** POSIX：`@deepseek-ai/node-addon-system/flock` 的 `tryLockExclusive(fd)`（`LOCK_EX | LOCK_NB`），并对 flock 的 inode 做「仍是路径上那个文件」的校验后重试。Windows：薄 named semaphore adapter（`Local\dsh-multi-root-registry-<sha256(canonicalPath)>`），逻辑与 `SessionWriteLease` 一致，本地实现、不深导入。无 TTL。
4. **Fail closed。** Authority 状态是：

   ```ts
   type RegistryAuthorityState =
     | { kind: 'active' }
     | { kind: 'contended' }
     | { kind: 'storage-failed'; reason: string }
   ```

   争用时：`multiRootScope` 为空、mutation 抛 `registry-contended`、面板/命令通过 `unavailable` 说明「另一个 DSH 进程占用登记表」。绝不读取已有 domain snapshot 继续 grant。
5. **不必强迫第二个 DSH 重启。** `refresh()`（命令 `list`、面板 Retry）先走 `ensureAuthority()`：前一个进程退出或崩溃后，等待方重新拿 lease、从磁盘重新 open、读回最后一次 durable mutation、再 publish。
6. **锁路径显式配置**，默认与 JSON backend 相邻：

   ```yaml
   config:
     leasePath: !!js dshHomePath('storages/multi_root_workspace.lock')
   ```

   用户自定义 `storage-json.root` 时必须同步覆盖 `leasePath`。长期等上游 storage 暴露 medium identity 后再去掉这层配置耦合。
7. **`@deepseek-ai/node-addon-system` 与 `koffi` 是依赖，不是 peer。** 它们是 native primitive，不是 cordis 服务身份；Windows 的 koffi 只在 win32 动态加载。

## Alternatives Considered

| 方案 | 否决理由 |
| --- | --- |
| 只给 mutation 套短期 file lock | 读路径仍走内存 snapshot；另一个进程的删除不会出现在本进程的 `refresh()` 里 |
| PID 文件 / TTL stale-owner | 活着但卡住的 holder 会被错误抢占，继任者按过期快照 grant；kernel 锁没有这个问题 |
| 每主根一把锁 | 两个主根仍重写同一份 `multi_root_workspace.json`，锁粒度小于介质 |
| 事务 / CAS + reload/watch | 正确但超出 0.1.1 范围；单写者 lease 已经关掉 stale-grant 窗口 |
| 深导入 `session-persistence-jsonl/src/win32.ts` | 发布包不含 `src/`（ADR-0002） |
| 争用时仍只读打开 domain | 「只读」仍会把过期 snapshot 播种进 scope，正是要禁止的 |

## Consequences

- 两个 DSH 进程共用 `$DSH_HOME` 时，只有 authority 授予附加根；另一个进程的沙箱退化为「仅主根」，直到它 refresh 成功。这是安全方向。
- `chains` 仍然只覆盖进程内、同一主根的 mutation；跨进程由 lease 负责。二者缺一不可。
- 新增运行时依赖：`@deepseek-ai/node-addon-system`（POSIX flock）、`koffi`（Windows semaphore）。
- 测试：`tests/registry-lease.spec.ts`（同进程双 stack 争用 / 接管）与 `tests/registry-multiprocess.e2e.ts`（两 OS 进程、干净退出、SIGKILL、durable 读回）。

## Related Documents

- [ADR-0002 上游耦合策略](./ADR-0002-upstream-coupling-policy.md)
- [ADR-0004 Root 注册表的持久化形态与校验语义](./ADR-0004-root-registry-persistence-and-validation.md)
- [架构文档 §7](../architecture/multi-root-workspace.md)
- [M4 开发计划](../plans/completed/2026-09-15-m4-registry-authority-lease.md)
