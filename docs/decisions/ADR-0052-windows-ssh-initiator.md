# ADR-0052：原生 Windows Host 的 SSH 发起端

**状态：Proposed（2026-11-25）**。本决定不开放 Windows capability；实机及分阶段验收见[开发计划](../plans/active/2026-11-25-windows-ssh-initiator.md)。

## 背景与决定

原生 Windows Host 需要访问 Linux/macOS SSH 环境。保留 Linux/macOS Host 原有 POSIX 实现及授权格式；Windows 只允许显式配置其一：使用 Windows OpenSSH（B，不依赖 WSL），或使用所选发行版的 WSL Bridge（C，不迁移 Host）。两者独立验证，失败不自动改用另一后端或发行版。Windows 目标与 Helper 不在范围内。

Host 独占 Registry、manifest、短事务准入和本地路径授权；发起端提供受管 SSH 连接、配置、凭据、Helper 及 SFTP。仅 Personal SSH，不证明 OS 级凭据隔离。严格主机验证、账户和 Helper 核验、现有沙箱与 no-replace 不变。WSL 不开额外网络监听，也不继承 ADR-0048 的 broker UID、部署证明或认证语义。

## 上游发包观察（W0-A）

在 `0.2.2-rc.5` 与 `0.2.3-alpha.2` 的八个 npm tarball 上，四个 SSH 包各自的 `src` 树逐字节一致，发布的 `package.json` 依赖和 Cordis 代际并不相同。`@deepseek-ai/dsh` 的 `engines.node` 分别为 `>=24.9.0` 和 `^24.22.3 || >=26.13.1`。只从 Host 锚定的同版本依赖树加载 Provider，保留 Cordis、Provider 类与 RPC 错误对象身份；不要依赖构建输出的 hash 文件名。

- `@deepseek-ai/dsh-ssh` 的 `.` 导出 `SshConnection`；`/protocol` 导出 `SshRpcPeer`、`SSH_PROTOCOL_VERSION = 3`，复用 4 字节 BE 长度前缀 + JSON 严格 schema、request/result/error/cancel 帧；`/schemas` 导出 `helloSchema`、`streamEndpointSchema` 和 `preparedSchema`。`/helper` 是官方入口，不是 Host connection API。
- `dsh-fs-ssh` 注入 `ssh` 与 `sandboxPolicy`；`dsh-subprocess-ssh`、`dsh-sandbox-ssh` 注入 `ssh`。调用面为 `request(method, params, schema, signal?, wait?)`、`connectStream(endpoint, signal?)`；管理器另需要 `ready`、`assertOpen` 和 fiber disposal。`ptcLaunch` 是上游 getter，这三个 provider 不调用它，本计划不添加远端 PTC。
- node-script 启动为已核验 Node + `--disable-sigusr1` + Helper。上游 `hello` 输入 `protocol/workspace/leaseMs/bootstrapPath?`，严格回包包含协议、hash、kind、platform、nodeVersion、executable、root、workspace 与可选 bootstrapHash。上游校验 Helper hash、launch kind 和配对的 bootstrapHash；适配层还须把 workspace 与预期绑定。默认 30s lease、约每 10s 心跳，心跳失败、stdio EOF 或退出须撤销该代次；成功 `close` / 远端 lease 才能得出对应清理结论，不自动重放。
- 流端点只有 POSIX `path` 和 64 位十六进制 `capability`（256 bit）。Helper 用 TLS 1.2、PSK identity `dsh-stream`、`PSK-AES256-GCM-SHA384`；本插件的回退见 [ADR-0051](./ADR-0051-ssh-stream-psk-boringssl-fallback.md)。stream-security 模块没有独立公开导出；把最少的客户端行为锁在精确版本合同，不能转为无认证的转发。

## 实现条件与风险

B 候选：不使用 ControlMaster 的官方 stdio RPC，另开 SSH 会话，以已验证的远端 Node 转发当前 Helper 的 Unix socket；不把 PSK 放进命令行。须实测双向 EOF、资源回收、Node/Electron PSK、Windows Askpass，以及同一 SSH 配置贯穿测试、核验和运行。SFTP hardlink/fsync 由远端 server 宣告；B 只载运现有 SFTP 协议。

C 候选：用户显式初始化后，在所选发行版的 Linux 文件系统中部署精确锁定的 Linux Runtime。拒绝直接共享 Windows pnpm 树：包源码相同不代表依赖可跨 OS；lockfile 可见 `dsh-subprocess-local` 含 `node-pty` 原生依赖，另有平台 optional 包及链接布局风险。复用官方 POSIX Runtime，manifest 只在 ACK 后可用，二进制回到 Host 授权的 Windows 文件句柄。Linux 依赖安装与 WSL2 双发行版实际加载/回收仍待验证；不承诺 WSL1 或默认安装系统软件。

有效身份须区分 B、C 发行版与可选 Linux 用户；POSIX 缺省保留旧摘要。切换停止新准入并退役旧代次；不迁移 SSH 配置、密钥或 known_hosts；登记记录保留，新上下文不得使用旧授权。后端选择的权威必须与 owner/follower 看到的 manifest 摘要绑定，不以本地 UI 状态替代。

W2 已实现身份投影和 Win32 remote-2 命名管道端点命名；尚未开放 Windows 远端控制面。未选择 Windows 时不写身份字段，不改变 POSIX 摘要。

## 相关

[ADR-0030](./ADR-0030-environment-and-root-identity.md)、[ADR-0032](./ADR-0032-upstream-ssh-backend.md)、[ADR-0033](./ADR-0033-remote-command-and-sandbox.md)、[ADR-0049](./ADR-0049-ssh-custody-modes.md)。
