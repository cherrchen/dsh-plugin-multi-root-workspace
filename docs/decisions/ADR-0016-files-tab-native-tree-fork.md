# ADR-0016: 附加根树逐字节复刻上游 Files 树

## Status

Accepted

## Date

2026-10-12

## Context

[ADR-0015](./ADR-0015-files-tab-plugin-owned-browsing.md) 确立了「portal 接管树区」的形态，但当时 portal 里挂的是自绘 `RootFileTree`：`▸`/`▾` 文本前缀作展开记号、插件私有 `files`/`readFile` RPC 供数据、有界文本预览承担文件查看。这套实现保证了功能正确，却在行高、图标、缩进、空态/截断/失败行、滚动与展开还原上与主根原生树逐项不一致——目检确认观感差距不可接受。

原生树组件仍不可复用（根写死 `sessions.byId` cwd、`useTabInfo`/`renderSlot` 绑在 `sidebar.right.pane.tab` 席位、store 在上游 `apply` 闭包内——ADR-0015 Context 的两条硬约束不变），但 P9 已确立第三条路：上游 client 包的**逐字节 fork**（`src/client/open-in-app/` + `FORK.md` 同步义务）。同样手法是否适用于体量大一个数量级的 `ui-sidebar-files`（~1200 行 vs open-in-app ~400 行），取决于复刻体能不能绕过上游外壳函数里那三个不可达缝。

## Investigation

对上游 `d743267388`（= `0.2.1-alpha.2`，与本插件 dev pin 相同）逐文件核查：

- `directory-node.ts` / `store.ts` / `face.ts` / `FilesBody.module.css` 只依赖基线外部模块（`dsh-client-store`、被 `alwaysBundle` 内联的 `RemoteError`/`clsx`/`dsh-util-workspace-path`）——**可字节级复刻**。
- `FilesBody.tsx` 的行级定义（`Entry`/`Level`/`TreeContext`/`orderEntries`/`failureLine`/滚动还原）与外壳函数可分离；外壳恰好集中了全部不可达缝——**只改写外壳**。
- 外壳的四个缝各有替身：`tab.id` → dockkit tabHost 的 `data-dockkit-content`（整个兼容窗口皆存在）；`tab.signal` → takeover 期自建 AbortController（abort 语义等同 tab 关闭）；`tabActions.openResource` → `ctx.get('sidebarRight').openResourceIn`；`t` → `ctx.locale.bind('sidebarFiles')` 消费上游活词典。
- 上游 `ui-open-in-app` 自己在 `files.actions` 注册上声明 `inject`——session 域 list occupant 声明 `store`+`inject` 是被支持的形态，inject 工厂签名 `(sessionId, actions)` 与 `filesFace` 恰好吻合，复刻 face 可原样进 inject。
- 数据通路本就就绪：`workspaceFiles.list/changes` 的 host 包装（B3）按绝对路径路由附加根；`workspaceFiles.read`/`readBytes`/`stat` 不做 workspace 围限，文件经 `dsh-resource://file/session/<id>/<abs-path>` 白得宿主 documentpreview viewer。
- `files.actions` 槽位本身 0.2.0-rc.2 才出现，兼容窗口内三版本被复刻文件 diff 为零——单一基线通吃。

## Decision

附加根树改为 `src/client/files-tree/` 下对上游 `ui-sidebar-files` 树体的逐字节 fork（清单、shim 对照、delta 与同步步骤钉在该目录 `FORK.md`）：

- `directory-node.ts` / `face.ts` / `store.ts` / `FilesBody.module.css` 与 `FilesBody.tsx` 的行级定义字节级一致；唯一改写是导出的外壳函数，四个缝改为 props：`root`（选中根绝对路径）、`tabId`（`data-dockkit-content`，缺席退回生成 id）、`signal`（takeover AbortController）、`onOpen`（inject 绑定的 `openResourceIn`）。
- `files.actions` 注册按上游同款声明 `store: createFilesStore()` + `inject: filesFace(createList(remote), createWatch(remote))`，框架按 session 实例化 store 并把 face 摊进合成 props。
- 文件地址用 `fileAddressFor(sessionId, undefined, path)`——`cwd` 必须留 `undefined`：携带绝对路径的 session 地址按原样送达 host，传 cwd 反而把附加根路径按主根相对化、指错文件。
- `remote` 经 `ctx.get('remote')` 惰性解析，缺席时 lazy proxy 折成 `gateway/internal` 失败行——复刻 face 无需第二条失败路径。
- 不复制：`bindCommands`/`refreshShortcut`（tab 快捷键仍刷原生树，与自绘时代同级）、隐藏 auto-refresh 钮（`autoRefresh` 恒 true 即上游默认）、上游 header 整块（本插件已有等价控件）。
- 复刻体类名 `mrfw-ft*`，**不携带** `data-files-root`/`data-files-body`（本插件 `:has()` 隐藏规则锚这两个属性于原生 pane，自携带会被误伤）；行级 `data-files-entry`/`data-files-path` 原样保留。
- primitives 经 `./primitives.ts` 按导出名解析（`*Regular` 与像素名双兜底）；folder 图标/`FileTypeIcon`/`classifyFileType` 缺席时 `filesTreeSurfaceSupported()` 为假、adapter 不建、整树不渲染——与 open-in-app 同型降级。
- 随之下线：插件私有 `files`/`readFile` 面板端点、`browseRoot`、`FilesView`/`FilePreview` 及其 zod 校验、`RootFileTree.tsx`、`src/panel-files.ts` 与仅它们使用的词条——本插件私有 RPC 两半同改，无兼容负担，不留回退。

## 修订：takeover 生命周期上移至 inject 产品（2026-10-31，Amendment）

Status 保持 **Accepted**；复刻面与四个缝的 prop 形态不变。决策中「`tab.signal` → takeover 期自建 AbortController（abort 语义等同 tab 关闭）」当时绑定在组件生命周期上——打开文件让 dockkit 失活 Files 页签、整体卸载其 body（该页签类型不声明 `keepMounted`），组件态与控制器同灭，选中根随之重置回主根。修订后：选中根存入 inject 产品的 session 域快照（经 `hooks` 区格以 `useTreeSelection` 送达组件，键为 `data-dockkit-content` 的 tab id，无条目即主根）；takeover 控制器同样住进 inject 产品、按 (tabId, root) 复用，仅在取消选择、换根、或 tabHost 节段离开文档（tab 记录真正结束）时终止——body 卸载本身不再终止，与上游 occurrence signal 的「隐藏不终、记录终则终」语义完全对齐。节段移除的判定也在 inject 产品：组件 body 卸载后可能很久才轮到用户关闭该隐藏页签，届时组件早已不在，无法再做清理——故 `signal()` 收到节段即在其上挂 `MutationObserver`，与控制器同寿命，节段一旦离开文档即 end，已卸载的 body 也覆盖。`view` 未应答（list 挂起或失败）期间保留选择，只有应答过的视图能把被除名/被扣留的选择收回主根。

## Alternatives Considered

- **精修自绘树逼近原生**：逐项对齐行高/图标/缩进/空态是永无终点的追影游戏——上游每次改版都得再追一遍；且自绘树没有 watch 自动刷新、展开/滚动记忆、失败行语义，这些是 store/face 层能力而非样式问题。排除。
- **复用/重指上游组件**：ADR-0015 已论证不可行，复核结论不变。
- **保留自绘树作 fork 缺席时的回退**：双实现意味着两套测试面与双倍维护；primitives 整面缺席的运行时根本渲染不了 Files 页签本体（上游自己也依赖同一批导出），回退路径事实上不可达。排除。

## Consequences

- 附加根树与主根原生树的行结构/图标/hover/缩进/loading/empty/truncated/failed 行逐项一致；白得原生 watch 自动刷新（`ready`/`change` 帧驱动 `DirectoryNode.refresh`）、按 tab 的滚动/展开记忆、懒加载与目录消失时的后代状态清理。
- 第二份有同步义务的源码副本：`FORK.md` 钉住基线、逐文件处置、许可差异与重拷步骤；上游 `ui-sidebar-files` 改版必须 diff 而非手工忽略。
- `dsh-util-workspace-path`/`dsh-api-remotes` 的类型面与 `dsh-typert-protocol` 的 `RemoteError` 进入 client bundle 的 `alwaysBundle` 内联集，bundle 测试随之钉住；新增 devDep `dsh-client-ui-dockkit`（`TabId`）、`dsh-util-workspace-path`、`dsh-api-remotes`、`dsh-client-ui-session`（`SessionId` 合并）全部钉在 dev pin。
- `data-dockkit-content` 成为本插件消费的新 DOM 钩子（非槽位契约），缺席退化为生成 id——仅失去跨重挂载的状态还原，已列入 `.agent/note/dsh-compat-contract.md` 目检表与故障排查条目。
- fork 缺席时（primitives 门或 pane 找不到）`data-root-kind` 不提前声称 `additional`——附加根行不渲染为可选、原生布局不被误伤，选择器退回仅菜单形态。

## Related Documents

- [ADR-0015](./ADR-0015-files-tab-plugin-owned-browsing.md)（portal 接管形态本身，本 ADR 只替换树区的来路）
- [ADR-0011](./ADR-0011-multi-root-workspace-consumers.md)（`workspaceFiles` 按根路由包装，本 fork 的数据源）
- [Files 头部根浏览计划](../plans/completed/2026-10-12-files-header-root-browsing.md)（P11）
- `src/client/files-tree/FORK.md`（复刻面、许可差异与同步步骤）
- [故障排查：Files 页签选择器退化](../troubleshooting/files-switcher-degraded.md)
