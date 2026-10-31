# F4 — Registry 权威后台恢复与故障诊断（实施稿 rev.5）

> **状态：Accepted / Phase 1–3 已在 `feat/host-f4` 实施，macOS 本机与三平台 CI 验证通过；真实 dsh-tui soak 暂缓（[ADR-0026](../../decisions/ADR-0026-registry-background-recovery.md)）。**本文是[共享 Registry 计划](./2026-10-30-shared-registry-authority.md) F 表 **F4** 项的专项计划；rev.4 经三轮技术评审通过，rev.5 吸收实施前源码审核门（Phase 0）的发现，合同由 ADR-0026 定案，批次已登记入[进度总账](./2026-09-12-multi-root-workspace.md)。文中"Current State"逐条对应当前源码，"Design"为已采纳合同，实施完成前不得宣称能力已实现。

## 评审修订记录

- **rev.1 → rev.2（2026-10-31 首轮评审）**：判定"方向可行，须修改后再通过"。吸收五项发现（2×P1、3×P2）：新增恢复完成条件与投影同步（R2）、整轮失败通知原子性（R3）、结构化重试资格（R1）、排队/取消/退出合同（R1/R4）、SIGSTOP 验收拆分；六个 Open Questions 按建议转为决定。
- **rev.2 → rev.3（2026-10-31 二轮评审）**：吸收三项修正与两处文字对齐，均为评审定向复现/验证支撑：
  - R2：空快照经现有 `publish([])` **不能**清掉旧 withheld——`remoteUnavailable` 清 `published` 后，空签名 `''` 与缺省值相等，发布被跳过而 scope 残留旧边界（复现：空列表返回、根发布 0 次、scope 仍持原 read-only 拒绝边界）。R2 增加"scope 实际发布状态"签名合同。
  - R3：暂存不得直接覆盖 `cache`（`list()`/Files 边界/`withPrimaryOperation`/`enterStorageFailed` 均读它），改为**本轮私有暂存**；提交按旧、新 key 并集处理，磁盘已删 key 显式清理。
  - R4：`unref()` + 晚到丢弃不构成握手取消——POSIX channel 是持事件循环引用的 `Socket`（子进程验证：hello 定时器 unref 后进程仍等 socket 超时），且 `releaseAuthority` 排在 `authorityChain` 后在途连接之后。改为给连接尝试本地取消能力。
  - 文字对齐：部分同步只要失败集合非空就继续有界重同步；SIGSTOP 重连通常保持原 epoch，只有 SIGKILL 接管产生新 epoch。
  - 六项决定不变。
- **rev.3 → rev.4（2026-10-31 三轮评审）**：吸收一项 P2 修正（评审在真实 Registry 栈定向验证支撑）：
  - R3 提交顺序反转："先 publish 后换 cache" 会让 `publish()` 内的 `notifyShared()`（`snapshotOf` 读 `cache`）与同步监听器（`list()` 读 `cache`）观察到"新 scope、旧 cache"（复现：scope 已拒写时监听器读到 `access = inherit`，提交后才变 `read-only`）。改为 listen 成功后**先整体提交 staged 到 `cache`**，再按并集逐 key 发布投影（已删 key 发布空），全部根发布完才 `setRegistryAuthority(true)`；**Registry/IPC 通知延后到全部投影更新完成**，保证任何同步回调看到的 Registry 状态与广播 snapshot 都属于本轮提交。
- **rev.4 评审结论（2026-10-31）**：**计划层面技术评审通过，无新增阻塞项**，合同由 [ADR-0026](../../decisions/ADR-0026-registry-background-recovery.md) 定案并立项。随附一条实施期强合同与一条验收要求：
  - R3 的"只写 scope、不触发通知"必须覆盖 `multiRootScope.subscribe()`——`setAdditionalRoots()` 同步通知订阅者（Skills/Files 均订阅），仅缓冲 Registry/IPC 通知不够；在 scope 层增加通知批处理机制，`setAdditionalRoots()` 保持根表唯一写口。
  - 提交一致性回归至少使用两个主根，同时检查 scope 订阅者、Registry 监听器和广播 snapshot，确保回调观察到完整提交后的状态。
- **rev.4 → rev.5（2026-10-31 实施前源码审核门）**：逐条对照源码核实 Current State 八项事实全部成立，另发现一项阻塞缺陷与五项须写入合同的细节（N1–N6），本稿据此修订 R0/R1/R2/R3/R4/R5 与 Validation：
  - **N1 [P1，阻塞，已先行修复]**：shared 模式在介质/锁一致性校验**之前**就赋值 `this.medium`；首次进入 `storage-failed` 后，下一次 `ensureAuthority()` 跳过整段校验去 acquire 错误锁名并以同一介质打开 domain——本机复现得到两个不同 epoch 的 active owner（违反不变量 6），且 `listenNative` 会 unlink 并重新 bind 同一 endpoint。后台恢复会把这个按需缺陷变成约 1 秒内自动触发。新增 R0：校验全部通过才赋值 `medium`；R1 的 `config` 类在按需与后台两条路径上都使 `ensureAuthority()` 早退。
  - **N2 [P2]**：`openDomain()` 在 listen 之前就把 `authorityState`/`table`/`operationEpoch` 置为 active；暂存期间任何同步 `list()` 未命中 cache 都会经 `statusesOf → lookupRecords → accept` 写 cache、写 scope、发通知，击穿 R3 的"失败零通知"。R3 改为这些状态全部推迟到提交段赋值，并把 `accept()` 拆出纯分类函数。
  - **N3 [P2]**：通知批处理的嵌套、冲刷期重入与异常安全未定义。R3 补充批处理规则。
  - **N4 [P3]**：R2 逐 key `applySnapshot` 时 publish 先于 `setRegistryAuthority`，订阅者看到旧 authority；改为每个 key 的应用也走同一批处理接缝，N 轮通知有界、接受。
  - **N5 [P3]**：owner 进入 quarantine 后仍持锁但关闭 server，follower 会以 `retryable` 低频重试至 owner 重启；接受，诊断文档注明。
  - **N6 [文档]**：架构文档 §3"无后台高频抢锁"、§6"按需重连"须随实现修订（已在 Documentation Impact）。
  - **Windows CI 修正（2026-10-31，实施后）**：R4 原拟给 client request 定时器补 `unref()`，首轮 PR CI 的 Windows 全部 20 个版本因此失败——Windows `Pipe` 以 unref 的 20ms 轮询定时器收包、本身不持事件循环句柄（POSIX 的 `Socket` 持有），在途请求唯一的事件循环引用就是这个 5s 定时器；unref 后只剩待决 hello 的子进程事件循环清空，Node 以 13（unsettled top-level await）退出，波及 `authority-native`（ambient-deny 子进程）、`registry-semaphore-win32` 与 `shared-registry-multiprocess`。修正为定时器保持 ref：取消与关闭（两平台 `close` 均同步触发）同步清除它，取消未命中的残余上限即 request 超时 5s；回归改为断言取消路径清除该定时器。
  - 另澄清：空快照场景下 `publish()` 在比较签名**之前**写 `metadataPublished`，因此 scope 未被写但监听器/`notifyShared` 仍触发——回归须同时断言 scope 层真值，不能只数通知。

## Goal

让降级中的 Registry 权威无需用户操作即可自动恢复：可重试的 `contended`、follower 断线、可重试的 `storage-failed` 以有界退避自动重试既有的 `ensureAuthority()`，并把 follower 重连推进到"投影已同步"才算完成；恢复路径复用既有准入与接管合同，不新增授权面；并向 operator 提供可读的故障诊断状态。

## Background

[共享 Registry 计划](./2026-10-30-shared-registry-authority.md) F 表对 F4 的原始定义：相对初版"按需重连、unknown-state 隔离至重启"，演进为**有界退避/jitter、取消/退出、诊断状态、存储核对及重开条件；心跳不得夺锁**；最小验收目标为"空闲故障不会形成忙循环；恢复不复用旧 grant；修复前始终保守拒绝"。

2026-10-31 对当前实现完成可行性核对：恢复引擎（`ensureAuthority` 全部分支）已存在且对重复调用安静；两轮评审又确认了四处必须先修的实机缺口（见 Current State「现状缺口」）。本文件把核对证据、评审发现与设计候选写成可评审的条目。

## Current State

以下全部可在当前源码核实（`main` @ `9053cf2` 之后，含 `fix/file-reader` 分支无关改动）：

### 已具备的恢复机制

- **`ensureAuthority()` 是唯一的恢复入口**（`src/registry.ts`），经 `authorityChain` 串行、幂等、检查 `disposed`：
  - `contended` → 重试 `RegistryAuthorityLease.acquire` → owner 已退则 `openDomain()`（磁盘重开 + 新 `operationEpoch` + 全量 `accept` 重发布）；owner 活着则进入 follower 连接循环（`[0, 50, 150]`ms，三次有界尝试）。
  - follower 断线 → `remoteUnavailable()`（保留拒绝边界）→ `contended` → 同一路径；断线本身是 `client` close 事件驱动的，立即发生。
  - `storage-failed` 且 `domain === undefined`（open 失败 / server listen 失败）→ lease 在手时重试 `openDomain()`。
  - `active` / follower 健康 → 立即返回，零成本。
- **对重复调用的安静性部分成立**（Issue #24 hot-fix 之后逐条核实）：
  - `setRegistryAuthority(false)` 同值静默（`src/scope.ts`）。
  - `remoteUnavailable()` 由 `remoteProjectionReady` 门控，第二次起提前 return。
  - `withdrawPublished()` 遍历的是已空的 `published`，重复调用无输出。
  - `loggedContended` 只警告一次。
  - 但下面「现状缺口」列出的通知路径**不受这些门控保护**。
- **内核重试成本有界且干净**：
  - POSIX：失败 acquire = open + flock + close，微秒级，无积累。
  - Win32：失败 acquire = `CreateSemaphoreW` + 0 超时 wait + `CloseHandle`，无句柄泄漏。并且 owner 死亡后**第一次 acquire 可能仍报 contended**——残留 semaphore 对象随最后一个 waiter handle 关闭才析构，第二次 acquire 才赢；周期重试对 Windows 接管是净收益而非成本。
  - follower connect：endpoint 已死立即拒绝（`native.ts` "not ready"）；owner 挂起时 socket 连得上但 hello 5s 超时（`protocol.ts` request 定时器，未 `unref`）。
- `timer.unref()` 是既有惯例（`skills/pool.ts`、`authority/native.ts`、`authority/protocol.ts` 的 server 端）。
- **`unknown-state` 对本 domain 实际几乎不可达**：本 domain 是 `single` 布局；`unknown-state` 只由 per-record 布局的批量删除恢复失败产生（上游 `dsh-storage-json`）。隔离至重启的真实代价场景因此极小。
- 断线晚到连接的防接纳机制已存在：`connectionGeneration` + `adopted` 双重检查，dispose 或换代的 client 一律 `close()` 丢弃（`ensureAuthority` follower 循环内）。

### 现状缺口（F4 要解决的）

- 恢复只由用户操作或 `refresh()` 触发：owner 退出后 follower 在下一个操作之前保持不可用显示。
- **[P1] follower 握手成功不等于恢复完成**（评审实机确认）：`AuthorityClient.connect` 的 `hello` 只交换 `{store, epoch, limit}`，不回放任何主根快照；`applySnapshot` 只在 owner 新广播 `change` 或本 Host 发起请求时发生。断线时 scope 已置 unavailable、已跟踪主根被 withheld；**重连后若 owner 无新变更，这些主根可以无限期保持降级**，直到用户操作——不满足"无需用户操作即可恢复"。`remoteUnavailable` 不清 `this.cache`，被 withheld 的主根集合本身就是待同步集合。
- **[P2] 空快照不能清掉旧 withheld 边界**（评审定向复现确认）：`remoteUnavailable` 执行 `published.clear()`（但**不清** `metadataPublished`），并把 withheld 行写入 scope；空快照（该 primary 在 owner 侧已无记录）的发布签名为 `''`，与 `published.get(key) ?? ''` 相等，`publish()` 判为无变化走早退——`setAdditionalRoots(key, [])` 被跳过，**scope 永远残留旧拒绝边界**（复现：Registry 返回空列表、根发布 0 次、scope 仍持原 read-only 边界）。`metadataPublished` 未同步清除还会让该 key 后续任何相同 statuses 的发布被误判为"无变化"。`enterStorageFailed` 的 withheld republish 存在同形缺口。
- **[P1] 整轮失败恢复仍有通知振荡**（评审实机复现确认）：shared 模式 `openDomain()` 先 `published.clear()` + `cache.clear()`，逐 key `accept()` 发布有效根，**然后**才 `AuthorityServer.listen`；listen 失败 → `enterStorageFailed` 再 republish withheld。真实 Registry + JSON 介质 + lease 注入持续 listen 失败、两轮恢复观察到 `available → withheld → available → withheld` 共 4 次根发布。权威全程 unavailable（`project()` 在 unavailable 下不产 grant，无真实授权振荡），风险是 Skills 失效反馈链与资源消耗。
- **[P2] 暂存不能写在 `cache` 上**（评审指出，已核实读点）：`cache` 是可见状态——`list()`/`statusesOf`、Files 的登记边界判断、`withPrimaryOperation()`、`enterStorageFailed` 的 withheld 生成都读它。openDomain 中途覆盖 cache，即使不 publish，也无法保证"失败期间保留上一轮投影"。
- **[P2] 提交顺序还会被同步回调反向观察**（评审实机验证）：`publish()` 内部的 `notifyShared()` 用 `snapshotOf()` 从 `cache` 取根记录，同步监听器也可立即 `list()` 读 `cache`——若先逐 key publish、最后才换 `cache`，同一段同步代码仍暴露"新 scope、旧 cache"（复现：scope 已拒写时监听器读到 `access = inherit`，提交后才变 `read-only`），并可能把旧记录带新 revision 广播出去。"提交是同步段"防不住同步回调，必须**先换 `cache` 再发布**，且把 Registry/IPC 通知延后到全部投影更新完成。
- **同类未门控路径**：`enterStorageFailed` shared 模式对每个缓存 key republish withheld，无 `remoteProjectionReady` 同型门控；`openDomain` 失败每次 `logger.error`，持久损坏 × 周期重试 = 日志洪泛。
- **`storage-failed` 把三类原因压成一个 kind**：缺少/相对 `leasePath` 与锁/介质配置错配（须改配置）、`unknown-state` quarantine（须重启核对，domain 仍持有、`ensureAuthority` 直接返回）、open/listen/acquire 瞬时失败（可重试）。调度资格与诊断显示都需要结构化区分，不能解析错误文本。
- **[P2] `unref` + 晚到丢弃不构成握手取消、退出上限未证**（评审子进程验证）：未 adopted 的 client 藏在 `AuthorityClient.connect()` 内部，dispose 无法立即关闭；generation 检查要等握手结束才执行；POSIX channel 是持有事件循环引用的 `Socket`，只 unref 超时定时器不解除 socket 引用——hello 定时器 unref 后进程仍被 socket 拖住。`releaseAuthority()` 排在 `authorityChain` 之后，也要等在途连接尝试。
- 无诊断面：`authorityState`、`connectionFailure`、重试进度对 operator 不可见，`unavailable` 只有静态文本。

## Scope

- 有界恢复调度器：资格分类、退避 + jitter、合并/取消合同、`unref` 定时器。
- 恢复完成条件：follower 连接建立 + 本 Host 已跟踪主根的快照同步（含空快照正确清理旧投影、部分失败处置、scope 真值签名）。
- 前置修复：整轮失败恢复的通知原子性（本轮私有暂存 + 并集提交）+ `enterStorageFailed` withheld republish 同值去重 + `openDomain` 失败日志去重。
- 挂起 owner 与退出成本：tick 单次连接尝试、**在途握手的本地取消**、退出上限合同。
- 诊断 getter 与 `unavailable` 文本的分相指示。
- 测试：fake timers + 真实 registry/介质/内核锁 + 多进程交错 + soak 复测。

## Non-goals

- 不改撤权完成语义（ADR-0024）、不改 lease / IPC / **协议帧**、不新增授权写口。
- 不抢占内核锁：永远只 `acquire`，无 steal / TTL / PID 判定。
- 不重放任何请求结果不明的 mutation（ADR-0024 语义原样保留）。
- **不引入心跳**：空闲健康连接的主动故障检测（如 owner SIGSTOP 时无在途请求）是否纳入另行决定；本期明确覆盖"请求超时进入降级后"的自动恢复。
- `unknown-state` 隔离至重启的合同本期不变；重开对账列为 F4b 候选、另立 ADR。
- 不引入 F1 / F2 / F3 / F5 / F6 的任何内容；不指定版本号，不授权发布。

## Design（已采纳合同；rev.5 实施细则随各节标注）

### R0 介质绑定校验不得被重试绕过（rev.5 新增，先行修复）

- shared 模式的全部绑定校验（`sharedStorageRoot` 为绝对路径、`storeIdentity(sharedStorageRoot)`、锁所在目录与介质同一 ID、锁名固定为 `multi_root_workspace.lock`）在局部变量上完成，**全部通过后才赋值 `this.medium`**；失败时 `medium` 保持未定义，任何后续调用都会重新校验并再次失败。
- 回归：错误锁名的实例在 `refresh()` 之后仍是 `storage-failed`、错误锁文件不存在、真 owner 的 epoch 不变，新 follower 仍能连上真 owner。
- R1 落地后，`config` 类失败直接使 `ensureAuthority()` 早退（与 `config-invalid` 同），成为终态。

### R1 恢复调度器（资格分类 + 合并/取消合同）

- **可重试资格**：`enterStorageFailed` 改为携带结构化分类（建议扩 `RegistryAuthorityState` 或在失败入口传枚举，**不解析错误文本**）：
  - `retryable`：`acquire` 非争用失败、`openDomain` open 失败、server listen 失败、follower 连接失败。
  - `config`：`leasePath` 缺失/非绝对、介质/锁配置错配（须修改配置后行重载）。
  - `quarantine`：`unknown-state`（domain 仍持有；`ensureAuthority` 现有早退路径原样生效）。
  - `contended` 恒为 retryable；`config-invalid` 为终态，不调度。
- **调度规则（写成不变量）**：
  - 全实例最多一个待执行 timer、一个正在执行的恢复尝试。
  - 下一轮从本轮完成后计时（post-completion delay），重复降级通知不重置退避；退避在恢复完成（含 R2 投影同步）时才归零。
  - 同时到来的 `scheduleRecovery()` 请求合并等待，不重复排队；mutation 保持原有独立语义，不受 tick 影响。
  - 初始约 1s、×2、封顶约 30s、±20% jitter；timer `unref`。**对可恢复故障持续低频重试，不设次数上限**（评审决定；单 tick 成本微秒级且有通知门控）。
  - `disposed` 使恢复代次失效：清 timer、取消在途握手（R4）、拒绝晚到连接（沿用 `connectionGeneration`/`adopted` 检查）。
- **opt-out**：patch 行布尔开关，默认开启；暂不开放间隔配置（评审决定）。
- **rev.5 实施细则**：
  - 分类形状：`RegistryAuthorityState` 的 `storage-failed` 增加 `recovery: 'retryable' | 'config' | 'quarantine'`（加字段，不改已有字段）；`enterStorageFailed(reason, recovery)` 由每个调用点显式传入，不从 reason 文本推断。映射：leasePath 缺失/非绝对、`sharedStorageRoot` 非绝对、介质/锁名错配 → `config`；`storeIdentity()` 抛错（目录创建失败、IPC 目录不安全）、acquire 非争用失败、domain open 失败、server listen 失败 → `retryable`（R0 保证每次重新校验）；四处 unknown-state（读、写、Skills 迁移）→ `quarantine`。
  - `ensureAuthority()` 对 `storage-failed` 的 `config`/`quarantine` 早退（按需与后台相同）；`quarantine` 保留现有 `domain !== undefined` 早退作为第二道门。
  - 调度器抽成独立小类（`src/authority/recovery.ts`），只依赖注入的 `run()` 与定时器，便于 fake-timer 单测；registry 持有一个实例。资格判定：`contended`、`storage-failed/retryable`、或 follower 且待同步集合非空 ⇒ 可调度；`active`、已同步 follower、`config-invalid`、`config`、`quarantine`、已 dispose、开关关闭 ⇒ 不调度。
  - 触发点：每次 `ensureAuthority()` 结束（按需或后台）、`remoteUnavailable()`（断线事件）、`Service.init` 首次尝试之后，都调用同一 `arm()`；`arm()` 遇已有 timer 或在飞尝试直接返回（不重置退避）。唯一例外：follower 新连接被接纳时（进展事件）退避归零并以 0 延迟替换待执行 timer，用于立即启动投影同步——仍只有一个 timer。
  - 退避：第 n 次连续失败后延迟 `min(1000·2ⁿ, 30000)·(0.8 + 0.4·random)` 毫秒；恢复完成（active，或 follower 且待同步集合清零）才归零。
  - 配置键：registry 行 `backgroundRecovery?: boolean`，缺省 `true`；bundle patch 行显式写 `backgroundRecovery: true` 并注释可关。

### R2 恢复完成条件与投影同步（前置设计要求）

- **完成定义**：恢复完成 = 连接建立 **且** 本 Host 已跟踪主根（`this.cache` 键集合，断线后保留）的快照同步完成——**含失败集合清零**：只要存在同步失败的 key，就继续有界重同步（仅重试失败 key，不重连）；全部 key 落地才清空恢复任务、重置退避。仅 `hello` 成功不算恢复。
- **同步执行**：connect 成功后**离开 `authorityChain`** 再逐 key `remoteSnapshot('snapshot', [key])`（不占转场队列做 N 次 IPC），每 key 走既有 `applySnapshot` 路径；`connectionGeneration`/`adopted` 门控继续生效。
- **scope 真值签名（rev.3 修正，前置要求）**：发布去重的签名必须代表 **scope 实际持有的内容**，而不是 `publish()` 上次算出的值。当前 `remoteUnavailable`/`enterStorageFailed` 把 withheld 写入 scope 却只清 `published`，导致空快照 `''` 撞缺省值。拟议：把 `published`/`metadataPublished` 的语义收拢为"写入 scope 的投影签名"，三个写入点（`publish`、两处 withheld republish、`withdrawPublished`）统一维护；或为重同步提供受控强制替换路径（跳过签名比较、但仍按有效集变化决定是否通知）。回归必须断言 **scope 层真值**（如 `multiRootScope.snapshot(policy).deniedRoots` 失去旧边界），不能只断言 `registry.list()` 为空。
- **可用性推进**：
  - 已跟踪集合为空 → hello 成功即 `setRegistryAuthority(true)`（零投影不等于降级；后续操作仍逐次 admission）。
  - ≥1 个快照成功落地 → `applySnapshot` 内的 `setRegistryAuthority(true)` 自然生效。
  - 失败集合非空 → 保持该 key withheld，短周期重同步；全部失败时整体保持 unavailable。
  - 同步中途断线 → `remoteUnavailable` → `contended` → 下一恢复 tick 重走全流程。
- **合同边界**：同步只恢复投影与显示，**绝不授权新操作**——每个新操作仍经 `withOperation`/`admit` 当次准入；不凭缓存或通知恢复授权。
- **rev.5 实施细则**：
  - 真值签名的落法：`published` 定义为"scope 当前持有内容的签名"，所有写 scope 的点都经同一私有 helper 维护：`publish()` 写入它算出的签名；withheld 写入（`remoteUnavailable`、`enterStorageFailed`）写入一个永不与 `publish()` 签名相等的 withheld 签名（投影为空时等同删除，即 `''`）；`withdrawPublished()` 清空。`metadataPublished` 定义为"Registry 视图最近一次已通告的 metadata"，只由 `publish()` 与 `withdrawPublished()` 维护——withheld 写入不通告 Registry 视图，因此不动它。由此空快照能真正写 `setAdditionalRoots(key, [])`，同值 withheld 写入按 key 签名自然去重（即 R3 要求的门控）。
  - 同步触发：follower 连接在 `ensureAuthority()` 内被接纳时，把当时 `cache` 键集合记为待同步集合；集合为空则立即 `setRegistryAuthority(true)`。同步由调度器的 tick 在 `authorityChain` 之外执行（后台 tick 刚连上则同一 tick 内同步）；单 key 失败保留在集合中，按调度器退避重试；连接中断由 `remoteUnavailable()` 清空集合并回到 `contended`。
  - 每个 key 的 `applySnapshot` 在 Registry 提交批处理内执行（publish 与 authority 写入一起冲刷，N4）。

### R3 整轮失败恢复的通知原子性（前置设计要求）

- **本轮私有暂存**：shared 模式 `openDomain()` 的两阶段结果**不落在 `this.cache`**——migrate + classify 产出写入尝试局部结构（本轮私有 staged map），`cache`/`published`/`metadataPublished` 与 scope 一律不动；listen/open 失败 → `domain.close()` + `enterStorageFailed` + 丢弃暂存，**整轮零通知**，上一轮投影与 `cache` 原样保留（含 `list()`/Files/`withPrimaryOperation` 视图）。
- **并集提交（rev.4 顺序）**：`AuthorityServer.listen` 成功后，提交按以下顺序作为**一段同步代码**执行：
  1. 保存旧 `cache` 键集合，计算与 staged 键的并集；
  2. **先**以 staged 结果整体替换 `cache`（单次原子赋值）；
  3. 对并集逐 key 发布投影：staged 中存在的按其分类结果 `publish`；磁盘已删、旧投影仍在的 key 显式 `publish([])`（经 R2 真值签名确保真正调 `setAdditionalRoots(key, [])`）；期间**只写 scope、不触发通知**——`multiRootScope` 增加通知批处理机制（如 batch/transact 接缝），批处理内 `setAdditionalRoots()`/`setRegistryAuthority()` 照常应用状态但 `subscribe()` 订阅者调用入队；`setAdditionalRoots()` 保持根表唯一写口，不得为跳过通知另开写口。Registry 侧 per-key 的 `notifyShared` 广播、监听器调用与 revision 通知同样收集进本轮提交的通知缓冲；
  4. 全部根发布完成后 `setRegistryAuthority(true)`（同在批处理内）；
  5. **统一冲刷**：scope 批处理结束时订阅者按序收到通知（同批多次写合并后的最终状态），随后发出积压的 `notifyShared` 广播与 Registry 监听器调用——任何同步回调此时看到的 `cache`、scope 全部投影与 authority 都已属于本轮提交。
- **门控**：listener 接受请求到提交完成之间不需要额外锁——`captureSnapshot`/`dispatchShared` 每次都现取新鲜分类（不依赖已发布投影），而提交本身是同步段：其间到达的 IPC 请求拿不到执行时机；hello 的 follower 只会收到冲刷阶段广播的新鲜 snapshot（revision/authority 均已落定）。回归必须断言：**同步监听器读取的 Registry 状态、scope `subscribe()` 订阅者观察到的投影、以及 `notifyShared()` 生成的 snapshot 都属于本轮提交**——不得在任一通知时点观察到旧 `cache` 或滞后投影（评审复现的 `inherit` vs `read-only` 反例即断言形状），回归至少覆盖两个主根。
- **`enterStorageFailed` withheld republish 同值去重**：加与 `remoteProjectionReady` 同型的"降级投影已发布"门控（覆盖 owner/follower 两路；`unknown-state` 重复调用也走同一门）。回归：同一降级状态下连续两次 `enterStorageFailed` 至多一轮 scope 通知。
- **失败日志去重**：`openDomain` 失败按 reason 去重（同 reason 只记一次，reason 变化或恢复后再记）。
- 回归基线即评审复现：真实 Registry + JSON + lease、持续 listen 失败、两轮恢复 ⇒ 根发布次数 ≤ 1（仅有初次降级的一次 withheld），不出现 `available → withheld` 振荡，且失败期间 `cache` 与 scope 字节级不变。
- **rev.5 实施细则**：
  - **暂存期不暴露 active（N2）**：打开的 domain、table、新 epoch 全部保存在本轮局部变量；`domain`/`table`/`operationEpoch`/`operationRevision`/`authorityState = active`/`server` 只在提交段第一步赋值。暂存期间 `lookupRecords()` 因状态非 active 返回空，`statusesOf()` 不会惰性 `accept`。`accept()` 拆为纯分类函数（分类 + 超限告警）与"写 cache + publish"两步，暂存只调前者。Skills 迁移写在局部 table 上顺序执行，不经 `operationChain`（此时没有任何调用方能拿到 table：本地操作排在 `authorityChain` 之后，IPC 尚未 listen）。迁移遇 unknown-state：保留 `this.domain = domain`（维持"不重开另一内存快照"）并以 `quarantine` 进入 `storage-failed`。非 shared 模式走同一暂存与提交路径（只是没有 listen 步骤）。
  - **scope 批处理接缝（N3）**：`multiRootScope.batch(body)`。嵌套按深度计数，仅最外层结束时冲刷；批处理内 `setAdditionalRoots()`/`setRegistryAuthority()` 照常立即应用状态（后者同值仍静默），订阅者调用合并为"脏"标记；最外层在 `finally` 中冲刷（body 抛错也冲刷，因为状态已应用），订阅者每轮只被调用一次。冲刷期间订阅者再触发的写入不在批处理内，按现有同步语义通知（不排队、不递归冲刷）。
  - **Registry 提交批处理**：registry 私有 `commit(body)`，在 `scope.batch()` 之内运行 body；body 内 `publish()` 产生的 `notifyShared(key)` 与 Registry 监听器调用按 key 去重收集；顺序为 scope 冲刷 → 按 key 首次出现顺序发 `notifyShared`（`snapshotOf()` 在冲刷时取值，revision/authority 均已落定）→ 监听器。同样用 `try/finally` 冲刷。`commit` 也可嵌套，仅最外层冲刷。
  - **失败日志去重**：记住上一次 `openDomain` 失败 reason，同 reason 不再 `logger.error`；提交成功后清除。

### R4 tick 成本、在途握手取消与退出上限

- 后台 tick 的 follower 连接尝试为 **1 次**（on-demand 保持 3 次有界循环）：`ensureAuthority` 保留唯一入口，传入调用来源（如 `{ background: true }`）在内部分流，复用同一 connect 代码。
- **在途握手本地取消（rev.3 修正）**：`AuthorityClient.connect` 增加本地取消能力（如可选 `AbortSignal`/`cancel` 句柄——内部 API 调整，**协议帧不变**）；registry 记录本轮在途握手的 cancel，`releaseAuthority`/换代时调用 → 销毁候选 channel、立即使握手 reject。adopted 后的关闭沿用现有 `client?.close()`；取消落在握手完成之后则走 `connectionGeneration`/`adopted` 检查丢弃晚到 client。
- **退出上限合同**：dispose 后可被取消的握手立即结束，`releaseAuthority` 不再排在在途连接之后；`protocol.ts` client request 定时器**保持 ref**，取消/关闭同步清除，取消未命中时残余上限 ≤5s（request 超时）。（实施期修正：原拟补 `unref()` 兜底，Windows CI 证伪——见评审修订记录"Windows CI 修正"。）
- owner 挂起时单 tick 占 `authorityChain` ≤ ~5s（单次连接）+ 同步时间；用户操作仍可能短暂排队，属可接受上限，评审确认。
- **rev.5 实施细则**：`AuthorityClient.connect(..., signal?: AbortSignal)`。调用前已中止 ⇒ 立即 reject；`connectNative()` 返回时已中止 ⇒ 销毁 channel 后 reject；hello 期间中止 ⇒ `close()` 销毁 channel，握手以 `AuthorityRpcError('authority-cancelled', …)` reject；完成后移除 abort 监听。registry 为每次连接尝试新建 `AbortController` 并记录，`releaseAuthority()` 在排入 `authorityChain` **之前**中止它。POSIX 与 Windows 的 connect 都是同步建立通道、只在 hello 阶段等待，因此两平台取消形状一致；Windows 原生行为已经 CI 证实（见"Windows CI 修正"）。

### R5 诊断面

- 新增只读 getter（名待定，如 `diagnostics`）：`{ authorityState, epoch, connectionFailure, recoveryClass: 'retryable'|'config'|'quarantine'|none, recovery: { phase: 'idle'|'waiting'|'attempting'|'disabled'|'requires-restart', attempts, nextRetryAt } }`——**必须区分 等待 / 尝试中 / 禁用 / 须重启**（评审要求），quarantine 不得显示为"自动重试中"。
- 状态转换打一条日志（info、按转换去重）；`unavailable` 文本可附带重试指示。panel/命令展示另行决定，首期仅 getter + 日志（评审决定）。
- **rev.5 实施细则**：getter 名定为 `diagnostics`；`recovery` 另带 `pendingSync`（待同步 key 数）。`config`、`config-invalid` 与 `quarantine` 均显示 `requires-restart`（须改配置或重启后重载）。日志只在 `(authorityState.kind, recoveryClass)` 变化与"恢复完成"时打，**不**在 waiting ↔ attempting 之间打，避免每个 tick 一行。owner 处于 quarantine 时 follower 只能看到 `contended` + 连接失败并保持 `waiting`（N5，接受）。

### R6 unknown-state 处置（本期保持）

- 维持隔离至重启。理由：single 布局下几乎不可达；重开对账机制可行（`domain.close()` 幂等且排空 in-flight）但扩合同，列 F4b 候选另立 ADR。

## Implementation（评审通过后）

- **Phase 0.5（阻塞修复，已落地）**：R0 介质绑定校验通过才赋值 `medium`，带先红后绿回归（`shared-registry.spec.ts` 错误锁名用例追加 `refresh()` 后断言）。
- **Phase 1（前置修复，独立可合入）**：R0 的 `config` 终态早退随资格分类一起落地；其余为 R2 的 scope 真值签名（含空快照清边界回归）+ R3 全部（私有暂存、rev.4 顺序并集提交、scope 通知批处理覆盖 `subscribe()`、withheld 门控、日志去重）+ R4 的握手取消（request 定时器保持 ref、取消时同步清除）+ R1 的结构化资格分类。每项带"修复前红、修复后绿"回归。
- **Phase 2（调度器 + 完成条件）**：R1 调度与合并/取消规则 + R2 投影同步（含失败集合重同步）。
- **Phase 3（诊断与验收）**：R5 + 多进程 e2e + soak 复测。

## Validation

| 场景 | 应验证的结果 | 回归入口 |
| --- | --- | --- |
| contended 后自动恢复 | fake timers + 真实 registry/介质/内核锁：无用户操作即 acquire→接管或 follower 连接 | `shared-registry.spec.ts` 新增 |
| follower 重连投影同步 | 已跟踪主根重连后自动从 withheld 恢复为最新快照；owner 已删记录的 key 经空快照**在 scope 层真正清掉**（断言 `snapshot(policy)` 的 denied/additionalRoots，而非仅 `list()`） | `shared-registry.spec.ts` |
| 部分同步失败 | 失败 key 保持 withheld、其余恢复；只要失败集合非空就有界重同步，全部完成才清恢复任务/重置退避 | `shared-registry.spec.ts` |
| 持续 listen 失败 | N 轮恢复至多初次降级一次 withheld 通知；无 `available → withheld` 振荡；失败期间 `cache` 与 scope 字节级不变（私有暂存） | `shared-registry.spec.ts` |
| 磁盘已删主根 | 提交并集把旧投影中已消失 key 显式清空，无残留 | `shared-registry.spec.ts` |
| 提交一致性 | **至少两个主根**；scope `subscribe()` 订阅者、Registry 同步监听器（`list()`）、`notifyShared()` 广播的 snapshot 在任一通知时点都属本轮提交（无 `inherit` vs `read-only` 式错配）；通知在 authority 落定后统一冲刷 | `shared-registry.spec.ts` |
| 持续 storage-failed | N 个 tick 后日志与 scope 通知有界；修复文件后自动恢复 | `shared-registry.spec.ts` |
| owner SIGKILL 后接管 | follower 自动以**新 epoch** 接管并从磁盘恢复 | `shared-registry-multiprocess.e2e.ts` |
| owner SIGSTOP→SIGCONT | 在途请求超时进入降级后自动重连，**通常保持原 epoch**；不夺锁、旧应答不复活 | `shared-registry-multiprocess.e2e.ts` |
| 合并/取消规则 | tick 在飞时重复降级不叠加排队；dispose 中在途 connect 被本地取消、退出不被拖延（或书面声明残余上限） | `shared-registry.spec.ts` |
| 空闲降级长稳 | CPU/heap/查询数有界，沿用 `pnpm soak:tui-registry` 口径 | soak 夹具 |
| Issue #24 回归 | 降级与恢复期间 skills `invalidate()` 次数不随 tick 数增长 | `skills-authority.spec.ts` 及新增断言 |
| Windows 原生 | owner 死亡后 waiter 无需第二次用户操作即接管（残留 semaphore 语义由周期 tick 覆盖） | `registry-semaphore-win32.e2e.ts` 扩展 |
| 恢复安全性 | 恢复后授权与磁盘一致；不复活旧 epoch 应答、不复用旧 grant、不 replay mutation | `shared-registry*.ts` |
| 介质绑定不被重试绕过（R0） | 错误锁名实例 `refresh()` 后仍 `storage-failed`、不建错误锁、owner epoch 不变、新 follower 连真 owner；R1 后为 `config` 终态 | `shared-registry.spec.ts` |
| 暂存期不暴露 active（N2） | listen 被屏障挂起时，同步 `list()`（含 cache 未命中的新 key）不写 cache、不写 scope、不发通知；listen 失败后 cache/scope 字节级不变 | `shared-registry.spec.ts` |
| scope 批处理（N3） | 嵌套只在最外层冲刷一次；body 抛错仍冲刷；冲刷期重入写入按同步语义通知 | `scope.spec.ts` |

**观测规则（评审要求）**：自动恢复用例只能经只读状态观测等待完成（`authority`/`diagnostics` getter、scope 投影），**不得**调 `refresh()`、`withOperation` 或任何隐式 `ensureAuthority` 的 helper 来推动恢复——否则测到的仍是按需恢复。心跳期主动故障检测不在本期验收范围（Non-goals）。

## Risks

| 风险 | 处置 |
| --- | --- |
| 重连≠恢复：hello 后无快照，投影长期 withheld | R2 把完成条件写死为"连接 + 已跟踪主根同步清零"；部分失败处置明确 |
| 空快照撞 `''` 缺省签名，旧边界清不掉 | R2 的 scope 真值签名/受控强制替换；scope 层断言而非 list 断言 |
| openDomain 中途失败的通知振荡 → Issue #24 同形慢速抖动 | R3 私有暂存 + 并集提交，整轮失败零通知；先于调度器合入并带回归 |
| 暂存污染 `cache` 可见面 | R3 本轮私有暂存，`cache` 只在提交时替换 |
| 去重漏一处（含 `unknown-state` 重复调用路径） | `enterStorageFailed` withheld republish 统一门控；评审时枚举全部 `setAdditionalRoots` 调用点 |
| owner 挂起时 tick 占 `authorityChain` 阻塞用户操作 | R4 单次连接 + ≤5s 上限；评审确认可接受 |
| 恢复流程拖延进程退出 | R4 本地握手取消（request 定时器取消时同步清除）；残余上限 ≤5s 写入合同 |
| 后台恢复被误读为合同保证 | 文档与诊断面明示 best-effort；任何授权仍以当次 admission 为准 |
| quarantine 被误标"重试中"误导 operator | 结构化 `recoveryClass`，诊断按类显示 |

## Open Questions → 评审决定

rev.1 六问按首轮评审建议转为决定（rev.3 维持不变，待最终签字）：

| 问题 | 决定 |
| --- | --- |
| 封顶后是否继续 | 对可恢复故障**持续低频重试**、保留 jitter；不设次数上限 |
| `storage-failed` 是否纳入 | 纳入结构化分类为 `retryable` 的子集；`config`/`quarantine` 排除 |
| opt-out | 默认开启 + 布尔开关；暂不开放间隔配置 |
| R3（tick 连接次数）实现形状 | 唯一 `ensureAuthority` 入口，传调用来源；内部复用 connect-once |
| 诊断展示 | getter + 转换日志首期即可；区分 等待/尝试中/禁用/须重启 |
| unknown-state | 保持现有合同；F4b 单独立项 |

## Documentation Impact

- 已采纳：[ADR-0026](../../decisions/ADR-0026-registry-background-recovery.md) 定案后台恢复调度与完成条件、通知原子性/去重保证、opt-out；实施时同步修订 ADR-0025 的"按需恢复"表述与 `docs/architecture/registry-authority-service.md` 恢复节。
- 本文已链接入共享计划 F4 行与 `docs/plans/README*` 索引；批次已登记总账，实施进度与发布状态以总账为准。
- 验收通过前不宣称任何能力已实现。

## Completion Criteria

- [x] 技术评审通过（rev.4，2026-10-31），评审决定表签字。
- [x] [ADR-0026](../../decisions/ADR-0026-registry-background-recovery.md) 落地；批次已登记总账（实现与验收另计）。
- [x] 实施前源码审核门（rev.5）完成；N1 阻塞缺陷已先红后绿修复（R0）。
- [x] Phase 1 前置修复落地：scope 真值签名（空快照清边界回归）、私有暂存与 rev.4 顺序并集提交（scope `subscribe()` 纳入通知批处理）、withheld 门控、日志去重、握手本地取消（request 定时器保持 ref、取消时清除）、结构化资格分类，各带"先红后绿"回归（macOS 本机）。
- [x] R1 调度 + R2 完成条件（含失败集合重同步）+ R4 tick 成本控制实施完成；fake-timer 单测与多进程 e2e 全绿，且用例遵守只读观测规则（macOS 本机与三平台 CI）。
- [x] 三平台 CI 通过；Windows semaphore 接管语义经原生验证：PR #29 CI（`0468e9a`，run 41193188159）82/82 通过：20 个精确版本 × ubuntu-22.04 / ubuntu-latest / macOS / Windows，gate 通过；Windows runner 上 `registry-semaphore-win32.e2e.ts` 的后台接管用例实跑通过（无任何操作、owner 死亡后 follower 自动接管，约 2.5s）。`shared-registry-multiprocess.e2e.ts` 的 SIGKILL/SIGSTOP 三例按设计只在 POSIX 运行，Windows 的 owner 死亡接管由前述 semaphore 用例覆盖。首轮 CI 的 Windows 失败及修正见评审修订记录"Windows CI 修正"。
- [ ] soak 空闲降级资源有界；Issue #24 刷新循环无回归。已完成：`registry-recovery-soak.e2e.ts` 空闲降级 30s（macOS 本机实测尝试 5 次、scope 通知 0、CPU ≈40ms、heap 增长 1–3MB）与 Issue #24 静默用例在本机及三平台 CI 全部通过。**暂缓**：真实 dsh-tui `pnpm soak:tui-registry`（2026-10-31 决定本批暂不运行，需隔离 TUI 环境）；在其完成前本项保持未勾选。
- [x] 架构文档恢复节与 ADR-0025"按需恢复"表述同步；总账已登记实施状态（未发布）。
