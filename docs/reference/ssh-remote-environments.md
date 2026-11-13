# SSH 远端环境（个人/团队/加固三档托管）

> 实验性、默认关闭。本文件是 ADR-0041 的 Host 侧运行参考；控制面语义（准入、状态机、remote-1 协议）见 [multi-environment-control-plane.md](./multi-environment-control-plane.md)。

## 托管档位

`multi-root-remote-tools` 设置的 `mode` 字段决定凭据托管方式：

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
