# ADR-0042: 附加根 Files 行右键菜单与 viewer 置灰

## Status

Accepted

## Date

2026-11-14

## Context

DSH 0.2.2-alpha.3 把 Files 页签拆成"页头 + 受控的 `sidebar.files.tree` Factory"，同时引入
`@deepseek-ai/dsh-client-ui-context-menu`：行级右键由 Factory 的输入 `rowTriggerProps` 展开，
宿主贡献方（`ui-open-in-app` 的 file/directory 项、`ui-file-actions` 的 file 项）按 target 解析动作。

本插件的附加根树在 alpha.3+ 走宿主 Factory（ADR-0016 的适配路径），但 `nativeTreeInput` 只转发
`root/entries/directories/expanded/current/currentRef/onToggle/onOpen`：**`rowTriggerProps` 与 `canOpen` 从未转发**，
于是同一棵树在主根能右键、能按"有无 viewer"置灰，在附加根不能。旧版逐字节行渲染路径同样没有菜单。

## Decision

### D1 采集：根级 composed prop，而不是上游包依赖

`useContextMenu` 由 `ui-context-menu` 通过 `ctx.slots.provideRoot` 提供给**每个 renderer Component**
（`GlobalStandardProps`），我们的 `sidebar.right.tab.files.actions` occupant 直接拿得到。
`src/client/files-tree/context-menu.ts` 按结构取出它：

- `filesMenuHookOf(props)`：`props.useContextMenu` 是函数才用；类型是本地最小声明；
- `filesMenuSeat(hook, sessionId, kinds)`：调用一次得到 `getTriggerProps`；调用抛错（菜单插件正在销毁）即
  "没有菜单"；`kinds?.()` 非空时只在对应 target kind 已注册时绑定，避免弹出空菜单
  （`registeredKinds` 是 rc.2 才有的快照，alpha.3 没有——没有就按"该版本原生已注册 file/directory"直接绑定）。

**不把 `@deepseek-ai/dsh-client-ui-context-menu` 加进任何依赖**：`scripts/upgrade-dsh.mjs` 会把每个
`@deepseek-ai/dsh*` devDependency 改写成目标 release，而该包 0.2.2-alpha.3 之前不存在——加了会让 20 个
老版本 lane 在 `pnpm install` 阶段死亡（与 ADR-0038 的 client 依赖教训相同）。

### D2 转发：Factory 输入 + 旧行同一语义

`src/compat/files-tree.ts` 的 `NativeTreeOptions` 增加可选 `rowTriggerProps` 与 `canOpen`，由
`TreeView`（`src/client/files-tree/tree-view.tsx`）写进 Factory 输入；旧宿主走逐字节行渲染路径时，
同一 seat 直接 spread 到行按钮上。两条路径因此行为一致，且旧 Factory 对未知输入是忽略而非报错。

### D3 target：绝对路径是承重设计

行 target 为：

- `{ kind: 'file', value: { sessionId, path: <绝对路径> } }`
- `{ kind: 'directory', value: { sessionId, path: <绝对路径> } }`

附加根树的键本来就是绝对路径；宿主贡献方对绝对路径有一致语义：`resolveWorkspacePath(cwd, path)` 原样返回，
`workspaceFiles.stat`/`readBytes` 由本插件的 host 包装按绝对路径路由到附加根，
`fileAddressFor(sessionId, cwd, 绝对路径)` 返回携带绝对路径的 session 地址。若传 workspace 相对路径，
贡献方会按 Session cwd 拼成**主根**路径——静默命中另一个同名文件。`paneId` 省略（上游贡献方不读它，
插件也没有稳定 pane id）。

### D4 viewer 置灰（canOpen）

Factory 的 `canOpen` 由公开的 `ctx.sidebarRightTabs` 计算：`candidates(address).length > 0`；它的
`subscribe` 通过 inject product 的 `hooks.canOpen` 计数器让已绘制的树在 tab 类型变化时重读；
服务缺席（旧宿主）不传输入，全部文件可打开——与旧原生一致。地址同样用
`fileAddressFor(sessionId, undefined, path)`。

## Alternatives Considered

- **加 `@deepseek-ai/dsh-client-ui-context-menu` devDependency**：被 upgrade 矩阵改写后 20 个 lane 安装失败；
  且类型只需最小结构声明；排除。
- **自带 DOM 事件委托实现右键**：绕过宿主的键盘（ContextMenu / Shift+F10）、焦点、菜单位置和贡献方解析；
  等于第二个菜单实现；排除。
- **workspace 相对 target**：所有贡献方按主根解析，右键"在文件管理器显示/打开"会命中错误文件；排除。
- **只支持 Factory 路径、不管旧行**：旧行只在没有菜单服务的宿主上绘制，看似无关；但两条渲染路径必须同语义，
  否则将来 DOM 回退会静默丢菜单；统一 spread 成本极低；采纳。

## Consequences

- 附加根行获得与主根完全相同的一组菜单项（在侧栏/浮窗打开、在文件管理器显示、默认应用打开、复制路径、
  下载/另存/复制图片），且都作用于附加根的真实路径；预览侧 Folder 导航器的接管树同样生效。
- 菜单项本身是上游贡献方的，插件只提供 target：上游菜单变化自动跟随；插件只维护触发绑定与 target 语义。
- 老宿主无 `useContextMenu` → 不绑定、DOM 不变（原生同样没有菜单）；无 `sidebarRightTabs` → 不置灰。
- 测试面：右键 target 的绝对路径与 session、kinds 缺省、无 seat 时 DOM 不变、Factory 输入透传、
  预览 retarget 的 target；见 `tests/client-files.spec.tsx`/`tests/client-switcher.spec.tsx`/
  `tests/client-navigator.spec.tsx`。

## Related Documents

- [ADR-0016](./ADR-0016-files-tab-native-tree-fork.md)（树体 fork 与宿主 Factory 适配）
- [ADR-0009](./ADR-0009-dsh-compat-contract.md)（结构探测与兼容契约）
- [ADR-0041](./ADR-0041-additional-root-workspace-search.md)（同批的工作区搜索）
- [完成计划](../plans/completed/2026-11-14-additional-root-files-parity.md)
- `src/client/files-tree/FORK.md`
