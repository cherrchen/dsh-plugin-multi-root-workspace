# Windows SSH 发起端阶段交付报告

## 1. 结论

此分支完成 POSIX 共用接缝、发起端身份与有序准入的部分基础，以及 B/C 的开发探针；没有交付完整原生 Windows SSH 支持。B 与 C 都未由产品入口启用。没有 Windows Node、Electron、Rivetdeck、WSL1、WSL2 或 Windows OS 版本的新增支持声明；远端 Windows 仍不支持。继续按[专项计划](./2026-11-25-windows-ssh-initiator.md)恢复，设计仍为 [Proposed ADR-0052](../../decisions/ADR-0052-windows-ssh-initiator.md)。

## 2. 架构与实际范围

现有 POSIX `SshEnvironmentManager` 挂入共享 runtime 合同，仍复用官方 Provider、连接、Helper 检查与 SFTP。新增 `connectionFactory`、`sftpFactory` 接缝和发起端身份投影；旧 POSIX manifest 不含新字段，不迁移授权。Windows 独立命名的 remote-2 IPC 端点仅是基础，未开放 Windows 控制面。未复制 Registry、远端工具或沙箱，未修改上游包。

B 提供 System32 可执行路径和严格、无 ControlMaster 参数的 Helper RPC 探针；不是 Windows SSH 服务适配器。C 提供无默认回退的 WSL 枚举和指定发行版 stdio 探针；不是生产 Bridge。两个探针只随检出源码使用，不进入 npm 制品。

## 3. 阶段交付

| 阶段 | 状态 | 提交 | 证据与剩余门禁 |
| --- | --- | --- | --- |
| W0 | BLOCKED | `013f59d` | 两版上游发包源码比较完成；Windows 实机泊位未执行 |
| W1 | PASS（共用接缝、本机回归） | `4a4bd02` | 真实 Cordis/provider 挂载合同、SFTP 注入、关闭/准入用例；非全平台矩阵 |
| W2 | BLOCKED | `cbf0a10` | 缓存和授权摘要识别不同发起端；缺权限/文件系统、选择持久化、切换及实际多 Host 复验 |
| W3-B | BLOCKED | `4e3c9e7`、`246577e` 的评审修订 | 命令、安全 argv 与官方 RPC 探针；缺生产连接、Relay/TLS、SFTP 与 Personal SSH 适配 |
| W3-C | BLOCKED | `246577e` | 枚举、精确选择与 stdio 探针；缺发行版内依赖与 Bridge 部署、协议/ACK、管理、重连和清理 |
| W4 | BLOCKED | `b7816f8`、本报告提交 | 本机回归、语言修复与打包证据；Windows Settings、端到端矩阵与正式放行未完成 |

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

## 5. 评审

W1 独立评审的同步异常、ACK 合同、结构检查和官方挂载覆盖已处理，见 `4a4bd02` 和计划复验。W2/W3 独立评审没有发现打开现有生产门禁的回归；落实统一发行版名称校验、UTF-16LE 单行、SystemRoot 点分量拒绝、显式 fixture SSH 配置与关闭上界（`246577e`）。中等严重度开放项：有效发起端身份尚未贯穿 `RemoteControlPlane` 和 `loadPersonalManifest` 的加载/缓存键，不可在各进程各自后处理 manifest。W4 全量套件发现缺 `initiator-mismatch` 文案，`b7816f8` 补八语言，定向复验通过；修正后未重复全量。

## 6. 恢复与限制

先在授权的真实 Windows 环境运行 B/C 探针；使用隔离测试 SSH 服务和测试配置，不复用个人密钥。随后按 W2/W3 门禁验证 ACL、no-replace、owner/follower digest 和代次，验证 B 的 Helper、Relay/PSK/Askpass、C 的精确 Linux 依赖树、发行版选择及退出，再完成 Settings、双发行版和 Node/Electron 全旅程。无运行条件的测试维持 `NOT_RUN`，不得以 POSIX 模拟替代。

## 7. 发布决定

- POSIX Regression：BLOCKED（本机定向/冒烟通过；完整矩阵未复跑）。
- Windows Native OpenSSH：BLOCKED。
- WSL Bridge：BLOCKED。
- Overall：BLOCKED；不满足本功能合并或正式发布条件。

## 8. Git 交付

基线 `287b39a73b407736b0fc20afc0bfab75283d4d97`，分支 `feat/windows-ssh-initiator`，最后一个代码提交 `b7816f8`；最终交付 HEAD 为包含本报告的后续文档提交。仅本地阶段提交，无 push、PR、合并、tag、版本提升、npm 发布或正式 Release。未追踪构建和环境资料未列入提交。
