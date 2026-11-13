# 多执行环境 G1a：远端控制面参考

本文是 [G1a](../plans/active/2026-11-06-multi-environment-gates.md) 已实现控制面的稳定技术参考：部署清单格式、远端记录域、`remote-1` 协议入口、Host 侧准入接口及拒绝码。架构合同归 [ADR-0030](../decisions/ADR-0030-environment-and-root-identity.md)；验证结果与关卡状态只归[路线图总账](../plans/active/2026-09-12-multi-root-workspace.md#多执行环境-g1a-控制面2026-11-07)。可选的 broker 证明行（`remote-tools`）会安装端点校验器、`remote_copy`/`remote_bash` 与能力投影；默认组合不挂载任何模型可见的远端能力。2026-11-11 外部评审通过后，模型侧仍默认关闭；是否为具体部署开启由维护者签收后决定。

## 开关与状态

Registry 行配置 `remoteEnvironments: { enabled?: boolean; manifestPath?: string }`，默认组合不写此字段。`registry.remoteStatus.state`：

| 状态 | 含义 |
| --- | --- |
| `disabled` | 未开启；v1 协议、v1 域、scope、prompt 与不装实验时逐字节相同。 |
| `platform-deferred` | 原生 Windows 发起端（ADR-0030 无限期延后），不读清单。 |
| `config-invalid` | 缺 `manifestPath` 或清单解析/保护检查失败；本地 Registry 不受影响。 |
| `storage-failed` | owner 打开或写入远端域失败，或 v1 存储失败。 |
| `owner-without-remote-protocol` | follower 连不上 `remote-1`（旧 owner 或 owner 未开启实验），或通道已关闭。 |
| `epoch-mismatch` / `config-digest-mismatch` | `remote-1` 与 v1 不属同一 epoch，或两个 Host 的清单摘要不同。 |
| `ready` | 唯一允许远端准入的状态。 |

## 部署清单

Host 启动时用 `node:fs` 直接读取（不经 `ctx.fs` 或工作区读路径）。POSIX 保护检查（生产路径）：清单文件与其**每一级祖先目录**都必须是非 symlink 的真实条目、属 root（uid 0）且不可被 group/other 写——文件由部署者以 root 安装，Host 与 broker 的运行账户均不得为 root；清单不得位于任何被绑定的本地 primary 之内。测试内部加载器才把文件与直接父目录放宽为"当前 uid 或 root"并跳过祖先遍历，生产配置没有对应开关。格式为严格 JSON（未知键即拒绝）：

```json
{
  "schemaVersion": 1,
  "configVersion": "2026-11-07.1",
  "environments": [{
    "environmentId": "build-ubuntu-01",
    "displayName": "Ubuntu build VM",
    "platform": "linux",
    "account": "dshbuild",
    "hostKey": "SHA256:<43 字符 base64>",
    "namespace": "build-vm-01",
    "transport": "helper",
    "helper": { "sha256": "<64 位十六进制>", "protocol": 3 },
    "connection": {
      "host": "build-alias",
      "nodePath": "/opt/node-v24/bin/node",
      "helperPath": "/opt/dsh-helper/node_modules/@deepseek-ai/dsh-ssh/lib/helper.js",
      "workspace": "/work/project"
    },
    "exec": {
      "shell": ["/bin/bash", "-c"],
      "env": { "PATH": "/usr/bin:/bin" },
      "maxTimeoutMs": 30000,
      "stdoutLimit": 8192,
      "stderrLimit": 4096,
      "terminateGraceMs": 2000
    },
    "credentialIsolation": "unattested"
  }],
  "bindings": [{
    "primary": "/home/me/project",
    "environmentId": "build-ubuntu-01",
    "rootId": "project",
    "path": "/work/project",
    "actions": ["read", "write", "exec"],
    "transfers": [{ "direction": "import", "peer": { "environmentId": "local", "rootId": "src" } }]
  }]
}
```

- `platform` 只接受 `linux` / `darwin`；Windows 目标为 `windows-target-unsupported`，其他值为 `unsupported-platform`，均使整份清单失效。
- `transport: "helper"` 必须带 `helper`，`"sftp"` 必须为 `helper: null`。
- `connection` 必填：`"helper"` 传输为 `{host, nodePath, helperPath, workspace}`（host 为 OpenSSH 别名 `/^[A-Za-z0-9._-]{1,64}$/`，三个路径均为规范化 POSIX 绝对路径；`helper.sha256` 即 helperHash）；`"sftp"` 仅允许 `{host}`。
- `exec` 可选且仅限 `"helper"`：`{shell(1..8, 首项绝对路径), env(≤64 键), maxTimeoutMs(1..3_600_000), stdoutLimit/stderrLimit(1..16MiB), terminateGraceMs(0..60000)}`；缺席即该环境无执行能力。
- `credentialIsolation: "attested" | "unattested"` 必填：ADR-0032 的部署者声明——Agent 是否确实无法触及连接凭据/套接字/配置/ssh 二进制；`"unattested"` 的连接仅在测试选项 `allowUnattestedForTesting` 下建立，生产路径不接受（既有 VPS 记录即 unattested：本地同 UID 持有私钥——历史性记录，未经本次评审复核）。
- `transfer` 可再声明 `destinationIsolation: "chroot-sftp"`：带 `import` 配对且 `actions` 含 `write` 的绑定，其模型可见目的端必须是 `transport: "sftp"` 且环境 `transfer` 声明该字面量；同时，任何共享该环境 `namespace`+`account` 的另一环境若带 helper 传输或 `exec`，证明即拒绝——复制目的账户必须是独立的 chroot SFTP-only 账户，helper 环境不能作复制目的。受 root 保护的清单是部署者声明，真实的 chroot/属主隔离仍须部署证据佐证。
- `quotas` 可选（环境与顶层各一份）：`{windowMs(1_000..86_400_000), maxOperations(1..1_000_000), maxBytes(1..1TiB)}`——broker 端按滚动时间窗对**每个**环境绑定请求计 1 次操作、对 `sftp` 的 `read`/`write` 计费载字节；顶层 `quotas` 为 broker 全局窗口，与每环境窗口同时扣减，任一耗尽即 `quota-exceeded`。窗口在 broker 进程内、随重启重置；缺席即不启用该预算，单文件/单请求/在飞上限保持不变。
- `revocations` 可选：`[{environmentId, reason?}]`（≤256 条）——部署者的显式拒绝清单，随清单摘要一起被 Host 与 broker 双方校验；被吊销环境的一切环境绑定方法（`open`/`openSftp`/`sftp` 非 `dispose` 操作/`confine`/`spawn`）拒绝 `environment-revoked`，仅 `dispose` 放行以便清理。引用未知环境为 `unknown-environment`，重复条目为 `duplicate-revocation`。
- `path` 为规范化 POSIX 绝对路径（无 `.`/`..`、`//`、尾斜杠、NUL，≤4096 字节）。
- 拒绝重复 `environmentId`、引用未知环境、同一 primary 下重复 `(environmentId, rootId)`；同一 primary 下共享 `namespace` 的两条绑定路径相等或嵌套为 `alias-conflict`。
- 清单摘要为解析结果按键排序后 JSON 的 SHA-256；绑定摘要覆盖该绑定及其环境（host key、账号、Helper、路径等）。绑定按 `primaryKey(primary)` 归属，跨项目复用 rootId 无效。

## 远端记录域

独立域 `multi_root_workspace_remote`（version 1，`backup-and-skip`），表 `grants`，键为 primary key，值 `{ grants: RemoteGrant[] }`；记录严格，带 `access`/`mode` 或未知键即无效。`RemoteGrant` 只含 `environmentId`、`rootId`、`displayPath`、`verifiedTarget {kind: object|path, value}`、`configVersion`、`bindingDigest`、`addedAt`，不存连接、密钥或准入句柄。只有 v1 lease 的 owner 在同一介质上打开它；旧版本只读 v1 域，不受影响。读取时按当前清单判定：绑定消失为 `revoked`，绑定摘要变化为 `withheld`（须在可信控制面重新登记），否则 `registered`。远端记录从不进入 `setAdditionalRoots`、scope、方言、指令或 Skills。

## `remote-1` 协议入口

v1 线协议不变。远端请求走同一介质派生的**第二**监听端点 `/tmp/dsh-registry-<uid>/<store 前 48 位>.r1.sock`，沿用内核 peer 认证与帧预算；旧 owner 没有该端点，follower 即记 `owner-without-remote-protocol`。请求带 `protocol: "remote-1"`、`domain`、`store`、`id`、`epoch`、`method`、`args`；`domain` 不是 `remote` 时显式回 `unknown-domain` 且通道保留。`hello` 携带清单摘要，回复与 v1 相同的 epoch；摘要不符回 `config-digest-mismatch`。方法：`remote-snapshot`、`remote-add [primary, {environmentId, rootId}]`、`remote-remove`、`remote-admit [primary, {purpose, endpoints, manifestDigest}]`。mutation 的请求 ID 去重与 v1 相同；回复丢失时 follower 以 `authority-disconnected` 报结果未知，不重放。v1 断开、接管或换 epoch 时 `remote-1` 通道随之关闭，须重新 hello。

## Host 侧接口与拒绝码

`registry.withRemoteOperation({ session, toolName, purpose, endpoints }, body)`：

1. 控制面非 `ready` 即 `remote-unavailable`。
2. 主根取 `primaryKey(session.header.cwd)`；模式取 `ctx.sandboxPolicy.resolve({ session })`，取不到为 `session-policy-unavailable`（不以工作区读写补缺）。有效模式：只读→只读，工作区读写与完全访问→工作区读写。
3. 发起侧先收窄：只读会话的 write/exec 及目的端为远端的 transfer 为 `mode-denies`；被 `toolAccess` 封顶的工具同类操作为 `tool-capped`。
4. owner 在同一 `serialize` 队列内准入：`config-digest-mismatch`、`endpoint-not-registered`、`endpoint-revoked`、`endpoint-withheld`、`action-not-allowed`、`transfer-pair-not-allowed`、`invalid-arguments`（read/write/exec 恰一个远端端点；transfer 为 `[源, 目的]`，可含 `{environmentId: "local", rootId}`，至少一端远端，且两端远端绑定分别声明 export/import 配对）。回复 epoch 与当前通道不符为 `stale-epoch`。
5. body 收到冻结的操作身份（operationId、purpose、toolName、sessionId、primaryRoot、epoch、revision、effectiveMode）；`endpoints` 在 body 结束后读取即抛错。排序轨迹以 debug 日志记录 operationId、阶段、epoch 与决定，不含路径内容、密钥或输出。

`addRemote(primary, {environmentId, rootId})` 只接受这两个键；先在队列外调用经 `setRemoteEndpointVerifier()` 注入的校验器（broker 行挂载时安装 `SshEndpointVerifier`，未挂载固定为 `endpoint-unverifiable`），平台不符为 `platform-mismatch`，入队后绑定摘要变化为 `binding-changed`，清单未授权为 `binding-not-authorized`。`removeRemote` 与 `remoteList` 在 follower 上经 `remote-1` 转发。

## `remote_bash` 合同（G3，可选 broker 行挂载）

`src/remote/exec.ts` 的 `runRemoteCommand` 与 `src/remote/exec-tool.ts` 的 `remoteBashTool` 由可选的 broker 证明行统一挂载（测试组合直接注册同一注册函数）。参数 `{environmentId, rootId, cwdRelative?, command, timeoutMs}`；工具名、Session 与取消信号只取自调度。后端（G4 以后由连接管理器提供，测试为 fake）声明部署控制的 shell、环境变量、时限与 stdout/stderr 上限，实现 `confine` / `currentGeneration` / 同步 `spawn`。

1. **准入 A**：`purpose: exec` 的远端准入；校验后端存在（`backend-unavailable`）、`cwdRelative`（空或相对 POSIX，无 `.`/`..`/空段/NUL/反斜杠，`invalid-cwd`）与时限（`invalid-timeout`）；以 `workspace-write`、端点 displayPath 和真实 sessionId 调用 `confine`，非 `full` 为 `sandbox-unverified`。
2. **准入 B**：同一请求重新准入，比对 epoch、端点身份（displayPath、bindingDigest、verifiedTarget）、有效模式与后端代次，任一不同为 `admission-changed` 并丢弃 argv；`spawn` 只在 B 的回调内调用。A、B 之间的撤权使 B 拒绝且不调用 `spawn`。
3. **结果**：`not-started{code}`；`admitted-may-start`（spawn 抛错或 `started` 失败）；`exited`（观察到直接退出、托管范围未确认）与 `scope-exited`（`waitForExit` 确认）；`unknown{reconcileId}`（启动后断线）。超时与取消各只 `terminate()` 一次并标 `termination`；输出按上限截断并标 `truncated`；从不重连或重跑。

SSH 兼容门禁（`classifySshCapability`、`SUPPORTED_SSH_RELEASES`、宿主锚定的 `loadHostSshPackages`）的检查器落点见[基线参考](./multi-environment-baseline.md#ssh-兼容门禁落地清单)。

## 官方 SSH 栈接入（S3a，无用户入口）

`src/remote/ssh-environment.ts` 的 `SshEnvironmentManager` 把已验证清单环境变成一条 `SshEnvironment`：构造任何官方类之前依次过——SSH 门禁必须 `eligible`（`ssh-capability-absent:<reason>`）、环境必须 helper 传输（`transport-not-helper`）、`credentialIsolation` 必须 attested（否则须测试选项，`credential-isolation-unattested`）；随后 `ssh -G <别名>` 解析宿主身份（`user` 必须等于 `account`、`stricthostkeychecking`/`batchmode` 必须 yes、`forwardagent`/`updatehostkeys` 必须 no），known_hosts 查找名按 OpenSSH 规则取：显式 `hostkeyalias` 逐字（不加端口后缀，`none` 按 OpenSSH 语义也是逐字查找名），否则解析后的 hostname，非 22 端口写作 `[hostname]:port`；全部 userknownhostsfile 与 globalknownhostsfile 来源合计**恰一把**匹配钥且 `ssh-keygen -lf` 指纹等于 `hostKey`（`account-mismatch`/`host-key-mismatch`/`host-identity-unverifiable`）；再经 `loadHostSshPackages` 在独立 `Context` 中按 SessionProjectionRegistry→SandboxPolicyService(read-only)→SshConnection→SshFileSystem→SshSubprocessRuntime→SshSandboxProvider 挂载，`hello.platform` 不符即 `platform-mismatch` 并按逆序销毁。`open` 按环境记忆化（并发共享同一 Promise），命中缓存时先经 `env.assertAlive()`（上游 `SshConnection.assertOpen` 的本地存活性检查）验活——被杀的连接留下尸体代次，验活失败即走 `markStale` 后重新建连。返回 `{environmentId, generation, hello(净化字段), fs, sandbox, subprocess, assertAlive, dispose}`——从不暴露 Context、连接对象、套接字或 `ctx.ssh.request`；`dispose`/`markStale`/`disposeAll` 只影响单环境，重开产生新代次而不重连。

`src/remote/ssh-verifier.ts` 的 `SshEndpointVerifier` 以绑定路径为 `workspaceRoot` 执行只读 `full` 限定探针（远端 Node 打印 `{realpath, dev, ino, isDirectory}`），必须 isDirectory 且 realpath 等于声明路径（`endpoint-redirected`），注册目标为 `{kind: "object", value: "dev:ino"}`。`src/remote/ssh-exec-backend.ts` 的 `sshExecBackend` 把清单 `exec` 块映射为部署描述：`confine` 直通官方沙箱并携带环境代次，`currentGeneration` 取管理器当前代次（失联/已处置即永不匹配），`spawn` 无控制通道、收集双倍上限以便本地截断标志成立，`done` 的传输错误映射为 `RemoteConnectionLost` 并标记环境 stale。

## SFTP 传输（G2：三个方向，单文件，无用户入口）

任何传输类型的可连接环境都可声明可选 `transfer: { maxBytes (≤1 GiB), timeoutMs (≤3_600_000) }`；缺席即该环境不能作传输端点（`transfer-unavailable`）。传输通道是环境别名上的 SFTP 子系统，与环境用于执行的 transport 无关：helper 环境可同时收/发文件并经 helper 执行（G5 的构建机），`exec` 仍只允许 helper 环境。`openSftp` 与 `open` 共享同一组有序拒绝与 `ssh -G` 身份检查，再经 `ssh -s <别名> sftp` 拉起 `src/remote/sftp.ts` 的最小 v3 客户端；服务端必须宣告 `hardlink@openssh.com` 与 `fsync@openssh.com`，否则 `publish-unsupported`。SFTP 校验分支：`realpath` 必须等于绑定路径（`endpoint-redirected`）、`lstat` 必须是目录，注册身份为 `{kind: "path"}`——v3 无 inode，同名换物无法在注册时识别（ADR-0030 已知限制），远端平台取清单声明值（SFTP 无握手）。

`src/remote/transfer.ts` 的 `runRemoteCopy` 支持 `local → sftp`、`sftp → local` 与 `sftp → sftp`；`local → local` 为 `direction-unsupported`，在任何准入前拒绝。每次复制仍是七阶段：准入 A（`purpose: transfer`；目的端为远端时只读会话 `mode-denies`、capped 工具 `tool-capped`；两个远端端点必须分别声明 `read`/`export` 与 `write`/`import` 配对，缺配对 `transfer-pair-not-allowed`，配对存在但缺动作 `action-not-allowed`）→ 受缚源打开 → 目的预检（目标必须不存在）→ EXCL staging + 有界流 + SHA-256 + fsync + 回读、源版本复检 → 准入 B（epoch、有效模式、两端端点身份、两端 SFTP 代次，任一变化 `admission-changed` ⇒ `cancelled`）→ no-replace 发布 → 只清理本操作确切 staging。

**源。** 本地源沿用 `O_NOFOLLOW` 的单 inode 绑定（普通文件、`nlink===1`、fd 与 lstat 同 inode、父目录 realpath 在根内、≤`maxBytes`）。远端源先对父目录与目标各做一次 `realpath`（必须与拼写相等，拒绝 symlink 替换），再 `lstat` 必须为普通文件且不超过上限，`open(P_READ)` 后复检 size/mtime；读完整流后再复检 size/mtime 与父/目标 realpath（`source-changed`）。SFTP v3 没有 inode 与 link count：远端源无法证明 `nlink===1`，同名替换与多硬链接由部署账户隔离承担，与路径型目标同一前提。

**目的（远端）。** `RemoteStage` 以 `SSH_FXF_EXCL` 创建 `.dsh-staging-<operationId>`（0600），分块写、`fsync`、服务端回读比对（`verify-mismatch`）、再次确认目标不存在，然后 `hardlink`（无覆盖）发布；发布请求送出后失联为 `unknown` + reconcileId，永不重放；代次已变时不按路径删除，报 `residual`。目标名不得以 `.dsh-staging-` 开头（`reserved-name`）。

**目的（本地）。** `src/remote/local-sink.ts` 的 `LocalBinarySink` 是唯一的本地二进制写入端口；只有 `registry.localTransferDestination(primary, rootId, effectiveMode, toolName)` 签发的 `LocalDestinationAuthority` 能打开它。该 Registry 入口与 `ctx.fs` 写围栏同源：根必须 `available` 且 access 在本次有效模式下可写（主根在 `read-only` 拒绝即 `mode-denies`；`read-only` 根永远 `local-destination-read-only`；`inherit` 跟随模式；固定 `read-write` 在只读会话仍可写），capped 工具对 additional root 为 `tool-capped`，并返回 DSH home、存储介质与 lease 目录的受保护边界（目标父目录落在其中即 `protected-path`；比 `ctx.fs` 在 workspace-write 下更严格）。sink 在目标父目录内以 `O_EXCL|O_NOFOLLOW` 创建 0600 文件（与目标同一文件系统），逐级检查父目录不是 symlink、绑定父目录 dev/ino，写入、fsync、按同一 fd 回读校验，发布前复核父目录身份、目标仍不存在、staging 仍是本操作 inode，最后以 `link(2)` 无覆盖发布并清理 staging。发布后清理失败只报 `staging: "residual"`，不撤销已提交；`publish-unverified` 报 `unknown`。发布文件权限为 0600；不覆盖、不删除、不递归。

**远端 → 远端。** 两边都是受管 SFTP 时，Host 只做有界中转：从源连接 `P_READ` 读 64 KiB 块，写入目标 staging，双方都不接触对端凭据；源读取与目标写入分别标记失联来源。源在发布前失联 ⇒ `failed`/`source-connection-lost` 并清理目标 staging；目标失联 ⇒ `unknown`/`destination-connection-lost`，staging `unknown`，不重放。

结果仍为 `{status, code?, operationId, from, to, bytes, sha256, stage, staging}`，不带文件内容与凭据；`deps.onStage` 为测试钩子。`remoteCopyTool` 不在任何生产路径注册；`from.environmentId` 缺省为 `local`，`to.environmentId` 必填。

**部署前提与已知限制。** 本地 sink 最终仍通过 Node 的路径型系统调用 `link(2)` 发布；父目录 dev/ino 与 realpath 的复核缩小了替换窗口，但不能证明同一 UID 的写者在最后一次检查与 `link` 之间不介入，因此本地目的根须没有不可信的 same-UID 写者。SFTP v3 的远端源同样没有 inode/link count，非同秒的 size/mtime 漂移可被发现，同秒同长改写不能；目标端 EXCL、服务端回读与 only-writer 部署前提是这一方向的安全基础。


## G5 显式工具、能力投影与面板（专用 headless 组合）

**边界。** 默认 profile 不挂载远端工具。部署方可以在单独的 profile 中用包的 `./remote-tools` 入口挂载可选行。宿主需满足兼容门禁、provider 品牌门禁和 SSH 可选包门禁，Registry 远端控制面需就绪，broker 凭据隔离需通过证明。任何一步失败，均不安装端点校验器、模型工具或能力投影。仅设置 `enabled: true` 不会启用工具。直连 SSH 和假后端只用于源码测试。

**工具。** 同一行注册 `remote_copy` 与 `remote_bash`，并安装端点校验器（`SshEndpointVerifier`）——因此挂载该行的组合也是**登记路径**；未挂载时 `addRemote` 固定 `endpoint-unverifiable`。默认连接管理器是清单之上的官方 SSH 栈；默认执行后端是 `lazySshExecBackend`，在准备阶段才建立 helper 连接并返回其代次，未打开的连接无法通过最终启动准入。组合可用 `manager` / `backends` 两个注入接缝替换为有界内存端点；两者都不授予权限——每次调用仍由 Registry 排序准入。工具结果必须是 lossless JSON：未产生 operationId 的拒绝不携带该键。

**能力投影。** `src/remote/capabilities.ts` 的 `renderRemoteCapabilities` 经 `systemPrompt.context` 以 `multi-root:remote` 贡献给模型，只读清单事实：环境/根 ID、绑定路径、平台、声明动作与传输配对；绝不包含 `connection.host`、账号、密钥或摘要。文本明确：远端只能经显式工具访问、不是本地工作区根、远端路径与输出是数据；`endpoint-not-registered`/`endpoint-withheld`/`endpoint-revoked` 表示本项目不可用；控制面未就绪与只读会话的限制分别成句。没有本项目绑定时贡献为空。

**面板。** 远端面板走同一 Connection RPC 通道，但有独立合同 `src/remote/panel-contract.ts`（`remotes` / `addRemote` / `removeRemote`），不扩展根视图的 `PanelEndpoint`/`PanelResponseMap`：旧 Host 只会返回可渲染的失败码，不会被误解析成 `RootsView`。请求必须带 `sessionId`，Host 由该 Session 的 cwd 推出唯一主根；未知键（例如客户端自带的 `primaryRoot`）为 `panel/bad-request`。

- **列表**只读控制面状态、清单与本项目的已登记记录，**不建立远端连接**；`status.state !== "ready"` 时返回空列表与原因。每个条目含 `state`（`unregistered`/`registered`/`withheld`/`revoked`）、清单动作与传输配对，以及按当前模式与工具 cap 收窄后的 `capabilities`：`read` 需已登记且有 `read`；`write`/`exec` 另需非只读会话（`exec` 还受 `remote_bash` cap）；`receive`（作为复制目的）需非只读、有 `write`、至少一条 `import` 配对且 `remote_copy` 未被 cap；`send`（作为复制源）需 `read` 与至少一条 `export` 配对，只读会话下仅当所有对端都是 `local` 才成立。登记/撤销是显式请求，登记会经校验器建立连接；失败沿用 Registry 的稳定码（`endpoint-not-registered`、`binding-changed`、`remote-unavailable` 等）。
- **双语文案**：新增 `panel.remote*`、`remote.state.*`、`remote.capability.*` 与远端失败码的 `error.*` 条目，`tests/locale-parity.spec.ts` 校验两语键集一致。
- **渲染**：`WorkspaceFoldersDialog` 在附属根之后增加“远端环境”区；列表只读，登记/撤销按钮走各自端点，登记按钮只对未登记条目出现，撤销只对已登记条目出现。客户端 `RemotesClient` 在边界用 `parseRemotesView` 校验值。

**旅程。** `tests/remote-journey.e2e.ts` 在**同一 Session** 内完成“两个本地根 → 构建机 → 设备”：两个本地根各复制一个源文件到构建机（同一远端路径、不同内容），`remote_bash` 在构建机执行构建，产物经 Host 中转到设备；设备与构建机使用相同远端路径但内容互不串扰；仅传输能力的设备对执行返回 `action-not-allowed`（声明了 `exec` 动作但无后端时为 `backend-unavailable`）；只读会话对写入/执行/目的端为远端的复制均为 `mode-denies`；删除登记后复制为 `endpoint-not-registered`；`local → local` 为 `direction-unsupported`。同一组合内另验证面板列表不建连、登记/撤销、未知 Session、客户端自带路径被拒，以及只读会话的能力投影。

### 部署启用清单

部署方在专用 profile 中按以下顺序启用。面板与面板端点随默认组合提供，关闭时显示远端不可用。

#### broker 依赖树与 SSH 配置（可复现步骤）

broker 运行**自己的** root 保护依赖树——与 Host/Agent 任何一方都不共享 node_modules。示例（路径/版本由部署者替换为其实际选定值；插件 tarball 是本地未发布的 `0.1.19-ssh.1` 构建，不从 npm 安装，上游包取支持矩阵中的精确版本）：

```sh
# root 执行；目录随后属 root、不可被 Host/broker 写
mkdir -p /opt/dsh-broker && cd /opt/dsh-broker
pnpm init
pnpm add --save-exact /path/to/dsh-plugin-multi-root-workspace-0.1.19-ssh.1.tgz \
  @deepseek-ai/dsh@0.2.2-rc.2 @deepseek-ai/cordis@4.1.0 \
  @deepseek-ai/dsh-ssh@0.2.2-rc.2 @deepseek-ai/dsh-fs-ssh@0.2.2-rc.2 \
  @deepseek-ai/dsh-subprocess-ssh@0.2.2-rc.2 @deepseek-ai/dsh-sandbox-ssh@0.2.2-rc.2
chown -R root:root /opt/dsh-broker && chmod -R a-w /opt/dsh-broker
```

`install.sh` 的 preflight 以 broker 入口锚定 `createRequire` 复核 DSH、Cordis 与四个 SSH 包可解析，缺失即在改账户/unit 前中止——解析检查不等于认证。

broker 账户的 `~/.ssh/config`（`$HOME` 0700；config 与 `known_hosts` 0600，属 broker）**最小且全部显式**——`<...>` 均为占位符，须替换为部署者显式提供的路径/主机/账号，不得留作运行值：

```sshconfig
Host <env-alias>
  HostName <fixed-hostname>
  User <fixed-remote-account>
  IdentityFile <provisioned-key-path>
  IdentitiesOnly yes
  StrictHostKeyChecking yes
  BatchMode yes
  ForwardAgent no
  UpdateHostKeys no
  UserKnownHostsFile <broker-owned-known_hosts>
  GlobalKnownHostsFile /dev/null
  KnownHostsCommand none
```

`ssh -G` 会把 `UpdateHostKeys no` 归一化为 `false`（`yes`→`true`，`ask` 保持 `ask`）；身份检查接受解析值 `no`/`false`，拒绝 `ask`/`true`，即清单里写 `no` 即可。

`known_hosts` 由部署者**带外**提供并在置入前核对指纹——不用 `ssh-keyscan`、不执行任何读取密钥的命令；私钥由部署者显式放置，安装器不发现不读取。SFTP 端绑定路径按 chroot 监狱内绝对路径写（如 `/workspace`），不是宿主机 realpath；`import` 目的账户须为声明 `destinationIsolation: "chroot-sftp"` 的独立 sftp 账户——helper 账户与同账号可执行环境都不能作复制目的；构建产物须用独立上传账户落盘后，再经 export/中转取回。固定属主/chroot 与独立写者隔离属外部部署证据，清单声明不构成证明。

1. 将同一构建的 broker 入口、共享 JS chunk、Node 及其解析到的依赖安装到 Host 账号和 Agent 都不可写的位置。四个 SSH 可选包须在对应 DSH 宿主的解析树中与 DSH 精确同版。先由 root 写好完整部署清单，供 Host 与 broker 共同读取。
2. 用 tarball 中的 `scripts/ssh-broker/install.sh` 创建专用账户、凭据根和服务。Linux 默认的 `/etc/dsh-ssh-broker` 属 root，Host 经客户端组可遍历目录和读取清单，`broker.json` 只开放给 root 和 broker 组。在连接前为 broker 配置受信的 OpenSSH 别名、固定主机钥和远端账户。
3. 部署层禁止该 Host UID 下的 Agent 获取无沙箱执行，包括其他 profile、会话、终端与权限提升。用部署实际提供的受限入口验证凭据与 socket 拒绝、用正常 Host 验证正对照。仅在这些部署事实成立时配置 `fullAccessDisabled: true` 与 `confinementProbe.verified: true`。布尔值用于记录证据，无法改变 DSH 会话权限。仓库内 `scripts/probe-remote-entry-isolation.mjs` 与 `scripts/ssh-broker/probe/` 是该步的参考实现：在容器内复刻真实启用序列（install.sh、专用 profile、`dsh plugin add`、受限预设表），对 shell 公开执行器、`DSH_PTY_SESSION_ID` 标记的 Agent PTY 与 PTC `run` 三个入口在只读与工作区可写两种模式下逐一验证凭据根 `EACCES` 与 socket 拒绝，记录伪造 `sandbox/mode: danger-full-access` 的守卫拒绝，并审计磁盘重载会话（持久化工件重放仍受限、篡改声明被 `remote-profile-full-access` 拒）与同 UID 第二 profile（受限进程同样被拒、可解析 `danger-full-access` 的 profile 不得承载 Agent 入口）——Linux 实机原始结果见 `docs/reference/remote-entry-isolation-evidence-20261111.json`；早期协议 2 容器样例 `remote-entry-isolation-evidence.json` 仅作历史反例。
4. 在专用 profile 的 `cordis.patch.yml` 加入以下配置。broker 行通过证明后才可登记端点，并同时注册 `remote_copy` 和 `remote_bash`。只有 Registry 配置时，面板可显示清单，登记返回 `endpoint-unverifiable`。

```yaml
- id: permission
  config:
    presets:
      read-only:
        sandbox: read-only
        approval: ask
      workspace-write:
        sandbox: workspace-write
        approval: ask
- id: multi-root-registry
  config:
    sharedStorageRoot: !!js dshHomePath('storages')
    leasePath: !!js dshHomePath('storages/multi_root_workspace.lock')
    remoteEnvironments:
      enabled: true
      manifestPath: /etc/dsh-ssh-broker/manifest.json
- insert:
    - id: multi-root-remote-tools
      name: '@dsh-electron/dsh-plugin-multi-root-workspace/remote-tools'
      config:
        broker:
          config:
            socketPath: /run/dsh-ssh-broker/broker.sock
            brokerUid: 996 # 替换为安装器报告的 UID
            credentialRoot: /var/lib/dsh-ssh-broker
            fullAccessDisabled: true
            confinementProbe:
              verified: true
              evidence: '受限入口的部署验收记录编号'
```

专用 profile 须使用受限默认模式和全新的会话存储。校验实际组合的权限预设表，确认任何预设名称下都没有 `sandbox: danger-full-access`，并禁用该 UID 下其他可绕过沙箱的入口。工具行在默认模式或任何可选预设允许完全访问时拒绝挂载。

注意 profile patch 层的合并语义：同一行的 `config` 是**整体替换**而非按键合并，因此上面的 `multi-root-registry` 配置必须同时写出 `sharedStorageRoot`/`leasePath`——只写 `remoteEnvironments` 会让共享权威拿不到 medium，远端平面停在 `owner-without-remote-protocol`，工具行按设计拒绝挂载（不会静默降级）。

两边更新清单或更换协议版本时，先按下面的步骤关闭，再用新清单重启 broker 与 Host。相同环境 ID 无法代替清单一致性。

### 停用与回滚

现行入口探针记录 Full-access 解析的守卫拒绝，观察 raw/LSP-like/job-like spawn 接缝，并实机审计磁盘重载会话与第二 profile；不会为了反向对照而启动不受限命令。2026-11-11 起有 Linux 实机结果（`.87`，`linux/x64`，DSH `0.2.2-rc.1`）：磁盘重放的会话仍受限、篡改磁盘的 `danger-full-access` 声明被守卫拒、同 UID 第二 profile 的受限进程同样被 socket 拒而其预设表可含 `danger-full-access`——证明每个承载 Agent 入口的 profile 都必须受限（原始记录 `docs/reference/remote-entry-isolation-evidence-20261111.json`）。静态文本清点仅作清单对照；旧协议 2 JSON 仅保留作历史反例。

1. 停止把新任务派到该 profile，卸载可选工具行。该行拒绝新调用，解除端点校验器，取消并等待已进入的工具调用，然后关闭 broker 连接。已提交的文件应保留。记录 `unknown` 和暂存残留，按操作 ID 对账，确认前禁止重放。
2. 移除 Registry 行的 `remoteEnvironments` 配置，重启原 profile。若该部署不再提供远端操作，停止 broker 服务。保留本地 v1 记录及独立的远端存储域供核对。
3. 确认原生工具及本地根仍可用、远端工具和能力投影已消失，历史远端引用调用失败。需要重新启用时，重新证明凭据隔离及清单一致性，再按当前授权登记端点。

## 凭据隔离：本机凭据代理（ADR-0040）

**边界。** `src/remote/broker/` 是一个独立进程：它以部署方创建的专用账户运行，凭据根（0700）内只持有 SSH 私钥、`config`、`known_hosts`；ControlMaster 与 Helper 暂存位于 broker 账户自己的 `mkdtemp`（`/tmp/dsh-ssh-*`，0700、属 broker），Linux unit 上以 `PrivateTmp=yes` 隔离该目录。helper 连接的 `ControlMaster` 复用仅对 `confine`/`spawn` 生效：每个 SFTP 传输以 `ControlMaster=no`/`ControlPath=none` 独立建连——共享 master 会让一次会话的关闭波及其他在飞会话，破坏逐会话代次隔离。unit 文件本身未被容器内 systemctl stub 真实执行过，真实 `ActiveState`、临时目录属主/模式与 socket 私访探针仍属待补部署证据。Host 账户只通过一个 0750 目录里的 0660 Unix socket 连接。托管进程拒绝以 Host 账户启动（同 UID 不构成隔离），也拒绝清单中任何未声明 `credentialIsolation: "attested"` 的环境（`broker-same-uid` / `manifest-unattested`），除非测试显式放宽。

**协议。** `src/remote/broker/protocol.ts` 是一行一个 JSON 的有界协议（`protocol: 3`，行 ≤ 2 MiB，二进制字段 ≤ 256 KiB，每连接最多 32 个在飞请求、8 个进程）。方法只有八个：`openSftp`、`sftp`（realpath/lstat/open/read/write/close/remove/hardlink/fsync/dispose）、`open`、`confine`、`spawn`、`wait`、`terminate`、`dispose`。没有读取/导出密钥、修改配置、选择主机或任意 ssh 的方法；未知方法、未知字段、越界与超长行直接断连。协议 3 与 2 不互通：`hello` 增加必填的 `sshCapability`（broker 账户自己的 SSH 能力判定，Host 不代替，缺席/为否/畸形即拒绝）；`confine` 的 policy 只收 `read-only`/`workspace-write`（`danger-full-access` 在 schema 层拒绝），仅 `full` 实施返回一次性 `confinementToken`——绑定环境、**返回后的**受限 argv、代次与 workspaceRoot，TTL 30 秒、每连接至多 256 张，`spawn` 校验 cwd 仍在受限根内且拒绝非空 `LD_*`/`DYLD_*`/`NODE_OPTIONS`/`NODE_PATH`，票据校验失败或成功使用都消耗该票据（并发上限与代次检查先于票据消耗）；每条 `sftp` 请求携带服务端代次，过期代次拒绝且不路由旧句柄。请求超时即销毁连接并拒绝所有在飞请求；发布类操作在应答丢失时由 Host 报 `unknown`+reconcileId，重放从不允许。

托管部署的 `stdoutLimit` 与 `stderrLimit` 各至多 128 KiB。broker 为每个流保留最多两倍声明上限，Host 截断结果并报告相应标记。更大的预算在证明阶段返回 `broker-output-limit`。

**准入（配额与吊销）。** 每个环境绑定请求先过部署级准入门，再做方法分派：清单 `revocations` 中被吊销的环境除 `dispose`/SFTP `dispose` 外一律拒绝 `environment-revoked`；随后 `RollingQuota` 对该请求计一次操作并预扣 `sftp read`/`write` 的载字节，顶层（broker 全局）与环境级滚动窗口各扣一次，任一窗口耗尽即 `quota-exceeded`——拒绝先于任何远端动作，被拒请求不扣预算，窗口按到达时间滚动恢复。配额与吊销都是 broker 进程内判定、只随清单重启更新；确定拒绝（`quota-exceeded`/`environment-revoked`/`generation-changed` 等）在 Host 侧按确定失败上报，`SftpConnectionLost` 仍只保留给真失联的 `unknown`+reconcileId 语义。

**审计。** `auditPath` 开启时每个请求追加一行 `{time, connection, method, environment?, outcome}`（0600、broker 属主；启动时拒绝外国属主或 symlink 的占用文件）。broker 内建轮转：追加会使文件超过 `auditMaxBytes`（默认 8 MiB，`broker.json` 可调）时先把现有文件滚为 `audit.jsonl.1..auditKeep`（默认留 4，链式移位、最旧丢弃），再向新文件追加——`appendFileSync` 每次写重新 open，与外部 logrotate 也兼容。审计只记方法、环境与结果，不记负载内容。

**认证。** 托管进程对每条连接做内核 peer 认证（`SO_PEERCRED`/`LOCAL_PEERTOKEN`，Linux 上 `SO_PEERPIDFD` 钉住对端）：UID 必须等于配置的 Host UID，且对端不得处于沙箱或 `NoNewPrivs`（Agent 的命令正是这种对端）。Host 侧连接只校验托管进程的 UID（`allowRestricted`），因为托管进程的 confinement 是部署 unit 的事。`hello` 只在认证通道上返回协议版本、`brokerUid`、环境 ID 列表和清单摘要。摘要仅用于 Host 与 broker 的配置比对，不进入模型投影。

**Host 适配。** `src/remote/broker/client.ts` 的 `BrokerEnvironmentManager` 实现与官方 manager 相同的结构面（`deployment`、`open`/`openSftp`、代次、`markStale`、`disposeAll`），G2 的复制管线、`SshEndpointVerifier` 与 G3 的双准入命令合同不改。SFTP 是语义代理（句柄/数据以 base64 往返），命令的 `confine` 代次在 `spawn` 时复核，输出在退出时随 `exit` 事件（含 `scope` 确认）返回，因此 `remote_bash` 的 `scope-exited`/`exited` 与截断语义保持。

**证明。（`src/remote/broker/attest.ts`）** 在打开任何环境之前检查：Host 与 broker 都不是 root 且彼此不同 UID；部署记录了通过的 `confinementProbe`；部署声明排除了无沙箱的 Agent 执行；凭据根经 `lstat` 是非 symlink 的真实目录、属 broker、恰为 0700，随后 Host 对其 `R_OK` 必须是 `EACCES`/`EPERM`；socket 是 socket、属主为 broker、无 world 权限、目录为 broker 属主且无 world 权限；清单的模型可见复制目的满足 `destinationIsolation` 收窄（sftp 目的、chroot-sftp 声明、目的账户无 helper/exec 共享环境，`destination-isolation-required`）；连接后的 `hello` 协议、UID、清单摘要匹配且 `sshCapability.eligible` 为真。任一失败返回 `unavailable` 与稳定 code，保持远端 SSH 连接和工具关闭。`src/remote/tools.ts` 的 `broker` 配置走这条路径：异步证明通过后才注册 `remote_copy`/`remote_bash`/校验器/能力投影，失败只记一条 warn，工具保持缺席。

**部署。** `scripts/ssh-broker/install.sh` 以 root 创建账户、客户端组、0700 凭据根、0750 socket 目录、`/etc/dsh-ssh-broker/broker.json`（0640 root:broker）与 launchd/systemd unit。Linux unit 通过 `RuntimeDirectory` 在启动时重建 `/run` 下的 socket 目录。脚本不代部署方创建清单或授权远端公钥，并打印剩余步骤。

**已知限制。** 托管账户持有全部密钥；Host 与 Agent 同 UID，因此“Agent 不能到达 socket”只能由部署的沙箱路径拒绝证明（`confinementProbe`），不能由本代码自证；`danger-full-access` 下 Agent 进程不受本机沙箱约束，必须与这些凭据互斥。socket 是长驻接口，进程崩溃后由 unit 重启，但 Host 不自动重建连接；重新启用必须重走证明。同 UID 测试模式（`allowSameUidForTesting`/`allowRestrictedForTesting`）只用于协议测试，生产入口没有开关。

## 模型开放的前置阻断项（当前状态：评审通过；模型入口仍默认关闭，维护者签收待定）

以下均为开放前提，不是可选项；各项标注其实现与验证状态。2026-11-11 外部评审已复核通过（[评审报告](../reviews/2026-11-11-model-entry-evidence-review.md)），但 `remote-tools` 行仍不得自动开放：默认组合不启用 `remoteEnvironments`，是否为具体部署开启由维护者签收后决定。

- **配额**：**已实现并实机验证**（2026-11-11 `.87`）——broker 端 `RollingQuota` 滚动时间窗预算（清单 `environments[].quotas` 每环境 + 顶层 `quotas` 全局），对每个环境绑定请求计操作数、对 `sftp read`/`write` 计费载字节，耗尽即 `quota-exceeded`，窗口随到达时间滚动恢复、被拒请求不计费；单文件/单请求/在飞数上限不变。生产清单已声明预算（env `{1h,20000 ops,512GiB}`、全局 `{1h,50000 ops,1TiB}`），live 复验 6/6；on-disk 配额未实现（部署者可另以 systemd `CPUQuota`/`MemoryMax`/`TasksMax` 与文件系统配额作纵深，不构成替代）。
- **审计**：**已实现并实机验证**（2026-11-11 `.87`）——broker 内建按 `auditMaxBytes`（默认 8 MiB）+ `auditKeep`（默认 4）的链式轮转，`audit.jsonl.N` 0600 broker 属主，启动拒绝外国属主/symlink 占用；实机观察到 2.1MB 追加文件按预算轮转、`.1-.N` 保留上限成立；与外部 logrotate 兼容（`appendFileSync` 每次写都重新 open）。
- **吊销**：**已实现并实机验证**（2026-11-11 `.87`）——清单 `revocations` 显式拒绝清单随摘要双方校验，被吊销环境的一切环境绑定方法拒绝 `environment-revoked`（`dispose` 放行清理）；停用/移除绑定并重启 broker + Host 重新证明后，已记录的 `unknown` 只许对账，**绝不**重放。
- **部署证据**：Linux 实机 unit（`ActiveState`、PrivateTmp、socket 私访探针）已有 2026-11-10/11 协议 3 记录，配额/审计/吊销三项已于 2026-11-11 实机验证；GUI 宿主证据已于 2026-11-11 在本机 DSH Web 实测取得（[`remote-gui-host-evidence-20261111.json`](remote-gui-host-evidence-20261111.json)：attestation 通过、工具入模型目录、Workspace Folders 面板登记/撤销走真实 RPC、停用后能力消失）；跨平台矩阵已于 2026-11-11 实机补齐（[`remote-macos-matrix-evidence-20261111.json`](remote-macos-matrix-evidence-20261111.json)：macOS launchd 发起端（`install.sh` Darwin 分支实跑修复两处缺陷）、macOS 目标 `platform:"darwin"` 经完整 ssh+helper+seatbelt 路径、Windows 目标在清单解析即 `windows-target-unsupported`；原生 Windows 发起端按 ADR-0030 延后）。2026-11-11 外部评审复核了上述记录与 HEAD 回归，结论为证据达标（PASS），但默认组合仍保持关闭。
- **默认关闭与签收**：评审通过不等于开启。默认 `cordis.patch.yml` 不包含 `remote-tools`，也不配置 `remoteEnvironments`；开启仅限维护者签收后的具体部署专用 profile。2026-11-11 的运行时审计已在 `.87` 上核实 `remote-exp`/`stock-exp` 均只有受限预设、伪造 `danger-full-access` 被守卫拒、无第三个 profile（[`remote-profile-audit-20261111.json`](remote-profile-audit-20261111.json)），`stock-exp` 已不再是 unpatched 状态；签收时确认不新增 unrestricted profile/Agent 入口，并按“停用与回滚”步骤保留退路。
