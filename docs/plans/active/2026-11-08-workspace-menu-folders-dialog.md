# 工作区菜单入口与 Workspace Folders 对话框复用（实施计划）

> **状态：已实施并在隔离 Web 宿主完成核心场景目检（`feat/workspace-menu-ui`，2026-11-08），决策见 [ADR-0038](../../decisions/ADR-0038-workspace-menu-folders-dialog.md)。** Phase 0–3 与文档/测试/门禁已完成，随 `v0.1.17` 发版。本计划只覆盖"工作区 `...` 菜单新增管理工作区目录入口"这一件事；`RootSwitcher`、上游 `WorkspaceBrowser`、对话框内部逻辑均不在改动范围内。

## Goal

在工作区行（`sidebar.workspaces`）的 `...` 菜单与右键菜单中新增"管理工作区目录…"（order 150，位于重命名与 "在 Finder 中显示" 之间）。点击后：

- 当前 session 已属于被点击的工作区 → 不新建会话，直接打开 footer 现有的"工作区目录"对话框；
- 当前 session 不属于该工作区（含没有 session、session 属于别的工作区、session orphaned）→ 先经上游 `uiWorkspace.openWorkspace` 打开/复用该工作区的 blank session，确认它成为 current 后，再打开对话框并固定使用该 session；
- 导航失败、被后续导航取代、目标没有成为 current，或所需服务缺失 → 不打开对话框；服务缺失时菜单项置灰。

## Background

- 对话框当前由 footer 的 `WorkspaceFoldersAction` 与 Files 面板的 `RootSwitcher` 各自持有一份本地实例。两者都是 modal，但都绑定在自己的组件生命周期上。
- 工作区菜单是全局手势，不能依赖 `RootSwitcher`（Files pane 可能不存在）。因此菜单必须有一个不依赖 pane 的对话框宿主。
- 面板的每个请求都要求有效 `sessionId`，主根由 host 按 session 推导（ADR-0008）。菜单点击时"该用哪个 session"必须先确定。
- 上游 `openWorkspace` 在 `beforeOpen` 回调里给出目标 session id，并在选中前同步调用；被取代时 resolve 但不调用。`startSession` 返回 `void`，不可用。

## Current State（2026-11-08，`feat/workspace-menu-ui`）

已核对：

- `src/client/index.ts`：
  - `inject = ['slots', 'locale', 'connection']`；
  - `uiWorkspace`、`sessions` 经 `readService()` 可选读取；
  - footer 注册 `sidebar.footer.action`（`SLOT_ID`，`order: 50`），渲染 `WorkspaceFoldersAction`，传 `panel`/`pickDirectory`/`sessionId`/`subscribeSession`/`t`/`wide`；
  - Files actions 注册在有 `absolutePath` 时渲染 `RootSwitcher`，否则渲染 compact `WorkspaceFoldersAction`；
  - 没有 `installWorkspaceMenu` 调用，也没有 `contextMenus` 依赖。
- `src/client/WorkspaceFoldersAction.tsx`：
  - `WorkspaceFoldersAction` 自持 `const [open, setOpen] = useState(false)`，触发按钮 `onClick={() => setOpen(value => !value)}`；
  - `WorkspaceFoldersDialog` 已导出，props 为 `WorkspaceFoldersActionProps & { onClose }`；`sessionId` 是可选 thunk；
  - `WorkspaceFoldersDialog` 的 `refresh` 依赖 `props.sessionId` 身份，session 变化会重发 `list`；带 epoch + `props.sessionId?.() !== base.sessionId` 守卫。
- `src/client/RootSwitcher.tsx`：本地 `dialogOpen`，显式传 `panel`/`pickDirectory`/`sessionId`/`subscribeSession`/`t`，不传 `dialogController`。
- `src/compat/client-icons.ts`：`maybeIcon` / `selectIcon` 探针；`IconAccessInherit` 已使用 `IconWorkspaceTreeOutline16` / `IconWorkspaceTreeOutlineRegular`。dev pin `0.2.2-rc.1` 的 primitives 导出后者。
- 上游 `workspace` target 声明在 `packages/client/ui-workspace/src/client/contract/slots.ts`；现有贡献 `workspace.rename` order 100、`open-in-app.workspace` order 200、`workspace.delete` order 300。
- `contextMenu.icon` 是 keyed root slot；上游 ui-workspace 用 `ctx.slots.inject('contextMenu.icon', function* () { ... ctx.slots.register({ name: 'contextMenu.icon', key }, Icon) ... })` 注册图标。
- `uiWorkspace` 是 cordis Service（`super(ctx, 'uiWorkspace')`）；`openWorkspace(workspaceId, beforeOpen?, options?)` 返回 `Promise<void>`；`beforeOpen` 在 `replaceMain` 中被同步调用，选中在回调之后写入。

## Scope

1. 新增 `WorkspaceFoldersDialogController` 与单元测试。
2. footer 的 `WorkspaceFoldersAction` 支持外部打开与固定目标 session，保留本地 dialog 与原有切换语义。
3. 新增 `workspace` context-menu 贡献、图标、可用性判定与导航。
4. `client/index.ts` 创建 controller、读取可选服务、安装菜单。
5. 菜单、controller、dialog owner 的测试；文档与 CHANGELOG。

## Non-goals

- 不新增菜单专用 dialog；
- 不删除/迁移/修改 `RootSwitcher`；
- 不修改上游 `WorkspaceBrowser`（`sidebar.workspaces`）；
- 不把 footer / RootSwitcher 的 dialog 统一成全局实例；
- 不强制每次新建 blank；
- 不新增设置页；
- 不改变对话框内部的列表、增删、权限、别名、Skills 逻辑；
- 不新增 locale key（复用 `switcher.manage`）。

## Design

### 1. Dialog controller（`src/client/workspace-folders-dialog.ts`）

```ts
export interface WorkspaceFoldersDialogController {
  registerOwner(open: (sessionId?: string) => void): () => void
  open(sessionId: string): boolean
  readonly available: ObservableSnapshot<boolean>
}

export function createWorkspaceFoldersDialogController(): WorkspaceFoldersDialogController
```

- `available = createSnapshotStore<boolean>(false)`；
- `registerOwner` 记录唯一 owner 并置 `true`，返回注销函数；注销时仅当自己仍是当前 owner 才置 `false`（last-wins）；
- `open` 在没有 owner 时返回 `false`；有 owner 时调用并返回 `true`；owner 抛错时捕获、返回 `false`，不改变 `available`（下一次点击仍可重试）；
- 不持有 sessionId、不排队、不做异步；它只是"footer 对话框现在能不能被外部打开"的接缝。

### 2. Footer owner 与目标 session（`WorkspaceFoldersAction.tsx`）

新增 props：

```ts
readonly dialogController?: WorkspaceFoldersDialogController
readonly dialogOwner?: boolean
```

`WorkspaceFoldersAction` 内部：

```ts
const [open, setOpen] = useState(false)
const [targetSessionId, setTargetSessionId] = useState<string | undefined>(undefined)
const openWith = useCallback((sessionId?: string) => {
  setTargetSessionId(sessionId)
  setOpen(true)
}, [])
const close = useCallback(() => {
  setOpen(false)
  setTargetSessionId(undefined)
}, [])

useEffect(() => {
  if (props.dialogOwner !== true || props.dialogController === undefined) return
  return props.dialogController.registerOwner(openWith)
}, [props.dialogOwner, props.dialogController, openWith])

const dialogSessionId = useCallback(
  () => targetSessionId ?? props.sessionId?.(),
  [targetSessionId, props.sessionId],
)
```

- 触发按钮保留切换：`open ? close() : openWith(undefined)`；这样 footer 原有"点一下开、再点一下关"的行为不变，且关闭会清空外部目标。
- 对话框渲染 `sessionId={dialogSessionId}`、`onClose={close}`；其余 props 原样透传。
- 只有 footer 注册 owner（`dialogOwner: true`）；compact Files action 与 `RootSwitcher` 都不传，不注册。
- 目标变化时 `dialogSessionId` 身份变化 → 对话框的 `refresh` 重跑；已经打开的 dialog 不会关闭再打开。旧请求的应答由对话框自身 epoch + session 守卫丢弃。

### 3. 菜单注册（`src/client/workspace-menu.ts`）

```ts
export interface WorkspaceMenuDeps {
  readonly panel: PanelClient | undefined
  /** Read per resolve/run: the controller may activate after this entry. */
  readonly workspaces: () => WorkspacesClient | undefined
  /** Read per request for the same reason. */
  readonly uiWorkspace: () => UiWorkspaceClient | undefined
  /** Read per request; its `retainInfo()` is the synchronous current-session probe. */
  readonly sessions: () => unknown
  readonly dialog: WorkspaceFoldersDialogController
  readonly t: Translate
}

export function installWorkspaceMenu(ctx: ClientContext, deps: WorkspaceMenuDeps): void
```

`installWorkspaceMenu` 内：

- `ctx.inject(['contextMenus', 'slots'], (scope) => { ... })`；缺服务时整段不存在，不抛错；
- **整个变更以 `contextMenu.icon` 槽位为门**：把图标注册与 `contextMenus.register` 一起放进 `scope.slots.inject('contextMenu.icon', ...)` 的回调。槽位不存在时回调不执行，菜单贡献和图标注册都不存在——不是"只少一个图标"；
- 在回调里 `scope.slots.register({ name: 'contextMenu.icon', key: 'multi-root-workspace.manage-folders' }, IconWorkspaceTree)`，并 `scope.effect(() => scope.contextMenus.register({ id, target: 'workspace', order: 150, resolve: ... }), '...')`；
- `resolve` 返回单个 `manage` 动作：

```ts
{
  id: 'manage',
  label: deps.t('switcher.manage'),
  icon: { key: 'multi-root-workspace.manage-folders' },
  disabled: !menuEnabled(deps, workspaceId),
  run: () => runWorkspaceMenu(deps, workspaceId),
}
```

### 4. 可用性

```ts
function menuEnabled(deps: WorkspaceMenuDeps, workspaceId: string): boolean {
  const workspace = deps.workspaces()?.list.getSnapshot().items
    .find(item => item.workspaceId === workspaceId)
  return deps.panel !== undefined
    && workspace !== undefined
    && typeof deps.uiWorkspace()?.openWorkspace === 'function'
    && deps.dialog.available.getSnapshot()
}
```

按需求：`panel`、`workspaces`（含目标记录）、`uiWorkspace.openWorkspace`、footer dialog 任一缺失即置灰。`sessions` 缺失不单独置灰——没有它就无法判定 current 归属，导航后的 current 校验也会失败，因此不会打开对话框；但保持入口可见可以让用户至少看到入口。`workspaces` / `uiWorkspace` / `sessions` 必须是 **调用时读取的 thunk**，否则在它们晚于本插件 entry 激活的组合里，入口会永久置灰或永远判不出 current。

### 5. 版本边界与降级

上游 tag 核对结果：`ContextMenus` 服务、`contextMenu.icon` keyed slot 与 `workspace` target **都首次出现在 `0.2.2-alpha.3`**（`@deepseek-ai/dsh-client-ui-context-menu` 由 commit `411f157983` 引入，keyed icon slot 由 `9dce789696` 引入；首个包含它们的 release tag 是 `dsh-v0.2.2-alpha.3`）。`0.2.2-alpha.2` 及更早的 20 个受支持版本没有该服务、slot 或 target。

因此本分支的行为边界是：

- **`0.2.2-alpha.3` 及以后**：槽位存在，菜单入口按 §3.4 的可用性规则出现；
- **更早版本**：`ctx.inject(['contextMenus', 'slots'])` 不触发；即使未来某个组合有 `contextMenus` 但缺 icon 槽位，嵌套的 `slots.inject` 也不执行。菜单贡献、`contextMenu.icon` key 与图标注册全部不存在，等价于"本分支没有做这次 UI 修改"；footer、`RootSwitcher`、Files 页签等既有 UI 完全不受影响。

### 6. 导航

```ts
async function runWorkspaceMenu(
  deps: WorkspaceMenuDeps,
  workspaceId: string,
): Promise<void> {
  const current = deps.sessionId()
  const workspace = deps.workspaces()?.list.getSnapshot().items
    .find(item => item.workspaceId === workspaceId)

  if (current !== undefined && workspace?.sessionIds.includes(current) === true) {
    deps.dialog.open(current)
    return
  }

  const openWorkspace = deps.uiWorkspace()?.openWorkspace
  if (openWorkspace === undefined) return

  let targetSessionId: string | undefined
  try {
    await openWorkspace(workspaceId, (id) => { targetSessionId = id })
  } catch {
    // 上游已显示 createFailed notice；这里不重复提示。
    return
  }

  if (targetSessionId === undefined) return
  const sessions = deps.sessions()
  const retained = mainViewRetentionOf(sessions, targetSessionId)
  if (retained === false) return
  if (retained === undefined && currentSessionIdOf(sessions) !== targetSessionId) return

  deps.dialog.open(targetSessionId)
}
```

- 用 `openWorkspace`，不用 `startSession`；
- `beforeOpen` 早于选中，await 后必须重新确认 current；判定优先 `sessions.retainInfo(target).retainedBy.mainView > 0`（`retain()` 同步更新），catalog 只在没有探针时回退；
- 判断"当前 session 是否属于目标工作区"同样优先遍历目标 `sessionIds` 的保留计数，避免 catalog 滞后或停留在上一个工作区；
- 当前 session orphaned 但目标工作区有效 → 按"不属于"导航，不置灰；
- 目标 workspace 在 resolve 与 run 之间被删除 → `workspace` 为 `undefined`，走导航路径，`openWorkspace` 会 reject（未知 workspace），捕获后不打开；
- `dialog.open` 返回值在菜单路径中不需要额外处理：`menuEnabled` 已保证可用；若在运行期间 footer 卸载，`open` 返回 `false`，表现为"什么都不发生"。

### 6. 类型补充

`src/client/workspace-menu.ts` 内定义结构化读取类型（不硬注入）：

```ts
interface WorkspacesClient {
  list: {
    getSnapshot(): {
      items: readonly {
        workspaceId: string
        sessionIds: readonly string[]
      }[]
    }
  }
}

interface UiWorkspaceClient {
  pickDirectory?: () => Promise<string | null>
  openWorkspace?: (
    workspaceId: string,
    beforeOpen?: (sessionId: string) => void,
  ) => Promise<void>
}
```

`workspace` target 与 `contextMenu.icon` 不引入上游包类型：该包在 `0.2.2-alpha.3` 之前不存在，列为 devDependency 会让 CI 的升级矩阵在旧版本安装阶段失败。模块内声明 `MenuAction` / `MenuContribution` / `MenuContextMenus` / `MenuSlots` / `MenuScope` 的极小结构化切片，并在 `ctx.inject` 的 scope 上做一次窄化；运行期行为与类型安全都不依赖包是否安装。

### 7. 图标

`src/compat/client-icons.ts`：

```ts
export const IconWorkspaceTree =
  maybeIcon(['IconWorkspaceTreeOutline16', 'IconWorkspaceTreeOutlineRegular'])
  ?? IconFolderOpen
```

`contextMenu.icon` 注册 `IconWorkspaceTree`。不使用 `IconSettings`，避免与 `RootSwitcher` 的 folder 图标/管理含义混淆。

### 8. `client/index.ts` 接线

- `apply()` 中创建一次 `dialogController`；
- footer 注册额外传 `dialogController`、`dialogOwner: true`；
- Files compact 注册不传；
- 以 thunk 传入 `workspaces` 与 `uiWorkspace`（`readService` 每次读取），与 `panel`/`sessionId` 一起传给 `installWorkspaceMenu`；
- `installWorkspaceMenu` 在 footer 注册之后调用（顺序不影响 React 挂载，但让 controller 先存在）；
- 不修改 `dsh.client.inject`：context-menu 不是包依赖，运行时通过 `ctx.inject` 软等待服务；旧版本上该服务不存在，整段不触发。

## Implementation

### Phase 0 — 基线确认（不写代码）

- 读取并确认 Current State 的每一项；
- `pnpm install --frozen-lockfile` 后运行 `pnpm test` 建立基线（本次已完成安装，基线结果记录在实施记录中）；
- 确认 dev pin 的 primitives 导出 `IconWorkspaceTreeOutlineRegular`（已确认）；
- 确认 `WorkspaceFoldersDialog` 仍从 `WorkspaceFoldersAction.tsx` 导出（已确认）；
- 确认 `switcher.manage` 在中英文字典中都存在（已确认）。

### Phase 1 — Dialog controller + footer owner

交付：

- 新增 `src/client/workspace-folders-dialog.ts`；
- `WorkspaceFoldersAction` 增加 `dialogController` / `dialogOwner` props、目标 session 与关闭清空；
- footer 注册传 controller + `dialogOwner: true`；compact 不传；
- `RootSwitcher` 零改动；
- 新增 controller 单元测试与 footer/compact owner 行为测试。

验收：

- footer 按钮仍能打开同一个对话框，切换/关闭行为不变；
- controller `available` 在 footer 挂载/卸载时正确切换；
- 外部 `open('s1')` 打开对话框且请求使用 `s1`；
- dialog 已打开时收到新目标会更新并重发 `list`；
- compact 不注册 owner；
- `RootSwitcher` 代码零 diff。

### Phase 2 — 菜单项 + 图标 + 禁用逻辑

交付：

- `src/compat/client-icons.ts` 增加 `IconWorkspaceTree`；
- 新增 `src/client/workspace-menu.ts`；
- `src/client/index.ts` 创建 controller、读取服务、调用 `installWorkspaceMenu`；
- 不新增包依赖；用本地结构化类型覆盖 `ContextMenus.register` / `contextMenu.icon` 的极小切片；
- 菜单单元测试。

验收：

- 菜单项 order 150、label `switcher.manage`、icon key 正确；
- 位于 rename 与 reveal 之间（按 order 断言，不依赖渲染顺序）；
- 带 workspace tree 图标；
- 服务缺失时置灰；
- `contextMenus`/`slots` 缺失时不抛错且没有注册。

### Phase 3 — 导航流程

交付：

- `runWorkspaceMenu` 实现；
- 当前 session 归属判断；
- `openWorkspace` + `beforeOpen` 捕获 target；
- await 后 current 校验；
- 失败/被取代处理；
- 覆盖全部分支的测试。

验收：

- 当前在 A 点 B：跳到 B 的 blank hero，再打开 B 的 dialog；
- 当前在 A 点 A：不新建 session，直接打开；
- B 有 blank：复用（断言传给 `openWorkspace` 的 workspaceId，不创建新会话由上游负责）；
- 导航被取代：不弹 dialog；
- orphaned current + 有效 workspace：正常导航；
- workspace 记录不存在：disabled；
- `openWorkspace` reject：不打开；
- `beforeOpen` 后 current 不是 target：不打开。

### Phase 4 — 测试、文档、gates

交付：

- 完整单元/组件测试；
- 手工验收记录（在计划末尾追加"实施记录"节）；
- `docs/architecture/multi-root-workspace.md` 更新客户端入口说明；
- `docs/guide/README.md` 补充菜单入口；
- `docs/decisions/README.md` / `README.en.md` 登记 ADR-0038；
- `docs/plans/README.md` / `README.en.md` 登记本计划；
- `CHANGELOG.md` / `CHANGELOG.en.md` 当前未发布段落（若没有 `[Unreleased]` 段则新增）；
- 跑 gates。

## Validation

### 菜单测试（`tests/client-workspace-menu.spec.ts`）

1. 注册参数：`target: 'workspace'`、`order: 150`、label、icon key。
2. `panel` 缺失 → `disabled: true`。
3. `workspaces` 缺失 / 目标 workspace 不存在 → `disabled: true`。
4. `uiWorkspace.openWorkspace` 缺失 → `disabled: true`。
5. `dialog.available` false → `disabled: true`。
6. 全部可用 → `disabled: false`。
7. 当前 session 属于目标 → 不调 `openWorkspace`，调 `dialog.open(current)`。
8. 当前 session 不属于 → 调 `openWorkspace`；`beforeOpen` 给出 target 后 `dialog.open(target)`。
9. 无 session → 导航后打开。
10. `openWorkspace` reject → 不打开。
11. `beforeOpen` 后 current 不是 target → 不打开。
12. orphaned current + 有效 workspace → 导航并打开（不置灰）。
13. `contextMenus` / `slots` 缺失 → 不抛错、无注册。
14. `dialog.open` 在 footer 运行期卸载后返回 false → 不抛错。

### Controller / dialog owner 测试（`tests/client-panel.spec.tsx`）

- `registerOwner` 前 `available` false，`open` 返回 false；
- 注册后 true，`open` 调 owner 并返回 true；
- 注销后 false；旧 owner 的注销不影响新 owner；
- owner 抛错时 `open` 返回 false 且 `available` 不变；
- footer 按钮打开/关闭行为不变；
- 外部 `open('s1')` 让 dialog 的 `list` 请求使用 `s1`；
- 关闭后目标清空，下一次 footer 打开用当前 session；
- dialog 已打开时收到新目标，`list` 重发且使用新 session；
- `dialogOwner` 未传（compact）不注册 owner。

### 集成（`tests/client-panel.spec.tsx` 或菜单 spec）

- 用真实 `client.apply` 挂载 footer + contextMenus stub：render footer → resolve 菜单贡献 → run `manage` → 断言 dialog 打开且 `list` 使用当前 session。验证 index 确实把同一个 controller 交给了 footer 和菜单。

### 手工验收

- 菜单项位置/图标/文案；
- 当前 workspace 直接打开；
- 其他 workspace 导航到 blank hero 后打开；
- 复用已有 blank；
- 导航被取代（快速点击另一个工作区）；
- `RootSwitcher` 入口仍存在、行为不变（sidebar-right Files 面板）；
- footer 入口行为不变；
- 服务缺失时置灰。

### Gates

```bash
pnpm test
pnpm build
pnpm typecheck
pnpm compat:check
pnpm docs:check
```

发布前按仓库规则再跑 `pnpm pack:check` 与 `pnpm smoke:packed`。

## Risks

1. **footer 未挂载**：菜单必须置灰；`dialog.available` 是唯一判据。
2. **导航竞态**：`beforeOpen` 早于选中，必须 await 后检查 current；被取代/失败都不弹窗。
3. **orphaned session**：不置灰；按不属于目标导航。
4. **两个 dialog owner**：RootSwitcher 不动；本阶段接受，统一 host 是后续独立重构。
5. **右键重复入口**：`workspace` target 固有行为，接受。
6. **图标兼容**：`IconWorkspaceTreeOutlineRegular` 缺失时回退 `IconFolderOpen`；required icon 探针失败仍 fail loud。
7. **测试桩漂移**：`client-panel.spec.tsx` 的 `ctx` stub 需要新增 `inject` 与 `contextMenus` 捕获；保持对既有测试零回归。
8. **升级矩阵与包依赖**：context-menu 在 `0.2.2-alpha.3` 之前不存在；不得把它列为 devDependency（CI 会把所有 `@deepseek-ai/dsh*` devDependency 重指到目标版本）。类型面用本地结构化接口，`compat:check` 与旧版本安装均不受影响。

## Documentation Impact

- `docs/decisions/ADR-0038-workspace-menu-folders-dialog.md`（新增）；
- `docs/decisions/README.md` / `README.en.md`（索引）；
- `docs/plans/active/2026-11-08-workspace-menu-folders-dialog.md`（本文件）；
- `docs/plans/README.md` / `README.en.md`（active 索引）；
- `docs/architecture/multi-root-workspace.md`：Client 半部条目补充 footer dialog owner、菜单入口、`order: 150`、导航语义；
- `docs/guide/README.md` / `README.en.md`：工作区 `...` 菜单入口与"先切换再打开"的用户可见语义；
- `CHANGELOG.md` / `CHANGELOG.en.md`。

## Completion Criteria

- [x] 工作区 `...` 菜单新增"管理工作区目录…"，order 150，带 workspace tree 图标。
- [x] 当前 session 属于目标 workspace：不新建 session，打开现有 dialog。
- [x] 当前 session 不属于：打开/复用目标 workspace blank，hero 页出现后打开 dialog。
- [x] 已有 blank 被复用。
- [x] 导航被取代/失败时不打开 dialog。
- [x] 服务缺失时菜单项置灰。
- [x] 没有新增菜单专用 dialog。
- [x] `RootSwitcher` 零修改，sidebar-right Files 面板入口保留。
- [x] Upstream `WorkspaceBrowser` 零修改。
- [x] 现有 footer 和 RootSwitcher 行为不回归。
- [x] 新增/更新测试通过。
- [x] `pnpm test`、`pnpm build`、`pnpm typecheck`、`pnpm compat:check`、`pnpm docs:check` 通过。
- [x] 文档与 CHANGELOG 更新。

## 实施记录（2026-11-08，`feat/workspace-menu-ui`）

### 实际改动

- **Controller**：新增 `src/client/workspace-folders-dialog.ts`。`createWorkspaceFoldersDialogController()` 用 `createSnapshotStore<boolean>(false)` 保存 `available`；`registerOwner` last-wins，注销只在仍是当前 owner 时生效；`open` 无 owner 或 owner 抛错时返回 `false`，后者保持 owner 注册与可用性，允许下一次重试。
- **Footer owner**：`WorkspaceFoldersAction` 增加 `dialogController` / `dialogOwner` props 与 `targetSessionId`；footer 触发按钮保留开/关切换，关闭时清空外部目标。`dialogSessionId = targetSessionId ?? props.sessionId?.()`，目标变化会改变函数身份并触发对话框重发 `list`。compact Files launcher 与 `RootSwitcher` 不传 controller，仍各自持有本地 dialog。
- **菜单**：新增 `src/client/workspace-menu.ts`。`installWorkspaceMenu` 经 `ctx.inject(['contextMenus', 'slots'], ...)` 软注册，并把图标注册与 `contextMenus.register` 一起嵌套在 `scope.slots.inject('contextMenu.icon', ...)` 回调内——icon 槽位缺席时整条贡献不存在（版本边界见 §设计 5）；贡献 `multi-root-workspace.manage-folders` / target `workspace` / order 150；`resolve` 输出 `manage` 动作，label `switcher.manage`，icon key 同名；`disabled` 需要 `panel`、目标 workspace 记录、`uiWorkspace.openWorkspace` 函数、`dialog.available` 全部成立。
- **导航**：当前 session 属于目标工作区 → 直接 `dialog.open(current)`；否则 `openWorkspace(workspaceId, beforeOpen)`，await 后要求 target 存在且主视图仍保留该 session 才打开。current 判定优先使用 `sessions.retainInfo()` 的同步保留计数，catalog 只在探针缺席时回退。`openWorkspace` reject、未调用 `beforeOpen`、被后续导航取代、footer 在运行期消失均不打开；`runWorkspaceMenu` 开头复查 `menuEnabled`，避免"已导航但对话框宿主已消失"。
- **图标**：`src/compat/client-icons.ts` 增加 `IconWorkspaceTree = maybeIcon(['IconWorkspaceTreeOutline16', 'IconWorkspaceTreeOutlineRegular']) ?? IconFolderOpen`；dev pin `0.2.2-rc.1` 实际导出 Regular 名。
- **接线**：`src/client/index.ts` 在 `apply()` 中创建一个 controller，footer 注册传 `dialogController` + `dialogOwner: true`；以 thunk 传入 `workspaces` / `uiWorkspace`（每次 resolve/run 重新 `readService`），在注册完成后调用 `installWorkspaceMenu`。`dsh.client.inject` 未加入 context-menu：它没有包依赖，运行期由 `ctx.inject` 软等待。
- **依赖**：不新增包依赖。`package.json` / `pnpm-lock.yaml` 相对 `main` 无变化；context-menu 的类型面是 [workspace-menu.ts](../../../src/client/workspace-menu.ts) 内的本地结构化接口。
- **测试**：新增 `tests/client-workspace-menu.spec.ts`（26 项：贡献参数、禁用矩阵、迟到激活、方法绑定、导航全分支、catalog 滞后/保留释放/探针缺席、软注册、图标槽缺席，以及一次真实 `client.apply` 的 footer→controller→dialog 接线）；`tests/client-session.spec.ts` 增加 3 项 `mainViewRetentionOf` 单元测试；`tests/client-panel.spec.tsx` 增加 controller 生命周期、footer 外部打开/目标切换/关闭清空、compact 不注册 owner、footer 卸载后可用性翻转共 9 项；`tests/client-icons.spec.ts` 增加 workspace-tree 图标绑定；三个既有 client harness（panel / switcher / navigator）增加 `inject` no-op 桩。
- **文档**：ADR-0038、本计划、decisions/plans 双语索引、架构 Client 半部条目、双语用户指南、双语 CHANGELOG `[Unreleased]`。

### 返工（2026-11-08，隔离环境目检后）

- **现象**：在 repo-a 的会话中点击 repo-b 的 `...` → 「管理工作区目录…」，既不导航也不弹窗。
- **主因**：`UiWorkspaceService.openWorkspace` 是普通方法（`return this.openWorkspaceSession(...)`），首版把 `deps.uiWorkspace?.openWorkspace` 解构后裸调用，`this` 丢失并同步抛 `TypeError`；`try/catch` 把它当成"导航失败"静默吞掉。修复为保留服务对象并以 `uiWorkspace.openWorkspace(...)` 方法形式调用；新增一个依赖 `this` 的 stub 回归。
- **次因**：修好绑定后，`openWorkspace` 已在 `replaceMain` 中同步 `retain()` 目标 blank，但该 session 的 catalog 行可能后到，`currentSessionIdOf()` 仍返回旧 session。修复为 `src/compat/client-session.ts` 新增 `mainViewRetentionOf(sessions, id)`，结构化读取 `sessions.retainInfo(id).getSnapshot().retainedBy.mainView`；导航后的 current 判定优先该探针，`false` 时即使 catalog 仍指向 target 也不打开。"当前 session 是否属于目标工作区"也改为遍历目标 `sessionIds` 的保留计数；没有探针的旧运行时回退 catalog。
- **回归**：新增 1 项方法绑定测试、3 项菜单保留探针测试（catalog 滞后但 retention 已保留 target；catalog 未列出但 retention 已命中的成员；retention 已释放而 catalog 仍指向 target）与 3 项 `mainViewRetentionOf` 单元测试。

### 与计划的差异

- `run` 直接返回 `runWorkspaceMenu(...)` 的 Promise，而不是 `void` 包装：上游 context-menu 接受 `void | Promise<void>`，返回 Promise 让测试可以 await，也不改变失败语义（内部已吞掉导航失败）。
- `workspaces` / `uiWorkspace` 改为 thunk 按需读取，而不是在 `apply()` 捕获：两者都可能晚于本插件 entry 激活（完善了计划 §3.4 的"可选服务"假设）。新增迟到激活回归。
- 增加运行期 `menuEnabled` 复查（见上）。计划原文只要求 resolve 时判定。
- 菜单测试文件使用 `.ts` + `createElement`，与计划文件清单一致；不需要 JSX。
- 未增加 `dsh.client.inject` 边；原因见 ADR-0038 决策 8。

### 测试与门禁（macOS arm64 / Node `24.18.0` / pnpm `11.25.0`）

- 定向回归：`client-workspace-menu.spec.ts` 26/26、`client-panel.spec.tsx` 72/72、`client-icons.spec.ts` 4/4；`client-switcher.spec.tsx` 23/23、`client-navigator.spec.tsx` 23/23 无回归。
- 完整 `pnpm test`（DSH 工具沙箱内）：**1223 passed / 157 skipped / 17 failed**。rebase 前本分支同一环境为 1181/157/17，更早的基线为 1142/157/17；三次的失败集合相同，全部是工具沙箱拒绝嵌套 `sandbox-exec` 与共享 Registry IPC 导致的 follower 期望失败（`expected 'contended' to be 'follower'`），范围是 `registry*`、`skills-*`、`authority-boundaries`、`b9-review-regressions`。
- 完整 `pnpm test`（完整主机权限）：**1302 passed / 95 skipped / 0 failed**（84 个文件通过、3 个文件整体跳过）。这与仓库 `v0.1.16` 发版记录中"沙箱内失败、完整权限下通过"的现象一致（见[进度总账](./2026-09-12-multi-root-workspace.md#v0116-发版验收2026-11-08)），因此确认上述 17 项不是本批回归。
- `pnpm typecheck`、`pnpm build`、`pnpm compat:check`、`pnpm lint`、`pnpm docs:check`、`pnpm pack:check`（185 个成员）全部通过。
- `pnpm smoke:packed`（DSH 工具沙箱内）：**95 passed / 0 failed / 8 skipped**；完整主机权限 + `DSH_PROBE_VERIFIED_DIALECTS=seatbelt` 重跑：**136 passed / 0 failed / 0 skipped**，打包产物行为电池全绿。
- **隔离 Web 宿主目检（已执行）**：在 `/tmp/dsh-mrw-manual-1794125206` 的独立 `$DSH_HOME` 中以 `link:` 安装本分支，启动 `dsh --profile web --port 52380`；用 headless Chrome（1280×800）实际点击验证：当前 repo-a → repo-b 的 `...` → 「管理工作区目录…」→ 当前会话切换为 repo-b，`工作区目录` 对话框可见，主根显示 repo-b 的 canonical 路径（截图 `/tmp/mrw-final.png`，不提交）。同一轮也验证了菜单项位于「重命名」与「在 Finder 中显示」之间、图标为 workspace-tree、页脚「工作区目录」按钮仍可独立打开。
- 仍需维护者人工确认：其他窗口宽度下的版式、Files 页签根选择器与 `RootSwitcher` 入口的视觉回归、服务缺失置灰（后者由单元测试覆盖）。

### 遗留

- 真实 GUI 手工验收（菜单位置/图标/文案、直接打开、跨工作区导航、blank 复用、快速切换竞态、RootSwitcher/footer 入口回归、服务缺失置灰）。
- 发布流程（版本号、CHANGELOG 从 `[Unreleased]` 定版、tag）按 `docs/development/release-workflow.md` 在验收后执行；届时把本计划移入 `completed/` 并更新索引与进度总账。
