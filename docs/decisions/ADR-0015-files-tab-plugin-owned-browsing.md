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

数据链路本就就绪：`files` / `readFile` RPC 已按 exact entry 路由附加根，`RootFileTree` 已具备懒加载、中止与过期响应丢弃。

## Decision

`sidebar.right.tab.files.actions` 的 occupant 是 **`RootSwitcher`**（owner `absolutePath` 缺失时退回 P1 的仅图标 launcher）：

- **触发钮伪装成路径标签入口**：占据路径标签位置的 flex 项（`order: -1` + `flex: 1 1 auto` + `min-width: 0`），上游 `[data-files-path]` 由 `:has()` 守卫规则隐藏。菜单列主根（标注 `panel.primary`、默认选中）与各附加根（`list` RPC 按 `sessionId` 取视图；非 `available` 的根如实标注状态且禁用）；「管理工作区目录…」放在 `Menu` 的 `footer` 区，打开同一个 `WorkspaceFoldersDialog`。触发钮后随一个 `PathLabel`（`mrfw-switcherPath`）显示**选中根**的完整路径——主根即原标签的值，附加根为其 canonical 路径——同一上游组件，观感与原生一致；该元素不携带 `data-files-*`，不会被本插件的隐藏规则误伤。
- **附加根选中时接管树区**：`closest('[data-files-root]')` 定位本 pane，`createPortal` 把 `RootFileTree`（去掉 Browse 门控、直渲染）挂成 `[data-files-body]` 的兄弟节点；`:has(.mrfw-rootSwitcher[data-root-kind="additional"])` 条件下的规则同时隐藏原生 body 与 reload——reload 刷的是被隐藏的树，留着只会误导。header 原位出现一个同款 `.mrfw-switcherReload` 图标钮（28px tool 配方），点击以 `key` 重挂载 portaled 树，等效原行内「刷新文件树」按钮；它与 portal 同生同灭，纯菜单降级时不会出现死按钮。原生树在后台保持 watch，切回主根即恢复。
- **选中态是组件实例 state**：每个 tab 渲染实例独立、重开复位，不持久化也不跨 tab 共享。
- **降级是设计的一部分**：无 connection/session → 菜单只列主根（观感等同原生路径标签）；找不到 `[data-files-root]` 祖先 → 不 portal、不隐藏任何上游元素，组件仍是一个可用的菜单；上游改掉 `data-*` 属性 → 全部 `:has()` 规则与 `closest()` 同时失效，退回原生布局。DOM 钩子已列入 `.agent/note/dsh-compat-contract.md` 的升版目检清单。
- **对话框回归纯管理**：行内 `RootFileTree` 与 `files.browse` 词条移除，浏览统一在 Files 页签进行。

## Alternatives Considered

- **复用 / 重指上游原生树**：根投影 fill-once、组件与 store 在闭包内，出树不可达；排除（见 Context）。
- **上游参数化（给 native tree 加 root prop / seam）**：属于上游仓库的改动，本插件约束下不可行；`workspaceFiles.list/changes` 的包装已经就位，将来上游若提供树级 seam，本组件退化为薄适配即可。
- **保留对话框内浏览**：树埋在模态里、与列表操作争布局，浏览这个高频动作为它付出的层级太深；已否定并实际移除。
- **替换 `sidebar.right.pane.tab` body seat**：替换的是整个上游 tab 体，耦合面远大于四个 `data-*` 钩子，否决。
- **新 host 端点承载切换器状态**：选中态纯属浏览器表现，不需要持久化权威；复用既有 `list`/`files`/`readFile` 即可，不增加端点。

## Consequences

- Files 页签成为多根浏览入口；选中附加根时树区归本插件渲染，reload 隐藏符合"它服务的是原生树"的事实。
- 视觉接管依赖四个上游 `data-*` 属性与扁平 flex header——非槽位契约，失效路径全部为静默退化（已写入 compat 目检与故障排查条目）。
- `createPortal` 挂进上游容器属非常规手段，但 React 树仍属本插件（事件、状态、卸载自洽），容器缺席时干脆不渲染。
- `order` 只改视觉序：选择器在 DOM 中仍位于 reload 之后，Tab 键序与读屏序不变——已接受的已知限制。
- 原生树在隐藏期间继续 watch（小开销，换来瞬时切回）；自绘树保持手动刷新，没有 watch。
- `react-dom` 因此进入 client bundle 的 module-table 依赖集（`createPortal`），bundle 测试随之钉住。

## Related Documents

- [Files 头部根浏览计划](../plans/completed/2026-10-12-files-header-root-browsing.md)
- [ADR-0011：多根消费方](./ADR-0011-multi-root-workspace-consumers.md)（修订：lazy tree 迁出对话框）
- [ADR-0005：出树 client 传输](./ADR-0005-out-of-tree-client-transport.md)
- [ADR-0006：宿主 token 复刻](./ADR-0006-client-ui-host-tokens.md)
- [故障排查：Files 页签选择器退化](../troubleshooting/files-switcher-degraded.md)
