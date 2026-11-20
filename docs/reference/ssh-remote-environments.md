# SSH 远端环境（个人/团队/加固三档托管）

> 实验性、默认关闭。本文件是 ADR-0049 的 Host 侧运行参考；控制面语义（准入、状态机、remote-1 协议）见 [multi-environment-control-plane.md](./multi-environment-control-plane.md)。

## 托管档位

`multi-root-remote-tools` 设置的 `mode` 字段决定凭据托管方式。UI 入口在 Workspace Folders 面板的“管理 SSH 远端”对话框 →“模式设置”Tab（`src/client/ssh-panel.tsx`，控件见 `src/client/remote-custody.tsx`）；插件设置卡只保留启用开关。

| 档位 | 凭据 | 部署证明 | 说明 |
| --- | --- | --- | --- |
| `personal`（默认） | 用户 `~/.ssh` 别名或插件凭据根 | 无 | Host 进程内直跑官方 SSH 栈，环境在清单内视为 `credentialIsolation: unattested`；不装 profile guard，不拒绝 `danger-full-access`。 |
| `team` | 部署 broker | 放宽 | `attestBroker(mode: 'team')`：跳过 `confinement-unproven`、`full-access-unrestricted` 与独立写者检查；`chroot-sftp` 目的隔离保留。 |
| `hardened` | 部署 broker | 全量 | ADR-0048 原路径，全部证明与 profile guard 保留。 |

未知或非法的 `mode`/`team` 值使该次读取按 `enabled:false` 处理并记一条警告（fail closed）。`team` 字段（`manifestPath`/`socketPath`/`brokerUid`/`credentialRoot`）只对 team 模式生效并逐项覆盖 registry 行的 `broker.config`；hardened 只读行配置。

## 文件布局与权限

- 插件级连接文件由 `remoteEnvironments.personalPath` 指定，默认为 `$DSH_HOME/storages/multi_root_workspace.remote-personal.json`。格式为 `{ schemaVersion: 2, revision, environments[] }`。环境保存目标、主机指纹、凭据引用、Helper 与传输/执行能力上限，远端目录由绑定单独保存。
- Workspace Root 绑定由 Host 写到 `<personalPath>.bindings.json`，格式为 `{ schemaVersion: 1, revision, bindings[] }`。绑定按本地 `primary`、`environmentId`、`rootId` 唯一标识，包含远端路径、动作与传输对端。一个 Workspace 可在同一环境绑定多个互不重叠的目录。新建或更新的绑定带 Host 生成的 `bindingId`，解除后重新添加同名绑定需要重新登记。
- 两个文件都必须是当前 uid 拥有的普通文件，非符号链接，权限至多 0600，父目录不得由 group/other 写，位置须在所有绑定的本地主根之外。连接文件缺失时，整个 personal 配置视为空；v2 连接文件存在时，绑定文件必须可读并通过保护检查。
- 两个文件共用 `<basename>.lock` 的内核租约与 CAS，当前 revision 取两份文件的最大值。读取 v1 合并文件时剥离环境里的 `workspace`，保留已保存的绑定路径与权限。首次写入先准备绑定文件，再原子替换为 v2 连接文件。在这之后，每个变更只原子替换它所属的文件。
- 凭据根由 `remoteEnvironments.credentialRoot` 指定，默认 `$DSH_HOME/storages/multi_root_workspace.ssh`。目录必须为当前 uid 所有且权限为 0700，否则返回 `credential-root-unsafe`。内部有 `credentials.json`、`keys/<id>` 与公钥、`secrets/<id>`、生成的 `ssh_config` 与 `known_hosts` 以及 `askpass.sh`。
- 每次远端 snapshot/list/admit/add/remove 前，`refreshPersonal()` 检查两个文件的保护和内容。配置损坏、语义非法或保护失效会使控制面进入 `config-invalid`，清空清单和摘要、断开 owner/follower 的远端信道。修复后可重载。清单摘要改变时 owner 换摘要重听 `remote-1`，follower 断开重连；受变更影响的已登记授权须重新核验。
- personal Helper 在目录核验或获准执行时取该绑定的远端目录作为工作区；连接按环境和目录分别缓存。旧 Helper 绑定首次升级会因其清单内容变化而需要重新登记。team/hardened 继续使用部署清单的 Helper 启动路径。

## RPC 端点与拒绝码

面板通道 `PANEL_CHANNEL` 上的 `ssh*` 端点（`src/remote/personal-contract.ts`）：每个请求携带 `sessionId`，Host 由会话解析主根；未知字段即 `panel/bad-request`。所有端点在开关未开或 `mode !== 'personal'` 时拒绝 `remote-personal-unavailable`；所有变更端点返回刷新后的 `sshState`。

`sshState`、`sshCredentialGenerate`、`sshCredentialImport`、`sshCredentialPassword`、`sshCredentialRemove`（`credential-in-use`）、`sshConfigAliases`（只读：本机 `~/.ssh/config` 的字面 `Host` 别名，跳过通配/否定项，读取失败返回空数组）、`sshListDirectories`（只读：按 `environmentId` 经 SFTP 列目录，返回 `{ path, parent, entries: [{ name, path }] }`，只含目录名与路径、最多 500 条；managed 环境以 `-F <credentialRoot>/ssh_config` 连接，因此未链接 `~/.ssh/config` 也可浏览；错误统一为 `remote-path-listing-failed`，Host 原文随错误显示）、`sshHostKeyScan`（直连 `hostname`/`port` 触网探测，返回 60 秒有界令牌，`host-key-token-expired` / `host-key-mismatch`；`alias` 形式经 `ssh -G` 在 Host 解析并返回用户 known_hosts 指纹与解析出的 endpoint，不触网、无令牌）、`sshEnvironmentSave`（托管凭据需 `hostKeyToken` + `fingerprint`；**例外**：target 身份（hostname/port/user）与 managed `credentialId` 均未变、且提交的 `fingerprint` 等于已记录 `hostKey` 时，环境元数据或能力更新可复用已记录指纹而不带 token；`ssh-config` 凭据的指纹必须匹配用户 known_hosts；带 `exec` 的保存只在 helper 已安装且目标身份未变时允许，否则 `exec-requires-helper`，在消耗扫描令牌与写 `known_hosts` 之前拒绝）、`sshEnvironmentRemove`（仍有绑定时为 `environment-in-use`）、`sshEnvironmentTest`、`sshHelperInstall`（`helper-hash-mismatch`）、`sshAccessKeyInstall`、`sshBindingSave`（主根由 Host 注入，校验远端目录）、`sshBindingRemove`、`sshConfigLink`。

无任何端点返回私钥或密码字节。

## 托管 ssh_config 与 Include 链接

凭据根内的 `ssh_config`（0600）为每个 managed 环境生成一个块：

```sshconfig
Host dsh-<environmentId>
  HostName <hostname>
  Port <port>
  User <user>
  IdentityFile "<credentialRoot>/keys/<accessKeyId ?? credentialId>"
  IdentitiesOnly yes
  UserKnownHostsFile "<credentialRoot>/known_hosts"
  GlobalKnownHostsFile /dev/null
  StrictHostKeyChecking yes
  BatchMode yes
  ForwardAgent no
  UpdateHostKeys no
```

生成的路径按 ssh_config 规则引用和转义，拒绝换行/NUL；支持凭据根含空格。OpenSSH 的 `-G` 会移除引号，因此 Host 仅在完整字段与已知托管 known_hosts 路径一致时将其保留为单个文件，不用预期路径覆盖其他解析结果。

`sshConfigLink` 在 `~/.ssh/config` **首行**写入 `Include "<credentialRoot>/ssh_config"`（先备份为 `config.dsh-backup-<时间戳>`，幂等）。未链接而使用 managed 环境时连接报 `ssh-config-not-linked`。

SFTP 使用独立的 SSH 子进程，同样在命令行强制 `StrictHostKeyChecking=yes`、`ForwardAgent=no`、`UpdateHostKeys=no`，并关闭 ControlMaster/ControlPath；用户别名配置不能放宽这些参数。

## Helper 安装与密码访问密钥引导

- Helper：远端执行 `npm install --prefix ~/.dsh-helper/<ver> @deepseek-ai/dsh-ssh@<Host 同版>`，再比较远端 `helper.js` 的 SHA-256 与 Host 本机文件；一致才写入 `helper` 字段（`protocol` 取上游 `SSH_PROTOCOL_VERSION`）。远端 node 探测容忍缺失（`command -v node || true`），缺 node 或路径非绝对时报 `helper-node-missing`；node/`$HOME`/sha256 三个秒级探测在连接瞬断时自动重试一次，`npm install` 不重试；外部命令失败的报错携带退出码/信号与 stderr（截断），不再只剩裸 `Command failed:`。
- 编辑连接：派生的 `accessKeyId` 由 Host 从已保存记录保留，前端无需回传；仅 environmentId、hostname/port/user、credentialId 与已确认主机指纹均未变化时继承。改变身份后必须重新安装访问密钥，不能通过保存请求移植旧密钥。
- 密码引导：为该环境生成访问密钥后，以 `SSH_ASKPASS`（凭据根内 0700 脚本，只读取 `DSH_SSH_SECRET_FILE`）+ `SSH_ASKPASS_REQUIRE=force` + `BatchMode=no` 用密码登录一次，把公钥追加到远端 `authorized_keys`；此后连接一律走访问密钥。

## 模式切换

切换 `mode` 走 `configureRemote`：远程域与 `remote-1` 监听按旧事实拆除，新模式下重读清单来源（personal → `personalPath`；team/hardened → `manifestPath` 覆盖或行配置），再按当前 authority 重开 owner/重连 follower。摘要变化后既有授权一律 withheld，需重新登记。工具子树的重挂载键是 `mode` + 全部生效 team broker 事实（manifestPath/socketPath/brokerUid/credentialRoot）+ 清单摘要——即使摘要不变，模式或 broker 事实一变也会拆除旧子树、重新证明并重挂（hardened 的 profile guard 不会带进 team）。因控制面未 `ready`（或 broker 不可用）而早退的挂载不算挂载成功：不占用重挂载键，`ready` 翻转或下一次远端变更时按现状重挂，登记用的端点校验器不会永久缺席。

设置写入走 Host 的 `settings` 服务；旧版 `configure` 路径没有 `setSource` 推送，行必须通过 `settings.describe()` 读取实时值，否则只有重启后 loader 重新组合才生效（本页“实时开关”回归覆盖）。

## follower 与 remote-1

Registry 的 owner 是唯一打开远程域和 `remote-1` 监听的 Host。若另一个 DSH 实例持有 lease，但它的 profile 没有挂载 `multi-root-remote-tools`（例如桌面端主插件仍是 mainline），follower 的 `connectFollower` 会收到 `registry authority is not ready`；面板显示 `remote.status.ownerWithoutRemotePlane` 的可操作提示。重启 follower 不能改变 owner；需要退出另一个实例，或让启用 SSH 的 profile 成为唯一 Host。

## GUI 管理面板（个人模式）

GUI 入口有两处：

- **插件详情设置卡**（`RemoteSwitchRow`）：只保留开关与启用风险确认。开启后 Host 的远程控制面按当前 `mode` 启动；开关关闭立即卸载。
- **Workspace Folders 面板远端区块**（`src/client/WorkspaceFoldersAction.tsx`）提供「管理 SSH 远端…」与个人模式的「管理远端 Root 绑定」两个入口。远端工作区列表与主要/附属工作目录共用 `WorkspaceRow`，显示平台、登记状态、`rootId` 与权限。可复制位置在 personal 模式为 `user@host:port/path`，部署清单为 `user@host/path`。行尾登记或撤回已核验的授权；解除绑定通过绑定对话框完成。

### SSH 远端管理对话框

独立对话框 `SshManagementDialog`（`src/client/ssh-panel.tsx`）由 ui-primitives `Modal` 承载，经 `src/client/ssh-client.ts` 调 `ssh*` 端点；Tab 条优先使用 `SegmentedTabs`，旧运行时降级为同 DOM 契约的本地 tablist。

**控件与布局。** 表单文本输入使用 primitives `Input`，动作按钮使用 `Button`，平台/helper/状态徽标使用 `Tag`（三者从 0.1.5 起可用）。`Checkbox` 与 `SegmentedControl` 自 `0.1.7-alpha.1` 起使用 primitives，旧版本回退为同语义的本地自绘控件（`.mrfw-sshCheckbox` / `.mrfw-sshRadioOption`）。宿主没有 Select primitive，原生 `<select>` 使用固定 32px 高的 `.mrfw-sshSelectControl`。字段采用两列 grid + 持久 label；对话框内不再使用为横向行设计的 `.mrfw-input`——其 `flex: 1 1 220px` 在纵向容器里会变成 220px 高度基准，曾把输入框拉成巨块。

三个 Tab，另有一个独立的“添加连接”Dialog：

**添加连接 Dialog** 从「已有连接」打开。选择本机 ssh-config 条目或插件托管凭据，填写显示名、环境 ID、平台与目标。主机钥扫描结果经弹窗确认后，保存连接并返回「已有连接」。本机来源可从 `sshConfigAliases` 选择，托管来源可从嵌套的凭据管理对话框添加凭据。

1. **已有连接** 提供连接测试、Helper 安装、访问密钥安装、SSH 配置链接与连接编辑。连接编辑可设置命令执行和文件传输的可用性，每条绑定再单独选择权限。删除仍被绑定的连接会返回 `environment-in-use`。team/hardened 显示部署清单的只读列表。
2. **SSH Key**：personal 显示凭据行（标签、类型、指纹、复制公钥、行内删除）和三个添加表单（生成密钥 / 导入私钥+可选口令 / 保存密码）。秘密输入**提交后立即清空**（无论成败），永不由状态回填；访问密钥（`purpose: 'access-key'`）不在 Key 列表重复出现，而显示在其所属环境下。team/hardened 说明凭据由部署 broker 托管，GUI 不读取、不创建。
3. **模式设置**：复用 `src/client/remote-custody.tsx` 的三档单选、team 四个 broker 字段与降级风险确认，写入同一个 `multi-root-remote-tools` form 与 CAS revision，不另建写入路径；同时说明档位如何决定“添加连接”的引导方式（personal 图形化表单、team 部署清单 + broker、hardened 部署 profile + 全量证明），并提供切到“已有连接”的按钮——添加连接的入口在该 Tab，不在模式页。档位是 **Host 级**（决定凭据由谁持有与 remote-1 的来源）。

### Workspace Root 绑定对话框

从 Workspace Folders 打开 `SshWorkspaceBindingsDialog`。选择已有连接，填写 Root ID、远端路径和允许的动作。可以通过只读 SFTP 选择目录，也可以手动输入规范化的 POSIX 绝对路径。本地传输对端可选 `primary` 和可用附加根的 `aliasId`。保存后在 Workspace Folders 的对应行登记。绑定对话框可编辑或解除一条绑定，其他绑定和 SSH 连接独立保留。

连接和绑定变更携带当前 `revision`。发生 CAS 冲突时刷新 `sshState` 后可重试，表单保留待提交内容。会话切换使旧请求的响应失效。已确认保存的连接无需完成后续 Workspace 操作。

**开关默认值**（GUI 勾选"允许命令执行"/"允许文件传输"时写入的完整节，见上文文件 schema）：

```jsonc
// exec
{ "shell": ["/bin/sh", "-c"], "env": { "PATH": "/usr/local/bin:/usr/bin:/bin" },
  "maxTimeoutMs": 600000, "stdoutLimit": 1048576, "stderrLimit": 262144, "terminateGraceMs": 2000 }
// transfer
{ "maxBytes": 268435456, "timeoutMs": 600000 }
```

所有变更请求携带当前 `revision`；`personal-config-conflict` 时前端先重取 `sshState` 再显示本地化冲突文案。服务端错误一律经 `error.*` 本地化渲染。

exec 与 transfer 独立授权：执行前用 helper 的只读受限 stat/realpath 探针分别验证根与 cwd；无需 transfer 配置或 SFTP 发布扩展。重定向目录和越界 cwd 在命令准备前拒绝。

## 在飞命令撤权与清理

`remote_bash` 从 spawn 返回 handle 起观察取消、超时与授权变化（包括尚未收到启动确认的阶段）。本 Host 的撤权通知立即触发重新准入；同时每 250ms 向 Registry owner 重新准入，覆盖跨 Host 撤权、会话降为只读和配置失效。复核等待超过 1 秒也按撤权处理。任何准入失败、epoch、策略、连接代次或授权存储 revision 变化均只发送一次 terminate；revision 变化保守终止该存储上的在飞命令，防止两次观察间 remove+re-add 恢复旧操作。

终止原因返回 `termination: revoked | cancelled | timeout`。在 `terminateGraceMs` 内仍无法确认结果则返回 `unknown` 和 reconcileId，不无限等待、不重新执行。启动确认尚未到达时传输断开同样立即返回 `unknown`：不等待一个不会再来的确认，也不发送 terminate，因为启动是否发生本身未知。通知和轮询只是失效检测，不能代替每次新操作的正式准入；网络和调度延迟下不承诺撤权瞬间远端停止。

## 传输截止时间

`transfer.timeoutMs` 是一次复制的总 I/O 预算：包含准入、连接/握手、预检、读取/写入、回读校验和发布，不在 staging 开始时重新计时。取消或超时会使待决调用结束，并废弃正在等待应答的 SFTP 通道；迟到连接立即关闭，不继续复制。清理使用独立且共享的 1 秒预算；断开的代次不能按路径删除暂存文件，报告 residual/unknown。CREATE 或 LINK 发出后缺少应答时返回 unknown 和 reconcileId；LINK 已确认、仅清理失败时仍返回 committed 与残留状态。
