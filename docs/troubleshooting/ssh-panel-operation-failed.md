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
