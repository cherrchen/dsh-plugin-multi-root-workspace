# ADR-0030：一个 Session 内的本地根与远端根

**状态** Accepted · 2026-11-06。已接受架构合同，实验默认关闭；各项能力须通过对应验收才可开放。

## 背景（Fact）

[Issue #32](https://github.com/cherrchen/dsh-plugin-multi-root-workspace/issues/32) 的原始场景有三台机器。Agent 从 Windows 上的多个 CLion 项目取源码，在 Ubuntu 虚拟机或公司 Linux 服务器构建，再把二进制发到嵌入式 Linux 并运行测试、取回日志。挂载目录能让文件可见，但构建命令仍由发起命令的机器执行。维护者在 Issue 中将此列为将来可以考虑的实验功能，未承诺完整远程开发环境。

插件核对点为 `feat/ssh-workspace` 与本地 `main` 的 `2af79a73`（插件包版本 0.1.15，本地实际安装的 DSH 为 0.2.2-rc.1）。当前 [Registry](../../src/registry.ts) 以 Session origin 的上游路径拼写确定记录集，[Scope](../../src/scope.ts) 将本机路径投影给所有消费者。所有写授权都在同一台主机解释。设计延续[需求](../requirements/multi-root-workspace.md)和[本地架构](../architecture/multi-root-workspace.md)的 out-of-tree 约束。

## 决策

1. 一个 Workspace 仍只有一个本地 Primary Root。Session header、Registry 主键和本地相对路径继续由 [ADR-0012](./ADR-0012-session-origin-and-effective-cwd.md) 和 [ADR-0028](./ADR-0028-upstream-primary-identity-and-shared-only-registry.md) 定义。模型显式选取已登记的 `{environmentId, rootId, relativePath}`。例如同一 Session 的 `build/project:out/fw.bin` 与 `board/app:fw.bin` 在各自环境解析（示意标签）。无目标的原生工具沿用本地入口。
2. 部署方在 Agent 无写权限的控制面预置连接和允许绑定的目录。环境 ID 为不可复用的内部 ID。配置绑定实际主机密钥、登录主体、端点配置版本，以及启用 Helper 时的程序摘要和协议；显示名和 OpenSSH alias 可读但不构成身份。凭据只经受控连接进程取得。Agent、项目配置、普通根管理命令、持 owner cookie 的浏览器均不得新增主机、改账号或扩大远端根集合。若部署无法保护配置与凭据，关闭相应能力。[ADR-0027](./ADR-0027-revive-target-and-protected-paths.md)
3. 每条远端 grant 存储环境 ID、根 ID、显示路径、**由远端验证的登记目标身份**及绑定的配置版本。确认目录替换需有可跨重连验证的对象身份或部署方提供的固定隔离根；仅能验证路径拼写时不承诺识别同名换盘，阻止依赖此保证的能力。拒绝同环境重叠根、保护目录和别名冲突；不同环境可以都有 `/work/app`。每次重验发现重定向、密钥/账号/Helper 变化便 withheld，须在可信控制面重新登记。失联为 unavailable，不触发自动 revive。
4. 本地 v1 记录按原格式读写，天然属于 `local`。在同一 Registry owner 管理下开**单独版本化的远端记录域**，沿用同一 lease、排序队列和 IPC 身份校验。远端记录不写本地 grant 字段，不送入 `setAdditionalRoots()`、本机 realpath、ACL SID 或方言。旧版只读原域。升级后的首次启用重新核对部署配置和对象身份；混合新旧 Host 遇旧 owner/协议时拒绝远端准入，不开第二个 owner。环境连接管理器只管理连接与能力，不保存第二份授权表。[ADR-0007](./ADR-0007-registry-authority-lease.md) / [ADR-0025](./ADR-0025-shared-registry-authority.md)
5. Host 从真实 session、调度工具名、当前策略推导用途。扩展既有操作准入，一次向 owner 提交本次动作及全部端点，在同一排序点取 grant、deny、epoch 和 revision，队列外执行 I/O。新操作重取准入，直调服务也覆盖；缓存 target、连接、epoch 或在飞回调均不能授权下一次操作。所有远端读取（含 stat/list）、启动和传输都须显式授权。远端拒绝后不以主根或本地路径重试。[ADR-0024](./ADR-0024-registry-operation-admission.md)
6. 本地端点的三态访问沿用 [ADR-0017](./ADR-0017-three-state-root-access-and-sandbox-modes.md)。SSH 端点按下表取当次会话策略，再受工具上限、根边界及已验证能力约束。传输还需验证导出、导入和两端配对；可读源码本身不授权上传至任一主机。[ADR-0013](./ADR-0013-per-root-and-per-tool-access.md)

### 准入使用哪个主根

当前 `withOperation()` 从 `policy.workspaceRoot` 取本地存储键；普通 `withRegistryAdmission()` 在缺少共享 Registry 时还允许执行回调。远端入口须要求显式成功的 owner 应答，以真实 Session 的 `primaryKey(session.header.cwd)` 选取记录；只在准入完成后构造发往 Helper 的远端 `workspaceRoot`。旧 owner、域打开失败、epoch 缺失或端点绑定不一致都拒绝远端操作。不得把远端路径或有效 cwd 作为本地授权表的键。[Registry 实现](../../src/registry.ts) / [现有准入封装](../../src/registry-operation.ts)

部署清单按本地主根列明可附加的环境、根和操作。面板仅能选择清单内对该主根预授权的绑定；跨项目复制一个有效 rootId 也须拒绝。owner 与实际持有连接的 Host 必须核对同一份部署绑定版本或摘要，再对该连接验证实际端点身份。两个别名若指向同一执行命名空间，按部署方验证的同一身份检查冲突；不能证明彼此隔离时拒绝有重叠授权的配置。恢复连接或接管后按新代次重新准入。

## SSH 入口合同（维护者已决定范围，待实现）

**平台。** 本期 SSH 实验的发起端为 Linux 或 macOS 上的 DSH，目标端限 Linux 或 macOS。对已知 Windows 目标，在配置入口即拒绝；目标身份或系统未验证时只允许身份核验，不登记根、不发布能力。官方 Helper 以握手的 platform 复核，纯 SFTP 端点须有与主机密钥绑定的可信部署清单，不能凭 POSIX 风格路径推断系统。

**原生 Windows DSH 作为 SSH 发起端无限期延后。** 保留从 Windows 添加 Linux/macOS SSH 路径的需求，不排期，也不以 Windows 发起的读回、传输或执行作为本期验收条件。重新评估的前提是上游 DSH 正式发布明确支持原生 Windows 发起 SSH 连接的版本。届时先用该版本在原生 Windows DSH 分别连接 Linux 和 macOS、添加路径并读回文件，再按实测能力决定插件支持范围。等待期间不开发自有 Windows SSH/SFTP 客户端、WSL 桥接或 POSIX 中继。

**权限。** SSH 根统一跟随当前 Session，最高为工作区读写。根登记、持久化、面板、命令、工具参数与 RPC 均无独立权限档位；Host 拒绝为远端设置 access/mode 的请求。会话政策在每次操作准入时重新解析，同一连接可同时服务不同模式的 Session。

| 当前 Session | SSH 路径的有效文件权限 |
| --- | --- |
| 只读（read-only） | 读取已授权根。拒绝写文件及以该根为目标的复制，包括创建 staging。远程命令只有在已验证只读沙箱中才能启动。 |
| 工作区读写（workspace-write） | 允许在本次授权的远端工作根内读写。命令按远端 workspace-write 沙箱执行；具体后端使用的临时目录另行验证和披露。 |
| 完全访问（danger-full-access） | 远端按工作区读写封顶。文件修改和进程仍显式使用受限策略；实现不了这一上限的能力拒绝执行。 |

启用实验功能、添加 SSH 路径的面板和命令帮助均在操作前显示以下说明。已登记根的列表以只读文字显示当前有效模式，随 Session 更新。三态选择器只用于本地根。

> 本期 SSH 实验限 Linux/macOS 上的 DSH 连接 Linux/macOS 目标。Windows 发起端无限期延后，等待上游 DSH 支持；Windows 目标不支持。SSH 路径权限跟随当前会话，最高为工作区读写，无法逐路径设置。

无法取得可信 Session、Registry 准入或有效模式时拒绝远端操作；不会以工作区读写补缺。模式切换对下一次准入生效。已经启动的进程仍持启动时的限制，回收语义见[执行 ADR](./ADR-0033-remote-command-and-sandbox.md)。技术依据与实测边界见[官方 SSH 后端](./ADR-0032-upstream-ssh-backend.md)。

## 备选与后果

- 可在不同 profile 各开本地、远端 Session，全部使用上游坐标。这适合单机开发，但构建与投送之间需另行交接，也不能让一个 Agent 直接引用两端。
- 可把 SSHFS 挂载点作为本地目录处理，只提供挂载方的文件语义。它无法选择构建所在机器；放宽 Windows 网络盘、UNC、设备路径校验会破坏既有边界，排除作为正式接入路径。[ADR-0019](./ADR-0019-windows-token-attributes-and-conditional-acls.md) / [ADR-0020](./ADR-0020-windows-normal-deny-groups.md)
- 分域增加了跨版本 IPC 和授权排序的工作量，换来可逆迁移。撤权后新准入必拒；已准入短操作可以结束，长任务按执行 ADR 回收。关闭实验先停止新准入，失效连接代次并处置在飞任务，再卸载远端行，历史本地库可直接由旧版使用。

## 实施验收

两台主机同路径、旧主根换名后变 symlink、新旧 owner 接管、IPC 失联、撤权与双端准入竞态必须用真实存储验证。任一情况下旧 grant 被重解释或一项远端失败导致本地 profile 起不来，就停止迁移。实施次序与测试入口见[验证计划](../plans/active/2026-11-06-multi-environment-gates.md)。

## 分项评审入口

建议先看[官方 SSH 能复用到哪一层](./ADR-0032-upstream-ssh-backend.md)，再分别评审[构建命令](./ADR-0033-remote-command-and-sandbox.md)和[源码与产物复制](./ADR-0034-binary-transfer.md)。[原生文件工具路由](./ADR-0031-filesystem-routing.md)是后续接入单一文件服务的条件，显式复制工具的实验可先进行。
