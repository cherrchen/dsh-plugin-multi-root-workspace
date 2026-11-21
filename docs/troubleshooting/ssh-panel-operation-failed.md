# 面板 SSH 区块只显示“操作失败。”：Schemastery volatile 字段泄漏成 custodyMode 对象

## 症状

- 打开 Workspace Folders 面板，远端 / SSH 区块只显示一条通用告警“操作失败。”；凭据、环境、绑定都不渲染。
- Host 侧本身没有报错，面板通道返回 HTTP 200；同一个通道的 `list` 等其他端点正常。
- 只有启用 `multi-root-remote-tools` 开关的 Host 会出现，关闭开关时整个远端区块隐藏。

## 根本原因

`multi-root-remote-tools` 行的配置由 Schemastery 校验。`enabled` / `mode` 是 `volatileField`，校验后的配置里它们是**带 `get()` 的包装对象**，不是布尔值或字符串。`src/remote/tools.ts` 的 `live()` 直接把 `config.mode` 当作回退值传给 `configureRemote`，于是 `RemoteControlPlane.mode` 变成包装对象。

`remotesViewOf` 把 `registry.remoteMode` 原样写进 `RemotesView.custodyMode`，线上值因此是 `{}`。浏览器端 `parseRemotesView` 的 `z.enum` 拒绝整个视图，抛出 `PanelError('panel/bad-response')`；`errorKeyOf` 找不到该 code 的文案，回退到 `error.fallback`（“操作失败。”）。SSH 管理区因 `custodyMode !== 'personal'` 永远不会挂载。

修复前可以用真实 Host 的通道应答确认：

```json
{"ok":true,"value":{"primaryRoot":"...","mode":"workspace-write","custodyMode":{},"status":{"state":"ready"},"endpoints":[]}}
```

## 诊断方法

1. 带浏览器 cookie 向 `/multi-root-workspace/remotes` 发送 Connection RPC 信封，观察 `custodyMode` 是否为字符串。
2. 若它是对象，检查 `multi-root-remote-tools` 行配置是否经过 Schemastery 校验（生产组合一定经过）。
3. 在浏览器侧对同一应答调用 `parseRemotesView`；`custodyMode` 不是三个枚举值之一时整个视图失败。

## 已验证的解决方案

- `src/compat/remote-settings.ts` 新增 `remoteModeOf()` 与字段级 `unwrapSettings()`：`readRemoteSettingsValue` 和 `initialValue` 都先解开 volatile 包装；`enabled`、`mode`、`team` 不再以包装对象参与判断。
- `src/remote/tools.ts` 用 `remoteModeOf(config.mode)` 读取行配置回退值，并用解包后的 `enabled` 生成 Settings 初始 seed；`registry.remoteMode` 始终是三个字符串之一。
- `src/remote/panel-contract.ts` 把 `custodyMode` 当作可选元数据：未知/不可读的值归一为 `undefined`，不再让一个可选字段使整个远端区块解析失败。
- 回归测试：`tests/remote-personal.spec.ts` 覆盖 volatile 解包与坏 `custodyMode`；`tests/remote-tools-switch.spec.ts` 用真实 Schemastery 校验后的行配置断言 `registry.remoteMode === 'personal'`。

修复后同一真实 Host 的应答为 `"custodyMode":"personal"`，`sshState` 返回空配置状态，SSH 管理区正常挂载。

## 同区块的另外两个现象

### 在设置中开启后必须重启才生效

旧版 Settings 服务没有 `installSection`，`installRemoteSettings` 走 `settings.configure` 兼容路径。该路径只监听 `settings/document-updated`，但 `read()` 始终回退到启动时的 loader 配置（没有 `setSource` 推送）。因此写入成功、事件也触发，`sync()` 仍读到旧值；只有重启后 loader 重新组合才把新值带进配置。

修复：兼容路径在每次读取时调用 `settings.describe()`，找到 `multi-root-remote-tools` 的实时 `value`；启动时的 loader 配置只在 `describe` 不可用时回退。回归测试见 `tests/remote-personal.spec.ts` 的 “reads the live namespace on the legacy configure path”。

### `registry authority is not ready`

这是 Registry 的 follower 连接 owner 的 `remote-1` socket 失败。只有持有 store lease 的 Host 会打开远程域和 `remote-1`；若另一个 DSH 实例持有 lease、但它的 profile 没有挂载 `multi-root-remote-tools`（例如桌面端主插件仍是 mainline），follower 永远无法就绪，重启 follower 也不会改变 owner。

修复：`connectFollower` 把这个具体错误映射为 `status.code = 'owner-without-remote-plane'`，面板显示可操作的双语提示；同时写一条 Host 日志。真正恢复 SSH 需要退出另一个实例，或让启用 SSH 的 profile 成为唯一 Host。

### `exec-requires-helper`

带 exec 勾选保存环境时被服务端拒绝。exec 只能走已安装的远端 helper：helper 未安装，或保存时改动了目标身份（hostname/port/user/凭据类型，helper 随之失效），服务端在消耗扫描令牌和写 `known_hosts` 之前就拒绝。GUI 对不满足条件的草稿直接禁用“允许命令执行”并给出引导文案。

修复：先不勾 exec 保存 → 在该环境行安装 helper → 再编辑勾选 exec。不要直接手改配置文件塞 `exec` 节——`toDeploymentManifest` 会以 `invalid-manifest` 拒绝 helper-less exec。

### `personal-config-conflict`

`savePersonalConfig` 的 CAS 在同目录 `<basename>.lock` 的 Registry 权威租约内执行：磁盘 `revision` 与请求不符、或另一个 Host 进程正持有写锁，都报此错。前端已自动重取 `sshState` 再提示；反复出现说明另一个 DSH 实例在并发写同一个人配置，退出多余实例即可。损坏的配置文件不会进入此路径——加载失败使控制面停在 `config-invalid` 并拒绝远端操作，写回合法文件（哪怕是原文）即恢复 `ready`。

### 旧 SSH 配置升级后保持停用

当前构建只开放个人 SSH。旧版团队和硬化配置的识别与迁移方式见 [SSH 远端环境参考](../reference/ssh-remote-environments.md#停用的旧配置)。

### 登记瞬间报「无法验证该远端端点的身份。」（`endpoint-unverifiable`）

秒报、不经网络时，`verifiedAddTarget` 只在一个地方抛出该码：**校验器没有注册**。`SshEndpointVerifier` 由 `multi-root-remote-tools` 行的受门禁子树挂载，挂载效果要求 `remoteStatus.state === 'ready'`；开关在启动即开（`cordis.patch.yml` `enabled: true`）时，首次 sync 会赶在 authority 获取完成之前运行——挂载早退，但 `mountedIdentity` 已记下同一 `(mode, team, digest)` 键，之后同键 sync 一律早退，校验器永久缺席。且 `openOwner`/`connectFollower` 把控制面推入 `ready` 时不发 `onRemoteChange`，没有任何事件能把它救回来；只有碰巧改了清单摘要才重挂。

目前 `tools.ts` 等待控制面进入 `ready` 后首次挂载个人 SSH 工具；`registry.ts` 在 `openOwner` 和 `connectFollower` 建立 `ready` 时发送 `notifyRemoteChange()`，触发重新同步。行级与栈级回归均见 `tests/remote-personal-ops.spec.ts`。

校验器挂载后还有第二层瞬发失败：`SshEnvironmentManager.open()` 的 `verifyHostIdentity` 用**裸 `ssh -G <别名>`**（不带 `-F`）解析托管别名，要求托管 `ssh_config` 已 Include 进 `~/.ssh/config`——这是设计：remote_copy/remote_bash 执行时要求用户自己的 `ssh` 能解析别名。未链接时报 `ssh-config-not-linked`，面板文案会引导先点「链接到 ~/.ssh/config」。注意 `installHelper`/`testConnection` 走 `-F` 不需要 Include，所以"装得上 helper、登记不过"是正常的先后顺序。

另：`endpoint-unverifiable`、`ssh-config-not-linked`、`host-identity-unverifiable`、`invalid-manifest`、`workspace-invalid` 的 Host message 现在都透传到面板（`errorHasDetail`），同一文案背后的三种原因（校验器缺失 / 只读 confine 不满 / 探针超时）不再被压平。

### 报错只剩 `Command failed: ssh ...`（括号内无原因）

`execFile` 非零退出时 error.message 只有命令行，真实原因（`Permission denied`、`Connection timed out`、`Host key verification failed`）在 `error.stderr` 上被丢弃；`defaultExec` 现在把退出码/信号与 stderr（截断）附进报错。

其中 `command -v node` 这条还有个可达性缺陷：远端缺 node 时它退出 1，`execFile` 直接 reject，带文案的 `helper-node-missing` 永远不可达（`testConnection` 的探针有 `|| true`，`installHelper` 漏了）。已对齐为 `command -v node || true`：空输出落到 `checkRemotePath`，正常抛 `helper-node-missing`。

同一函数里 `printf %s "$HOME"` / `sha256sum` 这类秒级探测在小规格远端 `npm install` 刚结束的颠簸窗口内会因连接瞬断失败；三者各自动重试一次（`npm install` 本身永不重试），持续性失败仍以原样报错。

### 安装 helper 走到最后一步报「个人配置无效，未写入。」

`workspace` 只在 `helper` transport 下才进 `connection` 校验；sftp transport 保存时 `workspace` 原样落盘从不校验。于是 `/root/`（尾斜杠）、`~/x`、`a//b` 这类非规范化值会在 helper 安装成功后写入 `helper` 字段时被 `toDeploymentManifest` 拒绝，裹成 `personal-config-invalid`。`sshEnvironmentSave` 现在在写入边界先跑 `checkRemotePath`，坏值以 `workspace-invalid` 当场拒绝（面板会显示被拒的具体路径）。
