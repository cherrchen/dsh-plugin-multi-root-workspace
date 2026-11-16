# 侧栏 footer 入口：图标与跨两代几何对齐、同槽共存

> 状态：**实施完成（2026-11-16），待验收发版**。[ADR-0044](../../decisions/ADR-0044-sidebar-footer-row-alignment-and-coexistence.md)
> 已 Accepted；分支 `fix/sidebar-buttom-style`；实现提交 `b1bd1d8`。目标：随下一个版本发布（版本号待发布准备
> 确定）。本地门禁、一次性 Chromium 复刻与隔离环境的真实 GUI 目检均已回填 §Progress；
> 2026-11-16 追加 A 修订（按钮高度跟随设置行 occupant，hover 药丸同尺寸，见 Phase 6）。

## Goal

侧栏底部的 Workspace Folders 入口（`sidebar.footer.action` 的 `multi-root-folders` occupant）在两代
受支持 DSH 上都与设置触发行**逐像素对齐**（新几何下也与账号 launcher 对齐），按钮高度与可见设置行
occupant 同高（hover 药丸同尺寸，A 修订），并使用与本插件其他入口
一致的 workspace tree 字形；
当同槽还有其他 footer action 真正渲染时，本入口与该 action **各占一整行、都可点击**（不争抢、不隐藏、
不改动其他插件）。不修改 DSH、不新增依赖、不引入运行时槽位探测。

## Background

### 用户报告（2026-11-16 截图）

截图中侧栏底部是「齿轮 + 工作区目录」（本插件入口），其下方是「⋯ 更多」（未登录时的账号 launcher，
宿主 `settings.launcher` occupant），两行的图标与文字起始位置不一致；用户同时指出本插件其他入口的
图标已经改过（workspace tree），这里仍是齿轮，需要一并改掉；并担心 `sidebar.footer.action` 与其他
插件争抢，询问能否让位。2026-11-16 就争抢策略征求用户意见后，用户选择**方案 A：共存（各占一行）**。

### P0 取证（已在本计划阶段完成）

上游事实用受支持 tag 的源码核对；几何数值用一次性 Chromium headless 复刻宿主 CSS 实测（不新增
依赖，不进入 CI，与 `2026-11-14-hero-entry-adaptive-width.md` 的 Playwright 取证方式相同）。

**1）宿主侧栏行配方有两代，rail 圆角另有一条更早的分界。** 行几何：旧配方（`0.1.5-rc.2` …
`0.2.1-rc.5`，19 个版本）行包装 `width: calc(100% + 4px); margin: 4px -2px`，按钮
`padding: 0 10px 0 8px`、gap 8px、r12，列 inline padding 12px；新配方（`0.2.2-alpha.2` …
`0.2.2-rc.3`，5 个版本，含开发 pin）行包装 `width: 100%; margin: 4px 0`，按钮
`padding: 0 calc(var(--dsh-sidebar-row-padding) - var(--dsh-sidebar-paint-inset))` + 3px 透明
`border-inline`、gap `--dsh-sidebar-label-gap`（6px）、圆角 `--dsw-radius-md`（12px），列 inline
padding 8px；分界 commit `86fb01a613`（"align sidebar spacing and enlarge row action targets"），首个
受支持 tag `dsh-v0.2.2-alpha.2`。**rail 圆角独立**：`0.1.5-rc.2`、`0.1.6-alpha.1` 两个最老版本
宿主为 50% 圆形，`0.1.6-alpha.2` 起（commit `c6b81a75fd`）22 个版本继承 `.trigger` 的 12px
（`86fb01a613` 对 rail 只加 `border-inline: 0` / `background-clip: border-box`）；本插件当前写死
50%，只与最老 2 个版本一致。另：`.triggerRow` 的 `position: relative` 自 `0.1.6-alpha.2` 起存在；
`@media (hover: hover)` 包装自 `0.2.2-alpha.2` 起存在。新几何下账号 launcher 与设置触发行用同一
token 配方（旧几何下账号 launcher 的 padding 不同），因此"与下方行对齐"统一以设置触发行
`.triggerRow / .trigger` 为参照。

**2）当前偏移（复刻实测，288px 宽侧栏，相对侧栏左缘；数值为元素盒左缘，参考行在新几何取
账号 launcher、旧几何取设置触发行）。** 新几何 + 当前样式：本行图标左缘 14、参考行 20（**Δ -6**）；
本行文字左缘 38、参考行 42（**Δ -4**）。旧几何 + 当前样式：18/18、42/42（Δ 0）。
拟议样式两代都是 Δ 0，按钮盒与参考行逐值相同。rail：宿主自 `0.1.6-alpha.2` 起是 12px 圆角方（22 个
版本），当前样式的 50% 圆只与最老 2 个版本一致；拟议 `var(--dsw-radius-md, 12px)` 在这 22 个版本上一致、
最老 2 个版本为已知偏差。

**3）同槽争抢是机制性的。** `.footerActions` 是单行 flex（无 wrap）；每个 occupant 是它的直接
flex 子项（renderer 每槽只发一个 `display: contents` 的 `[data-slot]` anchor）。官方 `ui-cordis` 在
标准 `dsh-web-app` 组合里无条件挂载并永久注册 `cordis-panel` 的 footer occupant（inventory 为空时
渲染 `null`），其 `.layer` 与我们的行都是"整行宽、不收缩"。复刻实测：再加一条渲染中的 Cordis 行
后，本行 left 280 / right 552，整行被推出 288px 列（不可见）。拟议共存规则下两行各占一整行
（left 8、宽 272），icon/label 仍为 20/42；rail 下两个 36px 入口在 x = 10 纵向排列；只有本行时与现状
逐像素相同。

**4）让位不可行/不可取（ADR-0044 §D4）。** `entries/entriesOfSlot/subscribe/getVersion` 在 24 个
版本上都可用，但只能回答"谁注册了"：官方 cordis occupant 永远注册、通常不渲染，按注册数让位会让本
入口在所有标准安装消失；按 id 白名单排除官方行不可推广；"渲染可见"只能靠 DOM 观测，双向让位会
互隐/抖动。生态抽样（balance-simple / vt-quote-bar / crypto-ticker / sidebar-organizer / ego-browser /
better-sidebar）没有"同槽有人注册就隐藏"的先例，实际做法都是 CSS/DOM 布局修补。

**5）编号核对。** 起草时 `ADR-0043` 被两个在飞 worktree 的未合入提案占用
（`feat/additional-file-tree-search` 的 `ADR-0043-additional-root-preview-navigator-search.md`、
`fix/worktree-delete-panel` 的 `ADR-0043-worktree-cleanup-panel-ui.md`），因此本线取 **ADR-0044**；
两条分支先后合入后，前者保留 ADR-0043，后者为消解重号改为 `ADR-0045-worktree-cleanup-panel-ui.md`
（编号口径见 `docs/decisions/README.md`）。本计划文件名同日不重复。

## Current State

| 位置 | 现状 |
| --- | --- |
| `src/client/index.ts:218-243` | footer occupant 注册：`id: SLOT_ID('multi-root-folders')`、`order: 50`、label thunk、`locale: NS`；`owner.wide` 转发给行组件；`dialogOwner: true` |
| `src/client/WorkspaceFoldersAction.tsx:286-345` | 行组件：`.mrfw-triggerRow`（rail 时 `mrfw-railRow`）→ `.mrfw-trigger`；`:338` 用 `IconSettings size={rail ? 18 : 16}`；`:320-322` 注释仍写旧几何（`calc(100% + 4px)` / 18px ink line） |
| `src/client/styles.ts:16-81` | footer 规则：旧宿主配方（`width calc(100% + 4px)`、`margin 4px -2px`、`padding 0 10px 0 8px`、`gap 8px`、r12、rail 50%）；文件头与规则注释声称"mirroring host ui-settings-general trigger"，在 dev pin 上已失真 |
| `src/compat/client-icons.ts:110-116` | `IconWorkspaceTree = selectIconOr(['IconWorkspaceTreeOutlineRegular'], IconFolderOpen)`；`IconSettings = icon('IconSettingsOutline16', 'IconSettingsOutlineRegular')` |
| `tests/client-styles.spec.ts` | 直接对 `STYLES` 正则断言；目前**没有** `.mrfw-trigger*` 断言 |
| `tests/client-panel.spec.tsx` | footer 注册/共存/无槽/对话框 owner 等；jsdom 的 ui-primitives 替身没有 `IconWorkspaceTreeOutlineRegular`，因此 `IconWorkspaceTree` 在测试里回退 folder（`data-icon="folder-open"`） |
| `tests/client-workspace-menu.spec.ts` | 桩 slots 只有 `inject/register`；本计划不新增槽账本调用，故无需扩展桩 |
| 文档 | `README.md:40,296,364` / `README.en.md` 把侧栏入口描述为底部动作、`sidebar.footer.action` 在所有受支持版本都存在；`docs/guide/README.md:96`、`docs/requirements/multi-root-workspace.md:73,140,162`、`docs/architecture/multi-root-workspace.md:209`、ADR-0006 的 footer 配方/图标条款需要同步 |

## Scope

- **S1 图标**：footer occupant 行由 `IconSettings` 改为 `IconWorkspaceTree`（wide 16 / rail 18）。
- **S2 行几何**：`styles.ts` 的 footer 行/按钮/rail 规则改为"宿主 token + 旧值 fallback"的单配方，
  修复两代对齐与 rail 圆角；同步改写 `styles.ts` 与 `WorkspaceFoldersAction.tsx` 中已失真的注释。
- **S3 共存规则**：增加 `[data-slot='sidebar.footer.action']:has(.mrfw-triggerRow)` 的纵向列规则，
  使同槽多 occupant 各占一行。
- **S4 测试**：`client-styles.spec.ts` 钉住 footer 规则（两代 fallback、共存选择器）；
  `client-panel.spec.tsx` 钉住 footer wide/rail 图标与 label 形态。
- **S5 文档与证据**：ADR-0006 Status 修订说明；README/guide/requirements/architecture 的入口描述；
  `.agent/note/dsh-compat-contract`（双语）记录几何分界；真实 GUI/复刻证据回填 §Progress。

## Non-goals

- 不做槽位让位/隐藏、不做渲染可见性探测、不读 `ctx.slots.entries/entriesOfSlot/subscribe`（ADR-0044 §D4）。
- 不改注册的 `id/order/label/locale`、不改 owner `{wide}` 传递、不改 hero / Files compact /
  工作区菜单 / 对话框 / RPC / 授权模型。
- 不改 DSH、不改 SlotMap、不新增依赖、不新增 locale 键、不引入配置项。
- 不改 CHANGELOG 与 `AGENTS.md` 的项目状态（发版准备阶段做）。

## Design

### D1 图标

`WorkspaceFoldersAction.tsx` 从 `../compat/client-icons.ts` 引入 `IconWorkspaceTree`（保留
`IconFolderOpen` 给对话框内部使用，`IconSettings` 若不再被本文件其他位置使用则从 import 移除；
`RootSwitcher.tsx` 的 `IconSettings` 菜单项不动），`:338` 改为：

```tsx
<span className="mrfw-triggerIcon" aria-hidden="true"><IconWorkspaceTree size={rail ? 18 : 16} /></span>
```

理由与兼容：`IconWorkspaceTree` 已是 Hero 入口与工作区菜单项使用的同一常量；它按
`IconWorkspaceTreeOutlineRegular`（0.1.7-alpha.1+）探测，旧版本回退 `IconFolderOpen`（现有测试替身
同样回退），与 ADR-0037 的图标结论一致。颜色由 `.mrfw-trigger` 的 `color` 继承，不新增颜色。

### D2 行几何（唯一配方 + fallback）

`styles.ts` 的 footer 块按 ADR-0044 §D2 的最终 CSS 改写：行包装的
`width: calc(100% + 4px - min(4px, 2 * var(--dsh-sidebar-paint-inset, 0px)))` 与
`margin: 4px calc(-2px + min(2px, var(--dsh-sidebar-paint-inset, 0px)))`；按钮的 `gap` /
`padding-inline`（含旧宿主右 padding 的 `max(0px, 2px - inset)` 补偿）/ `border-inline` /
`border-radius` / `background-clip` 都改为 token + fallback；rail 规则改为
`border-inline: 0; background-clip: border-box; border-radius: var(--dsw-radius-md, 12px)`（22/24 与宿主
一致，最老 2 个版本偏差见 §Background）。行包装补 `position: relative` 与 `0.1.6-alpha.2` 起的宿主一致。
14/22 字号、hover token、transition、16/18 图标尺寸全部保持；`:hover` 保持不包
`@media (hover: hover)`（19 个旧版本一致，5 个新几何版本仅在触屏上有差异）。**按钮高度（A 修订，
2026-11-16）**：初稿的 42px 固定高改为跟随设置行可见 occupant——`0.2.0-rc.1` 起的账号 launcher
未登录 32px / 已登录 44px，`0.1.7-rc.2` 及以前的 42px 设置触发行继续命中 42px 回退，rail 保持
36px；只改高度，20/42 icon/label 墨线不变。根因、备选与决策见
[ADR-0044 §修订二](../../decisions/ADR-0044-sidebar-footer-row-alignment-and-coexistence.md#修订二2026-11-16实施期-gui-复核-a按钮高度跟随设置行-occupant)。

**期望计算值（实施后由 §Validation 的复刻核对）：**

| 属性 | 旧几何（19 版本） | 新几何（5 版本） |
| --- | --- | --- |
| 行包装 width / margin-inline | `100% + 4px` / `-2px` | `100%` / `0` |
| 按钮 padding-left / right | 8px / 10px | 9px / 9px |
| 按钮 border-inline / gap / 圆角 | 0 / 8px / 12px | 3px / 6px / 12px |
| 图标左缘 / 文字左缘（288px 列） | 18 / 42 | 20 / 42（= 参考行） |
| rail 圆角（36×36） | `0.1.5-rc.2` / `0.1.6-alpha.1`：宿主 50%（18px），本插件 12px（已知偏差）；其余 17 个旧版本：宿主与本插件均 12px | 12px（= 宿主） |

同步改写两处注释：`styles.ts:16-19` 与 `WorkspaceFoldersAction.tsx:320-322` 说明"两代宿主配方 +
fallback"的契约，避免留下与新实现矛盾的旧事实。

### D3 共存规则

`styles.ts` 增加（ADR-0044 §D3 的最终规则）：

```css
[data-slot='sidebar.footer.action']:has(.mrfw-triggerRow) {
  display: flex !important;
  flex-direction: column;
  width: 100%;
  min-width: 0;
}
```

DOM 事实（全部受支持版本一致）：`sidebar.footer.action` 的 outlet 是
`<div data-slot="sidebar.footer.action" style="display:contents">`；每个 list occupant 的根节点直接
渲染在它内部，因此 `.footerActions`（单行 flex）的布局子项就是各 occupant 的根。把该 anchor 变成
纵向列后：单 occupant 时布局与 `display:contents` 逐像素相同（实测）；多 occupant 时每个 occupant
各占一整行（宽 100%），本行的 `width: calc(100% + 4px …)` / 居中 rail 规则仍在列内保持原语义。

规则不触碰 `.footerActions`、不触碰其他 occupant 的 DOM/样式；本插件未挂载时选择器不匹配。
`:has()` 不可用的浏览器丢弃该规则 → 宿主单行布局（与今天一致）。选择器里 `.mrfw-triggerRow` 只出现
在 footer occupant 中（Files compact launcher 用 `.mrfw-fileLauncher`，位于其他槽），不会误伤。

### 失败退化

| 条件 | 行为 |
| --- | --- |
| 旧宿主（无 `--dsh-sidebar-*` token） | CSS fallback 命中旧配方，与旧宿主逐像素一致（行/按钮/ink）；rail 圆角见下行 |
| 最老 2 个版本（`0.1.5-rc.2`、`0.1.6-alpha.1`） | rail 由圆形改为 12px（宿主仍为圆形）：已记录的圆角偏差，不影响 ink/布局 |
| 新宿主 | token 命中新配方，与设置/账号行逐像素一致 |
| 浏览器不支持 `:has()` | 共存规则被丢弃，宿主单行布局（今天的行为）；对齐规则不受影响 |
| 宿主 slot anchor 结构变化 | 共存选择器不匹配（无副作用）；对齐规则仍作用于本行 |
| 测试环境无真实 workspace-tree 字形 | compat 回退 `IconFolderOpen`（现有行为）；真实字形由浏览器/旅程覆盖 |

### 改动面

| 文件 | 改动 |
| --- | --- |
| `src/client/styles.ts` | footer 行/按钮/rail 规则 + 共存规则 + 注释 |
| `src/client/WorkspaceFoldersAction.tsx` | 图标 import/JSX；行注释更新 |
| `tests/client-styles.spec.ts` | 新增 footer 规则钉扎（2 代 fallback 值、rail 圆角公式、共存选择器、无字面颜色） |
| `tests/client-panel.spec.tsx` | footer wide（label + 16px 图标、icon 不是 settings）与 rail（无 label、18px、`.mrfw-triggerRail`）断言 |
| `docs/decisions/README.md` / `.en.md`、`docs/plans/README.md` / `.en.md`、进度总账 | 索引与台账行 |
| `ADR-0006`（Status） | 注明 footer 图标/几何由 ADR-0044 修订 |
| README / guide / requirements / architecture | 侧栏入口图标与"同槽共存时各占一行"描述 |
| `.agent/note/dsh-compat-contract.md` / `.en.md` | 记录"侧栏行几何两代分界 0.2.2-alpha.2"quiet trap |

## Implementation

### Phase 0 — 取证与计划（完成）

- [x] 核对 24 个受支持版本的宿主侧栏行配方与分界 tag（`0.2.2-alpha.2`）。
- [x] 一次性 Chromium 复刻两代布局，量化当前偏移（-6 / -4）与拟议配方的 0/0。
- [x] 复刻同槽双 occupant 场景：当前被推出列外；纵向列规则下两行均在列内且对齐保持。
- [x] 核对 `entries/entriesOfSlot/subscribe` API 与 cordis occupant 的常驻/条件渲染事实，形成让位否决依据。
- [x] 编写 ADR-0044 与本计划，更新索引与台账。

**退出条件**：文档入库；`pnpm docs:check` 通过；方案不含上游改动。

### Phase 1 — 图标与行几何

- [x] 按 §D1 替换 footer 图标并清理不再使用的 import。
- [x] 按 §D2 改写 `styles.ts` footer 规则与两处注释。
- [x] `pnpm typecheck`、`pnpm lint` 绿。

**退出条件**：dev pin 上真实 GUI 目检图标/文字左缘与设置行一致（宽/rail）；旧几何 lane 用复刻
核对称仅在旧值命中（见 §Validation）。

### Phase 2 — 共存规则

- [x] 按 §D3 增加纵向列规则与注释（含 `!important` 的理由与 anchor 契约）。
- [x] 复刻验证多 occupant 场景：两行均在 288px 列内、各占整行；rail 下 x 对齐设置 rail。

**退出条件**：单 occupant 与现状逐像素相同；多 occupant 不溢出、不重叠、都可点击。

### Phase 3 — 测试

- [x] `tests/client-styles.spec.ts`：footer 规则钉扎（两代 fallback、rail 圆角
  `var(--dsw-radius-md, 12px)`、`:has()` 共存选择器、颜色只用 `var(--dsw-*)`）。
- [x] `tests/client-panel.spec.tsx`：footer wide/rail 形态与图标（jsdom 替身下断言
  `data-icon="folder-open"` 的 compat 回退；断言不是 `settings`）。
- [x] 跑全量测试：新增 7 条断言在实现前红、实现后绿；focused 125 项全绿。全量 vitest 的 17 项失败全部落在既有的 registry/lease/skills 文件，在剥离本改动的基线上同样失败（本机卷的 registry 内核锁环境限制），非本改动引入，见 §Evidence。

**退出条件**：新增断言在未改实现时红、改后绿；全量 vitest 无新增失败。

### Phase 4 — 文档与兼容笔记

- [x] ADR-0006 Status 加修订说明（不重写历史正文）。
- [x] README（中/英）、`docs/guide`、`docs/requirements`、`docs/architecture` 的侧栏入口描述补图标与
  共存语义。
- [x] `.agent/note/dsh-compat-contract`（中/英）追加 quiet trap：侧栏行几何两代分界
  `0.2.2-alpha.2`、rail 圆角分界 `0.1.6-alpha.2`（最老 2 版偏差）、footer 槽的官方 cordis
  occupant 常驻但可 null 渲染；A 修订再补第四条（设置行高度随登录态 32/44，缺标记回退 42）。
- [x] README 索引与进度总账状态回填。

**退出条件**：`pnpm docs:check` 通过；文档与实现无矛盾。

### Phase 5 — 验收与发版准备

- [ ] 本地门禁：`pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm build`、`pnpm docs:check`、
  `pnpm compat:check`；涉及打包时加 `pnpm pack:check`（本改动只动 client 样式/JSX 与文档，
  不新增导出，仍以最小充分集为准）。
- [x] 真实 GUI 目检：宽/rail 两形态与设置行对齐；用一个临时第二 footer occupant 复刻多占用场景
  （Chromium 复刻或真实动态 Cordis 插件渲染 badge）确认两行共存。（A 修订后的 hover 高度另见 Phase 6。）
- [ ] 回填 §Progress 与台账（commit、PR、CI run）；随后按发布流程更新 CHANGELOG 与
  `AGENTS.md` 项目状态。

**退出条件**：门禁绿、目检截图入 PR、台账更新。

### Phase 6 — 追加：hover 高度跟随设置行 occupant（A 修订，2026-11-16）

- [x] 复现并量化：隔离 web 组合（`0.2.2-rc.3`、未登录）实测本行 hover 药丸 264×42、下方 More
  264×32，宽度/x/圆角/颜色相同，仅高度差 10px；根因是 `0.2.0-rc.1` 起设置行 occupant 换成账号
  launcher（未登录 32 / 登录 44），见 ADR-0044 §Investigation 的高度分界。
- [x] 实现 A：`[data-slot='sidebar']:has(button[data-signed-out='true'|'false']) .mrfw-trigger:not(.mrfw-triggerRail)`
  把高度设为 32 / 44；无该标记的宿主保持 42px，rail 保持 36px；只改高度，其余配方与 20/42
  icon/label 不变。
- [x] `tests/client-styles.spec.ts` 钉扎两条高度规则、42px / 36px 回退与 rail 排除；实现前红、
  实现后 focused 126 项全绿。
- [x] ADR-0044 §修订二、§Investigation 高度分界、D2 高度条款与 CSS、Consequences 同步；
  README/guide/requirements/architecture/compat note 同步；`pnpm docs:check` 绿。
- [x] 隔离环境 GUI 复验：重建并重装插件后，未登录下两行 hover 药丸均 264×32；把 launcher
  标记临时置为已登录后本行 44px（宿主同高）；rail 本行仍 36px；icon/label 仍 20/42。
- [x] hover 宽度（§修订三）：初稿 hover 用 `background` 简写把 `background-clip` 重置为
  `border-box`，实际填充比宿主宽 6px（264 vs 258，两侧各 3px 透明 border）；改用 `background-color`
  长写后两侧绘制填充均为 **258px（11..269）**，并加测试钉扎。

**退出条件**：hover 药丸与设置行同尺寸（两登录态）、无 42px 回退回归、门禁与 docs:check 绿。

## Validation

### 命令

```sh
pnpm typecheck            # host + client 双端；两代兼容写法必须过客户端 typecheck
pnpm lint
pnpm test                 # 全量 vitest（含 client-styles / client-panel）
pnpm build                # 产物构建（client bundle 与类型）
pnpm compat:check         # 依赖/精确版本合同未被改动
pnpm docs:check           # 文档结构、链接与索引
```

矩阵策略：本次改动是纯 client 样式/图标，无版本分支、无新导出、无类型或接口变化；不需要在
`SUPPORTED_DSH_RELEASES` 上新增适配分支，但客户端 typecheck 矩阵会重指全部 devDependency——因此
新样式**不得**使用任何仅新版本存在的 JS/类型符号（CSS 自定义属性只在样式字符串里，类型无关）。

### 真实 GUI 目检（实施者执行，截图入 PR）

1. 在 scratch web/desktop profile 安装当前构建（`build` 后按现有 `dsh plugin` 流程），打开侧栏：
   宽形态下本行图标/文字与下方设置/账号行对齐；折叠后 rail 按钮为 12px 圆角方并与设置 rail 同列
   对齐（新几何宿主与 `0.1.6-alpha.2` 起的旧几何宿主均如此；最老 2 个版本已知偏差，不要求目检）。
2. 多 occupant：在 Dev pin 上用动态 Cordis 插件让官方 Cordis badge 渲染（或一次性 Chromium 复刻），
   确认两行各占整行、都可点击；关闭动态插件后恢复单行。
3. 旧几何宿主（`0.2.1-rc.5`，以及如有条件的最老 2 个版本）至少目检一次：宽形态与设置行对齐不变
   （回归为零）；`0.2.1-rc.5` 的 rail 应同为 12px 圆角方。

### 复刻核实（可选，一次性）

沿用本计划阶段的 Chromium 复刻：宿主 CSS 逐字复制，两代 token 分别构造，量化图标/文字左缘、
行/按钮盒、rail 圆角命中与多 occupant 溢出。实施后把数值回填到本计划 §Progress 的 Evidence 块。

## Risks

| 风险 | 处理 |
| --- | --- |
| `:has()` 在部分浏览器不可用 | 规则被丢弃即回到宿主单行布局（现状），不报错；不支持时用户仍可用单入口，无功能损失 |
| 宿主继续改侧栏行配方 | 两代分界以 tag 核对钉住；下一次支持矩阵提升时按本 ADR 的取值方式增补 fallback，并把新版差异记入 compat note |
| 共存规则影响同槽其他 occupant 的布局 | 只在 share 容器 anchor 上做纵向排列（各占整行），不改写/不排序他人行；本插件未挂载时完全无效；行为写入 README/ADR |
| 单 occupant 时纵向列引入细微差异 | 复刻实测单 occupant 布局与 `display:contents` 逐像素相同；Phase 2 退出条件要求再次核对 |
| 测试替身无真实 workspace-tree 字形 | 断言 compat 回退值（folder）与"不是 settings"；真实字形由浏览器/旅程与 `client-icons.spec` 的探测表覆盖 |
| rail 圆角在最老 2 个版本与宿主不同 | 无 CSS-only 探针可区分 `0.1.6-alpha.2` 边界；采纳 22/24 对齐并把 2 版偏差记入 ADR/compat note；不影响 ink/布局 |
| `styles.ts` 注释与实现漂移 | 本计划已把两处注释列入 Phase 1 改动面，评审时对照 ADR-0044 §D2 |
| 外部评审质疑"为什么不让位" | ADR-0044 §D4 提供三条机制证据（cordis 常驻、账本无渲染态、互隐/不可组合）与生态/仓库先例，并在 Context 记录用户 2026-11-16 的决策 |

## Documentation Impact

| 文档 | 改动 |
| --- | --- |
| `docs/decisions/ADR-0044-…md` | 新增 + 修订二（A：hover 高度跟随设置行，已完成） |
| `docs/decisions/README.md` / `.en.md` | ADR-0044 索引行 |
| `docs/plans/README.md` / `.en.md` | 本计划行（active） |
| `docs/plans/active/2026-09-12-multi-root-workspace.md` | 进度总账新行（批次/编号/计划/ADR/commit/状态） |
| `docs/decisions/ADR-0006-client-ui-host-tokens.md` | Status 修订说明（footer 图标与几何由 ADR-0044 修订；正文不重写） |
| `README.md` / `README.en.md` | 侧栏入口图标、两代对齐、同槽共存行为 |
| `docs/guide/README.md` / `.en.md` | 同上（用户视角） |
| `docs/requirements/multi-root-workspace.md` | UI 需求/已知限制的入口描述 |
| `docs/architecture/multi-root-workspace.md` | Client 半部的 footer 入口几何/共存说明 |
| `.agent/note/dsh-compat-contract.md` / `.en.md` | 四条 quiet trap：行几何分界 `0.2.2-alpha.2`、rail 圆角分界 `0.1.6-alpha.2`（最老 2 版偏差）、cordis occupant 常驻可 null、设置行高度随登录态变化（`0.2.0-rc.1` 起 32/44，缺标记回退 42） |
| `CHANGELOG.md` / `.en.md`、`AGENTS.md` 项目状态 | 发版准备阶段再改，不在实现 PR 里手改 |

## Completion Criteria

- 两代宿主上 footer 入口的图标/文字左缘与设置触发行逐像素一致（新几何下账号 launcher 也对齐）；
  按钮高度与可见设置行 occupant 一致（账号 launcher 未登录 32 / 登录 44，旧代 42px），footer 两行
  hover 药丸同尺寸（高与绘制宽度一致：填充用 `background-color` 长写保留 `padding-box`）；rail 圆角
  在 22/24 版本与宿主一致，最老 2 个版本的偏差按 ADR 记录；旧几何无 ink/布局回归。
- 同槽出现真正渲染的第二 footer action 时，两者各占一整行、均可点击；本插件未挂载时宿主布局不变。
- 不隐藏入口、不观测他人渲染状态、不调用槽账本 API、不改注册选项。
- 新增测试在实现前红、实现后绿；全量 vitest、lint、双端 typecheck、build、docs:check、compat:check 绿。
- 真实 GUI 目检（宽/rail/多 occupant 复刻或真实 Cordis badge）截图与结论入 PR，证据回填本计划。
- ADR-0006/README/guide/requirements/architecture/compat note 同步完成，无遗留"旧几何/齿轮"描述。

## Progress

| 阶段 | 状态 | 证据 |
| --- | --- | --- |
| P0 取证与计划 | 完成（2026-11-16） | 本计划 §Background 的复刻数值；ADR-0044 §Investigation；索引/台账已更新 |
| P1 图标与行几何 | 完成（2026-11-16） | 提交 `b1bd1d8`：footer 图标换 `IconWorkspaceTree` 并移除 `IconSettings` import；`styles.ts` footer 规则改为 §D2 的 token+fallback 配方与注释；`pnpm typecheck` / `pnpm lint` 绿。§Progress 的复刻数值见 §Evidence（新几何 20/42、旧几何 18/42，Δ 0）。 |
| P2 共存规则 | 完成（2026-11-16） | 同一提交：§D3 纵向列规则与注释；复刻单 occupant 与 `display: contents` 逐像素相同（icon 20 / label 42 / 按钮 8..280 宽 272），多 occupant 两行各 8..280 宽 272、无溢出（改动前本行被推到 278..554）。rail 下两行 x 均 10。 |
| P3 测试 | 完成（2026-11-16） | 同一提交：`client-styles.spec.ts` 新增 6 项、`client-panel.spec.tsx` 新增 2 项；实现前 7 项红、实现后 focused 125 项全绿。全量 vitest 见 §Evidence（1848 通过；17 项为既有 registry/lease 环境失败，基线同样失败）。 |
| P4 文档与兼容笔记 | 完成（2026-11-16） | ADR-0006 Status 修订；README 中英、`docs/guide` 中英、requirements、architecture 更新；compat note 中英新增 §21 quiet trap（A 修订后为四条）；`pnpm docs:check` exit 0。 |
| P5 验收与发版准备 | 部分完成（2026-11-16） | 本地门禁（typecheck / lint / build / compat:check / docs:check / focused test）全绿，证据见 §Evidence。**真实 GUI 目检已完成**：隔离 scratch `$DSH_HOME`（临时目录）+ 本仓库构建产物 `dsh plugin add` 进 `web` profile，`dsh web`（host `0.2.2-rc.3`）由 headless Chromium 经 CDP 截图并读取真实 DOM——宽形态本行 icon/label 20/42 与下方宿主行 20/42 一致、rail 两按钮均 36×36 @ x=9.5 且圆角 12px、锚点计算样式 `display:flex/flex-direction:column`、同槽两行各占 264px 整行（第二行是克隆的合成 occupant；官方 cordis occupant 在空 profile 按设计渲染 null）。PR、CI run 与发版准备未做。 |
| P6 hover 高度与宽度跟随设置行（A 修订） | 完成（2026-11-16） | 高度：复现本行 264×42 vs More 264×32（差 10px），两条高度规则（32 / 44，rail 排除，42 回退）后未登录 32/32、模拟已登录 44/44、rail 36。宽度（§修订三）：复现绘制填充本行 264（8..272）vs More 258（11..269），根因是 hover 的 `background` 简写重置了 `background-clip`；改 `background-color` 长写后两侧均 **258（11..269）**。新增测试钉扎（实现前红）；ADR-0044 §修订二/§修订三 + 周边文档。 |

### Review 修正（2026-11-16，外部技术评审）

- **F1（必须修正）**：rail 圆角史更正为 `0.1.6-alpha.2` 起的独立分界（只有最老 2 个版本为圆形）；
  ADR §Context/§Investigation/§D2/§Alternatives/§Consequences、本计划 §Background/§D2/期望值表/失败
  退化/验收/风险/文档清单、索引与台账、compat note 清单均已同步；rail 公式改为
  `var(--dsw-radius-md, 12px)`，接受最老 2 个版本的已知圆角偏差（无 ink/布局影响）。
- **F2**：`:hover` 的 `@media (hover: hover)` 代差在 ADR §D2 记录取舍（保持不包装，与 19 个旧版本
  一致；触屏上与 5 个新几何版本有差异）。
- **F3**：`position: relative` 已补入行包装规则（与 `0.1.6-alpha.2` 起的宿主一致；最老 2 个版本
  没有该声明，本行无定位后代，不影响布局）。
- **F4**：一次性复刻方法已写入 §Evidence，含 token 切换、元素盒读取与 rail 圆角命中测试。
- **F5**：分支名 `fix/sidebar-buttom-style` 的拼写未改动（文档如实引用）；是否改名由维护者在发 PR
  前决定，若改名需同步本计划与台账中的引用。
- **F6**：`docs/decisions/README.md` / `.en.md` 的编号说明已补 ADR-0043 的在飞占用与本线从 0044
  开始；两个在飞分支之间的 0043 重号需由各自分支消解。
- **A（2026-11-16 追加，用户确认走 A）**：实施后 GUI 复核发现 hover 药丸高度与下方 `⋯ More`
  不一致（42 vs 32）。根因是 `0.2.0-rc.1` 起设置行 occupant 换成账号 launcher（未登录 32 /
  登录 44）。按钮高度改为跟随该 occupant（CSS 结构探测，`0.1.7-rc.2` 及以前保持 42、rail 36），
  ADR-0044 §修订二 与 §Investigation 的高度分界记录决策与证据。

### Evidence（实施后回填）

**复刻方法（一次性，可复跑；不引入依赖）。** 取宿主 CSS 逐字复制到本地 HTML：`.sidebar` 根（含
`--dsh-sidebar-*` / `--dsw-radius-md` token 定义与列 padding）、`.footArea` / `.footerActions` /
`.settingsArea`、`.triggerRow` / `.trigger`（两代各一份）、账号 launcher（新几何参考行）或设置
触发行（旧几何参考行）、Cordis `.layer` / `.badge`；slot anchor 用
`<div data-slot="sidebar.footer.action" style="display:contents">`，插件规则用 ADR-0044 §D2/D3 的 CSS
字面量。用 Chromium headless 打开后，`getBoundingClientRect().left` 读 icon/label/按钮盒，
`elementFromPoint` 读 rail 圆角（(3,3)/(4,4) 命中区分 12px 与 50%）。两代证据分别切换 sidebar 根上的
token 定义。

**执行（2026-11-16，本机）**：Chromium for Testing 156.0.8078.4（headless shell，`--dump-dom` 读出内联测量脚本的 JSON）；夹具为 `src/client/styles.ts` 的**生产样式表原文**（改动前版本取 `git show HEAD:src/client/styles.ts`）＋逐字复制的宿主两代 `.root` / `.footArea` / `.footerActions` / `.triggerRow` / `.trigger` CSS ＋官方 cordis `.layer` / `.badge`（rail 用 `.layer.rail`），slot anchor 为 `<div data-slot="sidebar.footer.action" style="display:contents">`。坐标相对侧栏左缘（sidebars 288px 宽 / 折叠 56px）；图标取 `svg` 盒、文字取 label 盒左缘。

- **行几何**（参考行 = 宿主设置触发行）：新几何 + 改动前 14 / 38 对 20 / 42（Δ -6 / -4）；新几何 + 改动后 **20 / 42 对 20 / 42（Δ 0）**；旧几何 + 改动前 18 / 42 对 18 / 42（Δ 0）；旧几何 + 改动后 **18 / 42 对 18 / 42（Δ 0）**。按钮盒：新几何 8..280 宽 272（3px border + 9px padding + 6px gap），旧几何 10..278 宽 268（padding 8/10、gap 8、无 border），与参考行逐值相同。
- **单 occupant 等价**：把 §D3 规则从同一夹具的样式表中移除后，icon 20 / label 42 / 按钮 8..280 宽 272 与含规则时完全一致 —— 纵向列不改变单占用布局。
- **多 occupant**：改动前，cordis 样式的整行 occupant 占 8..280 后本行被推到 **278..554（icon 286 / label 310）**，整行落在 288px 列右界之外；改动后 cordis 行与本行各占 **8..280、宽 272**，本行 icon / label 仍 20 / 42，参考行顺延到 y = 110，`footerActions` 的 `scrollWidth = clientWidth = 272`（无溢出）。
- **rail 圆角命中**（折叠 56px，`elementFromPoint` 相对按钮左上角）：本行与宿主参考 rail 按钮均 10..46（36×36），(3,3) / (4,4) 均命中按钮（Chromium 按 12px 圆角命中）；最老 2 个版本的夹具（宿主 `.trigger.rail { border-radius: 50% }`）在 (3,3) / (4,4) 均**不**命中，本行仍命中 → 已记录的 12px vs 50% 偏差。rail 多 occupant：官方 cordis 36×36 与本行纵向排列（y = 18 / 62，x 均 10）。
- **真实 GUI（隔离环境，2026-11-16）**：scratch `$DSH_HOME` 下 `dsh plugin add` 本仓库构建产物进 `web` profile，`dsh web`（`0.2.2-rc.3`）在 headless Chromium 中打开（一次性 CDP 截图，非仓库依赖）。真实 DOM 测量：footer slot 锚点内联 `display: contents` 被计算为 `display: flex; flex-direction: column`；本行 icon/label 左缘 **20 / 42**，同一列的宿主设置行（未登录账号 launcher）icon/label 也 **20 / 42**（两行 wrapper 均 8..272、宽 264）；按钮计算样式 `padding-inline 9px`、`gap 6px`、`border-inline 3px`、`border-radius 12px`、`background-clip padding-box`；rail（折叠 56px）本行 36×36 @ x=9.5、`border-radius 12px`、`border-inline 0`，与宿主 rail 按钮同 x 同圆角。同槽第二行演示：锚点内两行各 8..272、宽 264、高 42，icon/label 均 20/42、无溢出（该行为克隆的合成 occupant，仅目视；官方 cordis occupant 在空 profile 渲染 null，真实多占用语义由单元测试与上面的复刻覆盖）。截图与临时 harness 均在 gitignore 的临时目录，未入库。
- **门禁输出**：
  - `pnpm typecheck`：exit 0（host + client 双端 + auto-review 类型拷贝）。
  - `pnpm lint`：exit 0，`Found 0 warnings and 0 errors`（346 files / 62 rules）。
  - focused `pnpm vitest run tests/client-styles.spec.ts tests/client-panel.spec.tsx`：**125 passed**（新增断言实现前 7 failed）。
  - `pnpm test` 全量：1848 passed / 17 failed / 165 skipped。17 项全部落在 `tests/registry-*.spec.ts`、`tests/skills-*.spec.ts`、`tests/authority-boundaries.spec.ts`、`tests/b9-review-regressions.spec.ts` 的 registry authority/lease 用例；把本改动的 4 个文件 stash 掉后 `tests/registry-lease.spec.ts` 同样 4 failed（本机卷上 registry 内核锁的环境限制），与本次 client 改动无关。
  - `pnpm build`：exit 0（host ESM + `lib/client.js`）。
  - `pnpm compat:check`：exit 0（24 个精确版本 allowlist、dev pin 与安装树 `0.2.2-rc.3` 一致）。
  - `pnpm docs:check`：exit 0（10/10 checks，0 errors / 0 warnings）。
  - `pnpm pack:check`：未跑——本改动不新增导出、不动 exports/tarball 成员，按计划“最小充分集”只需 client 测试与 build。
- **A 修订（2026-11-16，hover 高度跟随设置行 occupant）**：复现于隔离 web 组合（`0.2.2-rc.3`、未登录）：本行 hover 药丸 264×42（x 8..272），下方 More 264×32（x 8..272），hover 背景 / 圆角 / x 范围相同，仅高度差 10px。实现后真实 DOM 复验：未登录本行与 More 均 **264×32**；把 launcher 的 `data-signed-out` 临时置为 `false` 后本行 **264×44**（与宿主同高）；rail 下本行仍 **36×36**；icon/label 左缘保持 **20 / 42**。宽度复核（§修订三）：初稿 hover 的 `background` 简写把 `background-clip` 重置为 `border-box`，绘制填充本行 264（8..272）vs More 258（11..269）；改用 `background-color` 长写后两侧绘制填充均 **258（11..269）**，并新增测试钉扎（实现前红、实现后 focused 126 项全绿）。新增钉扎实现前红、实现后 focused 126 项全绿；`typecheck` / `lint` / `build` / `compat:check` / `docs:check` 复跑；全量 vitest 仍为既有 17 项 registry/lease 环境失败（无新增）。
- **提交**：实现与测试 `b1bd1d8`；文档、ADR-0006 修订、索引与台账回填随后单独提交；A 修订与 PR 见 §Progress。

