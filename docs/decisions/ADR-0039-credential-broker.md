# ADR-0039：以独立 OS 账户托管 SSH 连接的本机凭据代理

**状态** Proposed · 2026-11-07。本文只规定凭据隔离的实现合同与验收条件；远端实验仍默认关闭，是否对模型开放由部署方的隔离证据决定，不由本文自动授权。

## 背景（Fact）

ADR-0032 已确认：rc.1 的 `SshConnection` 构造时立即启动 OpenSSH，凭据、ControlMaster socket、`ssh` 可执行文件与 Helper 暂存都由发起进程的 OS 身份持有。同 UID 的本地 Agent 命令即使读不到私钥，也可以复用已认证的 socket 发起新命令、替换 `ssh`/配置或直接读取密钥文件。仅把连接放进另一个 Node 进程、或使用随机临时目录，都不构成隔离证据。

G4 的实跑把一个 chroot SFTP 账户、一个 helper 账户和宿主的 `ssh` 放在同一卷上，因此部署保持 `unattested`，工具未对模型开放。本 ADR 定义把连接托管到**独立 OS 账户**的方案，以及 Host 与它之间的**经内核认证的本机接口**。

## 决策

下方保留 2026-11-07 初稿的历史设计。其“ControlMaster/Helper 暂存全部位于 home”布局与协议 2 的 hello/准入条件已被本文件 2026-11-10 的修正段落取代；当前实现以[控制面参考](../reference/multi-environment-control-plane.md)为准，不应按旧段落部署或签收。

### 1. 托管进程与凭据边界

- 部署方创建专用账户（示例名 `_dsh_ssh`）与客户端组（示例名 `dsh-ssh-clients`）。托管进程以专用账户运行，**必须与 Host 用户不同 UID**；同 UID 启动直接拒绝。
- 专用账户的 home（或 `DSH_SSH_BROKER_HOME`）为 0700：SSH 私钥、`config`、`known_hosts`、ControlMaster socket、Helper 暂存全部在其下。Host 用户不属于该目录的任何访问组。
- 部署清单（环境、绑定、动作、传输配对、helper 摘要）由部署方放在 Host 用户**不可写**的位置（例如 `/etc/dsh-ssh-broker/manifest.json`，root 所有且两进程可读）。托管进程只读这一份清单，不接受客户端传入的 manifest、主机名、账号、密钥或 Helper 路径。
- Host 用户只拿到一个本机 socket，路径形如 `/run/dsh-ssh-broker/broker.sock`：目录属主专用账户、0750、组为 `dsh-ssh-clients`，socket 0660。密钥目录与 socket 目录分离：前者 Host 组**不可读**，后者仅可连接。

### 2. 本机接口与认证

- 协议是**有界、版本化、请求/响应 + 事件**的 JSON lines：每行一个对象，`protocol: 2`，最大 2 MiB；二进制载荷（SFTP 数据、stdout/stderr）用 base64 分块，单块 ≤ 256 KiB；未知方法、未知字段、超界一律拒绝并关闭连接。
- 托管进程对每条连接做**内核 peer 认证**：`SO_PEERCRED`/`LOCAL_PEERTOKEN` 报告的 UID 必须等于配置的 Host UID，且对端不得处于沙箱或 `NoNewPrivs` 状态（复用 `src/authority/native.ts` 的判定；该模块为不同 UID 增加显式参数）。Linux 上用 `SO_PEERPIDFD` 钉住对端，内核不支持即失败关闭；没有 PID-only 回退。认证失败不返回协议内容。
- 托管进程的 `hello` 仅在认证通道返回 `{ protocol, brokerUid, environmentIds, manifestDigest }`。Host 核对协议版本、独立 UID 及实际加载的清单摘要，摘要不进入模型上下文或审计。
- 托管进程不提供任何“读取/导出密钥、修改配置、启动任意 ssh、切换主机”的方法。它只转发**已声明环境**上的四个语义面：SFTP 原语、`confine`、`spawn`/等待/终止、`dispose`。SFTP 原语是语义方法而不是原始字节隧道，便于逐请求限额与审计。

### 3. Host 侧适配与准入

- `BrokerEnvironmentManager` 实现与官方 `SshEnvironmentManager` 相同的结构面（`deployment`、`openSftp`、`sftpGenerationOf`、`open`、`generationOf`、`markStale`、`disposeAll`），因此 G2 的复制管线、`SshEndpointVerifier` 与 G3 的双准入命令合同**不改**：Registry 准入、源/目的绑定、staging、哈希与 no-replace 发布仍在 Host 侧执行。
- 托管进程的 SFTP 会话按环境记忆化（与官方 manager 相同）；`dispose`/`markStale` 只影响单环境，重开产生新代次。命令的 `confine` 结果携带代次，`spawn` 要求同一代次，失效即 `admission-changed`。
- Host 侧在**建立任何连接之前**执行 `attestBroker()`，只有全部检查通过才构造 manager、注册工具：
  1. socket 存在、是 socket、属主为配置的 broker UID、目录与 socket 权限恰为部署声明的值；
  2. 凭据根对 Host 用户**不可读**（`access(R_OK)` 必须 `EACCES`）；
  3. 连接成功、`hello.protocol` 匹配、`brokerUid` 等于部署声明且不等于 Host UID；
  4. 本地已解析清单与 broker 加载的清单具有相同的规范化摘要。旧协议或摘要不同即拒绝，防止同名环境在两个进程指向不同端点；
  5. 部署方记录的**受限探针**结果：以 Agent 的沙箱模式（workspace-write 或 read-only）运行的本机命令既读不到凭据根、也连不上 socket。该探针由部署流程执行并写入受保护配置；运行时无法自证沙箱是否覆盖了 socket，因此缺失证据即 `unavailable`，工具不挂载。
- `danger-full-access` 会话不构成受限探针的等价物：该模式下 Agent 进程不受本机沙箱约束，必须由部署禁止（运行时对远端操作的准入仍将有效模式收敛为 workspace-write，但不能限制同一会话的原生 shell）。默认模式为 `danger-full-access` 时工具行拒绝挂载。证明还要求受保护的配置显式记录 `fullAccessDisabled: true`，由部署方确保该 UID 下的所有 Agent 执行入口遵守限制。

### 4. 失败与撤权

- 认证失败、协议违规、清单摘要变化、托管进程断开：Host 立即停止新请求，关闭所有会话，`attestBroker` 返回 `unavailable`；已发出的 SFTP/exec 请求按 G2/G3 的既有语义返回 `unknown` 或 `failed`，不重放。
- 托管进程退出或 socket 消失后不自动重启、不重建连接；重新启用必须重新走 `attestBroker`。
- 审计只记录 `{time, connection, method, environmentId, outcome, bytes}`，不记录命令内容、路径、输出、密钥或摘要。日志写专用账户可写的 0600 文件。

## 部署前提（可检查项）

1. 专用账户与客户端组存在；Host 用户仅属于客户端组，不是专用账户组成员。
2. 凭据根 0700、属主专用账户；Host 用户对其 `R_OK` 为 `EACCES`。
3. socket 目录 0750，socket 0660；私钥与 ControlMaster 不在 socket 目录内。
4. 清单、broker 入口、Node 与依赖不可被 Host 用户写入。Host 与 broker 读取同一份清单。
5. 部署的 DSH 沙箱对 Agent 命令拒绝凭据根与 socket 路径；探针输出保存在受保护配置中。
6. 不允许 `danger-full-access` 会话与远端凭据同时启用。

## 验收

- **单元**：协议编解码与限额、未知方法/字段、peer UID 不符、沙箱/NoNewPrivs 对端、同 UID 启动拒绝、`hello` 不含敏感字段、断开后不重连、SFTP 语义代理的字节/句柄往返、`confine`/`spawn` 代次与事件顺序。
- **集成**：用受控的同 UID 测试模式跑通完整复制与一条命令，证明 Host 侧准入与结果归属不变；生产模式必须拒绝同 UID。
- **部署**：在具备两个真实账户的机器上由 Host 账户完成一次 SFTP 复制与一条 `remote_bash`，同时以 Agent 沙箱模式证明读凭据根与连 socket 都失败；保留 `attestBroker` 的完整输出。缺少这一项时部署保持 `unattested`，工具不挂载。

## 协议修订（2026-11-09）

首轮 Linux 实机使用协议 1，只比较环境 ID。未发布分支改用协议 2 绑定整份清单，避免凭据代理和 Host 在配置更新时各持一份不同的同名环境。协议 1 与 2 不互通，部署要一起更新两端。具体开关和停用顺序见[控制面参考](../reference/multi-environment-control-plane.md#部署启用清单)。

## 协议修订（2026-11-10，协议 3）

未发布分支改用协议 3，与协议 2 不互通，两端必须一起更新：`hello` 增加必填 `sshCapability`（broker 账户自己的 SSH 能力判定，Host 不代替）；`confine` 的 policy 只收 `read-only`/`workspace-write`（schema 层拒绝 `danger-full-access`），且仅 `full` 实施级返回一次性 `confinementToken`——单连接、绑定环境/精确 argv/代次/workspaceRoot、TTL 30 秒、上限 256 条，`spawn` 消费票据后才启动；每条 `sftp` 请求必须携带会话代次，服务端拒绝过期代次，不复用旧会话的句柄。

## 收窄与运行时约束（2026-11-10，外部评审修正）

保留原方案的历史动机，追加以下收窄；本 ADR 仍为 Proposed，不代表模型开放已经签收：

- **票据绑定**精确到 confine **返回后**的受限 argv（不是提交的 argv）；`spawn` 还在原生启动前拒绝非空 `LD_*`/`DYLD_*`/`NODE_OPTIONS`/`NODE_PATH` 环境键（`confinement-ticket-env`），杜绝动态加载器注入先于 runner 沙箱生效。
- **证明收窄**：Host 与 broker 均不得为 root（`broker-root-uid`）；凭据根经 `lstat` 必须是非 symlink 的真实目录、属 broker、恰为 0700；模型可见复制目的必须是声明 `destinationIsolation: "chroot-sftp"` 的 sftp 环境，且不得与同 `namespace`+`account` 的 helper/exec 环境共存（`destination-isolation-required`）——helper 环境不能作复制目的。
- **运行时守卫**（`src/remote/profile-guard.ts`）：专用 profile 安装即包裹 `sandboxPolicy.resolve`、`sandbox.confine`、`subprocess.spawn`/`spawnTerminal` 与晚激活的 `approval.request`——拒绝任何 `danger-full-access` 解析/策略/单发升级，未受票据约束的 spawn（LSP/job 等）fail-closed，`DSH_PTY_SESSION_ID` 标记终端按 `DSH_SESSION_ID` 找活体 Session 并重新准入/限定；守卫覆盖受支持的服务接缝，第三方 `node:child_process` 直引与用户终端标记属部署信任假设。
- **临时文件**：ControlMaster/Helper 暂存归 broker 账户 `mkdtemp` 私有目录，Linux unit 以 `PrivateTmp=yes` 隔离；unit 未在容器内真实执行，真实部署证据仍缺。
- **证据状态**：容器内协议 2 样例与伪造 hello 记录为**历史性反例**，不构成现行守卫的绿色证据；配额/审计轮转/吊销与 Linux/systemd/GUI 证据已于 2026-11-11 外部评审复核通过（[评审报告](../reviews/2026-11-11-model-entry-evidence-review.md)），模型入口仍默认关闭，开启需维护者签收（详见控制面参考"模型开放的前置阻断项"）。

## 备选与未决

- 以继承管道代替 socket（Host 启动托管进程）：没有文件系统接口可供同 UID Agent 枚举，但需要每次启动都经特权 launcher，且仍无法阻止同 UID Agent 启动自己的实例。首期选择长驻 socket，把“Agent 不能到达 socket”作为部署证据。
- 若上游未来提供可注入 transport 的 `SshConnection`，可用原始字节隧道替换语义代理；本 ADR 的认证与边界不变。
- 备忘录：即使凭据隔离通过，Registry 的 session 模式与 tool cap 仍是 Host 侧策略；托管进程不代替它们。
