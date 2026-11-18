# ADR-0044: 侧栏 footer 入口的宿主行几何对齐与槽位共存

## Status

Accepted（2026-11-16 决策定案；同日外部技术评审后修正 rail 圆角史（F1）；同日实施期 GUI 复核后追加按钮高度规则（A，见 §修订二），实施与验收见计划）

## Date

2026-11-16

## Context

本插件的 Workspace Folders 面板是"侧栏底部动作 + 对话框"：client 半部在
`sidebar.footer.action`（宿主 `ui-sidebar` 声明的 `kind: 'list'`、`scope: 'root'` 槽）注册一个
occupant（`id: 'multi-root-folders'`、`order: 50`、label 为 thunk、文案走 `action.label` /
`action.title`），把 `owner.wide` 转发给行组件（`src/client/index.ts:218-243`）。行组件渲染
`.mrfw-triggerRow` → `.mrfw-trigger`（wide）或 `.mrfw-triggerRail`（rail），点击打开共享的
Workspace Folders Dialog（`src/client/WorkspaceFoldersAction.tsx:286-345`）。样式表是插件唯一
样式源（[ADR-0006](./ADR-0006-client-ui-host-tokens.md)）。

三件事同时成立：

1. **行的几何配方已经过时。** `src/client/styles.ts:16-81` 复刻的是宿主 `ui-settings-general`
   在 2026-09 时代的 `.triggerRow` / `.trigger` 配方（`width: calc(100% + 4px)`、
   `margin: 4px -2px`、`padding: 0 10px 0 8px`、`gap: 8px`、r12）。上游在
   commit `86fb01a613`（"align sidebar spacing and enlarge row action targets"）改为
   paint-inset token 配方：sidebar 根节点声明 `--dsh-sidebar-row-padding: 12px`、
   `--dsh-sidebar-label-gap: 6px`、`--dsh-sidebar-paint-inset: 3px`（`dsh-v0.2.2-rc.3:
   packages/client/ui-sidebar/src/client/SidebarRoot.module.css:10-13`），行内边距改为
   `calc(row-padding - paint-inset)` 外加 3px 透明 `border-inline`、gap 6px、圆角
   `--dsw-radius-md`（12px）；列内边距 12px → 8px。该改动的
   **首个受支持版本是 `dsh-v0.2.2-alpha.2`**（`git tag --contains 86fb01a613`）。受支持矩阵的
   24 个精确版本因此分成两代：**19 个旧几何**（`0.1.5-rc.2` … `0.2.1-rc.5`）与 **5 个新几何**
   （`0.2.2-alpha.2`、`0.2.2-alpha.3`、`0.2.2-rc.1`、`0.2.2-rc.2`、`0.2.2-rc.3`）。在开发
   pin `0.2.2-rc.3` 上，本入口相对同一列的账号/设置行整体左移：图标左缘 6px、文字左缘 4px
   （见 §Investigation）。用户 2026-11-16 截图里"齿轮 + 工作区目录"与下方"⋯ 更多"（未登录时的
   账号 launcher，是 `settings.launcher` 的 occupant；新几何下它与设置触发行共用同一 token
   配方，旧几何下它自己的 padding 不同）没有对齐，就是这么来的。对齐参照统一取设置触发行
   `.triggerRow / .trigger`（见 §Investigation）。

   行几何之外还有一条**更早且独立**的分界：宿主 rail 触发器的圆角在 `dsh-v0.1.6-alpha.2`（commit
   `c6b81a75fd`，设计打磨批次）已从 `border-radius: 50%` + `corner-shape: round` 改为 12px 圆角方
   （`.trigger.rail` 不再覆盖圆角，继承 `.trigger` 的 12px）；24 个受支持版本中只有最老 2 个
   （`0.1.5-rc.2`、`0.1.6-alpha.1`）是圆形，其余 22 个都是 12px。本插件的 `.mrfw-triggerRail` 仍写
   `50%`，只与那 2 个版本一致。`.triggerRow` 的 `position: relative` 也在同一边界出现（
   `0.1.6-alpha.2` 起；最老 2 个版本没有）；`@media (hover: hover)` 包装则迟至 `0.2.2-alpha.2`
   才出现（见 §Investigation）。
2. **图标语义不一致。** footer 行仍用 `IconSettings`（齿轮，
   `WorkspaceFoldersAction.tsx:338`），而本插件其余入口——新会话 Hero 入口
   （`HeroWorkspaceEntry.tsx:100`；[ADR-0037](./ADR-0037-conversation-hero-workspace-folders-entry.md)
   在 2026-11-08 目检后把首版齿轮改为 workspace tree）、工作区 `...` 菜单项
   （`workspace-menu.ts:161`；[ADR-0038](./ADR-0038-workspace-menu-folders-dialog.md)）——都已使用
   `IconWorkspaceTree`；README 也一直把侧栏动作描述为 folder 字形。齿轮把"设置"语义借给了本入口，
   并与下方设置行（宿主 `IconSettingsOutlineMedium`）重复。
3. **该槽是会被撞的 list 槽，且官方就有一个常驻 occupant。** 宿主把每个 footer occupant 渲染为
   `.footerActions` 的直接 flex 子项：`.footerActions { display: flex }`（无 wrap；
   `dsh-v0.2.2-rc.3: packages/client/ui-sidebar/src/client/SidebarRoot.module.css:804-826`，
   `dsh-v0.1.5-rc.2` 同值；宿主 rc.3 的 footer 注释明确 "Each occupant owns its button geometry and hover
   chrome."，不为多 occupant 提供布局），renderer 每个槽渲染点只发一个 `display: contents` 的
   `[data-slot]` anchor（`scoped-slots.tsx:1313-1352`；list 行在 `1481-1509` 直接渲染在其内）。
   官方 `ui-cordis` 在标准 `dsh-web-app` 组合里**无条件挂载**，并永久注册
   `id: 'cordis-panel'` 的 footer occupant（`packages/extensions/ui-cordis/src/client/index.ts:86-88`；
   `packages/bundle/web-app/cordis.patch.yml`），但只在存在动态 Cordis 插件时才渲染
   （`CordisPanel.tsx:194` 在 inventory 为空时返回 `null`）。Cordis 行与本行都"整行宽、不收缩"
   （Cordis `.layer { flex: none; width: 100% }`；本插件 `flex: none`），两者同时渲染时后一项被推出
   列外（实测：本行 left ∈ [280, 552]，整行落在 288px 列的右边界之外，实际不可见/不可点）。

宿主没有 slot 级的"择一/让位/优先级接管"机制：`priority` 只对**同一个 cell** 生效，而 list 槽的
cell 键是 `id`——不同 id 的注册全部共存并全部渲染；宿主自带的"让位"只存在于装载期 `!!js` 行守卫
（better-sidebar 的双挂载互斥）、右侧栏 tab kind 的 band 接管（`priority: 'extension'` 盖住
builtin，卸载即恢复）与渲染崩溃的 `abdicate`，都与本槽无关
（`docs/subsystems/slots.md:60-69`；`ui-slots/src/index.ts:1266-1386,1410-1446`）。生态插件处理同槽
几何冲突的实际做法是 **CSS/DOM 布局修补**，不是隐藏自己：`dsh-balance-simple` 在本卡挂载期间用
`:has()` 把 `[data-slot="sidebar.footer.action"]` 变成纵向列；`dsh-vt-quote-bar` 与
`dsh-plugin-crypto-ticker` 在宿主 flex 容器上加换行；`dsh-sidebar-organizer` 只枚举
`entriesOfSlot` 做重排；`dsh-ego-browser` 按另一插件的服务是否存在选择另一条集成面。抽样中
**没有任何插件"同槽有人注册就静默隐藏"**。

还必须记录一个否决前提：`ctx.slots.entries / entriesOfSlot / subscribe / getVersion` 在全部 24 个
受支持版本上都是公开 API（`ui-renderer/src/client/registry.ts:403-473`），但槽账本只能回答"谁
注册了"，回答不了"谁渲染了"。"有他人注册就让位"的朴素判据（如
`entriesOfSlot('sidebar.footer.action').length > 1`）会让本入口在**所有标准安装**里永久消失
（`cordis-panel` 永远注册、通常不渲染）；"渲染可见"只能靠 DOM 观测，且两个插件都实现这种让位时
会互隐/抖动，`return null` 让位又会让"让位者"仍占着 ledger cell、无法组合。2026-11-16 产品决策：
**选择共存，不做让位/隐藏**。

## Investigation

以下证据均于 2026-11-16 在本机取得；上游事实用受支持 tag 的源码核对，几何数值用一次性
Chromium headless 复刻宿主 CSS 实测（不引入浏览器测试依赖，仅作为计划证据）。

### 宿主两代行配方（逐值）

| 属性 | 旧几何（19 个版本） | 新几何（5 个版本） |
| --- | --- | --- |
| 侧栏列 inline padding | 12px（`--dsh-sidebar-inline-padding`） | 8px（同名 token，值变） |
| 行包装 | `width: calc(100% + 4px); margin: 4px -2px` | `width: 100%; margin: 4px 0` |
| 按钮 padding | `0 10px 0 8px` | `0 calc(var(--dsh-sidebar-row-padding) - var(--dsh-sidebar-paint-inset))`（= 9px）+ `border-inline: 3px solid transparent` |
| 按钮 gap | 8px | `var(--dsh-sidebar-label-gap)`（= 6px） |
| 按钮圆角 | 12px | `var(--dsw-radius-md)`（= 12px） |
| rail 尺寸/边框 | 36×36；0.2.2-alpha.2 之前无 `border-inline` | 36×36；`border-inline: 0`、`background-clip: border-box`（随 `86fb01a613` 新增） |

来源：`dsh-v0.1.5-rc.2` 至 `dsh-v0.2.1-rc.5` 的
`packages/client/ui-settings-general/src/client/SettingsRoot.module.css`（旧值）与
`dsh-v0.2.2-alpha.2` 起的同一文件（新值）。**参照行统一取设置触发行**（`.triggerRow /
.trigger`）：新几何下账号 launcher（`packages/client/ui-settings-account/src/client/AccountMenu.module.css`，
自 `0.2.2-alpha.2` 起）与它使用同一 token 配方，截图里那一行正是账号 launcher；旧几何下账号
launcher 自己的 padding 不同（`6px`；未登录形态 `6px 2px 6px 6px`），不作参照。因此
"与下方行对齐"等价于"复刻 `.triggerRow` / `.trigger`"。

### rail 圆角与行包装属性的独立分界

rail 圆角不属于两代行几何，它有一条更早的分界（commit `c6b81a75fd`，首个 tag `dsh-v0.1.6-alpha.2`）：

| 属性 | `0.1.5-rc.2`、`0.1.6-alpha.1`（2 个版本） | `0.1.6-alpha.2` … `0.2.2-rc.3`（22 个版本） |
| --- | --- | --- |
| `.trigger.rail` 圆角 | `border-radius: 50%` + `corner-shape: round` | 无覆盖，继承 `.trigger` 的 12px |
| `.triggerRow` 定位 | 无 `position` | `position: relative` |

本配方在 rail 上采纳 `border-radius: var(--dsw-radius-md, 12px)`：与执行该分界之后的 22 个版本逐像素
一致，最老 2 个版本（宿主圆形）出现已记录的圆角偏差（无 ink/布局影响）。曾考虑的
`max(12px, 50% - 2 * inset)` 在 5 个新几何版本上为 12px、在 19 个旧几何版本上为 18px，只在
5 + 2 个版本上与宿主一致、其余 17 个不符，否决。不存在能区分 `0.1.6-alpha.2` 的 CSS-only 探针
（`--dsh-sidebar-inline-padding` 在所有旧版本都是 12px，`--dsw-*` 族出现得更晚），因此接受这 2 个
最老版本的偏差。

`@media (hover: hover)` 只存在于 `0.2.2-alpha.2` 起的 5 个版本；旧 19 个版本的 `.trigger:hover`
没有 media 包装。本配方保持不包装（见 §D2 的取舍说明）。

### 设置行可见 occupant 的按钮高度分界 `0.2.0-rc.1`（A 修订依据）

行几何之外还有一条**按钮高度**的分界，与 §D2 初稿的 42px 固定高度冲突：侧栏设置行（`.settingsArea`）的可见 occupant 在 `dsh-v0.2.0-rc.1` 前后是两个不同组件。

| 版本 | 设置行 occupant | 可见触发器高度 |
| --- | --- | --- |
| `0.1.5-rc.2` … `0.1.7-rc.2`（7 个版本） | `ui-settings-general` 的设置触发行（`.triggerRow` / `.trigger`） | 42px |
| `0.2.0-rc.1` … `0.2.2-rc.3`（17 个版本） | `ui-settings-account` 的账号 launcher：未登录 `[data-signed-out='true']` 32px、已登录 44px、`[data-collapsed='true']`（rail）36px | 32 / 44px |

本插件固定 42px 时，hover 药丸在 7 个最老版本上与下方一致，在 17 个账号 launcher 版本上不一致：未登录矮 10px（42 vs 32），已登录只差 2px（42 vs 44）。2026-11-16 在隔离 web 组合（`0.2.2-rc.3`、未登录）实测：本行按钮盒 264×42（x 8..272）、下方 More 按钮盒 264×32（x 8..272），hover 背景、圆角、x 范围相同，**只有高度差 10px**。用户据此要求在 A 修订中让按钮高度跟随可见行（见 §修订二）。

### 几何实测（288px 宽侧栏，相对侧栏左缘的 CSS px）

（数值为对应元素盒的左缘：图标取 `svg` 元素盒、文字取 label 元素盒。宿主字形在 16/14px
方形内还有约 1-2px 的墨迹内缩，两侧都用同一取法，故 Δ 不受影响。参考行：新几何取账号 launcher 的未
登录形态（截图中的 "⋯ 更多"），旧几何取设置触发行。）

| 场景 | 本行图标左缘 | 参考行图标左缘 | Δ | 本行文字左缘 | 参考行文字左缘 | Δ |
| --- | --- | --- | --- | --- | --- | --- |
| 新几何 + 当前样式 | 14 | 20 | **-6** | 38 | 42 | **-4** |
| 新几何 + 拟议样式 | 20 | 20 | 0 | 42 | 42 | 0 |
| 旧几何 + 当前样式 | 18 | 18 | 0 | 42 | 42 | 0 |
| 旧几何 + 拟议样式 | 18 | 18 | 0 | 42 | 42 | 0 |

按钮盒：新几何拟议 `left 8 / right 280 / padding-inline 9 / border 3 / gap 6 / radius 12`，
与参考行逐值相同；旧几何拟议 `left 10 / right 278 / padding 8 / 10 / border 0 / gap 8 / radius 12`，
与旧宿主 `.trigger` 逐值相同。

rail（折叠态 56px 列，角点命中测试在 (3,3)/(4,4) 处区分 12px 与 50%）：当前样式的 50% 圆形只与最老
2 个版本一致；`0.1.6-alpha.2` 起的 22 个版本宿主都是 12px，当前样式在 (3,3)/(4,4) 处与宿主不同。
拟议的 `var(--dsw-radius-md, 12px)` 在这 22 个版本上命中 12px、与宿主一致；最老 2 个版本命中 12px
而宿主是 50%，属已记录的已知偏差（见上节）。

### 同槽争抢实测（同一复刻）

- 仅本行：left 8、宽 272、icon 20、label 42，与下方设置行一致。
- 再渲染一条 Cordis 样式的全宽行（order 0，在前）：本行 left 280、right 552——整行被推出 288px
  列，不可见。
- 拟议共存规则下：Cordis 行与本行各占一整行（left 8、宽 272），icon/label 仍为 20/42；rail 下
  两个 36px 入口在 x = 10 纵向排列；只有本行时，列布局与现状逐像素相同。

### 图标现状

| 入口 | 图标 | 位置 |
| --- | --- | --- |
| 侧栏 footer 行 | `IconSettings`（齿轮） | `WorkspaceFoldersAction.tsx:338` |
| 新会话 Hero 行 | `IconWorkspaceTree` | `HeroWorkspaceEntry.tsx:100` |
| 工作区 `...` 菜单项 | `IconWorkspaceTree` | `workspace-menu.ts:161` |
| Files 根切换器 trigger | `IconFolderClose` | `RootSwitcher.tsx:329` |
| 宿主设置触发行 | `IconSettingsOutlineMedium` | `ui-settings-general/src/client/chrome.tsx` |

`IconWorkspaceTree` 的兼容探针为
`selectIconOr(['IconWorkspaceTreeOutlineRegular'], IconFolderOpen)`：Regular 字族自
`0.1.7-alpha.1` 起存在，更早版本回退 folder 字形（`src/compat/client-icons.ts:110-113`）。
尺寸沿用宿主设置行的 `wide ? 16 : 18` 惯例。

## Decision

### D1 图标：footer 行改用 workspace tree 字形

footer occupant 行的图标改为 `IconWorkspaceTree`（wide 16px / rail 18px），与 Hero 入口、工作区菜单
项同族；沿用现有兼容探针的旧版本 folder 回退，不新增像素名字形探测。`IconSettings` 仅保留给真正
"管理"语义的入口（`RootSwitcher` 的菜单末项等），从 footer 路径移除。颜色仍由 `.mrfw-trigger` 的
`color: var(--dsw-alias-label-primary)` 继承，不新增颜色值（ADR-0006）。

理由：ADR-0037 已就同一入口的同一问题给出目检结论（齿轮的"设置"语义不符）；本插件其余入口与
README 的描述都已指向 workspace tree；同列设置行本身用齿轮，重复字形会让两个入口看起来是同一类
动作。

### D2 行几何：一份配方 + 宿主 token fallback，两代逐像素（rail 圆角独立分界）

`src/client/styles.ts` 的 footer 规则改写为：

```css
/* 宿主在 0.2.2-alpha.2 把侧栏行从"2px 外扩 + 12px 列内边距"改成 paint-inset token
 * 配方（row-padding 12 / paint-inset 3 / label-gap 6，列内边距 8）。旧宿主没有
 * --dsh-sidebar-* 自定义属性：下面的 fallback 就是旧值，因此一份声明在两代上都与
 * 宿主 .triggerRow / .trigger 逐像素一致。 */
.mrfw-triggerRow {
  position: relative;
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  width: calc(100% + 4px - min(4px, 2 * var(--dsh-sidebar-paint-inset, 0px)));
  margin: 4px calc(-2px + min(2px, var(--dsh-sidebar-paint-inset, 0px)));
}

.mrfw-triggerRow.mrfw-railRow {
  width: 36px;
  margin: 8px 0 10px;
}

.mrfw-trigger {
  box-sizing: border-box;
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: var(--dsh-sidebar-label-gap, 8px);
  width: auto;
  height: 42px;
  margin: 0;
  padding-block: 0;
  padding-inline:
    calc(var(--dsh-sidebar-row-padding, 8px) - var(--dsh-sidebar-paint-inset, 0px))
    calc(var(--dsh-sidebar-row-padding, 8px) - var(--dsh-sidebar-paint-inset, 0px)
      + max(0px, 2px - var(--dsh-sidebar-paint-inset, 0px)));
  border: none;
  border-inline: var(--dsh-sidebar-paint-inset, 0px) solid transparent;
  border-radius: var(--dsw-radius-md, 12px);
  background: transparent;
  background-clip: padding-box;
  color: var(--dsw-alias-label-primary);
  font-family: inherit;
  font-size: 14px;
  line-height: 22px;
  text-align: left;
  cursor: pointer;
  overflow: hidden;
  transition: background-color var(--ds-transition-duration-fast) var(--ds-ease-in-out);
}

.mrfw-triggerRail {
  flex: none;
  width: 36px;
  height: 36px;
  margin: 0;
  padding: 0;
  gap: 0;
  justify-content: center;
  border-inline: 0;
  background-clip: border-box;
  border-radius: var(--dsw-radius-md, 12px);
}

/* 设置行的可见 occupant 分界（§修订二）：0.1.7-rc.2 及以前是 42px 的设置触发行，
   0.2.0-rc.1 起是账号 launcher（未登录 32px / 已登录 44px / rail 36px）。按钮高度
   跟随它，让 footer 两行的 hover 药丸同尺寸；没有该标记的宿主保持上面的 42px，
   rail 保持自己的 36px。 */
[data-slot='sidebar']:has(button[data-signed-out='true']) .mrfw-trigger:not(.mrfw-triggerRail) {
  height: 32px;
}

[data-slot='sidebar']:has(button[data-signed-out='false']) .mrfw-trigger:not(.mrfw-triggerRail) {
  height: 44px;
}
```

推导（`inset = var(--dsh-sidebar-paint-inset)`）：

- 旧宿主 `inset` 未定义 → 0：行包装宽 `100% + 4px - min(4px, 0) = +4px`、
  `margin-inline = -2px + min(2px, 0) = -2px`；按钮 `padding-left = 8px`、border 0、
  `padding-right = 8px + max(0px, 2px) = 10px`、gap 8px、圆角 12px——与旧宿主逐值相同。
- 新宿主 `inset = 3px`：行包装宽 `100%`、`margin-inline = 0`；按钮 `padding-left = 12 - 3 = 9px`、
  border 3px、内容缩进 12px，`padding-right = 9 + max(0px, -1px) = 9px`、gap 6px、圆角 12px——
  与新宿主逐值相同。
- 右 padding 的 `max(0px, 2px - inset)` 只服务旧宿主：旧配方左右不对称（左 8 / 右 10），补上
  2px 才能让长 label 的省略阈值与 hover 底色右缘也逐像素一致；新宿主该补偿为 0。
- rail 圆角走自己的分界（见 §Investigation）：`0.1.6-alpha.2` 起 22 个版本宿主为 12px，只有最老 2 个
  版本是 50%；`var(--dsw-radius-md, 12px)` 与这 22 个版本逐像素一致，最老 2 个版本接受 12px 的已知
  偏差（旧公式 `max(12px, 50% - 2 * inset)` 会在这 22 个版本上错成 18px，否决）。
- rail 其余（36×36、margin、padding、gap）两代相同；`.mrfw-triggerRow` 补 `position: relative` 与
  `0.1.6-alpha.2` 起的宿主一致（最老 2 个版本没有该声明；本行无定位后代，不影响布局）。
- 高度规则（§修订二）只改高度（32 / 44），左内边距、gap、圆角与 hover token 不变，因此 icon/label
  左缘仍为 20 / 42；`:not(.mrfw-triggerRail)` 让 rail 保持 36px；宿主重命名 `data-signed-out` 时
  规则不匹配，静默回退 42px（即今天的尺寸）。
- `@media (hover: hover)` 包装只在 5 个新几何版本存在；本配方保持不包装：与 19 个旧版本一致，
  触屏上与 5 个新版本存在"有无 hover 反馈"的差异（桌面指针设备无差异）。刻意取舍：不改变旧版本
  行为，且差异只在无 hover 能力的设备上可见。hover 填充用 `background-color` 长写（§修订三），
  保留基础规则的 `background-clip: padding-box`，绘制宽度与宿主行一致。
- 按钮高度跟随设置行可见 occupant（见 §Investigation 的高度分界与 §修订二）：账号 launcher 宿主未登录 32px、已登录 44px；`0.1.7-rc.2` 及以前命中上面的 42px 回退；rail 保持 36px。14/22 字号、hover token、transition 不变；宽/rail 两种形态的 icon 尺寸仍为 16 / 18。
- 不引入 JS 代际探测、不比较版本字符串：CSS fallback 本身就是结构探测（ADR-0009 的原则在这里
  不需要额外机制）。

### D3 槽位共存：本入口挂载期间把 footer 槽 outlet 变成纵向列

`src/client/styles.ts` 增加一条作用域限定到本入口的宿主 DOM 规则：

```css
/* 官方 ui-cordis 在标准组合里永久注册一个整行宽的 footer occupant（通常不渲染）。
 * 宿主 .footerActions 是单行 flex，两个整行宽 occupant 同时渲染时后者会被推出列外。
 * 本入口挂载期间把宿主 renderer 的 slot anchor（display:contents）改成纵向列，
 * 让每个 occupant 各占一整行；本入口不挂载时选择器不匹配，宿主布局原样。
 * display:contents 是 React 内联 style，必须 !important 才能覆盖。 */
[data-slot='sidebar.footer.action']:has(.mrfw-triggerRow) {
  display: flex !important;
  flex-direction: column;
  width: 100%;
  min-width: 0;
}
```

设计要点：

1. **只改最近的可寻址缝。** `[data-slot="<key>"]` 是宿主 renderer 公开的 anchor（源码注释称其为
   "addressable seam dynamic styles target"），全部 24 个受支持版本都有
   （`scoped-slots.tsx` 自 `dsh-v0.1.5-rc.2` 起）。规则不触碰 `.footerActions` 本身，也不触碰
   其他 occupant 的 DOM/样式/注册。
2. **作用域由本入口自身决定。** `:has(.mrfw-triggerRow)` 保证只有本插件的 footer 行在 DOM 中时
   才生效；插件未安装、未注册或 slot 未声明时选择器不匹配，宿主保持单行布局。`.mrfw-triggerRow`
   只出现在 footer occupant 中（Files compact launcher 用 `.mrfw-fileLauncher`，在其他槽），
   因此不会误伤。
3. **单 occupant 时布局等价。** 只有一个子项时，column 与 row 的外框、子项宽高、图标/文字左缘
   逐像素相同（实测），所以不需要再加"有他人才切换"的条件；这避免了对他人渲染状态的任何观测。
4. **rail 同规则生效。** 56px 折叠列里两个 36px 入口纵向排列，各自与设置 rail 按钮同 x（实测
   x = 10），不会互相挤压。
5. **不改顺序。** 注册 `order: 50` 保持不变；纵向顺序继续由宿主 list 语义（order 升序）决定，
   官方 Cordis 行（order 0）在本行之上。不改写、不重排他插件的行。
6. **不用槽账本。** 决策不读取 `entries/entriesOfSlot/subscribe`：本方案无 JS 观测、无跨插件
   协议、无注册生命周期变化；插件卸载即回到宿主布局。

### D4 明确不采用"槽位让位/隐藏"

被否决的不是实现难度，而是语义与可组合性：

- 官方 `cordis-panel` 在每个标准 profile 里永久注册（只是通常不渲染），"有人注册就让位"会让本
  入口在所有标准安装中消失；按 id 白名单排除官方 occupant 是脆弱且不可推广的。
- 槽账本不包含"是否渲染"的事实；要实现"他人真的渲染时让位"，只能对宿主 DOM 做可见性观测，且在
  两个插件互相让位时会产生互隐/抖动；`return null` 式让位仍占着 ledger cell，不可组合。
- 本仓库既有立场：能检测的接管要**可见**提示（[ADR-0015](./ADR-0015-files-tab-plugin-owned-browsing.md)
  修订），真正的替换点冲突要 **fail closed**（[ADR-0014](./ADR-0014-root-limit-and-provider-conflict.md)），
  都不支持"静默隐藏自己"；生态抽样也没有这种先例。
- 用户 2026-11-16 明确选择共存方案。若产品未来仍要求让位，必须另立 ADR，并以"渲染可见"为信号、
  带可见提示，且处理双向让位；本 ADR 的 D3 与之互斥。

### D5 边界与非目标

- 不改注册：`id` / `order` / `label` / `locale` / owner `{wide}` 的传递不变；不改 hero
  （`conversation.hero.options`）、Files compact launcher（`sidebar.right.tab.files.actions`）、
  工作区菜单、对话框、RPC 与授权模型。
- 不改 DSH、不新增依赖、不改 `dsh.client` 清单、不新增 locale 键。
- 不改颜色与主题选择器（ADR-0006）；不引入配置项（这不是部署可变选项，而是产品决策）。
- 不修改 CHANGELOG（发版准备时写）与 `AGENTS.md` 的项目状态（发版时更新）。

## Alternatives Considered

| 方案 | 否决理由 |
| --- | --- |
| 保持现状（不做任何改动） | 5 个新几何版本上图标/文字偏移 6/4px；Cordis 行渲染时本入口被推出列外，功能不可用 |
| 用 JS 在运行期探测宿主代际（读 token / 量 DOM）再切换样式 | 两代配方可以用 CSS fallback 精确表达；额外探测会把纯样式问题变成运行时测量与生命周期问题，且需要测试桩支持 |
| 保留 4px 外扩、只调 padding | 新宿主同时改了列内边距（12→8）、行内边距与 paint-inset，只改 padding 不能在两代同时命中 |
| rail 圆角保留 50%（或 `max(12px, 50% - 2 * inset)`） | 50% 只与最老 2 个版本一致；max 公式只在 5 个新几何 + 最老 2 个版本上与宿主一致，其余 17 个旧几何版本不符（7/24）。采纳 `var(--dsw-radius-md, 12px)`：22/24 对齐，最老 2 个版本的圆角偏差已记录 |
| 对齐到账号 launcher（32px 高、14px 图标、gap 8）而不是设置触发行 | 账号行会随登录状态变化（登录后是 44px、24px 头像），不是稳定参照；设置触发行是 42px/16px 的固定配方。新几何下两行的文字左缘本来就一致（20+14+8 = 20+16+6），旧几何下账号 launcher 的 padding 不同（见 §Investigation），所以参照只能是设置触发行 |
| 让位变体 A：任何他人在册就让位 | 官方 cordis-panel 永久注册 → 本入口在所有标准安装消失 |
| 让位变体 B：按 id 白名单排除 cordis-panel 后让位 | 白名单脆弱、不可推广；他人"注册但未渲染"时仍会误让位 |
| 让位变体 C：DOM 可见性观测，他人渲染时渲染 null | 需要宿主 DOM 观测与恢复信号；双向让位互隐/抖动；`return null` 仍占 cell，不可组合；用户在 2026-11-16 选择共存 |
| 像 `dsh-vt-quote-bar` / `dsh-plugin-crypto-ticker` 那样改宿主 `.footerActions` 的 flex-wrap 或直接写 style | 影响范围超出本槽（会改变 footer 之外的布局假设），且属对共享容器的更宽改写；只改最近 anchor 已足够 |
| 把入口移到 `sidebar.panellist` 或面板 More 菜单 | 那里是"面板"语义与 icon-only 语法；本入口打开的是对话框；会与已存在的 Hero/Files/工作区菜单入口重复，且失去"底部动作"位置 |
| 固定改为 icon-only 36px 以便与 Cordis 并排 | 官方 Cordis 行不收缩，并排仍溢出；且丢失 label 与既有入口形态 |

## Consequences

- **对齐**：行几何与图标/文字左缘在 19 个旧几何版本上保持不变（无回归），在 5 个新几何版本
  （含开发 pin）与设置触发行完全一致（该代账号 launcher 与设置触发行同配方，因此截图里的
  "⋯ 更多" 行也对齐）。按钮高度自 A 修订起跟随设置行 occupant，footer 两行的 hover 药丸同尺寸
  （账号 launcher 未登录 32 / 已登录 44；`0.1.7-rc.2` 及以前保持 42，与该代设置触发行一致）。
  rail 圆角由 50% 改为 `var(--dsw-radius-md, 12px)`：与 `0.1.6-alpha.2` 起的 22 个版本宿主一致
  （此前只与最老 2 个版本一致），最老 2 个版本（`0.1.5-rc.2`、`0.1.6-alpha.1`）出现已记录的圆角
  偏差（无 ink/布局影响）。
- **图标**：footer、Hero、工作区菜单三处入口同字形；设置语义只留给齿轮，README 既有描述变得准确。
- **共存**：另一个 footer action 真正渲染时，两行各自整行宽、都可点击；本插件未挂载时宿主布局
  不变。代价是本入口存在时该槽统一纵向排列（对同槽其他 occupant 也生效，属共享布局，
  插件卸载即恢复）；仅本行时无可见差异。
- **无运行时失败面**：没有 JS、没有网络/存储/授权改动；`:has()` 不可用时规则被浏览器丢弃，退化
  为宿主单行布局（即今天的行为）；旧宿主没有 token 时 fallback 命中旧配方。
- **测试面**：`tests/client-styles.spec.ts` 增加 footer 规则钉扎（两代 fallback、按钮高度跟随 launcher
  的 32 / 44 两条规则与 42 / 36 回退、共存选择器）；
  `tests/client-panel.spec.tsx` 增补 footer wide/rail 的图标与 label 断言（测试替身没有真实
  workspace-tree 字形时，替身或断言按 folder 回退钉住）；不需要扩展 slot 桩（本方案不调用
  `entries/entriesOfSlot/subscribe`）。
- **文档面**：ADR-0006 的 Status 加"footer 图标与几何由 ADR-0044 修订"；README/guide/requirements/
  architecture 的侧栏入口描述补"同槽共存时各占一行"；`.agent/note/dsh-compat-contract`（双语）
  记录"侧栏行几何两代分界 = 0.2.2-alpha.2"这一 quiet trap。CHANGELOG 留到发版准备。
- **回滚**：恢复 `IconSettings`、删除共存规则、还原 footer 规则即回到 `v0.1.20` 行为；无数据、
  协议、授权迁移。

## 修订（2026-11-16，外部技术评审 F1）

初稿把宿主 rail 圆角误归入"两代行几何"（19 个旧版本一律 50%）。评审核对后更正：rail 圆角从
`dsh-v0.1.6-alpha.2`（commit `c6b81a75fd`）起已由 50% 圆形改为继承 `.trigger` 的 12px，只有最老
2 个版本（`0.1.5-rc.2`、`0.1.6-alpha.1`）是圆形；`86fb01a613` 对 rail 只新增
`border-inline: 0` / `background-clip: border-box`。因此 D2 的 rail 公式定为
`border-radius: var(--dsw-radius-md, 12px)`（22/24 与宿主一致；最老 2 个版本接受已知圆角偏差），
并补齐 `.triggerRow` 的 `position: relative` 与 `:hover` 的 media 包装取舍。决策与其余设计不变。

## 修订二（2026-11-16，实施期 GUI 复核 A：按钮高度跟随设置行 occupant）

隔离 web 组合目检发现 footer 两行的 hover 药丸高度不一致（用户 2026-11-16 报告；§Investigation 的高度分界是根因）：按钮固定 42px，而 17 个 `0.2.0-rc.1` 起的版本下方可见行是账号 launcher（未登录 32 / 已登录 44）。产品决定（用户明确选择 A）：**按钮高度跟随设置行 occupant**，使两行 hover 药丸同尺寸；其余几何（20/42 icon/label 墨线、gap、圆角、hover token）不变。

- D2 的"42px 高不变"改为：账号 launcher 宿主 32 / 44，`0.1.7-rc.2` 及以前的 42px 设置触发行命中 42px 回退，rail 保持 36px。实现只用 CSS 结构探测（`[data-slot='sidebar']:has(button[data-signed-out=…])`），不读槽账本、不引入 JS 代际探测；属性缺失时静默回退 42px。
- 否决的备选：固定 32px（与已登录 44px 及旧代 42px 都不符）；固定 44px（未登录差 12px）；只在按钮内画一条 32/44 高的伪元素 hover 背景（视觉与可点区域不一致，且同样需要状态探测）；读取槽账本/账号状态（回答不了"渲染了多高"，ADR-0044 §D4 已否决）。
- 文档面：README / guide / requirements / architecture 说明 hover 高度跟随设置行；compat note §21 增加"设置行高度随登录态变化、缺少标记回退 42px"的 quiet trap；计划追加 P6 与证据。

## 修订三（2026-11-16，hover 药丸宽度：填充必须用 `background-color` 长写）

A 修订后 GUI 复核继续报告两行 hover **宽度**不一致。真实 DOM 复验（隔离 web 组合，`0.2.2-rc.3`，未登录）：两个按钮盒都是 264px（x 8..272），但**实际绘制的填充宽度**不同——本行 264px（8..272）、下方 More 258px（11..269），差 6px（两侧各 3px）。根因：

- §D2 的按钮基础规则有 `border-inline: 3px solid transparent` + `background-clip: padding-box`，填充应止于 padding box（258px）；
- 初稿的 `.mrfw-trigger:hover` 用 `background:` **简写**，会把 `background-clip` 重置为初始值 `border-box`，于是 hover 填充盖住两侧透明 border，多画 6px；
- 宿主自己的 hover 是 `background-color:` **长写**（`.trigger:hover { background-color: … }`），保留基础规则的 `padding-box`，所以两边宽度不同。

修复：hover 改 `background-color: var(--dsw-alias-interactive-bg-hover)`，`background-clip: padding-box` 由基础规则继续生效；rail 基础规则显式 `background-clip: border-box`、`border-inline: 0`，不受影响。修复后本行与 More 的绘制填充均为 258px（11..269），高与宽都与下方行一致。

否决的备选：在 hover 里补写 `background-clip: padding-box`（等价但偏离宿主的写法，且以后再引入简写会再次踩到）；收窄按钮宽度（会改变 icon/label 墨线与行宽，越出本次范围）。

## Related Documents

- [ADR-0006](./ADR-0006-client-ui-host-tokens.md)（宿主 token 样式机制；本 ADR 修订其 side-footer
  触发器配方与图标的过时条款）
- [ADR-0037](./ADR-0037-conversation-hero-workspace-folders-entry.md)（同入口的图标语义先例与
  "双入口共存"结论）
- [ADR-0038](./ADR-0038-workspace-menu-folders-dialog.md)（复用 footer 对话框的 owner 关系；本
  ADR 不动 owner）
- [ADR-0015](./ADR-0015-files-tab-plugin-owned-browsing.md)、
  [ADR-0014](./ADR-0014-root-limit-and-provider-conflict.md)（接管提示与冲突处置的既有立场）
- [ADR-0009](./ADR-0009-dsh-compat-contract.md)（结构探测、精确版本矩阵与两代兼容写法）
- [计划](../plans/active/2026-11-16-sidebar-footer-row-alignment-and-coexistence.md)
- 上游：`packages/client/ui-sidebar/src/client/SidebarRoot.tsx:467-475`（footer 渲染点）、
  `packages/client/ui-renderer/src/client/scoped-slots.tsx:1313-1352,1481-1509`（anchor 与 list
  渲染）、`packages/client/ui-settings-general/src/client/SettingsRoot.module.css`（两代配方）、
  `packages/extensions/ui-cordis/src/client/index.ts:86-88` 与 `CordisPanel.tsx:194`、
  `packages/bundle/web-app/cordis.patch.yml`（cordis occupant 常驻）、`docs/subsystems/slots.md`
- 生态先例：[dsh-balance-simple](https://www.npmjs.com/package/dsh-balance-simple)、
  [dsh-vt-quote-bar](https://www.npmjs.com/package/dsh-vt-quote-bar)、
  [dsh-plugin-crypto-ticker](https://www.npmjs.com/package/dsh-plugin-crypto-ticker)、
  [dsh-sidebar-organizer](https://www.npmjs.com/package/dsh-sidebar-organizer)、
  [dsh-ego-browser](https://www.npmjs.com/package/dsh-ego-browser)、
  [dsh-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar)（装载期双挂载守卫与
  `ctx.betterSidebar` 服务枢纽）
- 编号说明：`ADR-0043` 已被两个在飞分支的提案占用（未合入本线），本线新增决策从 0044 起。

## 修订三（2026-11-18）

受支持集合随 DSH `0.2.2-rc.4` 精确支持扩到 **25 个版本**：旧几何仍为 19 个（`0.1.5-rc.2` … `0.2.1-rc.5`），新几何从 5 个变为 **6 个**（`0.2.2-alpha.2` … `0.2.2-rc.4`）；rail 圆角对齐从 22 个版本变为 **23 个**，最老 2 个版本（`0.1.5-rc.2`、`0.1.6-alpha.1`）仍是已记录的偏差，其余旧几何版本数不变（17 个）。`0.2.2-rc.4` 未改任何上游侧栏 / 客户端源码，本文的两份配方、按钮高度规则与同槽共存结论均不变；正文中的 24/22/5/7-24 计数是 2026-11-16 决策与实施时的集合，保留为历史证据。
