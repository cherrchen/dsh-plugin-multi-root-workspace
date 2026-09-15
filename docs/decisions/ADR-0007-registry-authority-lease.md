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
2. **生命周期固定为**：acquire lease → open domain → load records → publish scope →（运行）→ **排空在飞 mutation → close domain → release lease**。没有 lease 就绝不开 domain，因此不可能带着 stale snapshot grant。拆除顺序的上半截（排空）与下半截（close 先于 release）同样是不变量：lease 是本进程「这份介质归我」的唯一依据，因此它必须比本进程**最后一次写**活得更久——若在 `release` 之后、某个在飞 `table.put()` 落盘之前继任者就拿到 lease 并 open 了介质，它读到的快照会缺掉那次 mutation。
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

## 返工补充（2026-09-15，PR #1 评审）

PR #1（head `507c954`）的 P1-1 指出：`releaseAuthority()` 先释放 lease、后 close domain，且既没走 authority 转场队列，也没与每主根 mutation 队列同步，于是有两个真实窗口——继任者在在飞 `table.put()` 落盘前拿到 lease 并 open 介质；以及一次与 disposal 重叠的在飞 acquisition（`refresh()` 已拿到 lease、正卡在 `openDomain()` 里）在拆除之后才完成，泄漏一个没人会关闭的 domain + lease。修复后，第 2 条的生命周期由以下三条不变量守住：

1. **拆除整体走 authority 转场队列。** `MultiRootRegistry.releaseAuthority()` 的全部动作都在 `serializeAuthority` 里执行，与 acquisition（`ensureAuthority()`）共享同一条队列，因此拆除与竞选/接管**不交错**；与 disposal 重叠的那次在飞 acquisition 由**同一次**拆除收尾，不会留下没人关的 domain + lease。
2. **顺序必须是「排空在飞 mutation → close domain → release lease」。** 先 fail closed（`table = undefined`、`authorityState = { kind: 'contended' }`）以拒绝新 mutation，再 `await this.drainMutations()`（`await Promise.allSettled([...this.chains.values()])`，等待每一条已入队/正在跑的每主根 mutation）→ `withdrawPublished()` → `domain.close()` → `lease.release()`。lease 必须比本进程最后一次写活得更久：继任者绝不会打开一份缺了最后一次写的快照。
3. **disposer 一开始就置 `disposed`，之后不再 acquisition。** `releaseAuthority()` 第一件事是把新的 `private disposed` 字段设为 `true`；`ensureAuthority()` 的串行 job 首行是 `if (this.disposed) return`，因此已拆除的 fiber 不可能再打开一份新介质。

两条新回归用例在 `tests/registry-lease.spec.ts` 的 `describe('authority teardown')`：一条用记录下的事件顺序断言 `put:end` 早于 `close`（且在拆除期间不发生 `close`），并确认拆除之后继任者能 acquire 到 lease；另一条让一次 acquisition 与 disposal 重叠，确认注册表停在 `contended`、store 可被继任者接管。

## 第二轮返工补充（2026-09-16）

Windows semaphore 名称必须先用 `realpathSync.native` 解析已创建的父目录，再拼接锁文件名、大小写归一化并散列。锁文件本身不必存在；只用 `resolve()` 的词法归一化无法合并 junction、符号链接和短路径别名，会让同一介质产生两把锁。纯命名测试与实际 acquire 争用测试均覆盖目录别名；本次 macOS 验证不替代 Windows 原生内核验证，详见[第二轮审查报告](../plans/completed/2026-09-15-v0.1.1-review-rework.md#第二轮审查与修复2026-09-16)。

## Related Documents

- [ADR-0002 上游耦合策略](./ADR-0002-upstream-coupling-policy.md)
- [ADR-0004 Root 注册表的持久化形态与校验语义](./ADR-0004-root-registry-persistence-and-validation.md)
- [架构文档 §7](../architecture/multi-root-workspace.md)
- [M4 开发计划](../plans/completed/2026-09-15-m4-registry-authority-lease.md)
