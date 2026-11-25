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
| W2 | BLOCKED（身份与 IPC 基础完成；原生配置、文件 I/O、切换未验收） | W1 合同稳定；Windows 共用信任边界明确 | 配置及本地文件授权/发布、后端身份、切换及多 Host 一致性用例通过；未验证 capability 关闭 |
| W3-B | NOT_STARTED | W1/W2 可用；W0-B 已验证或明确限定为不可发布的开发验证 | 严格主机验证、官方 Helper RPC、TLS PSK、SFTP、管理和清理通过 Windows Node/Electron 实机与独立版本门禁 |
| W3-C | NOT_STARTED | W1/W2 可用；在所选真实发行版上验证 stdio/依赖/退出 | 显式多发行版选择与初始化、manifest ACK、管理与工具、异常清理及代次隔离通过 |
| W4 | NOT_STARTED | W1/W2 可用；分别确认 B/C 的可验收项 | 现有 SSH Settings/i18n，完整用户旅程，真实矩阵、安装制品、回归、评审及发布决策 |

各阶段记录基准 HEAD、变更面、验证环境、命令与退出码、独立评审/修复、下一阶段条件。未通过项目不标 PASS；阶段形成独立提交或记录未提交阻塞。发布能力不能由测试环境变量或默认回退打开。

## 测试矩阵与证据

本机 macOS arm64 / Node 24.18.0 / pnpm 11.25.0。真实 Windows 尚无本地执行环境。仓库开启 GitHub-hosted Windows CI；当前无已注册 self-hosted runner。Hosted runner 不等同于真实 WSL2 双发行版或 Windows Electron 环境，不能以平台模拟替代。

L1–L3：现有 `ssh-*`、`remote-*` 合同、Registry/多 Host、传输并发与客户端 Settings；L4–L5：Linux/macOS POSIX 对照、Windows OpenSSH 与 WSL 各自 Node/Electron 至 Linux，Windows B/C 至 macOS、两发行版同名 alias、Windows 文件 ACL/NTFS 和进程退出；L6：typecheck、lint、build、兼容、许可、文档、pack 和 packed smoke。未实跑的矩阵格标 `NOT_RUN` / `BLOCKED`。

原生先决条件探针（无网络、无安装）：在 Windows 执行 `node scripts/probe-windows-ssh-initiator.mjs windows-openssh`，以及 `node scripts/probe-windows-ssh-initiator.mjs wsl "<发行版 A>" "<发行版 B>"`。只启动显式列出的发行版。该脚本不验证 sshd、Helper、PSK 或托管凭据。

## W0 阶段报告

基准 HEAD `287b39a73b407736b0fc20afc0bfab75283d4d97`（分支 `feat/windows-ssh-initiator`，工作区干净）。W0-A 上游发包合同 PASS：对 `@deepseek-ai/dsh-{ssh,fs-ssh,subprocess-ssh,sandbox-ssh}` 的 `0.2.2-rc.5` 与 `0.2.3-alpha.2` 各执行 `npm pack`，四次 `diff -qr <rc.5>/package/src <alpha.2>/package/src` 全部 exit 0（四包 `src` 树逐字节一致）；合同结论固化于 [ADR-0052](../../decisions/ADR-0052-windows-ssh-initiator.md)。

本机 macOS arm64 / Node 24.18.0 / pnpm 11.25.0 已跑：`pnpm exec vitest run tests/ssh-compat.spec.ts tests/ssh-environment.spec.ts tests/ssh-environment-shutdown.spec.ts tests/ssh-exec-backend.spec.ts tests/ssh-stream-ciphers.spec.ts tests/ssh-stream-race.e2e.ts tests/ssh-verifier.spec.ts tests/remote-sftp.spec.ts tests/remote-tools-switch.spec.ts tests/remote-personal.spec.ts tests/remote-personal-ops.spec.ts tests/remote-copy.spec.ts` —— 12 个文件、228 通过、1 跳过，exit 0；`pnpm docs:check` 与 `pnpm compat:check` 各 exit 0。以上命令均加 `pnpm_config_verify_deps_before_run=false` 执行：`node_modules/.modules.yaml` 记录的 `storeDir` 为仓库内 `.pnpm-store/v11`，而 pnpm 11 在本卷解析卷级默认 `/Volumes/西数2T/.pnpm-store/v11`，store 路径不一致使每次 `pnpm run` 前的依赖核验误判过期并要求清空 node_modules；lockfile 与已装树一致，属环境配置问题而非真实漂移。

探针已交付：`node --check scripts/probe-windows-ssh-initiator.mjs` exit 0；在 macOS 上执行 `node scripts/probe-windows-ssh-initiator.mjs` 按设计输出 BLOCKED、exit 2。

原生实测未执行，维持关闭：真实 Windows OpenSSH（`ssh -V` / `-G` / keygen）、Windows Node/Electron 上的 TLS/PSK、真实 WSL 发行版 stdio/部署/回收与双发行版车道均 `BLOCKED`/`NOT_RUN`。判定：B BLOCKED；C BLOCKED。W1/W2 中不依赖 Windows 实机的工作可以继续，Windows capability 门禁保持关闭。

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

- 新增 `src/remote/initiator/identity.ts`：`windowsInitiatorIdentitySchema`（`windows-openssh` 或 `wsl`{distribution,user}，zod discriminatedUnion + strict）与 `sameInitiatorIdentity`。控制字符检查用 `Array.from` + `charCodeAt` 写法（oxlint `no-control-regex` 规避，与 lead 备选一致，无语义差异）。
- `src/remote/manifest.ts`：`personalIdentity` schema 在 `credentialDigest` 后加 `initiator: windowsInitiatorIdentitySchema.optional()`；无 digest 代码改动——字段由既有 canonical JSON 覆盖，无默认值。
- `src/remote/personal/config.ts`：`toDeploymentManifest` 加第三可选参 `initiator?: WindowsInitiatorIdentity`，在投影的 `personalIdentity` 下 `...(initiator === undefined ? {} : { initiator })`；序列化/加载/路径不变，现有调用仍按两参调用。
- `src/remote/ssh-environment.ts`：新增 `initiator` 选项与 `requireInitiator(environment)`，`openFresh` 与 `openSftpFresh` 均在 `requireGate()` 之后、transport/身份核验之前调用——Helper 与 SFTP 在同 alias 不同身份下先拒（`initiator-mismatch`），不触及 `ssh -G`。rebind 与生产调用方未改。
- `src/authority/native.ts`：win32 `storeIdentity` 提取 `endpoint` 常量并返回 `remoteEndpoint: \`${endpoint}-remote\``；v1 管道名逐字节不变，POSIX `.r1.sock` 端点不变。win32 capability 关闭时无 remote-2 监听（远端面未启用）。
- 测试：`tests/ssh-environment.spec.ts` 在 refusal describe 加 initiator 失配用例（`initiator-mismatch`，`exec` 零调用）；`tests/remote-manifest.spec.ts` 加五身份变体（POSIX 缺席/B/C 发行版+用户/同名发行版异用户/Unicode 发行版名有意）摘要全异、`grantState` 仅同身份 `registered` 其余 `withheld`；`tests/remote-personal.spec.ts` 加 `toDeploymentManifest` 第三参投影用例（POSIX 两参投影断言传 `undefined`，旧断言未改）；`tests/remote-protocol.spec.ts` 首个 `hello binds store` 用例由 `nativeTest` 改 `it.skipIf(!availability.available)` 并断言 `remoteEndpoint !== endpoint`，其余时序/平台用例不变。

验证（本机 macOS arm64 / Node 24.18.0 / pnpm 11.25.0，均加 `pnpm_config_verify_deps_before_run=false`，原因见 W0）：`pnpm exec vitest run tests/remote-manifest.spec.ts tests/remote-personal.spec.ts tests/remote-protocol.spec.ts tests/remote-registry.spec.ts tests/ssh-environment.spec.ts` —— 5 个文件、115 通过、0 跳过，exit 0；`pnpm typecheck` exit 0；`pnpm docs:check` exit 0。

POSIX 旧行为未动：不传 `initiator` 时摘要与投影逐字节一致（选项缺席即 POSIX）；`storeIdentity` POSIX 路径与管道名不变。

未验收/未实现（W2 维持关闭）：原生配置读写与 ACL/`getuid`/mode 保护、config 文件系统与本地 I/O、身份切换与多 Host 一致性均未实施；Windows 命名管道真实行为 `NOT_RUN`（本机无 Windows）。调查记录：`src/worktrees/native-io.ts` 已有 Win32 路径钉扎的读取句柄（卷级 metadata handle），但没有 Windows 稳定传输 `fileState` 与 no-replace 发布——本地 transfer gate 不移除。生产路径保持关闭。

## 恢复与验收

从本计划、阶段提交及证据继续；接续前核对 `git status --short --branch`、HEAD 和对应 Exit Gate。真实目标使用授权的一次性测试设施，不读取或复用个人 SSH 凭据。不能验证的后端继续关闭；不阻塞其他不依赖该证据的阶段。
