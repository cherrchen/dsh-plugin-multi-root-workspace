# SSH 远端环境（个人/团队/加固三档托管）

> 实验性、默认关闭。本文件是 ADR-0041 的 Host 侧运行参考；控制面语义（准入、状态机、remote-1 协议）见 [multi-environment-control-plane.md](./multi-environment-control-plane.md)。

## 托管档位

`multi-root-remote-tools` 设置的 `mode` 字段决定凭据托管方式。UI 入口在 Workspace Folders 面板的“管理 SSH 远端”对话框 →“模式设置”Tab（`src/client/ssh-panel.tsx`，控件见 `src/client/remote-custody.tsx`）；插件设置卡只保留启用开关。

| 档位 | 凭据 | 部署证明 | 说明 |
| --- | --- | --- | --- |
| `personal`（默认） | 用户 `~/.ssh` 别名或插件凭据根 | 无 | Host 进程内直跑官方 SSH 栈，环境在清单内视为 `credentialIsolation: unattested`；不装 profile guard，不拒绝 `danger-full-access`。 |
| `team` | 部署 broker | 放宽 | `attestBroker(mode: 'team')`：跳过 `confinement-unproven`、`full-access-unrestricted` 与独立写者检查；`chroot-sftp` 目的隔离保留。 |
| `hardened` | 部署 broker | 全量 | ADR-0040 原路径，全部证明与 profile guard 保留。 |

未知或非法的 `mode`/`team` 值使该次读取按 `enabled:false` 处理并记一条警告（fail closed）。`team` 字段（`manifestPath`/`socketPath`/`brokerUid`/`credentialRoot`）只对 team 模式生效并逐项覆盖 registry 行的 `broker.config`；hardened 只读行配置。

## 文件布局与权限

- 个人配置：`remoteEnvironments.personalPath`（默认包内为 `$DSH_HOME/storages/multi_root_workspace.remote-personal.json`）。绝对路径、普通文件非 symlink、属当前 uid、`mode & 0o077 == 0`、父目录属当前 uid 且不可被 group/other 写、不得位于任何绑定的本地 primary 内。**文件缺失不是错误**：视为空清单（无环境、无绑定），控制面照常进入 `ready`。
- 凭据根：`remoteEnvironments.credentialRoot`（默认 `$DSH_HOME/storages/multi_root_workspace.ssh`）。0700、属当前 uid，否则 `credential-root-unsafe`。内部：`credentials.json`（0600 元数据）、`keys/<id>` + `keys/<id>.pub`、`secrets/<id>`（0600）、生成的 `ssh_config` 与 `known_hosts`、`askpass.sh`（0700）。
- 配置文件字段：`{ schemaVersion: 1, revision, environments[], bindings[] }`；绑定复用部署清单 binding schema。所有写操作以 `savePersonalConfig` 做 CAS：磁盘 `revision` 与请求的 `revision` 不符即 `personal-config-conflict`。
- 变更检测：每次远端 snapshot/list/admit/add/remove 之前，`refreshPersonal()` 按 stat 身份（dev/ino/size/mtimeMs）比较；变化即重载，摘要变化时 owner 换摘要重听 `remote-1`（域保持打开）、follower 断开重连；既有授权按新清单裁决（摘要变化 → withheld），不迁移。

## RPC 端点与拒绝码

面板通道 `PANEL_CHANNEL` 上的 `ssh*` 端点（`src/remote/personal-contract.ts`）：每个请求携带 `sessionId`，Host 由会话解析主根；未知字段即 `panel/bad-request`。所有端点在开关未开或 `mode !== 'personal'` 时拒绝 `remote-personal-unavailable`；所有变更端点返回刷新后的 `sshState`。

`sshState`、`sshCredentialGenerate`、`sshCredentialImport`、`sshCredentialPassword`、`sshCredentialRemove`（`credential-in-use`）、`sshHostKeyScan`（60 秒有界令牌，`host-key-token-expired` / `host-key-mismatch`）、`sshEnvironmentSave`（托管凭据需 `hostKeyToken` + `fingerprint`；`ssh-config` 凭据的指纹必须匹配用户 known_hosts）、`sshEnvironmentRemove`、`sshEnvironmentTest`、`sshHelperInstall`（`helper-hash-mismatch`）、`sshAccessKeyInstall`、`sshBindingSave`（主根由 Host 注入）、`sshBindingRemove`、`sshConfigLink`。

无任何端点返回私钥或密码字节。

## 托管 ssh_config 与 Include 链接

凭据根内的 `ssh_config`（0600）为每个 managed 环境生成一个块：

```sshconfig
Host dsh-<environmentId>
  HostName <hostname>
  Port <port>
  User <user>
  IdentityFile <credentialRoot>/keys/<accessKeyId ?? credentialId>
  IdentitiesOnly yes
  UserKnownHostsFile <credentialRoot>/known_hosts
  GlobalKnownHostsFile /dev/null
  StrictHostKeyChecking yes
  BatchMode yes
  ForwardAgent no
  UpdateHostKeys no
```

`sshConfigLink` 在 `~/.ssh/config` **首行**写入 `Include "<credentialRoot>/ssh_config"`（先备份为 `config.dsh-backup-<时间戳>`，幂等）。未链接而使用 managed 环境时连接报 `ssh-config-not-linked`。

## Helper 安装与密码访问密钥引导

- Helper：远端执行 `npm install --prefix ~/.dsh-helper/<ver> @deepseek-ai/dsh-ssh@<Host 同版>`，再比较远端 `helper.js` 的 SHA-256 与 Host 本机文件；一致才写入 `helper` 字段（`protocol` 取上游 `SSH_PROTOCOL_VERSION`）。
- 密码引导：为该环境生成访问密钥后，以 `SSH_ASKPASS`（凭据根内 0700 脚本，只读取 `DSH_SSH_SECRET_FILE`）+ `SSH_ASKPASS_REQUIRE=force` + `BatchMode=no` 用密码登录一次，把公钥追加到远端 `authorized_keys`；此后连接一律走访问密钥。

## 模式切换

切换 `mode` 走 `configureRemote`：远程域与 `remote-1` 监听按旧事实拆除，新模式下重读清单来源（personal → `personalPath`；team/hardened → `manifestPath` 覆盖或行配置），再按当前 authority 重开 owner/重连 follower。摘要变化后既有授权一律 withheld，需重新登记。

设置写入走 Host 的 `settings` 服务；旧版 `configure` 路径没有 `setSource` 推送，行必须通过 `settings.describe()` 读取实时值，否则只有重启后 loader 重新组合才生效（本页“实时开关”回归覆盖）。

## follower 与 remote-1

Registry 的 owner 是唯一打开远程域和 `remote-1` 监听的 Host。若另一个 DSH 实例持有 lease，但它的 profile 没有挂载 `multi-root-remote-tools`（例如桌面端主插件仍是 mainline），follower 的 `connectFollower` 会收到 `registry authority is not ready`；面板显示 `remote.status.ownerWithoutRemotePlane` 的可操作提示。重启 follower 不能改变 owner；需要退出另一个实例，或让启用 SSH 的 profile 成为唯一 Host。

## GUI 管理面板（个人模式）

GUI 入口有两处：

- **插件详情设置卡**（`RemoteSwitchRow`）：只保留开关与启用风险确认。开启后 Host 的远程控制面按当前 `mode` 启动；开关关闭立即卸载。
- **Workspace Folders 面板远端区块**（`src/client/WorkspaceFoldersAction.tsx`）：只保留远端工作区列表与 SSH 管理入口。标题行显示托管档位徽标（`RemotesView.custodyMode`）；列表沿用附属工作目录的行样式（名称、平台徽标、登记状态、`rootId · path`、当前能力），保留登记/移除动作。列表上方是两枚入口：
  - `panel.remoteAdd`（添加 SSH 远端…）：打开管理对话框的“添加连接”Tab；
  - `panel.remoteManage`（管理 SSH 远端…）：打开管理对话框的“已有连接”Tab。

  远端列表的平台徽标显示实际系统名称（Linux / macOS），不是清单里的 `linux`/`darwin`。

### SSH 远端管理对话框

独立对话框 `SshManagementDialog`（`src/client/ssh-panel.tsx`）由 ui-primitives `Modal` 承载，经 `src/client/ssh-client.ts` 调 `ssh*` 端点；Tab 条优先使用 `SegmentedTabs`，旧运行时降级为同 DOM 契约的本地 tablist。四个 Tab：

1. **添加连接**：personal 档位显示分步表单——连接目标（环境 ID、显示名、hostname、port、user、平台）→ 凭据（ssh-config 别名或托管凭据；无托管凭据时可直接跳到 SSH Key Tab）→ 远端目录与能力（workspace、exec/transfer）→ 主机密钥（“扫描主机钥”→ 指纹单选）。保存沿用 `sshEnvironmentSave` 的 revision、`hostKeyToken` + `fingerprint` 语义；保存成功后草稿与扫描状态清空，连接出现在“已有连接”，但远端工作区仍需在 Workspace Folders 列表中显式登记。team/hardened 显示部署清单/broker 引导，不渲染个人表单，并提供“打开模式设置”入口；控制面未 `ready` 时显示不可用原因。
2. **已有连接**：personal 显示链接横幅（managed 环境存在且 `linked === false` 时，按钮调 `sshConfigLink`）、已保存环境行（名称/ID、实际平台名、helper、`user@host:port`、workspace、凭据来源、访问密钥）、测试连接/安装 helper/安装访问密钥/编辑/行内删除；编辑复用添加表单。其下是“本项目绑定”：行显示环境、rootId、远端路径、动作与传输，本地传输对端恰为 `primary` 加各可用根的 `aliasId`。team/hardened 显示部署清单中的端点只读列表与登记状态。
3. **SSH Key**：personal 显示凭据行（标签、类型、指纹、复制公钥、行内删除）和三个添加表单（生成密钥 / 导入私钥+可选口令 / 保存密码）。秘密输入**提交后立即清空**（无论成败），永不由状态回填；访问密钥（`purpose: 'access-key'`）不在 Key 列表重复出现，而显示在其所属环境下。team/hardened 说明凭据由部署 broker 托管，GUI 不读取、不创建。
4. **模式设置**：复用 `src/client/remote-custody.tsx` 的三档单选、team 四个 broker 字段与降级风险确认，写入同一个 `multi-root-remote-tools` form 与 CAS revision，不另建写入路径；同时说明档位如何决定“添加连接”的引导方式（personal 图形化表单、team 部署清单 + broker、hardened 部署 profile + 全量证明）。档位是 **Host 级**（决定凭据由谁持有与 remote-1 的来源）。

所有变更请求携带当前 `revision`；`personal-config-conflict` 时前端先重取 `sshState` 再显示本地化冲突文案。服务端错误一律经 `error.*` 本地化渲染。对话框关闭不影响 Workspace Folders 对话框；打开期间会话切换会清空旧会话的 `sshState` 并重新读取。

**开关默认值**（GUI 勾选"允许命令执行"/"允许文件传输"时写入的完整节，见上文文件 schema）：

```jsonc
// exec
{ "shell": ["/bin/sh", "-c"], "env": { "PATH": "/usr/local/bin:/usr/bin:/bin" },
  "maxTimeoutMs": 600000, "stdoutLimit": 1048576, "stderrLimit": 262144, "terminateGraceMs": 2000 }
// transfer
{ "maxBytes": 268435456, "timeoutMs": 600000 }
```

所有变更请求携带当前 `revision`；`personal-config-conflict` 时前端先重取 `sshState` 再显示本地化冲突文案。服务端错误一律经 `error.*` 本地化渲染。
