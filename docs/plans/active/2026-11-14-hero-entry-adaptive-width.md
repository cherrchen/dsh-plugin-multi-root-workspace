# 新会话 Hero 入口按可用宽度自适应（Workspace Folders）

> 状态：**P1/P2 已完成，P3 进行中**（2026-11-14）。P0 取证、P1 实施与 P2 文档已完成；决策修订见 [ADR-0037](../../decisions/ADR-0037-conversation-hero-workspace-folders-entry.md) 文末修订节。

## Goal

新会话页工作区行右端的 Workspace Folders 入口（`conversation.hero.options`）不再把整行向右撑出输入卡宽度：它像相邻两个选择器一样随可用宽度收缩（label 省略号），并在可用宽度低于阈值时退化为 28×28 图标按钮。**不修改 DSH 的任何行为**（不改上游 DOM、样式、插槽契约），只调整插件自己的 DOM/CSS/JS。

## Background

入口在 `v0.1.17` 引入（[ADR-0037](../../decisions/ADR-0037-conversation-hero-workspace-folders-entry.md)），首版用视口媒体查询 `@media (max-width: 560px)` 退化图标。真实 GUI 里出现两个问题（用户截图 2026-11-14）：

1. 入口不随窗口变窄压缩，始终按 label 全宽占据行尾；
2. 列宽不足时它向整行右缘之外溢出（图中按钮越过输入卡右边界）。

### P0 取证（已执行）

上游事实（本机安装的 `@deepseek-ai/dsh-client-ui-conversation@0.2.2-rc.3`，与 `0.2.2-rc.1` 源码一致）：

```css
/* ConversationRoot.module.css */
.heroWorkspaceRow { display: flex; align-items: center; gap: 2px; min-width: 0; padding: 0 16px 0 20px; }
.heroOptions       { display: flex; flex: none; align-items: center; gap: 2px; min-width: 0; margin-left: auto; }
```

- `.heroOptions` 是 slot outlet 的容器，**`flex: none`**：它不参与收缩，宽度恒为内容 max-content。插件条目因此是纯加法，行宽不够时整行溢出。
- 相邻的 workspace 选择器与模式选择器是 `.heroWorkspaceRow` 的直接 flex 子项（默认 `flex-shrink: 1`），所以它们能收缩；模式选择器用 `AgentPresetSeat.module.css` 的 `min-width: 54px; max-width: 100%` 作为 icon+chevron 下限，label 省略号收成 0 —— 这就是"横向压缩宽度自适应"的真实机制。
- 条目的 `max-width: min(100%, 240px)` 的 `100%` 相对 `.heroOptions` 解析，而后者宽度由内容决定（循环引用 → 视为 auto），因此该上限从未生效。
- hero 行没有 `container-type`（`container-type` 只出现在会话标题行 `.titleRow` 与输入卡），视口媒体查询与列宽无关：侧栏/右侧面板改变的是列宽而不是视口宽度，所以 `≤560px` 在真实 GUI 里不会触发。

实测（Playwright + Chromium，按上述上游规则 + 当前插件样式复刻行结构；label `Workspace folders`）：

| 列宽 | workspace chip | 模式选择器 | 当前入口 | 行溢出 |
| --- | --- | --- | --- | --- |
| 700 | 207 | 108 | 143 | 0 |
| 480 | 207 | 86 | 143 | 0 |
| 430 | 207 | 54 | 143 | **14** |
| 380 | 207 | 54 | 143 | **64** |
| 300 | 207 | 54 | 143 | **144** |

即：两个上游控件在 480/430 已经收缩，插件条目宽度恒为 143px，从 430 起整行右边溢出。这解释了截图里的两个现象。

## Current State

- 组件：`src/client/HeroWorkspaceEntry.tsx` —— `<button class="mrfw-heroEntry">`（label 在前、icon 在后）+ 同目录对话框。
- 样式：`src/client/styles.ts` 的 `.mrfw-heroEntry*`（28px 高、`0 8px`、4px gap、`max-width: min(100%, 240px)`）+ `@media (max-width: 560px)` 图标退化。
- 测试：`tests/client-panel.spec.tsx`（形态、aria、共存、StrictMode）、`tests/client-styles.spec.ts`（几何/断点）。
- 兼容矩阵 `0.1.5-rc.2` ～ `0.2.2-rc.3`；`conversation.hero.options` 从 `0.2.1-alpha.3` 起存在。

## Scope

- `conversation.hero.options` occupant 的宽度自适应：几何测量模块、seat 包装、状态属性与样式。
- 退化到图标时的可访问性（`aria-label` / `title` 保持）。
- 单测（几何函数、组件状态、样式钉扎）与文档/ADR 修订。
- 上游结构探针失败时的安全退化路径。

## Non-goals

- 不改 DSH：不注入/覆盖上游 class、不改 `.heroOptions` 的 `flex`、不改上游 DOM、不伪造 container、不改插槽契约。
- 不动注册（`HERO_SLOT_ID` / `HERO_ORDER` / `spec` 门控）、对话框、RPC、授权模型、会话权威。
- 不改侧栏 `Folders` 入口。
- 不为布局引入新的运行时依赖（不引 Playwright 等浏览器测试栈）。

## Design

### 机制：测"行内剩余空间"，把入口夹进去

上游不给容器、也不允许我们改 `.heroOptions`，因此插件只能测出自己的可用余量，再用 `max-width` 夹住自己：

1. **探针**：把 seat 临时置为图标下限（`data-measuring`，28px、无 label），此时上游控件处于**自然宽度**（不会被我们的 label 挤压）；读取 seat 左缘与它左侧最近一个盒子的右缘之差，加上 flex gap，即"行愿意留给我们的空间"。恢复属性后写入状态。
2. **夹取**：`--mrfw-hero-entry-room` = `28 + 余量`（px），`.mrfw-heroEntry { max-width: min(240px, var(...)) }`。余量耗尽时按钮正好贴住左邻，不产生溢出。
3. **阈值**：`room < 88px` → `data-size="compact"`，28×28 图标（`88 = 16 icon + 4 gap + 16 padding + 4×13px 文字`）。
4. **重测**：`ResizeObserver` 观察行与行内非本 seat 的盒子（列宽、标题、语言变化都会改宽度）；每次渲染的 layout effect 也补测（locale 变化等）。

与上游的优先级关系：入口只取上游控件自然宽度之外的余量，**不挤压上游控件**；窗口继续变窄时先由上游 chip 自己按 `flex-shrink` 收缩（它们比我们更能表达"省略"），我们的余量随之归零并退化为图标。

### 失败退化

`heroRowOf` 找不到已知的行结构（上游改结构、测试环境无布局）→ 返回 `null` → 组件不写 `data-size` / 自定义属性 → 样式回落到今天的形态：`max-width: min(240px, ...)` 与 `:not([data-size])` 作用域内的 `≤560px` 视口媒体查询。入口仍可用、可点，行为与 `v0.1.19` 一致。

### 结构

```tsx
<span
  className="mrfw-heroEntrySeat"
  ref={seat}
  data-size={form}                       // 'full' | 'compact'，未测出时不写
  style={room === null ? undefined : { '--mrfw-hero-entry-room': `${room}px` }}
>
  <button className="mrfw-heroEntry" …>{label}{icon}</button>
</span>
```

- 包装 `display: inline-flex`、`min-width: 0`、`max-width: 100%`，`margin: 0 4px 0 0` 从按钮移到包装（行内 ink 位置不变）。
- `:is([data-measuring], [data-size='compact'])` 共用 28px 图标形态；`data-measuring` 只在探针同步执行期间存在。
- 无 DOM 结构依赖落在上游 class 上：只依赖"slot outlet 是 `display: contents`、某祖先 flex 行、前一个兄弟是盒子"这三条可通过探针自证的事实（见 ADR-0037 修订节）。

### 几何模块（`src/client/hero-entry-room.ts`）

| 导出 | 职责 |
| --- | --- |
| `HERO_ENTRY_ICON_PX` | 28：图标形态宽度，也是探针的固定宽度 |
| `HERO_ENTRY_LABEL_MIN_PX` | 88：显示 label 的最小可用宽度 |
| `heroRowOf(seat)` | 跳过 `display: contents` 祖先后的第一个 flex 行；否则 `null` |
| `heroRowWidthTargets(row, seat)` | 行本身 + 行内不含 seat 的盒子（RO 观察集） |
| `measureHeroEntryRoom(seat)` | 置 `data-measuring` → 读余量 → 恢复 → `28 + max(0, 余量)`；行不可识别时 `null` |
| `heroEntryForm(room)` | `'compact' | 'full' | undefined`（纯函数） |

`display: contents` 的 slot anchor 没有自己的 box（`getClientRects()` 为空），因此"前一个盒子"要沿 contents 包装向下找最后一个有盒子的后代——这样同槽其他插件的条目（如 forge worktree，order 0）也会被正确扣除。

## Implementation

### Phase 0 — 取证与计划（完成）

- [x] 以上游 rc.3 源码核对 `.heroOptions` / `.heroWorkspaceRow` / 两个相邻选择器的收缩规则。
- [x] Playwright 复刻行结构，量化"不收缩 + 溢出"（见上表）。
- [x] 原型验证"探针 + 夹取 + 阈值"方案：430px 列宽下入口 143→28、溢出 14→0；450px 下 92px 省略号形态；560px 以上保持全宽 label；两次探针结果稳定（无抖动）。
- [x] 本计划、ADR-0037 修订节、索引。

**退出条件**：计划文档入库；根因与方案有可复现证据；方案不涉及上游改动。

### Phase 1 — 几何模块与组件接入

- [x] 新增 `src/client/hero-entry-room.ts`（常量、行探针、余量测量、形态函数），导出 JSDoc 覆盖参数/返回/前提。
- [x] `HeroWorkspaceEntry.tsx`：seat 包装、`data-size`、`--mrfw-hero-entry-room`、layout effect 探针、`ResizeObserver` 观察集与释放；注册、对话框、`aria-*`、`title` 不变。
- [x] `styles.ts`：seat 包装、room 变量、`:is([data-measuring],[data-size='compact'])` 图标形态、回退媒体查询作用域改到 `:not([data-size])`。
- [x] `tests/client-hero-room.spec.ts`：行识别、contents 下钻、组预算、同槽条目扣除、gap、`null` 退化、形态阈值边界（87/88/89）。
- [x] `tests/client-hero-entry.spec.tsx`：包装与状态属性、图标形态、回退形态、重测（RO 回调与重渲染）、观察集、卸载断开、StrictMode。
- [x] `tests/client-styles.spec.ts`：新规则与回退作用域；删除旧的 560px 无条件断言。

**退出条件**：`pnpm lint`、`pnpm typecheck` 通过；新增/更新的 client 测试通过（`pnpm build && pnpm test`）；样式测试钉住"未测出 = 旧行为"。**已满足**：lint/typecheck 通过；18 个 `tests/client-*` 文件 316 项通过；生产模块 + 生产样式表的 Chromium 复核见下。

### Phase 2 — 文档与决策

- [x] ADR-0037 修订节：机制（测余量、不挤压上游、阈值）、为何不用容器查询/媒体查询、对上游 DOM 的三条探针事实、失败退化。
- [x] `docs/decisions/README.md` / `.en.md` 索引行更新。
- [x] `README.md` / `README.en.md`：删掉"`≤560px` 只显示图标"，改为"随行内可用宽度收缩，余量不足 88px 时只显示图标"。
- [x] `docs/guide/README.md` / `.en.md`、`docs/requirements/multi-root-workspace.md`、`docs/architecture/multi-root-workspace.md` 同步。
- [x] `docs/plans/README.md` / `.en.md` 的 active 列表登记本计划。
- [x] `.agent/note/dsh-compat-contract.md` / `.en.md`：hero 行结构探针与支持版本的关系。

**退出条件**：`pnpm docs:check` 通过；文档不再承诺视口断点，且明确"不改 DSH"。**已满足**。

### Phase 3 — 门禁、真实 GUI 复核与 Draft PR

- [x] `pnpm lint`、`pnpm typecheck`、`pnpm build`、`pnpm docs:check`、`pnpm compat:check`、`pnpm pack:check` 通过。
- [x] `pnpm test` 的 client 面全绿：18 个 `tests/client-*` 文件、316 项。完整套件在本机 DSH 工具沙箱内另有 17 项既有失败（见下），与本变更无关。
- [ ] 真实 GUI 复核（手工，留给评审者/用户）：宽列全宽 label；缩窄时省略号；再窄时 28×28 图标且不越过输入卡右缘；打开右侧预览面板（列宽变窄但视口不变）同样生效；切换长标题工作区/语言后仍不溢出。
- [x] `git push` + Draft PR，描述含根因、机制、探针事实、退化路径与验证记录。

**沙箱限制（既有，非本变更引入）**：DSH 工具沙箱内 `nativeHostAvailability()` 返回 `{ available: false, reason: "the Host itself is sandboxed; shared IPC refuses sandboxed peers" }`，因此共享 Registry 的 follower/IPC 用例（`registry-lease`、`registry.spec` 的 follower 分支、`registry-multiprocess`、`skills-*`、`authority-boundaries`、`b9-review-regressions`）以 `contended` 失败。把本变更 stash 后在未改动的基线树上重跑其中三个代表文件，出现同样形状的 8 项失败；完整件 `v0.1.17` 的计划也记录了同一限制。一次带完整本机权限的重跑尝试因本会话没有可用的批准应答者而未执行（命令未启动），因此本计划不声称"完整套件全绿"。

**退出条件**：上述命令全绿；手工复核项逐条记录；Draft PR 已创建并链接本计划。

## Validation

```sh
pnpm lint && pnpm typecheck && pnpm build && pnpm test
pnpm docs:check && pnpm compat:check && pnpm pack:check
```

### P1 验证（生产几何模块 + 生产样式表，Chromium）

把 `src/client/hero-entry-room.ts` 用 esbuild 编成 IIFE、把 `src/client/styles.ts` 的样式表原文，连同上游 rc.3 的行规则一起加载到 Chromium，按组件的方式写 `data-size` 与自定义属性后测量：

| 列宽 | room | 形态 | 入口宽 | 行溢出 |
| --- | --- | --- | --- | --- |
| 700 / 620 / 560 / 520 | 341 / 261 / 201 / 161 | full | 149（自然宽度） | −4 |
| 480 | 121 | full | 121（省略号） | −4 |
| 450 | 91 | full | 91（省略号） | −4 |
| 430 | 71 | compact | 28 | −4 |
| 400 / 380 / 340 | 41 / 28 / 28 | compact | 28 | −4 |
| 300 | 28 | compact | 28 | 29 |

- 负的"行溢出"表示按钮盒在行的内容右缘以内 4px（seat 的右外边距）；`430` 起入口不再贡献溢出。
- `300px` 的 29px 溢出与入口无关：上游 workspace chip（207）+ 模式选择器（54，已到 icon+chevron 下限）+ 入口（28）+ gap/padding 本身已超过列宽；入口此时已是图标下限。
- 长标题（360px workspace chip）：620px 列宽 room 107 → full 且省略号、无溢出；560/520 退化为图标、无溢出；460px 列宽 22px 溢出同样来自上游三件套的下限。
- 同槽另一个条目（93px，模拟 forge worktree）：700px 列宽入口仍为自然 149px；560px 时 room 106 → 省略号；520px 时 room 66 → 图标；全程无溢出。扣除规则正确。
- 两次连续探针的 room 与入口宽一致（无抖动）。

手工验收（真实 GUI）：

1. 宽列（≥560px 列宽）：入口显示完整 label，几何与相邻选择器一致。
2. 逐步缩窄：label 以省略号收缩，按钮右缘始终不越过输入卡右边界。
3. 余量 < 88px：28×28 图标，`aria-label` / `title` 仍可识别。
4. 打开右侧预览面板（列宽变窄、视口不变）：同样按列宽退化 —— 这正是旧视口断点失效的场景。
5. 切换到长标题工作区或切换界面语言：重新测量，不溢出。

## Risks

| 风险 | 处理 |
| --- | --- |
| 探测依赖上游行结构（`.heroOptions` 在 flex 行内、slot anchor 为 `display: contents`） | 探针只认结构自证的三条事实；认不出即回落到旧形态，不抛错、不影响可用性；ADR 记录该耦合 |
| 探针期间的强制重排 | 只在 layout effect 与 RO 回调内做一次同步读写（seat 置 28px 再恢复），列宽不变时不触发额外回调 |
| 观察集导致重测抖动 | 只观察行与非本 seat 的盒子；探针对自身宽度无依赖，重复测量结果稳定（原型两次探针一致） |
| 阈值 88px 与其它语言/字号不符 | 阈值＝16 icon + 4 gap + 16 padding + 4 个 13px 字符；其余仍可省略号显示，阈值只决定"是否值得显示文字" |
| 其他插件同槽条目 | 余量从"最近的前一个盒子"算起，contents 下钻包含其他插件的条目；条目在最右端时语义明确 |
| `ResizeObserver` 在测试环境缺失 | 产品代码不写防御分支；测试用 `vi.stubGlobal` 提供桩，浏览器端（Electron/Chromium/WebKit/Gecko）均原生支持 |

## Documentation Impact

本计划的 Phase 2 即文档清单。ADR-0037 修订节是唯一决策之家；README/guide/requirements/architecture 只更新对用户可见形态的描述；plans 索引登记本计划；CHANGELOG 按仓库惯例在发版准备提交里更新，不在本变更内。

## Completion Criteria

- [ ] 入口宽度 = `min(240px, 行内余量)`，任何列宽下右缘不超出输入卡；余量 < 88px 时为 28×28 图标。
- [ ] 宽列保持今天的形态（无视觉回归），图标形态保留 `aria-label` / `title`。
- [ ] 上游 DOM/CSS/插槽契约零改动；无新依赖、无新 RPC、无 host 侧改动。
- [ ] 探针认不出行结构时回落到 `v0.1.19` 的形态（不抛错、不空白）。
- [ ] 单测覆盖几何函数、形态阈值、重测与卸载；样式测试钉住新规则与回退作用域。
- [ ] `lint / typecheck / build / test / docs:check / compat:check / pack:check` 全绿。
- [ ] Draft PR 已创建，描述含根因、机制、证据与验证记录。

## Progress

| 阶段 | 状态 | 证据 |
| --- | --- | --- |
| P0 取证与计划 | 完成 | 上文实测表；原型在 430/450/480/560/700px 列宽下的入口宽度与行溢出；ADR-0037 修订节；提交 `docs(plan): investigate the hero entry's width overflow and record the plan` |
| P1 几何与组件 | 完成 | `src/client/hero-entry-room.ts`、`HeroWorkspaceEntry.tsx`、`styles.ts`；`tests/client-hero-room.spec.ts`（15）、`tests/client-hero-entry.spec.tsx`（8）、`tests/client-styles.spec.ts`（25）；生产模块 + 生产样式表的 Chromium 表见上；提交 `fix(client): fit the hero entry to the row's leftover width` |
| P2 文档 | 完成 | ADR-0037 修订节、decisions README 双语索引、README/README.en、guide 双语、requirements、architecture、compat note 双语；`pnpm docs:check` 通过 |
| P3 门禁与 PR | 进行中 | lint / typecheck / build / docs:check / compat:check / pack:check 通过；client 面 316 项通过；完整套件只剩 17 项既有沙箱失败（见 Phase 3 的沙箱限制节）；Draft PR 见下 |
