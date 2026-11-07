# 多执行环境 G1a：远端控制面参考

本文是 [G1a](../plans/active/2026-11-06-multi-environment-gates.md) 已实现控制面的稳定技术参考：部署清单格式、远端记录域、`remote-1` 协议入口、Host 侧准入接口及拒绝码。架构合同归 [ADR-0030](../decisions/ADR-0030-environment-and-root-identity.md)；验证结果与关卡状态只归[路线图总账](../plans/active/2026-09-12-multi-root-workspace.md#多执行环境-g1a-控制面2026-11-07)。本关**不含**任何 SSH 包、连接、端点校验器、面板、命令或模型工具：默认关闭，开启后也因没有校验器而无法登记远端根。

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

Host 启动时用 `node:fs` 直接读取（不经 `ctx.fs` 或工作区读路径）。POSIX 保护检查：文件与父目录不是 symlink、属当前 uid 或 root、不可被 group/other 写；清单不得位于任何被绑定的本地 primary 之内。格式为严格 JSON（未知键即拒绝）：

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
- `credentialIsolation: "attested" | "unattested"` 必填：ADR-0032 的部署者声明——Agent 是否确实无法触及连接凭据/套接字/配置/ssh 二进制；`"unattested"` 的连接仅在测试选项 `allowUnattestedForTesting` 下建立，生产路径不接受（当前 VPS 证据即 unattested：本地同 UID 持有私钥）。
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

`addRemote(primary, {environmentId, rootId})` 只接受这两个键；先在队列外调用经 `setRemoteEndpointVerifier()` 注入的校验器（本关生产环境没有，固定为 `endpoint-unverifiable`），平台不符为 `platform-mismatch`，入队后绑定摘要变化为 `binding-changed`，清单未授权为 `binding-not-authorized`。`removeRemote` 与 `remoteList` 在 follower 上经 `remote-1` 转发。

## `remote_bash` 合同（G3，仅测试组合）

`src/remote/exec.ts` 的 `runRemoteCommand` 与 `src/remote/exec-tool.ts` 的 `remoteBashTool` 不被任何生产行注册。参数 `{environmentId, rootId, cwdRelative?, command, timeoutMs}`；工具名、Session 与取消信号只取自调度。后端（G4 以后由连接管理器提供，测试为 fake）声明部署控制的 shell、环境变量、时限与 stdout/stderr 上限，实现 `confine` / `currentGeneration` / 同步 `spawn`。

1. **准入 A**：`purpose: exec` 的远端准入；校验后端存在（`backend-unavailable`）、`cwdRelative`（空或相对 POSIX，无 `.`/`..`/空段/NUL/反斜杠，`invalid-cwd`）与时限（`invalid-timeout`）；以 `workspace-write`、端点 displayPath 和真实 sessionId 调用 `confine`，非 `full` 为 `sandbox-unverified`。
2. **准入 B**：同一请求重新准入，比对 epoch、端点身份（displayPath、bindingDigest、verifiedTarget）、有效模式与后端代次，任一不同为 `admission-changed` 并丢弃 argv；`spawn` 只在 B 的回调内调用。A、B 之间的撤权使 B 拒绝且不调用 `spawn`。
3. **结果**：`not-started{code}`；`admitted-may-start`（spawn 抛错或 `started` 失败）；`exited`（观察到直接退出、托管范围未确认）与 `scope-exited`（`waitForExit` 确认）；`unknown{reconcileId}`（启动后断线）。超时与取消各只 `terminate()` 一次并标 `termination`；输出按上限截断并标 `truncated`；从不重连或重跑。

SSH 兼容门禁（`classifySshCapability`、`SUPPORTED_SSH_RELEASES`、宿主锚定的 `loadHostSshPackages`）的检查器落点见[基线参考](./multi-environment-baseline.md#ssh-兼容门禁落地清单)。

## 官方 SSH 栈接入（S3a，无用户入口）

`src/remote/ssh-environment.ts` 的 `SshEnvironmentManager` 把已验证清单环境变成一条 `SshEnvironment`：构造任何官方类之前依次过——SSH 门禁必须 `eligible`（`ssh-capability-absent:<reason>`）、环境必须 helper 传输（`transport-not-helper`）、`credentialIsolation` 必须 attested（否则须测试选项，`credential-isolation-unattested`）；随后 `ssh -G <别名>` 解析宿主身份（`user` 必须等于 `account`、`stricthostkeychecking` 必须 yes、`forwardagent` 必须为 no），所有 userknownhostsfile 合计恰一把主机钥且 `ssh-keygen -lf` 指纹等于 `hostKey`（`account-mismatch`/`host-key-mismatch`/`host-identity-unverifiable`）；再经 `loadHostSshPackages` 在独立 `Context` 中按 SessionProjectionRegistry→SandboxPolicyService(read-only)→SshConnection→SshFileSystem→SshSubprocessRuntime→SshSandboxProvider 挂载，`hello.platform` 不符即 `platform-mismatch` 并按逆序销毁。`open` 按环境记忆化（并发共享同一 Promise），返回 `{environmentId, generation, hello(净化字段), fs, sandbox, subprocess, dispose}`——从不暴露 Context、连接对象、套接字或 `ctx.ssh.request`；`dispose`/`markStale`/`disposeAll` 只影响单环境，重开产生新代次而不重连。

`src/remote/ssh-verifier.ts` 的 `SshEndpointVerifier` 以绑定路径为 `workspaceRoot` 执行只读 `full` 限定探针（远端 Node 打印 `{realpath, dev, ino, isDirectory}`），必须 isDirectory 且 realpath 等于声明路径（`endpoint-redirected`），注册目标为 `{kind: "object", value: "dev:ino"}`。`src/remote/ssh-exec-backend.ts` 的 `sshExecBackend` 把清单 `exec` 块映射为部署描述：`confine` 直通官方沙箱并携带环境代次，`currentGeneration` 取管理器当前代次（失联/已处置即永不匹配），`spawn` 无控制通道、收集双倍上限以便本地截断标志成立，`done` 的传输错误映射为 `RemoteConnectionLost` 并标记环境 stale。
