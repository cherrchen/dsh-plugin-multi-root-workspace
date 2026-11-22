# ADR-0033：显式选择远端构建环境及可承诺的隔离范围

**状态** Accepted · 2026-11-06。已接受架构合同，实验默认关闭；各项能力须通过对应验收才可开放。

## 背景（Fact）

Issue 原场景包含 Windows 工具链、Ubuntu 编译器和设备运行时；本期由 Linux/macOS 上的 DSH 负责 Session 和执行准入，构建命令在已验证的 Linux/macOS 目标上运行。Windows 发起端的范围见[平台决议](./ADR-0030-environment-and-root-identity.md)。上游 SSH 组合让 fs、sandbox 和 subprocess 全部指向一个远端；本地 process fence 依赖本机服务与方言。Remote Helper 提供预留、流连接、至多启动一次、退出等待及 lease 清理。某次管理请求超时和构建执行超时是两种不同事件。[上游 SSH 子系统](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.1/docs/subsystems/ssh.zh.md)

## 决策

首版执行入口是可选的 `remote_bash({environmentId, rootId, cwdRelative, command, timeoutMs})`。例如由 Agent 指定 build 环境的 project 根运行 `cmake --build build`。部署方预置该环境可用的 shell、环境变量和限额。原生 bash/pwsh、用户终端、后台 jobs、PTY/PTC 和 LSP 不读取这个选择。模型无法指定主机名、凭据、sandbox argv 或切换到未登记目录。

1. 取真实 session、dispatch 工具身份与当前模式，取得 owner 对 `exec` 的新准入。在指定主机验证根与 cwd；拒绝越界和已变更的环境身份。同时检查命令能触及的整个执行环境，不能只校验 cwd。缺少执行业务授权时在连接/准备命令前返回拒绝。
2. 仅开放证据覆盖的策略。例如专用构建用户、一个可写工作树、经审定的构建临时目录、无其余 grant 的 workspace-write 是首个候选。构建所需运行时和系统库可读须如实列出；若部署要求隐藏其他项目或密钥，须由远端账户、容器或挂载隔离提供证据。FS 根内读取的合同不能推导为 shell 全机读隔离。禁止把 SSH 认证、网络隔离、文件效果限制混为一项保证。远端 OS、管理员和已部署 Helper 属于可信基础设施。
3. 将可表达的策略传给该环境的 `sandbox.confine`，检查返回的 enforcement，再将封装的 argv 交给**同一代次**的 subprocess.spawn。准备可能跨越一次撤权：在调用公开的 subprocess.spawn 前再取 owner 的短期启动准入，比对准备时的根、身份、策略和连接代次，失配即丢弃 argv。最终准入与 spawn 绑定在同一操作里，遵循 ADR-0024 允许已准入短操作完成的顺序，禁止缓存 argv。按[入口权限表](./ADR-0030-environment-and-root-identity.md)将会话模式转换为远端受限模式，即使会话为 Full-access 也必须调用 confine。若 deny、工具上限或临时目录边界无法实现，或后端仅报告未经验证的 partial，启动前拒绝。在本机运行 `ssh host command` 的 Seatbelt 或 Windows ACL 不产生远端隔离。
4. 上限内分别收集 stdout/stderr，标记截断、退出码/信号、operationId、环境、执行截止时间和清理状态。长期等待不持有 owner 队列。启动后取消/撤权触发终止请求，分别记录直接进程退出和 `waitForExit` 确认的托管范围。lease/EOF 只是清理机制；断线、丢应答或后代无法确认时返回 `unknown`，保留对账 ID，禁止自动重连重跑构建或测试。
5. Helper-less 设备首期禁用 shell。传输授权不包含执行；UI 只显示设备实际能力、沙箱后端与证明范围。任何未来的“不受沙箱控制、由操作员独立批准执行”须另立决策，并解决可信批准通道。普通面板 owner cookie、模型参数、命令白名单均不能承担此职责。

**最终准入点与输出。** rc.1 的公开 spawn 同步返回 handle，随后由内部异步完成 prepare、接流和 start。最终准入之后发生的撤权按在飞操作处理；调用方尽力终止并等待确认，不能承诺远端此后绝不会首次起进程。最终准入之前的撤权必须阻止 spawn。不得在私有 start RPC 中插入钩子。首期以受控 stdio 配置收集有界输出，关闭 spill、额外控制 fd 和 stdin 管道，避免 Helper 在命令沙箱外写日志或将远端 spillPath 误作本地文件。工具通过 Host 正常的工具授权流程执行，已有的拒绝规则必须生效。[远端进程实现](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.1/packages/ssh/subprocess-ssh/src/index.ts) / [Helper 的输出收集](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.1/packages/ssh/ssh/src/helper-processes.ts)

**凭据逃逸是部署前提。** 即使 `remote_bash` 自身受限，只要本地原生 bash / PTC 或远端构建进程能读取部署私钥、使用 SSH agent/ControlMaster socket、改写 SSH config 或 Helper，就能绕开它。用于正式受限声明的部署必须隔离该账户/代理、socket、配置、可执行文件与网络入口，禁用凭据转发，并用真实子进程尝试直接登录或复用连接。对用户自行持有且对本地 Full-access 可用的其他身份，产品不能声称控制所有 SSH 访问。无法隔离本插件使用的身份时，拒绝注册这项能力。

## 备选与待证

- 可让每个 profile 全程在同一远端运行；适用于对照试验，代价是切换 Session。可向上游提议显式、可持久化的 per-operation ExecutionContext，覆盖 session restore、子 Agent、PTY/PTC、LSP、后台任务的路由、取消和审计；公共接缝成熟前保留显式工具。
- 排除根据 cwd、命令中的 cd/路径或上一次调用来推断主机，尤其两个并发 Agent 可以在不同环境有完全相同的 cwd。排除用 ssh2/CLI 的裸 exec 声称根内执行。
- **安全证明与回滚**：在构建机让 shell 用绝对路径、重定向、子进程写只读/根外哨兵，检查文件实际内容；模拟 prepare 后撤权、启动后断线、输出背压和后代延迟退出。工具关闭时先撤销新启动，再处置既有 handle，向用户保留已确认/未知的最终结果。证明不足时保留已验收的复制能力，构建由操作员独立完成。
