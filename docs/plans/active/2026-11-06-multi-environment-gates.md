# Issue #32 多执行环境实施与验证计划

**状态** In Progress（外部技术评审通过；2026-11-07 开始 G0） · 2026-11-06。G0 已增加[基线取证入口及接缝清单](../../reference/multi-environment-baseline.md)，G1 的本地委托对照沿用同一入口（`--local-facade`）；逐平台验证与关卡状态归[路线图总账](./2026-09-12-multi-root-workspace.md#多执行环境-g0-基线2026-11-07)，不代表真实 SSH 能力已验收。本稿用于评审拆分、依赖和验收方法。架构基线为 [ADR-0030 至 ADR-0034](../../decisions/ADR-0030-environment-and-root-identity.md)。除已落地的 G0 入口外，下述 PR、接口名与测试夹具仍为候选。评审已决定：SSH 能力仅当宿主为 `0.2.2-rc.1` 及之后的支持成员时开放，更低的受支持宿主静默不开启该能力。

目标样例取自 [Issue #32](https://github.com/cherrchen/dsh-plugin-multi-root-workspace/issues/32)。Issue 中的 Windows 发起端无限期延后。本期只在 Linux/macOS 发起端验证其余跨机流程，由一个 Session 先从两个本地根各复制一个源码文件到 Ubuntu，再显式执行构建，把产物从 Ubuntu 流式投送设备。设备具备已验证执行能力时再执行测试、读回日志；只有传输能力的设备应成功收件并明确拒绝执行。这样可以区分完成了哪一段，以及何时才算满足完整诉求。

## 交付边界与依赖

评审以一个默认关闭的 POSIX 实验为边界。本期可以独立验收的能力是单文件复制、受限的单次远端命令、显式根内读取。给原生 FS 门面增加远端路由要过消费者差分，G6 的透明进程路由单独延期。若实际后端仅能安全执行其中一项，只对那一项给出结论；端到端构建部署要等所有参与步骤各自通过。Windows 发起端按 ADR-0030 无限期延后。

先做 G0。随后可分别做 G1 本地对照、G1a 控制面和 G4 独立官方对照；G2 依赖 G1/G1a，G3 可先用假后端，真实命令再合入 G1a/G4。G5 接入可选工具、UI 和多环境旅程时才允许用户触及相应操作。以下每个 PR 在实验组合内可撤回，实施及对外宣告支持均须另行评审。

初版远端集成候选 pin 为已核对的 DSH `0.2.2-rc.1`。旧 pin 只承担原本的本地回归。实现时从宿主解析 SSH 可选 peers，延迟到通过平台、兼容性、品牌及部署检查后才加载；禁用态应可在完全没有 SSH peers 的 packed profile 中启动。单独记录“缺可选包”“身份不符”“能力不足”和“结果未知”，使用户能区分无法开始与可能已经产生效果。

**SSH 兼容门禁（评审决定）。** 远端能力仅对 `SUPPORTED_SSH_RELEASES` 内的宿主开放：`src/compat/dsh-version.ts` 新增该常量（现 `['0.2.2-rc.1', '0.2.2-rc.2']`，须保持为 `SUPPORTED_DSH_RELEASES` 后缀）及 `SSH_PEER_PACKAGES` 分类。宿主不在集合内、SSH 包缺席或版本不符时能力静默缺席——compat 行不失败、不产生 mixed、不影响既有本地行为。上游安装期兼容检查对清单中**每一个** `dsh-*` peer（含 optional）都要求宿主版本满足其 range，因此四个 SSH 包若进 `peerDependencies`，range 必须与全量 allowlist 一致；收窄只发生在运行时地板，不在 manifest 区间。`@deepseek-ai/dsh` 自身依赖不含任何 SSH 包，packed profile 默认即无 SSH peers，缺席按“缺可选包”记录。SSH 包动态加载并经宿主锚定解析（仿 `loadHostKoffi()`），不计入 `CORE_PACKAGES`；`check-dsh-compat.mjs` 对本类排除版本混合检查，单独要求其 dev pin 恰好钉住一个 `SUPPORTED_SSH_RELEASES` 成员（可与核心 pin 并存），并互查 peer 声明与分类名单一致。

## 每一关的改动与退出条件

| 独立 PR | 前置、候选落点与实验 | 通过证据 | 未通过时 |
| --- | --- | --- | --- |
| G0 基线 | 仅调研与测试。以 rc.1 和最老支持 pin 对照 `cordis.patch.yml`、`src/compat/fs-patch.ts`、真实 profile 工具清单、package/Helper 发布物。先记录原生 web/headless FS 与进程行为；含 `applyPatch` 开/关。[分发调查](../../decisions/ADR-0032-upstream-ssh-backend.md) 已有精确入口导入结果。另产出三项评审要求的证据：出树工具注册缝的实测清单（注册入口、真实 Session 与调度工具身份的获取、权限拦截、tool cap、按实验开关条件出现、turn 取消）；上文 SSH 兼容门禁在 `check-dsh-compat.mjs` 的落地清单；受管 SFTP 端点原语盘点（`SSH_FXF_EXCL` 排他创建、`hardlink@openssh.com`、`posix-rename@openssh.com` 是否存在——该结论不依赖 G1a）。 | 对每个 profile 保存真实组合行、版本树、命令与哨兵；区分静态源码、安装成功和执行成功。 | 缺安装、Host 或凭据的格子记录未验证；不动生产配置。 |
| G1 仅 local backend | G0 后在 test composition 将委托门面接到 `src/fs.ts` 的原实现，扩展 `tests/fs-parity.spec.ts` 与 sandbox/process parity。此时不引入 SSH peer、远端记录或面板。[路由合同](../../decisions/ADR-0031-filesystem-routing.md) | 三平台比较空根/仅本地根的返回值、事件、scope、argv、工具清单与 prompt；直接 fs 调用和全套 smoke 等价。 | 丢弃 POC，保留现有 provider 子类。 |
| G1a 授权前置 | G0 后，扩展 Registry owner 的远端域与版本化准入。候选落点为 `src/registry.ts`、`src/authority/protocol.ts`、`src/registry-operation.ts`、`src/compat/authority-storage.ts`（第二域由同一 lease 的 owner 开启）。v1 `store` 字段装的是存储目录介质 id，本地与远端域共享——远端准入入口必须自带域判别，旧 owner 对未知域显式拒绝。部署清单由 Host 在受保护控制面启动期解析，不经工作区读路径。先用真实存储、双 Host 和无网络 fake 端点。 | 两个同名远端根分属不同本地项目；本地 v1、远端准入、新旧 owner 互操作和权限隔离分别有断言。 | 新旧协议协商失败仅禁 SSH；若影响本地 follower，停止合入。 |
| G2 只复制普通文件 | G1/G1a 后在实验 profile 中消费双端准入，实现候选 Transfer adapter 和受控二进制 sink；从 Linux/macOS DSH 向受管 Ubuntu SFTP 做单连接 POC，再用 macOS 目标验证相同入口。实验配置只由部署方提供；模拟通道只用于故障注入。[复制合同](../../decisions/ADR-0034-binary-transfer.md) | 两个本地根上传后逐文件哈希相同，可从允许根下载；只读目的地、SFTP symlink/抢占发布名、无安全发布原语均拒绝。 | 禁用相应方向；不提前给默认 profile 增加模型工具。 |
| G3 显式远端命令合同 | G1 后给独立测试组合加 `remote_bash` 调度与取消，使用可控的假 backend 验证 session、权限、输出和状态机；对外启用依赖 G1a/G4 真机结论。[执行合同](../../decisions/ADR-0033-remote-command-and-sandbox.md) | 最终准入前撤权不会调用 spawn；超时、失联、直接进程退出但后代未确认均可区分。工具只能在经验证的组合中出现。 | 只测试调度，暂不开放执行。 |
| G4 官方 POSIX 后端 | G0 可先于 G2/G3 独立进行。由 Linux/macOS Host 连一台可丢弃的 POSIX 远端；先跑上游完整组合，再在本插件临时 profile 内挂隔离 Context，重跑同一用例。可选 peers 与 `src/compat/` 按 pin 探测，落点含 `src/compat/dsh-version.ts`（SSH 分类与 `SUPPORTED_SSH_RELEASES`）、`scripts/check-dsh-compat.mjs`、`package.json` peers/meta。 | 绑定真实 host key 与 Helper hash，验证版本守卫、实际沙箱和清理；本地 brand、不受支持 profile 的退化、一个环境 dispose 均不影响其他环境。远端内核哨兵必须由受测命令实际尝试修改。 | 工具保持关闭；若只有私有协议能实现，记录最小上游 RFC 与复现。 |
| G5 多环境与端到端 | G1/G2/G3/G4 通过对应能力后把已验证的 Registry、连接管理器和能力投影接入真实工具组合；能力投影沿用现有 topology runtime-context 贡献缝（`src/instructions.ts`），新工具文案走 locale 双语并经 `tests/locale-parity.spec.ts`。测试本地两根＋build＋board，分别以同名路径放不同内容。最后才接面板与原生 FS 消费方。 | 旧库升降级、旧 owner、重连换身份、双 Host 撤权均不串权。从 Linux/macOS DSH 完成上述真实旅程。Web、headless、Electron 各自记录实测入口（Electron 实测依赖外部宿主仓库，登记时注明宿主与版本），SDK/ACP 等未测试的入口不列入支持。 | 仅交付已通过的显式工具；无受限执行能力的设备只记录已验收的传输方向。 |
| G6 原生透明执行 | G5 后，按 [执行 ADR](../../decisions/ADR-0033-remote-command-and-sandbox.md) 的 ExecutionContext 提案评估上游公开 API；逐一检查 bash、jobs、PTY、PTC、LSP、watch、指令、Skills 和 session restore。 | 两个并发 Agent 在同路径不同主机运行、恢复、撤权及取消，进程和文件效果可归因；每个 consumer 独立通过才开放。 | 延后该 consumer；维持显式目标，无 cwd 猜测。 |

## 各 PR 的实现细节与评审证据

### G0/G1：基线与本地委托

1. 固定插件与上游 SHA、安装包版本及实际 profile patch。输出“工具 → 调用的服务方法 → 允许/拒绝 → 文件或进程效果”对照表。单列 raw service 调用、工具调度和配置打开的 apply_patch，避免仅在 mock 工具上验证。
2. 候选改动集中在 `src/fs.ts`、`src/compat/fs-patch.ts` 及测试组合。本地路径继续走原 provider；实验门面逐项验证 resolve、观察事件、错误、同步 processPath、版本条件和 move 两端。向本机植入与远端 displayPath 同名的哨兵，输入未知/撤销的远端 URI；断言本地 IO 调用数为零。
3. 以旧 pin 和 rc.1 各运行一次 `tests/fs-parity.spec.ts`、`tests/apply-patch.e2e.ts` 中适用的测试；记下旧 pin 缺席的方法。对比关闭实验前后的 prompt、工具清单、sandbox argv 和 profile 服务，包括外来 provider、缺 optional peer、权限服务可用性。若必须改写本机调用者才可通过，保留显式工具，停止替换生产门面。

### G1a：绑定、存储与准入

| 产物 | 建议实现与负例 |
| --- | --- |
| 部署清单 | 受信部署方按本地 primary 列出 environmentId、rootId、账号、固定主机身份、命名空间、Helper/配置版本及允许的动作和传输配对。注册请求只能引用既有 ID。模型、项目文件、普通面板 RPC 不得带密钥、任意 host 或权限提升。测试另一项目的合法 ID 与两个 alias 指向同一目录。 |
| 持久化 | 新版本化域由现有 lease 的 owner 打开。endpoint 清单存引用，grant 存远端登记时身份；连接、密钥和准入句柄不入库。在 v1 原库的副本执行启用→撤权→关闭→旧版启动→新版重启，核对本地记录及远端撤权。注入新域打开/落盘失败，断言远端失效、本地仍由唯一 owner 管理。 |
| 协议 | 现行 hello、请求与 snapshot 都有严格的 v1 schema。先原样保留 v1 对话，用受同一 lease 与 peer 认证保护的可选协议入口试验远端请求。仅当新 owner 支持时开通。v1 `store` 字段装的是存储目录介质 id，本地与远端域共享同一值，远端入口必须自带域判别字段；旧 owner 对未知域显式拒绝。owner 解析 store、域、epoch、primary、用途、端点配对及绑定代次并在同一队列取一致记录；follower 只在已认证 Host 内结合其 Session 的有效策略和工具上限收窄。凭据和本地 ALS proof 不上 wire。失联、旧版只有 v1、配置摘要不符均显式拒绝。 |
| 顺序和清理 | 用 Promise 屏障将撤权放在初次准入之前/之后，以及最终发布或 spawn 准入之前/之后。取授权的短事务占 owner 队列，网络、哈希和等待退出在队列外。销毁、lease 交接和新 epoch 后重用旧请求，必须拒绝；将同一连接上的两个 Session 设成不同模式验证不会串权。 |

候选回归入口为 `tests/registry-operation.spec.ts`、`tests/shared-registry-multiprocess.e2e.ts` 和 `tests/tool-access.spec.ts`。保留一份可脱敏的排序轨迹（操作 ID、阶段、epoch、决定），不得记录 SSH 密钥、socket 票据、文件内容或命令输出。

### G2：从普通文件到可信发布

先实现内存受限的单文件状态机，再接两种端点。以现有 fs fence 提供本地受控读取/创建/发布，部署侧优先验证带隔离账户的 SFTP。每个端点须写明可保证的打开、稳定身份、私有 staging、目标父目录固定和原子 no-replace 原语——OpenSSH 服务器侧候选为 `SSH_FXF_EXCL` 排他创建、`hardlink@openssh.com` 与 `posix-rename@openssh.com`，仅普通可覆盖 rename 判 unsupported；普通路径型 SFTP 无法排除目录/对象替换时只能给出 unsupported。

- **输入与预算**：只接收已登记的源/目的根和相对文件名。开文件前检查双端权限、超时、大小、并发、暂存空间和已存在的目标；no-replace 仍须在最终提交时原子执行。每次固定大小分块、有背压，对源的字节数、版本及目标内容分别核验。测试 0 字节、超过一个协议 frame、超过部署上限、慢消费者和磁盘满。
- **竞态夹具**：在打开后改指 symlink、在验哈希后点名替换 staging、改写同一 inode、移动发布父目录、抢占最终文件名。可信隔离时哨兵必须安全；缺少所需证据时应在传出内容之前拒绝该部署。
- **状态与恢复**：记录 prepared、streaming、verified、发布请求已发出四个观察点。分别在每一点注入撤权、断线和关闭；给出提交状态、已知字节数、残留及可做的只读对账。模拟 link 已成功但临时名清理失败，必须报目标已提交；丢确认一律不重放。首期不包含目录递归、覆盖和删除。
- **通过样例**：先本地→构建机，再从该机独立导出二进制到设备；两次操作各自重新准入。用不持有对端凭据的构建机账户复验。缺少目标发布证据时将此方向剔出能力表。

### G3/G4：连接隔离和远端进程

1. 按 ADR-0032 的精确包、公开服务和顺序，仅在专用实验环境挂载一组官方 provider，先与同机配置的官方独立组合对照，再起第二个环境。连接构造前检查开关和平台；验证 A 错密钥、错摘要、网络抖动或 dispose 不会启动/终止 B，也不影响本地 profile。纯 SFTP 的目标平台以固定主机身份和受信部署清单验证。hello 绑定的 workspace 只是 Helper 的默认 resolve cwd：一环境多根共享连接时所有远端操作恒传绝对已核验根，断言解析永不落到默认 workspace。
2. 建立一份部署图，标出持有私钥、ControlMaster、SSH agent、可写临时区和 Helper 的 OS 主体。用本地 bash、Agent PTY/PTC 在各受支持模式尝试复用 socket、读取凭据、劫持 PATH/config；用远端构建用户尝试改写 Helper。`/tmp/dsh-ssh-*` 的 mkdtemp 0700 目录只是临时归属，不构成同 UID 隔离证据。通过必须有 OS 身份或命名空间隔离的证据。若做不到，仅保留隔离试验，不对模型开放后端。
3. 工具注册走宿主调度与权限拦截；独立准入仍保护直接服务调用。shell、固定环境、时限、stdout/stderr 上限由部署控制。显式限定 stdio 无 spill、模型不可选择可执行入口或额外 fd。返回退出码、信号、超时/取消原因和清理确认，禁止将远端路径交给本地 reader。对照 `tests/process-entrypoints.spec.ts` 验证本地 Agent PTY、用户终端、PTC 和原生 shell 不受影响。
4. G3 可用可控后端卡在 confine 完成与最终准入之间；G4 用公开 spawn 返回后立即断线/撤权复测。分别断言“根本未调用 spawn”“已准入且可能稍后启动”“已观察直接退出”“已确认范围退出”“结果未知”。测试超时后仍有后代在运行、持续大输出、重复取消和两 Session 共用连接只取消其中一项。
5. 真实远端沙箱试验绕过调用侧路径检查，用实际 shell/子进程尝试写根外哨兵；排除后端合法临时区。另对远端文件 API 直接尝试读取根外、在 resolve 后替换目录和读流关闭后续读。后端只支持安全 exec 不能同时算 FS 根内读取已通过。

### G5/G6：组合、回滚与后续范围

先在专用 headless profile 合入显式工具，以 `scripts/smoke-journey.mjs` 的真实 Session 流程为参照，再验证 web 面板。两台远端用相同路径、不同内容和不同账号，测试 topology、只读限制、复制方向、输出归属及端点拒绝。UI 状态从 Host 的实时能力读取，禁用项显示具体原因；断开一台不能切换到另一台或回到本机。Electron 及其他消费者只登记实际验证的组合。

每次验收至少做一次故障回滚演练：停止新准入→取消对应任务和流→记录已提交、残留或未知→释放连接→卸载可选行→重新启动原 profile。检查本地根、旧版存储、原生工具、已发布文件和未确认操作。运行历史中的远端引用在禁用后必须可辨认并拒绝重用。G6 仅保留公共执行上下文的上游研究；原生 bash 透明路由、远端 PTY/PTC/LSP/watch 与 Windows 发起端均不得作为本期完成项。

### 公开入口接线与失败报告

- **列出/添加**：面板传 sessionId 和部署清单中的引用，由 Host 解析本地主根。列出时只投影该项目的条目、目标平台、状态、实际能力和当前模式；添加时由 owner 核对绑定。无 Session、越权引用、重复点击、撤权后的迟到应答都要有用例。默认关闭或 Windows 发起端不得为刷新列表创建连接。
- **显式操作**：复制返回两端 ID、字节数、摘要、发布/清理结果；执行返回环境、操作 ID、退出/未知状态和截断标记。输入中的 URI、文件名、远端 stdout 都按数据处理；不能据此选择其他环境或把远端路径交给本地 reveal/download。端点不可用时禁止自动改用普通 SSH 或原生 bash。
- **读回文件**：先用真实 host 服务调用完成“已准入的根内读取”，与只读/读写 Session 的同名文件交叉验证；再按 ADR-0031 接入已审计的公开消费方。Helper 读路径不携带根策略，“根内读取”只能由客户端准入加部署账户隔离联合证明，后端或部署不能证明时该入口不开放。只有工具/面板实际走到通过验收的后端，才能宣告该入口可用。

### 平台与权限入口验收

按 [ADR-0030 的入口合同](../../decisions/ADR-0030-environment-and-root-identity.md)从面板、命令及直接 Host RPC 分别验证。本期正例由 Linux/macOS 上的 DSH 分别添加 Linux 和 macOS 的 SSH 根，并经真实连接读回各自的哨兵文件。原生 Windows 上只验证 SSH 入口显示延后原因，并在打开连接前拒绝请求。Windows 发起的读回用例留到上游满足 ADR-0030 的恢复条件后执行。负例为任一发起端选择已知 Windows 目标，在获取凭据和建立连接前拒绝；目标平台未验证或与握手/受信部署记录不符时，不登记根或执行文件操作。验收用调用计数和根表断言，不能只截图。Windows 本地多根继续纳入三平台回归。

在启用与添加入口核对声明，SSH 根列表只能查看当前有效模式；对命令、RPC、配置和工具分别提交逐根 access 或 mode 覆盖，确认拒绝且无副作用。让只读与工作区读写的两个 Session 并发复用同一连接，再在读写 Session 内动态切为只读。检查新写入被拒、未获准发布的复制被取消、下一条命令受只读约束。完全访问 Session 的远端写入仍须通过工作区边界；测试根外且位于获准临时区之外的哨兵。Session 或权限事实缺失时，连接缓存不能放行。

## 运行入口与取证

- **本地对照**：用相应 pin 的干净工作树运行 `pnpm compat:check`、`pnpm verify:all` 和 `pnpm docs:check`。快速定位可用 `pnpm exec vitest run tests/fs-parity.spec.ts tests/process-entrypoints.spec.ts tests/shared-registry-multiprocess.e2e.ts`。最终三平台仍须过 kernel probe、compose/behavior/journey、pack 和 packed smoke；`check-pack.mjs` 增加"产物无静态 SSH 引用"的断言。Windows 按[开发工作流](../../development/plugin-development-workflow.md)区分原生提升权限和普通用户的验证。
- **POSIX 对照**：在上游 rc.1 工作树按上游文档部署测试用 node-script Helper。设置 `DSH_SSH_TEST_CONFIG` 指向部署方持有的临时配置后，运行 `pnpm exec vitest run --retry 0 --config vitest.e2e.config.ts packages/ssh/ssh/tests/live.e2e.ts`；检查用例实际运行数，skip 不算通过。可执行载体另走上游 `scripts/verify-ssh-helper-artifact.ts` 与 `scripts/verify-ssh-helper-ssh.ts`。不向仓库提交凭据、socket、完整配置或敏感日志。[上游 fixture](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.1/packages/ssh/ssh/tests/live.e2e.ts)
- **新增实验**：各 PR 将自己的 fixture 加到现有 Vitest/真实 journey 入口；为每次运行记录插件和上游 SHA、精确 npm 版本、profile、Host/Remote OS、CPU、内核、Helper hash/协议、enforcement、哨兵前后摘要和操作最终状态。mock 证明调度；真实 sshd 证明连接；原生内核哨兵证明该后端该策略。Linux x64/arm64、macOS、嵌入式 ARMv7/musl 和 Windows 原生逐格记录，非目标平台可用明确的拒绝作为预期结果。

| 对抗面 | 最低判定标准 |
| --- | --- |
| 模式与消费者 | 本地测三种 Session 模式 × 三态访问 × tool cap；SSH 测三种 Session 模式的有效权限 × tool cap。覆盖真实 read/write/edit/apply_patch 的增删改移、bash/pwsh、Agent PTY/PTC、remote_copy、remote_bash。每个组合要么结果与有效权限一致，要么在产生效果前明确拒绝；关闭入口同样测试不可调用。 |
| 读写身份 | 将根、父目录、最终分量在解析与打开/发布间替换为 symlink、硬链接或 Windows junction；根外哨兵无泄露、无修改，异环境同路径版本不能互认。Windows UNC/设备/映射盘沿用本地拒绝。 |
| 授权与恢复 | 断开 follower、锁交接、storage-failed/config-invalid、撤销根、替换 host key 或 Helper、复用旧 target/argv/任务 ID。拒绝新操作且本地主根回退正常。 |
| 传输与进程 | 两个写者抢同一目标、大文件背压、在发布/启动后丢应答、杀 SSH 而子进程存活。结果区分未执行、部分完成、已确认与未知；无自动重放。尝试通过 native bash、PTY、PTC 直接取 SSH 身份。 |
| 降级与退出 | 缺 peer、mixed install、外来 provider、旧版无新 FS 方法、卸载远端行后重启。原生本地 profile 和品牌门禁可用，任何远端目标都不能落到本机路径。 |


## 提交外部评审的材料与完成判据

| 评审焦点 | 审阅者应能据此作出的判断 |
| --- | --- |
| 权威与兼容性 | 用一份端点清单、远端记录示例、新旧 owner/follower 的四格协议矩阵及故障时序图，说明哪个进程授权哪一步、另一项目为何不能复用同名根，以及关闭实验后旧版能否运行。 |
| 连接与执行 | 用部署图和“会话模式 × 工具上限 × 后端能力”表指出凭据在哪里、哪一步真正启动进程、哪些临时写入是沙箱允许的，以及哪种情况下只能报告 unknown。 |
| 传输 | 对每种源/目的组合分别列出对象身份与原子发布原语、可制造竞态的参与者、拒绝路径和清理责任。对只有普通 SFTP 的设备给出最小可部署前提或明确的 unsupported 结论。 |
| 发布范围 | 提交实际 DSH pin、平台/profile、命令、哨兵与失败注入结果，对照 G0 的关闭态基线，明确已验证、未验证、拒绝与延期。平台执行证据和发布状态继续归[路线图总账](./2026-09-12-multi-root-workspace.md)。 |

**本稿已经外部评审给出可追踪结论，维护者已接受 Plan**，可按 G0 开始实施。实施后的实验验收要求正向旅程、所有适用的拒绝用例和回滚都可复现；仅有 mock、静态审计、stdio Helper 或缺配置而跳过的测试，均不能签收真实 SSH 能力。若评审发现公开 API 或部署隔离不能兑现某项保证，应收窄交付或提出 ADR 修订，不能以放宽拒绝条件作为计划调整。
