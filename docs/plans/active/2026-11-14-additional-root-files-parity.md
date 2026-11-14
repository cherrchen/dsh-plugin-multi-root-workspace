# 附加根 Files 树与主根原生 File 完全对齐（行右键菜单 + 工作区搜索）

> 状态：进行中（2026-11-14）。本文件既是开发计划也是执行账本：每阶段结束把命令与结果写入 §7。
>
> 关联文档：`docs/decisions/ADR-0015-files-tab-plugin-owned-browsing.md`、`docs/decisions/ADR-0016-files-tab-native-tree-fork.md`、
> `src/client/files-tree/FORK.md`、`docs/reference/dsh-0.2.2-migration.md`。

## Goal

让"附加根（additional root）"在右侧 Files 视图里的树与 DSH 主根原生 File 树在功能层面完全一致。本轮补齐
上游 0.2.2 线新增、而本插件从未转发/从未实现的两类交互：

1. **行级鼠标右键菜单**（文件行、目录行、预览导航器树）：菜单项、禁用态、执行语义与主根一致，且作用于附加根内的真实路径；
2. **工作区搜索（FileSearch）**：搜索钮、搜索栏、结果树、命中高亮、排除规则/隐藏项/`.gitignore` 开关、空结果提示、
   截断/不完整提示、失败重试、键盘操作，搜索根为当前选中的附加根而非 Session cwd。

同时补齐与搜索同批（0.2.2-rc.2）引入、影响树本身的**隐藏项过滤**（`showHidden` 默认隐藏 dotfile，目录"只有隐藏项"提示）。

硬约束：
- 不修改任何上游仓库/包（ADR-0002）；不新增上游运行时 import；新客户端依赖一律走结构探测。
- **不在老版本 DSH 宿主上引入新版本行为**：所有新交互由结构探测门控；旧宿主上附加根视图与今天完全一致。
- 外观走宿主 CSS token 与插件类名（ADR-0006），文案走上游 `sidebarFiles` 活词典（i18n 规则）。

## Background

### 上游事实（24 个受支持 release 的逐 tag 审计）

| 面 | 最早版本 | 形状/备注 |
| --- | --- | --- |
| `ui-context-menu` + `ctx.contextMenus` + 根级 `useContextMenu` + `getTriggerProps` + `file`/`directory` target | 0.2.2-alpha.3 | rc.2 追加 `registeredKinds`/`contextMenu.button`（可选探测） |
| `sidebar.files.tree` Factory（`rowTriggerProps`/`canOpen`/`current`/accessory） | 0.2.2-alpha.3 | 无更早分支；此前的树是 FilesBody 内联 |
| `FileTreeInput.highlight`、`TreeDirectoryState.omitted` | 0.2.2-rc.2 | 与 search 同批 |
| `workspaceFiles.search` | 0.2.2-rc.2 | request `{query,excludedPaths,includeHidden,respectGitignore}` → `{matches[{path,type}],truncated,incomplete}`；host 需 subprocess/ripgrep；限额 maxResults 512 / maxEntries 100000 / timeout 30s |
| `ui-open-in-app` 的 `file`/`directory` 右键项、`ui-file-actions` 的 `file` 右键项 | 0.2.2-alpha.3 | 均以 `workspaceFiles.stat` 解析绝对路径（插件已按绝对路径路由） |
| 搜索 DOM 钩子（`data-files-search*`/`data-files-view`/`search-*` 笔记行） | 0.2.2-rc.2 | 仅 rc.2+ 存在 |
| rc.2 → rc.3 | — | 这些面零改动（只有 package.json bump） |

结论：只需两个结构门控——**Factory + `useContextMenu`（alpha.3+）** 与 **`workspaceFiles.search`（rc.2+）**。
但注意：`renderFactorySlot` 自 0.1.6-alpha.2 就存在，**不能**用它判断 Factory 是否存在；插件现在用
`pane.hasAttribute('data-files-page')` 这一 alpha.3+ 的 DOM 钩子做版本分界，本轮沿用。

### 插件现状

- Files 页：`src/client/index.ts` 在 `sidebar.right.tab.files.actions` 注册 `RootSwitcher`；选中附加根后把
  `FilesTree` portal 到 `[data-files-page]`，`src/client/styles.ts` 用 `:has([data-root-kind="additional"])`
  隐藏原生 `[data-files-content]`/`[data-files-reload]`/原生 open-in-app 目录按钮与（rc.2 起）原生搜索条/开关。
- 文档预览：`src/client/files-tree/navigator.tsx` 在 `aside[data-files-navigator]` 上标记 `data-mrfw-navigator`，
  隐藏原生 body 并 portal 同一 `FilesTree`；reveal、replace-tab 打开、按 pane 的记忆已复刻。
- 数据面：附加根目录树走上游 `workspaceFiles.list/changes`（host `src/workspace-files.ts` 按绝对路径路由、按
  Registry 准入与"登记但被扣留"边界拒绝）；打开文件用 `fileAddressFor(sessionId, undefined, absolutePath)`。
- 树渲染两条路径：宿主 Factory（`src/compat/files-tree.ts` 的 `nativeTreeInput` 构造输入）与旧宿主逐字节复刻行。
  当前 `nativeTreeInput` 只传 `root/entries/directories/expanded/current/currentRef/onToggle/onOpen`：
  **`rowTriggerProps`（右键）、`canOpen`、`highlight`/`omitted`（搜索）从未转发**，这就是附加根缺右键与高亮的直接原因。
- 搜索：host 已把 `workspaceFiles.search` 纳入准入与扣留边界，但**不路由**（上游 search 根固定为 Session cwd；
  `src/workspace-files.ts` 注释明确"插件不提供附加根搜索 UI"）；客户端把原生搜索条/开关在接管期整体隐藏。
  根因是**传输缺口**（上游 wire 无 root 字段）+ **UI 缺口**，不是样式问题。

## Scope

- 右键菜单：Factory 输入转发（`rowTriggerProps`）、target 构造（绝对路径，file/directory）、`canOpen`、
  旧行渲染路径的同款转发；Files 页与文档预览 retarget 两个挂载点。
- 搜索传输：`contract.ts` 新增 `search` 端点（request `rootId/query/excludedPaths/includeHidden/respectGitignore`、
  response `SearchView`）；host 新模块 `src/files-search.ts`（会话派生权威 + 刷新 registry 解析 rootId + 授权 + 准入）；
  `src/workspace-files.ts` 的 search 专用包装（单次准入、路由校验、撤销后置检查）；`src/compat/workspace-files.ts` 结构探测。
- 搜索 UI：插件级偏好书（与上游同 localStorage key/格式）、按 (tab,root) 的状态、搜索栏/结果树/笔记/设置浮层、
  页头搜索钮、键盘操作、隐藏项过滤、样式与 `SidebarFilesKey` 扩展。
- 测试：contract/授权矩阵/host 路由/客户端 UI/兼容降级/主根零变化；文档、ADR、FORK.md、兼容笔记；Draft PR 与 CI 跟踪。

## Non-goals

- 不注册新快捷键、不改上游 `workspace.files` 命令；接管期原生 Cmd+P 仍聚焦被隐藏的原生搜索框（G10 已知边界）。
- 不做预览导航器（文档预览旁 Folder 树）的搜索：其状态由上游 `sidebar.files.navigator` face 的 `focus()` 驱动，
  接管树不参与该 face；单独加会引入与原生不一致的第二入口（G12 已知边界）。
- 不 fork/复制 `SearchSettings` 之外的上游组件，不改上游 store/face。
- 不做 `canOpen` 以外的行外观差异（accessory 槽原生 Files 树自身不使用，不消费）。
- 不改 `SUPPORTED_DSH_RELEASES`、不改 peer/dev pin、不新增 `@deepseek-ai` 依赖（devDep 会在 20 个老版本 lane 安装失败）。
- 不做发版：CHANGELOG 在该版本 release 准备时更新（本 PR 不含），本轮只到 Draft PR + CI 绿。

## Design

### D1 行右键菜单与 canOpen（客户端）

- 采集：`useContextMenu` 是 `ui-context-menu` 通过 `ctx.slots.provideRoot` 提供给**每个 renderer Component** 的
  根级标准 prop（`GlobalStandardProps`），我们的 slot occupant 直接拿到。插件按结构探测：
  `props.useContextMenu` 是函数 → `getTriggerProps = props.useContextMenu().getTriggerProps`；
  类型用本地最小声明（`src/client/files-tree/context-menu.ts`），**不 import 上游包**（删 devDep 风险）。
- 转发：`nativeTreeInput(..., { rowTriggerProps, canOpen })`；Factory 在文件主按钮/目录按钮上展开（上游
  `trigger.ts` 负责 preventDefault、聚焦、键盘 ContextMenu/Shift+F10）。旧行渲染路径同样 spread，保持两个渲染面一致。
- target：`{ kind: 'directory', value: { sessionId, path: <绝对路径> } }` 与
  `{ kind: 'file', value: { sessionId, path: <绝对路径> } }`。绝对路径是承重设计：
  `ui-open-in-app` 的 `resolveWorkspacePath(cwd, path)` 对绝对路径原样返回，`workspaceFiles.stat` 被插件路由到附加根，
  `fileAddressFor(sessionId, cwd, 绝对路径)` 返回携带绝对路径的 session 地址。不传 `paneId`（上游菜单项不使用）。
- 避免空菜单：rc.2+ 有 `contextMenus.registeredKinds` 时仅在对应 kind 已注册时绑定；alpha.3 无此成员时直接绑定
  （该版本原生已注册 file/directory 贡献）。
- `canOpen`：宿主 Factory 输入，由 `ctx.get('sidebarRightTabs').candidates(address)` 计算，用其 `subscribe` 触发重渲染；
  服务缺席（旧宿主）不传。地址用 `fileAddressFor(sessionId, undefined, absolutePath)`。

### D2 搜索传输（host）

上游 `workspaceFiles.search` 的 wire 只有 sessionId，根由 host 从 Session cwd 解析，无法指定附加根。新增插件自有端点
（沿用 ADR-0005 的 Connection RPC 与"每端点一个响应形状"规则；同一 channel `/multi-root-workspace`，不新增 handler/row）：

- `src/contract.ts`：
  - `PanelEndpoint` + `PANEL_ENDPOINTS` 增加 `'search'`；
  - request 字段（`PanelRequest` + 严格 schema + `narrowCall`）：`rootId`（RootView.id，稳定 id 而非路径）、
    `query`、`excludedPaths`、`includeHidden`、`respectGitignore`；
  - response：`SearchView = { root: string; matches: readonly { path: string; type: 'file'|'directory'|'other' }[]; truncated: boolean; incomplete: boolean }`，
    `matches.path` 相对 `root`、'/' 分隔（与上游 wire 同形）；
  - `searchViewSchema` + `parseSearchView`（非严格，允许将来加字段）；
  - `PanelResponseMap.search = SearchView`；
  - `client/panel-client.ts` 的 `expectShape` 改成 switch，增加 search 分支（`assertNever`）。
- `src/files-search.ts`（新 host 模块，`command.ts` case `'search'` 调它）：
  1. `resolvePanelPrimaryRoot(ctx, sessionId)`（ADR-0008，会话派生权威）；
  2. `ctx.multiRootRegistry.refresh(primary)`（与 `list` 相同：应答前重新校验每个登记目录）；
  3. 按 `rootId` 查找登记行，要求 `state === 'available'` 且 `multiRootScope.scopeOf(primary).includes(path)`；
  4. 调 `workspaceFiles.search({ sessionId, workspaceRoot: root, primaryRoot: primary }, request, signal)`
     （`primaryRoot` 是 host 内部标记，仅本端点构造，不上 wire）；
  5. 把上游结果（相对 root）与 `canonicalRoot(root)` 组装成 `SearchView`；错误按 `RootValidationError` 稳定码抛出
     （`invalid-ref`/`not-found`/`root-unavailable`/`search-unavailable`/`session-not-found` 等，客户端已有词表，
     新增 `error.search-unavailable`）。
- `src/workspace-files.ts`：`search` 从通用准入循环移出，改为专用包装（**只准入一次**，避免以附加根为 key 的重复准入）：
  - 普通 wire 调用（无 `primaryRoot` 标记）：维持现状 —— 准入 key = Session cwd，`rootWithheld` 拒绝；
  - 端点路由调用：`root === primary` 或 `scopeOf(primary)` 的**实时**成员才允许；准入 key = primary；
    准入前后各查一次授权，撤销即抛 `workspace-file/outside-workspace`；不把内部标记传给上游。
- 客户端：`panel.call('search', payload, signal)`（已有泛型 call，无需新方法）；`panel-client` 负责解析与
  `PanelError`；失败码走 `errorKeyOf` 回退。
- 取消：`AbortSignal` 一路透传到 rg；上游限额是唯一 deadline；不引入流式。

### D3 搜索 UI 与状态（客户端）

- 状态：inject product（session 域）内新增 `searchState: SnapshotStore<Record<key, SearchState>>`，
  `key = tabId + '\u0000' + root`，经 `hooks` 送达成 `useSearchState`，跨 body 重挂载保留；
  `SearchState = { barOpen, query, pending, result?, expanded[], scrollTop }`。
- 偏好：插件级 `createSearchPreferenceBook(localStorage)`，key/格式与上游相同
  （`dsh.sidebar-files.workspace-search.v1`，按 root 只存与默认值的差异）；默认排除列表（.git、node_modules 等）、
  `showHidden=false`、`respectGitignore=true` 与上游 `search-rules.ts` 逐字一致（复制为插件自有模块）。
- 执行：`SearchPane` effect 在"trim 后 query 非空且（query 或偏好）变化"时发请求，新请求 abort 旧请求；
  settle 仅在仍是当前 controller 时写回；空白 query 结束搜索回树（与上游 `face.ts` 的 `runSearch/settle` 同构）。
- 渲染对齐原生：
  - 结构 `[搜索栏][aria-live 状态行][body(data-files-view=tree|search)][设置浮层]`；
  - 结果树 = 上游 `buildSearchTree` 的等价实现（全展开、祖先合成、命中目录空级 `omitted:'unmatched'`），交给同一个
    `TreeView`（Factory 输入 `highlight=query`；旧路径渲染 `<mark>`）；点击文件用绝对路径打开，点击目录折叠/展开结果级；
  - 树态（非搜索）按 `showHidden` 过滤隐藏项、目录"只有隐藏项"提示（rc.2+ 原生行为，G15）；
  - 笔记：空结果 + 过滤提示（hidden/excluded/ignored 组合）、截断、不完整、失败 + 重试；
  - 键盘：↑/↓ 在搜索框与 body 行之间移动；Esc 清空并回树；设置浮层自持 Esc；
  - 样式 `mrfw-fs*`，只引用 `var(--dsw-*)` token；文案 `t('search.*'/'settings.*')`；
  - 入口：`RootSwitcher` 头部在附加根接管时渲染搜索钮（位置=原生开关位：reload 之后、open-in-app 之前），
    `aria-expanded` 跟随状态；原生 `[data-files-search-toggle]` 保持隐藏。
- 搜索可用性门控：`typeof remote.workspaceFiles.search === 'function'`（rc.2+）；同时 host 端端点/服务缺席时
  返回 `search-unavailable`，客户端按失败呈现而不是误显示结果。

### D4 兼容门控（"不在老宿主引入新版本行为"）

| 能力 | 结构探测 | 缺席时 |
| --- | --- | --- |
| 右键菜单 | composed prop `useContextMenu` 可调用且返回 `getTriggerProps`；rc.2+ 再查 `registeredKinds` | 不绑定、DOM 不变（旧原生同样没有） |
| canOpen | `ctx.get('sidebarRightTabs')` 的 `candidates` 函数 | 不传输入，全部可打开（旧原生语义） |
| 搜索 | `remote.workspaceFiles.search` 为函数（客户端）+ `workspaceFiles.search` 为函数（host 包装内既有探测） | 不渲染搜索钮/栏；不调用端点 |
| 树输入附加项 | `rowTriggerProps`/`highlight`/`omitted` 一律可选传参 | 旧 Factory 忽略未知输入 |
| 隐藏项过滤 | 搜索偏好书仅在搜索面可用时创建 | 不改变旧宿主树 |

所有探测放 `src/compat/`（`workspace-files.ts` 扩展；`files-tree.ts` 输入构造；新增 `context-menu.ts`），
不做版本字符串比较。老 pin 缺的导出按 `src/client/open-in-app/upstream-surface.d.ts` 模式补 ambient 声明（纯类型）；
运行时仍由门控保证不触碰。

## Implementation（阶段 / 提交 / 退出条件 / 验收）

每个阶段一个可独立 review 的提交（实现+测试同提交；文档阶段单独提交）。阶段门禁全部通过才进入下一阶段。

### P0 基线与计划（本文件）

- 提交：`docs(plan): additional-root files parity (context menu + search)`
- 门禁：`pnpm docs:check`；上游事实均有 tag 级证据（`git show/grep dsh-v0.2.2-{alpha.3,rc.1,rc.2,rc.3}`）。
- 验收：G1–G15 每项有"实现/不做+理由"；计划经用户确认。

### P1 行右键菜单 + canOpen（G1/G2/G3/G11/G15 的非搜索部分）

- 提交：`feat(client): row context menus and canOpen for additional-root files`（P2 依赖它无，可先行）
- 改动：`src/compat/files-tree.ts`（输入透传 `rowTriggerProps`/`canOpen`）、新增
  `src/client/files-tree/context-menu.ts`、`adapter.tsx`（surface 增加 `contextMenu`/`canOpen`）、
  `RootSwitcher.tsx`/`navigator.tsx`（把 occupant 的 `useContextMenu` 与 surface 传入）、`FilesTree.tsx`
  （Factory 输入与旧行 spread）。
- 测试：文件/目录右键 target（含绝对路径与会话 id）；无 `useContextMenu` 时 DOM 不变；`registeredKinds` 缺 kind 不绑定；
  `canOpen` 透传与无服务退化；主根零变化（既有 specs 全绿）。
- 门禁：`pnpm exec vitest run tests/client-files.spec.tsx tests/client-switcher.spec.tsx tests/client-navigator.spec.tsx`、
  `pnpm lint`、`pnpm typecheck`、`pnpm build`、`pnpm compat:check`。
- 验收：附加根文件/目录行右键打开与原生一致的菜单且命中正确绝对路径；预览 retarget 同样；旧宿主 DOM/行为不变。

### P2 host 搜索传输（G4–G8 底座）

- 提交：`feat(host): additional-root workspace search endpoint`
- 改动：`src/contract.ts`（`search` 端点/字段/视图/schema/parser/响应映射）、`src/client/panel-client.ts`
  （`expectShape` 分支）、`src/files-search.ts`（新）、`src/command.ts`（case）、`src/workspace-files.ts`
  （search 专用包装）、`src/compat/workspace-files.ts`（探测）、`src/index.ts` 导出类型、`src/client/locales.ts`
  （`error.search-unavailable` 等）。
- 测试（host）：契约合法/非法（多余字段、空 query、缺 rootId、非数组 excludedPaths）；授权矩阵（主根/实时附加根 ✅；
  未登记 ❌；被扣留 ❌；redirect ❌；authority unavailable ❌；未知 session → `session-not-live`/`session-not-found`）；
  `withRegistryRead(primary,'files')` 只准入一次；上游收到 `{sessionId, workspaceRoot: root}` 且无内部标记；
  上游 `workspace-file/search-failed` 透传；旧 host 无 `search` → `search-unavailable`。
- 门禁：`pnpm exec vitest run tests/command*.spec.ts tests/contract*.spec.ts tests/workspace-files*.spec.ts`（按实际文件名）、
  `pnpm lint`、`pnpm typecheck`、`pnpm build`、`pnpm compat:check`、`pnpm kernel:probe`。
- 验收：端点只可能搜索"该 session 主根或其实时附加根"；拒绝矩阵错误码稳定；准入可观察；旧 host 无端点也不影响加载。

### P3 客户端搜索 UI 与状态（G4–G9、G15）

- 提交：`feat(client): workspace search for additional-root files`
- 改动：新增 `search-rules.ts`/`search-tree.ts`/`search-preferences.ts`/`search-state.ts`/
  `search-pane.tsx`/`search-settings.tsx`；`FilesTree.tsx` 抽出 `TreeView`（Factory/旧行共用，支持
  `highlight`/`omitted`/`showHidden` 过滤）；`adapter.tsx`（inject 产品状态/动作/偏好/运行函数，surface.search）；
  `RootSwitcher.tsx`（搜索钮 + 搜索态/树态切换）；`styles.ts`（`mrfw-fs*` 与 `mrfw-ft*` 增补）；
  `locales.ts`（`SidebarFilesKey` 扩展 rc.2 新增 key）；ambient 声明补老 pin 缺项。
- 测试（jsdom）：无 search → 无搜索钮/DOM；有 → 钮开栏聚焦；输入 → 端点 payload 正确（rootId/root/query/偏好），
  连续输入 abort 旧请求只落最后一次，空白回树；结果树全展开、`<mark>`、目录折叠、行点击打开正确绝对地址；
  空结果三提示、截断/不完整、失败+重试；偏好增删/恢复默认/`.gitignore`/`showHidden` 触发重搜并写回 localStorage，
  重挂载保留、不同根互不串扰；键盘 ↑/↓/Esc；`aria-*` 结构；样式门禁（无字面颜色、`mrfw-` 前缀、只引用 token）；
  bundle 门禁（新外部 import 仅既有外部集）。
- 门禁：`pnpm exec vitest run tests/client-files.spec.tsx tests/client-switcher.spec.tsx tests/client-styles.spec.ts tests/client-bundle.spec.ts`、
  `pnpm lint`、`pnpm typecheck`、`pnpm build`、`pnpm pack:check`。
- 验收：rc.2/rc.3 上附加根搜索逐项与主根原生一致（入口/栏/结果/高亮/笔记/失败/偏好/键盘/隐藏项过滤）；
  < rc.2 零可见变化；主根选择零影响。

### P4 预览导航器与边界（G11/G12）

- 提交：`feat(client): context menus in the preview navigator tree; document the search boundary`
- 改动：确认 retarget 的 surface 传递；`styles.ts`/`FORK.md` 注释与 delta 清单更新（右键/canOpen/highlight/omitted、
  原生搜索继续隐藏的理由）。
- 测试：`tests/client-navigator.spec.tsx` retarget 右键 target；原生搜索条仍隐藏、预览无搜索钮。
- 门禁：同 P1 + `tests/client-navigator.spec.tsx`。
- 验收：预览旁附加根树右键与原生一致；搜索边界文档化、可验证。

### P5 文档与 ADR

- 提交：`docs: additional-root files parity (ADR, README, FORK sync)`
- 产物：`ADR-0040-additional-root-workspace-search.md`（端点/授权/兼容/边界/回滚）、
  `ADR-0041-additional-root-row-context-menus.md`（转发/canOpen/绝对路径 target）、`docs/decisions/README.md` 索引、
  `docs/reference/dsh-0.2.2-migration.md` 补充、`README.md`/`README.en.md`（What/Why + Known Limitations + 结构）、
  `docs/architecture/multi-root-workspace.md`、`docs/requirements/multi-root-workspace.md`、
  `src/client/files-tree/FORK.md`（delta 与同步步骤）、`.agent/note/dsh-compat-contract.md`（+.en）结构边界、
  进度总账 `docs/plans/active/2026-09-12-multi-root-workspace.md` 条目、本计划完成时移入 `docs/plans/completed/`。
- 门禁：`pnpm docs:check`、`pnpm lint`、`pnpm compat:check`、`git diff --check`。
- 验收：文档与代码一致、无死链、ADR 编号/索引正确；CHANGELOG 明确留到 release 准备。

### P6 全量门禁 + Draft PR + CI

- 本地：`pnpm lint` → `pnpm typecheck` → `pnpm build` → `pnpm test` → `pnpm compat:check` → `pnpm docs:check` →
  `pnpm pack:check` → `pnpm kernel:probe` → `pnpm registry:probe` → `pnpm smoke:compose` → `pnpm smoke:behavior` →
  `pnpm smoke:journey` → `pnpm smoke:packed`（本机不可执行的项在证据栏注明，交由 CI）。
- 提交/PR：`git push -u origin <branch>` → `gh pr create --draft --base main`（标题/描述按
  `dsh-pr-description` 规范：Why/What/Test/兼容矩阵/边界/回滚；标签 kind/feature + area/client + area/host + area/docs）。
- CI：`gh pr checks --watch` 跟踪 releases/verify/gate 三个 job（24 个支持版本 × 平台矩阵，4 版本/组，42 分钟/版本）；
  失败即修、重跑直至全绿；把最终 run URL 与结论写入 §7 并回报。
- 验收：Draft PR、CI 全绿、无上游文件改动、`git diff --stat` 只含本仓库。

## Validation（总门禁表）

| 门 | 命令 | 何时 |
| --- | --- | --- |
| 静态 | `pnpm lint` | 每阶段 |
| 类型 | `pnpm typecheck` | 每阶段（P2 起必须） |
| 文档 | `pnpm docs:check` | P0/P5/P6 |
| 兼容 | `pnpm compat:check` | 每阶段 |
| 构建 | `pnpm build`（build:types + bundle） | P1/P2/P3/P6 |
| 单测 | `pnpm test` / `pnpm exec vitest run <file>` | 每阶段聚焦；P6 全量 |
| 打包 | `pnpm pack:check`、`pnpm smoke:packed` | P3/P6 |
| 内核 | `pnpm kernel:probe`、`pnpm registry:probe` | P2/P6 |
| 冒烟 | `pnpm smoke:compose/behavior/journey` | P6 + CI |
| CI | releases / verify / gate | P6 |

## Risks and mitigations

| 风险 | 缓解 |
| --- | --- |
| 上游 rc.2 DOM/CSS 漂移 | 自持 `mrfw-fs*` 类名；只读 `[data-files-page]`/`[data-files-navigator]` 两个已复刻钩子；FORK.md 同步清单 |
| 端点扩大攻击面 | 只接受"该 session 主根或其实时附加根"，全部判定在 host；rootId 解析自刷新后的 registry；准入+撤销后置检查；拒绝矩阵测试 |
| 搜索进程资源 | 复用上游限额；cwd 限定在附加根；共享 Host 走 owner 准入 |
| 老宿主安装/编译失败 | 不新增 `@deepseek-ai` 依赖；新外部 import 仅既有外部集；老 pin 缺导出用 ambient 声明；CI 24 版本矩阵验证 |
| 与上游快捷键/状态冲突 | 不注册快捷键、不复用 `data-files-search*` 属性；G10/G12 显式边界 |
| 回归主根 | 新代码只在选择附加根时挂载（`selected !== 'primary'` 分支）；主根既有测试与"主根零变化"断言 |
| 面板协议漂移 | 客户端对响应做 schema 解析（`panel/bad-response`）；未知失败码回退 `error.fallback` |

**回滚**：删除/禁用 search 端点与搜索 UI、去掉 `rowTriggerProps` 转发即可回到 v0.1.19 行为；无数据迁移
（偏好使用上游共用 localStorage 键，删除代码不影响原生读取）。

## Documentation Impact

- 新增 ADR-0040/0041 + 索引；`docs/reference/dsh-0.2.2-migration.md` 补充 alpha.3/rc.2 结构边界；
  `README.md`/`README.en.md`、`docs/architecture`、`docs/requirements`、`src/client/files-tree/FORK.md`、
  `.agent/note/dsh-compat-contract.md`（+.en）；进度总账与本计划归档。
- CHANGELOG 留到该版本 release 准备提交。

## Completion Criteria

1. 附加根 Files 树的右键菜单（文件/目录/预览导航器）与主根原生一致，target 指向附加根真实绝对路径。
2. 附加根 Files 页具备与主根一致的搜索（入口/栏/结果/高亮/笔记/失败/偏好/键盘/隐藏项过滤），搜索根为选中附加根。
3. 未授权/被扣留/重定向/不可用根一律拒绝；准入一次；无主根搜索或路径混淆。
4. 0.2.2-alpha.2 及更早宿主上附加根视图与今天完全一致；主根在任何宿主上零行为变化。
5. `pnpm lint` / `typecheck` / `build` / `test` / `compat:check` / `docs:check` / `pack:check` / `kernel:probe` / `registry:probe` 本地通过，smoke 项按环境给出证据或交 CI。
6. Draft PR 打开、CI（releases/verify/gate）全绿并记录 run URL。

## 进度与证据

| 阶段 | 状态 | 提交 | 证据（命令/结果） |
| --- | --- | --- | --- |
| P0 | 进行中 | — | 本文件 + tag 级审计 |
| P1 | 待开始 | — | — |
| P2 | 待开始 | — | — |
| P3 | 待开始 | — | — |
| P4 | 待开始 | — | — |
| P5 | 待开始 | — | — |
| P6 | 待开始 | — | — |
