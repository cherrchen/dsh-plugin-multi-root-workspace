# ADR-0015: Files 页签根选择器与插件自有 portal 渲染

## Status

Accepted

## Date

2026-10-12

## Context

附加根此前只能在 Workspace Folders 对话框里逐行展开浏览：树埋在管理界面内，每次查看要穿过一层模态，且同一行的树与列表操作挤在一个布局里。Files 页签天然是文件浏览的位置——它的头部显示当前路径、提供 actions 槽位，但槽位契约只允许在头部放控件，树区（`[data-files-body]`）是上游 `FilesBody` 的私有领地。

两条硬约束决定了可选形态：

1. **原生树无法重指到附加根**。上游树的根是 `sessions.byId[sessionId].cwd`（client 投影 fill-once，连 `working-directory/change` 都不更新它），`DirectoryNode` 与其 store 在上游 `apply` 闭包内，出树不可达；feature 插件隔离也禁止 import 上游组件。
2. **上游 DOM 形状不是槽位契约**。`FilesBody` 的 `.header` 是扁平 flex 行（`PathLabel` → reload → actions occupants），flex 项本体携带 `data-files-root` / `data-files-path` / `data-files-reload` / `data-files-body` 属性——它们存在但不被承诺。所有依赖这些钩子的规则必须在上游改 DOM 时**静默失效**，而不是破坏功能。

数据链路本就就绪：`files` / `readFile` RPC 已按 exact entry 路由附加根，`RootFileTree` 已具备懒加载、中止与过期响应丢弃。（**2026-10-12 修订**：`files` / `readFile` 端点与 `RootFileTree` 已随 P11 删除——树改为逐字节复刻上游 `ui-sidebar-files`，列目录/监听直接走 `workspaceFiles` Remote，见文末修订节。）

## Decision

`sidebar.right.tab.files.actions` 的 occupant 是 **`RootSwitcher`**（owner `absolutePath` 缺失时退回 P1 的仅图标 launcher）：

- **触发钮伪装成路径标签入口**：占据路径标签位置的 flex 项（`order: -1` + `flex: 1 1 auto` + `min-width: 0`），上游 `[data-files-path]` 由 `:has()` 守卫规则隐藏。菜单列主根（标注 `panel.primary`、默认选中）与各附加根（`list` RPC 按 `sessionId` 取视图；非 `available` 的根如实标注状态且禁用）；「管理工作区目录…」放在 `Menu` 的 `footer` 区，打开同一个 `WorkspaceFoldersDialog`。触发钮后随一个 `PathLabel`（`mrfw-switcherPath`）显示**选中根**的完整路径——主根即原标签的值，附加根为其 canonical 路径——同一上游组件，观感与原生一致；该元素不携带 `data-files-*`，不会被本插件的隐藏规则误伤。
- **附加根选中时接管树区**：`closest('[data-files-root]')` 定位本 pane，`createPortal` 把树挂成 `[data-files-body]` 的兄弟节点；`:has(.mrfw-rootSwitcher[data-root-kind="additional"])` 条件下的规则同时隐藏原生 body 与 reload——reload 刷的是被隐藏的树，留着只会误导。header 原位出现一个同款 `.mrfw-switcherReload` 图标钮（28px tool 配方），点击调复刻 face 的 `refresh(tabId)`——每个已挂载目录在现有行下后台重拉、成功即就地换数据，展开态保留、不出现 loading 闪烁；它与 portal 同生同灭，纯菜单降级时不会出现死按钮。原生树在后台保持 watch，切回主根即恢复。（**2026-10-12 修订**：portal 的树从自绘 `RootFileTree` 换成 `src/client/files-tree/` 下逐字节复刻的上游组件——`data-dockkit-content` 取 tab id、takeover AbortController 作生命周期、列目录与 watch 走 `workspaceFiles.list/changes`、文件经 `fileAddressFor(sessionId, undefined, path)` + `sidebarRight.openResourceIn` 交给 viewer 打开，详见文末修订节。）
- **附加根选中时同时接管 open-in-app 分离按钮**：上游 `ui-open-in-app` 的 files.actions occupant 拿到的 `absolutePath` 永远是主根，且该 prop 由 `FilesBody` 单方注入、插件无法改指——选中附加根时它会把目录发到错误的位置，是缺陷而非可接受偏差。`:has(...[data-root-kind="additional"])` 规则隐藏其 `data-open-target="directory"` 元素，header 原位渲染 `src/client/open-in-app/` 下**逐字节复刻**的上游组件树（`OpenInAppAction`/`OpenTargetButton`/`controller`/`applications`/`open-failure-toast`，来源 `d743267388` = `0.2.1-alpha.2`，唯一改动是 css specifier 追加 `.ts`），`absolutePath` 换成选中根。宿主 HTTP 路由（`GET open-in-app/apps`/`POST open-in-app/open`）不校验路径归属，附加根路径直接可用；locale 直接 `bind('open-in-app')` 消费上游已注册词典，应用选择共享 `dsh.open-in-app.choice` 持久化键——观感、文案、偏好与原生完全一致并自动跟随上游更新。复刻面与同步步骤见 `src/client/open-in-app/FORK.md`。
- **选中态是组件实例 state**：每个 tab 渲染实例独立、重开复位，不持久化也不跨 tab 共享。
- **降级是设计的一部分**：无 connection/session → 菜单只列主根（观感等同原生路径标签）；找不到 `[data-files-root]` 祖先 → 不 portal、不隐藏任何上游元素，组件仍是一个可用的菜单；上游改掉 `data-*` 属性 → 全部 `:has()` 规则与 `closest()` 同时失效，退回原生布局。DOM 钩子已列入 `.agent/note/dsh-compat-contract.md` 的升版目检清单。
- **对话框回归纯管理**：行内 `RootFileTree` 与 `files.browse` 词条移除，浏览统一在 Files 页签进行。（**2026-10-12 修订**：`RootFileTree` 组件、`files` / `readFile` 端点与 `src/panel-files.ts` 随后也整体删除，不再留回退。）

## Alternatives Considered

- **复用 / 重指上游原生树**：根投影 fill-once、组件与 store 在闭包内，出树不可达；排除（见 Context）。
- **上游参数化（给 native tree 加 root prop / seam）**：属于上游仓库的改动，本插件约束下不可行；`workspaceFiles.list/changes` 的包装已经就位，将来上游若提供树级 seam，本组件退化为薄适配即可。
- **保留对话框内浏览**：树埋在模态里、与列表操作争布局，浏览这个高频动作为它付出的层级太深；已否定并实际移除。
- **替换 `sidebar.right.pane.tab` body seat**：替换的是整个上游 tab 体，耦合面远大于四个 `data-*` 钩子，否决。
- **新 host 端点承载切换器状态**：选中态纯属浏览器表现，不需要持久化权威；复用既有 `list`/`files`/`readFile` 即可，不增加端点。

## Consequences

- Files 页签成为多根浏览入口；选中附加根时树区归本插件渲染，reload 与 open-in-app 的隐藏符合"它们服务的是原生树与主根"的事实。
- 视觉接管依赖五个上游 `data-*` 属性与扁平 flex header——非槽位契约，失效路径全部为静默退化（已写入 compat 目检与故障排查条目）。
- open-in-app 复刻引入一份**有同步义务的源码副本**（FORK.md 钉住上游 commit、逐字节清单与 diff 步骤）；`*Regular` 图标族缺席的 0.1.x 运行时不建 adapter、不渲染该按钮，与上游"无应用即无按钮"同型降级。
- `dsh-client-store` 随复刻的 controller 进入 client bundle 的 module-table 依赖集（`createSnapshotStore`），bundle 测试随之钉住；`@deepseek-ai/dsh-host-open-in-app` 仅以 devDependency 形式取 `./shared` 路由常量内联。
- 上游 `workspace.openLocal` 快捷键仍按 `session.cwd` 打开主根——其解析在上游 apply 闭包内，插件够不着；已接受的已知限制，仅影响键盘路径。
- `createPortal` 挂进上游容器属非常规手段，但 React 树仍属本插件（事件、状态、卸载自洽），容器缺席时干脆不渲染。
- `order` 只改视觉序：选择器在 DOM 中仍位于 reload 之后，Tab 键序与读屏序不变——已接受的已知限制。
- 原生树在隐藏期间继续 watch（小开销，换来瞬时切回）；**2026-10-12 修订**：复刻树接管后同样带 watch 自动刷新（`autoRefresh` 恒 true 即上游默认），自绘树「只能手动刷新」的限制随之消失。
- `react-dom` 因此进入 client bundle 的 module-table 依赖集（`createPortal`），bundle 测试随之钉住。

## 修订：接管树改为逐字节复刻上游 Files 树（2026-10-12，Amendment）

Status 保持 **Accepted**；portal 接管、`:has()` 守卫、open-in-app 复刻与降级模型不变，改变的是 portal 里那棵树的来路——自绘 `RootFileTree`（`▸`/`▾` 文本前缀 + 插件私有 `files`/`readFile` RPC + 有界文本预览）换成 `src/client/files-tree/` 下对上游 `@deepseek-ai/dsh-client-ui-sidebar-files` 的逐字节复刻（基线 `d743267388` = `0.2.1-alpha.2`，与 dev pin 相同；复刻面与同步步骤见 `src/client/files-tree/FORK.md`）。**该替换的完整决策记录（调研、备选与后果）见 [ADR-0016](./ADR-0016-files-tab-native-tree-fork.md)，是本修订的唯一真源**；本节保留接管形态的连续性叙述。

- **动机**：自绘树与主根原生树的行高、图标、缩进、空态/截断/失败行、滚动与展开还原全部不一致——这是 P2 选择的实现代价，目检确认观感差距不可接受。复刻上游组件是消除不一致的确定性手段，与 P9 的 open-in-app 复刻同一先例。
- **复刻边界**：`directory-node.ts` / `face.ts` / `store.ts` / `FilesBody.module.css` 字节级一致；`FilesBody.tsx` 的行级定义（`Entry`/`Level`/`TreeContext`/`orderEntries`/`failureLine`）同样逐字节，仅导出的 shell 函数改写——上游 shell 正是当初「不可复用」的根因集合（根写死 `sessions.byId` cwd、`useTabInfo` 是 `sidebar.right.pane.tab` 席位 inject、`renderSlot` 会递归），fork 把这四个缝改成 props：`root`（选中根绝对路径）、`tabId`（`data-dockkit-content` 祖先，缺省时生成）、`signal`（takeover 的 AbortController，abort 即 forget bucket + 关闭全部 watch，等同上游 tab 关闭语义）、`onOpen`（注入 face 绑定的 `sidebarRight.openResourceIn`）。
- **接线走上游同款声明**：`files.actions` 注册声明 `store: createFilesStore()` + `inject: filesFace(...)`——session 域槽位上声明 store/inject 是框架支持的形态（上游 `ui-open-in-app` 已有先例），框架按 session 实例化 store、以 `(sessionId, actions)` 跑 inject 工厂，把 face 摊进 occupant 的合成 props。复刻的 `filesFace` 内部按绝对路径调 `remote.workspaceFiles.list/changes`——B3 已就位的按根路由直接消费；`remote` 服务缺席时 `lazyFilesRemote` 折成 `gateway/internal` 失败，复刻 face 无需第二条失败路径。
- **文件打开白得 viewer 行为**：行点击走 `fileAddressFor(sessionId, undefined, path)`——`cwd` 必须留 `undefined`：session 地址携带绝对路径即按原样送达 host（`workspaceFiles.read` 本就不做 workspace 围限），传 cwd 反而会把附加根路径按主根相对化。`dsh-resource://file/session/<id>/<abs-path>` 交给 documentpreview viewer，比有界文本预览强。
- **随之下线的私有面**：`files` / `readFile` 面板端点、`browseRoot`、`FilesView`/`FilePreview`、`RootFileTree.tsx`、`src/panel-files.ts` 与对应词条全部删除——本插件私有 RPC 两半同改，无兼容负担，不留回退代码。
- **fork 的 DOM 纪律**：复刻体类名改 `mrfw-ft*`，不携带 `data-files-root`/`data-files-body`（本插件的 `:has()` 隐藏规则锚这两个属性于**原生** pane）；行级 `data-files-entry`/`data-files-path` 原样保留。`bindCommands`/`refreshShortcut`/隐藏 auto-refresh 钮不实现（快捷键刷新仍只刷原生树，与原有限制同级）。
- **代价**：第二份有同步义务的源码副本（FORK.md 钉住清单、delta 与 diff 步骤）；`dsh-util-workspace-path`、`dsh-api-remotes` 的类型面与 `dsh-typert-protocol` 的 `RemoteError` 进入 client bundle 的 `alwaysBundle` 内联集，bundle 测试随之钉住；新增 devDep `dsh-client-ui-dockkit`（`TabId`）、`dsh-util-workspace-path`、`dsh-api-remotes` 与 `dsh-client-ui-session`（`SessionId` 合并），全部钉在 dev pin。
- **附带收益**：附加根树获得原生 watch 自动刷新（`ready`/`change` 帧驱动 `DirectoryNode.refresh`，自绘树没有的能力）、scroll/展开态按 tab id 记忆、`loading`/`empty`/`truncated`/失败行与原生一致、目录懒加载语义完全一致。

## Related Documents

- [Files 头部根浏览计划](../plans/completed/2026-10-12-files-header-root-browsing.md)
- [ADR-0011：多根消费方](./ADR-0011-multi-root-workspace-consumers.md)（修订：lazy tree 迁出对话框）
- [ADR-0005：出树 client 传输](./ADR-0005-out-of-tree-client-transport.md)
- [ADR-0006：宿主 token 复刻](./ADR-0006-client-ui-host-tokens.md)
- [故障排查：Files 页签选择器退化](../troubleshooting/files-switcher-degraded.md)
