# SSH 远端环境（个人模式）

> 实验性、默认关闭。本文件是 ADR-0049 的 Host 侧运行参考；控制面语义（准入、状态机、remote-2 协议）见 [multi-environment-control-plane.md](./multi-environment-control-plane.md)。

## 启用条件

当前公开构建只提供个人 SSH。默认组合通过 `multi-root-remote-tools.enabled` 开关启用，默认关闭。启用后，Host 从 `remoteEnvironments.personalPath` 读取连接，从 `remoteEnvironments.credentialRoot` 读取插件托管的凭据；也可引用本机 `~/.ssh/config` 中的别名。个人模式下，本机 DSH Host 持有凭据，同一操作系统账号下的进程可能访问这些凭据。

### Host Profile 依赖

- `SUPPORTED_SSH_RELEASES` 是 SSH 支持的精确版本真源。四个官方包分别为 `@deepseek-ai/dsh-ssh`、`@deepseek-ai/dsh-fs-ssh`、`@deepseek-ai/dsh-subprocess-ssh` 和 `@deepseek-ai/dsh-sandbox-ssh`，都须与当前 Host 同版。它们在插件 manifest 中仍是 optional peers，局部安装故障只阻断 SSH。
- 上游 Profile 使用 `nodeLinker: hoisted`、`autoInstallPeers: false`。CLI 的 `dsh plugin --profile <name> add` 支持普通 npm 依赖，并将它们写入该 Profile 的 `package.json` 与锁文件，安装到该 Profile 的 `node_modules`。Bundle 选择保持原样。官方安装闭包为共用包提供回退。运行中 Plugin Manager 的 Bundle 安装接口拒绝普通包。决策依据见 [ADR-0049](../decisions/ADR-0049-ssh-custody-modes.md)。
- 发布 tarball 带 `scripts/install-ssh-deps.mjs` 与构建入口 `lib/install-ssh-deps.js`。命令由 `src/compat/ssh-profile.ts` 从可信安装上下文生成：Desktop 使用 `process.resourcesPath/runtime/cli/bin/dsh`，脚本本身由 `ELECTRON_RUN_AS_NODE=1 <应用可执行文件>` 启动（`runtime/bin/node` 依赖 Desktop 启动器注入的 `DSH_DESKTOP_NODE_EXECUTABLE`，普通终端不可用）；Web 从 `profileContext.installAnchor` 指向的 `@deepseek-ai/dsh` manifest 解析 `bin.dsh`，并复用当前进程的 Node。命令携带脚本、精确 CLI、Profile、DSH Home 与 Host 版本；脚本先运行一次 `dsh --version` 核对版本、校验 Profile 位于该 Home 且不是重定向目录，然后以结构化 argv 执行一次 `dsh plugin --profile <name> add --save-exact`，绝不从调用方接收包名。四包已对齐时直接报告已就绪，不再次写入；版本不符、Profile 不在该 Home、Desktop Profile 未初始化或版本不在 `SUPPORTED_SSH_RELEASES` 时返回诊断并停止。路径中的空格、单引号与非 ASCII 字符由 POSIX 引用与 argv 传递共同支持。
- 插件优先使用上游发布的安装闭包中的 SSH 包，否则从当前 Profile 的直接依赖中解析。Profile 副本的模块入口必须位于对应包目录，DSH/Cordis peers 必须指向当前安装闭包，SSH 包间的 peer 必须指向同一组副本。插件私有副本只用于诊断。启动时记录的包位置和身份与现状不同则要求重启。重新检测只读取状态，开关、工具启动及 RPC 均不会运行本地包管理器。
- Settings 的 `status` 和工作区的 `remotes` 可返回 `dependencies`，含 Host 版本、Profile 名称、每包状态和可选的精确安装命令。仅在启动器目录对应 CLI 管理的 Profile 且能确定唯一目标 CLI 时生成命令；否则返回诊断。三种结果分开：本次写入成功（安装完成）、磁盘已对齐但当前进程仍需重启（`ssh-deps-restart`）、当前 Host 已能解析四包（`ready`）。用户步骤见[个人 SSH 指南](../guide/user/ssh-remote-environments.md#安装当前-profile-的-ssh-依赖)。

### Desktop 一键安装的启动器接缝

客户端只在 `view.code` 为 `ssh-deps-missing` 或 `ssh-deps-partial`、且启动器显式声明能力时显示 **安装并重启**。能力对象是 `window.dshDesktop.sshDependencies`（Rivetdeck 桥为 `window.deepseekDesktop.sshDependencies`），形状固定为：

```ts
{
  protocolVersion: 1,
  install(request: { profile: string; release: string }): Promise<{
    status: 'ready' | 'installed' | 'restart-required',
    profile: string,
    release: string,
  }>,
  subscribe(listener: (phase: 'stopping' | 'installing' | 'restarting' | 'checking' | 'done') => void): () => void,
}
```

启动器必须用自己的可信状态校验请求的 Host、Profile 与版本（不接收包名、argv 或任意命令），合并或拒绝同一 Profile 的并发请求；先停止目标 Host 并等待退出，再复用 `scripts/install-ssh-deps.mjs` 的安装核心，最后以原配置重启同一 Profile，并在每个阶段发出上述事件。停止失败必须结束请求；安装失败且 Host 已停止时尝试恢复启动并保留可重试诊断；新 Host 启动后由既有 `dependencies` 检测确认四包解析与加载，未就绪时继续显示依赖提示。

**当前阻塞点**：本仓库的硬约束是不修改上游 `deepseek-harness` 任何包，而 `dsh-v0.2.2-rc.5` 的 `apps/desktop` 只暴露 `dshDesktop` 的既有 IPC（文件、更新、快捷键、浏览器、目录选择等），没有 Profile 安装或 Host 停止/重启的桥接口；实际启动器也不在本仓库。因此 Web 与当前 Desktop 不显示该按钮，客户端保留复制命令与重新检测。接入方只需在启动器主进程按上述对象实现能力并通过 preload 暴露；插件侧无需再改协议。

### 停用的旧配置

Host 将显式的 `team`、`hardened` 或其他不支持的模式视为停用。旧版配置了部署清单且未显式指定个人模式的 Registry 行、以及仅配置 broker 或 team 参数而未指定模式的工具行，同样保持停用。发布包移除了 SSH broker 入口和安装脚本。Broker 设计留作研发记录，见 [ADR-0049](../decisions/ADR-0049-ssh-custody-modes.md) 和[控制面参考](./multi-environment-control-plane.md)。

如果要沿用早期实验的自定义 profile，请先从该 profile 的 `multi-root-registry` 与 `multi-root-remote-tools` 行中移除旧档位及部署字段（`mode`、`manifestPath`、`team`、`broker`），保留个人连接和凭据路径。重新加载 profile 后，在插件设置中开启个人 SSH，并按[个人 SSH 指南](../guide/user/ssh-remote-environments.md)配置和登记目录。

## 文件布局与权限

- 插件级连接文件由 `remoteEnvironments.personalPath` 指定，默认为 `$DSH_HOME/storages/multi_root_workspace.remote-personal.json`。格式为 `{ schemaVersion: 2, revision, environments[] }`。环境保存目标、主机指纹、凭据引用、Helper 与传输/执行能力上限，远端目录由绑定单独保存。
- Workspace Root 绑定由 Host 写到 `<personalPath>.bindings.json`，格式为 `{ schemaVersion: 1, revision, bindings[] }`。绑定按本地 `primary`、`environmentId`、`rootId` 唯一标识，包含远端路径、动作与传输对端。一个 Workspace 可在同一环境绑定多个互不重叠的目录。新建或实际修改授权的绑定带 Host 生成的 `bindingId`。路径、动作集合与传输配对集合相同时，保存保留原记录、摘要和配置 revision。解除后重新添加同名绑定需要重新登记。
- 两个文件都必须是当前 uid 拥有的普通文件，非符号链接，权限至多 0600，父目录不得由 group/other 写，位置须在所有绑定的本地主根之外。连接文件缺失时，整个 personal 配置视为空；v2 连接文件存在时，绑定文件必须可读并通过保护检查。
- 两个文件共用 `<basename>.lock` 的内核租约与 CAS，当前 revision 取两份文件的最大值。读取 v1 合并文件时剥离环境里的 `workspace`，保留已保存的绑定路径与权限。首次写入先准备绑定文件，再原子替换为 v2 连接文件。在这之后，每个变更只原子替换它所属的文件。
- 凭据根由 `remoteEnvironments.credentialRoot` 指定，默认 `$DSH_HOME/storages/multi_root_workspace.ssh`。目录必须为当前 uid 所有且权限为 0700，否则返回 `credential-root-unsafe`。内部有 `credentials.json`、`keys/<id>` 与公钥、`secrets/<id>`、生成的 `ssh_config` 与 `known_hosts` 以及 `askpass.sh`。凭据记录的生成、导入、保存密码与删除经 `credentials.json.lock` 内核租约（与清单文件同一机制）串行化并在租约内重读，多个 Host 实例并发变更不丢记录。
- 每次远端 snapshot/list/admit/add/remove 前，`refreshPersonal()` 检查两个文件的保护和内容。两份文件与其所在目录的 stat 身份（dev/ino/size/mtime/mode/uid）全部未变时沿用上一次已校验的读入；任一字段变化、文件缺失或父目录权限被放宽时立即重读并重做全部保护检查。有效配置原位发布，保留 owner 的授权域与现有 `remote-2` 连接。后续请求各自携带并校验当期清单摘要。配置损坏、语义非法或保护失效时，控制面进入 `config-invalid`，清空清单和摘要并拒绝远端准入，修复后可重新加载。
- personal 环境授权身份包含主机名、端口、账号、平台、主机钥、凭据引用（含已安装访问密钥）、Helper 与执行/传输策略。连接新建或身份变化生成新的身份 ID。显示名只影响展示。尚未包含目标和凭据身份的旧 personal 登记升级后变为 `withheld`，须重新登记一次。
- personal Helper 在目录核验或获准执行时取该绑定的远端目录作为工作区；连接按环境和目录分别缓存。旧 Helper 绑定首次升级会因其清单内容变化而需要重新登记。

## RPC 端点与拒绝码

面板通道 `PANEL_CHANNEL` 上的 `ssh*` 端点（`src/remote/personal-contract.ts`）：每个请求携带 `sessionId`，Host 由会话解析主根；未知字段即 `panel/bad-request`。所有端点在开关未开或 `mode !== 'personal'` 时拒绝 `remote-personal-unavailable`；所有变更端点返回刷新后的 `sshState`。

- `sshState`、`sshCredentialGenerate`、`sshCredentialImport`、`sshCredentialPassword`、`sshCredentialRemove`（`credential-in-use`）、`sshConfigLink`（写入 Include）。
- `sshConfigAliases` 只返回本机 `~/.ssh/config` 中的字面 `Host` 别名。跳过通配和否定项，读取失败返回空数组。
- `sshListDirectories` 按连接经只读 SFTP 返回 `{ path, parent, entries: [{ name, path }] }`，最多 500 条。ssh-config 来源在打开 SFTP 前使用 `ssh -G` 和用户 known_hosts 核对已保存的主机、端口、账号与指纹。漂移会拒绝浏览。managed 来源使用 `-F <credentialRoot>/ssh_config`，可在链接 `~/.ssh/config` 前浏览。SFTP 错误为 `remote-path-listing-failed`。
- `sshHostKeyScan` 返回有效期 60 秒的确认令牌。直连形式用 `ssh-keyscan`，令牌绑定目标主机、端口和候选指纹。别名形式通过 `ssh -G` 和本机 known_hosts 取得目标和唯一指纹，令牌还绑定别名与账号。
- `sshEnvironmentSave` 携带 `intent: create | update`。创建时 ID 已存在返回 `environment-id-conflict`，更新目标不存在返回 `environment-not-found`。连接身份及记录的指纹相同时可复用已有指纹。主机、端口、账号、平台、凭据来源或材料改变时需要重新确认扫描结果。别名保存时会重新核对解析结果。允许启用 exec 的条件是 Helper 已安装且可沿用。
- `sshEnvironmentRemove` 拒绝移除仍被 Workspace 引用的环境（`environment-in-use`）。`sshEnvironmentTest`、`sshHelperInstall`、`sshAccessKeyInstall` 负责连接检查与远端设置。
- `sshBindingSave` 用显式 `rootId` 编辑已有绑定，省略时创建；省略 `rootId` 且同一 Workspace、同一环境已存在同路径绑定时，编辑该绑定而不是分配新 `rootId`（向导「上一步→下一步」的重复保存因此幂等）。绑定归请求会话的 Workspace。`sshBindingRemove` 解除当前 Workspace 的绑定。

插件详情的「SSH 远端」通过独立的 `/multi-root-workspace-ssh-settings` Connection 通道打开。它使用同一 Host 身份校验，直接读取插件级状态和管理连接、凭据，不要求活动会话。该通道拒绝 Workspace 绑定、目录浏览与登记/移除请求；这些操作继续通过 `PANEL_CHANNEL` 由当前会话派生主根。

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

`sshConfigLink` 在 `~/.ssh/config` **首行**写入 `Include "<credentialRoot>/ssh_config"`（先备份为 `config.dsh-backup-<时间戳>`，幂等）。`~/.ssh/config` 是符号链接（dotfiles 托管常见）时，备份与写入落在其解析出的目标文件上——符号链接本身保留、绝不替换成普通文件，备份落在目标文件旁；多层符号链接一直解析到最终目标，最终目标缺失时在该处创建。未链接而使用 managed 环境时连接报 `ssh-config-not-linked`。

SFTP 使用独立的 SSH 子进程，同样在命令行强制 `StrictHostKeyChecking=yes`、`ForwardAgent=no`、`UpdateHostKeys=no`，并关闭 ControlMaster/ControlPath；用户别名配置不能放宽这些参数。ssh-config 别名的 `sshEnvironmentTest` 与 `sshHelperInstall` 在命令行强制同一组安全选项（测试连接另加 `BatchMode=yes` 与 `ConnectTimeout=10`）；托管来源从生成的 `ssh_config` 获得同样的值。

## Helper 安装与密码访问密钥引导

- Helper 安装使用与 Host 同版的 `@deepseek-ai/dsh-ssh`。Host 逐个比对包内 `lib/*`，并记录安装后 `node_modules` 文件集摘要 `treeSha256`。打开新连接前，Host 先验证远端入口脚本与由该摘要重建的脚本一致。入口脚本启动时重新验证文件集，再加载 Helper。上游 hello 仍以 `helper.sha256` 校验 `helper.js`。记录格式保持 `integrity: 1 | 2`；安装同时部署 `helper-entry.mjs`（beta.2 的逐字节模板，供回退与 plain Node Host）和 `helper-entry-v3.mjs`（在加载上游 Helper 前给固定的 `PSK-AES256-GCM-SHA384` 追加 `ECDHE-PSK-CHACHA20-POLY1305`，供 BoringSSL Host）。记录里的 `helperPath` 仍指向 `helper-entry.mjs`，所以重装不改变 `bindingDigest`，已登记 Root 不会变成 `withheld`，也不需要重新登记；Desktop 遇到没有 v3 入口的旧 Helper 报 `helper-outdated`，重装一次即可。详见 [ADR-0051](../decisions/ADR-0051-ssh-stream-psk-boringssl-fallback.md)。该检查信任 SSH 对端和首次 npm 安装，后续校验由 Helper 入口执行。
- Helper 需要远端 Linux 或 macOS、Node.js ≥ 24.9.0、npm 和可写的 `~/.dsh-helper/<version>`。Host 首先检查依赖、已有 revision 和已保存别名身份。远端预检查确认平台、规范化绝对路径、Node 版本、npm 及目标或最近现存父目录权限，然后执行一次 npm 安装。安装验证通过后以原子替换部署入口，最后按原 revision CAS 登记 Helper。收到不确定结果时不重发写操作。
- RPC 在既有 `{ code, message, details }` 的 `details` 中附带 `stage`、`retryable`、`remediation`、可选退出码、版本和远端完成/登记状态。错误阶段为 `host-preflight`、`ssh-connect`、`remote-prerequisites`、`remote-install`、`artifact-verification`、`entry-generation`、`config-commit`。npm 诊断使用结构化结果。OpenSSH 退出 255 时仅识别明确的标准诊断，详情仅包含安全摘录。未识别的退出归到独立的未知错误。远端已安装或已校验与 Host 已登记分别记录。
- 编辑连接：派生的 `accessKeyId` 由 Host 从已保存记录保留，前端无需回传；仅 environmentId、hostname/port/user、credentialId 与已确认主机指纹均未变化时继承。改变身份后必须重新安装访问密钥，不能通过保存请求移植旧密钥。
- 密码引导先做 revision 预检，然后固定已确认的主机公钥、账号及一次性密码副本。远端按公钥精确、串行地更新 `authorized_keys`。保存冲突时，目标身份和访问密钥引用均未变化才允许复用密钥重试一次。仍失败则用同一目标回滚远端条目，再删除本地密钥。如果远端无法确认回滚或读不出持久状态，返回 `access-key-reconcile-required`，保留该密钥记录及核对编号。
- 私钥导入：带口令的私钥经 `SSH_ASKPASS`/`SSH_ASKPASS_REQUIRE=force`（凭据根内私有临时目录中的 0600 口令文件 + 0700 脚本，用完即删）把旧口令交给 `ssh-keygen -p` 解密后重新保存，口令不进入命令行参数；材料或口令被拒报 `credential-import-failed` 并清除半成品密钥文件。

## 实时开关与卸载清理

启用通过 `configureRemote` 加载个人连接和工作区目录绑定。停用时先停止接纳新的 SSH 操作，取消并收束在途传输、连接和 Helper，再按依赖逆序拆除 fiber。

管理器的关闭是一个幂等事务：`disposeAll()` 在第一次调用时置为关闭状态，后续与并发的重复调用共享同一完成；`open`、`openSftp` 与 `openTransferSftp` 在进入和异步完成后都检查关闭状态，关闭开始后才完成的连接会被立即释放并拒绝返回。传输先中止并等待各自的收束，随后 Helper 与 SFTP 会话逐项独立清理：一个 Helper、SFTP 会话或 fiber 失败只记录带资源标识的警告，其余资源继续释放。fiber 按反向挂载顺序拆除（sandbox → subprocess → fs → ssh → policy → projections），单个 fiber 失败不阻止后续 fiber。

清理同时保护转发流的事件逃逸。上游 `SshConnection` 在 TLS 认证的 `secureConnect` 上移除一次性的 `error` 监听，之后才挂上连接的永久监听；连接丢失若落在这一窗口，`socket.destroy(error)` 会让 Node 以未处理的 `'error'` 事件终止进程。插件在 `tls.connect` 返回时同步给上游转发流套接字附加一个只吞掉未处理错误的监听（精确匹配上游 stream 选项形状），它不替换连接自身的监听、不改变真实掉线的失效与上报，也不安装进程级 `uncaughtException` 处理器。该保护在 native 与 BoringSSL 运行时都安装，且先于任何 abort 回调可运行。

personal 子树首次等到控制面就绪再挂载，常规配置保存更新现有管理器。环境授权身份改变时只废弃该环境的 SFTP 与 Helper 代次。绑定编辑交由准入指纹失效，已无绑定引用的目录 Helper 在撤权复核后回收。其他环境和仍有效的目录可继续使用已有连接。

设置写入走 Host 的 `settings` 服务；旧版 `configure` 路径没有 `setSource` 推送，行必须通过 `settings.describe()` 读取实时值，否则只有重启后 loader 重新组合才生效（本页“实时开关”回归覆盖）。

## follower 与 remote-2

Registry 的 owner 是唯一打开远程域和 `remote-2` 监听的 Host。若另一个 DSH 实例持有 lease，但它的 profile 没有挂载 `multi-root-remote-tools`（例如桌面端主插件仍是 mainline），follower 的 `connectFollower` 会收到 `registry authority is not ready`；面板显示 `remote.status.ownerWithoutRemotePlane` 的可操作提示。重启 follower 不能改变 owner；需要退出另一个实例，或让启用 SSH 的 profile 成为唯一 Host。

## GUI 管理面板（个人模式）

GUI 入口有两处：

- **插件详情设置卡**：开启 SSH 远端环境后，第一行显示「SSH 远端」和「管理」按钮，进入与工作区面板共用的管理对话框。实验开关仍负责启用风险确认；开关关闭时隐藏该设置入口。
- **Workspace Folders 的「远端工作目录」**（`src/client/WorkspaceFoldersAction.tsx`）与「主要工作目录」「附属工作目录」并列，标题行同时提供「管理 SSH 远端…」与个人模式的「管理远端 Root 绑定」。远端目录列表与主要/附属工作目录共用 `WorkspaceRow`。首行依次显示末级文件夹名、SSH 环境名标签、当前会话的有效能力。第二行为可复制地址，使用 `ssh://user@host:port/path`。IPv6 主机加方括号，路径按 URI 规则转义。行尾「…」可登记；personal 模式且远端状态就绪时，菜单首项「编辑」直接打开「本项目绑定」对话框并落在该绑定的内联编辑表单上（与绑定列表行尾的铅笔入口等价）。personal 模式还在所有状态下提供「移除」——对已登记行先撤销登记再以当前 revision 的 CAS 解除绑定，对未登记/待重新登记/已撤销行只解除绑定，确认文案说明两处一起移除，因此「待绑定」行也可以从这里清掉。该菜单同样用于修改读取、写入、执行及本地传输对端，保存沿用绑定的 CAS 校验；对已登记目录修改能力后，通过同一菜单重新登记。解除绑定也可在绑定对话框中完成。

### SSH 远端管理对话框

「SSH 设置」遵循 DSH `SettingsRoot` 的窗口网格与 `ModelsSection` 的列表卡片。桌面端使用 800×800 的窗口上限和 188px 的左侧导航，右侧内容独立滚动。宽度低于 768px 的浏览器使用全屏窗口和顶部导航，Windows 与 macOS 桌面窗口保留左轨。面板复用宿主 `useModalLayer` 管理焦点、Escape 和嵌套遮罩，缺少该接口时由宿主 `Modal` 承载。

**控件与布局。** 表单文本输入使用 primitives `Input`，表单操作使用 `Button`，平台和 Helper 徽标使用 `Tag`。添加连接、编辑连接和 Root 绑定的下拉选择使用宿主 primitives 的 `Menu` 和 `Button`。本机 SSH 别名可直接输入，也可从菜单选取。单行输入框、下拉触发器和常规操作按钮统一为 32px 高。私钥文本区可调整高度，关闭按钮沿用宿主尺寸，绑定行尾两个图标按钮均为 28px。`Checkbox` 与 `SegmentedControl` 自 `0.1.7-alpha.1` 起使用 primitives，旧版本回退为同语义的本地控件（`.mrfw-sshCheckbox` / `.mrfw-sshRadioOption`）。字段使用 grid 和持续可见的标签。远端目录选择器空间不足时，「转到」和「上一级」一起换行。

**请求反馈。** 测试连接、安装 Helper、安装访问密钥、链接 `~/.ssh/config`、获取主机密钥、保存/删除连接、更新 SSH Key、保存/解除绑定、读取远端目录，以及 Workspace Folders 中登记/移除远端目录，都是异步请求，界面不冻结。触发按钮原位显示转圈，保持原宽度和可访问名称，并标记 `aria-busy`。操作所在位置出现带说明的状态行（`role="status"`；宿主提供 `TextShimmer` 时文字带扫光），对话框顶部显示一条不占布局的进度条。状态行和进度条延迟约 120ms 淡入，瞬时完成的请求不会闪烁；`prefers-reduced-motion` 下改为静态指示。转圈优先使用宿主 `StateDot`（`ongoing`），旧运行时回退为本地 CSS 圆环。测试连接是只读请求，不锁定其他操作，多个连接可同时测试。会改写配置的请求仍按 `revision` 串行：进行期间其余变更入口禁用，正在运行的按钮本身不变暗。读取远端目录时保留上一层列表并降低不透明度，返回后再替换。

**添加连接向导** 从「远端连接」列表底部打开，与「添加远程工作目录」向导共用 `WizardShell`：左侧步骤轨、当前步内容和底部操作行。向导复用 `wizard/env-parts.tsx` 的连接表单（`ConnectForm`）、主机密钥选择（`HostKeyPick`）和就绪清单（`EnvironmentSetup`），字段校验与 `ssh-draft.ts` 一致。

1. **连接**。选择本机 ssh-config 条目或插件托管凭据，填写显示名、平台与目标。本机来源可从 `sshConfigAliases` 选择，托管来源可从嵌套的凭据管理对话框添加凭据。点「扫描」获取主机密钥后在同一步内选择一条指纹并确认保存（区别于旧版的嵌套确认对话框）；「上一步」回到表单且不保存任何内容。面板按显示名生成环境 ID，显示名为空、生成的 ID 不符合命名规则或已被占用时，使用未被占用的 8 位十六进制短 UUID。保存连接后进入第二步。编辑连接时保留原 ID。
2. **连接设置**。可以检测远端 Node、安装 Helper，并设置连接级的命令执行及文件传输能力。托管密码先安装访问密钥。托管连接若尚未链接 `~/.ssh/config`，此处提供链接入口。Helper 安装成功后即可勾选「允许命令执行」，点「完成」保存能力设置并进入完成页。跳过此步或关闭对话框时，已保存的连接和已安装的 Helper 保留。工作区目录仍通过 Workspace Folders 的绑定对话框选择，执行权限需要在对应 Root 上单独勾选并登记。

- **远端连接**。每条连接使用一张卡片，显示名称、配置就绪状态、平台、SSH 地址和凭据。测试、编辑、删除、安装 Helper、链接配置和安装访问密钥使用行尾的无边框图标按钮，操作名称可通过悬停提示或读屏获取。删除确认使用「确认删除」和「取消」文字按钮。编辑表单在对应卡片下展开。安装 Helper 后，对应安装入口隐藏。仅修改显示名等元数据可直接保存，修改连接身份需重新扫描。删除仍被绑定的连接会返回 `environment-in-use`。
- **SSH Key**。凭据卡片显示名称、类型和可用的公钥指纹，行尾提供复制公钥和删除的无边框图标按钮，删除确认使用文字按钮。列表底部的「添加凭据」打开嵌套对话框：先在卡片中选择生成密钥、导入私钥或保存密码，再填写对应的名称与秘密字段，「上一步」可回到类型选择。提交时清除表单中的秘密输入，提交后对话框关闭。连接专用访问密钥（`purpose: 'access-key'`）仍显示在所属连接卡片下。

### Workspace Root 绑定对话框

从 Workspace Folders 打开 `SshWorkspaceBindingsDialog`。「添加绑定」打开 `AddBindingWizard`（`src/client/wizard/add-binding.tsx`），与「添加远端工作目录」向导共用 `WizardShell` 的绑定、登记两步：第一步在整页表单中选择已有连接、指定远端路径（只读 SFTP 浏览或手动输入规范化的 POSIX 绝对路径）、勾选允许动作、可选的 Files 稳定路径列举断言与本地传输对端（`primary` 和可用附加根的 `aliasId`），「下一步」经 revision CAS 保存（草稿携带已保存的 `rootId`，「上一步→下一步」的重复保存编辑同一绑定而非重复登记）；第二步展示环境、路径、动作与传输摘要并调用 `remotes.add` 登记，成功后进入完成页。已有绑定仍在对话框内联编辑或解除，其他绑定和 SSH 连接独立保留；编辑权限或更新部署后状态变为「待重新登记」的目录，从 Workspace Folders 行尾「…」菜单重新登记。

新建绑定时，Host 将路径的末级目录名转换为最多 63 字符的小写标识。转换结果为空，或同一项目和 SSH 环境已有同名标识时，改用 UUID 的前 8 位，并保证该标识在当前范围内唯一。编辑已有绑定时沿用原标识。

「本项目绑定」与「远端工作目录」共用目录行。首行显示目录名、SSH 环境和已配置的权限，第二行显示可复制的远端地址；已配置的本地传输对端按导入和导出方向列在下方。行尾用铅笔编辑，垃圾桶打开解绑确认。确认解绑会撤销已有登记。

连接和绑定变更携带当前 `revision`。发生 CAS 冲突时刷新 `sshState` 后可重试，表单保留待提交内容。会话切换使旧请求的响应失效。已确认保存的连接无需完成后续 Workspace 操作。

**开关默认值**（GUI 勾选"允许命令执行"/"允许文件传输"时写入的完整节，见上文文件 schema）：

```jsonc
// exec（新草稿；已保存的连接保留它自己的上限）
{ "shell": ["/bin/sh", "-c"], "env": { "PATH": "/usr/local/bin:/usr/bin:/bin" },
  "maxTimeoutMs": 600000, "stdoutLimit": 1048576, "stderrLimit": 262144, "terminateGraceMs": 2000 }
// transfer
{ "maxBytes": 268435456, "timeoutMs": 600000 }
```

所有变更请求携带当前 `revision`；`personal-config-conflict` 时前端先重取 `sshState` 再显示本地化冲突文案。服务端错误一律经 `error.*` 本地化渲染。

exec 与 transfer 独立授权：执行前用 helper 的只读受限 stat/realpath 探针分别验证根与 cwd；无需 transfer 配置或 SFTP 发布扩展。重定向目录和越界 cwd 在命令准备前拒绝。

## 模型工具：参数、结果与输出预算

`remote_copy` 与 `remote_bash` 广告的 JSON Schema 与 execute 边界的实际校验来自同一份声明（`src/remote/tool-arguments.ts`）：缺字段、错误类型、未知字段与嵌套对象都在工具层以带字段位置的 `invalid-arguments` 结束，早于 Registry 准入与任何 SSH/SFTP I/O。

**`remote_copy` 端点。** `from` 与 `to` 使用同一定义 `{environmentId?, rootId, relativePath}`，两侧规则相同：只有**省略** `environmentId` 才取 `local`，`null` 与空串是参数错误；远端端点必须显式给出环境 ID。本地主根写作 `environmentId: "local"` + `rootId: "primary"`（可省略 environmentId，即 `local:primary`），附加根使用登记的 `aliasId`。`relativePath` 是单个普通文件的规范化相对 POSIX 路径。上传示例 `{"from":{"rootId":"primary","relativePath":"dist/app.tar"},"to":{"environmentId":"build","rootId":"app","relativePath":"in/app.tar"}}`；下载示例 `{"from":{"environmentId":"build","rootId":"app","relativePath":"out/app.tar"},"to":{"rootId":"primary","relativePath":"dist/app.tar"}}`。

**`remote_bash` 参数。** `environmentId` 必填且必须命名远端环境（`"local"` 是参数错误）；`rootId` 是登记的绑定根，`cwdRelative` 相对它（`""` 或省略表示根目录本身）；`timeoutMs` 是整数毫秒；`maxOutputBytes` 是可选单流预览上限。工具名与 Session 只取自调度上下文，模型参数里的同名字段作为未知字段被拒绝。

**结果文案。** 两个工具保留既有 `status`/`code`/`stage`/`staging`/`operationId`/`reconcileId` 语义，并为可诊断的失败增加有界 `message` 与 `hint`：文案只由稳定错误码与安全字段（环境/根 ID、相对路径、已准入的 displayPath、候选列表）生成，不包含捕获到的异常文本、SSH 诊断原文或凭据路径。`invalid-cwd` 的提示说明 `cwdRelative` 为空表示已准入根目录（附 displayPath），否则必须是规范化相对路径；`destination-parent-missing` 指明缺失的是目标父目录；`local-root-unavailable` 说明 `primary` 与 `aliasId` 的写法。

**端点候选。** 端点类错误可以附上每个方向最多 6 个 `environmentId:rootId`。候选读取当前 Session 主根对应的 Registry 快照（`remoteList`）与当前清单，筛选已登记且允许所需动作的远端。复制候选还要符合会话模式、工具上限与对端配对。两个远端之间必须同时有源的 `export` 和目的的 `import`。本地端可以是 `local:primary` 或可用的本地附加根，须被对应远端绑定列为对端，本地目的端须可写。读取不建连，也不消耗准入。快照不可用时仍返回原错误码与通用提示，每次重试走正式准入。

**输出预算。** `remote_bash` 默认给 stdout 和 stderr 各 64 KiB 预览预算，原始窗口和 JSON 字符串内容分别受同一上限约束。默认最多传给模型 128 KiB 的两路 JSON 输出内容，另有结果字段开销。`maxOutputBytes` 可调节单流预算，受到该流的部署上限约束。新个人 SSH 连接保留 stdout 1 MiB、stderr 256 KiB 的部署上限，已保存连接沿用原配置。

结果逐流报告 `truncated`、`totalBytes` 与 `droppedBytes`。`totalBytes` 是后端能证明的原始字节总数。`droppedBytes` 从该总数扣除实际进入预览的原始字节数，包含上游丢头、UTF-8 尾部舍弃及 JSON 预算裁剪。SSH 采集窗口含 U+FFFD 时，适配器保留上游文本，精确总数仍可返回，无法核实的丢弃量为 `null`。采集器未提供坐标时两项计数均为 `null`。大输出的处理示例见[用户指南](../guide/user/ssh-remote-environments.md#使用远端工具)。

## 在飞命令撤权与清理

`remote_bash` 从 spawn 返回 handle 起观察取消、超时与授权变化，包括启动确认阶段。owner 通知各 Host 重新准入，并保留每秒一次的复核以观察会话模式变化等无通知情况。本地根重分类只用于含本地端点的准入。持续无法取得结论时，单轮复核在 5.5 秒截止后终止命令。

终止原因返回 `termination: revoked | cancelled | timeout`。在 `terminateGraceMs` 内仍无法确认结果则返回 `unknown` 和 reconcileId，不无限等待、不重新执行。启动确认尚未到达时传输断开同样立即返回 `unknown`：不等待一个不会再来的确认，也不发送 terminate，因为启动是否发生本身未知。通知和轮询只是失效检测，不能代替每次新操作的正式准入；网络和调度延迟下不承诺撤权瞬间远端停止。

## 传输截止时间

`transfer.timeoutMs` 是一次复制的总 I/O 预算，涵盖准入、握手、读写、校验和发布。个人模式每个复制端点独占 SFTP 通道，取消或超时只影响该次复制。传输清理使用独立的一秒预算，清理结束后回收通道。CREATE 或 LINK 缺少应答时返回 unknown 和 reconcileId。LINK 已确认时，清理失败仍返回 committed 与残留状态。

## Files 标签页目录浏览

绑定声明 `directoryListing: 'stable-path'`（纯 SFTP 与 Helper 连接均可勾选，且必须同时允许 `read`；Helper 登记在对象核验后追加独立的 SFTP v3 路径核验，见[使用指南](../guide/user/ssh-remote-environments.md#在-files-标签页浏览远端目录可选)）后，宿主在面板通道上提供两个端点：`remoteFiles.list`（受限目录列举，17 个固定错误码）与 `remotes.waitForAuthorizationChange`（授权元数据租约，非文件监视）。二者与上面传输端点共用同一套会话/登记/令牌权威。组件依赖、时序、生命周期与安全姿态的唯一真源见 [file-browsing-providers.md](../architecture/file-browsing-providers.md)，决策见 [ADR-0052](../decisions/ADR-0052-provider-file-browsing.md)。
