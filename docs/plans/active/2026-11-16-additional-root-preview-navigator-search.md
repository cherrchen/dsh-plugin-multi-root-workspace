# 附加根文件预览导航树的工作区搜索（实施计划）

> 状态：**P1–P4 已实施**；P5 本机门禁与**隔离环境交互目检**已完成（见「进度与证据」，截图待维护者目视复核）。分支 `feat/additional-file-tree-search` 已推送，Draft PR [#65](https://github.com/cherrchen/dsh-plugin-multi-root-workspace/pull/65) 等待 CI。
> P0 文档已作为 `2265702` 提交，并按 2026-11-16 外部技术评审的 F1–F3 修订（RootSwitcher 过渡帧缺陷纳入、
> 测试范围编号、危害主次表述）。本文件是实施计划与执行账本，每阶段结束把命令与结果写入「进度与证据」。
>
> 分支：`feat/additional-file-tree-search`（`main` @ `53ae34d`）。
> 关联：[ADR-0043](../../decisions/ADR-0043-additional-root-preview-navigator-search.md)、
> [ADR-0041](../../decisions/ADR-0041-additional-root-workspace-search.md)、
> [ADR-0042](../../decisions/ADR-0042-additional-root-row-context-menus.md)、
> [ADR-0015](../../decisions/ADR-0015-files-tab-plugin-owned-browsing.md)、
> [ADR-0016](../../decisions/ADR-0016-files-tab-native-tree-fork.md)、
> `src/client/files-tree/FORK.md`、`docs/reference/dsh-0.2.2-migration.md`。
>
> **本次会话只执行 P0（文档，且按用户要求不提交）**；P1 起是待实施的阶段（ADR 已 Accepted）。

## Goal

当被预览的文件位于**附加根**时，让文档预览右侧的 Folder 导航树（上游 `FileNavigator`，插件接管树体）获得
与**主根原生导航树**一致的工作区搜索：搜索栏常显、设置浮层、隐藏项眼睛、`aria-live` 结果计数、命中高亮结果树、
空/截断/不完整提示、失败重试、Up/Down/Esc 键盘语义；搜索根是被预览文件所在的附加根，请求经既有 Host
`search` 端点授权与路由。

本轮不新增 Host 能力：复用 ADR-0041 的端点与插件搜索面（`FilesPane`），把它以 `preview` 模式接进预览接管，
并让旧宿主、主根与 Files 页签行为保持不变。

## Background

### 场景与根因

两个相邻场景（用户截图）：

1. **主根文件被预览**：右侧导航树由上游 `FileNavigator` 原生绘制。DSH `0.2.2-rc.2` 起它自带搜索栏
   （截图左上角"搜索文件"输入框），输入直接调上游 `workspaceFiles.search`。
2. **附加根文件被预览**：插件的 `NavigatorRetarget` 在同一个 `aside[data-files-navigator]` 上接管树体，
   portal 逐字节复刻的 `FilesTree`。但接管只替换了树体：原生搜索栏与状态行被
   `src/client/styles.ts` 一并隐藏，而插件自己的搜索面只接在 Files 页签（`FilesPane`）上。
   于是附加根的预览树没有任何搜索入口。

根因不是样式，而是**接线缺口**：搜索面与刷新/打开/当前行语义都是按 Files 页形态写的，预览接管只借用了树体。

同一次评审还确认了一个**同型、且已在 v0.1.20 发布版本中存在的缺陷**：Files 页的 `RootSwitcher` 里搜索记录的
`stateKey` 取自 `takeover`（旧根），`rootId` 取自 `selected`（新根），换根那一帧会以 B 的 rootId 发出 A 的
query/filters，并把 A 的记录写成 `pending` 后无人结算（A 的 spinner 卡死、失败结果被清成无限 pending）。
预览接管与它共享同一个修复模式，本计划一并修复（见 D2、D8 的 switcher 用例）。

### 版本答案（用户询问"这是哪个 DSH 版本加的"）

| 项 | 值 |
| --- | --- |
| 引入 release | **`0.2.2-rc.2`**（tag `dsh-v0.2.2-rc.2` = `ddac96760b6edf8fa0fe17cbdcf0b512f4c12b2c`，tag commit 时间 2026-11-11；npm 于 2026-11-12 提供该精确版本） |
| 引入提交 | 上游 PR [#7365](https://github.com/deepseek-ai/deepseek-harness/pull/7365) `feat/sidebar-file-search`，merge `2d463af8d2`（2026-11-07）；同一 PR 引入 `workspaceFiles.search`、`FileNavigator` 搜索半部、`SearchSettings`、搜索规则/偏好/结果树与 `data-files-search*` DOM |
| rc.1 到 rc.2 的差异 | `ui-sidebar-files` 的 `FileNavigator.tsx` 变化 `+240/−16`（搜索栏/状态行/结果/设置），另有
  `search-*.ts`/`SearchSettings.tsx`/store/face actions；`api/workspace-files` 新增 `search.ts`（`+124`）与 wire 类型 |
| rc.2 到 rc.3 | 该包 `src/` 与 `locale/` **零差异**（只有 `package.json` 版本行），搜索语义基线 = rc.3 |

插件侧的对应时间线：`v0.1.16` 起预览导航接管；`v0.1.18` 支持 rc.2 时把原生搜索面在接管期隐藏；
`v0.1.20` 补齐 Files 页签搜索（ADR-0041/0042），并明确把预览导航树排除（ADR-0041 D4）。本轮关闭该遗留缺口。

### 上游契约清单（预览模式，必须对齐）

| # | 行为 | 上游锚点（rc.3，只读核对） | 本轮实现 |
| --- | --- | --- | --- |
| U1 | 预览的搜索栏**常显**；Files 页由页头 toggle 控制 | `FileNavigator.tsx` `const searchBarOpen = !page \|\| state?.searchBarOpen === true` | `FilesPane` 新增 preview 模式：恒显示、不写 `barOpen` |
| U2 | 每 pane 一份 query/pending/result/结果展开/结果滚动；不持久化 | `store.byPane[panel.id]`；`files-navigator.client.spec` | 复用 `search-state.ts`，键 `(paneId, root)` |
| U3 | 非空即搜、新请求 abort 旧请求、空白回树 | `face.ts` `runSearch/settle`；`FileNavigator` input change | 已是 `FilesPane` 现有 effect 语义 |
| U4 | 结果树 = 同一 tree Factory，全展开、`highlight`、`omitted:'unmatched'` | `FileNavigator.tsx` `renderFactorySlot('sidebar.files.tree', ...)` | 已是 `ResultTree → TreeView` |
| U5 | 预览时结果里标当前文件（`current` 由 `locateFile(resultTree, relative)` 计算） | `FileNavigator` `resultCurrent` | preview 模式新增 `previewPath` → `current`（不自动滚动，见 D4） |
| U6 | 打开结果行 = 预览的 `replaceTab` | `PreviewFrame.tsx` `openResource(address, { replaceTab: true })` | preview 模式 `onOpenFile` 用现有 `openFileIn` |
| U7 | 计数行/空结果 hint/截断/不完整/失败 + Retry | 上游 `SearchNotes`/`SearchFailure`；README §Search | 已是 `FilesPane` 现有视图与语义 |
| U8 | 设置浮层：规则草稿关闭时保存、ignore 立即、关闭回焦 magnifier | 上游 `SearchSettings` + `closeSettings` | 复用；把回焦目标从输入框改为 magnifier（两模式一致） |
| U9 | eye 默认关闭；列出的树与搜索都过滤隐藏项 | 上游 `workspaceEntries(levels, showHidden)`；默认偏好 | seat 存在时把 `preferences.showHidden` 传给 `FilesTree`（今天是默认 true） |
| U10 | Esc：设置 → 清空查询 → 交给上游关闭导航树 | 上游 aside `onKeyDown` + document `close` | `FilesPane` 现有处理器；新增"query 为空不拦截"的断言 |
| U11 | Mod+P (workspace.files) 聚焦搜索框；接管期原生框隐藏 | 上游 face `focus()` | **不实现**，保留为文档化边界（不注册第二快捷键） |
| U12 | Up/Down 的焦点 stops 覆盖输入 + body 行（列出的树与结果共用 body） | 上游 `FileNavigator.moveAlongRows` 的 `[data-files-search], [data-files-body] [data-files-path] > div > button` | 扩 `FilesPane.moveAlongRows` 的 stops 到 pane 根内的树行与结果行（当前只覆盖结果行；两个模式共用，见 D1 共享修正） |

### 插件现状（代码地图，`main` @ 53ae34d）

| 位置 | 现状 | 本轮动作 |
| --- | --- | --- |
| `src/client/files-tree/navigator.tsx` | 预览接管：定位预览/aside/pane/root，hold/reveal/scroll 记忆，portal `FilesTree`，`openFileIn`；`root` 与 `takeover` 是两个 state | 增加 search seat 分支：portal `FilesPane mode="preview"`；接管记录补 `rootId` 并原子落定 |
| `src/client/files-tree/pane.tsx` | `FilesPane`：bar/status/results/settings/keyboard/偏好/请求身份/隐藏项；bar 由 `barOpen` 打开、打开走 `openFile`、关闭设置回焦输入；**Up/Down stops 只含结果行**；设置草稿不随根清理 | 增加 `mode`/`previewPath`；preview 差异与 current 标记；回焦 magnifier；pane 根 marker；stops 扩到树行；草稿随 `stateKey` 清理 |
| `src/client/files-tree/FilesTree.tsx` | 树体；`showHidden` 默认 true；焦点交接按 `body.parentElement` 找原生 body | 焦点交接改为在接管容器内查找（D5） |
| `src/client/RootSwitcher.tsx` | Files 页搜索 seat 的 owner：`searchKey` 取自 `takeover`（旧根）、`rootId` 取自 `selected`（新根），存在同型过渡帧缺陷 | `Takeover` 补 `rootId`，`searchKey` 与 `rootId` 都从 takeover 读取（D2） |
| `src/client/files-tree/adapter.tsx` | `createFilesTreeSurface` 已组装 `search` seat；`searchSupported()` 结构探测 | 不改（预览复用同一 seat） |
| `src/client/files-tree/search-state.ts` | 记录 `(tabId, root)`、请求身份、`forgetTab` | 不改；预览以 paneId 作为 tabId |
| `src/client/files-tree/tree-view.tsx` | `current` 需要 `ref`；`highlight`/`omitted` 已具备 | `current.ref` 改为可选 |
| `src/compat/files-tree.ts` | `nativeTreeInput` 传 `current`/`currentRef` | `currentRef` 只在存在时传（Factory 字段本就可选） |
| `src/client/styles.ts` | 隐藏 aside 的原生 body/搜索栏/状态行（无否定守卫） | 加 `:not([data-mrfw-files-pane])` 守卫；不新增视觉规则 |
| `src/client/index.ts` | `document.actions` occupant 注册 `NavigatorRetarget`（apply 作用域有插件 `t`） | 传入失败码本地化回调 |
| `src/files-search.ts`、`src/workspace-files.ts`、`src/contract.ts` | Host 端点/路由/准入已就绪（ADR-0041） | **零改动**，实现 PR 以 diff 为空作为验收 |
| `tests/client-navigator.spec.tsx` | 自建预览 DOM fixture + 共享 harness；无 search stub | 扩展 harness（remote.search + rpc search）+ 新用例 |
| `tests/client-search.spec.tsx` | `FilesPane` 页模式用例 | 增加 preview 模式用例 |
| `tests/client-styles.spec.ts` | 断言隐藏选择器与插件搜索样式 | 更新隐藏选择器的守卫断言 |
| `src/client/files-tree/FORK.md` | 同步义务/同步步骤（已提及 navigator search half） | 更新 delta 与 DOM 契约段（D9） |

### 为什么 Host 零改动

`search` 端点接收 `{ sessionId, rootId, query, excludedPaths, includeHidden, respectGitignore }`，
Host 用自己的会话派生权威与 Registry 解析 rootId、在准入帧内复核授权、再以命名该根的 scope 调上游同一实现
（`src/files-search.ts` / `src/workspace-files.ts`）。预览与 Files 页对它的需求完全相同：**搜哪个登记根**。
预览不带来新的授权对象、不需要 pane 身份、不需要额外字段；把 paneId 塞进 wire 只会扩大协议面（ADR-0043
Alternatives 已记录该取舍）。

## Scope

- 客户端：`FilesPane` 的 preview 模式；`NavigatorRetarget` 接线；结果当前行；焦点交接；隐藏项默认；
  设置回焦；CSS 隐藏守卫；DOM 标记。**零文案改动**：所有字符串继续来自上游 `sidebarFiles` 活词典，
  `src/client/locales.ts` 与 `locale/*.json` 不动。**无新增依赖/外部 import**：`client-bundle` 的
  模块表与既有外部集不变。
- 测试：`client-search`（pane 模式）、`client-navigator`（接管 + 搜索 + 降级 + 生命周期）、
  `client-styles`（隐藏守卫）、`client-files`/`client-switcher`/`client-search-state` 回归。
- 文档：ADR-0043、ADR-0041 D4 修订、README 双语、architecture/requirements 的 Files 搜索与已知边界段、
  `docs/reference/dsh-0.2.2-migration.md`、`FORK.md`、`.agent/note/dsh-compat-contract.md`（双语）、
  索引与路线账本登记。
- 门禁：`lint` / `typecheck` / `build` / focused vitest / `compat:check` / `docs:check` / `pack:check`；
  全量 `test`、smoke 与 CI 按仓库发布流程执行。

## Non-goals

- 不改 Host：`contract.ts`/`files-search.ts`/`workspace-files.ts`/`command.ts`/registry/scope/支持矩阵，
  不新增端点或请求字段。
- 不加任何 `@deepseek-ai` 依赖或运行时 import（`client-bundle.spec.ts` 的模块表/外部集保持不变）；
  不改 dev pin / peer / `SUPPORTED_DSH_RELEASES`。
- 不注册新快捷键、不接管 Mod+P（`workspace.files`）；不把原生搜索框搬进插件容器。
- 不改 Files 页的搜索入口与页头形态。`mode` 默认值保持 page；共享面只做**显式变更清单**：设置关闭回焦、
  Up/Down stops、设置草稿随 `stateKey` 清理（三项行为，后两者含 v0.1.20 既有缺口的修复）、`RootSwitcher`
  换根过渡帧缺陷修复（v0.1.20 已发布缺陷）与 `data-mrfw-files-pane` 纯 DOM 标记；行为项属有意改变 Files 页，
  需在 ADR/CHANGELOG 记录。
- 不重写 `FilesPane` 为 headless hook / 第二个组件（ADR-0043 Alternatives）。
- 不改主根原生导航树、原生 Files 页树与原生搜索行为；不改旧版 fork 基线（`0.2.2-alpha.2` 的
  `directory-node.ts`/`store.ts` 逐字节面，`face.ts` 的 hold/release delta 不动）。
- 不做 CHANGELOG/版本号/tag/PR（按发布流程，在发版准备时写 CHANGELOG 并行）。
- 不把本计划当作"已实现"写入 current-state 文档；P4 只在实现完成后更新。

## Design

### D1 `FilesPane` 的 preview 模式（唯一状态机）

API 增量（`src/client/files-tree/pane.tsx`）：

```ts
export interface FilesPaneProps {
  // ...现有字段不变（filesTree/stateKey/rootId/tabId/root/signal/useStore/actions/
  //   onOpenFile/nativeTree/reveal/saved/onScrollOffset/describeFailure）
  /** 'page'（默认）保持 Files 页形态；'preview' 是预览导航树里的形态。 */
  readonly mode?: 'page' | 'preview' | undefined
  /** preview：被预览文件的绝对宿主路径，用于结果树当前行。 */
  readonly previewPath?: string | undefined
}
```

行为差异（唯一清单，禁止再加隐式分支）：

| # | 行为 | page（默认，不变） | preview |
| --- | --- | --- | --- |
| 1 | 栏可见性 | `state.barOpen === true` | **恒真**；不读、不写 `barOpen` |
| 2 | 首次挂载聚焦 | bar 打开时聚焦输入 | 不聚焦 |
| 3 | 打开行 | `onOpenFile`（调用方给 `openFile`） | 同一 prop；调用方给 `openFileIn`（replaceTab） |
| 4 | 结果当前行 | 无 | `previewPath` 与结果树匹配时标 `data-files-current` |
| 5 | 设置关闭回焦 | **改为 magnifier**（与原生一致；两模式共用） | 同左 |
| 6 | 根元素标记 | `data-mrfw-files-pane=""`（新增；无样式影响） | 同左 |

实现要点：

- `const preview = mode === 'preview'`；`const barOpen = preview || state?.barOpen === true`。
- 自动聚焦 effect 加 `if (!preview)`；preview 不产生"打开预览即抢焦点"。
- `SearchBar` 新增 `triggerRef` 回调 ref（设置在 magnifier 按钮上）；`FilesPane` 持有
  `settingsTrigger`，`closeSettings` 的 `refocus` 分支改为 `settingsTrigger.current?.focus()`
  （两个模式一致，属对上游原生行为的对齐）。
- 当前行：以 `relativeUnderRoot(previewPath, root)` 求相对路径；结果找到时用
  `locateFile(result.tree, relative).current` 求当前行 key（`result.kind === 'found'` 且相对路径存在时）。
  `ResultTree` 新增 `current?: string`，内部传 `TreeView current={{ path, ref: undefined }}`。
- `FilesPane` 根 div 增加 `data-mrfw-files-pane=""`（D5 的隐藏守卫与测试锚点）。

不引入新状态：查询、结果、展开、滚动、失败、attempt 全部沿用现有 `(tabId,root)` 记录；preview 只改变
"栏是否画、打开往哪走、结果标不标当前行、首次是否聚焦"。

**共享显式变更清单**（三项行为对齐 + 一项过渡帧缺陷修复 + 一个纯 DOM 标记；两模式共用，因此也改变
Files 页既有行为，必须在 ADR/CHANGELOG 明说）：

- 设置关闭回焦改为 magnifier（原生行为；现状是聚焦输入框）。
- `moveAlongRows` 的 stops 从“输入 + 结果行”扩为“输入 + 列出的树行 + 结果行”：现状只覆盖结果行
  （`[data-mrfw-files-results] li[data-files-entry]`），列出的树行不在 stops 里，与原生“Down 从输入进入首行、
  Up 从首行回到输入”不一致。这是 v0.1.20 遗留的键盘缺口，本计划一并修正（非 preview 特有差异）。
- 设置草稿随 `stateKey` 变化清空（D3）：Files 页切换根时同样生效，避免旧根草稿落到新根偏好。
- **`RootSwitcher` 换根过渡帧缺陷修复（D2）**：换根时不再发出“B 的 rootId + A 的 query”请求，也不在 A 的
  记录上遗留 `pending`（v0.1.20 已发布缺陷的修复）。
- `data-mrfw-files-pane` 根标记（纯 DOM，无视觉/交互效果）。

### D2 接线：接管记录按根原子落定（预览接管 + Files 页两个 owner）

**主导危害是错配请求与记录串写，崩溃是次要情形**：换根那一帧若 `stateKey/root` 与 `rootId` 来自不同 state，
会以 B 的 rootId 发出 A 的 query/filters，并把 A 的记录写成 `pending` 后无人结算；只有“无保护地读 `root.id`”
才会额外崩溃。预览接管与 Files 页的 `RootSwitcher` 是同一模式的两个实例，必须一起修。

`src/client/files-tree/navigator.tsx`：

```
const search = filesTree.search
// 接管记录必须自带根路径与根 id：root(RootView) 与 takeover 原本是两个 state，
// 根切换 / list 失败时有一帧“旧 takeover + 新/空 root”。主导问题是错配请求与
// 记录串写；无保护地读 root.id 才会崩。
const rootId = root?.id
useEffect(() => {
  if (aside === null || rootPath === undefined || rootId === undefined || paneId === undefined) {
    setTakeover(null)
    return
  }
  setTakeover({ signal: takeoverCtl.signal(paneId, rootPath, ...), paneId, root: rootPath, rootId })
  ...
}, [aside, rootPath, rootId, paneId, takeoverCtl])

createPortal(
  search === undefined
    ? <FilesTree {...现有全部 props} />                       // 今天的形态，逐项不变
    : <FilesPane
        filesTree={filesTree}
        mode="preview"
        stateKey={searchStateKey(takeover.paneId, takeover.root)}
        rootId={takeover.rootId}
        tabId={takeover.paneId}
        root={takeover.root}
        signal={takeover.signal}
        useStore={filesTree.useStore}
        actions={filesTree.actions}
        onOpenFile={address => {
          if (openTabId === undefined) filesTree.openFile(address)
          else filesTree.openFileIn(openTabId, address)          // openTabId = preview tab id；不要传 paneId
        }}
        nativeTree={props.nativeTree}
        reveal={revealLive ? {...} : undefined}
        saved={savedTree}
        onScrollOffset={onScrollOffset}
        previewPath={absolutePath}
        describeFailure={describeFailure}
      />,
  aside,
)
```

- `takeover` 记录从 `{ signal, paneId, root }` 扩为 `{ signal, paneId, root, rootId }`，**四个字段在同一次
  state 提交里落定**（`rootId` 来自同一次 `list` 应答的 `RootView.id`）；`root` 反向不再被 pane 读取。
  这样根切换（A→B）与 list 失败（`setRoot(undefined)`）的过渡帧都只渲染**完整旧根**或什么都不渲染，
  不会出现“A 的 key + B 的 rootId”的错配请求/记录串写（`undefined.id` 崩溃只是无保护读取的次要情形）。
- **`RootSwitcher.tsx` 用同一修复（v0.1.20 现存缺陷）**：它的 `Takeover` 记录当前是 `{ signal, tabId, root }`，
  而 `searchKey` 取自 `takeover`、`rootId` 取自 `selected`。改为 `Takeover = { signal, tabId, root, rootId }`，
  `rootId` 与 `selectedPath` 在同一次 state 提交里落定；portal 内 `stateKey` 与 `rootId` 分别由
  `searchStateKey(takeover.tabId, takeover.root)`、`takeover.rootId` 得到，两处都不再直接读 `selectedId`。

```ts
// RootSwitcher.tsx（修复后）
interface Takeover {
  readonly signal: AbortSignal
  readonly tabId: TabId
  readonly root: string
  readonly rootId: string
}
useEffect(() => {
  if (!treeVisible || selectedPath === undefined || selectedId === undefined || tabId === undefined) {
    setTakeover(null)
    return
  }
  setTakeover({ signal: takeoverCtl.signal(tabId, selectedPath, ...), tabId, root: selectedPath, rootId: selectedId })
  ...
}, [treeVisible, selectedPath, selectedId, tabId, takeoverCtl])
```
- `describeFailure`：`NavigatorRetargetProps` 新增可选 `describeFailure?: (failure: SearchFailureInfo) => string | undefined`；
  在 `src/client/index.ts` 的 document-actions occupant 里用 apply 作用域的 `t` 构造。把
  `RootSwitcher` 里现有的 describer 抽成共享 helper（例如 `files-tree/describe-failure.ts`），两处共用
  `errorKeyOf` 映射（`error.fallback` 返回 undefined，交给 `FilesPane` 的树词汇），避免两份映射漂移。
- 搜索记录的清理沿用现有 `dropDeadOwners → endTakeover(key, true) → searchStore.forgetTab(key)`；
  pane 死亡时预览与 Files 页只要同一 id 的键都会清掉（两者键空间不同 id，互不影响）。
- **seat 缺席路径不改**：有面板通道但 `search === undefined` 时仍 portal `FilesTree`，DOM 与生命周期不变
  （新 CSS 守卫不匹配旧 DOM，行为不变）；覆盖 `0.2.2-alpha.3`–`rc.1` 与裁剪掉 search 服务的组合。
  **没有面板通道时导航接管本身就不存在**（`navigator.tsx` 发 `list` 需要 `panel`），导航树全程原生。
- 名称纪律：外层“预览 tab id”（`data-dockkit-content`，用于 `openFileIn` 的 `replaceTab`）在实现中命名为
  `openTabId`，与记录键 `paneId`、Files 页的 `tabId` 区分，杜绝把 paneId 传给 `replaceTab`。

### D3 状态、请求身份与生命周期

- 键：`searchStateKey(paneId, root)`。选 paneId（aside 的 `data-files-navigator`）而不是 preview tab id：
  `replaceTab` 会换 tab 但 pane 存活；原生 `store.byPane` 也是 pane 语义；打开文件后返回、导航树关开都保记录。
- 请求身份：沿用 `searchRequestKey`（rootId/query/excludedPaths/includeHidden/respectGitignore/attempt）。
  导航树重新打开或 body 重挂载时，同身份已结算答案直接复用（不重跑、不重置展开与滚动）。
- 根切换（同一 pane 的预览文件从根 A 换到根 B）：键跟着 root 变，A 的 query/结果留在 A 的键下；不串状态。
- 根被移除/扣留/重定向：Host 端点会在下一次搜索拒绝（`root-unavailable`/`not-found` 等），
  已画出的旧结果保留到下一次请求结算，失败视图带 Retry；树体本身仍由现有 Registry/刷新行为决定（不变）。
  **同路径移除后以新 `rootId` 重加**：预览接管只在 aside 打开/预览文件变化时重新 `list`，旧 `rootId` 的
  Retry 会持续 `not-found`，直到关闭/重开 Folder；本轮不做“失败时有界重列”，与现有树刷新时机保持一致，
  写入已知边界。
- 未授权：客户端无法构造"搜别的根"的请求（`rootId` 来自本次 list 的 `RootView`），Host 侧仍独立复核；
  本条不是新的信任面。
- **设置草稿必须随 `stateKey` 清理**：设置浮层草稿是组件 state；同一 pane 的预览文件从根 A 换到根 B 时
  `FilesPane` 不重挂、只有 props 变，若面板开着，A 的规则草稿会被 `closeSettings` 写进 B 的偏好键。
  实现为 `useEffect(() => { setSettingsDraft(undefined) }, [stateKey])`（清空而不是提交，避免写错根），
  并补测试（A 根开面板改规则 → 切 B → B 的偏好不变、面板关闭）。关闭 Folder 时 pane 卸载、草稿丢失——
  原生组件只 `return null`、草稿存活，这是接受的已知差异，写入 FORK.md。
- **结果视图会卸载列出的树**：query 非空时 `FilesPane` 用结果体替换 `FilesTree`，树卸载触发 `release`
  （关闭目录节点与 watch）；清空 query 后重新 `hold` 并重新 list/watch。原生是同一个 body 换内容、hold 不断。
  这是接受的行为差异：store bucket 与已列 levels 保留，重开时 ready level 的 `loading` 是 no-op，不闪 loading；
  A6 的“不新增请求”只约束搜索请求（请求身份），不约束清空 query 后的目录 list/watch。

### D4 隐藏项、当前行与树

- **隐藏项**：seat 存在时，`FilesPane` 把 `preferences.showHidden` 传给列出的 `FilesTree`；
  preview 模式因此与原生 rc.2+ 预览一致：**默认不显示 dotfile**，eye 打开后无重列即出现。
  seat 缺席时 `FilesTree` 继续用默认 `true`（今天的树），旧宿主零变化。
- **当前行**：只标记、不自动滚动。理由：上游的滚动只在 reveal 结算且当前行尚未绘制时触发
  （`pane.scrollToCurrent`），插件的 reveal 进行态（`walk`/`revealSeed`）是 `FilesTree` 的组件 state；结果视图下
  树体卸载会**丢弃**进行态，清空查询后按 `saved.revealed` 的 seed 规则**重新判定**（已完成 walk 的文件不重滚），
  因此结果视图不复刻该滚动——与原生一样不会为标记反复抢视口（ADR-0043 D4）。
- **当前行在两条渲染路径上的术语**：宿主 Factory 路径由宿主画 `.current` + `aria-current`；旧版逐字节行
  路径由 `TreeView` 画 `data-files-current` + `aria-current`。测试分别断言，不要用一个 DOM 钩子概括两条路径。
- **结果树**：沿用 `ResultTree → TreeView`；preview 只多一个 `current`；`highlight=query`、
  `omitted:'unmatched'`、空结果 hint、截断/不完整与失败重试全部复用。

### D5 焦点、键盘、Escape 与 CSS

- **焦点交接**：`FilesTree` 的 shell 把原生 body 的查找范围改为
  `body.closest('[data-files-page], aside[data-files-navigator]') ?? body.parentElement`，再在其中
  `querySelector('[data-files-body]')`。原因：加 pane 包装后 `body.parentElement` 是 pane 不再是 aside，
  旧写法会静默不再交接；按容器查找同时覆盖门户/直接 child 两种形态，Files 页语义也一致。
- **设置回焦**：改到 magnifier（D1 第 5 行）。
- **Escape**：设置浮层自持；`FilesPane` 在 query 非空时清空并 **同时 `preventDefault` 与
  `stopPropagation`**；query 为空时两者都不做，让上游 face 的 document 级监听关闭浮层导航树。上游
  `face.ts` 的 `close` 以 `event.defaultPrevented` 判定（README：Escape 在行自身处理器之后才被 document 听到）；
  React 18 的合成监听挂在 portal 容器，synthetic stop 也阻止 native 冒泡。测试在 document 上挂冒泡 `keydown`
  监听：非空 query 时 `defaultPrevented` 为真且监听**收不到**；空 query 时 `defaultPrevented` 为假且监听**收得到**。
  真实关闭与焦点归还由实机目检确认。
- **行移动**：`moveAlongRows` 的 stops 改为 pane 根内的
  `[data-mrfw-files-search]`、`li[data-files-entry] > button`、`li[data-files-entry] > div > button`；
  不再以 `[data-mrfw-files-results]` 为前提（列出的树行与结果行都进入 stops，两条渲染路径同用）。
  两个模式共用，因此也修好 Files 页既有缺口（见 D1 末尾的共享对齐修正）。
- **CSS**：`src/client/styles.ts` 的隐藏规则改为

```css
aside[data-mrfw-navigator] > div:not([data-mrfw-files-pane]):has([data-files-search]),
aside[data-mrfw-navigator] > [data-files-search-status],
aside[data-mrfw-navigator] > [data-files-search-settings] {
  display: none;
}
```

  并把 `FilesPane` 根元素标记为 `data-mrfw-files-pane`。守卫是**防御性**的：现状规则只匹配精确名
  `[data-files-search]` 与 aside 直接子节点 `[data-files-search-status]`，pane 包一层后本就不会被误伤；
  加守卫是为了上游改选择器或本插件重构时不误伤，测试按“有/无 marker 两向 `matches()`”钉住。
  状态行与设置浮层的隐藏仍依赖 **direct-child** 语义（插件自己的同名节点在 pane 后代），styles 测试要显式
  断言“插件的嵌套状态行/设置面板不被匹配、原生直接子节点被匹配”。原生设置浮层只在原生 `draft` 非空时
  渲染；正常交互下其 trigger 已被隐藏而不可达，接管瞬间若仍有遗留 draft，新增的直接子节点隐藏规则兜底。
  原生 aside 的宽度/模式/resize 不改；不新增颜色/尺寸规则。

### D6 降级与兼容矩阵

| 宿主 | 预览接管 | search seat | 行为 |
| --- | --- | --- | --- |
| < `0.2.2-alpha.3`（无 `document.actions` 槽） | 不注册 occupant | — | 全程原生；本功能不存在（原生也没有搜索） |
| `0.2.2-alpha.3` – `0.2.2-rc.1`（有槽、有面板通道、无 `workspaceFiles.search`） | 接管树体 | undefined | 与今天完全一致：portal `FilesTree`；原生搜索面隐藏（原本也不存在） |
| `0.2.2-rc.2` +，有面板通道、无 `workspaceFiles.search`（裁剪组合） | 接管树体 | undefined（`searchSupported` 假） | 与今天完全一致：portal `FilesTree`；原生搜索面隐藏（避免死控件） |
| `0.2.2-rc.2` +，有面板通道、有 search 函数 | 接管树体 | 有 | **本轮新行为**：aside 内 portal `FilesPane mode="preview"` |
| **无面板通道**（任意版本） | **不接管**（`navigator.tsx` 的根解析要求 `panel`，拿不到就 `setRoot(undefined)`） | — | 导航树保持原生；本功能不存在 |
| 主根文件（任意宿主） | 不接管 | — | 原生导航树与原生搜索零变化 |

不改 `SUPPORTED_DSH_RELEASES` / dev pin / peer；`pnpm compat:check` 只应输出不变的结果。

### D7 错误与授权（沿用、不扩面）

| 情形 | 表现 |
| --- | --- |
| 宿主无 `workspaceFiles.search` | 不画搜索面；端点即使被调也答 `search-unavailable` |
| 无面板通道 | **不接管**（根解析要求 `panel`）；原生导航器（含原生搜索）完整保留；本功能不存在。
  注：当前 client 行 `inject = ['slots','locale','connection']`，无 connection 时整行不激活，因此该分支在
  真实组合中不可达，仅作逻辑防御，不单测 |
| 根被撤/扣留/重定向/不可用 | 下一次请求以 `root-unavailable`/`not-found` 拒绝，失败视图 + Retry；不泄露路径内容 |
| 会话非 live | 既有 `session-not-found`/`session-not-live` 码，`describeFailure` 本地化 |
| 上游 `workspace-file/*` 失败 | 既有白名单透传（ADR-0041 修订 R3），客户端按树词汇本地化 |
| 请求 abort（新查询/卸载） | 既有 signal 透传；不写回已 abort 的应答 |

### D8 测试设计（实现阶段）

**`tests/client-search.spec.tsx`（pane 单测，jsdom）**

1. preview 模式：`barOpen` 为 false 时仍画搜索栏；挂载不聚焦输入（`document.activeElement` 不是 searchbox）。
2. page 模式回归：既有 14 个用例全绿（含 R1/R2 回归），栏仍由 `barOpen` 控制。
3. preview 打开路由：结果行点击仍调用传入的 `onOpenFile`（由 navigator 层负责 replaceTab 拼装；pane 不感知）。
4. preview 当前行（pane 单测走 legacy 行路径）：`previewPath` 命中结果文件 → 行带 `data-files-current`；
   路径在根外或未命中 → 无标记；Factory 路径（宿主 `.current`/`aria-current`）见 nav-6。
5. 设置关闭回焦 magnifier（preview 与 page 各一条）。
6. 非 preview（page）不产生当前行标记。
7. keyboard stops：page 与 preview 各一条——query 为空时 Down 从输入进入**列出的树首行**，首行 Up 回到输入；
   结果行之间的 Up/Down 不回归。
8. 设置草稿随 `stateKey` 清理：A 根打开设置、编辑规则 → 切到 B 根的 `stateKey` → 面板关闭、B 的偏好不变。
9. Escape 与 document 监听：document 上挂冒泡 keydown。query 非空时 Esc 被 row 处理器 `preventDefault`
   （且 stopPropagation，document 监听收不到）；query 为空时不 `preventDefault` 且 document 监听收得到
   （上游 `face.ts` 的 `close` 以 `event.defaultPrevented` 判定是否关闭）。两个断言都要（只看
   defaultPrevented 或只看“监听到没”都不足以证明关闭链路）。
10. preview 模式不写 `barOpen`：挂载并交互后 `store.state(key).barOpen === false`（栏可见性由 mode 决定，
    不是记录状态）。
11. a11y 结构：状态行 `aria-live="polite"`；eye 按钮 `aria-pressed` 跟随 `showHidden`；设置浮层 `role="dialog"`
    与 `aria-label`；magnifier `aria-haspopup="dialog"`/`aria-expanded` 跟随面板开关。
12. 设置浮层 Esc 顺序：设置打开、焦点在设置输入 → Esc 关闭设置、query 保持不变、document 冒泡监听收不到
    （与 pane-9 的“设置关闭态 Esc 清查询”成对；这是 lint/A5 明确要求的顺序）。
13. 根元素带 `data-mrfw-files-pane`（page 与 preview 两模式）；它是纯 DOM 标记，无视觉/交互效果。

**`tests/client-navigator.spec.tsx`（接管集成，jsdom fixture）**

> 集成夹具里原生搜索栏/状态行**始终在 DOM**（上游预览恒渲染，插件用 `styles` 的 `:has()`/`>` 规则隐藏，
> 但 jsdom 不跑层叠）：原生与插件的 `input[type=search]`、`aria-label`/placeholder、`data-files-search-status`、
> `data-files-show-hidden`、`data-files-search-settings*` 可能重名。所有交互/断言必须先 scope 到插件 pane：
> `const paneOf = (aside: HTMLElement) => aside.querySelector<HTMLElement>('[data-mrfw-files-pane]')!`，
> 再用 `paneOf(aside).querySelector(...)`；`screen.findByRole('searchbox')` 这类全局查询只在纯 pane 单测里用。
> 原生节点只做存在性断言，隐藏语义交给 `client-styles` 的选择器/`matches()` 用例。

1. harness 扩展：`remote.workspaceFiles.search` 函数；`connection.rpc.call` 对 `'search'` 返回
   `SearchView` 并记录 payload；`openNavigator` fixture 增加原生搜索栏（`[data-files-search]`）与状态行节点。
2. 附加根预览 + seat 存在 → aside 内出现 `.mrfw-fsPane`（带 `data-mrfw-files-pane`）与搜索输入；
   原生栏/状态行仍在 DOM（由 `styles` 规则隐藏，styles 套件覆盖选择器）。
3. 输入 query → channel 收到 `sessionId` / `rootId` / `query`（trim 后）/ `excludedPaths`（默认规则）/
   `includeHidden: false` / `respectGitignore: true`；结果树出现、命中 `<mark>`、状态行计数。
4. 结果行点击 → `openResourceIn(sessionId, address, { replaceTab: preview tab id })`（与现有树行同 route）。
5. 清空 query → 回到列出的树，原有 reveal/current 行为不回归。注意：结果态曾卸载树体，清空后重新
   `hold` 会重开目录 list/watch——这是接受的偏差，**不要断言**“清空后无目录请求”；只断言搜索请求不重复。
6. 结果当前行（两条渲染路径分别断言）：legacy 行（无 `nativeTree`）带 `data-files-current`；Factory 路径
   （传入 `renderFactorySlot`）收到的输入含 `current`、`highlight`、`omitted`，且 `currentRef` 缺省时不出现。
   不命中/根外无标记。
7. eye：默认隐藏 dotfile（树里没有 `.hidden` 行）；点 eye → 树出现且下一次请求 `includeHidden: true`；
   偏好按根写入（用现有 preference book 断言）。
8. 失败 + Retry：channel 首次返回错误码 → 失败行 + Retry；重试以同一 payload 再发一次。
9. 生命周期：关导航树（移除 aside）再打开 → query/结果/展开/滚动保留且不新增 search 调用
   （请求身份命中）；`replaceTab` 式 remount（同一 pane、新 tab）同样保留。
10. 根切换与过渡帧（P0 回归）：同一 pane 预览文件从根 A 换到根 B → B 的栏不带 A 的 query（记录分离）。
    过渡帧用**可观测**方式造：hold 住第二次 `list` RPC 再切换预览文件，期间断言 (a) `searchStore` 中 A 的
    key 没有被写入 B 根的结果（已结算记录/expanded 保持 A 的，不出现 B 的 match path），(b) RPC 里不出现
    “`rootId=B` + A 的 query/filters”组合，(c) 释放后页面不崩、新 takeover 正常落到 B；list 失败或切到
    absolute-scope/他会话地址时不抛错（`ErrorBoundary` 不触发）。`stateKey` 本身不出现在 wire，不能直接断言。
11. seat 缺席（remote 无 `search`）：portal 仍为 `FilesTree`（无 `.mrfw-fsPane`），树行为与今天一致
   （用现有接管用例回归）。
12. pane 死亡：移除 pane 载体 → 该 pane 的搜索记录被清理（用 store 断言；配合现有 owner-death 用例）。
13. pane 包装下的既有接管行为：seat 存在时关闭/重开 Folder，展开/滚动/`revealed` 记忆、reveal 与
    `replaceTab` 打开不回归（现有 nav 用例都是无 seat 的直挂形态，需补 seat 形态）。
14. preview 模式不写 `barOpen`：输入/清空后记录的 `barOpen` 仍为 false。
15. Factory 路径键盘 stops：宿主 `renderFactorySlot` 绘制行时 Down 从输入进入首行、首行 Up 回到输入。
16. `describeFailure` 映射：channel 返回 `root-unavailable` 等面板码 → 失败行用插件字典（`error.root-unavailable`），
    不落到 `error.unavailable` fallback；未知码仍回落到树词汇。
17. 无面板通道（若测试组合可达）：occupant 不注册/不接管、aside 不带 `data-mrfw-navigator`；真实组合因
    `inject = ['slots','locale','connection']` 不可达时，在兼容矩阵注明而不强行构造。

**`tests/client-switcher.spec.tsx`（Files 页换根过渡帧，F1 回归）**

- 非空 query 下从根 A 切到根 B（以及 A→primary、primary→B）：hold 住 `list`/`search` 的 RPC 制造过渡帧，
  断言 (a) 不出现“`rootId=B` + A 的 query/filters”的 `search` 调用，(b) A 的记录不遗留 `pending`（回到 A
  时状态行已结算，不出现永久 spinner），(c) 过渡帧后 B 的搜索以 B 的 query/filters 正常结算，(d) 失败结果
  不会在切换窗口被清成无限 pending。与 D8-10 的预览版本共用同一组可观测断言。

**`tests/client-styles.spec.ts`**

- 更新隐藏选择器断言：必须含 `:not([data-mrfw-files-pane])`；用 `matches()` 证明插件 pane 不被匹配、
  原生栏被匹配、无 marker 的 aside 行为不变。
- 状态行与设置浮层按 **direct-child** 断言：aside 的直接子节点 `[data-files-search-status]` /
  `[data-files-search-settings]` 被匹配；pane **内部**的同名节点不被匹配（含新增的设置直接子节点隐藏规则）。
- 现有 `mrfw-fs*` / `mrfw-ft*` 规则断言保持不变（只新增守卫与设置浮层直接子节点隐藏）。

**焦点交接**：原生 body（`tabIndex=-1`）持有焦点时接管 → 复刻 body 获得焦点。三条：preview（seat 存在，
有 pane 包装）、preview（seat 缺席，直挂）、**Files 页（seat 存在，pane 包装的 rc.2+ 路径）**；后两者
证明 `closest()` 容器查找对旧路径不变、对被包装的 Files 页恢复交接。

**回归套件**：`client-files.spec.tsx`、`client-switcher.spec.tsx`、`client-search-state.spec.ts`、
`client-search-preferences.spec.ts`、**`client-search-ownership.spec.ts`**（pane 死亡清理记录在它里面）、
`client-bundle.spec.ts`（无新外部 import）、`client-files-page-notice.spec` 等。

**无 Host 测试新增**：实现 PR 的 **Host 侧** diff 必须为空（`src/contract.ts`、`src/files-search.ts`、
`src/workspace-files.ts`、`src/command.ts`、`src/registry.ts`、`src/scope.ts`、`src/index.ts` 的 Host 半部，
以及 **Host 侧** `src/compat/*` 如 `workspace-files.ts`/`fs-patch.ts`）；**client 侧** `src/compat/files-tree.ts`
的 `currentRef` 条件透传是允许的（assigned P1）。`tests/command.spec.ts`/`tests/contract.spec.ts`/
`tests/workspace-routing.spec.ts` 保持全绿即可。

### D9 文档

- ADR-0043（本计划的决策）与 ADR-0041 的 D4 修订：按仓库惯例（ADR-0008/0015 的 Amendment 段）在 ADR-0041
  末尾**追加**带日期的"修订：预览导航器搜索由 ADR-0043 补齐（2026-11-16，Amendment）"小节，保留
  **Accepted** 状态与 D4 原文，只在修订段标注其"预览导航器不获得搜索"一条已被 ADR-0043 取代；
  不重写已接受的决策。
- README.md/en.md：功能条目与"两个已知边界"段（第 361/359 行附近）改为新事实；**现行事实**不再声称
  预览导航树无搜索（历史计划/CHANGELOG/旧 ADR 原文合法保留旧事实）。
- `docs/architecture/multi-root-workspace.md` §7 的 Files 搜索段与预览导航接管段；requirements 的 UI/已知限制段。
- `docs/reference/dsh-0.2.2-migration.md` 的 `## 附加根 Files 视图消费的两个接口面（2026-11-14）`：新增
  "第三个接口面：预览导航搜索" 子节；标题里的"两个"要么保留并加子节（不改锚点），要么改为不带数字并同步
  两处入站锚点（`.agent/note/dsh-compat-contract.md` / `.en.md` 用 `#附加根-files-视图消费的两个接口面2026-11-14`）。
  `docs:check` 不校验 `#anchor`，改名时必须手工 grep 两处 note 并更新。**历史表行不修改**：新增子节里
  声明“rc.2 表格中‘接管时原生搜索条隐藏’是当时结论，已被本子节的预览导航搜索取代”，与 P4 的历史豁免一致。
- `src/client/files-tree/FORK.md`：Intentional deltas（preview 模式、current 可选 ref、焦点交接范围、
  设置草稿随根清理与结果态 release 的已知差异）、What upstream keeps owning（原生栏不再在"完全隐藏"语义下）、
  Search surface sync obligations（navigator 映射，并把现有"deliberately NOT the `data-files-search*` hooks"
  一句改成准确事实：pane 沿用 `data-files-search-status/settings/...`，仅不写精确的 `data-files-search`）、
  Sync procedure 第 9/10 步措辞（含隐藏规则守卫的同步检查）。
- `.agent/note/dsh-compat-contract.md` / `.en.md`：两处已知边界段、DOM 钩子表（`data-files-search*` 与
  `data-mrfw-files-pane` 守卫）、人工目检清单（附加根预览搜索的 3 个状态）。
- 索引：`docs/decisions/README.md`、`docs/decisions/README.en.md`（ADR-0043）；`docs/plans/README.md`、
  `docs/plans/README.en.md`（本计划）；CHANGELOG 留到发版准备。

## Implementation

> 每阶段一个可独立 review 的提交；实现与测试同提交，文档最后一批。阶段门禁全绿才进入下一阶段。
> P0 已作为独立的第一笔 `docs(adr)` 提交入库（不混入 P1 代码提交）；P1–P4 已完成，P5 执行中。

### P0 文档（本次交付）

- 产物：`docs/decisions/ADR-0043-additional-root-preview-navigator-search.md`、本计划、
  `docs/decisions/README.md`/`README.en.md` 与 `docs/plans/README.md`/`README.en.md` 索引、进度账本行。
- 本次不写代码、不提交；评审通过后以 `docs(adr): propose additional-root preview navigator search`
  作为第一笔提交入库。
- 退出：`pnpm docs:check` 0 error；ADR 名称/编号合法、链接可解析；计划与 ADR 互链。

### P1 `FilesPane` preview 模式（纯客户端，可独立 review）

- 提交草案：`feat(client): add a preview mode to the additional-root search pane`；F1 可拆成同一阶段的
  独立提交 `fix(client): key the Files-page search by the takeover root`（便于单独 review/回滚）。
- 改动：`pane.tsx`（mode/previewPath/barOpen/自动聚焦/设置回焦/marker/当前行/stops 扩展/草稿清理）、
  `RootSwitcher.tsx`（`Takeover` 补 `rootId`，`searchKey`/`rootId` 都从 takeover 读取——F1 修复）、
  `tree-view.tsx`（`current.ref` 可选）、`compat/files-tree.ts`（`currentRef` 条件透传）。P1 不动 `styles.ts`
  （marker 属性只是 DOM 标记，隐藏规则由 P3 统一加守卫）。
- 测试：D8 的 pane 单测 1–10 + page 回归 + `client-switcher` 过渡帧用例（F1）。
- 退出：focused vitest（`client-search`、`client-search-state`、`client-files`、`client-switcher`）全绿；
  `pnpm lint` / `pnpm typecheck` 绿；`RootSwitcher` 过渡帧用例证明 A→B 不出现错配请求、A 不遗留 pending；
  `git diff` 的 page 面只允许**显式共享对齐清单**：设置关闭回焦 magnifier、
  Up/Down stops 覆盖列出的树行、设置草稿随 `stateKey` 清理（三项行为对齐）与 `data-mrfw-files-pane`
  纯 DOM 标记；分别由 D8 pane 用例 5/7/8/13 钉住，不得出现清单外的 page 行为变化。

### P2 导航接管接线

- 提交草案：`feat(client): search the additional root from the preview navigator`
- 改动：`navigator.tsx`（`takeover` 记录扩为 `{ signal, paneId, root, rootId }` 并原子落定；seat 分支、
  stateKey/openFileIn/previewPath/describeFailure）、`src/client/index.ts`（构造并传 describeFailure）、
  新增或抽出共享的 `describeSearchFailure` helper（`RootSwitcher` 与 navigator 共用）、必要时 `pane.tsx` 的导出类型。
- 测试：D8 的 navigator 1–16（含 seat 缺席回归 11；15 依赖 P1 的 stops 扩展，16 是本阶段 describeFailure 接线）。
- 退出：`pnpm exec vitest run tests/client-navigator.spec.tsx tests/client-search.spec.tsx` 全绿；
  旧 seat 缺席用例逐项保持；Host 侧 `git diff` 为空。

### P3 焦点交接 + CSS 守卫

- 提交草案：`fix(client): hand focus to the forked preview tree and guard the native search hide rule`
- 改动：`FilesTree.tsx`（容器内查找原生 body）、`styles.ts`（`:not([data-mrfw-files-pane])`）、
  `tests/client-styles.spec.ts`、焦点交接测试。
- 退出：styles 套件 + navigator/files 相关套件全绿；隐藏规则在"有/无 marker"两种 DOM 上断言正确；
  无新样式规则（除非守卫本身）。

### P4 文档与证据

- 提交草案：`docs: document additional-root preview navigator search`
- 产物：D9 的全部文档更新、ADR-0041 追加修订、FORK.md、进度账本状态/证据、本计划「进度与证据」。
- 退出：`pnpm docs:check` 0 error；`git diff --check`；**current-state 文档**（README、architecture §7、
  requirements 已知限制、FORK.md、migration reference、compat note）不再把"预览导航树无搜索"写成现行事实；
  历史文档（completed plans、CHANGELOG、ADR-0041 原文）豁免。

### P5 全门禁 + 实机目检 + CI

- 命令顺序：`pnpm lint` → `pnpm typecheck` → `pnpm build` → focused vitest（P1–P3 全部文件）→
  `pnpm compat:check` → `pnpm docs:check` → `pnpm pack:check` → `pnpm verify:all`（含 kernel:probe、
  完整 test、三项 smoke、smoke:packed、auto-review fork 与 smoke:auto-review；本机受限项按既有
  "已知本地环境限制"记录，CI 拥有最终信号）。若某门禁与本次客户端改动无关而本机不可跑，必须写明理由与基线证据。
- **实机目检**（开发树 DSH web，注册一个附加根）：
  1. 预览主根文件 → 原生搜索栏/结果/键盘不变；
  2. 预览附加根文件 → 搜索栏常显、输入出结果、命中高亮、计数、眼睛、设置、失败重试；
  3. 结果行打开文件 → 预览原位替换（replaceTab），树与搜索记录随 pane 保留；
  4. 关闭/打开 Folder、拖动/浮动/窄屏 fill 模式 → 插件搜索面填满 aside 且不遮挡 resize 手柄与设置浮层；
     记录已知既有 delta（push/overlay 的 scrollbar-track 圆角内缩只作用于宿主类），不按像素 parity 判失败；
  5. 切回主根文件 → 原生搜索恢复，插件面消失；
  6. Escape：设置 → 清查询 → 关导航树的顺序正确（上游 document 监听真实行为）。
  目检证据（截图/命令）写入「进度与证据」。
- CI：releases + 24 版本 × image 矩阵 + gate 全绿后记录 run URL（实现 PR 阶段；本次不创建 PR）。

## Validation（总验收标准）

1. **A1 入口与根**：附加根文件预览、Folder 打开时，右侧树出现与主根一致的搜索栏（恒显）；输入触发
   `search` 端点，payload 的 `rootId` 是**当前被预览文件所属的附加根**，`query` 去首尾空白；筛选值来自该根
   的偏好（无存储偏好时是默认规则、`includeHidden=false`、`respectGitignore=true`，有存储偏好时以存储为准）。
2. **A2 结果与打开**：结果树全展开、命中 `<mark>`、状态行计数；空结果 hint、截断、不完整、失败 + Retry
   与 Files 页一致；点击结果行以 `replaceTab` 打开，不替换成主根同名文件。
3. **A3 当前行**：结果包含被预览文件时该行标当前——legacy 行是 `data-files-current`+`aria-current`，
   Factory 路径是宿主 `.current`/`aria-current` 且输入含 `current`；不命中/根外无标记；不自动滚动。
   清查询后树体恢复，reveal 按既有 seed 规则继续（已完成 walk 的文件不重滚，恢复的是保存的 scrollTop）。
4. **A4 隐藏项**：默认隐藏 dotfile（与原生 eye 默认一致）；打开 eye 后树与搜索都包含；偏好按附加根写入
   宿主同名 localStorage 键，重启/重开保留。
5. **A5 键盘与 a11y**：Up/Down 的 stops 覆盖输入、列出的树行与结果行（Down 进首行、首行 Up 回输入，
   page 与 preview 都成立）；Esc 先关设置、再清查询、空查询不拦截（上游可关导航树）；设置关闭回焦 magnifier；
   `aria-live` 状态行与 `aria-pressed` eye 与原生结构一致。
6. **A6 生命周期**：关闭/重开 Folder、`replaceTab` 打开文件后返回：查询/结果/展开/滚动保留且**不新增搜索请求**
   （请求身份命中；清空 query 后的目录 list/watch 重开是接受偏差）；设置草稿在根切换时丢弃、不在新根落盘；
   pane 死亡清理该 pane 记录；根 A/B 切换不串状态；根被撤/扣留时下一次搜索稳定失败并可重试；同路径
   移除后以新 `rootId` 重加时，Retry 会持续 `not-found`，需关闭/重开 Folder 才重新解析（D3 已知边界）。
7. **A7 兼容与降级**：有面板通道但 seat 缺席（`alpha.3`–`rc.1`、裁剪组合）时预览接管的 DOM 与生命周期不变、
   隐藏规则行为不变（新增守卫不匹配旧 DOM）；无面板通道时全程原生、不接管；主根文件在任何宿主上原生搜索
   零变化；< `alpha.3` 无 occupant；不新增依赖、peer 与支持矩阵不变。
8. **A8 Host 零改动**：实现 PR 的 `src/contract.ts`/`src/files-search.ts`/`src/workspace-files.ts`/
   `src/command.ts`/registry/scope 与支持矩阵 diff 为空；`tests/command.spec.ts`/`tests/contract.spec.ts`/
   `tests/workspace-routing.spec.ts` 全绿。
9. **A9 门禁**：`pnpm lint`/`typecheck`/`build`/focused vitest/`compat:check`/`docs:check`/
   `pack:check` 本机通过；全量 `test` 与三 smoke 按既有本地环境限制记录（authority/lease 家族基线同因），
   CI 非沙箱 runner 全绿（实现 PR 阶段）。
10. **A10 文档**：ADR-0043、ADR-0041 追加修订、README 双语、architecture/requirements、migration reference
    （含第三个接口面子节/锚点）、FORK.md、compat note 双语（含入站锚点）、索引与账本全部同步；`docs:check`
    0 error；**现行事实**中不再有"预览导航树无搜索"（历史文档豁免）。
11. **A11 Files 页换根过渡帧（F1 修复）**：非空 query 下切根不产生错配搜索请求；被切走的根记录不遗留
    `pending`；切回/切到新根后状态行按各自记录正确结算；失败结果不被切换窗口清成无限 pending。

## Risks and mitigations

| 风险 | 缓解 |
| --- | --- |
| `FilesPane` 模式分支回归 Files 页 | 默认 `'page'`；page 用例全量回归；page 面只允许三项行为对齐（设置回焦、
  Up/Down stops、草稿随 `stateKey` 清理）与纯 DOM 的 pane marker，测试分别钉住 |
| 隐藏规则误伤插件搜索面（自嵌套/未来复用 `data-files-search*`） | `:not([data-mrfw-files-pane])` 守卫 + marker + styles 套件用 `matches()` 断言原生/插件两侧 |
| pane 包装导致焦点交接静默失效 | 容器内查找 + 焦点交接测试；seat 缺席路径不包装 |
| 关闭设置回焦变化引发行为回归 | 原生语义；两个模式各一条测试；无明显用户依赖（现有用例无焦点断言） |
| 旧宿主行为漂移 | seat 缺席路径保持今天 `FilesTree` portal；`client-bundle` 无新 import；`compat:check` 不变 |
| 搜索记录串 pane/串根 | 键 `(paneId, root)`；D8 用例 9/10/12 覆盖关开、remount、根切换、pane 死亡 |
| `RootSwitcher` 修复引入 Files 页换根回归 | 只把 `rootId` 并入 takeover、`searchKey`/`rootId` 改读 takeover；保留 `selected` 对菜单/标签的显示职责；client-switcher 既有用例全量回归 + F1 过渡帧用例 |
| 根切换/list 失败的过渡帧错键或崩溃（P0，两个 owner） | 预览 `takeover` 与 Files 页 `RootSwitcher.Takeover` 都同时携带 `rootId` 与 `root`，同一 state 提交；过渡帧只渲染完整旧根或空；D8 用例 10 与 `client-switcher` 用例分别断错配请求与 pending 泄漏 |
| 设置草稿跨根串写 | `stateKey` 变化时清空草稿（不提交）；D8 pane 用例 8 断言 B 根偏好不变 |
| 结果视图卸载树体、结束 hold（清 query 重开 list/watch） | 接受的偏差：store bucket 与已列行保留、ready level 的 loading 为 no-op、不闪 loading；A6/D8 只断言搜索请求不重复，不断言目录请求 |
| 隐藏规则守卫被误认为“今天会误伤”或上游改成后代选择器后失效 | ADR D6 写明守卫是防御性、现状本不误伤；FORK.md 同步清单记录 `data-files-search*` 钩子与守卫；styles 套件双向 `matches()` 断言 |
| 预览侧 aside 布局（push/overlay/fill、窄屏、浮动）与原生不一致 | 不新增视觉规则，pane 复用已按原生列上下文写的 `mrfw-fsPane`；P5 实机目检 6 个形态；已知既有 delta：push/overlay 下原生 `.body` 的 scrollbar-track 圆角内缩只作用于宿主类，复刻 `mrfw-ftBody` 保持 2px，不按像素 parity 判失败 |
| Escape 冒泡在真实 React/浏览器与 jsdom 不同 | 空 query 不拦截的单元断言 + 实机目检验证"第二次 Esc 关导航树" |
| 上游搜索语义随 release 漂移 | 支持矩阵不变（止于 rc.3）；FORK.md 第 9/10 步把 navigator search half 纳入同步义务；升版时 diff |
| 端点/授权面被无意扩大 | 不改 wire；实现 PR 检查 Host diff 为空；失败码与既有端点一致 |
| 用户对"默认隐藏 dotfile"的观感反馈 | 这是与原生 rc.2+ 预览一致的行为；README 记录；eye 可恢复 |

**回滚**：恢复 `navigator.tsx` 的 seat 分支为只画 `FilesTree`（`takeover` 去掉 `rootId`），移除 `FilesPane` 的
`mode` / `previewPath` 分支与 styles 守卫即可回到 v0.1.20 行为。共享对齐修正（设置回焦、Up/Down stops、
草稿清理）、`RootSwitcher` 过渡帧修复（恢复旧 `Takeover` 形状与 `selectedId` 接线）、焦点交接与
`TreeView.current.ref` 可选是独立修复，可以保留或单独回退。无数据迁移、无协议变化；
搜索偏好沿用宿主同名 localStorage 键，删除代码不影响原生读取。

## Documentation Impact

- 新增：`docs/decisions/ADR-0043-additional-root-preview-navigator-search.md`、本计划；
  `docs/decisions/README.md`/`README.en.md` 与 `docs/plans/README.md`/`README.en.md` 索引、进度账本行。
- 修订：`ADR-0041`（**追加** D4 修订小节，不重写原文）、`README.md`/`README.en.md`（功能条目 + 已知边界）、
  `docs/architecture/multi-root-workspace.md` §7、`docs/requirements/multi-root-workspace.md`（UI 与已知限制）、
  `docs/reference/dsh-0.2.2-migration.md`（第三个接口面子节；若改标题需同步两处 note 锚点）、
  `src/client/files-tree/FORK.md`、
  `.agent/note/dsh-compat-contract.md`/`.en.md`（含入站锚点）、
  `docs/troubleshooting/files-switcher-degraded.md`（确认无需新增症状，或补一行守卫说明）、进度总账。
- 发版准备（不在本计划内执行）：`CHANGELOG.md`/`CHANGELOG.en.md`（需包含 Files 页既有行为变化：Up/Down
  焦点进入列出的树行、设置关闭回焦 magnifier，以及 `RootSwitcher` 换根搜索错配/永久 pending 的缺陷修复）
  与 `AGENTS.md` 的版本叙事/当前状态段；本计划与 ADR 不预写版本号。

## Completion Criteria

1. A1–A11 全部落地为可执行测试或目检证据并通过（实现阶段）。
2. 实现 PR 的 Host 侧与支持矩阵 diff 为空；**旧宿主**（< `0.2.2-alpha.3` 无 occupant；`alpha.3`–`rc.1`、
   以及裁掉 search 服务的组合）行为不变；`rc.2+` Files 页的设置回焦/Up-Down stops/草稿清理与
   `RootSwitcher` 过渡帧缺陷修复属有意共享变更、不在“零变化”承诺内；主根行为零变化。
3. `pnpm lint`/`typecheck`/`build`/focused vitest/`compat:check`/`docs:check`/`pack:check`
   本机通过；全量 `test`/smoke 与 CI 按仓库规则记录（本地受限项注明基线同因）。
4. 文档全套同步，`docs:check` 0 error；**current-state 文档**不再把"预览导航树没有搜索"写成现行事实
   （历史计划/CHANGELOG/旧 ADR 原文豁免）。
5. ADR-0043 已 Accepted（2026-11-16 外部技术评审有条件通过；F1–F3 已并入 ADR 与本计划），P1+ 可执行；
   实施若偏离 ADR，先回到评审更新 ADR，而不是静默改设计。

## 进度与证据

| 阶段 | 状态 | 提交 | 证据（命令/结果） |
| --- | --- | --- | --- |
| P0 | 已完成 | `2265702` | ADR-0043 + 本计划 + 四个索引条目 + 进度账本行；`node scripts/check-docs.mjs` → 0 errors / 0 warnings（2026-11-16）；外部技术评审有条件通过，F1–F3 修订记录见文末 |
| P1 | 已完成 | `324e7c5`（F1 换根修复）+ `d006203`（preview 模式） | focused vitest：`client-search` 27、`client-search-state` 7、`client-files` 17、`client-switcher` 32（含新增换根过渡帧用例）全绿；`pnpm lint` 0 warnings / 0 errors、`pnpm typecheck` 通过；Files 页面只含共享对齐清单与 `data-mrfw-files-pane` 标记 |
| P2 | 已完成 | `8a5e38d` | `tests/client-navigator.spec.tsx` 36（24 既有 + 12 新）全绿，seat 缺席路径逐项回归；`pnpm typecheck` / `pnpm lint` 通过；Host 侧 diff 为空 |
| P3 | 已完成 | `d695ba8` | `client-files` 20、`client-styles` 44、`client-navigator` 38 全绿；styles 双向 `matches()`（原生直接子节点匹配、插件嵌套节点不匹配）；焦点交接三形态（preview 有/无 pane 包装、Files 页包装、旧直挂） |
| P4 | 已完成 | （本提交 `docs: document additional-root preview navigator search`） | ADR-0041 Amendment、ADR-0043 状态、README 双语、architecture §7、requirements、migration reference 第三接口面、FORK.md、compat note 双语、troubleshooting；`node scripts/check-docs.mjs` → 0 errors / 0 warnings |
| P5 | 本机门禁 + 隔离环境交互目检完成 | — | 见下节「P5 执行记录」：lint/typecheck/build/focused/compat/docs/pack 全绿；`pnpm test` 1871/165/17（17 个基线同因）；三项 smoke 与 packed、auto-review 全绿；`verify:all` 在完整 test 处因基线同因中止；隔离 scratch `$DSH_HOME` + 真实 `dsh web` + Chrome/CDP 的交互目检覆盖全部检查项并截图 20 张 |

### P5 执行记录（命令与结果）

2026-11-16 本机（macOS，DSH 会话自身运行在 Seatbelt 内）按计划顺序执行：

| 命令 | 结果 |
| --- | --- |
| `pnpm lint` | 0 warnings / 0 errors（347 files） |
| `pnpm typecheck` | 通过（host + client 双端，含 auto-review 源码生成） |
| `pnpm build` | 通过（types + bundle；client bundle 2 files / 1.94 MB） |
| focused vitest（P1–P3 七个套件 + `client-search-preferences`） | 193 passed / 0 failed |
| `pnpm compat:check` | allowlist、peerDependencies、dev pin、安装树一致（DSH `0.2.2-rc.3`，24 个精确版本） |
| `pnpm docs:check` | 0 errors / 0 warnings |
| `pnpm pack:check` | packed artifact 完整 |
| `pnpm kernel:probe` | exit 0；seatbelt runner-failed（`sandbox_apply: Operation not permitted`）、bwrap/landlock unavailable → 受限执行断言按既有基线 skip |
| `pnpm test` | **1871 passed / 165 skipped / 17 failed**；17 个失败全部是本机既有基线同因（共享 authority 的内核 IPC / sandboxed-peer 家族：`authority-boundaries` 2、`b9-review-regressions` 1、`registry-lease` 4、`registry-multiprocess.e2e` 3、`registry-operation` 1、`registry.spec` 3、`skills-authority` 2、`skills-registry` 1）；本次改动只触及 client 与文档，未改这些模块 |
| `pnpm smoke` | compose **56/0/0**；behavior **96/0/8**（skip：受限 bash 与共享 IPC）；journey **88/0/2**（web 腿真实启动 `dsh web` 并注册附加根；skip：本机无内核 runner） |
| `pnpm smoke:packed` | **95 passed / 0 failed / 8 skipped**；tarball 经真实 `dsh plugin add` 安装后跑完整 behavior battery |
| `pnpm auto-review:fork` | baselines、上游 hash、显式 delta、策略、身份、角色、协议与 owner teardown 全部验证 |
| `pnpm smoke:auto-review` | headless/web × 双 bundle order 全部通过（单行开关、重复 reload、owner drain、官方恢复） |
| `pnpm verify:all` | lint → typecheck → build → kernel:probe 通过；在完整 `pnpm test` 处因上述 17 个基线同因失败中止（与此前发布验收记录同因；CI 非沙箱 runner 是最终信号） |

**Host 侧 diff 为空**：`git diff 53ae34d..HEAD -- src/contract.ts src/files-search.ts src/workspace-files.ts src/command.ts src/registry.ts src/scope.ts src/index.ts src/compat/workspace-files.ts src/compat/fs-patch.ts src/compat/dsh-version.ts package.json cordis.patch.yml` 无输出；`src/compat/files-tree.ts` 的 `currentRef` 条件透传属计划允许的 client 侧改动。

**实机交互目检（2026-11-16，隔离环境完成）**：用 scratch `$DSH_HOME`（不触碰真实用户 profile）+ 真实 `dsh web` + 本机 Google Chrome（headless，CDP 驱动）搭起可交互目检装置——脚本化模型端点驱动一轮真实 turn 生成 GUI 可见会话、经 `/workspace-folders add` 注册附加根，然后在真实浏览器里逐项操作并截图 20 张（`.dsh-smoke/gui/shots/`，本机证据，不入库）。逐项结果：

- 附加根预览常显搜索栏（`03`）：aside 内为插件 pane，原生栏仍在 DOM 被隐藏；输入 `alpha` → 1 个结果、命中 `<mark>alpha</mark>`、状态行「1 个结果」、Factory 路径 `aria-current` 标当前文件（`04`）。
- 设置浮层（`05`）：排除规则、尊重 `.gitignore` 开关、空白添加项齐全；Esc 关闭后焦点回到 magnifier、查询保留（`06`）。
- Esc 顺序：设置 → 清查询（`07`，树与当前行恢复）→ 关导航树（`08`，aside 消失、原生布局恢复）。
- `replaceTab`（`09`）：点击结果行 `beta-notes.md` 后预览 tab 原位更替（tab 数量不变），插件 pane 与查询保留。
- Folder 关闭/重开（`10`）：查询 `beta`、结果、当前行、无 pending 全部保留（`replaceTab` 后同 pane 记录仍命中）。
- eye（`11`/`19`）：默认隐藏 `.git`；开启后列出的树出现 `.git` 且查询/结果保留；偏好按根保存。
- 布局：窄屏 900×760（`12`）、全屏（`13`）、浮动 pane（`14`/`15`，拖动预览 tab 生成 `data-dockkit-float`，浮动内 Folder 正常展开且搜索面可用）均正确。
- 失败与重试（`16`/`17`）：移走附加根目录 → 本地化失败行「该目录当前不可用，只能设为只读；请先恢复目录再调整权限。」+「重试」；恢复目录后点重试 → 「1 个结果」gamma.md。
- 主根对照（`18`）：主根 README 预览的 aside 不带 `data-mrfw-navigator`、无插件 pane，原生搜索栏可见且布局不变——切回主根恢复原生。
- 已知偏差复核：移除根后重新登记会得到新 `rootId`，旧 rootId 上的「重试」持续 `not-found`（提示「没有找到对应的登记项」），关闭/重开 Folder 后重新解析并恢复；与需求文档已记录的边界一致。

截图供维护者目视复核；本计划保持在 `active/`。

### 本次会话的版本与代码事实核对（P0 证据）

- 上游：`git log -1 --format='%ci %h' dsh-v0.2.2-rc.2` → `2026-11-11 10:32:18 +0800 ddac96760b`；npm registry 的
  `0.2.2-rc.2` 发布时间为 2026-11-12T02:13:08Z；
  `git diff --stat dsh-v0.2.2-rc.2 dsh-v0.2.2-rc.3 -- packages/client/ui-sidebar-files/src ...` → 空；
  搜索引入提交 `2d463af8d2`（PR #7365，2026-11-07）。
- 插件：`main` @ `53ae34d` 的 `FilesPane`/`NavigatorRetarget`/`styles.ts`/`search-state.ts`/
  `FilesTree` 与本文代码地图一致（只读核对，未修改）。
- 文档门禁：`node scripts/check-docs.mjs`（`pnpm docs:check` 的稳定逻辑入口）→ 10 项全 PASS、
  `0 errors, 0 warnings`（2026-11-16，本次会话）。
- 外部技术评审（2026-11-16）：**有条件通过**；条件 F1（RootSwitcher 存在同型过渡帧缺陷，须纳入修复，
  已写入 D2/P1/A11 与 client-switcher 测试）、F2（P2 测试范围写全 1–16）、F3（D2 危害主次：错配请求/记录串写
  为主、崩溃为次）均已并入 ADR 与本计划；ADR Status 据此由 Proposed 改为 Accepted。
