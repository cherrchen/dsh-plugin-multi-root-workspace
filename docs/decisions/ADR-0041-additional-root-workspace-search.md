# ADR-0041: 附加根工作区搜索：插件通道端点与结构门控

## Status

Accepted

## Date

2026-11-14

## Context

DSH 0.2.2-rc.2 给右侧 Files 页签加了工作区搜索：搜索栏、结果树（含命中高亮）、排除规则与 ignore 开关、
隐藏项开关与"只有隐藏项"提示。原生搜索的根永远是 Session cwd（Host 从 Session header 解析），
`workspaceFiles.search` 的 wire request 里**没有根字段**——浏览器侧无法指定根。

本插件把附加根的树接进同一个 Files 页签（ADR-0015/ADR-0016），所以搜索必须**为附加根**工作：
用户选中的附加根才是"这个树的工作区"。需求与验收见
[附加根 Files 树对齐计划](../plans/completed/2026-11-14-additional-root-files-parity.md)。

约束：

- 不修改上游任何包/接口（ADR-0002），不给插件新增上游运行时依赖；
- 不把新版本行为带到老宿主：0.1.5-rc.2 起的 24 个受支持版本里，只有 0.2.2-rc.2 起有搜索（结构探测，ADR-0009）；
- 授权只有一个家：附加根是否可用、是否仍被授予，必须由 Host 的 Registry/scope 判定，客户端只能"请求搜哪个根"；
- 搜索的资源预算、错误码、忽略规则语义应与原生搜索完全一致。

## Investigation

- 上游 `workspaceFiles.search` 在 Host 侧是普通方法 `search(scope, request, signal)`，`scope` 是由 Typert lookup 解析
  出来的普通对象 `{ sessionId, workspaceRoot }`；root 从 `scope.workspaceRoot` 解析后交给 `searchWorkspace(...)`
  在工作区根启动打包的 ripgrep。也就是说：**Host 进程内**可以构造一个命名附加根的 scope 来复用同一实现，
  与 `list`/`stat` 的既有"按根改写请求再调原方法"同型。
- 浏览器侧没有命名根的能力：wire 第一参数是 SessionId，Host 用它查 Session header。任何"把根编码进
  sessionId 或 query"的方案都会污染上游协议或依赖未验证行为。
- 插件已有自己的 Connection RPC 通道 `/multi-root-workspace`（ADR-0005）与"每端点一个响应形状"的契约；
  skills / worktree 两个功能族已在同一通道上按"先分支、再解析"的模式扩展，是本端点的既有先例。
- `multiRootScope.scopeOf()` 在共享权威 Host 中**只在准入帧内**回答（无帧时返回空），因此"是否仍被授予"
  的判定必须在 `withRegistryRead` 的帧内进行；准入本身必须在主根下取，否则会以附加根为 key 错序。

## Decision

### D1 传输：插件通道上的一个端点

在上游无法命名根的前提下，新增插件自有端点 `search`（沿用 ADR-0005 的通道与"一个端点一个响应形状"）：

- 请求（严格 schema，`src/contract.ts`）：`{ sessionId, rootId, query, excludedPaths, includeHidden, respectGitignore }`。
  **用 Registry 的稳定 `rootId` 而不是路径**：Host 每次都用刷新后的登记表解析，移除、移动、重命名或重定向的根
  不会被客户端旧副本绕过。
- 响应 `SearchView`：`{ root, matches[{ path, type }], truncated, incomplete }`；`matches.path` 相对 `root`、
  `/` 分隔——与上游 wire 同形，客户端把它按绝对根合成树。
- 客户端失败码走既有 `error.<code>` 词表；Host 侧失败映射为 `invalid-ref`/`not-found`/`root-unavailable`/
  `search-unavailable`/`session-not-found` 等稳定码，上游 `workspace-file/*` 码原样透传。

### D2 授权：Host 派生、登记表解析、帧内校核、单次准入

`src/files-search.ts`（Host）按顺序：

1. `resolvePanelPrimaryRoot(ctx, sessionId)`：主根来自 live Session，不接受客户端命名（ADR-0008）；
2. `multiRootRegistry.refresh(primaryRoot)`：应答前重新 stat/重解析/重新分类每个登记目录，与 `list` 一致；
3. 按 `rootId` 找到登记行，要求 `state === 'available'`（目录在、未被重定向、未被扣留），否则 `root-unavailable`；
4. 以 `{ sessionId, workspaceRoot: root, primaryRoot }` 调上游实现的**进程内**调用；`primaryRoot` 是 host 内部标记，
   只在本调用存在，不进 wire；
5. `src/workspace-files.ts` 的 search 专用包装在**一次** Registry 准入帧内（key = 主根）复核
   `scopeOf(primaryRoot)` 是否仍包含该根，再以命名该根的 scope 调上游；撤销/扣留/权威不可用即拒绝；
   查询被 abort 时信号一路传到 ripgrep；
6. 普通 wire 的 `workspaceFiles.search` 调用（原生 UI，根=Session cwd）保持 v0.1.18 行为：以该根准入并在
   被扣留时拒绝，不路由。

### D3 客户端：结构门控、状态归属、偏好与隐藏项

- **门控**：仅当 `remote.workspaceFiles.search` 是函数（0.2.2-rc.2+）且本插件通道可用时，Files 页头才渲染搜索钮；
  老宿主上搜索面完全不存在——不是"打开后报错"。
- **状态**：搜索记录按 `(tab, root)` 存在 inject product（session 域）里：`barOpen/query/pending/result/expanded/scrollTop`
  与 `attempt`（失败重试）；body 重挂载（打开文件会让 Files body 卸载）后保留。结果树复用同一
  `TreeView`/宿主 Factory，`highlight` 标命中、`omitted: 'unmatched'` 抑制空目录行。
- **偏好**：与上游同一个 localStorage key `dsh.sidebar-files.workspace-search.v1`、同样的"只存差异、恢复默认即删项"
  格式；按根隔离。规则编辑是草稿，浮层关闭时保存；ignore 开关即时保存。
- **隐藏项**：从 rc.2 起原生树默认隐藏 dotfile，眼睛开关揭示。插件在自己的树绘制期应用同一偏好
  （`drawnTree`：过滤项、丢弃隐藏目录下的已列层级、给"只有隐藏项"的目录画说明），并把
  `includeHidden = showHidden` 传给搜索。

### D3 修订（2026-11-14，code review）：请求身份与记录所有权

- **请求身份**：`search-state.ts` 以 `searchRequestKey({rootId, query, excludedPaths, includeHidden, respectGitignore, attempt})`
  标识"同一次请求"。已结算答案保存该身份；body 重挂载时身份相同则复用，不重跑、不重置展开与滚动
  （打开文件再返回的路径）。查询/筛选/重试 attempt 变化必然改变身份并重跑，失败答案同样算已结算——
  重试是按钮的显式 attempt，不是 effect 落定后的自动循环。
- **记录所有权**：搜索记录随 session 的 inject product 创建（每 session 一份，不跨会话共享），
  并带 `forgetTab(tabId)`；adapter 的 owner 死亡清理在 `endTakeover(key, true)` 后调用它，
  body-only unmount（`end(key)`）保留记录。session 结束时记录随 product 回收。
- **页头 reload 与活动搜索**：reload 先保持 `filesTree.face.refresh(tabId)` 的树内 re-list；展示搜索结果时
  `FilesTree` 未挂载、face 无可刷新节点，故同一按钮再对搜索记录调用 `store.refresh(key)`：非空查询会
  清空 `settledKey` 并递增 `attempt`（旧结果与位置保留到新答案结算），使搜索无需改查询/筛选即可刷新；
  空查询不动作，树由 face 的 re-list 负责。
- **失败码**：search 端点的 host 错误在通道边界保留上游 `workspace-file/*` 词汇（白名单集合），
  客户端据此本地化；未知异常仍归一 `panel/internal`。

### D4 已知边界

- 原生 Files 快捷键（Cmd+P）走的是上游 `sidebar.files.navigator` face 的 `focus()`，接管期它聚焦的是被隐藏的
  原生搜索框；因此页头搜索钮是附加根搜索的受支持入口。不自注册快捷键（会与上游 id/默认键冲突）。
- 文档预览的 Folder 导航器只获得行右键，不获得搜索：其搜索态由上游 face 驱动，接管树不参与该 face；
  单独加入口会形成与原生不一致的第二入口。

## Alternatives Considered

- **给上游 search request 加根字段**：改动上游 wire 契约，旧 Host 不识别、未来 Host 可能收紧校验；排除。
- **插件自建 Typert Remote 命名空间**：契约生成是 workspace 形状的，外置插件没有受支持的挂载方式（ADR-0005）；排除。
- **新开一条 Connection 通道**：同一通道已有 handler 所有权（ADR-0005），多开一条只增加生命周期而无收益；排除。
- **Host 侧自写 ripgrep 搜索**：要复制上游的预算、错误语义、ignore 规则与 rg 启动细节，等于把上游实现分叉；排除。
- **重指原生导航器**：根写死在 `useSessions` 的 cwd，不可重指（ADR-0015）；排除。
- **让客户端把根拼成相对 cwd 的 `..` 路径交给原生搜索**：树键、地址与打开路由都会指向主根，且依赖未定义行为；排除。

## Consequences

- 附加根获得与主根一致的搜索语义（同一实现、同一预算、同一错误码），Host 侧无需复制 rg 逻辑。
- 面板契约多一个端点：客户端用 schema 解析响应，形状不符 → `panel/bad-response`；未知失败码回退
  `error.fallback`。端点未授权时只返回稳定拒绝码，不泄露路径内容。
- 老宿主零影响：无新依赖、无新 devDep（devDep 会在 upgrade 矩阵里被改写成不存在的版本），门控是结构探测。
- 第二份需要同步的上游逻辑：`search-rules.ts`/`search-tree.ts`/`search-preferences.ts` 是语义复制
  （见 `src/client/files-tree/FORK.md` 的同步清单）；上游改搜索语义时必须 diff。
- 搜索 UI 是插件自有组件而非逐字节 fork（它要按"当前选中的根"工作），样式逐条对齐上游 rc.2 规则并只用
  `var(--dsw-*)` token（ADR-0006）。
- 已知本地环境限制：权威 IPC 不可用的沙箱里，17 个 authority/lease/follower 测试在基线提交上也失败（与本文无关，
  CI 拥有该信号）；见完成计划 §7。

## Related Documents

- [ADR-0005](./ADR-0005-out-of-tree-client-transport.md)（插件自有 Connection RPC 通道）
- [ADR-0008](./ADR-0008-panel-session-derived-authority.md)（会话派生权威）
- [ADR-0009](./ADR-0009-dsh-compat-contract.md)（结构探测与兼容契约）
- [ADR-0015](./ADR-0015-files-tab-plugin-owned-browsing.md) / [ADR-0016](./ADR-0016-files-tab-native-tree-fork.md)
- [ADR-0024](./ADR-0024-registry-operation-admission.md)（操作准入）、[ADR-0025](./ADR-0025-shared-registry-authority.md)（共享权威）
- [ADR-0042](./ADR-0042-additional-root-row-context-menus.md)（同批的行右键菜单）
- [完成计划](../plans/completed/2026-11-14-additional-root-files-parity.md)
- `src/client/files-tree/FORK.md`、`docs/reference/dsh-0.2.2-migration.md`
