# SSH 远端环境：三种模式使用指南

English: [ssh-remote-environments.en.md](./ssh-remote-environments.en.md)

SSH 远端环境允许 Agent 通过显式工具 `remote_copy`（文件传输）和 `remote_bash`（命令执行）访问远端主机上的目录。该功能为**实验性功能，默认关闭**，支持按凭据托管与隔离强度切换三种模式：**个人（`personal`）**、**团队（`team`）** 和 **硬化（`hardened`）**。

> [!WARNING]
> **平台与版本前提**：
> - 仅支持 **Linux** 和 **macOS** 发起端，远端目标主机也仅支持 **Linux** 和 **macOS**（Windows 发起端和 Windows 目标目前均延后或不支持）。
> - 需要 DSH 运行时在 SSH 支持矩阵内（当前为 `0.2.2-rc.1` ～ `0.2.2-rc.5`），且宿主安装有对应的四个官方 SSH 可选包（`@deepseek-ai/dsh-ssh`、`dsh-fs-ssh`、`dsh-subprocess-ssh`、`dsh-sandbox-ssh`）。

---

## 一、三种模式对比与选型

| 维度 | 个人模式（`personal`，默认） | 团队模式（`team`） | 硬化模式（`hardened`） |
| --- | --- | --- | --- |
| **凭据持有方** | 本机 DSH Host 进程 | 独立操作系统账户下的 Broker 进程 | 独立操作系统账户下的 Broker 进程 |
| **隔离承诺** | **不承诺** Agent 拿不到密钥；同 UID 进程可触及凭据 | 放宽部署证明；Broker 保护密钥不被受限进程读取，但同 UID 的 `danger-full-access` 进程仍可绕过限制连接 Broker socket | **全量隔离证明**：唯一承诺“Agent 拿不到密钥”的模式；禁止 `danger-full-access`，强制启动 `remote-profile-guard` |
| **配置来源** | 面板 GUI 交互式管理（用户属主的个人配置文件） | root 保护的部署清单 + 面板内填写的 Broker 参数（或 profile 配置） | 仅限 root 保护的部署清单与专用 profile 配置（面板只读） |
| **复制目的要求** | 不要求 chroot；建议仅拉取或推送到自有目录 | `import` 写入目的端必须为声明 `destinationIsolation: "chroot-sftp"` 的 SFTP 账户（不检查独立写者） | 必须满足 `chroot-sftp` 且复制目的账户不得与执行/Helper 账户重叠（独立写者隔离） |
| **配额 / 审计 / 吊销** | 无 Broker 控制 | 支持清单 `quotas`、`revocations` 及 Broker 审计日志 | 完整支持清单 `quotas`、`revocations`、Broker 审计日志与入口隔离探针 |
| **适用场景** | 个人电脑、一次性 VM、可信 Agent | 多人共享构建机、有运维配合但希望免去全局 profile 锁定的环境 | 面向不可信任务或严格合规要求的生产环境 |

### 三档共有的安全边界

无论使用哪种模式，以下控制均保持生效：

1. 远端主机**不是**本地附加根，只能通过 `remote_copy` / `remote_bash` 显式操作，不会进入本地文件树、LSP 或指令注入。
2. 每次调用前都经过 Registry 的两段准入检查（操作前准备 + 真正执行/发布前二次复核）。
3. 会话处于 `read-only` 模式时，自动拒绝远端写入、命令执行以及向远端复制。
4. 远端目录必须先在本工作区**登记（Register）**后才能被模型使用；文件发布采用临时暂存 + 校验 + 原子硬链接（不覆盖已有文件）。

---

## 二、前置开启与模式切换

1. 打开侧栏 **插件（Plugins）** → 找到 **Multi-root Workspace** 详情页。
2. 在设置卡中找到 **SSH 远端环境**（带有黄色「实验性」标签），打开开关。
3. 阅读弹出的风险确认框，勾选确认后点击 **确认开启**（取消则保持关闭）。
4. 打开管理界面的两种方式：
   - **插件详情页**：开启后设置卡顶部会出现「**SSH 远端 → 管理**」按钮（此入口无需当前有活动会话，可管理全局连接与模式，但不能绑定工作区目录）。
   - **工作区面板**：点击侧栏底部的 **工作区目录（Folders）**（或新会话页工作区行右侧入口）→ 在「远端工作目录」区点击 **管理 SSH 远端…**。
5. 在对话框中切到 **模式设置（Mode）** 页签，选择 `个人（默认）`、`团队` 或 `硬化`。
   - **注意**：在开关已开启的状态下，从高隔离档位切换到低隔离档位（如 `硬化 → 团队` 或 `团队 → 个人`）会再次弹出风险确认框。

---

## 三、个人模式（Personal）设置与使用

个人模式完全在 GUI 中完成配置，无需 root 权限、独立系统账户或部署清单文件。

### 第 1 步：准备凭据（二选一）

- **方式 A：使用本机 `~/.ssh/config` 主机别名**
  - 确保本机 `~/.ssh/config` 中已配置好 `Host <别名>`（包含 `HostName`、`User`、`IdentityFile` 等），且目标主机钥已在你的 `~/.ssh/known_hosts` 中存在**唯一**匹配条目。
- **方式 B：使用插件托管凭据**
  1. 在「SSH 远端管理」对话框切到 **SSH Key** 页签（或在添加连接时点「管理凭据」）。
  2. 选择以下三种方式之一创建凭据：
     - **生成密钥**：输入名称，插件生成 ed25519 密钥对。创建后点击列表右侧的复制公钥图标，将其追加到远端主机的 `~/.ssh/authorized_keys`。
     - **导入私钥**：输入名称并粘贴私钥（加密私钥需同时提供口令，导入时会自动剥离口令并以 0600 权限保存在本机凭据根），同样确保公钥已授权给远端主机。
     - **保存密码**：输入名称和密码。保存后会在后续步骤中用密码登录一次，自动在远端安装专用访问密钥（`authorized_keys`），之后连接全部改为密钥认证。

### 第 2 步：添加连接

1. 切到 **已有连接** 页签，点击 **添加连接**。
2. **第 1 步（连接与主机密钥）**：
   - 凭据来源选择「本机 SSH 主机别名」或「托管凭据」，填写显示名、远端平台（Linux / macOS）及 `用户名@主机名:端口`（使用别名时端口和目标会在扫描时从 `ssh -G` 自动解析）。
   - 点击 **扫描并测试连接**，在弹出的主机密钥确认框中核对指纹后点击 **确认并保存**。
3. **第 2 步（连接设置）**：
   - **密码凭据**：先点击 **安装访问密钥**，使用刚才保存的密码登录一次并在远端写入访问密钥。
   - **托管凭据链接**：如果界面提示「尚未链接」，点击 **链接到 ~/.ssh/config**。插件会先备份原 `~/.ssh/config`，再在其首行写入一条 `Include` 指令以使托管别名生效（未链接前无法建立连接）。
   - **安装 Helper**（如需命令执行或对象级核验，推荐安装）：可先点 **检测 Node**，再点击 **安装 Helper**（插件会通过 SSH 在远端 `~/.dsh-helper/<版本>` 安装与宿主完全同版的 `@deepseek-ai/dsh-ssh` 并校验 `helper.js` 哈希；要求远端已安装 Node.js 且 `command -v node` 返回绝对路径）。
   - 勾选 **允许命令执行**（需 Helper 已安装）和/或 **允许文件传输**，点击 **完成**。

### 第 3 步：绑定目录到工作区并登记

连接是插件全局的，目录绑定则是按当前工作区保存的。**此步必须在有活动会话的工作区面板中完成**：

1. 打开侧栏 **工作区目录（Folders）**，在「远端工作目录」区点击 **管理远端 Root 绑定**。
2. 点击 **添加绑定**：
   - 选择已创建的 SSH 连接。
   - 输入远端绝对路径（例如 `/srv/work/app`），或点击 **UI 选择** 通过 SFTP 浏览挑选远端目录。
   - 勾选 **允许动作**：`读取`、`写入`、`执行`（`执行` 需连接已安装 Helper 并开启执行）。
   - 如需在本地与远端间使用 `remote_copy`，在 **本地传输** 中勾选对应本地根（`primary` 或可用附加根）的 **自本地根导入** / **导出到本地根**。
   - 点击 **保存绑定**。
3. 回到「工作区目录」面板的「远端工作目录」列表，找到刚才绑定的行，点击行尾 **…** 菜单 → **登记（Register）**。
   - 登记时会实际连接远端校验目录存在性及真实路径（不可为符号链接重定向）。状态变为「已登记」后，模型即可使用该目录。

> [!TIP]
> 删除不再需要的连接前，必须先在工作区绑定对话框中**解除绑定**，否则会报 `environment-in-use`。修改绑定权限或更新部署后状态变为「待重新登记（`withheld`）」时，再次从 `…` 菜单点击 **登记** 即可恢复。

---

## 四、团队模式（Team）设置与使用

团队模式由运维或管理员在本机预先部署独立的 **Credential Broker（凭据代理）** 守护进程和受 root 保护的部署清单，但**放宽**了硬化模式的三项强制要求：不要求在 profile 中全局禁止 `danger-full-access`、不要求提供 `confinementProbe` 入口隔离证明、也不强制 SFTP 复制目的账户与执行账户完全独立（即允许共享构建机上的同账户执行，只要复制目的端本身是 `chroot-sftp`）。

> [!NOTE]
> 团队模式与硬化模式仅支持在 **Linux** 或 **macOS** 上部署 Broker（POSIX 平台），Windows 不适用。

### 第 1 步：准备 Root 保护的部署清单（管理员操作）

与个人模式不同，团队模式不使用面板添加连接，而是由管理员以 `root` 编写部署清单（默认路径 `/etc/dsh-ssh-broker/manifest.json`，文件及其**每一级祖先目录**均须属 `root` 且不可被 group/other 写，不能是软链接，也不能位于任何已绑定的本地工作区内）：

```json
{
  "schemaVersion": 1,
  "configVersion": "2026-11-21.1",
  "environments": [
    {
      "environmentId": "team-build-01",
      "displayName": "Shared Build VM",
      "platform": "linux",
      "account": "dshbuild",
      "hostKey": "SHA256:<43位base64主机公钥指纹>",
      "namespace": "team-build-01",
      "transport": "helper",
      "helper": {
        "sha256": "<远端 helper.js 的 64 位十六进制 SHA-256>",
        "protocol": 3
      },
      "connection": {
        "host": "team-build-alias",
        "nodePath": "/opt/node-v24/bin/node",
        "helperPath": "/opt/dsh-helper/node_modules/@deepseek-ai/dsh-ssh/lib/helper.js",
        "workspace": "/srv/work/project"
      },
      "exec": {
        "shell": ["/bin/bash", "-c"],
        "env": { "PATH": "/usr/local/bin:/usr/bin:/bin" },
        "maxTimeoutMs": 60000,
        "stdoutLimit": 65536,
        "stderrLimit": 65536,
        "terminateGraceMs": 2000
      },
      "transfer": {
        "maxBytes": 268435456,
        "timeoutMs": 600000
      },
      "credentialIsolation": "attested"
    },
    {
      "environmentId": "team-sftp-dest",
      "displayName": "Chroot SFTP Drop",
      "platform": "linux",
      "account": "dshxfer",
      "hostKey": "SHA256:<43位base64主机公钥指纹>",
      "namespace": "team-sftp-dest",
      "transport": "sftp",
      "helper": null,
      "connection": { "host": "team-sftp-alias" },
      "transfer": {
        "maxBytes": 268435456,
        "timeoutMs": 600000,
        "destinationIsolation": "chroot-sftp"
      },
      "credentialIsolation": "attested"
    }
  ],
  "bindings": [
    {
      "primary": "/path/to/local/workspace",
      "environmentId": "team-build-01",
      "rootId": "app",
      "path": "/srv/work/project/app",
      "actions": ["read", "write", "exec"],
      "transfers": [
        { "direction": "export", "peer": { "environmentId": "local", "rootId": "primary" } },
        { "direction": "export", "peer": { "environmentId": "team-sftp-dest", "rootId": "out" } }
      ]
    },
    {
      "primary": "/path/to/local/workspace",
      "environmentId": "team-sftp-dest",
      "rootId": "out",
      "path": "/out",
      "actions": ["read", "write"],
      "transfers": [
        { "direction": "import", "peer": { "environmentId": "team-build-01", "rootId": "app" } }
      ]
    }
  ]
}
```

**团队模式清单关键点**：

- **目标账户区分**：如果某个绑定包含 `write` 且有 `import` 传输（即允许把文件推送到该远端目录），该环境**必须**使用 `"transport": "sftp"` 且在 `transfer` 中声明 `"destinationIsolation": "chroot-sftp"`（对应服务端应配置真实的 SSH ChrootDirectory + `internal-sftp` 限制）。
- **团队模式的放宽项**：若 `team-sftp-dest` 需要与执行环境共用相同 `namespace` 和 `account`，团队模式允许这样做；但仍建议尽量分开账户。若只需向远端执行命令或从远端导出（`export`）到本地，只需配置 `helper` 环境即可。
- **Output 上限**：Broker 托管下 `exec.stdoutLimit` 与 `exec.stderrLimit` 均不得超过 `131072`（128 KiB）。
- **`credentialIsolation`**：Broker 服务的环境必须声明为 `"attested"`。

### 第 2 步：安装独立依赖树并配置 Broker 服务（管理员操作）

Broker 不能与 DSH 宿主或 Agent 共享 `node_modules`，需用 `root` 安装到独立只读目录，然后运行包内自带的安装脚本：

```sh
# 1. 安装独立的 root 保护依赖树（版本须与宿主 DSH 精确一致，例如 0.2.2-rc.5）
mkdir -p /opt/dsh-broker && cd /opt/dsh-broker
pnpm init
pnpm add --save-exact /path/to/dsh-electron-dsh-plugin-multi-root-workspace-<version>.tgz \
  @deepseek-ai/dsh@0.2.2-rc.5 @deepseek-ai/cordis@4.1.0 \
  @deepseek-ai/dsh-ssh@0.2.2-rc.5 @deepseek-ai/dsh-fs-ssh@0.2.2-rc.5 \
  @deepseek-ai/dsh-subprocess-ssh@0.2.2-rc.5 @deepseek-ai/dsh-sandbox-ssh@0.2.2-rc.5
chown -R root:root /opt/dsh-broker && chmod -R a-w /opt/dsh-broker

# 2. 运行 install.sh 创建专用系统账户（默认 _dsh_ssh）、客户端组、0700 凭据根与 systemd/launchd 服务
#    注意：<dsh-host-user> 替换为实际运行 DSH 的普通用户名；macOS 下 Node 不能位于 /Users/* 内
sudo DSH_SSH_BROKER_JS=/opt/dsh-broker/node_modules/@dsh-electron/dsh-plugin-multi-root-workspace/lib/remote-broker.js \
     DSH_SSH_BROKER_MANIFEST=/etc/dsh-ssh-broker/manifest.json \
     DSH_SSH_BROKER_NODE=/usr/local/bin/node \
     /opt/dsh-broker/node_modules/@dsh-electron/dsh-plugin-multi-root-workspace/scripts/ssh-broker/install.sh <dsh-host-user>
```

> [!TIP]
> 运行完 `install.sh` 后，请记下终端输出的 **broker UID**、**凭据目录**（Linux 默认 `/var/lib/dsh-ssh-broker`，macOS 默认 `/usr/local/var/dsh-ssh-broker`）、**socket 路径**（Linux 默认 `/run/dsh-ssh-broker/broker.sock`，macOS 默认 `/usr/local/var/run/dsh-ssh-broker/broker.sock`）以及生成的公钥。如果 `install.sh` 将你的用户加入了新用户组（如 `dsh-ssh-clients`），**需要重新登录系统会话或重启 DSH 进程**使组权限生效。

### 第 3 步：配置 Broker 账户的 SSH 材料与远端授权

1. 将脚本打印的公钥（或你预置的私钥对应公钥）授权给远端主机对应账户的 `~/.ssh/authorized_keys`。
2. 如清单使用了 `helper` 传输，提前在远端对应账户的 `connection.helperPath` 路径安装与 Host 精确同版的 `@deepseek-ai/dsh-ssh`，并核对 `helper.js` 的 SHA-256 写入清单。
3. 在 Broker 账户家目录下配置 `~/.ssh/config`（权限 0600，属主为 Broker 账户）和带外核验过的 `known_hosts`（权限 0600）。Broker 会严格校验以下安全指令，**缺一不可**：

```sshconfig
Host team-build-alias
  HostName <fixed-hostname>
  User dshbuild
  IdentityFile <broker-owned-key-path>
  IdentitiesOnly yes
  StrictHostKeyChecking yes
  BatchMode yes
  ForwardAgent no
  UpdateHostKeys no
  UserKnownHostsFile <broker-owned-known_hosts>
  GlobalKnownHostsFile /dev/null
  KnownHostsCommand none
```

### 第 4 步：在 GUI 中填入团队参数并使用

与硬化模式必须修改 profile YAML 不同，团队模式可以直接在 DSH 界面中完成接入：

1. 确保在插件详情已开启 **SSH 远端环境**。
2. 打开 **工作区目录（Folders）** → **管理 SSH 远端…** → **模式设置**（或从插件详情「SSH 远端 → 管理」进入）。
3. 选择 **团队（Team）** 单选按钮。
4. 填写下方出现的四个字段：
   - **部署清单路径**（`manifestPath`）：例如 `/etc/dsh-ssh-broker/manifest.json`
   - **broker socket 路径**（`socketPath`）：例如 `/run/dsh-ssh-broker/broker.sock`（macOS 为 `/usr/local/var/run/dsh-ssh-broker/broker.sock`）
   - **broker 用户 UID**（`brokerUid`）：填 `install.sh` 输出的数字 UID（如 `996`）
   - **凭据目录**（`credentialRoot`）：例如 `/var/lib/dsh-ssh-broker`（macOS 为 `/usr/local/var/dsh-ssh-broker`）
5. 点击 **保存团队配置**。
   - 若 DSH 客户端侧未挂载配置表单或希望固化在 profile 中，也可由管理员直接在 profile 的 `cordis.patch.yml` 的 `multi-root-remote-tools` 行配置 `mode: team` 与 `team: { manifestPath, socketPath, brokerUid, credentialRoot }`。
6. 切到 **已有连接** 可只读查看清单中声明的连接；回到 **工作区目录（Folders）** 面板，在「远端工作目录」区找到对应绑定的条目，点击 **…** → **登记**。登记校验通过后，`remote_copy` 和 `remote_bash` 即对当前会话的 Agent 可用。

---

## 五、硬化模式（Hardened）设置与使用

硬化模式是唯一严格承诺「**Agent 拿不到 SSH 密钥且无法绕过沙箱直连 Broker**」的部署形态。它**无法通过 GUI 表单修改 Broker 参数**，必须由部署管理员通过专用受限 DSH Profile 配置，并附带部署层的入口隔离验证记录。

### 第 1 步：完成 Broker 与清单部署（含独立写者与配额/审计/吊销）

1. 按「团队模式」第 1～3 步完成独立依赖树、`install.sh`、Broker `~/.ssh/config` 与 `known_hosts` 的部署。
2. **严格目的隔离（独立写者）**：在 `manifest.json` 中，任何承担 `import` 写入目的的 `sftp` 环境，其 `namespace + account` **绝对不能**与任何 `transport: "helper"` 或带 `exec` 的环境相同（否则 `attestBroker` 会以 `destination-isolation-required` 拒绝挂载）。
3. **可选安全加固字段**（推荐在硬化清单中使用）：
   - `quotas`（顶层全局配额 & `environments[].quotas` 单环境配额）：限制滚动时间窗 `windowMs` 内的最大操作数 `maxOperations` 和最大字节数 `maxBytes`。
   - `revocations`：显式吊销列表 `[{ "environmentId": "...", "reason": "..." }]`，一旦写入并重启后，被吊销环境的所有操作立即拒绝 `environment-revoked`。
   - `/etc/dsh-ssh-broker/broker.json` 中的 `auditPath`、`auditMaxBytes`（默认 8 MiB）和 `auditKeep`（默认保留 4 份轮转日志）已由 `install.sh` 默认开启。

### 第 2 步：部署层禁止无沙箱执行并执行隔离探针

硬化模式要求运行 DSH 的同一个操作系统账号（Host UID）下，**所有能承载 Agent 入口的 Profile 都不得允许 `danger-full-access`**，防止 Agent 通过切换会话或子进程直接读取凭据根或连接 Broker socket。

1. 确认该 Host UID 下没有其他可让 Agent 启动非受限命令的入口或配置了 `danger-full-access` 的 profile。
2. 运行仓库内提供的隔离探针脚本（或等价的部署验证步骤）进行实机验证：
   - 验证 Agent shell、Agent PTY（带 `DSH_PTY_SESSION_ID`）和 PTC 在 `read-only` 与 `workspace-write` 模式下，读取 `credentialRoot` 返回 `EACCES`/`EPERM`，连接 `socketPath` 被拒绝。
   - 验证正常运行中的 Host 进程本身可以连上 `socketPath` 完成握手。
   - 保留验证记录编号或审计报告（参考 `scripts/probe-remote-entry-isolation.mjs` 与 `scripts/ssh-broker/probe/`）。

### 第 3 步：配置专用受限 Profile 的 `cordis.patch.yml`

使用一个全新的专用 profile（例如 `remote-exp`）与独立会话存储，将插件加入该 profile 后，在该 profile 的 `cordis.patch.yml` 中配置以下补丁层：

> [!IMPORTANT]
> Profile 补丁层对同一行 `config` 采用**整块替换**而非字段合并。因此重写 `multi-root-registry` 时，必须把 `sharedStorageRoot` 和 `leasePath` 一并写全；重写 `multi-root-remote-tools` 时也必须完整写出 `broker.config`。

```yaml
# 1. 限制权限预设表，绝不包含 danger-full-access
- id: permission
  config:
    presets:
      read-only:
        sandbox: read-only
        approval: ask
      workspace-write:
        sandbox: workspace-write
        approval: ask

# 2. 启用远端控制面并保留共享存储配置
- id: multi-root-registry
  config:
    sharedStorageRoot: !!js dshHomePath('storages')
    leasePath: !!js dshHomePath('storages/multi_root_workspace.lock')
    maxAdditionalRoots: 16
    backgroundRecovery: true
    remoteEnvironments:
      enabled: true
      manifestPath: /etc/dsh-ssh-broker/manifest.json

# 3. 显式指定 hardened 模式及经过验证的 broker 参数
- id: multi-root-remote-tools
  config:
    mode: hardened
    broker:
      config:
        socketPath: /run/dsh-ssh-broker/broker.sock
        brokerUid: 996 # 替换为 install.sh 报告的实际 UID
        credentialRoot: /var/lib/dsh-ssh-broker
        fullAccessDisabled: true
        confinementProbe:
          verified: true
          evidence: 'deploy-probe-20261121' # 替换为实际探针验收记录编号
```

- 检查组合输出，确认无 `danger-full-access` 预设且配置生效：
  ```sh
  dsh --profile remote-exp --dump-config
  ```

### 第 4 步：启动使用与日常操作

1. 使用该专用 profile 启动 DSH（确保当前只有这一份启用了 SSH 远端控制面的 Host 持有存储 lease；若机器上另有一个未启用 SSH 的桌面端/Web 实例持有同一个 `$DSH_HOME` 存储锁，会提示 `owner-without-remote-protocol`，需先退出那个实例）。
2. 在插件详情页确认 **SSH 远端环境** 开关处于开启状态（若未设为默认开启，可在详情页手动确认风险并开启）；切到「模式设置」Tab 可确认当前处于 **硬化** 且参数受 profile 保护（只读）。
3. 在「工作区目录（Folders）」的「远端工作目录」区找到对应项目绑定的目录，点击行尾 **…** → **登记（Register）**。
4. 登记完成后，Agent 即可在系统提示词中看到可用远端端点，并按权限调用：
   - `remote_bash`：在已登记且授权 `exec` 的端点执行受限命令。
   - `remote_copy`：在本地根与已登记 SFTP 端点之间、或两个已登记 SFTP 端点之间安全复制单文件。

---

## 六、停用、变更清单与故障排查

### 更新清单或切换模式

- **个人模式**：直接在面板保存或编辑，Host 会按配置版本号（CAS `revision`）原子提交并原位刷新，不影响其他工作区的在飞操作。当环境连接参数或绑定路径/能力改变后，对应绑定会进入「待重新登记（`withheld`）」，在面板重新点击 **登记** 即可。
- **团队 / 硬化模式**：修改 `manifest.json`、更换密钥或调整 `revocations` 前，先在插件详情关闭 **SSH 远端环境** 开关，等待正在执行的远端调用收束完毕，再重启 Broker 服务与 DSH Host（Host 与 Broker 启动时会校验 `manifestDigest`，两边不一致会拒绝接入）。

### 常见错误与排查

- **`owner-without-remote-protocol` / 面板提示另一实例持有存储**：另一个未开启 SSH 远端功能的 DSH 实例（例如未启用该插件的 Desktop 端）正持有 `$DSH_HOME` 的存储锁。退出那个实例后再刷新。
- **`endpoint-unverifiable`**：`multi-root-remote-tools` 未能挂载工具与校验器。在团队/硬化模式下，说明 Broker 证明未通过（请检查日志中 `credential broker is unavailable (<code >)` 的具体原因，常见如 `credentials-readable`、`broker-same-uid`、`confinement-unproven`、`destination-isolation-required`、`manifest-mismatch`、`socket-missing`）。
- **`ssh-config-not-linked`**（个人模式）：存在托管凭据的环境但尚未把插件生成的配置链接进 `~/.ssh/config`，在「已有连接」页签点击 **链接到 ~/.ssh/config**。
- **`unknown` 返回与 `reconcileId`**：远端命令启动后连接断开或文件发布应答丢失时，工具不会自动重试（避免重复执行或覆盖文件），请凭返回的 `reconcileId` 到远端或审计日志对账后再决定后续操作。

关于协议字段、全部错误码与架构细节，参见技术参考 [SSH 远端环境参考](../../reference/ssh-remote-environments.md) 与 [多执行环境控制面参考](../../reference/multi-environment-control-plane.md)。
