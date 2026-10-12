# Files 头部根浏览：launcher 前移（P1）、根选择器 + 自绘附加根树（P2）与头部完整性精修（P3–P5）

## Current State

本计划实施完成。P1 单独提交（仅图标齿轮 launcher 前移，原 `7e3232a` 后改写为 `79f6934`）；P2 按 Design 落地（提交 `252b927`）：`files.actions` 挂载 `RootSwitcher`（owner `absolutePath` 缺席时退回 compact launcher），附加根选中时 `RootFileTree` 经 `createPortal` 接管树区，对话框行内树与 `files.browse` 词条下线，`data-files-*` 钩子列入 compat 目检与故障排查，决策见 [ADR-0015](../../decisions/ADR-0015-files-tab-plugin-owned-browsing.md)。目检另捕获一处真实缺陷：上游 `data-files-path` 双重含义（每个树行也携带），头部规则收紧为 `[data-files-path]:not([data-files-entry])`。用户目检后追加 P3–P5 三个精修阶段（见文末「追加阶段」节）：P3 恢复头部完整路径显示（提交 `0c50edc`），P4 附加根态刷新收进 header（提交 `89bdf75`），P5 刷新改原地重拉消除 loading 闪烁（提交 `9fe0ad4`）。

## Goal

让右侧栏 Files tab 的头部成为多根浏览入口，分两阶段交付、**每阶段一个提交**：

- **P1**：把 actions 区里的启动钮从区尾移到 reload 按钮左侧，并把它收敛为**仅图标**——取消中/英文文字，图标从 folder 换成设置齿轮（`IconSettingsOutline`，全支持版本皆有：旧名 `IconSettingsOutline16` / 新名 `IconSettingsOutlineRegular`）。独立可用的小改进。
- **P2**：把该入口升级为「主根 + 附加根」切换器——默认主根、选中附加根时以本插件**自绘懒加载树**接管树区，并同时承担打开 Workspace Folders 对话框的入口；面板根行内嵌的 `RootFileTree` 随之下线（浏览统一迁到 sidebar）。

## Background（讨论结论沉淀）

本计划在会话中完成了出树可行性论证，关键事实：

- `sidebar.right.tab.files.actions` 槽位（上游 `ui-sidebar-files` 声明，`kind: 'list'`、`scope: 'session'`、owner 携带 `absolutePath`）的 occupant 经 React Fragment 渲染为 `.header` flex 容器的**直接子项**；`FilesBody` 写死 `PathLabel → reload → renderSlot(actions)` 的 DOM 序，注册的 `order` 只在槽位内部排序——**改 `order` 无法越过 reload**，只能动 flex `order`（CSS）。
- `.header` 是 `display:flex`；`data-files-path` / `data-files-reload` / `data-files-body` / `data-files-root` 都落在 flex 项本体上（`PathLabel` 透传 attributes、`Tooltip` 用 `cloneElement` 不包 DOM），是 CSS 选择器与 `closest()` 可依赖的稳定钩子；`.header`/`.body` 的 class 是 CSS-module hash，不可锚。
- **原生树无法复用到附加根**：树根 = `sessions.byId[sessionId].cwd`（client 投影 fill-once，连上游 `working-directory/change` 都不更新它）；`DirectoryNode` 与 store 都在上游 `apply` 闭包内，出树不可达；feature 插件隔离也禁止 import 上游组件。已排除。
- 数据链路本就就绪：`workspaceFiles.list/changes` 已被本插件 `src/workspace-files.ts` 包装为按绝对路径路由附加根——但 native 树指不过来，所以 P2 用**自绘树**（既有 `files`/`readFile` RPC + `RootFileTree` 渲染）。
- 上游同槽位另有 `open-in-app`（`order: -10`，截图中的蓝色图标）；本插件注册 `order: 50`。

## Scope

- `src/client/`：新组件（根选择器）、`styles.ts` 新规则、`index.ts` 的 `files.actions` 注册形态调整、`WorkspaceFoldersAction.tsx` 移除行内 `RootFileTree`。
- 复用既有面板通道：`list` / `files` / `readFile` RPC 与 `RootFileTree` 渲染，不新增 host 端点。
- 文档与 compat 探针更新。

## Non-goals

- 不改上游仓库；不替换 `sidebar.right.pane.tab` 的 body seat；不动 `order: 50` 之外的注册语义。
- 自绘树不实现 watch / auto-refresh，也没有宿主 `openResource` viewer 打开（`readFile` 预览兜底）——附加根本来就走不到宿主 viewer。
- Tab 键序与读屏序维持 DOM 序（CSS `order` 只改视觉）。

## Design

### 布局模型

Files 头部当前视觉序（DOM 序）：`[data-files-path] 路径 | ↻ reload | open-in-app | 本插件`。全部是同层 flex 项，`order` 默认 0、等值按 DOM 序。

### P1：icon-only launcher 前移（方案 A 修订）

视觉目标：`路径 | ⚙ | ↻ | open-in-app`。

```css
/* 仅当本插件 launcher 存在时，把上游 path 钉在最前 */
[data-files-root]:has(.mrfw-fileLauncher) [data-files-path] { order: -2 }
.mrfw-fileLauncher { order: -1 }   /* 排在 path 之后、全部 order:0 项之前 */
```

`:has()` 守卫让对上游元素的规则只在本插件在场时生效；`.mrfw-fileLauncher` 顺带补齐基样式（flex、垂直居中）——它现在没有任何规则。

按钮本体（compact 分支）从「图标 + `action.label` 文字」改为**仅图标**：去掉 `mrfw-triggerLabel` 文字，类名换成 `mrfw-btn mrfw-btnGhost mrfw-iconBtn`（方形 iconButton，与相邻 `↻`/open-in-app 同类），图标由 `IconFolderClose` 换成 `IconSettingsOutline`——经 `compat/client-icons.ts` 新增 `IconSettings = icon('IconSettingsOutline16', 'IconSettingsOutlineRegular')` 按导出名探测，跨全部支持版本。可访问名靠 `title` + `aria-label`（= `action.title`，即「管理本会话的附属工作目录」），图标按钮必须有可达名。footer 入口（非 compact）形态不变，仍渲染图标 + `action.label` 文字；两处触发图标统一换成齿轮，保持入口识别一致。

### P2：根选择器 + 自绘树

- `files.actions` 注册由 compact launcher 换成 `RootSwitcher` 组件：仿 `PathLabel` 观感的触发钮 + ui-primitives `Menu`（已在依赖内）。菜单项：主根（owner `absolutePath`，默认选中）、各附加根（`list` RPC，`sessionId` 走既有 prop；state 非 `available` 的项如实标注）、末项「管理…」打开 Workspace Folders 对话框。
- CSS：选择器就位即隐藏原生路径并接管其位置——
  `[data-files-root]:has(.mrfw-rootSwitcher) [data-files-path]{display:none}`、`.mrfw-rootSwitcher{order:-1}`。P1 的 `order:-2` 规则随之作废，由隐藏取代。
- 选中附加根（触发钮带 `data-root-kind="additional"`）时：
  - `[data-files-root]:has(.mrfw-rootSwitcher[data-root-kind="additional"]) [data-files-body]{display:none}` 隐藏原生树体（树与 watch 在后台存活，切回主根即恢复）；同条件隐藏 `[data-files-reload]`——它刷的是被隐藏的原生树，留着会误导。
  - 从 launcher `closest('[data-files-root]')` 取本 pane 容器，`createPortal` 把自绘树挂成 `[data-files-body]` 的兄弟节点（`flex:1 1 auto; min-height:0; overflow:auto`，吃满 `.body` 让出的空间），内容复用 `RootFileTree` 的 Directory/FileEntry 递归渲染与 `files`/`readFile` RPC。
- 选中态为组件实例 state（每个 tab render occurrence 独立，重开复位，可接受）。
- **降级**：无 connection/session → 菜单只列主根，观感等同原生路径；`closest`/`querySelector` 找不到钩子 → 不 portal、不隐藏，静默退回原生布局。
- `WorkspaceFoldersAction` 根行内嵌的 `RootFileTree` 移除（`files.browse`/`files.reload`/`files.empty`/`files.truncated`/`files.previewTruncated` 词条若仅它使用则一并清理）；`files`/`readFile` 端点与 `RootFileTree` 组件本体保留并复用。
- `:has()` 要求 Chromium ≥105 / Electron / Safari 15.4+，宿主满足；失效 = 退回原生观感，不破坏功能。

## Implementation

### Phase 1 —— icon-only launcher 移到 reload 左侧（单独提交）

- `src/compat/client-icons.ts`：新增 `IconSettings`（`IconSettingsOutline16` / `IconSettingsOutlineRegular` 双名探测）。
- `src/client/WorkspaceFoldersAction.tsx`：compact 分支去文字、换齿轮图标、改 `mrfw-iconBtn` 方形类、补 `aria-label`；footer 触发器同步换齿轮（文字保留）。
- `src/client/styles.ts`：`.mrfw-fileLauncher` 基样式 + `order:-1`；`:has()` 守卫的 `[data-files-path]{order:-2}`。
- 注释写明依赖：上游扁平 flex header + `data-*` 属性；失效退化为现状。
- 测试：stylesheet 断言规则存在；`client-panel.spec.tsx` 的 `files.actions` 用例把点击目标从 `/action.label/` 改为按钮可达名 `/action.title/`。
- 文档：troubleshooting 或 architecture 记一笔 `data-*` 钩子依赖。
- **完成即提交**（方案 A 修订版独立交付）。

### Phase 2 —— 根选择器 + 自绘附加根树（单独提交）

- `src/client/RootSwitcher.tsx`（新）：选择器组件（owner `absolutePath`、`sessionId`/`subscribeSession` prop、`list` RPC、`Menu`、对话框入口）。
- `src/client/index.ts`：`files.actions` 注册改挂 `RootSwitcher`；`sidebar.footer.action` 注册不变。
- `src/client/styles.ts`：P1 的 `order:-2` 规则替换为隐藏规则 + switcher 样式 + `data-root-kind` 条件的 body/reload 隐藏 + portal 树容器样式。
- `src/client/WorkspaceFoldersAction.tsx`：移除行内 `RootFileTree` 及不再引用的词条。
- `RootFileTree.tsx`：保持可复用（供 portal 树）。
- compat：`data-files-*` 钩子列入结构探针 / 发版目检清单。
- 测试：switcher 菜单项来源与选中行为、portal 目标查找与降级路径、面板行内树移除回归。
- ADR：**新增 ADR-0015**（Files tab 自绘树接管：备选=原生树重指——不可行、上游参数化——留作上游事项、保持对话框——已否）并修订 [ADR-0011](../../decisions/ADR-0011-multi-root-workspace-consumers.md) 中"lazy tree 放在现有对话框"的表述。
- **完成即提交**。

## 追加阶段（P3–P5，web 目检后的精修）

P2 的人工核验通过后，用户基于真实观感追加三个小阶段，各自单独提交、各自全绿：

- **P3**（提交 `0c50edc`）**恢复头部完整路径**：P2 把上游路径标签整体隐藏后，头部只剩根名触发钮——用户在主根与附加根态都要求原位置仍显示完整路径。实现：触发钮后随一个 `PathLabel`（`mrfw-switcherPath`），主根显示 pane 工作区根（即原标签的值）、附加根显示其 canonical 路径；复用上游同一组件，自带生长/左端渐隐/hover 全路径。`.mrfw-rootSwitchBtn` 收敛为 `flex: 0 1 auto` 只缩不涨，把剩余宽度让给路径；该元素不带 `data-files-*`，不受本插件隐藏规则影响。
- **P4**（提交 `89bdf75`）**附加根态刷新收进 header**：接管态原本只有树区顶部一个「刷新文件树」文本钮，与主根态的 header reload 不一致。`RootFileTree` 移除行内按钮；header 在原生 reload 位置渲染 `.mrfw-switcherReload` 图标钮（上游 `.tool` 配方：28px 命中区、15px 字形、次色 + hover 高亮），图标走既有 `IconRefresh` 双名适配器。按钮与 portal 树同生同灭（统一 `treeVisible` 条件），纯菜单降级时不渲染；不带 `data-files-reload`，不会被隐藏规则误伤。
- **P5**（提交 `9fe0ad4`）**刷新改原地重拉，消除 loading 闪烁**：P4 的 header reload 用 `key` 重挂载树，每次点击全部目录闪回「正在读取」。`RootFileTree` 改收 `reload` 计数 prop：每个已挂载 `Directory` 的拉取 effect 依赖它后台重拉，但**只在 `entry.id + path` 身份变化时**才清空 `listing`——重拉期间旧行保持渲染，成功就地换数据；展开态与文件预览均保留。切根仍正常清屏。

## Validation

每阶段：`pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm build`、`pnpm docs:check` 全绿；`pnpm smoke`（compose/behavior/journey）无回归。P2 另需 web 组合人工核验三态：无附加根（原生观感）、选中附加根（自绘树 + reload 隐藏）、切回主根（完全还原）。P3–P5 各经用户 web 目检确认后提交。

## Risks

- 全部布局耦合在上游 `data-*` 属性与扁平 flex header 上——非槽位契约，上游改 DOM 则**静默退化**为原生观感（功能不坏）；已列入 compat 探针。
- `createPortal` 进上游容器属非常规手段：容器不存在则放弃 portal；React 树仍属本插件，事件/状态自洽。
- `order` 只改视觉序，焦点/读屏序不变（P2 选择器在 DOM 中仍位于 reload 之后——可接受的已知限制）。
- 附加根选中态不跨 tab 持久；原生树在隐藏期间保持 watch（小开销，换来瞬时切回）。

## Documentation Impact

- 本文件进 `docs/plans/active/`；完成后移 `completed/` 并在[进度总账](../active/2026-09-12-multi-root-workspace.md)补行。
- P2 落地时更新：[架构 §client 半部](../../architecture/multi-root-workspace.md)、[需求文档](../../requirements/multi-root-workspace.md)、`README.md`/`README.en.md` 面板与 Files 入口叙述、[ADR-0011](../../decisions/ADR-0011-multi-root-workspace-consumers.md) 修订 + 新 ADR、troubleshooting 增补 `data-*` 钩子条目；发布时进 CHANGELOG。

## Completion Criteria

- P1 单独提交并全绿：视觉序为 `路径 | ⚙ 图标钮 | ↻ | open-in-app`，按钮仅图标、齿轮、可达名完整。
- P2 单独提交并全绿：选择器默认主根、可切换附加根并以自绘树接管树区；面板行内树移除；降级路径成立；文档同步。
- P3 单独提交并全绿：触发钮与 reload 之间显示选中根完整路径（主根与附加根均生效），观感与原生 PathLabel 一致。
- P4 单独提交并全绿：附加根态 header 在原生 reload 位置提供同款图标刷新钮，树区不再自带刷新控件。
- P5 单独提交并全绿：点刷新不清屏、不闪「正在读取」；目录展开态与文件预览保留；切根仍正确清屏。
