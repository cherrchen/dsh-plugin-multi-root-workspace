# Files 页头 RootSwitcher 的窄宽布局：根名/路径/控件按优先级让位

> 状态：已完成（2026-11-17）。本文件是修复计划与执行账本；Draft PR 与最终提交的 CI 结果见 PR 页面。
>
> 分支：`fix/file-tree-rootswitch-width`。
> 关联：[ADR-0046](../../decisions/ADR-0046-files-header-rootswitch-shrink-priority.md)、
> [ADR-0015](../../decisions/ADR-0015-files-tab-plugin-owned-browsing.md)、
> [ADR-0016](../../decisions/ADR-0016-files-tab-native-tree-fork.md)。

## Goal

Files 页头（`sidebar.right.tab.files.actions` 的 `RootSwitcher`）在右侧栏变窄、
右侧栏双栏、以及可拖动的浮动小窗这三种窄宽工况下不再出现组件重叠：根名、完整路径、
原生 reload / 搜索 / open-in-app（主根态）或插件自绘的同位控件（附加根接管态）
必须按固定优先级让位，任何情况下都不互相覆盖，也不因溢出丢失右侧控件。

## Background（取证与根因）

用户报告：Files 页头的 `RootSwitch` 在变窄的 `SideBar.right`、`sidebar.right` 双栏、
可拖动的小窗下形成组件重叠（三张截图：Files 页头根名文字被 reload 图标压住，
magnifier / open-in-app 紧贴其后）。宽形态（单栏大侧栏）无此问题。

### 上游 DOM（0.2.2-rc.3，受支持的最新宿主；旧宿主同形）

`FilesBody` 的 header 是一条扁平 flex 行（`.header`：`display:flex; gap:4px`，
`padding: 0 6px 0 16px`）：

```text
PathLabel(data-files-path) → [hidden auto-refresh] → reload(data-files-reload)
→ search(data-files-search-toggle) → [data-slot="sidebar.right.tab.files.actions"](display:contents)
```

插件的 `.mrfw-rootSwitcher` 是该槽的 occupant，靠 `order:-1` 与 `flex:1 1 auto`
接管 PathLabel 的位置；槽内后续还有上游的 open-in-app 分离按钮（主根态）。

`.mrfw-rootSwitcher` 的内部（主根态）：

```text
Menu 的 anchor 包装 span（.root，display:inline-flex）
  └ button.mrfw-rootSwitchBtn（folder 图标 + 根名 label + chevron）
PathLabel.mrfw-switcherPath（选中根的完整路径）
[附加根接管态] button.mrfw-switcherReload + button.mrfw-switcherSearch + open-in-app fork
```

### 根因

`.mrfw-rootSwitchBtn` 自身写了 `flex: 0 1 auto; min-width: 0`，label 也写了
`min-width: 0 + overflow:hidden + text-overflow:ellipsis`——设计意图是"可以收缩、省略号"。
但**真正参与外层 flex 的是 `Menu` 的 anchor 包装 span**，它没有 `min-width:0`：

- 它是 `.mrfw-rootSwitcher` 的 flex item，默认 `min-width:auto` ⇒ 自动最小尺寸等于
  内容 min-content；按钮里的根名是 nowrap，min-content 就是完整根名。
- 于是该 item 的 used width 被钉在 min-content（实测 `dsh-plugin-multi-root-workspace`
  为 249.59px，其中 label 202.59px），`.mrfw-rootSwitcher` 自己被 `flex:1 1 auto`
  压缩到分配宽度后，**触发器盒子比分配到的宽度更宽，直接溢出并画到后续控件上去**。
- 同一行里唯一能收缩的是 `mrfw-switcherPath`（上游 PathLabel `flex:1 1 auto;
  min-width:0`），它先被压到 0，然后没有任何东西继续让位 ⇒ 溢出。

即：**收缩能力写在了内层按钮上，外层包装把最小值钉死，收缩从未发生**。

### 量化证据

一次性 Chromium 复刻（宿主 0.2.2-rc.3 的 `FilesBody`/`PathLabel`/`Menu`/
`OpenTargetButton` CSS module 原文 + 生产样式表原文 + 真实 DOM 结构；宽度为
`[data-files-page]` 的 CSS 宽度）：

| 页宽 | 主根态 trigger 盒宽 | 与 reload 重叠 | 与 search 重叠 | 与 open-in-app 重叠 |
| --- | --- | --- | --- | --- |
| 400 | 249 | 0 | 0 | 0 |
| 380 | 249 | 1.59 | 0 | 0 |
| 360 | 249 | 21.59 | 0 | 0 |
| 344 | 249 | 28（整枚） | 5.59 | 0 |
| 299 | 249 | 28 | 28 | 14.59 |
| 220 | 249 | 28 | 28 | 43（整枚） |

附加根接管态更糟：插件自绘的 reload / search / open-in-app 被固定在 trigger 之后，
页宽 ≤ 400 时整行 `scrollWidth` 超过 header，open-in-app 被推出页外。

真实 GUI（隔离 scratch `$DSH_HOME` + 本仓库构建产物 `dsh plugin add` + `dsh web`
+ headless Chromium CDP）实测三种工况的开箱状态：

| 工况 | 触发方式 | Files pane 宽 | 开箱重叠 |
| --- | --- | --- | --- |
| 变窄的右侧栏 | 拖右栏分隔条到最小值 | 299 | reload 28 / search 28 / open-in-app 14.59 |
| 右侧栏双栏 | 页头 `Split` | 323 | reload 28 / search 5.59 |
| 可拖动的小窗 | 把 Files tab 拖出成浮动面板，缩到最小 | 220 | reload 28 / search 28 / open-in-app 43 |

（右栏单栏最小宽 299、浮动面板最小宽 220 来自上游布局常量 `FLOAT_MIN_SIZE` 与实测。）

## Design

一条收缩优先级规则，三层：

1. **固定控件永不移动、永不收缩**：reload / search / open-in-app（主根态来自 header，
   附加根态来自 switcher 内部）保持原生 `flex:none` 与原生几何。
2. **完整路径先让位**：`.mrfw-switcherPath` 改为 `flex: 1 1 0; min-width: 0`。
   零 flex-basis 使它只能在**有富余**时占位、在缺空间时无法吸收任何 deficit ⇒
   路径从"占满余量"一路压到 0，期间根名不受影响。
3. **根名其次**：给 `Menu` 的 anchor 包装 span 加 `className="mrfw-rootSwitchAnchor"`，
   规则 `flex: 0 1 auto; min-width: 0` 解开 min-content 钉子；根名 label 随即按既有
   `overflow:hidden + ellipsis` 省略。
4. **最后是图标**：`.mrfw-rootSwitchBtn` 增加 `overflow: hidden`，页宽小于"图标 +
   固定控件"的物理下界时，触发器自己的图标被裁剪而不是画到邻件上（此时上游本身也已
   无法容纳 header，只保证"不互相覆盖"）。

兼容性：

- `Menu` 的 `className` prop 在全部 24 个受支持发布上存在（`0.1.5-rc.2` 起逐 tag
  核对：`className?: string | undefined`，且都落在 `<span className={clsx(css.root, className)}>`
  这个 anchor 包装上）；旧宿主上规则同样生效，无版本分支。
- 不新增 `:has()` 依赖（插件样式表本就依赖它，接管规则失效时整套接管都会退化）；
  新规则只用 flex 与一条既有 class。
- 不依赖任何新的上游 DOM 钩子；`Menu` 的 `className` 是公开 prop。

## Non-goals

- 不改上游 `FilesBody` header、不复刻 header；不隐藏 reload / 搜索 / open-in-app。
- 不改 `RootSwitcher` 的菜单、Portal、selection 或搜索语义；不改接管条件。
- 不为"页宽小于上游自身可容纳宽度"的极端情况设计新交互（例如折叠触发钮）；
  只保证不重叠、不错误放大。

## Implementation

### Phase 0 — 取证、方案与文档骨架

- 复刻与真实 GUI 定量取证（见 §Background）；写本计划与 [ADR-0046](../../decisions/ADR-0046-files-header-rootswitch-shrink-priority.md)。
- 更新 `docs/plans/README.md`/`.en.md`、`docs/decisions/README.md`/`.en.md` 索引。

**退出验收**：`pnpm docs:check` 通过；计划中的数值可复跑（复刻 HTML 与 GUI 测量脚本
为一次性临时件，不入库）；根因有真实 GUI 证据（不只截图推断）。

### Phase 1 — 实现与测试

- `src/client/RootSwitcher.tsx`：`Menu` 传 `className="mrfw-rootSwitchAnchor"`。
- `src/client/styles.ts`：§Design 的三条规则 + 注释（说明"收缩能力必须写在参与
  外层 flex 的 anchor 上"与三级优先级）。
- `tests/client-styles.spec.ts`：钉住 anchor 规则（`flex: 0 1 auto` + `min-width: 0`）、
  path 规则（`flex: 1 1 0` + `min-width: 0`，且选择器优先级高于上游 `.path` 的
  `flex: 1 1 auto`）、trigger `overflow: hidden`；实现前红、实现后绿。
- `tests/client-switcher.spec.tsx`：钉住渲染出的 anchor 包装带 `mrfw-rootSwitchAnchor`
  class（否则样式规则无目标，回归会静默失效）。

**退出验收**：`pnpm lint`、`pnpm typecheck` 绿；`vitest run tests/client-styles.spec.ts
tests/client-switcher.spec.tsx tests/client-files.spec.tsx` 绿；新增断言在实现前失败
（记录红测证据）。

### Phase 2 — 构建与真实 GUI 视觉验证（三工况）

- `pnpm build` 后按 `dsh plugin --profile web add <repo>` 重装进隔离 scratch `$DSH_HOME`，
  `dsh web` + headless Chromium CDP 重放 §Background 的三种工况。
- 在 220 / 299 / 323 / 344 / 380 / 400 / 520 七个宽度读取真实 DOM 的
  `getBoundingClientRect`：所有可见 header 项两两重叠为 0；header `scrollWidth ≤
  clientWidth` 直到上游可容纳下界；根名在 > 阈值时完整、不足时省略号；
  路径在有余量时出现。
- 截图留档（宽形态回归 + 三工况各一张）并放入 PR 描述。

**退出验收**：三工况重叠全部为 0；宽形态（pane ≥ 520）根名不出现省略号、路径可见；
附加根接管态下插件自绘的 reload / search / open-in-app 仍在页内且不重叠；
220 宽下 open-in-app 完整可见。

### Phase 3 — 文档同步与收尾

- `docs/architecture/multi-root-workspace.md` Files actions 段补窄宽让位规则；
  `.agent/note/dsh-compat-contract.md`/`.en.md` 追加 quiet trap（Menu anchor 包装是
  flex item，收缩必须写在它上面；header 是扁平 flex，溢出会画到后继控件）。
- 进度总账追加一行；计划移入 `docs/plans/completed/`；PR 描述按仓库既有结构写
  （背景 / 根因 / 修复 / 验证证据 / 文档影响）。

**退出验收**：`pnpm docs:check` 绿；文档与实现无矛盾。

### Phase 4 — Draft PR 与 CI

- 推送分支，开 Draft PR（标签 `kind/fix` + 相关 `area/*`，Issue Type 按需）。
- 只保留最后一个提交的 CI：新 push 前先取消旧 run（`gh run cancel`），确认最终提交
  的 run 全绿。

**退出验收**：PR 为 Draft；head commit 的具体 run 全部 checks 通过；被取代的 run 均已
cancel，无重复消耗。

## Validation

```sh
pnpm build                     # 产物（lib/client.js）必须先构建，GUI 验证用
pnpm lint
pnpm typecheck
pnpm test                      # 全量 vitest（含 client-styles / client-switcher）
pnpm docs:check
pnpm compat:check              # 依赖/精确版本合同未改动
```

矩阵策略：本次改动是纯 client 样式 + 一个公开 prop 的透传，无版本分支、无新导出、
无类型或接口变化；不需要在 `SUPPORTED_DSH_RELEASES` 上新增适配分支。

### 真实 GUI 目检（实施者执行，截图入 PR）

1. 隔离 scratch `$DSH_HOME` 安装当前构建，`dsh web` 打开，进入一个仓库 Session，
   在右侧栏打开 Files 页签。
2. 三工况复现：拖右栏分隔条到最小（299）；`Split` 双栏（单栏约 323）；把 Files tab
   拖出成浮动面板并缩到最小（220）。
3. 每个工况：截图；DOM 量测 header 各项矩形并断言两两重叠为 0、`scrollWidth ≤
   clientWidth`；确认根名/路径按优先级让位。
4. 宽形态回归：把右栏拉宽到 ≥ 520，确认根名完整、路径出现、控件位置与改动前一致。

## Risks

| 风险 | 处理 |
| --- | --- |
| 上游 `Menu` 不再把 `className` 放在 anchor 包装上 | 24 个受支持 tag 已逐版核对；计划 Phase 1 的 switcher 组件测试钉住 class 落在 `[aria-haspopup=menu]` 的直接父级，样式失效时测试先红 |
| 路径`flex:1 1 0` 改变宽形态下路径的可见宽度 | 有富余时零 basis 仍由 grow 占满余量，宽形态几何与改动前一致（Phase 2 的 520/400/380 量测对比） |
| 极端窄宽下触发器图标被裁剪"看起来坏" | 只有页宽小于上游 header 自身可容纳宽度时发生；优先保证不重叠，且上游同宽下同样溢出 |
| 旧宿主（0.1.5/0.1.6）无 PathLabel 的 fallback path span 行为变化 | fallback 仍走同一规则；其 `min-width:0` 只允许收缩，不改变可见文本内容；Phase 1 样式测试覆盖 |
| 只改 CSS 被误认为"偶然生效" | ADR-0046 记录优先级与机制，样式测试钉住三条规则，GUI 量测留档 |

## Documentation Impact

| 文档 | 改动 |
| --- | --- |
| `docs/decisions/ADR-0046-files-header-rootswitch-shrink-priority.md` | 新增 |
| `docs/decisions/README.md` / `.en.md` | ADR-0046 索引行 |
| `docs/plans/README.md` / `.en.md` | 本计划行（active → completed） |
| `docs/plans/active/2026-09-12-multi-root-workspace.md` | 进度总账新行 |
| `docs/architecture/multi-root-workspace.md` | Files actions 段补窄宽让位规则 |
| `.agent/note/dsh-compat-contract.md` / `.en.md` | quiet trap：anchor 包装是 flex item；扁平 header 的溢出语义 |
| `README.md` / `README.en.md` | 无需改（行为修正，无新用户操作） |
| `CHANGELOG.md` / `.en.md`、`AGENTS.md` 项目状态 | 发版准备阶段再改，不在本 PR 手改 |

## Completion Criteria

- 三种窄宽工况下 header 任何可见项两两重叠为 0，header 不出现横向溢出（直到上游
  自身可容纳下界）；220 宽下 open-in-app 完整可见。
- 宽形态（pane ≥ 520）根名完整无省略号、路径可见、控件位置不变。
- 新增测试实现前红、实现后绿；`pnpm lint` / `typecheck` / `test` / `build` /
  `docs:check` / `compat:check` 绿。
- 真实 GUI 三工况截图与 DOM 量测入 PR。
- ADR-0046、索引、架构、compat note 同步；计划移入 completed 并回填证据。
- Draft PR 打开，最终提交的 CI run 全绿且仅保留该 run。

### P5 — 三档根名显示（2026-11-17 追加需求）

用户追加需求：宽度不够时除"开头…"外还要把结尾显示清楚，避免同前缀根无法区分。已确认的
规则与实现：

- 三档：全名 → `前几个…后几个`（自适应最大化可见字符；优先在分隔符处断开；尾部上限
  10 个字符、前缀 ≥ 3、尾部 ≥ 4）→ `开头…`。
- 判定输入是 `RootSwitcher` 自身宽度（`flex: 1 1 auto` ⟹ 恒等于 header 留给它的空间，
  与文字内容无关），文字变短不会反馈进判定、不会抖动。
- 量测：标签自身字体的 offscreen canvas；无 canvas 时退回触发器内隐藏探针的同步布局
  读取（jsdom 两者都退化为全名 + CSS 省略号兜底）。
- 名被截断时隐藏 `PathLabel` 墨迹（盒子保留，reload/搜索/open-in-app 仍在原生位置）；
  完整名称仍是按钮的 `aria-label`。
- 决策记入 [ADR-0046](../../decisions/ADR-0046-files-header-rootswitch-shrink-priority.md)
  §修订（2026-11-17）。

**退出验收**：三档在真实 GUI 逐档出现且无重叠；宽形态仍显示全名与路径；既有门禁全绿。

**真实 GUI（隔离 Web 宿主；宽度为 `[data-files-page]` 的 CSS 宽）**：

| pane 宽 | 形态 | 根名 |
| --- | --- | --- |
| 520 | full | `dsh-plugin-multi-root-workspace`（路径 `multi-root-workspace` 同时可见） |
| 420 | full | 全名（路径余 22px） |
| 394 | middle | `dsh-plugin-multi-root-…rkspace` |
| 380 | middle | `dsh-plugin-multi…workspace` |
| 360 | middle | `dsh-plugin-multi…rkspace` |
| 344 | middle | `dsh-plugin…workspace` |
| 320 | middle | `dsh-plu…workspace` |
| 299 | middle | `dsh…workspace` |
| 附加根（`…-ssh`）420 / 344 / 299 | middle | `dsh-plugin-multi-root-…kspace-ssh` / `dsh-plugin-multi…e-ssh` / `dsh-…space-ssh` |
| 双栏 233 | head | `dsh…` |
| 浮动小窗 220 | head | `d…` |

以上每个状态的两两重叠均为 0；截断状态 PathLabel 墨迹隐藏（`visibility: hidden`），
带头尾的显示让 `…-workspace` / `…-experiment` / `…-ssh` 这类同前缀根仍可区分。

## Progress

| 阶段 | 状态 | 证据 |
| --- | --- | --- |
| P0 取证与计划 | 完成（2026-11-17） | 提交 `3b5d62e`：§Background 的复刻与真实 GUI 数值；本文件 + [ADR-0046](../../decisions/ADR-0046-files-header-rootswitch-shrink-priority.md)；索引与总账 |
| P1 实现与测试 | 完成（2026-11-17） | 提交 `6380ffe`：`Menu` 传 `mrfw-rootSwitchAnchor`、三条样式规则、`tests/stubs/ui-primitives.tsx` 的 Menu 改为与真实原语同形的 anchor 包装（`className` 落点即 flex item）；新增 4 项断言实现前红、实现后绿；`vitest run tests/client-` 26 文件 643 项全绿；`pnpm lint` / `pnpm typecheck` 绿 |
| P2 构建与 GUI 目检 | 完成（2026-11-17） | 隔离 scratch `$DSH_HOME` + `dsh plugin add` + `dsh web`（DSH `0.2.2-rc.3`）+ headless Chromium CDP；三工况 + 附加根接管态实测（见 §Evidence）；宽形态几何与改动前逐值相同 |
| P3 文档同步 | 完成（2026-11-17） | 架构段、compat note 中/英 quiet trap、ADR-0046/索引/总账；`pnpm docs:check` 0 errors；本计划移入 `completed/` |
| P4 Draft PR 与 CI | 完成（2026-11-17） | Draft PR 已开；分支最终提交的 CI 结果见 PR 页面（本仓库只保留最新提交的运行） |
| P5 三档根名显示（追加需求） | 完成（2026-11-17） | 提交 `eacbc98`：新增 `root-name-fit.ts`（三档纯函数）与 `root-name-room.ts`（宽度预算 + 文字量测），`RootSwitcher` 接线、样式表探针与 PathLabel 隐藏规则；`client-root-name-fit` 11 项、`client-root-name-room` 6 项、switcher 新增 3 项、styles 新增 1 项；真实 GUI 见 §P5 |

### Evidence（实施后回填）

**一次性 Chromium 复刻（宿主 0.2.2-rc.3 CSS module 原文 + 生产样式表原文 + 真实 DOM 结构）**：
修复后页宽 520…180 的每一项两两重叠为 0；附加根接管态在页宽 ≥ 400 时 header 不再溢出
（`scrollWidth ≤ clientWidth`），插件自绘的 reload/搜索/open-in-app 留在页内。

**真实 GUI（隔离 Web 宿主，headless Chromium CDP；宽度为 `[data-files-page]` 的
`getBoundingClientRect`）**：

| 工况 | pane 宽 | 改动前 | 改动后 |
| --- | --- | --- | --- |
| 宽形态（单栏） | 647 | 无重叠；触发 249、路径 249 | **完全一致**：触发 249@809、路径 249@1062、label 不省略 |
| 变窄的右侧栏（单栏最小宽） | 299 | 触发 249；与 reload 28、搜索 28、open-in-app 14.59 重叠 | 触发 150、路径 0，**重叠全 0**，`clientW = scrollW = 299`，根名三档显示（P5 之后为 `dsh…workspace`） |
| 右侧栏双栏（默认对分） | 323 | 触发 249；与 reload 28、搜索 5.59 重叠 | 触发 174、路径 0，**重叠全 0** |
| 右侧栏双栏（拖到更窄） | 233 | （低于单栏最小值，改动前同样溢出） | 触发 84、路径 0，**重叠全 0**，三个控件均在页内 |
| 可拖动的小窗（浮动面板默认） | 380 | 触发 249；与 reload 1.59 重叠 | 触发 231、路径 0，**重叠全 0** |
| 可拖动的小窗（缩到最小） | 220 | 触发 249；与 reload 28、搜索 28、open-in-app 43 重叠（open-in-app 被整枚覆盖，根名越出页右缘） | 触发 71、路径 0，**重叠全 0**，`clientW = scrollW = 220`，open-in-app 完整可见 |
| 附加根接管态（宽） | 647 | 触发 322、路径 176、三个插件控件可见 | 规格不变：触发 322@809、路径 176@1135、reload 28@1327 / 搜索 28@1359 / open-in-app 43@1391 |
| 附加根接管态（单栏最小宽） | 299 | header 溢出（scrollWidth ≈ 408 > 299），open-in-app 被推出页外 | 触发 150、路径 0，**重叠全 0**，三个插件控件均在页内 |
| 附加根接管态（双栏更窄） | 233 | 同上溢出 | 触发 84、路径 0，**重叠全 0**，open-in-app 在 977..1020（页右缘 1026）内 |
| 附加根接管态（浮动最小） | 220 | 同上溢出 | 触发 71、路径 0，**重叠全 0**，三个插件控件均在页内 |

锚点包装的计算样式在修复后为 `min-width: 0px; flex: 0 1 auto`，类名为
`_root_… mrfw-rootSwitchAnchor`（确认 `Menu.className` 落在真实 flex item 上）。
三工况的前后截图（crop）留在 gitignore 的临时目录、结论入 PR 描述。
