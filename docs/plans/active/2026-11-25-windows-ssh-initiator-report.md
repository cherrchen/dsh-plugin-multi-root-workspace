# Windows SSH 发起端阶段交付报告

## 1. 结论

此分支完成 POSIX 共用接缝与有序准入，并补齐控制面的发起端身份投影（配置、刷新、owner hello 与共享摘要）和 B/C 开发探针；没有交付完整原生 Windows SSH 支持。B 与 C 都未由产品入口启用。没有 Windows Node、Electron、Rivetdeck、WSL1、WSL2 或 Windows OS 版本的新增支持声明；远端 Windows 仍不支持。继续按[专项计划](./2026-11-25-windows-ssh-initiator.md)恢复，设计仍为 [Proposed ADR-0052](../../decisions/ADR-0052-windows-ssh-initiator.md)。

## 2. 架构与实际范围

现有 POSIX `SshEnvironmentManager` 挂入共享 runtime 合同，仍复用官方 Provider、连接、Helper 检查与 SFTP。新增 `connectionFactory`、`sftpFactory` 接缝；发起端身份经 `RemoteLiveConfig.initiator` 进入共享控制面，空清单也携带同一摘要，字段分工见 [ADR-0052](../../decisions/ADR-0052-windows-ssh-initiator.md)；旧 POSIX manifest 不含新字段，不迁移授权。Windows 独立命名的 remote-2 IPC 端点仅是基础，未开放 Windows 控制面。未复制 Registry、远端工具或沙箱，未修改上游包。

B 提供 System32 可执行路径和严格、无 ControlMaster 参数的 Helper RPC 探针；不是 Windows SSH 服务适配器。C 提供无默认回退的 WSL 枚举和指定发行版 stdio 探针；不是生产 Bridge。两个探针只随检出源码使用，不进入 npm 制品。

## 3. 阶段交付

| 阶段 | 状态 | 提交 | 证据与剩余门禁 |
| --- | --- | --- | --- |
| W0 | BLOCKED | `013f59d` | 两版上游发包源码比较完成；接续原生探针原始输出见[计划 W0](./2026-11-25-windows-ssh-initiator.md#w0-阶段报告)；完整门禁未过 |
| W1 | PASS（共用接缝、本机回归） | `4a4bd02` | 真实 Cordis/provider 挂载合同、SFTP 注入、关闭/准入用例；非全平台矩阵 |
| W2 | BLOCKED | `cbf0a10` | 发起端身份投影与 POSIX IPC owner–follower 合同通过；原生 ACL/文件 I/O、选择持久化、切换及 Win32 多 Host 复验未完成 |
| W3-B | BLOCKED | `4e3c9e7`、`246577e` 的评审修订 | 原生命令探针与 Windows Node TLS 本机回环通过；缺生产连接、经 OpenSSH Helper/Relay、SFTP 与 Personal SSH 适配 |
| W3-C | BLOCKED | `246577e` | 原生只读枚举与精确选择校验通过；缺双发行版、发行版内依赖与 Bridge 部署、协议/ACK、管理、重连和清理 |
| W4 | BLOCKED | `b7816f8`、本报告提交 | 接续 Windows 本机窄门禁与 POSIX 合同复验；Windows Settings、端到端矩阵与正式放行未完成 |

## 4. 实际测试与退出验收

macOS arm64，DSH `0.2.3-alpha.2`，隔离 Node `24.22.3`，pnpm `11.25.0`；`pnpm_config_verify_deps_before_run=false` 仅修正本机 store 前置核验（原因见专项计划 W0）。以下 W4 广扫基于 `4e3c9e7` 加当时 W3-C 未提交变更；后续评审修订及 locale 使用定向复验，不把旧全量结果改为全绿。

| 项目 | 结果 |
| --- | --- |
| `pnpm compat:check` / `lint` / `typecheck` / `build` / `licenses:check` / `docs:check` | PASS，各 exit 0 |
| `pnpm test` | FAIL，exit 1；2759 通过、134 跳过、1 失败，170 文件通过、8 跳过、1 失败；失败原因是新增错误码缺翻译，见评审 |
| 修正后 `pnpm exec vitest run tests/locale-parity.spec.ts tests/windows-ssh-initiator.spec.ts tests/remote-manifest.spec.ts tests/remote-personal.spec.ts tests/ssh-environment.spec.ts` | PASS，5 文件 114 通过、0 跳过，exit 0；同一修正树 lint、typecheck、探针语法、docs:check exit 0 |
| `pnpm pack:check` / `pnpm smoke:packed` | PASS，均 exit 0；实际 tarball 安装 battery 136 项通过，未验证不存在的 Windows Bridge 产物 |
| `pnpm smoke:compose` / `pnpm smoke:behavior` | PASS，均 exit 0，分别 58 / 137 项通过 |
| 真实 SSH 用户旅程、Linux/macOS 完整原生回归 | NOT_RUN；本机测试/冒烟不能计为跨平台或真实 SSH E2E |
| Windows Node/Electron × B/C、Windows 到 Linux/macOS、Windows ACL/NTFS、双发行版 WSL、多 Host 切换 | BLOCKED / NOT_RUN；本机为 macOS，仓库无 self-hosted runner，托管 CI 现有 Windows 车道未在此分支执行 |

最终检查：架构 A 只满足共用 POSIX 接缝与 out-of-tree 约束；B/C、Windows 远端功能 D 和发布质量 E 的实机项均未通过。文档交付覆盖 ADR、计划、阶段报告和验收状态，不发布未存在的 Windows 设置操作指南。支持平台、DSH 版本合同和双语 CHANGELOG（只记录已发布内容）未改；未新增模式或放宽 capability。

### 接续验证（基准 `6e8957b`）

Windows x64 原生进程加显式指定的 Ubuntu 发行版内 Linux x64 scratch（`wsl.exe --distribution Ubuntu --exec`，不作默认发行版或 Bridge 证据）；Node `24.22.3`（官方压缩包，SHA-256 校验后隔离解压），pnpm `11.25.0`。Linux 侧 `pnpm install --frozen-lockfile` 通过供应链核验与构建脚本；未改系统默认 Node，未绕过 lockfile 或前置核验。

| 项目 | 结果 |
| --- | --- |
| Windows OpenSSH 命令探针 / WSL 只读枚举 | PASS，各 exit 0；原始输出见[计划 W0](./2026-11-25-windows-ssh-initiator.md#w0-阶段报告) |
| Windows unit / contract | PASS：`pnpm exec vitest run tests/remote-manifest.spec.ts tests/remote-personal-stat-cache.spec.ts tests/remote-personal-ops.spec.ts tests/remote-registry.spec.ts tests/ssh-environment.spec.ts` exit 0，4 文件通过、1 跳过，64 通过、95 跳过；三个触及文件复跑 exit 0（46 通过、81 跳过）。win32 上跳过项不算通过。`pnpm typecheck` exit 0 |
| POSIX contract / Registry owner–follower integration | PASS：`pnpm exec vitest run tests/remote-personal-ops.spec.ts tests/remote-personal-stat-cache.spec.ts tests/remote-manifest.spec.ts` exit 0，126 通过、1 跳过（win32 专属用例按设计跳过）；Linux/macOS 完整原生矩阵未跑 |
| Windows Node TLS PSK 合同与本机回环 | PASS：`pnpm exec vitest run tests/ssh-stream-ciphers.spec.ts` exit 0，13 通过；非经 OpenSSH 的 Relay，非 Electron |
| compat / lint / build / licenses / pack / packed smoke / docs | PASS，各 exit 0；`pnpm smoke:packed` 122 通过、1 跳过（MSIX pwsh 无可用 ACL kernel runner）；非 Windows SSH 制品验证 |
| Windows 配置 ACL / NTFS no-replace / Windows remote-2 / 双发行版 WSL stdio / Electron / Helper / 真实 SSH E2E | NOT_RUN：ACL、no-replace、Win32 remote-2 尚未完成实现或验收；双发行版、Electron、Helper 与真实 SSH 缺对应环境，见 §6。未复跑全量 Windows 套件 |

scratch 首轮未设 `DSH_TEST_FIXTURE_PARENT`，11 个 fixture 环境准备失败（不计入 PASS）；改设合格的 `/var/tmp` fixture 路径后同批全部通过。pnpm lockfile 与前置核验均未绕过。

## 5. 评审

W1 独立评审的同步异常、ACK 合同、结构检查和官方挂载覆盖已处理，见 `4a4bd02` 和计划复验。W2/W3 独立评审没有发现打开现有生产门禁的回归；落实统一发行版名称校验、UTF-16LE 单行、SystemRoot 点分量拒绝、显式 fixture SSH 配置与关闭上界（`246577e`）。中等严重度遗留发现已关闭：有效发起端身份现贯穿 `RemoteControlPlane` 配置、操作前刷新、owner hello 与 `loadPersonalManifest` 的加载/缓存键，owner 与 follower 对同一摘要达成一致；同时关闭 Windows 刷新在平台延期状态下发布空清单的泄漏（configure 后 refresh 直接 `disabled`，含 win32 用例断言）。W4 全量套件发现缺 `initiator-mismatch` 文案，`b7816f8` 补八语言，定向复验通过；修正后未重复全量。

## 6. 恢复与限制

三个实物阻塞：第二个用户 WSL 发行版（C 的双发行版证明）、支持版本的 Windows Electron Host（B/C 的 Electron 门禁）、隔离 SSH fixture（Helper/Relay 实测）。W2 剩余原生 ACL 与配置读写、路径钉扎与 no-replace 文件 I/O、选择持久化与 Win32 多 Host／在飞代次；W3-B 剩余经 OpenSSH 的 Helper/Relay/PSK/Askpass 与 SFTP 扩展；W3-C 剩余 WSL 版本判定、精确 Linux 依赖树、Bridge 与 manifest ACK、异常清理。补齐缺失环境后再运行尚未执行的探针。Helper 实测只使用隔离 SSH 服务和测试配置，不复用个人密钥。完成上述门禁后再做 Settings、双发行版和 Node/Electron 全旅程。无运行条件的测试维持 `NOT_RUN`，不得以 POSIX 模拟替代。

## 7. 发布决定

- POSIX Regression：BLOCKED（此次 POSIX 定向合同通过，Linux/macOS 完整原生回归未跑）。
- Windows Native OpenSSH：BLOCKED（命令探针与 Node 本机 TLS 通过；Helper/Relay、Electron 及 E2E 尚未实测）。
- WSL Bridge：BLOCKED（只读枚举通过；双发行版及 Bridge 未验收）。
- Overall：BLOCKED；不满足本功能合并或正式发布条件。

## 8. Git 交付

基线 `287b39a73b407736b0fc20afc0bfab75283d4d97`，分支 `feat/windows-ssh-initiator`，接续前最后一个代码提交 `b7816f8`。接续从已推送到 origin 的分支提交 `6e8957b` 开始；本次 W2 代码、测试与证据同一提交，提交主题 `feat(ssh): bind the effective initiator to the remote control plane`。本轮未执行 push、PR、合并、tag、版本提升、npm 发布或正式 Release。未追踪构建和环境资料未列入提交。
