# ADR-0043: 附加根文件预览导航树的工作区搜索

## Status

Accepted（2026-11-16 外部技术评审有条件通过；评审条件 F1–F3 已并入本 ADR 与本 ADR 的实施计划。P1–P4 已于 2026-11-16 在分支 `feat/additional-file-tree-search` 实施，P5 门禁与实机目检进行中）

## Date

2026-11-16

## Context

### 用户可见的缺口

文档预览页的右侧 Folder 导航树（上游 `ui-sidebar-files` 的 `FileNavigator`；预览模式由
`ui-sidebar-documentpreview` 的 `PreviewFrame.tsx` 以 `page: false` 渲染到
`aside[data-files-navigator]`）自 DSH `0.2.2-rc.2` 起带有工作区搜索。本插件从 `v0.1.16` 起接管这棵树的树体，
让附加根的文件也能在这里浏览（`src/client/files-tree/navigator.tsx`），但接管只替换树体：原生搜索条与状态行
随原生 body 一起被 `src/client/styles.ts` 在接管期隐藏，而插件自己的搜索面只接在 Files 页签上。

因此今天存在一个不对称：**主根文件的预览导航树有搜索（原生），附加根文件的预览导航树没有**。
`v0.1.20`（ADR-0041/0042）补齐的是附加根 Files 页签的行右键与工作区搜索，并在 ADR-0041 D4 明确把预览
导航树排除在本轮之外：该导航器的搜索态由上游自己的 face 驱动，接管树不参与。本 ADR 关闭这个遗留缺口。

### 上游事实（逐 release 核对）

本仓库不把上游 checkout 作为依赖；以下证据取自本地只读 tag 对照，方法与本仓库
`docs/reference/dsh-0.2.2-migration.md` 一致。

| 事实 | 证据 |
| --- | --- |
| 引入版本 | `dsh-v0.2.2-rc.2`（tag `ddac96760b6edf8fa0fe17cbdcf0b512f4c12b2c`，tag commit 时间 2026-11-11；npm registry `time` 元数据为 2026-11-12T02:13:08Z） |
| 引入提交 | 上游 PR #7365 `feat/sidebar-file-search`，merge commit `2d463af8d2`（2026-11-07）；同一 PR 新增 `workspaceFiles.search`、`FileNavigator` 搜索半部、`SearchSettings`、搜索规则/偏好/结果树、`data-files-search*` DOM 钩子与 locale 键 |
| rc.2 到 rc.3 | `ui-sidebar-files` 的 `src/` 与 `locale/` 零差异（只有 `package.json` 的版本行）；本 ADR 的语义基线 = `0.2.2-rc.3` |
| 预览模式搜索栏常显 | `FileNavigator.tsx` 的 `const searchBarOpen = !page \|\| state?.searchBarOpen === true`；文档预览以 `page: false` 渲染 |
| 搜索状态按 pane | `FileNavigator` 读 `useStore(store => store.byPane[panel.id])`；同一 pane 的 Files 页与预览共享一份记录 |
| 结果树 | 经 `sidebar.files.tree` Factory 绘制，输入含 `highlight`、`omitted: 'unmatched'`、`current`/`currentRef`（预览当前文件在结果树中同样标当前行） |
| 打开路由 | 预览的 `onOpen(address)` 调 `tab.actions.openResource(address, { replaceTab: true })` |
| 搜索根 | `workspaceFiles.search` 的 wire 请求没有根字段，Host 从 Session cwd 解析根（ADR-0041 Context）；wire 永远只能搜主根 |
| 交互契约 | 栏结构（设置 magnifier、输入、eye、clear）、`aria-live` 状态行、空结果 hint、截断/不完整、失败重试、设置浮层（规则草稿、ignore 立即保存、eye 立即保存）、Up/Down 在输入与行间移动、Escape 顺序（设置 → 清空查询 → 交给上游关闭导航树）、关闭设置后回焦 magnifier |
| 偏好 | 按 workspace root 存 `dsh.sidebar-files.workspace-search.v1`（与 Files 页同一键、同一格式）；eye 默认关闭，即列出的树默认不画 dotfile |
| 文档语义 | `ui-sidebar-files` README（rc.3）§The navigator / §Search：预览旁搜索栏常显；query/结果按 pane 保存、不持久化 |

### 插件现状（当前事实）

- `src/client/files-tree/navigator.tsx`：在预览头部 `sidebar.right.tab.document.actions` 注册不可见 occupant，
  按 `(paneId, root)` 接管 `aside[data-files-navigator]`；portal `FilesTree`，复刻 hold/reveal/滚动记忆与
  `replaceTab` 打开；`data-mrfw-navigator` 标记触发 `styles.ts` 的隐藏规则。
- `src/client/RootSwitcher.tsx`（Files 页）：**存在与预览接管同型的过渡帧缺陷**——搜索记录的 `stateKey` 取自
  `takeover`（旧根），而传给 `FilesPane` 的 `rootId` 取自 `selected`（新根），二者是两个独立 state；换根
  （含切到主根）的那一帧会以 B 的 rootId + A 的 query/filters 发出搜索，并把 A 的 key 写成 `pending` 后
  无人结算（v0.1.20 已发布缺陷，本轮一并修复）。
- `src/client/styles.ts`：接管期隐藏 aside 的 `[data-files-body]`、`div:has([data-files-search])` 与
  `[data-files-search-status]`；Files 页头再隐藏原生 `[data-files-search-toggle]`。
- `src/client/files-tree/pane.tsx`：`FilesPane` 是 Files 页签的插件搜索面（bar/status/results/notes/settings/
  keyboard、偏好、请求身份、隐藏项过滤、`data-mrfw-files-*` DOM）。它按 Files 页接线：bar 由页头 toggle 经
  `barOpen` 记录打开、打开文件走 `filesTree.openFile`、关闭设置回焦输入框、结果树不标记"当前文件"。
- `src/client/files-tree/adapter.tsx`：`createFilesTreeSurface` 已经为两个 owner（Files 页 actions 与预览
  document actions）组装同一个 `search` seat；`searchSupported()` 是结构探测
  （`remote.workspaceFiles.search` 是函数 + 面板通道存在）。
- `src/client/files-tree/FilesTree.tsx`：树体；`showHidden` 默认 `true`；焦点交接用
  `body.parentElement?.querySelector('[data-files-body]')` 判断被隐藏的原生 body 是否持有焦点。
- `src/client/files-tree/search-state.ts`：搜索记录按 `(tabId, root)` 存在 inject product，带请求身份与
  `forgetTab`；`tree-view.tsx` 的 `current` 需要 `ref`。
- Host：`src/files-search.ts` 的 `search` 端点已就绪（rootId → 刷新 Registry → 单次主根准入 → 帧内复核），
  `src/workspace-files.ts` 的 search 包装负责路由与扣留边界；本 ADR 不涉及 Host 改动。

### 约束

- 不修改上游、不新增 `@deepseek-ai/*` 运行时 import 或依赖（升级脚本会改写 devDependency，旧 lane 会在
  安装阶段死亡；ADR-0002/ADR-0009）。
- 授权只有一个来源：Host 的 Registry/scope；客户端只能请求"搜哪个 rootId"（ADR-0008/ADR-0024/ADR-0025）。
- 旧宿主零行为变化：预览接管自 `0.2.2-alpha.3` 起存在，搜索自 `0.2.2-rc.2` 起存在；
  `0.2.2-alpha.3` 到 `0.2.2-rc.1` 上必须与今天逐字节一致。
- 视觉只用宿主 `var(--dsw-*)` token 与 `mrfw-*` 类（ADR-0006）；文案消费上游 `sidebarFiles` 活词典，
  不新增硬编码 copy（i18n 规则）。

## Investigation

### 预览模式的原生搜索契约（需要复刻的部分）

`FileNavigator` 只有一份实现，Files 页（`page: true`）与预览（`page: false`）的差异被压缩成少量分支：

1. **栏的可见性**：预览恒显示；Files 页由页头 toggle 打开。预览没有"收起栏"的入口。
2. **状态归属**：每个 pane 一份 `byPane[panel.id]`：`query`、`searchBarOpen`、`search`（`pending`/`result`）、
   结果树展开与滚动 offset。query 不持久化；关闭/重画导航树保留。
3. **请求**：trim 后非空才搜索；新查询/偏好变化 abort 旧请求；空白查询结束搜索回到树。
4. **结果视图**：结果树复用 `sidebar.files.tree` Factory，全展开、高亮 query、目录空级用
   `omitted: 'unmatched'` 抑制"空目录"行；上方 `aria-live` 状态行报结果数；结果树自己的展开与滚动独立于树。
5. **结果当前行**：预览的 `current` 由 `locateFile(resultTree, relativePath)` 计算；结果命中被预览文件时标当前行
   （`currentRef` 交给 face 的滚动判定，只有 reveal 结算后才滚动）。
6. **打开结果行**：走预览的 `onOpen`，即 `replaceTab`（新文件取代被预览文件所在的 tab）。
7. **笔记与失败**：空结果 + 过滤提示（hidden/excluded/ignored 组合）、截断、不完整、失败原因 + Retry；
   失败重试是显式 attempt，不是自动循环。
8. **设置浮层**：浮在导航树内、栏高之下；规则是草稿，关闭（magnifier/Esc/失焦/点击外部）时保存；
   `.gitignore` 开关立即保存；关闭后回焦 magnifier。
9. **隐藏项**：eye 默认关闭；列出的树与搜索请求同时跟随；打开后无重新列目录也能显示。
10. **键盘与 Escape**：Down 从输入进入首行，Up/Down 在行间移动，首行 Up 回到输入；Esc 先由设置浮层自己处理，
    再由栏处理清空查询；查询为空时栏不再拦截，让上游 face 的 document 级 Escape 关闭浮层导航树。
11. **命令边界**：`workspace.files`（桌面默认 Mod+P）由上游 face 聚焦搜索框；接管期原生框隐藏，
    本插件不注册快捷键（与 ADR-0041 D4 的已知边界同型）。

### 插件已经具备的复用面

- **Host 传输与授权**：`search` 端点已通过 ADR-0041 落地并经过 review 修复（请求身份、记录所有权、
  错误码透传），无需新端点、新字段或新依赖。
- **搜索语义**：`pane.tsx` 已实现 3、4、7、8、9、10 的 Files 页版本（含 abort、请求身份复用、
  偏好 re-run、设置草稿、眼睛过滤、键盘移动）；`search-state.ts` 已实现记录与请求身份。
- **树与打开**：`FilesTree` 已具备 `reveal`/`saved`/`onScrollOffset`/`showHidden`；
  `TreeView` 已具备 `highlight`/`omitted`/`current`；导航接管已具备 hold/reveal/滚动记忆、
  `openFileIn`（replaceTab）。
- **门控**：`searchSupported()` 只认结构（`remote.workspaceFiles.search` 是函数 + 面板通道），不比较版本字符串。

### 缺口与三个耦合点

1. **栏的可见性**：`FilesPane` 用 `state.barOpen` 决定是否画栏；预览必须常显且不写 `barOpen`。
2. **打开路由与当前行**：`FilesPane` 固定用 `onOpenFile`（Files 页的打开路径），也不计算结果当前行；
   预览需要 `replaceTab` 与 `"被预览文件在结果树中的当前行"`。
3. **焦点与包装层**：预览的 `FilesTree` 目前直接挂在 aside 下，焦点交接按"父节点即 aside"查找原生 body；
   一旦在中间加一层 pane 包装（为了画栏），这个查找会失效。关闭设置后的回焦目标（原生是 magnifier，
   当前 `FilesPane` 是输入框）也应一并对齐。
4. **两个 owner 的同一类过渡帧缺陷**：预览接管的根路径与根 id 来自两个 state（`root` / `takeover`）；
   Files 页的搜索 key 与 rootId 也来自两个 state（`takeover` / `selected`）。两者都会在换根那一帧产生
   "旧 key + 新 rootId" 的错配请求与无人结算的 `pending`。修复必须对两个 owner 用同一模式（D2）。

### 兼容分界

| 能力 | 结构证据 | 缺席时 |
| --- | --- | --- |
| 预览导航接管 | `sidebar.right.tab.document.actions` 槽 + `aside[data-files-navigator]`（`0.2.2-alpha.3`+） | 不接管，全程原生 |
| 工作区搜索 | `remote.workspaceFiles.search` 是函数（`0.2.2-rc.2`+）+ 面板通道 | 有面板通道时保持今天的接管形态（portal `FilesTree`，不画插件搜索面）；**无面板通道时导航接管本身不存在**（`navigator.tsx` 的根解析需要 `panel`），导航树全程原生 |

两者同时成立才出现新行为，因此实际生效范围是 **DSH `0.2.2-rc.2` 及以上**；更早宿主零变化。

## Decision

### D1 复用同一个搜索面：`FilesPane` 增加 `mode`

`FilesPane` 是唯一的工作区搜索状态机与 UI。新增：

- `mode?: 'page' | 'preview'`（默认 `'page'`，Files 页行为不变）；
- `previewPath?: string`（仅 preview：被预览文件的绝对宿主路径，用于结果树当前行）。

preview 模式的差异被收敛为一张显式清单，而不是第二个组件：

| 面 | page 模式（现状） | preview 模式（新增） |
| --- | --- | --- |
| 栏可见性 | `state.barOpen` 记录 + 页头 toggle | **恒显示**（与原生预览一致），不写 `barOpen`，不抢首次焦点 |
| 打开行 | `filesTree.openFile(address)` | `openFileIn(previewTabId, address)`（`replaceTab`） |
| 结果当前行 | 无 | `previewPath` 在结果树中 → 标当前行（Factory: `.current`/`aria-current`；legacy: `data-files-current`） |
| 关闭设置回焦 | 改为 magnifier（本轮对齐原生；现状为输入框） | magnifier（与原生一致） |
| 初始挂载 | 打开栏时聚焦输入 | 不聚焦（避免打开预览就抢键盘） |

响应式细节：preview 模式不依赖 `barOpen`、不写它；搜索记录键与显示状态无关。结果当前行只标记、不自动滚动（理由见 D4）。

**共享显式变更清单**（三项行为对齐 + 一项过渡帧缺陷修复 + 一个纯 DOM 标记；两模式共用，因此也改变
Files 页既有行为，需在 ADR/CHANGELOG 明说）：

- 设置关闭回焦改为 magnifier（原生行为；现状是聚焦输入框）。
- `moveAlongRows` 的焦点 stops 从“输入 + 结果行”扩为“输入 + 列出的树行 + 结果行”：现状只覆盖结果行，
  列出的树行不在 stops 里，与原生“Down 从输入进入首行、Up 从首行回到输入”不一致。这是 v0.1.20 遗留的
  键盘缺口，本 ADR 一并修正（不是 preview 特有差异）。
- 设置草稿随 `stateKey` 变化清空（D3）：Files 页切换根时同样生效，避免旧根草稿落到新根偏好。
- **`RootSwitcher` 换根过渡帧缺陷修复（D2）**：换根时不再发出“B 的 rootId + A 的 query”请求，也不再
  在 A 的记录上遗留 `pending`（v0.1.20 已发布缺陷的修复）。
- `data-mrfw-files-pane` 根标记（纯 DOM，无视觉/交互效果）。

**不做**新组件、不复制状态机、不把搜索状态搬进树 store：ADR-0041 已确立"一个搜索实现、一个端点、
一套偏好"；复制一份 UI 会让请求身份、折叠/滚动、设置草稿与无障碍语义出现两套漂移源。

### D2 接线：接管期 portal 搜索面，接管记录按根原子落定（两个 owner）

**主导危害是“错配请求与记录串写”，不是崩溃。** 预览接管与 Files 页接线各自让“搜索记录 key/根路径”和
“rootId”来自两个独立 state；换根的那一帧会以 B 的 rootId 发送 A 的 query/filters（wire 上出现错配请求），
并把 A 的记录写成 `pending` 后无人结算（A 的状态行 spinner 卡死，失败结果被清成无限 pending）。只有
“无保护地读 `root.id`”这一种写法才会额外崩溃，属于次要情形；原子记录同时消除两者。

`navigator.tsx` 在接管成立时（`aside` 存在、文件属于可用附加根、面板通道存在）：

- 若 `filesTree.search !== undefined`：portal `FilesPane mode="preview"` 进 aside。**接管记录必须在同一次 state 提交里同时携带
  `paneId`、根路径与根 id**（`takeover: { signal, paneId, root, rootId }`），因为 `root`（`RootView`）与 `takeover`
  原本是两个 state，根切换或 list 失败时存在一帧“旧 takeover + 新/空 root”的过渡。portal 的根相关字段全部取
  takeover 的四个字段——`stateKey`（`searchStateKey(takeover.paneId, takeover.root)`）、`rootId`、`tabId`
  （`takeover.paneId`）与 `signal` 直接来自它；`saved` 来自 `takeoverCtl.saved(takeover…)` 快照，`reveal` 来自
  `revealLive`，`onOpenFile`/`onScrollOffset`/`previewPath`/`describeFailure` 是调用方的回调或 prop——它们与
  takeover 同源（同一次 list 解析 + 同一次 hold），但**不是 takeover 记录字段**。`NavigatorRetargetProps` 新增
  可选的 `describeFailure?: (failure: SearchFailureInfo) => string | undefined`，由 `src/client/index.ts` 用 apply 的
  `t` + `errorKeyOf` 构造；与 `RootSwitcher` 共用同一个 describer helper，避免两份映射漂移。
- **同一模式必须应用到 `RootSwitcher.tsx`（Files 页的现存缺陷）**：它的 `Takeover` 记录当前只有
  `{ signal, tabId, root }`，而 `searchKey` 取自 `takeover`、`rootId` 取自 `selected`；把 `rootId` 并入
  `Takeover`（与 `selectedPath` 同一次提交落定），`searchKey` 与 `FilesPane` 的 `rootId` 都从 takeover 读取。
  这样切换根（含切到主根、以及主根→附加根）时，过渡帧只渲染完整的旧根记录，不会发出错配请求，也不会遗留
  `pending`。该修复与预览接管属同一变更批次（可拆分提交），测试在 `client-switcher`/`client-search` 镜像预览的过渡帧用例。
- 若 `filesTree.search === undefined`：**保持今天的 portal `FilesTree`**，DOM、生命周期与隐藏规则行为不变
  （`0.2.2-alpha.3` 到 `rc.1`，以及裁掉 search 服务的组合）。没有面板通道时导航接管根本不会建立
  （根解析要求 `panel`），导航树保持原生，不属于本分支。

原生 aside 的宽度、push/overlay/fill、resize 手柄、导航树开合与 pane 记账仍归上游；插件只画 aside 内部的搜索面与树体。

### D3 状态与生命周期：沿用 ADR-0041 的记录模型

- 记录键 `(paneId, root)`：与原生"按 pane"一致，又避免同一 pane 在两个附加根之间切换时串查询/结果
  （原生只有主根一个根，不存在这个问题）；键类型与 `search-state.ts` 现有 `searchStateKey` 相同。
- 记录住在 session 的 inject product（一 session 一份），body unmount（开文件/replaceTab/关导航树）保留；
  pane 死亡时既有 `dropDeadOwners → forgetTab(paneId)` 清理；不新增生命周期通道。
- 请求身份（`searchRequestKey`）继续保证：body 重挂载/导航树重开时，同一请求复用已结算答案，
  不重跑、不重置展开与滚动；查询、筛选、重试 attempt 改变才重新请求。
- 结果树展开/滚动记录在 `(paneId, root)` 记录里；关闭/重开导航树、`replaceTab` 打开文件后返回都保留，
  与原生 pane 记录同型。
- **结果视图会卸载列出的树**：query 非空时 pane 用结果体替换 `FilesTree`（树卸载 → `release` 结束 hold，
  关闭目录节点与 watch）；清空 query 后重新 `hold` 并重新 list/watch。原生是同一个 body 换内容、hold 不断。
  这是接受的行为差异：store bucket 与已列 levels 保留，重开时 ready level 的 `loading` 是 no-op，不闪 loading；
  “不新增请求”只承诺搜索请求（请求身份），不承诺清空 query 后不重新 list 目录。
- **组件态偏差**：设置面板草稿是组件 state。根切换（`stateKey` 变）时必须丢弃草稿而不是写进新根的偏好；
  关闭 Folder 会让 pane 卸载、草稿丢失（原生组件只 `return null`，草稿存活）。两者都在实现时用状态清理与
  测试钉住，并写入 FORK.md 的已知差异。
- **同路径移除后以新 `rootId` 重加**：预览接管只在 aside 打开/预览文件变化时重新 `list`，旧 `rootId` 的 Retry
  会持续 `not-found` 直到关闭/重开 Folder；本轮不做“失败时有界重列”，与现有树刷新时机一致（已知边界）。

已知偏差（有意接受）：原生把 Files 页与预览的搜索状态都按 pane 共享；插件 Files 页沿用 ADR-0041 的
`(tab, root)` 键，预览按 `(pane, root)` 键，因此"在 Files 页输入查询后切到同一 pane 的预览"
不会继承该查询。跨面共享是纯表现层便利，重键 Files 页会改动 v0.1.20 的行为与测试；只有在宿主提供更明确的
身份接缝时才值得重做。

### D4 结果当前行、滚动与隐藏项

- **当前行**：preview 模式用 `relativeUnderRoot(previewPath, root)` + `locateFile(result.tree, relative)`
  得到绝对路径，交给 `ResultTree → TreeView` 的 `current`。`TreeView.current` 的 `ref` 变为可选，
  `nativeTreeInput` 只在 ref 存在时传 `currentRef`（Factory 的字段本就是可选的）。宿主 Factory 路径由宿主
  绘制当前行（`.current` + `aria-current`），旧行路径由复刻行画 `data-files-current`/`aria-current`；两者
  语义相同，测试按两条渲染路径分别断言。
- **不自动滚动**：原生只有在 reveal 结算、且当前行尚未绘制时，才在下一次绘制把当前行滚进视口。
  插件的 reveal 进行态属于 `FilesTree` 的组件 state：结果视图卸载树体会**丢弃**进行态，清空查询后按
  `saved.revealed` 的 seed 规则**重新判定**（已完成 walk 的文件不重滚），因此结果视图只标当前行、不复刻滚动，
  与原生一样不会为了"标记"反复抢视口。
- **隐藏项**：search seat 存在时，列出的树使用 `preferences.showHidden`（默认 `false`，eye 关闭）；
  seat 不存在时维持 `FilesTree` 的默认 `true`（今天的树）。这与原生预览在 rc.2+ 的行为一致，
  也是本 ADR 唯一一处用户可见的默认外观变化：附加根预览树默认不再显示 dotfile，eye 打开后恢复。

### D5 焦点、键盘与 Escape

- **焦点交接**：`FilesTree` 的 body 从"aside 的直接子节点"变成 pane 的子节点后，把查找范围从
  `body.parentElement` 改为 `body.closest('[data-files-page], aside[data-files-navigator]')`（找不到容器时仍用父节点）；
  两个挂载面（Files 页与预览）语义一致：无 pane 包装的旧宿主/旧路径行为不变；Files 页在 rc.2+ 因 pane 包装而失效的交接被同一规则恢复。
- **设置回焦**：关闭设置浮层后聚焦栏内的 magnifier（原生行为）；preview 与 page 共用。
- **Escape 顺序**：设置浮层先自持 Esc；随后 `FilesPane` 在 query 非空时清空并 `stopPropagation`；
  query 为空时不再拦截，让上游 face 的 document 级 Escape 关闭浮层导航树。上游的 `close`（`face.ts`）挂在
  document 冒泡并明确以 `event.defaultPrevented` 判定（README：Escape 在行自身处理器之后才被 document 听到，
  行内处理器 prevent 它会保留导航树）；row 处理器在 query 非空时同时 `preventDefault` 与 `stopPropagation`。
  测试同时断言两件事：query 非空时 `defaultPrevented` 为真且 document 监听收不到；query 为空时
  `defaultPrevented` 为假且 document 监听收得到。真实关闭与焦点归还由实机目检确认。
- **行移动**：沿用 `moveAlongRows`，但 stops 必须覆盖 pane 根内**列出的树行与结果行**
  （`[data-mrfw-files-search]`、`li[data-files-entry] > button` 与 `li[data-files-entry] > div > button`，
  Factory 与 legacy 两条渲染路径同用）；preview 的搜索结果容器带同一个
  `data-mrfw-files-results` 钩子，但焦点选择器不再以它为前提。Down 从输入进首行、Up 从首行回输入，
  两个模式都成立。
- **Mod+P 边界保留**：不注册快捷键；接管期原生框隐藏，命令不会把键盘交给插件输入框。这与 ADR-0041 D4
  记录的 Files 页边界同类，属于上游 face 不可重指的已知限制，不新增第二入口。

### D6 CSS 与 DOM：只隐藏原生，不隐藏自己

- `styles.ts` 的隐藏规则加一个**防御性**否定守卫：`aside[data-mrfw-navigator] > div:not([data-mrfw-files-pane]):has([data-files-search])`；
  `FilesPane` 根元素携带 `data-mrfw-files-pane`。现状的规则只匹配精确名 `[data-files-search]`（输入框）
  与 aside 的**直接子节点** `[data-files-search-status]`，pane 已包在一层 div 里，因此今天的 DOM 本来就不会
  被误伤；守卫是为上游改选择器或本插件重构时不误伤，测试按“有/无 marker 两向 `matches()`”钉住。
- 插件 DOM 继续使用 `data-mrfw-files-*` 作为自己的钩子，**不写**精确的 `data-files-search`（输入框）与
  `data-files-root`/`data-files-body`；但**确实沿用**上游同名钩子 `data-files-search-status`、
  `data-files-search-settings`、`data-files-search-settings-toggle`、`data-files-show-hidden`、
  `data-files-search-clear` 等（它们位于 pane 后代）。状态行与设置浮层的隐藏依赖 **direct-child** 语义，
  同一规则里再给 `[data-files-search-settings]` 补直接子节点隐藏，覆盖“接管瞬间原生 draft 仍在”的遗留浮层；
  测试要同时断言插件的嵌套节点不被匹配、原生直接子节点被匹配。FORK.md 现有的
  “deliberately NOT the `data-files-search*` hooks”表述要改成这个准确事实。
- 不新增视觉语言/规则集：`mrfw-fsPane` 已是"原生 navigator 的列上下文 + 拉伸项"，其内部 bar/status/body/settings
  与 preview 的 aside 布局同构。新增的 CSS 只有两条**隐藏原生**的防御规则：搜索栏选择器的 `:not([data-mrfw-files-pane])`
  守卫，以及 aside 直接子节点 `[data-files-search-settings]` 的隐藏（防接管瞬间遗留的原生 draft 浮层）；
  两者都不给插件自己的节点加样式，并各有 `matches()` 测试。

### D7 版本门控与零 Host 改动

- 不新增探测、不比较版本字符串：搜索面只由 `filesTree.search` seat 的存在决定（其本身由
  `remote.workspaceFiles.search` 函数 + 面板通道结构探测而来）。
- 不改 `src/contract.ts`、`src/files-search.ts`、`src/workspace-files.ts`、`src/command.ts`、
  registry/scope 与支持矩阵；客户端不新增依赖。实现 PR 的 Host 侧 diff 必须为空。

## Alternatives Considered

- **新建 `NavigatorSearch` 组件，复制搜索状态机**：请求身份、偏好、铺开/折叠、设置草稿、无障碍与
  键盘会出现第二份语义，必须与 `FilesPane` 同步演进；排除。
- **抽出 headless `useWorkspaceSearch` 再由两个视图分别渲染**：结构上更分离，但本次两个视图共享
  90% 以上的结构（同一 bar/status/results/settings 组件），抽取只增加一次重构面而没有行为收益；
  待上游把搜索拆成可复用 Factory 时再议；本轮排除。
- **让原生导航器直接搜附加根**：原生 wire 无根字段，根由 Host 从 Session cwd 解析（ADR-0041）；
  且原生 face 的搜索状态与我们接管的树不共享数据源；排除。
- **接管期不隐藏原生栏，让用户看到但报错/搜主根**：原生结果画进被隐藏的 body，成为死控件；
  主根结果与附加根树并置会直接误导；排除。
- **把原生栏控件搬到插件容器（重父级/DOM 搬移）**：上游 face 的注册、焦点与状态绑定在原生组件实例上，
  搬 DOM 会与 React 的树所有权冲突；排除。
- **插件自建 ripgrep/Host 搜索**：复制上游预算、ignore 规则与错误语义；ADR-0041 已排除，本 ADR 沿用。
- **为预览新增独立端点或把 paneId 塞进 `search` 请求**：无需要——端点只需要 session + rootId，
  预览与 Files 页共享同一授权语义；新增字段会扩大 wire 与 review 面；排除。

## Consequences

- 附加根预览导航树获得与主根原生一致的搜索：同一 Host 实现、同一限额、同一错误码、同一偏好键与语义；
  入口、栏、结果、高亮、笔记、失败重试、键盘与 Escape 顺序对齐原生预览。
- 一个 `mode` 分支与结果当前行对齐取代第二套搜索实现；`FilesPane` 的默认行为保持 page。Files 页还有
  **共享显式变更清单**并有测试钉住：设置关闭回焦改为 magnifier、Up/Down 焦点 stops 覆盖列出的树行、
  设置草稿随 `stateKey` 清理（三项行为对齐；其中 stops 与草稿清理是 v0.1.20 既有缺口的修复）、
  `RootSwitcher` 换根过渡帧缺陷修复（v0.1.20 已发布缺陷），以及纯 DOM 的 `data-mrfw-files-pane` 标记。
  行为项需在发版 CHANGELOG 中如实记录。
- 同步义务扩大：`src/client/files-tree/FORK.md` 的 navigator 搜索半部（`FileNavigator` 的 search 区）
  与 `pane.tsx` 的语义对应关系要写进同步清单；上游 `data-files-search*` 钩子变化时重新核对隐藏规则
  （含 `data-files-search-settings` 直接子节点的遗留浮层）。
- 对 ADR-0041 的修订采用**追加 Amendment 小节**的方式，保留其 Accepted 状态与 D4 原文；历史文档
  （completed plans、CHANGELOG、修订前的 ADR 原文）中的“预览导航器无搜索”记载合法保留，不被改写或
  作为文档门禁判据。
- 旧宿主零变化：有面板通道但无 search seat 时仍 portal `FilesTree`；无 `document.actions` 槽时整个 occupant
  不注册；无面板通道时导航接管不存在、全程原生。rc.2+ Files 页的设置回焦、Up/Down stops 与设置草稿
  随 `stateKey` 清理是对齐修正（有意变更，测试与发版 CHANGELOG 记录），不在“旧宿主零变化”承诺内。
- 用户可见变化：rc.2+ 上附加根预览树默认隐藏 dotfile（与原生 eye 默认一致），eye 打开即恢复。
- 已知限制保留：Mod+P 不聚焦插件输入框；结果当前行不自动滚动；Files 页与预览不共享搜索记录（D3）；
  结果视图替换树体会结束 hold（清空 query 后重新 list/watch，但保留已列行、不闪 loading）；设置草稿
  在根切换时丢弃、关闭 Folder 时丢失（D3）。
- 测试面：`FilesPane` 的模式单测、导航接管集成测试（真实 pane + stub search）、`RootSwitcher`/Files 页
  换根过渡帧回归（镜像 D8-10 的可观测断言）、styles 隐藏守卫、`FilesTree` 焦点交接、旧 seat 缺席的
  零变化断言；无 Host/协议测试新增。
- 回滚：把 `navigator.tsx` 的 portal 分支恢复为只画 `FilesTree`（并让 `takeover` 去掉 `rootId`），删除
  `FilesPane` 的 mode 分支、marker、设置回焦/键盘共享修正与草稿清理，并恢复 `RootSwitcher` 的旧 `Takeover`
  形状与 `selectedId` 接线，恢复 `TreeView.current` 的 ref 必填与 `FilesTree` 的父节点查找即可；其中设置回焦、
  键盘 stops、草稿清理、`RootSwitcher` 过渡帧修复与焦点交接是独立修复，可以选择保留。
  无数据迁移、无协议变化，偏好沿用宿主同名 localStorage 键。

## Related Documents

- [ADR-0041](./ADR-0041-additional-root-workspace-search.md)（搜索端点、状态归属、结构与兼容门控；本 ADR 以追加的“D4 修订（2026-11-16）”小节关闭其预览导航树边界，不重写已接受的原文）
- [ADR-0042](./ADR-0042-additional-root-row-context-menus.md)（同一接管树的行右键）
- [ADR-0015](./ADR-0015-files-tab-plugin-owned-browsing.md) / [ADR-0016](./ADR-0016-files-tab-native-tree-fork.md)（接管形态与树体 fork）
- [ADR-0002](./ADR-0002-upstream-coupling-policy.md) / [ADR-0009](./ADR-0009-dsh-compat-contract.md)（上游耦合与结构探测）
- [ADR-0006](./ADR-0006-client-ui-host-tokens.md)（宿主 token）
- [ADR-0024](./ADR-0024-registry-operation-admission.md) / [ADR-0025](./ADR-0025-shared-registry-authority.md)（Host 准入与共享权威）
- [实施计划](../plans/active/2026-11-16-additional-root-preview-navigator-search.md)
- `src/client/files-tree/FORK.md`、`docs/reference/dsh-0.2.2-migration.md`
