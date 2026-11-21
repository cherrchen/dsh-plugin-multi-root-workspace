# SSH 远端环境（个人模式）

> 实验性、默认关闭。本文件是 ADR-0049 的 Host 侧运行参考；控制面语义（准入、状态机、remote-1 协议）见 [multi-environment-control-plane.md](./multi-environment-control-plane.md)。

## 启用条件

当前公开构建只提供个人 SSH。默认组合通过 `multi-root-remote-tools.enabled` 开关启用，默认关闭。启用后，Host 从 `remoteEnvironments.personalPath` 读取连接，从 `remoteEnvironments.credentialRoot` 读取插件托管的凭据；也可引用本机 `~/.ssh/config` 中的别名。个人模式下，本机 DSH Host 持有凭据，同一操作系统账号下的进程可能访问这些凭据。

### 停用的旧配置

Host 将显式的 `team`、`hardened` 或其他不支持的模式视为停用。旧版配置了部署清单且未显式指定个人模式的 Registry 行、以及仅配置 broker 或 team 参数而未指定模式的工具行，同样保持停用。发布包移除了 SSH broker 入口和安装脚本。Broker 设计留作研发记录，见 [ADR-0049](../decisions/ADR-0049-ssh-custody-modes.md) 和[控制面参考](./multi-environment-control-plane.md)。

如果要沿用早期实验的自定义 profile，请先从该 profile 的 `multi-root-registry` 与 `multi-root-remote-tools` 行中移除旧档位及部署字段（`mode`、`manifestPath`、`team`、`broker`），保留个人连接和凭据路径。重新加载 profile 后，在插件设置中开启个人 SSH，并按[个人 SSH 指南](../guide/user/ssh-remote-environments.md)配置和登记目录。

## 文件布局与权限

- 插件级连接文件由 `remoteEnvironments.personalPath` 指定，默认为 `$DSH_HOME/storages/multi_root_workspace.remote-personal.json`。格式为 `{ schemaVersion: 2, revision, environments[] }`。环境保存目标、主机指纹、凭据引用、Helper 与传输/执行能力上限，远端目录由绑定单独保存。
- Workspace Root 绑定由 Host 写到 `<personalPath>.bindings.json`，格式为 `{ schemaVersion: 1, revision, bindings[] }`。绑定按本地 `primary`、`environmentId`、`rootId` 唯一标识，包含远端路径、动作与传输对端。一个 Workspace 可在同一环境绑定多个互不重叠的目录。新建或实际修改授权的绑定带 Host 生成的 `bindingId`。路径、动作集合与传输配对集合相同时，保存保留原记录、摘要和配置 revision。解除后重新添加同名绑定需要重新登记。
- 两个文件都必须是当前 uid 拥有的普通文件，非符号链接，权限至多 0600，父目录不得由 group/other 写，位置须在所有绑定的本地主根之外。连接文件缺失时，整个 personal 配置视为空；v2 连接文件存在时，绑定文件必须可读并通过保护检查。
- 两个文件共用 `<basename>.lock` 的内核租约与 CAS，当前 revision 取两份文件的最大值。读取 v1 合并文件时剥离环境里的 `workspace`，保留已保存的绑定路径与权限。首次写入先准备绑定文件，再原子替换为 v2 连接文件。在这之后，每个变更只原子替换它所属的文件。
- 凭据根由 `remoteEnvironments.credentialRoot` 指定，默认 `$DSH_HOME/storages/multi_root_workspace.ssh`。目录必须为当前 uid 所有且权限为 0700，否则返回 `credential-root-unsafe`。内部有 `credentials.json`、`keys/<id>` 与公钥、`secrets/<id>`、生成的 `ssh_config` 与 `known_hosts` 以及 `askpass.sh`。
- 每次远端 snapshot/list/admit/add/remove 前，`refreshPersonal()` 检查两个文件的保护和内容。有效配置原位发布，保留 owner 的授权域与现有 `remote-1` 连接。后续请求各自携带并校验当期清单摘要。配置损坏、语义非法或保护失效时，控制面进入 `config-invalid`，清空清单和摘要并拒绝远端准入，修复后可重新加载。
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
- `sshBindingSave` 用显式 `rootId` 编辑已有绑定，省略时创建。绑定归请求会话的 Workspace。`sshBindingRemove` 解除当前 Workspace 的绑定。

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

`sshConfigLink` 在 `~/.ssh/config` **首行**写入 `Include "<credentialRoot>/ssh_config"`（先备份为 `config.dsh-backup-<时间戳>`，幂等）。未链接而使用 managed 环境时连接报 `ssh-config-not-linked`。

SFTP 使用独立的 SSH 子进程，同样在命令行强制 `StrictHostKeyChecking=yes`、`ForwardAgent=no`、`UpdateHostKeys=no`，并关闭 ControlMaster/ControlPath；用户别名配置不能放宽这些参数。

## Helper 安装与密码访问密钥引导

- Helper：远端执行 `npm install --prefix ~/.dsh-helper/<ver> @deepseek-ai/dsh-ssh@<Host 同版>`，再比较远端 `helper.js` 的 SHA-256 与 Host 本机文件；一致才写入 `helper` 字段（`protocol` 取上游 `SSH_PROTOCOL_VERSION`）。远端 node 探测容忍缺失（`command -v node || true`），缺 node 或路径非绝对时报 `helper-node-missing`；node/`$HOME`/sha256 三个秒级探测在连接瞬断时自动重试一次，`npm install` 不重试；外部命令失败的报错携带退出码/信号与 stderr（截断），不再只剩裸 `Command failed:`。
- 编辑连接：派生的 `accessKeyId` 由 Host 从已保存记录保留，前端无需回传；仅 environmentId、hostname/port/user、credentialId 与已确认主机指纹均未变化时继承。改变身份后必须重新安装访问密钥，不能通过保存请求移植旧密钥。
- 密码引导：为该环境生成访问密钥后，以 `SSH_ASKPASS`（凭据根内 0700 脚本，只读取 `DSH_SSH_SECRET_FILE`）+ `SSH_ASKPASS_REQUIRE=force` + `BatchMode=no` 用密码登录一次，把公钥追加到远端 `authorized_keys`；此后连接一律走访问密钥。

## 实时开关

启用通过 `configureRemote` 加载个人连接和工作区目录绑定。停用时先卸载工具子树并以取消信号收束在飞操作，再关闭远端域与 IPC。

personal 子树首次等到控制面就绪再挂载，常规配置保存更新现有管理器。环境授权身份改变时只废弃该环境的 SFTP 与 Helper 代次。绑定编辑交由准入指纹失效，已无绑定引用的目录 Helper 在撤权复核后回收。其他环境和仍有效的目录可继续使用已有连接。

设置写入走 Host 的 `settings` 服务；旧版 `configure` 路径没有 `setSource` 推送，行必须通过 `settings.describe()` 读取实时值，否则只有重启后 loader 重新组合才生效（本页“实时开关”回归覆盖）。

## follower 与 remote-1

Registry 的 owner 是唯一打开远程域和 `remote-1` 监听的 Host。若另一个 DSH 实例持有 lease，但它的 profile 没有挂载 `multi-root-remote-tools`（例如桌面端主插件仍是 mainline），follower 的 `connectFollower` 会收到 `registry authority is not ready`；面板显示 `remote.status.ownerWithoutRemotePlane` 的可操作提示。重启 follower 不能改变 owner；需要退出另一个实例，或让启用 SSH 的 profile 成为唯一 Host。

## GUI 管理面板（个人模式）

GUI 入口有两处：

- **插件详情设置卡**：开启 SSH 远端环境后，第一行显示「SSH 远端」和「管理」按钮，进入与工作区面板共用的管理对话框。实验开关仍负责启用风险确认；开关关闭时隐藏该设置入口。
- **Workspace Folders 的「远端工作目录」**（`src/client/WorkspaceFoldersAction.tsx`）与「主要工作目录」「附属工作目录」并列，标题行同时提供「管理 SSH 远端…」与个人模式的「管理远端 Root 绑定」。远端目录列表与主要/附属工作目录共用 `WorkspaceRow`。首行依次显示末级文件夹名、SSH 环境名标签、当前会话的有效能力。第二行为可复制地址，使用 `ssh://user@host:port/path`。IPv6 主机加方括号，路径按 URI 规则转义。行尾「…」可登记或经确认移除授权。personal 模式可在该菜单中修改读取、写入、执行及本地传输对端，保存沿用绑定的 CAS 校验。对已登记目录修改能力后，通过同一菜单重新登记。解除绑定通过绑定对话框完成。

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

从 Workspace Folders 打开 `SshWorkspaceBindingsDialog`。选择已有连接，指定远端路径和允许的动作。可以通过只读 SFTP 选择目录，也可以手动输入规范化的 POSIX 绝对路径。本地传输对端可选 `primary` 和可用附加根的 `aliasId`。保存后从 Workspace Folders 对应目录的「…」菜单登记。绑定对话框可编辑或解除一条绑定，其他绑定和 SSH 连接独立保留。

新建绑定时，Host 将路径的末级目录名转换为最多 63 字符的小写标识。转换结果为空，或同一项目和 SSH 环境已有同名标识时，改用 UUID 的前 8 位，并保证该标识在当前范围内唯一。编辑已有绑定时沿用原标识。

「本项目绑定」与「远端工作目录」共用目录行。首行显示目录名、SSH 环境和已配置的权限，第二行显示可复制的远端地址；已配置的本地传输对端按导入和导出方向列在下方。行尾用铅笔编辑，垃圾桶打开解绑确认。确认解绑会撤销已有登记。

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

`remote_bash` 从 spawn 返回 handle 起观察取消、超时与授权变化，包括启动确认阶段。本 Host 的撤权通知立即触发重新准入，并每 250ms 向 Registry owner 轮询。启动前后都比较 epoch、有效模式、实际用到的登记指纹和连接代次。同一授权移除后重加会产生新的登记 ID，无关登记写入保留当前指纹。明确拒绝立即终止。临时不可用、摘要不一致和 IPC 中断在一次复核的 1 秒预算内重试，到期仍无法确认则以撤权终止。

终止原因返回 `termination: revoked | cancelled | timeout`。在 `terminateGraceMs` 内仍无法确认结果则返回 `unknown` 和 reconcileId，不无限等待、不重新执行。启动确认尚未到达时传输断开同样立即返回 `unknown`：不等待一个不会再来的确认，也不发送 terminate，因为启动是否发生本身未知。通知和轮询只是失效检测，不能代替每次新操作的正式准入；网络和调度延迟下不承诺撤权瞬间远端停止。

## 传输截止时间

`transfer.timeoutMs` 是一次复制的总 I/O 预算，包含准入、连接/握手、预检、读取/写入、回读校验和发布。并发调用可共享环境的 SFTP 通道与 opening。取消只结束当前调用的等待，其他调用可继续使用通道。待应答的请求超时会废弃通道代次，迟到的 opening 由管理器统一处理。清理使用独立且共享的 1 秒预算。失效代次按 residual/unknown 报告，避免按路径清理。CREATE 或 LINK 发出后缺少应答时返回 unknown 和 reconcileId。LINK 已确认时，清理失败仍返回 committed 与残留状态。
