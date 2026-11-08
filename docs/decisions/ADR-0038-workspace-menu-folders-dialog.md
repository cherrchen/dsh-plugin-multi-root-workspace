# ADR-0038: 工作区右键菜单复用 Workspace Folders 对话框

## Status

Accepted（决策定案；实施状态与证据见[计划](../plans/active/2026-11-08-workspace-menu-folders-dialog.md)）。

## Date

2026-11-08

## Context

上游工作区行（`sidebar.workspaces` 的 `WorkspaceBrowser`）把每一行的 `...` 手势发布为 `workspace` context-menu target（`{ workspaceId, path, displayTitle }`，定义在 `packages/client/ui-workspace/src/client/contract/slots.ts`）。现有贡献按 `order` 排列：`workspace.rename` = 100、`open-in-app.workspace` = 200、`workspace.delete` = 300。插件需要一个位于重命名与 "在 Finder 中显示" 之间的入口，打开本插件已有的"工作区目录"管理对话框。

本插件的对话框目前有两个 owner，都是组件本地状态：

- `WorkspaceFoldersAction`（`src/client/WorkspaceFoldersAction.tsx`）：sidebar footer 的 `sidebar.footer.action` 入口，`const [open, setOpen] = useState(false)`；
- `RootSwitcher`（`src/client/RootSwitcher.tsx`）：sidebar-right Files 面板的 `sidebar.right.tab.files.actions` 占用者，自己的 `dialogOpen`；它导出的 `WorkspaceFoldersDialog` 是同一个组件。

`RootSwitcher` 是 Files pane 的会话级占用者，可能根本没有挂载（没有 Files pane、没有 `absolutePath`、旧运行时没有该槽位）。工作区菜单是全局的：它不能要求某个 Files pane 存在，也不能把命令式句柄塞进一个可能不存在的组件。另一方面，对话框的每个请求都要求一个有效 `sessionId`（面板主根由 host session 推导，ADR-0008）——菜单在被点击的那一刻并不知道应该用哪个 session。

上游 `uiWorkspace` 服务（cordis Service 名 `uiWorkspace`）提供了两条能力：

- `openWorkspace(workspaceId, beforeOpen?, options?)`：连接/复用目标工作区的 blank session，`beforeOpen(sessionId)` 在选中**之前**同步调用；导航被后续操作取代时 `openWorkspace` 正常 resolve 但不会调用 `beforeOpen` 或改变选中。它复用已有 blank，没有才创建。
- `startSession(workspaceId?, options?)`：返回 `void`，拿不到目标 session id，不能用于"先确认当前会话，再打开对话框"。

`uiWorkspace`、`workspaces`、`panel`、`contextMenus` 在裁剪组合中都可能缺席，插件一直按可选服务读取它们（`src/client/index.ts` 的 `readService`；`ctx.inject(['contextMenus', ...])` 软注册）。

版本边界（上游 git tag 核对）：extensible context-menu 的 `ContextMenus` 服务、`contextMenu.icon` keyed slot 与 `workspace` target **都首次出现在 `0.2.2-alpha.3`**（`@deepseek-ai/dsh-client-ui-context-menu` 由 commit `411f157983` 引入，图标 keyed slot 由 `9dce789696` 引入；两者首个包含它们的 release tag 都是 `dsh-v0.2.2-alpha.3`）。`0.2.2-alpha.2` 及更早的 20 个受支持版本没有该服务、slot 或 target。

图标方面，dev pin（DSH `0.2.2-rc.1`）的 `@deepseek-ai/dsh-client-ui-primitives` 导出 `IconWorkspaceTreeOutlineRegular`；像素名时代（`0.1.5` / `0.1.6`）使用 `IconWorkspaceTreeOutline16`。现有的 `IconAccessInherit` 已经按这两个名字探测。

## Decision

1. **菜单项身份与位置。** 新贡献 `id: 'multi-root-workspace.manage-folders'`、`target: 'workspace'`、`order: 150`；动作 id 为 `manage`，label 复用 `switcher.manage`（"管理工作区目录…"），图标 key 为 `multi-root-workspace.manage-folders`。菜单同时出现在右键菜单，这是 `workspace` target 的固有行为，接受。

2. **由 footer 的对话框充当菜单的唯一宿主。** 新增轻量 `WorkspaceFoldersDialogController`（`src/client/workspace-folders-dialog.ts`），在 `apply()` 中创建一次，同时交给 footer 的 `WorkspaceFoldersAction` 和菜单安装器。footer 以 `dialogOwner: true` 注册自己的打开函数；controller 的 `available` 是一个 `ObservableSnapshot<boolean>`，随 owner 注册/注销翻转。`open(sessionId)` 只在有 owner 时调用并返回 `true`，否则返回 `false`；owner 抛错时返回 `false`，不改变可用性。多个 owner 采用 last-wins：旧 owner 的注销函数在它已不是当前 owner 时是 no-op。

3. **不新增对话框实例，也不迁移 `RootSwitcher`。** `RootSwitcher` 保持零改动，继续拥有自己的对话框；Files actions 的 compact `WorkspaceFoldersAction` 不传 controller、不注册 owner，行为不变。本阶段接受"两个现有 dialog owner"的代价；把它们统一成一个全局 host 是另一次重构，不在本决策内。

4. **footer owner 支持指定目标会话。** `WorkspaceFoldersAction` 增加可选 `dialogController` / `dialogOwner` props 与内部 `targetSessionId`。footer 触发按钮保留原有开/关切换语义；通过 controller 打开时把 `targetSessionId` 设为目标会话并打开。对话框的 `sessionId` 解析为 `targetSessionId ?? props.sessionId?.()`；关闭时清空目标。dialog 已打开时收到新请求只更新目标，`sessionId` 函数身份变化会触发对话框重新 `list`；旧请求的迟到应答由现有的 epoch + sessionId 守卫丢弃。

5. **整条 UI 变更以 `contextMenu.icon` 槽位为门。** `installWorkspaceMenu` 把图标注册与 `contextMenus.register` 一起放进 `scope.slots.inject('contextMenu.icon', ...)` 的回调；槽位不存在时回调根本不执行，因此菜单贡献、`contextMenu.icon` key 和图标注册都不存在。这不是"只隐藏图标"：在 `0.2.2-alpha.3` 之前的版本上，本分支的 UI 修改等于没有发生，其他既有 UI（footer、`RootSwitcher`、Files 页签）保持原样。

   菜单 `resolve` 只有在以下全部成立时才返回 `disabled: false`：`panel` 存在、`workspaces.list` 快照中能找到目标 `workspaceId`、`uiWorkspace.openWorkspace` 是函数、`dialog.available` 为 `true`。任一缺失即置灰，不导航、不打开。`contextMenus` 或 `slots` 缺失时 `ctx.inject` 不触发，整个入口不存在且不抛错。

   `workspaces` 与 `uiWorkspace` 在 **resolve/run 时按需读取**（以 thunk 注入），不在 `apply()` 中捕获快照：这两个服务由其他客户端插件提供，可能在本插件 entry 之后才激活；捕获快照会让入口永久置灰。同一个 `sessionId()` 解析器既用于当前归属判断，也用于 await 后的 current 校验，不另存一份 `sessions` 快照。

6. **导航顺序：能复用当前会话就复用，否则先切换再打开。**
   - 当前 session 属于被点击的工作区（`workspace.sessionIds.includes(current)`）→ 不导航，直接 `dialog.open(current)`。
   - 否则（含当前没有 session、当前 session orphaned、当前 session 属于别的工作区）**以方法形式**调用 `uiWorkspace.openWorkspace(workspaceId, id => { target = id })`（`UiWorkspaceService.openWorkspace` 读取 `this`，解构后的裸函数调用会同步抛错），await 之后要求 `target` 存在且**主视图仍保留该 session**，才 `dialog.open(target)`。判定优先使用 `sessions.retainInfo(target).getSnapshot().retainedBy.mainView > 0`：`retain()` 在 `replaceMain` 内同步更新保留计数，而刚创建 blank 的 catalog 行可能后到；没有该探针时才回退到 catalog 的 `currentSessionIdOf(sessions) === target`。保留探针明确为 `false` 时，catalog 即使仍把 target 当作 current 也不得打开——那正是后续导航已释放它的情形。
   - 同一个保留探针也用于"当前 session 是否属于目标工作区"：遍历目标工作区的 `sessionIds`，优先看谁的 `mainView` 计数为正；只有探针不可用时才用 catalog。否则 catalog 既可能滞后于刚选中的新 blank，也可能仍停留在上一个工作区的 session。
   - `openWorkspace` reject、导航被后续操作取代、或 await 后 current 不是 target → 不打开。`openWorkspace` 失败时上游已经显示创建失败 notice，插件不重复提示。
   - 不因当前 session orphaned 而置灰：它只是"不属于目标工作区"，按正常导航处理。

7. **图标走现有兼容探针。** `src/compat/client-icons.ts` 增加 `IconWorkspaceTree = maybeIcon(['IconWorkspaceTreeOutline16', 'IconWorkspaceTreeOutlineRegular']) ?? IconFolderOpen`，`contextMenu.icon` 注册这个组件。若工作区树图标与 `IconFolderOpen` 都缺席，现有 required-icon 探针已在模块加载时 fail loud，不新增静默路径。

8. **不新增包依赖。** `@deepseek-ai/dsh-client-ui-context-menu` 在 `0.2.2-alpha.3` 之前不存在，而 CI 的升级矩阵会把每个 `@deepseek-ai/dsh*` devDependency 重指到目标版本——若把它列为 devDependency，所有旧版本 lane 会在 `pnpm install` 阶段因 `ERR_PNPM_NO_MATCHING_VERSION` 失败。因此本模块只用**本地结构化接口**声明 `ContextMenus.register` 与 `contextMenu.icon` slot 的极小切片；运行期仍由 `ctx.inject` 软等待服务，不写进 `dsh.client.inject`（该字段是必须到达的工厂边）。

## Alternatives Considered

- **为菜单新建一个对话框实例。** 最直接，但会产生第三份列表状态与第三套 `list`/mutation 流程；同一时刻可能出现两个管理对话框，状态互不感知。否决。
- **把对话框提升为全局 host，footer、RootSwitcher、菜单三方共用。** 长期更干净，但要重写 `RootSwitcher` 的本地生命周期与关闭刷新语义，违反本次"RootSwitcher 零改动"的硬约束，也超出一次菜单入口的范围。推迟到单独重构。
- **通过 imperative handle / portal 复用 `RootSwitcher` 的对话框。** 菜单是全局的，`RootSwitcher` 可能未挂载；为了菜单而强行挂载一个 Files 占用者既不可靠也不合理。否决。
- **每次点击都新建 blank session。** 会制造大量空会话，且与上游 `openWorkspace` 的复用语义冲突。否决。
- **用 `uiWorkspace.startSession` 代替 `openWorkspace`。** 返回 `void`，无法确认目标 session 已成为 current，也无法把固定 `sessionId` 交给对话框。否决。
- **只检查 `panel`，`uiWorkspace` 缺失时用当前路径猜测主根。** 面板主根必须由 host 按 session 推导（ADR-0008）；客户端猜 cwd 会破坏授权边界。置灰是唯一正确的降级。否决。
- **当前 session orphaned 时置灰。** orphaned 只表示它不属于当前列表中的任何工作区，不代表目标工作区无效；按"不属于目标"导航是正确行为。否决。

## 版本边界（2026-11-08 核对）

| 上游能力 | 首次出现的受支持版本 | 证据 |
| --- | --- | --- |
| `@deepseek-ai/dsh-client-ui-context-menu` / `ContextMenus` 服务 | `0.2.2-alpha.3` | commit `411f157983`；`git tag --contains` 仅 `dsh-v0.2.2-alpha.3`、`dsh-v0.2.2-rc.1` |
| `contextMenu.icon` keyed slot | `0.2.2-alpha.3` | commit `9dce789696`；同上 |
| `workspace` context-menu target | `0.2.2-alpha.3` | `packages/client/ui-workspace/src/client/contract/slots.ts` 在该 tag 才出现 `workspace:` 声明 |

在此之前的受支持版本（`0.1.5-rc.2` … `0.2.2-alpha.2`，共 20 个）没有 `contextMenus`，也没有 `contextMenu.icon` 或 `workspace` target；`ctx.inject(['contextMenus', 'slots'], ...)` 永远不触发，菜单贡献与图标注册都不存在，行为等同"本分支没有做这次 UI 修改"。

## 修订（2026-11-08）

真实环境目检发现"repo-a 中点击 repo-b 的 `...` → 管理工作区目录"既不导航也不弹窗。定位到两层缺陷：

1. **主因：`openWorkspace` 被解构后裸调用，`this` 丢失。** `UiWorkspaceService.openWorkspace` 是普通方法（`return this.openWorkspaceSession(...)`），解构得到的函数引用以裸形式调用会同步抛 `TypeError`；首版的 `try/catch` 把它当成"导航失败"静默吞掉，于是既没有创建/复用 blank，也没有对话框，连上游的创建失败 notice 都不会出现。修复为保留服务对象、以 `uiWorkspace.openWorkspace(...)` 方法形式调用。回归用一个依赖 `this` 的 stub 钉住。
2. **次因：导航后只读 catalog 判断 current。** 修好绑定后，`openWorkspace` 已在 `replaceMain` 中同步 `retain()` 目标 blank，但该 session 的 catalog 行可能后到，`currentSessionIdOf()` 仍返回旧 session。修复为 retention probe 优先（`sessions.retainInfo(target).retainedBy.mainView > 0`），catalog 只在探针缺席时回退；保留探针明确为 `false` 时，catalog 即使仍指向 target 也不打开。回归覆盖：catalog 滞后但 retention 已保留 target；retention 已释放、catalog 仍指向 target；catalog 未列出但 retention 已保留的成员。

修复后在隔离 Web 宿主（1280×800，headless Chrome 驱动）实测：当前 repo-a → 点击 repo-b 的 `...` → 管理工作区目录… → 当前会话切换为 repo-b，对话框可见且主根显示 repo-b 的 canonical 路径。

## Consequences

- footer 未挂载（该组合没有 `sidebar.footer.action`）时，菜单项会置灰——这是"菜单只复用 footer 对话框"的直接代价，也是 `dialog.available` 的用途。
- 插件仍有两个 dialog owner（footer、RootSwitcher）；二者理论上可同时存在，但都是 modal，实际互斥。本阶段明确不统一。
- 点击菜单可能改变当前会话：目标工作区没有合适的 blank 时由上游创建一个。用户可见行为是"跳到该工作区的空白页，随后打开目录对话框"。
- 导航竞态被 await 后的 current 校验收敛；被取代的导航不会弹出一个属于旧目标的对话框。
- controller 是 `apply()` 作用域的，不是模块级单例；插件热重载会重新创建，不会把上一个客户端的 owner 带过来。
- 右键菜单与 `...` 菜单都会出现该条目，这是 `workspace` target 的固有行为，不额外去重。
- 本分支不新增任何包依赖：context-menu 的类型面是本地结构化接口，发布包与开发树都不引入该包，`compat:check` 与旧版本的升级矩阵都不受影响。
- 没有改变任何授权：对话框仍按 session 向 host 请求，目标 session 必须先在客户端成为 current。

## Related Documents

- [ADR-0008：面板主根由 host session 推导](./ADR-0008-panel-session-derived-authority.md)
- [ADR-0005：出树 client 半部与 Connection RPC 通道](./ADR-0005-out-of-tree-client-transport.md)
- [ADR-0015：Files 页签根选择器](./ADR-0015-files-tab-plugin-owned-browsing.md)
- [实施计划](../plans/active/2026-11-08-workspace-menu-folders-dialog.md)
