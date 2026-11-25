# Windows Host SSH 发起端：OpenSSH 与 WSL

## 基线与范围

2026-11-25：工作区干净，开发分支 `feat/windows-ssh-initiator`；本地 `main`、远端 `main`（`git ls-remote`）、HEAD 与 `v0.1.24` 参考提交同为 `287b39a73b407736b0fc20afc0bfab75283d4d97`。不回退、不改版本、不推送或发布。

交付原生 Windows Node/Electron Host 的两个独立 SSH 发起端：B 使用系统 OpenSSH，无 WSL；C 使用用户显式选择的 WSL 发行版及其 SSH 环境，原生 Host 仍负责 Registry、准入、工具和本地数据 I/O。目标仅 Linux/macOS；不做 Windows Helper、独立凭据主体或 Team/Hardened。复用既有管理及工具语义；不改上游、不扩大沙箱、不重新授予既有 POSIX Root。

## 现状与设计边界

`classifySshCapability()` 和 `RemoteControlPlane.configure()` 各有平台门禁；移除一处不能形成 Windows 能力。`SshEnvironmentManager` 集中缓存、代次和 Host/Helper 复核，`RemoteToolsManager` 是现有工具接缝；不要为各后端复制这两个角色。WSL 应使用独立 stdio 通道，不带入 Broker 的独立 UID/部署证明。Host 只在确认当前 manifest 后交付新运行时；跨发起端的授权必须验证 owner/follower 一致且使用同一代次，缺失字段保留 POSIX 旧摘要。

当前 HEAD 有绑定浏览对话框的目录列表；没有通用 SSH Files Provider Routing 上线。后者在其他开发分支，不作为本分支重构基础。POSIX 实际行为见 [SSH 参考](../../reference/ssh-remote-environments.md)；控制面见 [多环境参考](../../reference/multi-environment-control-plane.md)。

## 阶段与门禁

| 阶段 | 状态 | Entry Gate | Exit Gate |
| --- | --- | --- | --- |
| W0 | BLOCKED | 需求与实际基线一致；已找到平台、连接、准入、凭据和 I/O 接缝 | 两版上游合同；真实 Windows Node/Electron 和至少两个真实 WSL 环境，或明确各自阻塞；分别判定 B/C |
| W1 | PASS (限定：共享接缝、本机回归) | 官方 provider 的实际接入合同明确；记录 POSIX 基线 | 通过共享运行时接缝运行原有 POSIX 用例；缺包与 Windows 门禁不改；无 Root 迁移 |
| W2 | BLOCKED（身份与 POSIX IPC 合同通过；原生配置、文件 I/O、切换未验收） | W1 合同稳定；Windows 共用信任边界明确 | 配置及本地文件授权/发布、后端身份、切换及多 Host 一致性用例通过；未验证 capability 关闭 |
| W3-B | BLOCKED（原生命令探针通过；Helper、流转发、SFTP、管理未验收） | W1/W2 可用；W0-B 已验证或明确限定为不可发布的开发验证 | 严格主机验证、官方 Helper RPC、TLS PSK、SFTP、管理和清理通过 Windows Node/Electron 实机与独立版本门禁 |
| W3-C | BLOCKED（原生枚举通过；双发行版、依赖部署、Bridge、ACK 未验收） | W1/W2 可用；在所选真实发行版上验证 stdio/依赖/退出 | 显式多发行版选择与初始化、manifest ACK、管理与工具、异常清理及代次隔离通过 |
| W4 | BLOCKED（本机回归与制品验证已运行；缺完整后端及实机验收） | W1/W2 可用；分别确认 B/C 的可验收项 | 现有 SSH Settings/i18n，完整用户旅程，真实矩阵、安装制品、回归、评审及发布决策 |

各阶段记录基准 HEAD、变更面、验证环境、命令与退出码、独立评审/修复、下一阶段条件。未通过项目不标 PASS；阶段形成独立提交或记录未提交阻塞。发布能力不能由测试环境变量或默认回退打开。

## 测试矩阵与证据

首轮使用 macOS arm64 / Node 24.18.0 / pnpm 11.25.0；接续环境与实测见 W0 阶段报告。仓库开启 GitHub-hosted Windows CI；当前无已注册 self-hosted runner。Hosted runner 不等同于真实 WSL2 双发行版或 Windows Electron 环境，不能以平台模拟替代。

L1–L3：现有 `ssh-*`、`remote-*` 合同、Registry/多 Host、传输并发与客户端 Settings；L4–L5：Linux/macOS POSIX 对照、Windows OpenSSH 与 WSL 各自 Node/Electron 至 Linux，Windows B/C 至 macOS、两发行版同名 alias、Windows 文件 ACL/NTFS 和进程退出；L6：typecheck、lint、build、兼容、许可、文档、pack 和 packed smoke。未实跑的矩阵格标 `NOT_RUN` / `BLOCKED`。

原生先决条件探针（无网络、无安装）：在 Windows 执行 `node scripts/probe-windows-ssh-initiator.mjs windows-openssh`，`node scripts/probe-windows-ssh-initiator.mjs wsl-list`（只读列出 `--list --quiet`，不启动任何发行版），以及 `node scripts/probe-windows-ssh-initiator.mjs wsl "<发行版 A>" "<发行版 B>"`。只启动显式列出的发行版。Helper 控制面探针（一次性测试设施，连接显式给出的 alias，不读取个人凭据）：`node scripts/probe-windows-ssh-initiator.mjs windows-openssh-helper <fixture-ssh-config> <alias> <remote-node> <remote-helper> <canonical-workspace> <entry-sha256> <linux|darwin>`，见 W3-B 阶段报告。`<fixture-ssh-config>` 必须是显式绝对路径的测试专用 SSH 配置，只含测试 key 与 known_hosts，不得 Include 其他文件、不得指向用户主配置；探针同时以 `IdentityAgent=none`/`IdentitiesOnly=yes`/`IdentityFile=none` 关闭 agent 与默认身份。该脚本不验证 sshd、PSK 或托管凭据。

## W0 阶段报告

基准 HEAD `287b39a73b407736b0fc20afc0bfab75283d4d97`（分支 `feat/windows-ssh-initiator`，工作区干净）。W0-A 上游发包合同 PASS：对 `@deepseek-ai/dsh-{ssh,fs-ssh,subprocess-ssh,sandbox-ssh}` 的 `0.2.2-rc.5` 与 `0.2.3-alpha.2` 各执行 `npm pack`，四次 `diff -qr <rc.5>/package/src <alpha.2>/package/src` 全部 exit 0（四包 `src` 树逐字节一致）；合同结论固化于 [ADR-0052](../../decisions/ADR-0052-windows-ssh-initiator.md)。

本机 macOS arm64 / Node 24.18.0 / pnpm 11.25.0 已跑：`pnpm exec vitest run tests/ssh-compat.spec.ts tests/ssh-environment.spec.ts tests/ssh-environment-shutdown.spec.ts tests/ssh-exec-backend.spec.ts tests/ssh-stream-ciphers.spec.ts tests/ssh-stream-race.e2e.ts tests/ssh-verifier.spec.ts tests/remote-sftp.spec.ts tests/remote-tools-switch.spec.ts tests/remote-personal.spec.ts tests/remote-personal-ops.spec.ts tests/remote-copy.spec.ts` —— 12 个文件、228 通过、1 跳过，exit 0；`pnpm docs:check` 与 `pnpm compat:check` 各 exit 0。以上命令均加 `pnpm_config_verify_deps_before_run=false` 执行：`node_modules/.modules.yaml` 记录的 `storeDir` 为仓库内 `.pnpm-store/v11`，而 pnpm 11 在本卷解析卷级默认 `/Volumes/西数2T/.pnpm-store/v11`，store 路径不一致使每次 `pnpm run` 前的依赖核验误判过期并要求清空 node_modules；lockfile 与已装树一致，属环境配置问题而非真实漂移。

探针已交付：`node --check scripts/probe-windows-ssh-initiator.mjs` exit 0；在 macOS 上执行 `node scripts/probe-windows-ssh-initiator.mjs` 按设计输出 BLOCKED、exit 2。

接续基准 HEAD `6e8957b`（本地与 `origin/feat/windows-ssh-initiator` 一致，工作区干净）。Windows x64 系统 Node `24.14.0` 不满足验收版本；改用校验官方 SHA-256 后隔离解压的 Node `24.22.3`，pnpm `11.25.0`，未改系统默认。在合规运行时取得以下原始输出（两条 stderr 均为空）：

```text
> node scripts/probe-windows-ssh-initiator.mjs windows-openssh
PASS: Windows OpenSSH config and disposable key tooling
> node scripts/probe-windows-ssh-initiator.mjs wsl-list
["Ubuntu","docker-desktop"]
```

两条均 exit 0：B 的系统客户端、配置解析与临时密钥工具 `PASS`；C 只读枚举 `PASS`。`docker-desktop` 不作为用户发行版，双发行版 stdio 探针 `NOT_RUN`；无隔离 SSH fixture，Helper 探针 `NOT_RUN`。未验证 Windows Electron Host；W0-B 与 W0-C 的完整门禁仍 `BLOCKED`，不能按探针放行。

## W1 阶段报告

基准 HEAD `013f59d`（W0 提交后，工作区干净）。变更面：

- 新增 `src/remote/initiator/contract.ts`：`SshInitiatorBackend`（`kind: 'posix' | 'windows-openssh' | 'wsl'` 与 `runtime`）和 `SshInitiatorRuntime`（`RemoteToolsManager & SshExecManager`，加 `capability`、可同步或异步的 `rebind`、`disposeAll`）。
- 新增 `src/remote/initiator/posix.ts`：`createPosixInitiator(options)` 返回 `{ kind: 'posix', runtime: new SshEnvironmentManager(options) }`。
- `src/remote/tools.ts`：mount 改为动态导入 `createPosixInitiator`；`onRemoteChange` 回调经 `Promise.resolve(rebind())` 捕获失败并 warn；初始 `rebind()` 返回非 undefined 时 await——POSIX rebind 同步返回，无新增 microtask。teardown 顺序不变。
- `src/remote/tools-registration.ts`：manager 探测面从 `Partial<SshEnvironmentManager>` 改为 `Partial<SshExecManager>`，守卫增加 `markStale` 函数检查；`SshEnvironmentManager` 类型导入删除。
- `src/remote/ssh-environment.ts`：新增 `SshHelperConnectionConfig` 接口与 `connectionFactory`/`sftpFactory` 选项（私有字段捕获）；`openSftpFresh` 走 `sftpFactory ?? SftpClient.connect`；`openFresh` 在分配 Cordis Context 前构造共享 `config`，以 `connectionFactory ?? dsh-ssh SshConnection` 挂载 `mount(ssh, config)`，其余四处 provider/registry mount 不变；eligibility、Helper 核验与 TLS 回退均未移动。
- `tests/ssh-environment.spec.ts`：首个共享 SFTP 用例改用 `sftpFactory` 注入并断言 `(connection, onLoss)` 精确一次调用；相邻同时复制用例保留 `SftpClient.connect` 静态 spy，覆盖生产默认路径。

验证（本机 macOS arm64 / Node 24.18.0 / pnpm 11.25.0，命令均加 `pnpm_config_verify_deps_before_run=false`，原因见 W0）：

- `pnpm exec vitest run tests/ssh-environment.spec.ts tests/ssh-environment-shutdown.spec.ts tests/ssh-exec-backend.spec.ts tests/remote-tools-switch.spec.ts tests/remote-tools.spec.ts tests/remote-registry.spec.ts tests/remote-copy.spec.ts tests/remote-journey.e2e.ts` —— 8 个文件、135 通过、1 跳过，exit 0。
- `pnpm typecheck` —— exit 0。
- `pnpm docs:check` —— exit 0。

W1 未跑跨平台矩阵与任何原生实测；Windows capability 保持关闭。正式 PASS 判定留待评审。

评审收口（自有评审 + 独立只读评审，生产代码无 High/Critical）：

- F1：rebind 回调可能同步抛错——`tools.ts` 的 `onRemoteChange` 回调改为 `try { void rebind()?.catch(rebindFailed) } catch { rebindFailed() }`，同步与异步失败统一 warn；POSIX 同步退役不变（不得挪入微任务）。
- F2：合同措辞——`initiator/contract.ts` 的 `rebind` 注释改为「Retire superseded access synchronously. Only the latest requested manifest's ACK can make a remote runtime usable.」，未来远端运行时自持代次 ACK，当前无异步后端。
- F3：探测面一致性——`tools-registration.ts` 守卫补 `openSftp` 函数检查，与 `SshExecManager` 完整对齐。
- F4：缺真实 Cordis/provider 合同测试——`tests/ssh-environment.spec.ts` 新增注入 `connectionFactory` 用例：身份核验后在官方 provider Context 挂载 `ctx.provide('ssh', ...)`，断言 factory 收到 `(environment, config, gate)` 及 `sandbox.confine`/`subprocess.spawn`/`assertOpen` 可用；`it.skipIf(officialGate.status !== 'eligible')` 在本机未跳过、实际执行。
- F5（范围说明，不处理）：`capability` 为合同暴露给未来实现；POSIX 仍依赖既有 gate，W2 前不接新 capability。

复测：`pnpm exec vitest run tests/ssh-environment.spec.ts tests/remote-tools-switch.spec.ts tests/remote-tools.spec.ts tests/static-ssh-imports.spec.ts` —— 4 个文件、47 通过、0 跳过，exit 0；`pnpm typecheck` exit 0；`pnpm docs:check` exit 0。独立评审结论：无 High/Critical。

## W2 阶段报告

基准 HEAD `4a4bd02`（W1 评审收口提交后，工作区干净）。本轮只做身份与 IPC 基础块，不含 settings/config 文件系统与本地 I/O；Windows capability 门禁未动。变更面：

- 新增 `src/remote/initiator/identity.ts`：`windowsInitiatorIdentitySchema`（`windows-openssh` 或 `wsl`{distribution,user}，zod discriminatedUnion + strict）与 `sameInitiatorIdentity`。控制字符检查用 `Array.from` + `charCodeAt` 写法（oxlint `no-control-regex` 规避，无语义差异）。
- `src/remote/manifest.ts`：`personalIdentity` schema 在 `credentialDigest` 后加 `initiator: windowsInitiatorIdentitySchema.optional()`；无 digest 代码改动——字段由既有 canonical JSON 覆盖，无默认值。
- `src/remote/personal/config.ts`：`toDeploymentManifest` 加第三可选参 `initiator?: WindowsInitiatorIdentity`，在投影的 `personalIdentity` 下 `...(initiator === undefined ? {} : { initiator })`；序列化/加载/路径不变，现有调用仍按两参调用。
- `src/remote/ssh-environment.ts`：新增 `initiator` 选项与 `requireInitiator(environment)`，`openFresh` 与 `openSftpFresh` 均在 `requireGate()` 之后、transport/身份核验之前调用——Helper 与 SFTP 在同 alias 不同身份下先拒（`initiator-mismatch`），不触及 `ssh -G`。rebind 与生产调用方未改。
- `src/authority/native.ts`：win32 `storeIdentity` 提取 `endpoint` 常量并返回 `remoteEndpoint: \`${endpoint}-remote\``；v1 管道名逐字节不变，POSIX `.r1.sock` 端点不变。win32 capability 关闭时无 remote-2 监听（远端面未启用）。
- 测试：`tests/ssh-environment.spec.ts` 在 refusal describe 加 initiator 失配用例（`initiator-mismatch`，`exec` 零调用）；`tests/remote-manifest.spec.ts` 加五身份变体（POSIX 缺席/B/C 发行版+用户/同名发行版异用户/Unicode 发行版名有意）摘要全异、`grantState` 仅同身份 `registered` 其余 `withheld`；`tests/remote-personal.spec.ts` 加 `toDeploymentManifest` 第三参投影用例（POSIX 两参投影断言传 `undefined`，旧断言未改）；`tests/remote-protocol.spec.ts` 首个 `hello binds store` 用例由 `nativeTest` 改 `it.skipIf(!availability.available)` 并断言 `remoteEndpoint !== endpoint`，其余时序/平台用例不变。

验证（本机 macOS arm64 / Node 24.18.0 / pnpm 11.25.0，均加 `pnpm_config_verify_deps_before_run=false`，原因见 W0）：`pnpm exec vitest run tests/remote-manifest.spec.ts tests/remote-personal.spec.ts tests/remote-protocol.spec.ts tests/remote-registry.spec.ts tests/ssh-environment.spec.ts` —— 5 个文件、115 通过、0 跳过，exit 0；`pnpm typecheck` exit 0；`pnpm docs:check` exit 0。

POSIX 旧行为未动：不传 `initiator` 时摘要与投影逐字节一致（选项缺席即 POSIX）；`storeIdentity` POSIX 路径与管道名不变。

首轮未验收（历史记录）：原生配置读写与 ACL/`getuid`/mode 保护、config 文件系统与本地 I/O、身份切换与多 Host 一致性均未实施；Windows 命名管道真实行为 `NOT_RUN`（本机无 Windows）。调查记录：`src/worktrees/native-io.ts` 已有 Win32 路径钉扎的读取句柄（卷级 metadata handle），但没有 Windows 稳定传输 `fileState` 与 no-replace 发布——本地 transfer gate 不移除。生产路径保持关闭。

接续关闭身份接线的评审发现：配置、操作前刷新与 owner hello 现在共同使用 `loadPersonalManifest` 的有效发起端身份，缓存不复用其他路径、后端、发行版或用户的投影。顶层及环境内摘要的分工见 [ADR-0052](../../decisions/ADR-0052-windows-ssh-initiator.md)。无身份时验证了旧空清单的序列化与原摘要；Windows 端额外锁定首次配置和后续刷新都不能发布清单。

共享 Registry 合同：同身份且文件未变不重启远端面；仅改变 owner 发起端后，旧 follower 不能重新握手或获取列表；不同发行版或用户均拒绝，匹配后恢复。该测试在显式指定的 Ubuntu 内以 POSIX IPC 运行，不证明 Win32 remote-2 命名管道或实际发起端运行时。命令及结果见[阶段交付报告](./2026-11-25-windows-ssh-initiator-report.md)。W2 仍缺原生 ACL 与配置读写、路径钉扎与 no-replace I/O、选择持久化与 Win32 多 Host／在飞代次验证；不开放 Windows capability。

## W3-B 阶段报告

基准 HEAD `cbf0a10`（W2 提交后，工作区干净）。本轮为受限开发切片：只交付 Windows OpenSSH 命令构造与官方 Helper 控制面校验，未做任何生产启用、TLS PSK、SFTP 或管理面声明。

变更面：

- 新增 `src/remote/initiator/windows-openssh.ts`：`windowsSystem32`（仅接受盘符 SystemRoot，拒绝 UNC/根相对/盘相对/NUL）、`windowsOpenSshCommands`（`System32/OpenSSH` 下 ssh/ssh-keygen/ssh-keyscan 三个绝对路径）、`windowsOpenSshHelperArgs`（alias 白名单、远端 node/helper 必须 POSIX 绝对路径、托管 config 必须盘符绝对路径；argv 为 `-T`、可选 `-F`、BatchMode/StrictHostKeyChecking/ForwardAgent=no/ClearAllForwardings/UpdateHostKeys=no/ConnectTimeout/ServerAlive，尾部 `<alias> '<node>' '--disable-sigusr1' '<helper>'` 单引号转义命令；无 `-M`/`-S` 复用、无 `/dev/null`）。
- `scripts/probe-windows-ssh-initiator.mjs`：`windows-openssh` 分支改用 `windowsOpenSshCommands()` 三个路径，并 `statSync` 拒绝缺失的 `ssh-keyscan`（不发起网络扫描）；新增 `windows-openssh-helper` 分支，恰 6 参 `[alias, node, helper, workspace, digest, platform]`，`probeHelper` 经官方 `SshRpcPeer` 发 `hello`（断言 hash/kind=`node-script`/platform/workspace/无 bootstrapHash）、`heartbeat`、`close` 并各自确认，`SSH_PROTOCOL_VERSION !== 3` 直接拒绝；`main` 改 async。探针 argv 只接受显式操作者输入，无生产挂载、不读取个人凭据。
- 新增 `tests/windows-ssh-initiator.spec.ts`：纯 argv 断言，5 用例，不启动进程、不访问网络。

验证（本机 macOS arm64 / Node 24.18.0 / pnpm 11.25.0，`pnpm_config_verify_deps_before_run=false`）：`pnpm exec vitest run tests/windows-ssh-initiator.spec.ts` —— 1 文件、5 通过，exit 0；`pnpm typecheck` exit 0；`pnpm exec oxlint` 两个新文件 exit 0；`node --check scripts/probe-windows-ssh-initiator.mjs` exit 0；`node scripts/probe-windows-ssh-initiator.mjs windows-openssh` 在 macOS 按设计输出 BLOCKED、exit 2。

可复制的原生验证命令（Windows Node/Electron，连接一次性测试设施）：

```
node scripts/probe-windows-ssh-initiator.mjs windows-openssh-helper <fixture-ssh-config> <alias> <remote-node> <remote-helper> <canonical-workspace> <entry-sha256> <linux|darwin>
```

`<fixture-ssh-config>` 为显式绝对路径的测试专用配置：只含测试 key 与 known_hosts，不 Include 其他文件、不复用用户主配置；探针追加 `IdentityAgent=none`/`IdentitiesOnly=yes`/`IdentityFile=none` 关闭 agent 与默认身份，并在 spawn 前 `statSync` 校验 `ssh.exe` 存在。结束后清理是有界的（peer.close + stdin/stdout destroy + SIGTERM 子进程 + 5s 未关闭即 unref 拒绝），不证明远端所有进程已退出。

评审修复（W3-B 范围，已合入工作区）：`windows-openssh-helper` 参数由 6 增至 7（新增 fixture 配置，经 `windowsOpenSshHelperArgs` 盘符校验后作为 `-F` 传递）；spawn 追加身份固定选项；`SystemRoot` 校验追加 `.`/`..` 段拒绝。剩余 `NOT_RUN` 原生缺口不变。

接续的原生命令探针见 W0。Windows Node 运行已有 TLS PSK 兼容测试通过，包含本机回环握手；这不是经 OpenSSH 的 Helper 流测试。隔离目标的官方 Helper、SSH 流转发、Node/Electron 间的 PSK、SFTP 扩展、Askpass、配置同源和异常清理仍未验收；生产路径和 capability 保持关闭。

## W3-C 阶段报告

基准 HEAD `4e3c9e7`（W3-B 提交后，工作区干净）。本轮为受限开发切片：只做 WSL 发行版发现与所选发行版内启动校验，不做 WSL 版本验证、依赖部署或 Bridge 实现。

变更面：

- 新增 `src/remote/initiator/wsl.ts`：`wslExecutable`（复用 `windowsSystem32` 盘符校验）；`parseWslDistributions`（只解析成功的 `--list --quiet` stdout：BOM 或无 BOM 的 UTF-16LE 行分隔探测、fatal 解码，逐名校验非空/≤256/无首尾空白/无前导 `-`/无控制字符、无重复，畸形即抛错，不猜本地化文本）；`wslExecArgs`（选中项必须在已安装清单内，否则拒绝并返回 `--distribution <name> --exec <command...>`）。
- `scripts/probe-windows-ssh-initiator.mjs`：移除顶层 `SystemRoot`/`system32` 局部与 `isAbsolute`（helper 各自校验路径）；新增 `wsl-list` 分支输出 `JSON.stringify(names)`，不启动发行版；`wsl` 分支先 `--list --quiet` 得已安装清单、逐个校验所选发行版存在后才在其内执行——`node -e` 打印 JSON 核验 `platform=linux`、版本、POSIX `executable`、非空默认 `user` 与 `/` 起始 `home`，再 `ssh -V`，最后用 `runtime.executable`（而非裸 `node`）做 65537 字节 stdin/stdout 二进制与 EOF 校验。
- `tests/windows-ssh-initiator.spec.ts`：新增 5 用例覆盖 `wslExecutable` 路径、UTF-8/无 BOM UTF-16LE/带 BOM UTF-16LE 三种编码等价解析、空缓冲、畸形清单（首尾空白/重复/NUL/非法 UTF-8）、`wslExecArgs` 精确 argv 与缺席/大小写/前导 `-` 注入拒绝（伪造清单含 `--exec` 也不放行）。纯 fixture，不起进程、不访问网络。

验证（本机 macOS arm64 / Node 24.18.0 / pnpm 11.25.0，`pnpm_config_verify_deps_before_run=false`）：`pnpm exec vitest run tests/windows-ssh-initiator.spec.ts` —— 1 文件、10 通过，exit 0；`pnpm typecheck` exit 0；`pnpm exec oxlint` 新文件 exit 0；`node --check scripts/probe-windows-ssh-initiator.mjs` exit 0；`node scripts/probe-windows-ssh-initiator.mjs wsl-list` 与 `… wsl Ubuntu Debian` 在 macOS 均按设计 BLOCKED、exit 2。

原生验证命令（Windows Node/Electron）：`node scripts/probe-windows-ssh-initiator.mjs wsl-list` 只读枚举；`node scripts/probe-windows-ssh-initiator.mjs wsl "<发行版 A>" "<发行版 B>"` 为两发行版证明（各校验 Linux Node 可执行路径、默认用户/home、OpenSSH、二进制 stdio 与 EOF）。

评审修复（W3-C 范围，已合入工作区）：发行版名校验改为共享 `isWslDistributionName`（`identity.ts` 导出，wsl.ts 两个校验点与持久化 schema 同一条规则，schema 侧同样拒绝前导 `-`）；UTF-16LE 探测追加"奇数索引高字节为 0"判据，使无换行的单条 UTF-16LE 清单（如仅 `Ubuntu`）也能识别，不接受非法编码；新增对应 fixture 用例。剩余 `NOT_RUN` 原生缺口不变。

接续的原生枚举见 W0。现有环境只有一个合格发行版，双发行版 stdio 探针 `NOT_RUN`；WSL 版本判定、产品运行时部署、manifest ACK、Bridge、管理与工具、异常清理与代次隔离均未验收或未实现。Ubuntu 只用于 POSIX 合同测试；不计为 Bridge 或双发行版证据。生产路径和 capability 保持关闭。

## W4 阶段报告

本机验证与制品证据、评审闭环及发布决定汇总于[阶段交付报告](./2026-11-25-windows-ssh-initiator-report.md)。支持平台、DSH 版本合同与 CHANGELOG 均未改；Windows capability 门禁保持关闭。

## 恢复与验收

从本计划、阶段提交及证据继续；接续前核对 `git status --short --branch`、HEAD 和对应 Exit Gate。真实目标使用授权的一次性测试设施，不读取或复用个人 SSH 凭据。不能验证的后端继续关闭；不阻塞其他不依赖该证据的阶段。
