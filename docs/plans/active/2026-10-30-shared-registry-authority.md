# 多 Host 共享 Registry：完整实施与后续演进计划

## Goal

落实 Issue #24 原始 Long-term 方案：**多个 DSH Host 可以同时使用附加根，始终只有一个存储管理者，新操作的授权与权限变更有可验证的顺序**。覆盖共享访问、一致授权、故障与接管、完整消费链，以及三平台和打包安装验收；不止于当前初版的提交或本机测试。

本文是[总路线图](./2026-09-12-multi-root-workspace.md#多-host-权威服务开发2026-10-29)的专项补充，负责原始目标与当前实现的对应关系、剩余工作、依赖和退出条件。实时进度、精确测试结果、平台/版本证据和发布状态仍只维护在总路线图。架构合同以[共享服务架构](../../architecture/registry-authority-service.md)、[ADR-0024](../../decisions/ADR-0024-registry-operation-admission.md)和[ADR-0025](../../decisions/ADR-0025-shared-registry-authority.md)为准。

本文以 **2026-10-30 的初版提交 `c56fbb2`** 为 Current State 快照。初版经 PR #26 合入 `main` 并随 `v0.1.12` 发版；原始方案的完整验收（Ubuntu 报告环境长跑复测等）和后续演进尚未结束，因此本计划放在 `active/`。

## Background

[Issue #24](https://github.com/cherrchen/dsh-plugin-multi-root-workspace/issues/24) 报告 Ubuntu 上第二个共享登记存储的 dsh-tui Host 空闲时持续单核占用、内存增长，最终 V8 OOM。机制是竞争锁失败重复发布 unavailable，触发 Skills 失效与客户端重查反馈链；`storage-failed` 同样存在重复通知问题。机制、引入历史与 hot-fix 证据见[故障排查](../../troubleshooting/registry-owned-by-another-process.md#skills-查询导致持续刷新issue-24)，不在本计划重写一份问题时间线。

已发布的 `v0.1.11` hot-fix 使 authority 同值通知静默，保留持续内核锁和单持锁进程消费限制。它解决刷新循环，不能让第二个 Host 同时使用附加根。原始 Long-term 因而提出四部分建设，并在审计后将操作准入、同步接缝、拒绝边界、旧终端语义和 IPC 权限隔离列为前置条件。

原始顺序保持为：**先定撤权语义和授权接缝 → 建立核心/facade、IPC 与版本协议 → 接齐消费者和恢复 → 用确定性多进程交错完成跨平台验收**。原审计的“Proposed，未实现”描述的是初版之前的状态；不能用它覆盖今天的代码，也不能把今天的本机通过结果扩写成全部平台已验收。

## Current State

### 已发布基线、开发初版与原始目标对照

下表是基于 `c56fbb2` 的能力快照，不是另一个持续更新的发布账本。

| 原始规划 | 已发布 `v0.1.11` | 开发初版 `c56fbb2` | 完整目标仍需闭环的内容 |
| --- | --- | --- | --- |
| 刷新循环 hot-fix | 已实现；authority 同值静默 | 保留；增加共享模式重查与查询资源回归 | 在真实 TUI/报告环境验证新服务的长期 CPU、内存和事件数 |
| 共享访问 | 只有持锁 Host 使用附加根；另一方等待 | owner 唯一打开显式 JSON medium；follower 走本机认证 IPC；Registry 仍是 scope 发布者 | 三平台实际装配、配置别名/错配、混合新旧 holder、打包安装证据 |
| 一致授权 | 进程间不共享新操作授权 | owner/follower 的 admission 与 mutation 在 owner 排序；store/epoch/revision；本地 mode/tool cap 收窄 | 全支持版本与非工具入口审计，确定性撤权交错及缓存旁路验证 |
| 故障与接管 | lease 争用下 fail closed，退出后 refresh 接管 | 断线停止新附加授权并保留拒绝边界；按需重连/竞选；磁盘重开、新 epoch；结果不明不重放 | Windows semaphore/pipe 原生故障矩阵、Linux peer 身份原生验证、长期恢复循环 |
| 完整消费链 | 各消费者使用单 Host scope | fs、sandbox、shell/PTC/agent PTY、LSP、Files/watch、instructions、Skills 均有新准入接缝 | 每平台/版本核对实际调用路径；保留路径身份、工具上限和旧进程快照边界 |
| ADR 与架构演进 | ADR-0007 的独占消费合同 | ADR-0007 保留历史；ADR-0024 定义撤权语义；ADR-0025 替代共享模式的独占消费条款 | 后续若修改合同，追加 ADR，不静默扩大撤权或恢复承诺 |

### 实现落点与当前边界

- `src/registry.ts`：同一个 Registry 类内的 owner 核心与 follower facade 角色分支，共用唯一 mutation/重分类路径；并非独立 daemon 或已经物理拆成两个服务包。
- `src/authority/`、`src/compat/authority-storage.ts`：认证传输、协议和显式介质适配；只有 owner 打开 domain。`src/registry-operation.ts` 与 scope 连接异步准入和同步执行。
- `src/process-fence.ts`：异步入口重新准入，同步入口消费有效上下文；Host 直接调用同步 handle 时仍须显式 `withOperation()` 包裹。没有上下文时只给保守主根范围。
- 旧 PTY/进程及池化 LSP server 的自主行为保留启动快照。初版未实现撤权时自动终止/重建它们，也不等待全部在飞工作完成。
- mutation 去重只在连接内存中；没有跨崩溃的持久化去重日志。连接/应答丢失后需要重新读取状态对账，不盲目重放。
- 恢复由新操作/refresh 按需触发；没有后台持续重连服务。已打开 domain 出现 unknown-state 后隔离并持锁，需要重启核对。
- 共享范围限同机器、同用户、同锁命名空间和同物理介质；旧 Linux 内核无法证明 peer 身份时不共享，Windows 限同登录会话。

### 当前证据的适用范围

初版时已有本机 macOS 开发基线、最早同步版本隔离树、真实内核锁/IPC、独立进程交错、原生 Skills 重查，以及安装产物双 Host profile 验证；这些本机结果自身不能证明其他平台或 TUI 长期运行。初版后的原生 CI、Windows waiter 交错补强及验收修复，见[总账的 Draft PR 验收记录](./2026-09-12-multi-root-workspace.md#初版核对与-draft-pr-验收2026-10-30)，不将下表的初版快照误读为实时待办。后续 macOS 真实 TUI 长跑与故障注入已补入总账；Ubuntu 报告环境仍需独立复测，不能用 hot-fix 的旧双 Host 观察或 macOS 结果替代。

## Scope

本计划的首要交付是原始四部分方案的完整闭环：保留 hot-fix，核实实现边界，完成未执行矩阵，修复验收暴露的缺陷，达到可发布状态。原审计的六项 P1、介质身份、epoch、协议兼容、请求结果不明、重复提交和旧权威恢复都在范围内。

后续能力也纳入本文规划，但分为“原始方案尚缺验收”与“改变首版合同的演进候选”。后者必须先完成设计和 ADR；不能因列在未来表里，就把它当成已实现或首版发布的隐含前提。

## Non-goals

- 不修改上游包、不另建根表或授权写口，不以缓存、广播版本、提示词或模型参数代替当次授权。
- 不以缩短持锁、按项目拆同一 JSON 的锁、替代锁路径、TTL/PID 判断或超时夺锁代替唯一 owner。
- 首版不承诺撤权后所有旧效果立即消失，不承诺网络存储、跨机器/用户/登录会话共享，也不承诺跨崩溃 exactly-once。
- 本计划不指定新版本号，也不授权自动发布。独立 daemon 等演进不通过“完善首版”名义直接改变部署和信任边界。

## Design

### 原始六项 P1 的决定与剩余工作

| 审计问题 | 初版已作决定/实现 | 尚未闭环的工作与判定 |
| --- | --- | --- |
| 撤权何时完成 | ADR-0024：撤权后的新准入用新状态；已准入操作可以完成 | 各消费者和平台用屏障验证两侧时序；旧 PTY 快照须对用户明确。强撤权属于后续新合同 |
| 本地 scope/版本不能证明授权 | owner 和 follower 都经核心排序；缓存仅辅助 | 丢通知、延迟/旧 epoch 应答、并发 mutation 下不得从旧缓存批准新调用 |
| 同步 confine/spawn 不能改 RPC | 异步入口准入，短期上下文供同步消费者使用；无上下文收窄 | 逐精确版本核对直接服务、非工具调用、PTY、同步返回形状、过期 async 后代与复制 argv |
| 断线不能清掉拒绝边界 | 保留在册/withheld 信息；未知状态主根范围、无共享 temp；Files 拒绝未知外部读 | 冷缓存、related tail、流取消、Full-access、根位于 temp/home 的组合均须原生验证 |
| 旧终端新命令可能继承旧权限 | 明确旧 PTY/进程快照例外；新建 PTY 重新准入/生成 profile | 验证创建与输入旧终端的区别；若产品要求旧命令也撤权，另立终止/重建协议 |
| IPC 是新管理权限入口 | 内核 peer/token 认证，拒绝受限 agent；无 bearer 文件，不继承连接 | Linux/Windows 的真实受限子进程攻击、服务端伪装及失败关闭证据仍须补齐 |

### 不因后续演进而放松的合同

每次准入与 mutation 的顺序、唯一介质打开者、scope 单一发布路径、recordedPath 身份校验、每根访问三态、可信 tool cap、Session origin、用户终端透传、provider/compat 门禁和卸载排空顺序继续有效。具体规则引用架构和 ADR，不在这里再维护协议 schema。

故障检测与获得存储权是两件事：即使未来加入心跳，超时也只能停新授权，不能抢仍被持有的内核锁。Windows semaphore 的关闭 handle 不恢复 count，必须验证实际 handle 生命周期；不能凭 POSIX 结果推断 Windows 可恢复。

## Implementation

### P1 — 撤权合同与授权接缝（原始步骤 1）

初版已建立基础；剩余工作是全面核对入口和异常边界。

- 建立“消费者 × 实际公开入口 × 同步/异步形状 × Session 来源 × 准入位置”的检查表，直接读取每个支持版本的发布 API/实际调用路径。
- 覆盖直接 fs write/edit、shell/PTC、agent PTY、工具和非工具入口；显式包装同步调用与无上下文主根 fallback 都要有正反例。
- 用真实 I/O/启动屏障检验先准入后撤权、先撤权后准入；旧操作可完成与新操作被拒必须分别断言。
- 验证工具嵌套只能收窄、未知工具身份偏严、路径替换不重授、过期上下文与旧 argv 不可复用。

退出条件：同步调用形状保持；每条实际扩大附加授权的入口都能指出可信准入来源；没有只靠 `tools/execute` 的覆盖假设。必要功能若因缺接缝不可用，修复或显式处理支持范围，不能静默降级后宣称兼容。

### P2 — 核心/facade、IPC 与版本协议（原始步骤 2）

依赖：P1 的准入合同；初版已实现逻辑角色，仍需完整平台和兼容验证。

- 验证只有 owner 打开显式介质；follower 的管理与准入均走同一核心，不受承载 Host 的 Session 表或 tool cap 污染。
- 验证 canonical store、lease 和 endpoint 对齐；覆盖路径别名、长路径、自定义配置、替代锁名拒绝、配置上限不一致。
- 验证 hello/snapshot/change 的一致切点、旧连接/epoch 响应、协议不兼容、旧插件 holder 无 IPC 的安全退化。
- 验证管理请求 ID 冲突、已提交但丢应答、连接内重复提交、超时与新 epoch 后不盲目重放；确认缓存/队列/缓冲和慢客户端资源有界。
- Linux/Windows 完成真实 peer/token 攻击用例；证明知道 endpoint、同 UID、能读协议/数据均不等于能管理 Registry，连接也不能被 agent 继承复用。

退出条件：身份、权限和配置兼容均有生产路径证据；不确定结果明确呈现；内存去重没有被宣称为持久化 exactly-once；未知协议/认证能力不可确认时不共享授权。

### P3 — 全消费者、故障与接管（原始步骤 3）

依赖：P1/P2；初版接入后的缺陷按同一阶段返工。

- 依[消费者表](../../architecture/registry-authority-service.md#5-同步消费与全消费者接缝)核对 fs、sandbox、shell/PTC/PTY、LSP、Files、instructions、Skills 以及 command/panel/review/topology；显示投影不能进入执行放行。
- Files 覆盖 list/stat/read/readBytes、存在的旧 readAll/readRelated、关联路径与 watch 每帧；断线后空表不能恢复上游外部读权限。
- Skills 覆盖原生缓存、alias/metadata 开关、候选/正文/receipt/reader 的 epoch；instructions 覆盖读取至最终投递之间的撤销、延期和显式撤回。
- 验证正常卸载、断线、暂停、崩溃、多候选竞选、旧 holder 重启、重新连接；胜者从磁盘重新打开，旧数据/旧 epoch 不得复活。
- 验证 storage-failed 重复刷新不触发反馈链，unknown-state 不发布新 grant，保持 lease/拒绝边界；清理流、reader、订阅、fd/handle 与公开方法包装。

退出条件：完整消费链在故障期间保守拒绝，恢复后能用新身份重新使用附加根；新/旧进程语义与 ADR 一致。owner 暂停时安全不可用是首版预期，不能以越过内核锁提高可用性。

### P4 — 确定性多进程、三平台、版本与安装验收（原始步骤 4）

依赖：P1–P3；这是当前首版的主要未完成交付。

- 在独立进程/V8 堆上验证同/异主根并发 mutation、不丢 durable 数据、撤权屏障、断线/崩溃/接管、多个候选、旧 holder 恢复。
- macOS、Linux、Windows 原生执行；核实实际可用方言，不把 platform skip、外层沙箱拒绝或缺能力当成通过。
- 对原有每个精确 DSH 版本重建统一依赖树、执行 enforce 兼容门禁和相关矩阵；不改支持列表来掩盖失败，不覆盖未提交 manifest，不保留探测 pin。
- 每 OS 执行 kernel:probe、compose/behavior/journey、pack:check、smoke:packed；验证实际安装 bundle 的多 Host 共享，区分同进程双 profile 与独立进程证据。
- 真实 dsh-tui/Ubuntu 报告环境进行可复现的多 Host 长期观察，包含 Skills 开启、零根/有根、变化后自动重查、撤权和 owner 退出。记录 CPU、RSS、V8 heap、查询/事件数、错误和退出，事先确定采样周期/时长/保护阈值，不强制 GC 来掩盖增长。
- 进行发布前复核，更新对应文档和总账；版本及发布内容按既有 release workflow 处理，不能在本计划里虚构已发布状态。

退出条件：下列验收矩阵无未解释的失败；所有未覆盖条件有明确记录和处置；原报告环境与新服务长期资源行为有独立证据。只有代码提交和本机通过不能结束本阶段。

### F — 后续能力演进（尚未实现，先设计再进入开发批次）

下列是完整长期方向的预留工作，**不把它们倒推成原始首版的必做要求**。纳入开发时需在总账登记批次，并以新 ADR/专项计划确定合同及退出条件。

| 方向与来源 | 相对初版的差异 | 设计/实现前必须解决 | 最小验收目标 |
| --- | --- | --- | --- |
| F1 独立权威 daemon（原方案允许后续替换承载方式） | 当前服务依附持锁 Host，逻辑核心/facade 同类实现 | 核心物理分离、启动/发现/退出/升级、版本并存、迁移与回退；不新增第二 owner | 关闭任意使用方 Host 不导致服务丢失；daemon 崩溃按原锁/epoch 恢复；旧部署安全退化 |
| F2 强撤权（原审计提出的另一种产品选择） | 当前允许已准入工作完成，旧 PTY/进程是快照例外 | 操作/进程/PTY/LSP 生命周期登记、取消/排空、失联 Host 语义，以及撤权成功的精确定义 | 在承诺的范围内旧效果已停止后才返回成功；失联不能被误报为撤销完成 |
| F3 持久化幂等与自动对账（原审计的结果不明问题的更强方案） | 当前只做内存去重与手动重新读取，不自动重放 | 请求日志与 mutation 原子提交、client/store/epoch 身份、重试期限与日志回收、降级安全 | 在提交前后/应答前后崩溃，重试同一逻辑请求不重复执行；能查询明确结果 |
| F4 后台恢复与故障诊断（后续可用性增强；[专项计划](./2026-10-31-f4-background-recovery.md) rev.4 评审通过，[ADR-0026](../../decisions/ADR-0026-registry-background-recovery.md) 已立项；已实施并经三平台 CI 验收，真实 TUI soak 暂缓，未发布） | 当前按需重连；unknown-state 隔离至重启 | 有界退避/jitter、取消/退出、诊断状态、存储核对及重开条件；心跳不得夺锁 | 空闲故障不会形成忙循环；恢复不复用旧 grant；修复前始终保守拒绝 |
| F5 更透明的直接同步调用集成（原同步接缝问题的后续改善） | 当前显式 async wrapper 或主根 fallback | 识别所有真实异步上层/必要上游公开 seam；保留 sync API、receiver 与描述符，不同步阻塞 RPC | 新增调用方式也能取得逐操作授权，不牺牲旧版功能或绕过 mode/tool cap |
| F6 扩展认证/锁命名空间（超出原方案首版边界） | 当前旧 Linux 无 peer-pidfd 时不共享，Windows 只同登录会话 | 等价强度的 peer 身份证明、跨会话锁/endpoint 与 ACL、新旧实现共存；不能只降为同 UID | 支持范围内仍唯一存储管理者；受限 agent 无管理权限；跨会话崩溃/接管可验证 |

跨机器/用户、网络介质和不同容器挂载视图不因 F6 自动纳入。是否需要这些产品能力，另行定义需求和信任边界；不把它们作为待补齐的现有支持承诺。

首版处置：F1–F6 均明确延期为演进候选。它们分别改变部署方式、撤权保证、持久化提交协议、恢复策略、同步接缝或支持范围，需要独立需求/ADR 与验收资源；当前没有采纳为首版必做项，也不宣称已经实现。

## Validation

| 场景 | 应验证的结果 | 主要生产回归入口 |
| --- | --- | --- |
| 正常 holder/follower、同/异项目 | 多实例均可使用各自附加根；只有一个 domain 打开者；授权集合不串项目 | `shared-registry.spec.ts`、`shared-registry-multiprocess.e2e.ts` |
| 并发修改与真实撤权屏障 | 数据不丢；旧准入按合同完成，新准入使用新权限；通知丢失不影响正确性 | `registry-operation.spec.ts`、`shared-registry*.ts` |
| 直接/同步/非工具进程入口 | 返回形状保持；没有准入不扩大权限；过期上下文/旧 argv 不放行；用户终端不误围限 | `process-fence.spec.ts`、`shared-consumers.spec.ts` |
| 断线、冷缓存、storage-failed/unknown-state | 保留拒绝边界；无共享 temp/ambient 绕过；Files 不空表穿透；Skills 不自激重查 | `shared-consumers.spec.ts`、`skills-authority.spec.ts` |
| owner 崩溃/暂停、多候选、旧 owner 重启 | 唯一继任者、磁盘重新打开、新 epoch；暂停未退出不夺锁，旧响应不复活 | `shared-registry-multiprocess.e2e.ts` |
| Windows semaphore 与 pending pipe | 争用失败关闭 handle；holder 崩溃、waiter 暂停/恢复后行为可解释且可恢复；pending client 断开不永久损坏监听 | `registry-semaphore-win32.e2e.ts`、`registry-lease*.ts`、`authority-native.spec.ts` |
| 三平台受限 agent 及伪装端点 | 知道协议/endpoint 仍无管理权限；token/peer 不可确认时拒绝，不继承连接 | `authority-native.spec.ts` 与原生 runner |
| 新旧 holder / 协议 / 配置差异 | 不另开 domain、不接受不兼容状态、不把结果不明当作未提交重放 | `shared-registry.spec.ts` 及版本隔离安装树 |
| 全消费者与缓存/流 | 每新操作准入；旧 Skill epoch、Files 帧或指令投递不能借缓存越过边界 | `shared-consumers.spec.ts` 及各消费者现有测试 |
| 真实 TUI 长期运行与打包部署 | 查询/事件与资源增长有界，多 Host 可用，撤权/接管行为与源码测试一致 | TUI 观察夹具、三项 smoke、packed battery |

这里的“入口”表示应运行/补足的套件，**不表示每个组合用例已经存在或在每个平台通过**。缺少 Windows waiter 暂停等原生交错时须补夹具；代码已存在但没运行，与没有用例，是两种不同的未完成项。精确执行结果仍只写总账。

## Risks

| 风险 | 处置 |
| --- | --- |
| 本机绿灯被误作跨平台支持证明 | 按 OS/版本/内核能力记录实际执行、跳过原因和失败；不以旧版本历史结果替代新服务验证 |
| 初版和未来合同混淆 | P1–P4 闭环原始方案；F 项先立新合同，尤其强撤权、自动重放和后台恢复 |
| 受限 agent 借 IPC 提权 | 真实受限子进程攻击与伪装服务端测试；认证失败不可降级成同 UID 放行 |
| Windows semaphore 或旧插件并存导致恢复假设失效 | 原生测试 handle 生命周期及混合 holder；必要时修订锁方案并证明升级共存，不更换锁名绕过竞争 |
| 同步服务调用漏包裹或未知上游形状 | 维护实际入口清单、结构适配和负对照；不阻塞事件循环等待本进程服务 |
| 查询/缓存/恢复造成新资源循环 | 覆盖稳定失败、反复接管、慢 peer 和长时间 requery；观察 fd/handle/reader/队列，而不仅看短期 heap |

## Documentation Impact

- 本专项计划维护原始目标对照、阶段与退出条件；[总路线图](./2026-09-12-multi-root-workspace.md#多-host-权威服务开发2026-10-29)维护进度、执行结果和发布状态，两个方向互相导航。
- [架构](../../architecture/registry-authority-service.md)维护当前协议/消费者/恢复合同；ADR-0007 保留历史，ADR-0024/0025 为已采纳决策。F 项改变合同时追加 ADR。
- 入口或配置改变时同步需求、开发工作流、故障排查与必要双语 README；发布内容按双语 CHANGELOG 维护，不在计划复制发布历史。
- 文档变更必须通过 `pnpm docs:check`。本计划只有首版验收完成、未来候选已实施或有可追溯的后续计划/明确延期去向后，才按计划生命周期评估迁入 `completed/` 并更新所有链接。

## Completion Criteria

原始 Long-term 方案的完成条件：

- [x] 原四部分与六项 P1 全部有决定、代码落点和适用平台/版本证据，边界没有靠聊天补充。
- [x] 三平台/全部原支持精确版本相关矩阵完成；失败已修复，缺能力场景按明确合同安全退化并记录。
- [x] 独立进程并发修改、跨实例撤权、断线/暂停/崩溃、多候选、旧 holder 和新 epoch 的交错验证完成。
- [x] 真实受限 agent 不能管理 Registry；Windows semaphore/pipe 与 Linux peer 身份恢复假设有原生证据。
- [x] 全消费者直接/同步/非工具接缝、缓存与流、mode/tool cap、路径身份和已启动进程快照验证完成。
- [ ] 真实 TUI/报告环境的共享服务长期观察完成；macOS 已补证，Ubuntu/报告 Node 组合仍待复测，旧 hot-fix 观察不代替新服务证据。
- [x] 每个 OS 的普通门禁、kernel probe、三项 smoke、pack 与 packed 验收完成，支持/发布状态如实维护。
- [x] F1–F6 每项明确为采纳实施、另立计划或延期/不采纳并记录理由；未采纳项不虚报已实现，也不无限扩大首版完成条件。
