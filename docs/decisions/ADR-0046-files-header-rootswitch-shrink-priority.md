# ADR-0046: Files 页头 RootSwitcher 的窄宽让位优先级

## Status

Accepted（2026-11-17；实施见 [计划](../plans/completed/2026-11-17-files-rootswitch-narrow-width.md)）

## Date

2026-11-17

## Context

Files 页的 `RootSwitcher` 伪装成上游 header 的 path label，占据 `sidebar.right.tab.files.actions`
槽，并靠 flex `order: -1` 与 `flex: 1 1 auto` 接管 header 里的路径位置
（[ADR-0015](./ADR-0015-files-tab-plugin-owned-browsing.md)）。header 本身是上游
`FilesBody` 的一条扁平 flex 行：PathLabel → reload → search → 槽 occupants
（主根态还有上游 open-in-app 分离按钮）。插件在这个位置**额外**引入了一个触发器
（folder 字形 + 选中根的显示名 + chevron）与一个完整路径 label。

右栏变窄、右栏双栏、浮动小窗三种工况下出现了组件重叠：根名文字被 reload 图标压住，
搜索与 open-in-app 被触发器盒子覆盖。根因是收缩能力写错了层：`.mrfw-rootSwitchBtn`
与其 label 都写了 `min-width: 0` 与省略号，但真正参与外层 flex 的是 `Menu` 原语渲染的
anchor 包装 span（`.root`，`display: inline-flex`），它没有 `min-width: 0`，默认
`min-width: auto` 把它的 used width 钉在内容 min-content（nowrap 根名的完整宽度，
实测 249.59px）。`.mrfw-rootSwitcher` 被压缩到分配宽度后，触发器盒子溢出并画到后续
控件上；同排唯一可收缩的只有 path label，压到 0 之后没有别的让位者。

量化（Chromium 复刻 + 真实 GUI）：页宽 299（右栏最小宽）时触发器与 reload、search
各重叠 28px、与 open-in-app 重叠 14.59px；浮动面板最小宽 220 时 open-in-app 被整枚
覆盖（43px）；附加根接管态下插件自绘的三个控件被推出页外。

## Decision

一条收缩优先级规则，按"固定控件 → 路径 → 根名 → 触发器图标"的顺序让位：

1. reload / search / open-in-app 保持 `flex: none` 与原生几何，永不移动、永不收缩。
2. `.mrfw-switcherPath` 用 `flex: 1 1 0`（+ `min-width: 0`）：有富余时由 grow 占满，
   缺空间时零 basis 无法吸收 deficit，于是路径先让到 0。
3. 给 `Menu` 传 `className="mrfw-rootSwitchAnchor"`，把 `flex: 0 1 auto; min-width: 0`
   写在**参与外层 flex 的 anchor 包装**上；根名 label 按既有 `overflow: hidden` 与
   `text-overflow: ellipsis` 省略。
4. `.mrfw-rootSwitchBtn` 增 `overflow: hidden`：页宽小于"图标 + 固定控件"的物理下界时，
   触发器自己的图标被裁剪，而不是画到邻件上。

`Menu.className` 是公开 prop，且 24 个受支持发布（`0.1.5-rc.2` 起）都把它放在同一个
anchor 包装 span 上（逐 tag 核对），所以规则无版本分支、无需结构探活。不新增
`:has()` 依赖，不新增上游 DOM 钩子。


## 修订（2026-11-17）：窄宽下的三档根名显示

同一显示面追加的规则：触发器不再只靠 CSS 右省略，而是按实测宽度把根名切成三档：

1. **全名**——放得下时显示完整显示名；
2. **前几个…后几个**——放不下但一头一尾都放得下时，自适应地最大化可见字符（优先在
   `-`、`_`、`.`、空格、`/` 等分隔符处断开，尾部上限 10 个字符、前缀至少 3 个、
   尾部至少 4 个），让同前缀但不同结尾的根（`…-workspace` / `…-experiment` /
   `…-ssh`）仍可区分；
3. **只留开头…**——连一头一尾都放不下时退化为前缀 + 省略号。

判定输入是 `RootSwitcher` 自身的宽度：它是 header 里的 `flex: 1 1 auto` 项，宽度恒等于
header 留给它的空间、与文字内容无关，所以文字变短不会反过来改变判定，不会来回抖动。
候选字符串用标签自身字体的 offscreen canvas 量测；没有 canvas 的宿主退回触发器内隐藏
探针的同步布局读取，两者都不可用时保留全名、由样式表的省略号兜底。

实现：`src/client/root-name-fit.ts`（纯函数，三档拟合）与 `src/client/root-name-room.ts`
（宽度预算与文字量测）；样式表新增触发器内的离流探针与"名被截断时隐藏 PathLabel 墨迹"
（盒子保留，reload / 搜索 / open-in-app 仍在原生位置）。完整显示名始终是触发器的
`aria-label`，视觉上的省略不影响读屏与悬停标题。

**行内控件的异步出现也要触发重拟合。** open-in-app 的分裂按钮只在应用目录加载完成
后才渲染：它被插入本行时会占掉约 43px，但 `RootSwitcher` 的外宽不变，因此观察
switcher 自身不会触发重拟合，已拟合的一头一尾会被 CSS 再裁一次、丢掉可辨识的结尾。
所以拟合观察的是"行宽 + 控件席位"：fork 外面包一层 `mrfw-switcherOpen` 席位 span，
席位从 0 到实测宽度的变化同样重拟合（reload 与搜索按钮随接管同步渲染，由依赖覆盖）。

**证据边界（测试能否证明上游 DOM）。** 单测里 `@deepseek-ai/dsh-client-ui-primitives`
被 vitest alias 成本地 stub（宿主发布包带裸 `.module.css` 与宿主侧依赖，jsdom 套件
无法解析），所以 `client-switcher.spec.tsx` 的 anchor 断言只证明"我们把 `className`
接到原语文档化的落点上"，看不到上游 DOM 变化。上游侧的保证来自两条独立证据：全部
24 个受支持发布逐个 tag 核对 `Menu.className` 落到 anchor 包装 span（本 ADR §决策），
以及隔离 Web 宿主里对真实 DOM 的量测（anchor 包装带 `mrfw-rootSwitchAnchor` 且
`min-width: 0`）。stub 刻意保持与真实原语同形的嵌套，因此上游若停止转发 `className`
该断言仍会先红。

## Alternatives Considered

- **只给按钮加 `min-width: 0`（现状即如此）**：无效。收缩发生在锚点包装这一层，
  内层 `min-width` 不会让外层 item 低于 min-content。
- **结构选择器 `:has(> .mrfw-rootSwitchBtn)` 代替 className**：可用，但把"哪个元素是
  外层 flex item"藏进假设；`className` 是公开 prop，显式钩子更易读、可被组件测试钉住。
- **给触发器挂 `:has([data-path-clipped])`/容器查询做断点折叠**：需要额外上游内部属性
  或新增 containment，收益只是在极端窄宽多留几十像素，不符合"最小机制"。
- **在窄宽时隐藏 path label（display:none）**：路径本来就会被压到 0，隐藏不改变优先级，
  却引入断点选取问题（根名长度与路径长度都随内容变化，固定断点会错判）。
- **JS 量测切换 compact 形态**：可精确，但引入 ResizeObserver、额外渲染态与测试面；
  CSS 收缩优先级已能消除重叠，不值得。
- **让 header 换行 `flex-wrap`**：header 是固定 38px 行，换行会破坏上游几何。

## Consequences

- 宽形态几何不变：零 basis + grow 在有富余时产生的路径宽度与原来一致（Phase 2 用
  520/400/380 三个宽度对照）。
- 收缩顺序成为可测试的契约：三条样式规则 + 触发器 anchor 的 class 由测试钉住，
  未来改样式或升级 `Menu` 时会先红。
- 页宽低于上游 header 自身可容纳宽度（约 137px）时本插件仍会溢出，与上游一致，
  不视为本决策的缺陷；插件保证的是"不互相覆盖、不错误放大"。
- 三档显示只改触发器的视觉文本与 PathLabel 的可见性，不改变菜单、接管条件、搜索或
  路径语义；量测不可用时退化为全名 + CSS 省略号，与修订前的观感一致。

## Related Documents

- [计划：Files 页头 RootSwitcher 的窄宽布局](../plans/completed/2026-11-17-files-rootswitch-narrow-width.md)
- [ADR-0015: Files 页插件自有浏览](./ADR-0015-files-tab-plugin-owned-browsing.md)
- [ADR-0016: Files 页原生树 fork](./ADR-0016-files-tab-native-tree-fork.md)
- [ADR-0006: Client UI 使用宿主 token](./ADR-0006-client-ui-host-tokens.md)
