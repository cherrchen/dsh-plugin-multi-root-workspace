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
| W1 | NOT_STARTED | 官方 provider 的实际接入合同明确；记录 POSIX 基线 | 通过共享运行时接缝运行原有 POSIX 用例；缺包与 Windows 门禁不改；无 Root 迁移 |
| W2 | NOT_STARTED | W1 合同稳定；Windows 共用信任边界明确 | 配置及本地文件授权/发布、后端身份、切换及多 Host 一致性用例通过；未验证 capability 关闭 |
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

## 恢复与验收

从本计划、阶段提交及证据继续；接续前核对 `git status --short --branch`、HEAD 和对应 Exit Gate。真实目标使用授权的一次性测试设施，不读取或复用个人 SSH 凭据。不能验证的后端继续关闭；不阻塞其他不依赖该证据的阶段。
