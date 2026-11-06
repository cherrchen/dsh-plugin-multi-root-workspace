# ADR-0032：将 DSH 官方 SSH 组合用作每个 POSIX 环境的后端

**状态** Accepted · 2026-11-06。已接受架构合同，实验默认关闭；各项能力须通过对应验收才可开放。

## 核对结果（Fact）

本地上游 checkout 为 `dsh-v0.2.2-rc.1`（`66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db`），与本插件的开发 pin 相同。本地 `master` 为 `fcc0ad46`，两者的 `packages/ssh` 无差异。以下结论限定于这个 tag。

| 层次 | 实际证据与边界 |
| --- | --- |
| 源码和公开入口 | `SshConnection` 管理一条 OpenSSH ControlMaster 连接、Helper 握手和独立认证的数据流；构造时只接受 Linux/macOS Host。配置由部署者提供，启用 StrictHostKeyChecking、禁用 agent forwarding。连接丢失使在飞请求失效。认证具体密钥仍由部署者管理，hello 不返回主机密钥指纹。[连接实现](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.1/packages/ssh/ssh/src/index.ts) |
| npm 分发与装载 | 在公共 Registry 下载并检查了四个 rc.1 tarball。临时干净目录中用 Node 24.18.0（macOS arm64）、Cordis 4.1.0、四个精确 rc.1 包运行 `npm install --ignore-scripts`，四个包根入口均成功导入对应类。`dsh-ssh` 还含 `lib/helper.js`。这更新了 Issue 评论中对早期发布时间点的判断。**`@deepseek-ai/dsh` 元包自身的依赖不含任何 SSH 包，默认安装即无 SSH peers**，缺席是常态而非异常。可复查 [ssh](https://registry.npmjs.org/@deepseek-ai%2fdsh-ssh/0.2.2-rc.1)、[fs-ssh](https://registry.npmjs.org/@deepseek-ai%2fdsh-fs-ssh/0.2.2-rc.1)、[subprocess-ssh](https://registry.npmjs.org/@deepseek-ai%2fdsh-subprocess-ssh/0.2.2-rc.1)、[sandbox-ssh](https://registry.npmjs.org/@deepseek-ai%2fdsh-sandbox-ssh/0.2.2-rc.1) 的版本元数据。 |
| Helper 部署 | 有远端 Node 时可部署匹配的打包脚本，指定绝对 Node/Helper 路径和预置 SHA-256；独立可执行载体为 private workspace 包，发布物是分平台归档。Linux x64/arm64 的构建目标是 glibc 2.28，macOS x64/arm64 的部署目标是 14。本次查询 rc.1 GitHub Release 的 assets 为空。不能要求用户从该页下载一个目前不存在的二进制；POC 可选 script 或从同一 tag 原生构建再验证归档。ARMv7/musl 不在预构建目标内。[载体与验证](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.1/packages/ssh/ssh-helper-runtime/README.zh.md) / [Release](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.2-rc.1) |
| 默认组合与实测 | rc.1 的 base 挂载本地 subprocess、sandbox、fs-sandbox；本插件替换其中后两行。上游 live e2e 显式建独立 Context，并要求可丢弃的远端 workspace。上述导入探针未启动 SSH、未验证远端内核或 mixed-root Web/Electron profile。[默认组合](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.1/packages/bundle/base/cordis.patch.yml) / [live fixture](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.1/packages/ssh/ssh/tests/live.e2e.ts) |

## 复用边界

| 公共类 | 插件向它委托什么 | 插件仍需解决什么 |
| --- | --- | --- |
| SshConnection | 连接、握手、Helper 摘要、并发帧与流、lease、dispose | 将部署配置绑定真实 host key/账户，限制凭据可见性，每环境独立连接代次 |
| SshFileSystem | 远端 resolve、stat/list、文本与分段字节读取、带 expected version 的 write/edit/patch/delete/move | 根内安全打开、外部 target/version 命名空间、逐操作准入；公共 FS 无通用 writeBytes |
| SshSandboxProvider | 在目标机请求 confine，消费返回 argv、enforcement 与失败规则 | 证明实际策略表达了本次所有正负权限和允许的临时目录 |
| SshSubprocessRuntime | 在**同一连接**执行上述 argv、收集输出、取消、等待托管进程结束 | 绑定真实执行目标与操作、限制可执行入口；首期不注册远端 PTY/PTC |

优先以**独立根 Context** 复现上游 live fixture，按顺序挂 SessionProjectionRegistry、SandboxPolicyService（远端坐标）、SshConnection、SshFileSystem、SshSubprocessRuntime、SshSandboxProvider；等待 fibers 和 `ssh.ready`。外部仅暴露本插件的受控方法，不导出原始 Context、subprocess、SSH request 或 socket。每个环境拥有各自的 fibers、取消器和连接代次。管理器在配置撤销时先拒绝新请求，再取消/等待在飞工作并逆序 dispose；连接失败只影响对应环境。Helper 握手发生在远端进程启动之后，不能靠程序自报的摘要防御已被替换的启动文件；安装通道、Node、Helper、原生附属文件和父目录均须由可信部署方控制。为每个环境固定仅包含预期密钥的 known_hosts 和登录账户，禁止 Agent 改写匹配规则。两台同路径主机的并行调用和单连接销毁测试通过后才启用多个实例。此组装复用官方协议、进程生命周期和远端沙箱，插件只做路由、策略和结果归属。

**凭据隔离须先于连接。** rc.1 在 `SshConnection` 构造时立即启动 OpenSSH，在系统临时目录创建 ControlMaster socket，并按连接进程的 PATH 查找 ssh。普通 Cordis Context 只隔离服务名；同一 OS 身份的本地 Agent 命令可能借用已认证的 socket，即使拿不到私钥也能发起新命令。加载 fiber 之前先验证远端功能开关、发起平台与部署绑定。共享进程只用于受控测试，生产部署须证明 Agent 无法调用连接管理接口、使用 socket/代理或替换 ssh、配置与 Helper；必要时以独立 OS 主体和经身份认证的本机接口托管官方组合。仅分进程或随机临时目录不能作为隔离证据。未满足条件就不创建连接。此约束也适用于仅传输的部署。[连接的启动与控制命令](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.1/packages/ssh/ssh/src/index.ts)

可选包仅从宿主树按需加载（经宿主锚定解析，仿 `loadHostKoffi()`），遵循 [ADR-0009](./ADR-0009-dsh-compat-contract.md) 的精确 peers 和单例检查；结构适配在 `src/compat/`。缺包、mixed、协议或身份不匹配即撤下远端能力。**宿主支持地板为 `SUPPORTED_SSH_RELEASES`**（现 `['0.2.2-rc.1']`，须保持为 `SUPPORTED_DSH_RELEASES` 后缀）：宿主不在集合内时能力静默缺席——compat 行不失败、不报 mixed、不影响本地行为。因上游安装期兼容检查对清单中每一个 `dsh-*` peer（含 optional）都要求宿主版本满足其 range，SSH peers 的 manifest range 与全量 allowlist 一致，收窄只发生在运行时地板与按 pin 探测。使用包的公开类和方法；`SshConnection.request()` 虽然可见，内部 RPC 方法名、帧和流票据仍是私有协议。

## 无法直接复用的边界

rc.1 的 strict `policySchema` 只传 mode、workspaceRoot、可选 additionalWritableRoots 和 sessionId；没有 deniedRoots。Helper 在远端重新解析 workspaceRoot，读调用接收 target 而无根限制策略，`sandbox` RPC 拒绝 danger-full-access。因此按[入口权限表](./ADR-0030-environment-and-root-identity.md)单独构造远端策略。根内读取及无 Helper 传输另见 [Transfer ADR](./ADR-0034-binary-transfer.md)。[wire schema](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.1/packages/ssh/ssh/src/schemas.ts) / [Helper 实现](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.1/packages/ssh/ssh/src/helper.ts)

**继承的实现接缝。** 在宿主用真实 Session 调用 `ctx.sandboxPolicy.resolve({ session })`，读取返回的 mode。上游优先取该 Session 最近的 sandbox/mode 事件，再取部署默认值。按入口表取远端上限，并与可信调用方更严格的限制取交集；不传入模型请求的提升模式。向 SshFileSystem 的每次 mutation 和 SshSandboxProvider.confine 显式传 `{ mode: effectiveMode, workspaceRoot: verifiedRemoteRoot, sessionId: session.id }`，忽略本机 workspaceRoot 和 additionalWritableRoots。只允许目标机上本次核验过的根；首版单根命令省略 additionalWritableRoots。不要改共享 Context 默认 mode，否则两个并发 Session 会串权。工具 cap 或远端 deny 无法由该操作表达时拒绝。SFTP 不消费这份 DSH 策略，由 Transfer 在创建临时文件前和发布前落实同一权限判定。[Session 策略解析](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.1/packages/sandbox/sandbox-policy/src/index.ts) / [SSH FS 的逐调用 policy](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.1/packages/ssh/fs-ssh/src/index.ts)

**实测（2026-11-06）。** 在 macOS arm64 上经 stdio 启动 npm rc.1 的官方 Helper，对同一连接的同一文件依次发送 workspace-write、read-only、workspace-write。两次可写请求落盘；中间一次返回 `FS_SANDBOX_DENIED`，文件内容保持第一次写入值。单独发送 danger-full-access confine 请求被拒绝。这个探针验证了 Helper 对逐调用策略的处理；Session 取值、工具上限、真实 SSH 连接和远端进程内核限制仍须联测。

## 备选、退出与待证

- 完整官方 SSH profile 可作为单远端对照组，用于验证 Helper 和内核效果。rc.1 的官方连接类只接受 Linux/macOS 发起端。
- Windows 发起端按[平台决议](./ADR-0030-environment-and-root-identity.md)无限期延后。系统自带 ssh.exe、第三方客户端或 WSL 可用，均不满足上游 DSH 原生支持条件。
- 若独立 Context 在公共 API 上不能可靠隔离，退回单独 POSIX 后端进程实验（受认证 IPC、短请求、绑定环境）；若连此路径也需要复制私有 ABI，停止集成。上游 RFC 优先申请可实例化 backend、受根约束的文件句柄/二进制发布及可报告策略表达能力，附失败用例，不修改上游源码。
- **验收与回滚**：比较同一条远端命令在官方独立组合和内部 backend 的 cwd、输出、退出与拒写行为；再验证错密钥、错摘要、双 Context 串用、断线清理、禁用 SSH 后本地照常启动。失败时卸载可选行，关闭对应 capability，不改公共兼容矩阵。
