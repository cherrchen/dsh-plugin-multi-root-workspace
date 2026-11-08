# Workspace Folders Hero 入口（`conversation.hero.options`）

> 状态：已完成（2026-11-08），ADR-0037 已定案；随下一个版本发布（CHANGELOG `[Unreleased]`）。

## Goal

在新会话页的工作区行（`conversation.hero.options`：workspace 与模式选择器之后、整行右端）新增一个 Workspace Folders 入口。外观与相邻两个选择器同一套几何与交互，但**没有 chevron**；窄窗口只保留图标。`sidebar.footer.action` 的既有入口保持不变。

## Background

Workspace Folders 当前只有侧栏底部入口。用户在 blank session 开始新任务时，hero 行是输入区上方唯一的控件行；上游 `0.2.1-alpha.3` 起提供 `conversation.hero.options`（commit `3f1d5dfcfa`），专门用于在 workspace / 模式选择器之后追加紧凑选项，因此可以把入口放到任务开始的位置，而不占用或替换上游控件。

该槽是 `session` scope 的 `list`，composed props 带确定 `sessionId`；渲染位置由上游 `.heroOptions` 的 `margin-left: auto` 推到整行右端。hero 行只在 blank session 存在，首条消息发出后消失；新入口是“新建任务阶段”的附加路径，不是侧栏入口的替代品。

## Current State

- 侧栏入口：`src/client/index.ts` 中 `ctx.slots.inject('sidebar.footer.action', ...)` 注册 `multi-root-folders`（order 50），occupant 为 `WorkspaceFoldersAction`，内部打开 `WorkspaceFoldersDialog`。
- 面板通道：`src/client/panel-client.ts` → Connection RPC `/multi-root-workspace`；`list` 端点要求 `sessionId`，host 由 `resolvePanelPrimaryRoot` 解析（[ADR-0008](../../decisions/ADR-0008-panel-session-derived-authority.md)）。
- 样式：`src/client/styles.ts` 单一表，全部 `mrfw-` 前缀，颜色只用宿主 `--dsw-*` token（[ADR-0006](../../decisions/ADR-0006-client-ui-host-tokens.md)）。
- 兼容矩阵：`0.1.5-rc.2` ～ `0.2.2-rc.1`；`conversation.hero.options` 从 `0.2.1-alpha.3` 起存在，旧运行时上 `slots.inject` 静默不触发。
- 相邻几何（上游）：`HeroShell.module.css` 的 `.workspace` 与 `AgentPresetSeat.module.css` 的 `.seat` 均为 28px 高、`0 8px`、`gap 4px`、`--dsw-radius-sm`、13px/20px/500、hover/展开 `--dsw-alias-interactive-bg-hover`。

## Scope

- `conversation.hero.options` 的插件注册、trigger 组件与样式。
- 复用 `WorkspaceFoldersDialog`、`panel-client`、`t()` 与既有错误码。
- 新会话页的窄窗图标降级（视口 `≤560px`）。
- 注册、共存、旧运行时缺席、会话权威、无 chevron、StrictMode 与样式断点的测试。
- 文档、ADR-0037、CHANGELOG、兼容笔记与进度总账。

## Non-goals

- 不隐藏、不删除侧栏 `Folders` 入口；不做“新入口出现即旧入口消失”的门控。
- 不替换 `conversation.hero.agentPreset`；不做“夹在两个控件之间”的替换。
- 不改面板 RPC、授权模型、`session-not-live` 分类。
- 不加 `conversation.session.header.utilities` 入口（后续可选）。
- 不改 `dsh.client.inject`，不引入对 `ui-conversation` 的硬客户端依赖。
- 不改 host 侧、不新增端点、不迁移数据。

## Design

### 注册（纯加法）

```ts
const HERO_SLOT_ID = 'multi-root-folders.hero'
const HERO_ORDER = 10   // forge worktree 默认 0，排在其后
```

```ts
ctx.slots.inject('conversation.hero.options', () => ctx.slots.register({
  name: 'conversation.hero.options',
  id: HERO_SLOT_ID,
  order: HERO_ORDER,
  locale: NS,
}, (props: { readonly sessionId: string }) => {
  const sessionId = props.sessionId
  const readSession = useCallback(() => sessionId, [sessionId])
  return createElement(HeroWorkspaceEntry, {
    panel, pickDirectory, sessionId: readSession, t,
  })
}))
```

- `readSession` 必须稳定：对话框 `refresh` 依赖它，裸 `() => sessionId` 会每次渲染重发 `list`。
- 不注册 `label`（该槽 owner 不投影 label）。
- 与侧栏注册完全独立：不同槽、不同 id、互不 dispose。

### 可见形态（对齐两个选择器，无 chevron）

| 属性 | 值 | 对齐对象 |
|---|---|---|
| `min-height` | 28px | 两个选择器 |
| `padding` | `0 8px` | 两个选择器 |
| `gap` | 4px | 两个选择器 |
| `border-radius` | `var(--dsw-radius-sm)` | 两个选择器 |
| 字体 | 13px / 20px / 500 | 两个选择器 |
| 文字色 | `var(--dsw-alias-label-primary)` | 两个选择器 |
| 展开/悬停底色 | `var(--dsw-alias-interactive-bg-hover)` | 两个选择器 |
| 图标 | workspace tree `IconWorkspaceTreeOutlineRegular` 16px，`flex: none`；旧运行时回退 `IconFolderOpen`；文字在前、icon 在后 | 与 preset 图标同尺寸；右对齐行外缘 |
| 最大宽度 | `min(100%, 240px)`，label 省略号 | preset seat |
| 行内对齐 | `margin-right: 4px`：按钮盒距行右缘 20px，与工作区选择器距行左缘 20px 对称 | `.heroWorkspaceRow` 的 `0 16px 0 20px` |
| chevron | **无** | 按钮打开对话框，不是下拉 |

结构：

```tsx
<button
  type="button"
  className="mrfw-heroEntry"
  title={t('action.title')}
  aria-label={t('action.label')}
  aria-haspopup="dialog"
  aria-expanded={open}
  onClick={() => { setOpen(value => !value) }}
>
  <span className="mrfw-heroEntryLabel">{t('action.label')}</span>
  <span className="mrfw-heroEntryIcon" aria-hidden="true"><IconWorkspaceTree size={16} /></span>
</button>
```

### 窄窗口：只保留图标

hero 行没有 `container-type`（上游只给会话标题行和输入卡行设了容器），使用视口媒体查询，阈值取宿主自己的紧凑步进 **560px**：

```css
@media (max-width: 560px) {
  .mrfw-heroEntry {
    width: 28px;
    min-width: 28px;
    padding: 0;
    justify-content: center;
    gap: 0;
  }
  .mrfw-heroEntryLabel { display: none; }
}
```

- `≤560px`：28×28 纯图标按钮，名称由 `aria-label` + `title` 承载。
- `561–767px`：保留文字，label 靠省略号收缩。
- 视口近似而非容器查询：抽屉模式（`<768`）下侧栏隐藏、列宽≈视口；若上游以后给 composer 加容器，再切 `@container`。

### 会话权威

- hero occupant 直接用 composed `props.sessionId`（确定值），不走 `currentSessionIdOf`。
- 侧栏 fallback 保持现有 `currentSessionIdOf` + `subscribeSessions`，两者互不影响。
- host 端零改动：`{ sessionId }` 继续由 `resolvePanelPrimaryRoot` 按 live session 解析。

### 双入口共存

- 新运行时：新会话行一个 `Folders`，侧栏底部一个 `Folders`；同一对话框、同一套 RPC、同一份文案。
- 旧运行时：只有侧栏入口。
- 不做去重、不做优先级判断；两份 trigger 代码共用对话框与 `t()`，只新增外观。

### 类型与依赖

- type-only 导入 `@deepseek-ai/dsh-client-ui-conversation/client`，取得 `conversation.hero.options` 的 `SlotMap` 声明。
- `devDependencies` 增加精确 pin `"@deepseek-ai/dsh-client-ui-conversation": "0.2.2-rc.1"`；不放进 `dependencies` / `optionalDependencies` / `peerDependencies`。
- `pnpm install` 更新 `pnpm-lock.yaml`；`compat:check` 确认运行时依赖规则未被破坏。

## Implementation

### Phase 0 — 准备

- [x] 加 devDependency，`pnpm install`，确认类型可解析。
- [x] `pnpm typecheck` 确认 type-only 导入无运行时引用。

### Phase 1 — 组件与样式

- [x] 新增 `src/client/HeroWorkspaceEntry.tsx`：trigger（icon + label）+ 复用 `WorkspaceFoldersDialog`。
- [x] `src/client/styles.ts`：`.mrfw-heroEntry` / `.mrfw-heroEntryIcon` / `.mrfw-heroEntryLabel` + 560px 媒体查询。
- [x] 导出组件供单测渲染。

### Phase 2 — 注册

- [x] `src/client/index.ts` 增加 `HERO_SLOT_ID`、`HERO_ORDER` 和独立的 `ctx.slots.inject('conversation.hero.options', ...)`。
- [x] **不动** `sidebar.footer.action` 注册及其 occupant。

### Phase 3 — 测试

`tests/client-panel.spec.tsx`：

- [x] `mount({ filesActions?, heroOptions? })`；`slots.inject` 白名单加 `conversation.hero.options`，仅在该 flag 时调用回调。
- [x] 注册：`id === 'multi-root-folders.hero'`、`order === 10`、`locale === NS`。
- [x] 共存：同一 harness 下侧栏注册仍在，渲染侧栏 occupant 仍出现 `Folders` 按钮。
- [x] 旧运行时：默认 harness 无 hero 注册，侧栏入口照旧。
- [x] 会话权威：以 `{ sessionId: 'session-9' }` 渲染 hero occupant，点开后 `list` 的 payload 是 `session-9`。
- [x] 形态：hero trigger 只有图标与可见文字 label，没有 chevron/展开箭头元素（`container.querySelector` 断言）。
- [x] StrictMode 渲染无重复 `list`。

`tests/client-styles.spec.ts`：

- [x] `.mrfw-heroEntry` 含 `min-height: 28px`、`padding: 0 8px`、`border-radius: var(--dsw-radius-sm)`、hover/open 使用 `var(--dsw-alias-interactive-bg-hover)`。
- [x] 无字面颜色。
- [x] 存在 `@media (max-width: 560px)`，且其中 label 为 `display: none`、按钮为 28px 宽。
- [x] 不存在 `.mrfw-heroEntryChevron` 规则。

`tests/client-bundle.spec.ts` 不变（无新运行时 import）。

### Phase 4 — 文档

- [x] `README.md` / `README.en.md`：新会话行 `Folders` 入口（外观同工作区/模式选择器，无下拉箭头，窄窗图标）；侧栏动作保留。
- [x] `docs/guide/README.md` / `.en.md`：面板侧行为补充 hero 入口与窄窗行为。
- [x] `docs/requirements/multi-root-workspace.md`：§UI/已知限制：新增 seat、形态约束（无 chevron）、560px 图标降级、侧栏保留、退役延后。
- [x] `docs/architecture/multi-root-workspace.md`：Client 半部：双入口、各自 scope/权威、样式与断点。
- [x] `docs/decisions/ADR-0037-*.md`（本 ADR）与索引。
- [x] `CHANGELOG.md` / `CHANGELOG.en.md`：下个版本 Added：新会话行入口；侧栏入口保留。
- [x] `.agent/note/dsh-compat-contract.md` / `.en.md`：`conversation.hero.options` 可用版本与“缺席即无该入口、侧栏不受影响”。
- [x] 本计划归档到 `docs/plans/completed/` 并在进度总账登记批次。

## Validation

```sh
pnpm install && pnpm lint && pnpm typecheck && pnpm build
pnpm test && pnpm compat:check && pnpm docs:check
pnpm smoke:compose && pnpm smoke:behavior && pnpm smoke:journey
pnpm pack:check && pnpm smoke:packed
```

手工验收：

1. 新会话页出现 workspace tree 图标的 `工作区目录 / Folders`，与相邻两个选择器同高、同字号、同 hover 底色，但没有下拉箭头；点击打开同一对话框，`list` 的 `sessionId` 是当前 blank session。
2. 侧栏底部 `Folders` 入口仍在、行为不变。
3. 窗口缩到 ≤560px：入口只剩图标，`aria-label` / `title` 仍可识别；≥561px 恢复文字。
4. 发出第一条消息后 hero 行消失，侧栏入口照常可用。
5. 旧运行时只有侧栏入口，行为与今天一致。

## Risks

| 风险 | 处理 |
|---|---|
| 视口媒体查询 ≠ 列宽（无容器祖先） | 560 与宿主 compact 步进对齐；文档注明近似；上游若加容器再切 `@container` |
| 没有 chevron 后与两个选择器“看起来不一样” | 有意的语义差异：按钮 vs 下拉；同高/同字号/同 hover 保证同一视觉族 |
| 双入口让用户疑惑 | 文案/图标一致，README 说明两者等价；退役决策在合入 main 后处理 |
| 两份 trigger 漂移 | 共用对话框与 `t()`，只新增外观；样式测试钉住几何与断点 |
| `ui-conversation` devDep | 仅类型与 lockfile；运行时依赖规则不受影响 |
| 上游改名/移除该槽 | 注册静默缺席，侧栏入口不受影响 |

回滚：删除 hero 注册与 `HeroWorkspaceEntry` 即回到当前行为；无数据/协议迁移。

## Documentation Impact

本计划的文档改动清单即 Phase 4。ADR-0037 记录 seat 增量、形态复用、无 chevron 的理由、窄窗策略与侧栏退役 Deferred；兼容笔记记录槽的可用版本与降级；CHANGELOG 记录用户可见变化；进度总账登记批次与实施证据。

## Completion Criteria

- [x] 新运行时 `conversation.hero.options` 出现插件入口，形态与 workspace / 模式选择器一致（无 chevron），点击打开同一对话框，`sessionId` 来自槽属性。
- [x] `≤560px` 只显示图标，`aria-label` / `title` 可读；`≥561px` 显示文字，label 省略号收缩。
- [x] `sidebar.footer.action` 入口与行为**完全不变**。
- [x] 无 host 侧改动、无新 RPC、无授权面变化。
- [x] 单测覆盖注册、共存、旧运行时缺席、会话权威、无 chevron、StrictMode；样式测试覆盖几何/token/560px 分支。
- [x] `pnpm verify:all`、`compat:check`、`docs:check` 全绿；支持矩阵两条车道通过。
- [x] 文档、ADR-0037（含退役 Deferred）、CHANGELOG、进度总账同步完成。

## Progress

| 阶段 | 状态 | 证据 |
|---|---|---|
| 前置事实核对 | 完成 | 上游 `contract/slots.ts`、`ConversationContent.tsx`、`ConversationRoot.module.css`；`git log -S` 确认 `3f1d5dfcfa` 为 `0.2.1-alpha.3` 引入 |
| ADR-0037 | 完成 | `docs/decisions/ADR-0037-conversation-hero-workspace-folders-entry.md` |
| Phase 0 | 完成 | `@deepseek-ai/dsh-client-ui-conversation@0.2.2-rc.1` 入 `devDependencies`；`pnpm install`、`pnpm typecheck` 通过 |
| Phase 1 | 完成 | `HeroWorkspaceEntry.tsx`；`styles.ts` 的 `.mrfw-heroEntry*` 与 560px 媒体查询 |
| Phase 2 | 完成 | `client/index.ts` 的 `HERO_SLOT_ID` / `HERO_ORDER` 与独立 `slots.inject`；侧栏注册未改 |
| Phase 3 | 完成 | 新增 6 个 hero 用例、4 个样式用例与图标 fallback 用例；完整套件 1234 passed / 95 skipped / 0 failed（完整本机权限，含图标 fallback、右内缩与不独占断言） |
| Phase 4 | 完成 | README、guide、requirements、architecture、ADR、CHANGELOG、兼容笔记已更新；计划归档与总账已登记 |
| 完整验证 | 完成 | `pnpm verify:all` 通过；compose 54/54、behavior 137/137、journey 76/76、packed behavior 136/136；`smoke:auto-review` 按精确版本跳过 |
| 真实 GUI 目检 | 完成 | 入口/对话框/两处共存与窄窗均可见；目检发现首版 `IconSettings` 语义不符，按反馈改为 workspace tree 字形并补 fallback；随后改为文字在左、icon 在右，并补 4px 右侧内缩对齐工作区选择器 |

### 目检修订（2026-11-08）

真实 GUI 目检确认了入口位置、几何、无 chevron、双入口与窄窗形态；同时发现首版 `IconSettings` 的齿轮语义不适合“工作区目录”入口。按反馈改为 workspace tree 字形：新运行时用 `IconWorkspaceTreeOutlineRegular`，旧运行时回退 `IconFolderOpen`。随后按右对齐行的阅读顺序把 trigger 内结构改为**文字在左、icon 在右**，并补 DOM 顺序断言；再按行左右内边距的差异补 `margin-right: 4px`，使按钮盒左右各 20px、ink 各 28px。适配层新增 `selectIconOr` 与 fallback 单测；样式测试同时钉住 4px 右内缩与“不 grow / 不绝对定位 / 不占满宽度”，确认它不会独占 list 槽。注册、RPC、授权与窄窗行为均未改变。

### Evidence

```text
pnpm install          通过（锁文件已更新）
pnpm typecheck        通过
pnpm lint             通过（0 warnings / 0 errors）
pnpm build            通过（lib/client.js 418.34 kB）
pnpm test             完整本机权限：1234 passed / 95 skipped / 0 failed
pnpm compat:check     通过（allowlist / peers / dev pin / installed tree 一致）
pnpm docs:check       通过
pnpm verify:all       通过（含 kernel:probe、smoke、pack:check、smoke:packed、auto-review:fork）
  smoke:compose       54 passed / 0 failed / 0 skipped
  smoke:behavior      137 passed / 0 failed / 0 skipped
  smoke:journey       76 passed / 0 failed / 0 skipped
  smoke:packed        136 passed / 0 failed / 0 skipped
  pack:check          184 members, complete
  smoke:auto-review   skipped（可选集成的精确基线为 DSH 0.2.1-rc.2）
```

说明：在 DSH 工具沙箱内直接运行完整套件时，共享 Registry 的 follower/IPC 用例会以 `contended` 失败（日志报告 `shared IPC refuses sandboxed peers`）；同一用例在未改动的 main 基线工作树上以相同形状失败，确认是环境限制。上述 1234 passed 是在完整本机权限下重跑的结果，与 `v0.1.16` 发版验收记录的处理方式一致。

进度与发布状态的唯一真源仍是 [Multi-root Workspace 进度总账](../active/2026-09-12-multi-root-workspace.md#进度总账)；本表只记录本计划的阶段状态。
