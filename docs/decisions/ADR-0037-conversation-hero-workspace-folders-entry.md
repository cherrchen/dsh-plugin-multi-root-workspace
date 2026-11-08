# ADR-0037: 新会话 Hero 行的 Workspace Folders 入口

## Status

Accepted：增量入口与形态决策定案；2026-11-08 已实施并通过完整门禁（[Workspace Folders Hero 入口计划](../plans/completed/2026-11-08-workspace-folders-hero-entry.md)）。侧栏 `Folders` 入口**不退役**，去留另案决定。

## Date

2026-11-08

## Context

Workspace Folders 目前只有一个入口：侧栏底部 `sidebar.footer.action`（`multi-root-folders`，order 50）。它在所有受支持运行时都存在，但用户开始一个新任务时通常停留在新会话页，侧栏入口离输入区较远；插件因此缺少一个“创建任务阶段就在手边”的入口。

上游从 `0.2.1-alpha.3` 起（commit `3f1d5dfcfa`，`feat(ui-conversation): add the New Session options slot`）提供 `conversation.hero.options`：

```ts
'conversation.hero.options': { kind: 'list'; scope: 'session' }
```

它渲染在 blank session 的 hero 工作区行内、workspace 选择器与模式选择器之后；`.heroOptions` 自带 `margin-left: auto`，因此条目组整体落在整行右端（`packages/client/ui-conversation/src/client/contract/slots.ts`、`skeleton/ConversationContent.tsx`、`skeleton/ConversationRoot.module.css`）。该行为 `session` scope，composed props 带确定的 `sessionId`，不需要全局“当前会话”解析（[ADR-0008](./ADR-0008-panel-session-derived-authority.md)）。hero 行只在 blank session 存在，首条消息发出后整行消失。

同一行的两个相邻控件提供了现成的视觉族：workspace 选择器（`HeroShell.module.css` 的 `.workspace`）与模式选择器（`AgentPresetSeat.module.css` 的 `.seat`）都是 `min-height: 28px`、`padding: 0 8px`、`gap: 4px`、`border-radius: var(--dsw-radius-sm)`、13px/20px/500 字重、hover/展开用 `var(--dsw-alias-interactive-bg-hover)`。它们带有 chevron，因为它们打开菜单；Workspace Folders 打开的是对话框，不是下拉。

`conversation.hero.options` 不在旧运行时上存在：`0.1.5-rc.2` 到 `0.2.1-alpha.2` 都没有该槽。插件的 `slots.inject` 是软接缝，槽缺席时注册静默不触发——旧运行时行为与今天完全一致。

## Decision

1. **纯加法注册。** 在 `conversation.hero.options` 注册 `multi-root-folders.hero`（order 10，排在 forge worktree 默认的 0 之后），与 `sidebar.footer.action` 的 `multi-root-folders` 完全独立：不同槽、不同 id、各自 dispose。不注册 `label`（该槽 owner 不投影 label），文案继续走 `multi-rootWorkspace` 命名空间的 `action.label` / `action.title`。

2. **复用同一个对话框。** 新入口只新增 trigger；`WorkspaceFoldersDialog`、RPC 端点、授权模型、文案和错误码全部复用。入口是“打开对话框的按钮”，不是新的管理器。

3. **按钮语义，无 chevron。** trigger 使用 `aria-haspopup="dialog"` 与 `aria-expanded`，有 `title` 与 `aria-label`；不渲染方向箭头。展开态由底色与 `aria-expanded` 表达。几何与相邻两个选择器同一套：28px 高、`0 8px` 内边距、4px 间距、`--dsw-radius-sm`、13px/20px/500、`--dsw-alias-label-primary`、hover/展开 `--dsw-alias-interactive-bg-hover`、最大宽度 `min(100%, 240px)` 且 label 省略号收缩；图标为 workspace tree 字形 `IconWorkspaceTreeOutlineRegular` 16px（旧运行时回退 `IconFolderOpen`）；因为该行整体右对齐，trigger 内顺序是**文字在前、icon 在后**，让文字朝向行内、字形落在右侧外缘。行本身的左右内边距不对称（上游 `0 16px 0 20px`），所以 trigger 追加 `margin-right: 4px`：按钮盒右侧与工作区选择器左侧同为 20px 内缩，图标/文字 ink 同为 28px。

4. **窄窗口只保留图标。** hero 行没有 `container-type`（上游只给会话标题行与输入卡行设了容器），因此使用**视口媒体查询**，阈值取宿主自己的紧凑步进 `560px`（`InputBar.module.css` 的 compact 断点）：`max-width: 560px` 时按钮 28×28、无 padding、仅图标，名称由 `aria-label` / `title` 承载；`≥561px` 恢复文字，label 以省略号收缩。这是近似而非容器查询：抽屉模式（`<768`）下侧栏隐藏、列宽≈视口；若上游以后给 hero 行加容器，再切换为 `@container`。

5. **会话权威来自槽属性。** hero occupant 直接使用 composed `props.sessionId`，并把读取函数 memoize 成稳定回调（对话框 `refresh` 依赖其身份）；不读 `currentSessionIdOf`。侧栏 fallback 保持现有 `currentSessionIdOf` + `subscribeSessions`，两者互不影响。host 端零改动：`{ sessionId }` 继续由 `resolvePanelPrimaryRoot` 按 live session 解析。

6. **双入口共存，不做门控。** 新运行时同一页出现两个 `Folders`（新会话行 + 侧栏底部），指向同一对话框、同一套 RPC、同一份文案；旧运行时只有侧栏入口。不隐藏侧栏入口、不去重、不做优先级判断。

7. **显式槽位门控，零运行时依赖。** `conversation.hero.options` 的注册走窄结构接口（`inject` + `spec` + `register`），不把 `ui-conversation` 加入任何依赖：typecheck 矩阵包含 `0.2.1-alpha.3` 之前的版本，它们的 SlotMap 没有该键。`slots.inject` 只在槽位声明时触发；回调内再用 `spec` 确认声明存在，查不到就直接返回空 disposer。因此只有声明了该槽的 DSH 版本才会显示入口；旧版本既不注册、也不渲染，侧栏入口不变。

## Alternatives Considered

- **新入口出现即隐藏侧栏入口。** 否决：hero 行只在 blank session 存在，发首条消息即消失；按入口隐藏侧栏会让用户在会话中途失去唯一入口。侧栏退役需要独立决策，本 ADR 明确 Deferred。
- **替换 `conversation.hero.agentPreset`，或把入口夹在 workspace 与 preset 之间。** 否决：那是上游模式选择器的 owner seat（`session-maybe`），替换会抢走既有控件；`conversation.hero.options` 的契约位置就是两个选择器之后、整行右端。
- **带 chevron。** 否决：相邻控件带箭头是因为它们打开 `menu`；本入口打开 `dialog`，箭头会承诺一个不存在的下拉语义。有意的差异，用同高/同字号/同 hover 保证仍属同一视觉族。
- **容器查询。** 否决：hero 行目前没有容器祖先；伪造一个容器会改变上游布局。560px 视口断点与宿主 compact 步进对齐，先接受近似。
- **把管理器做成紧凑下拉。** 否决：对话框承担目录选择器、多行增删改、权限确认和错误展示；压缩成下拉会复制一套交互并失去既有可访问性。
- **加 `conversation.session.header.utilities` 入口。** 推迟：本需求只要求新会话行；header utilities 是后续可选入口，不纳入本次范围。
- **引入对 `ui-conversation` 的运行时依赖（或 type-only devDependency），或改 `dsh.client.inject`。** 否决：typecheck 矩阵的旧版本根本没有这个 SlotMap 键，type-only 合并仍需要额外 pin 与矩阵对齐；窄结构接口加显式 `spec` 门控已经足够，且旧版本的 `inject` 本身就不会触发。运行时依赖更会让旧运行时要求该包存在，破坏“缺席即无该入口、侧栏不受影响”的降级。

## Consequences

- 新运行时新会话页出现 `工作区目录 / Folders`，点击打开同一对话框，`list` 的 `sessionId` 来自槽属性；侧栏入口行为完全不变。旧运行时只有侧栏入口，行为与今天一致。
- 无 host 侧改动、无新 RPC、无授权面变化；这是纯客户端增量。
- 没有 chevron 后，与两个选择器“看起来不一样”是有意的语义差异；同高、同字号、同 hover 底色保证同一视觉族。
- 窄窗形态依赖视口而非列宽：抽屉模式下两者近似；文档注明该近似，上游若给 hero 行加容器再切换 `@container`。
- 双入口可能让用户疑惑：文案与图标一致，README 说明两者等价；侧栏退役在合入 main 后另行处理（Deferred）。
- 两份 trigger 可能漂移：它们共用对话框与 `t()`，只有外观代码各自维护；样式测试钉住几何、token 与 560px 分支，并禁止 `.mrfw-heroEntryChevron` 规则回潮。
- 回滚：删除 hero 注册与 `HeroWorkspaceEntry` 即回到当前行为；无数据、协议或授权迁移。
- 该入口**不独占** `conversation.hero.options`：槽是 `kind: 'list'`，slot outlet 以 `display: contents` 挂在 `.heroOptions` 内，条目是它的直接 flex 子项；trigger 保持 `display: inline-flex`、`min-width: 0`，不设 `flex: 1`、不绝对定位、不占满宽度，因此其他插件的条目（如 forge worktree）可以并排出现。当前隔离组合里只安装了本插件，所以视觉上只有一个条目——这是组合事实，不是 CSS 独占。
- 首版实现使用 `IconSettings`；2026-11-08 的真实 GUI 目检确认齿轮的“设置”语义不符合该入口，改为 workspace tree 字形（`IconWorkspaceTreeOutlineRegular`，旧运行时回退 `IconFolderOpen`），并把 trigger 内顺序改为文字在左、icon 在右。这是纯表现层修正，不改变注册、RPC 或授权。
- 首轮 PR CI 暴露了兼容性边界：`0.2.1-alpha.3` 之前的矩阵版本没有该 SlotMap 键，typecheck 失败。最终实现因此不使用 `ui-conversation` 的类型或依赖，而以 `spec` 作为显式的“该版本是否有此槽”门控；旧版本不显示入口，符合“从第一个支持该槽的版本开始才可用”的要求。
- Review 修正：`spec` 是 `SlotRegistry` 服务公开的声明查询；`specDynamic` 只存在于内部 `SlotCore`，服务不暴露。首版门控误用了后者，真实宿主上会永远返回 `undefined`，导致入口不注册。现在改用公开 `spec`，并以真实 `SlotRegistry`（加载浏览器 bundle）的回归测试钉住；同时在 `0.2.1-alpha.3` repointed 树上实测该槽声明可被探测、入口可注册。
- 上游改名或移除该槽：`slots.inject` 静默不触发，新入口消失，侧栏入口不受影响。

## Related Documents

- [Workspace Folders Hero 入口计划](../plans/completed/2026-11-08-workspace-folders-hero-entry.md)
- [ADR-0005：出树 client 半部与 Connection RPC 通道](./ADR-0005-out-of-tree-client-transport.md)
- [ADR-0006：客户端 UI 消费宿主 token](./ADR-0006-client-ui-host-tokens.md)
- [ADR-0008：面板主根由 host session 推导](./ADR-0008-panel-session-derived-authority.md)
- [DSH 兼容性契约](../../.agent/note/dsh-compat-contract.md)
