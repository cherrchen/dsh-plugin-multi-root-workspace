# Workspace 发现提示（Worktree Toast）位置与形态重构

> 状态：**已完成——需求同步与初始计划（2026-11-15 评审完成）**，分支 `feat/workspace-toast`；实施随 `v0.1.20` 发版。评审决定与最终实施/退出验收见 [实施计划](./2026-11-15-workspace-toast-implementation.md)；两文冲突时以实施计划为准。

## 0. 结论摘要

- 需求：把「发现 {count} 个可添加的工作目录」的常驻提示从**右下角**改成 **Hero 页顶部居中**（与官方 Toast 同一落点）/ **对话页右上角、Header 下方**；提示内部控件改用 `@deepseek-ai/dsh-client-ui-primitives`；不移动输入框；本功能可以继续自绘容器。
- 建议：**页面感知的两套落点** + 一张 16px 圆角、无描边、带 elevation 的常驻提示卡；操作使用 `Button`、`Menu`、`Tooltip`（按版本兼容性包裹），关闭改用图标；不改变任何触发、RPC、授权与生命周期语义。
- 关键约束：本插件承诺 **24 个精确 DSH 版本**（`0.1.5-rc.2` … `0.2.2-rc.3`）。primitives 的导出、图标名、`Button` 的 ref 能力、页面 DOM 探针都必须按矩阵降级，否则 `0.1.*` 车道会在 typecheck 或运行期失败。
- 本轮未改代码。需要用户拍板的点集中在 §1.4，默认推荐值已给出。

## 1. 需求同步

### 1.1 用户诉求逐条同步

| 用户原话 | 同步结论 | 备注 |
| --- | --- | --- |
| 当前发现功能的 Toast 在右下角跳出 | 现状属实：`src/client/styles.ts` 的 `.mrfw-toast` 为 `position: fixed; right: 24px; bottom: 24px` | 截图 1、3 可直接复现 |
| 希望在 Hero 页的正上方中间（与官方 Toast 相同） | Hero 视角的落点定为：视口顶部、水平居中于聊天列/输入卡；纵向与官方 Toast 对齐（`top: 40px`） | 「居中于视口」还是「居中于输入卡」见 Q2 |
| 或者对话页的右上角（注意不要放到 Header 上） | 对话页视角的落点定为：会话内容区右上角、**Header 下沿之下**，不覆盖 Header 控件 | 需要页面感知；见 §3.1 |
| 调整 Toast 的格式 | 重做信息层级、表面、圆角、间距、按钮与关闭控件；保留「常驻、非模态、无 backdrop、无 focus trap」 | 见 §3.2 |
| Toast 中的组件使用 `@deepseek-ai/dsh-client-ui-primitives` | 操作区的按钮、下拉菜单、图标、Tooltip 全部改用 primitives；容器继续自绘 | 映射见 §3.3；兼容性见 §4.5 |
| 本功能本身的 Toast 可以不使用上游的 Toast | 采纳：上游 `Toast` 是**瞬时、深色、只有内联文字动作**的横幅，无法承载常驻 + 菜单 + 按钮；本提示改为「常驻提示卡」而沿用 Toast 的落点/动效语言 | 见 §3.6 |
| 当前自绘 Toast 还需要 UI/UX 设计优化，先分析缺点再给修改意见 | 本文第 2 节给缺点分级，第 3 节给目标设计 | 用户明确要求先分析 |
| 对话页右下角会遮盖输入框；若不放到右下角，也可以向上平移输入框来避开（但 DOM 读取不优雅） | **不移动输入框**。输入框是 sticky 布局 + 滚动锚点 + 会话内容宽度轴的核心，移动它会引入 reflow/跳动，且不解决「提示离上下文远」的问题；应移动提示本身 | 该备选方案在第 2 节明确否决 |
| 先在 `feat/workspace-toast` 分支做，不要直接改代码，先给报告审阅 | 已确认当前分支为 `feat/workspace-toast`、工作区干净；本轮只新增本报告 | 是否提交该报告由用户决定 |

### 1.2 现状（代码事实）

- 组件：`src/client/WorktreePrompt.tsx`，注册在 `shell.overlay`（`src/client/index.ts`），会话激活时调用一次 `worktreePrompt(sessionId, { fresh: true })`，有候选则渲染提示。
- 提示 DOM：`WorktreePrompt.tsx` 第 488–522 行，一个 `div.mrfw-toast[role=status][aria-live=polite]`，内含文本、`button.mrfw-btnPrimary`（查看）、原生 `select.mrfw-select`（稍后）、`button.mrfw-iconBtn`（× 文本字形）。
- 样式：`src/client/styles.ts` 第 1420–1490 行。右下角固定定位、`width: max-content`、`max-width: min(360px, calc(100vw - 48px))`、`padding: 14px 16px`、`border: 0.5px solid var(--dsw-alias-border-l2)`、`background: var(--dsw-alias-bg-layer-2)`、`box-shadow: var(--dsw-elevation-prominent)`、`border-radius: var(--dsw-radius-md)`。
- 触发与生命周期规则：`docs/decisions/ADR-0039-worktree-aware-root-suggestions.md` §20.1–§20.3，以及 `docs/plans/completed/2026-11-09-worktree-aware-root-suggestions.md` 第二十次修订小节。
- 测试：`tests/client-worktree.spec.tsx` 用 `getByLabelText('worktree.toastLater')` + `fireEvent.change` 驱动原生 select；样式测试 `tests/client-styles.spec.ts` 目前没有覆盖 Toast。
- 用户截图（2026-11-15）：
  - 截图 1：提示卡本体——文本 14px，操作行为「黑色胶囊查看 / 带原生箭头的稍后下拉 / 裸 ×」三种不同控件语言。
  - 截图 2：Hero 页，提示在右下角，与 Hero 内容无视觉关系。
  - 截图 3：对话页，提示压住输入卡右端（模型选择器/发送按钮一侧），确认了「右下角遮盖输入框」的问题。

### 1.3 范围与非目标

**范围内**

- 提示的落点、尺寸、表面、排版、操作控件、可访问性、入场动效与响应式退化。
- 页面感知所需的只读 DOM 探针、兼容降级与对应测试。
- 必要的图标兼容、词典键、ADR/计划/README/CHANGELOG。

**非目标（本轮不做）**

- 不改 `fresh` / `seen` / `snooze` / `resolve` 的线协议、宿主复验、授权、Registry 写入与去重规则。
- 不改触发时机（仍是一次会话激活一次只读检查）、不自动添加/删除根、不自动打开 Dialog。
- 不改「常驻、不自动消失、非模态、无 backdrop、无 focus trap」。
- 不改「查看」仍是唯一打开 Dialog 的入口；不改「×」只关闭、不写状态；不改「稍后」三档（永久不再提示仍在 Dialog）。
- 不改 Dialog 本体（`Modal`、自定义按钮与下拉保持现状）；统一 Dialog 控件是后续独立任务。
- 不移动输入框、不修改上游 DOM/样式/插槽契约。

### 1.4 待确认问题（推荐值已给出，无异议即可按推荐实施）

| 编号 | 问题 | 推荐 | 备选 |
| --- | --- | --- | --- |
| Q1 | Hero 与对话页是否使用**两套不同落点**？ | 是：Hero 顶部居中；对话页右上、Header 下方 | 两页统一顶部居中（会压住对话 Header，不满足「不要放到 Header 上」） |
| Q2 | Hero「正上方中间」的水平基准 | 居中于输入卡（`[data-composer-card]`），无法取得时退回聊天列中心再退回视口中心；与官方 `Toast anchor` 的用法一致 | 严格居中于视口（官方 Toast 默认值），但与聊天列不完全对齐 |
| Q3 | 对话页「右上角」的水平基准 | 会话内容列右缘 − 24px（列内右上角） | 对齐输入卡右缘（更贴近聊天内容宽度，但在宽窗口下显得离右缘很远） |
| Q4 | Hero 顶部纵向距离 | `top: 40px`（与官方 Toast 一致） | 使用 `--dsh-frame-overlay-top`（macOS 为 68px，更远离窗口 chrome，但比官方 Toast 低 28px） |
| Q5 | 对话页 Header 下的间距 | 12px | 8px / 16px |
| Q6 | 「稍后」是否由原生 select 改成 primitives `Menu` | 改成 Menu（触发按钮 + 菜单项），保留「直到出现新 worktree / 7 天 / 30 天」三档 | 保留原生 select（不满足「组件使用 primitives」） |
| Q7 | 关闭控件是否加 Tooltip | 加；用 `Tooltip` 包一层普通 `span`（不能直接包 `Button`，见 §4.5），文案复用 `worktree.toastClose` | 只保留 `aria-label`，不加 Tooltip |
| Q8 | 窄屏/触控形态 | 宽度不足或 `pointer: coarse` 时改为两行（文本行 + 操作行），控件高度 32px | 保持单行，允许溢出/换行 |
| Q9 | 与官方瞬时 Toast 的叠放 | 接受偶发重叠（官方 Toast 短暂出现且 z-index 更高）；不为此加特殊避让 | Hero 落点下移 56px 避开官方 Toast（偏离官方落点） |
| Q10 | 提示卡表面 | 浅色 elevated card：`--dsw-alias-bg-layer-2` + `--dsw-elevation-panel`、无描边、R16，参考上游常驻公告卡 `AccountNotice` | 沿用官方 Toast 的深色表面（`--dsw-alias-toast-bg`）；但内部按钮/菜单在深色面上的颜色体系需要额外设计，风险更高 |

## 2. 现状缺点分析

### 2.1 位置与遮挡（P0）

1. **直接遮挡输入框。** 右下角 24px 与输入卡同处页面底部；对话页中提示卡正好压住输入卡右端（截图 3）。输入框是用户当前任务的中心，提示是次要建议，优先级颠倒。
2. **页面无关。** Hero 页与对话页共用一个固定落点：Hero 页上它离 Hero 标题/输入卡很远（截图 2），对话页上它遮住输入框；两个页面都没有获得「靠近上下文」的效果。
3. **与输入框避让的备选方案不可取。** 向上平移输入框需要改 sticky composer 的布局/边距，触发 reflow、滚动锚点与内容宽度轴变化，还会在提示消失后跳回；同时需要额外 DOM 读取。移动提示本身成本更低、副作用更小。
4. **不感知窗口结构。** 固定 `right: 24px` 不考虑右侧栏（打开 Files 侧栏时会盖在右侧栏或对话列边界上）、侧栏抽屉、窗口 chrome 与安全区；窄窗口下 `max-width` 只保证不超出视口，不保证不压住输入卡。

### 2.2 形态与信息层级（P1）

5. **看起来像系统告警，不像「工作目录建议」。** 没有前置图标、没有标题/说明层级，只有一行计数文本；与功能的语义（发现可添加的工作目录）没有视觉连接。
6. **「Toast」名不副实。** 按 ADR 它是常驻、可交互、可延后、不自动消失的提示；上游 Toast 是瞬时、只读、最多内联文字动作的横幅。当前实现借用了 Toast 的「浮层」概念，却没有采用其表面/动效，也没有形成自己的「常驻公告卡」语言。
7. **文本与操作区堆叠成表单感。** 文本一行、操作一行，卡片高度约 92px；在右下角小面积里显得笨重，也没有明确的阅读起点（图标/标题）。

### 2.3 控件组成与交互（P1）

8. **三种控件语言混用。** 「查看」是自绘黑色胶囊（28px、字号 12、圆角 14px），「稍后」是伪装成按钮的原生 `select`（28px、R8、原生箭头与原生弹层），「×」是文本字形按钮（28px、R8）。三者高度相同但字体、圆角、图标、悬停/焦点反馈都不一致。
9. **原生 select 的语义与视觉都不合适。** 可见标签「稍后」是一个 disabled 的占位 option；点击后打开的是操作系统/浏览器原生菜单，无法沿用 DSH 的菜单材质、键盘导航、选中标记与主题；选项文案较长（「直到出现新 worktree」）时布局不受控。
10. **「稍后」读起来像单次动作，实际是时长选择。** 用户会预期点一下即延后，实际必须再选一次；而「×」也关闭提示，二者长期效果不同（× 不写 snooze），但界面没有解释，用户无法判断「关掉后还会不会再提醒」。
11. **自绘按钮缺少成体系的交互状态。** `.mrfw-btn` 只有 hover/active/disabled，没有 `:focus-visible` 规则；关闭按钮没有 Tooltip；原生 select 又自带另一套焦点样式。
12. **键盘路径不完整。** 提示异步出现后没有焦点管理（这本身是对的，非模态），但无法用 Escape 关闭；Tab 需要从页面末尾走到提示；自定义按钮的焦点可见性未验证。

### 2.4 视觉工艺（P1/P2）

13. **违反「无描边 + elevation」的浮层配方。** 当前同时使用 `border: 0.5px solid var(--dsw-alias-border-l2)` 与 `box-shadow: var(--dsw-elevation-prominent)`；上游样式规则明确要求 elevated surface 使用 `border: 0` + elevation，0.5px hairline 是阴影的第一层而不是额外描边（`docs/web-styling.md` 第 26 条）。
14. **圆角与尺寸不遵循圆角标尺。** 卡片用 `--dsw-radius-md`（R12），而带内边距的浮层卡片按上游常驻公告/Toast 的配方应为 R16（`--dsw-radius-lg`）；自绘按钮的 `14px` 胶囊圆角不在标尺上（`docs/ui-radius.md` 的 H20–28 控件为 R8，H32–40 为 R12）。
15. **无入场/退场动效。** 提示突然出现/消失；官方 Toast 有 160ms 入场 + 延时淡出。常驻提示不需要淡出，但入场可以用同一条曲线，减少突兀感。
16. **关闭字形不是图标库。** `×` 是文本字符，光学大小/字重与 16px 图标不一致，也没有图标的悬停/禁用语义。
17. **浅色卡与官方深色 Toast 并存。** 顶部若同时出现官方瞬时 Toast，会出现两种完全不同的浮层表面；当前浅色卡本身方向合理（可交互），但需要明确「常驻建议卡」与「瞬时系统 Toast」是两种语言。

### 2.5 可访问性（P1）

18. **`role="status"` 包裹交互控件。** status/live region 适合纯文本通知；把按钮和下拉放进 live region，屏幕阅读器可能只播报文本变化，用户不容易发现其中控件，且局部更新会重复播报。
19. **缺少区域名。** 整个提示没有可读的 `aria-label`；用户听到一段孤立文本，不知道它属于哪个功能区。
20. **原生 select 的可访问名是「稍后」，不是实际决策。** 选项才是真正的选择；把占位文本当标签会让读屏用户误解。
21. **没有 Escape 关闭路径。** 非模态提示也不应强迫用户用鼠标；焦点在提示内时 Escape 关闭是低成本的补全（菜单打开时由 Menu 自己消费 Escape）。
22. **对比度未验证。** 12px 的 `label-secondary` 文本、disabled 占位 option 在深浅两套主题下都需要验证。

### 2.6 响应式与平台（P2）

23. **28px 控件在触控/粗指针下偏小。** 上游粗指针工具栏一般为 32px；当前没有 `pointer: coarse` 分支。
24. **窄屏只靠换行兜底。** 360px 上限 + 原生 select 的 180px 上限在窄窗口/长本地化文案下会挤压文本或让操作行换行，缺少明确的两行紧凑形态。
25. **不处理窗口 chrome 与安全区。** 顶部布局需要 macOS 顶部 clearance / Windows caption 的换算（见 §3.1）；当前底部方案没有这个问题，但改成顶部后必须处理。

### 2.7 问题分级汇总

| 级别 | 问题 | 处理 |
| --- | --- | --- |
| P0 | 右下角遮输入框；页面无关；移动输入框的备选方案不可取 | 本任务修复 |
| P1 | 控件语言混用/原生 select；信息层级缺失；a11y（status 包裹控件、区域名、Escape）；边框+elevation、圆角标尺 | 本任务修复 |
| P2 | 触控尺寸、窄屏两行、深浅色对比、与官方 Toast 的偶发重叠 | 本任务处理或明确接受 |
| 保留 | 常驻不自动消失；× 不写状态；查看才开 Dialog；三档稍后 | 按 ADR 保留，不在本任务变更 |

## 3. 目标设计

### 3.1 位置模型

**页面感知（只读探针，失败即降级）**

- 主会话根：`document.querySelector('[data-phase]')`。`data-phase` 在 `0.1.5-rc.2` 已存在，取值 `hero` / `active` / `settling`；读不到时按「Hero 顶部居中」降级，绝不回到右下角。
- Hero / settling：`top = 40px`；水平中心依次取 `[data-composer-card]` 的中心、会话根中心、视口中心。`data-composer-card` 在 `0.1.5-rc.2` 已存在。
- 对话页 active：
  - 内容区顶部：优先 `[data-conversation-content]` 的 `getBoundingClientRect().top`（`0.2.1-alpha.3+`）；否则测量会话根第一个子元素（Header），取可见时的 `bottom`；再退化到会话根 `top`。
  - `top = 内容区顶部 + 12px`（保证在 Header 下方；Header 最小 76px，可能因页签换行而更高，必须测量而不是写死）。
  - `right = 内容区右缘 - 24px`（列内右上角；右侧栏打开时也留在对话列内）。
  - 可用宽度 = 内容区宽度 − 48px，与 560px 取小。
- 重排监听：`window.resize` + `ResizeObserver`（会话根/输入卡/内容区）+ `MutationObserver`（`data-phase` 属性变化）。滚动不影响 fixed 定位，不监听滚动。
- Hero → active 切换时提示若仍可见，立即重测并换位，不做动画，避免两套落点之间滑动。
- 旧版本的 Hero 头部结构与新版不同（`0.1.5` 使用 `headerHidden`，新版本使用 `headerBlank`）。实施时必须用同一探针实测 Hero 顶部 40px 内是否存在实体 Header：若存在，Hero 纵向改取 `max(40px, Header 下沿 + 12px)`；否则保持 40px。active 的 Header 通过上面的测量路径取得。

**落点对照**

| 页面 | 纵向 | 横向 | 上限 |
| --- | --- | --- | --- |
| Hero（`data-phase=hero`） | `top: 40px` | 输入卡中心（回退：列中心 → 视口中心） | `min(560px, 视口 − 32px)` |
| settling | 同 Hero | 同 Hero | 同 Hero |
| 对话页（`data-phase=active`） | Header 下沿 + 12px | 对话列右缘 − 24px | `min(560px, 列宽 − 48px)` |
| 完全读不到探针 | `top: 40px` | 视口中心 | `min(560px, 视口 − 32px)` |

### 3.2 版式与尺寸

宽屏单行形态（推荐）：

    [icon]  发现 4 个可添加的工作目录          [ 查看 ]  [ 稍后 v ]  [ x ]

- 容器：`display: flex; align-items: center; gap: 12px; padding: 10px 12px;` 高度 48px；`max-width` 按 §3.1。
- 表面：`background: var(--dsw-alias-bg-layer-2)`（Q10 备选：上游公告卡的 `--dsw-specific-input-major`）；`border: 0`；`box-shadow: var(--dsw-elevation-panel)`；`border-radius: var(--dsw-radius-lg)`（R16）；颜色 `var(--dsw-alias-label-primary)`。
- 前置图标：`IconWorkspaceTree`（既有 compat；旧版本回退 `IconFolderOpen`），16px，`var(--dsw-alias-label-secondary)`，装饰性 `aria-hidden`。
- 文本：14px/22px、`label-primary`、允许换行、`min-width: 0`；计数文案与现在完全一致（A/B 中性）。
- 操作区：`display: flex; align-items: center; gap: 8px; margin-left: auto; flex: none;`。
- 控件统一 28px 高（`Button size="sm"`）；粗指针/窄屏升到 32px。
- 窄屏/粗指针（Q8）：容器改为两行——第一行图标+文本，第二行操作右对齐；左右 16px 安全边距，顶部跟随 §3.1。
- 动效：160ms ease-out 的 `opacity + translateY(-4px)` 入场；`prefers-reduced-motion` 下只保留 opacity；不做退场动画（关闭即卸载，保持现有生命周期简单）。

### 3.3 控件映射（primitives）

| 元素 | 组件 | 用法 | 说明 |
| --- | --- | --- | --- |
| 查看 | `Button` | `variant="primary" size="sm"` | 保留唯一主操作；文字 `worktree.toastView` |
| 稍后（触发） | `Button` | `variant="ghost" size="sm"`，children = 文本 + `IconChevronDown` 12px；`aria-haspopup="menu"` + `aria-expanded` | 替换原生 select；标签文案待 Q6/§8 确认 |
| 稍后（菜单） | `Menu` | `open`/`anchor`/`items`/`onSelect`/`onClose`，`side="bottom"`、`align="end"`、`portal` | 三个 snooze 档位复用现有词典；选择后调用现有 `snoozeNotice(mode)` 并关闭菜单；`portal` 避免固定浮层裁剪 |
| 关闭 | `Button` | `variant="ghost" size="sm"`，`icon={<IconClose/>}`，仅图标 + `aria-label={t('worktree.toastClose')}`；className 收成 28×28 | 需要新增 `IconClose` compat；Tooltip 见下 |
| 关闭 Tooltip | `Tooltip` | 包一层普通 `span` 作为 anchor，Button 放在里面 | **不能直接包 `Button`**：0.1.5–0.1.7 的 Button 不是 forwardRef，Tooltip 注入的 ref 会丢（§4.5） |
| 前置图标 | 既有 compat 图标 | `IconWorkspaceTree`，回退 `IconFolderOpen` | 不新增图标资源 |
| 容器 | 自绘（插件样式） | `section` + 插件类名 | 无现成 primitives 卡片；不使用 `MenuSurface`（0.1.5 无此导出） |

不引入 `MenuSurface`、`MenuItemButton`、`Pill`：前两者在支持矩阵的旧版本缺失或行为不同，`Pill` 的 24px/选择语义与操作按钮不匹配。

### 3.4 交互与可访问性

    <section class="mrfw-notice" aria-label="工作目录建议" data-placement="hero|conversation">
      <Icon />
      <p role="status" aria-live="polite">发现 4 个可添加的工作目录</p>
      <div role="group" aria-label="工作目录建议操作">
        <Button>查看</Button>
        <Menu><Button aria-haspopup="menu">稍后 v</Button></Menu>
        <Tooltip><span><Button aria-label="关闭通知">x</Button></span></Tooltip>
      </div>
    </section>

- `role="status"` 只包文本，不包按钮；区域用 `aria-label`。
- 不移动焦点、不设 focus trap、不加 backdrop（保持 ADR 的非模态语义）。
- 焦点在提示内时 `Escape` 关闭提示；菜单打开时 Menu 先消费 Escape，再交还。
- 所有控件使用 primitives 自带的 `:focus-visible` / hover / disabled 状态；插件样式只做布局，不覆盖 primitives 的视觉配方。
- 关闭按钮有 Tooltip（Q7）与 `aria-label`；图标 `aria-hidden`。
- 座位顺序保持 DOM 顺序：图标 → 文本 → 操作；Tab 可依次到达三个控件。

### 3.5 主题与表面

- 只用 `--dsw-*` token，不写字面颜色；深/浅两套主题都要验证。
- 浮层配方：`border: 0` + `box-shadow: var(--dsw-elevation-panel)`（Q10；若设计坚持更突出的层级，可换 `--dsw-elevation-prominent`，但都不得再加中性描边）。
- 圆角按标尺：容器 R16（`--dsw-radius-lg`）；内部控件由 primitives 决定（sm = R8）。
- 字号只用主题既有角色：正文 14/22；不引入 13px 或 600 字重。
- 图标 16px，与 14px 文本按垂直中心对齐；操作区 28px 控件与文本行中心对齐。

### 3.6 与官方 Toast 的关系

- **不使用上游 `Toast` 组件**：其 API 只支持 `text` + 内联文字 `actions` + `holdMs` 自动淡出，无法承载常驻 + Menu + 独立按钮；硬套会与 ADR 的常驻语义冲突。
- **沿用其位置与动效语言**：顶部 `40px`、居中于聊天列（`anchor` 的官方用法）、160ms 入场，让用户感觉它属于同一套反馈系统。
- **视觉上区分**：官方瞬时 Toast 是深色、无交互、自动消失；本提示是浅色常驻卡、可交互、不自动消失。二者同时出现时（Q9）接受短暂重叠，官方 Toast 在上层。
- 与 Dialog 的关系不变：「查看」仍是显式确认入口；Dialog 本次不改。

## 4. 技术方案

### 4.1 文件改动清单

| 文件 | 改动 |
| --- | --- |
| `src/client/notice-placement.ts`（新增） | 纯位置解析器 + 只读 DOM 探针（`data-phase`、`data-composer-card`、`data-conversation-content`、Header 测量）；输入 rect/视口，输出 `{ top, left?, right?, maxWidth, placement }` |
| `src/client/WorktreePrompt.tsx` | 提示区改用 primitives 与 Menu；新增 placement hook、Escape、菜单状态；生命周期/RPC 调用不动 |
| `src/client/styles.ts` | 删除/替换 `.mrfw-toast`、`.mrfw-toastText`、`.mrfw-toastActions`、`.mrfw-toastSelect`；新增 `.mrfw-notice*` 布局/动效/窄屏/粗指针规则 |
| `src/compat/client-icons.ts` | 新增 `IconClose`（`IconCloseOutline16` → `IconCloseOutlineRegular`）；复用现有 `IconChevronDown`、`IconWorkspaceTree` |
| `src/client/locales.ts` | 新增区域名/操作组名（如需）与关闭 Tooltip 复用键；en/zh 同步 |
| `tests/client-notice-placement.spec.ts`（新增） | 纯解析器 + 合成 DOM 探针 + 降级路径 |
| `tests/client-worktree.spec.tsx` | select → Menu 的交互改写；新增 placement/a11y 断言；其余行为断言不变 |
| `tests/client-styles.spec.ts` | 新增提示卡规则断言：无右下角定位、border 0 + elevation、R16、动效、窄屏/粗指针、无字面颜色 |
| `tests/client-icons.spec.ts` | 新增 `IconClose` 双名兼容断言 |
| `docs/decisions/ADR-0039-worktree-aware-root-suggestions.md` | 新增第二十一次修订（UI 落点/形态/控件/compat/a11y） |
| `docs/plans/completed/2026-11-09-worktree-aware-root-suggestions.md` | 新增 P11 小节（实施项 + 验收） |
| `docs/plans/README.md` | 评审通过后登记本计划 |
| `README.md` / `README.en.md` | 更新 Worktree 建议的用户可见描述（位置/操作） |
| `CHANGELOG.md` / `CHANGELOG.en.md` | 随下一个发版记录该用户可见变化 |

### 4.2 位置解析器与 DOM 探针

- 纯函数：`resolveNoticePlacement({ viewport, phase, composerRect, contentRect, rootRect })`，不含 DOM，便于单测；返回固定定位所需的 `top` / `left`（Hero）或 `right`（对话页）与 `maxWidth`。
- 探针适配器：只在 `useLayoutEffect` 与 resize/observer 回调中读取 `getBoundingClientRect` 与 `dataset.phase`；不缓存过期 rect。
- 探针失败（元素不存在、rect 全 0、属性缺失）→ 落到「Hero 顶部居中」；禁止 fallback 回右下角。
- 监听：`window.addEventListener('resize')`、`ResizeObserver`（会话根/内容区/输入卡）、`MutationObserver`（attributeFilter: `['data-phase', 'data-content-phase']`，subtree）。
- 只在提示可见时挂监听；关闭/卸载时全部 disconnect（与现有 abort/epoch 生命周期一致）。

### 4.3 组件改造

- 保留 `WorktreePrompt.tsx` 的触发、`fresh`、`seen`、Dialog 长轮询、snooze/resolve 与 `workEpoch` 逻辑；只替换提示区的渲染与停留位置。
- `openSnooze` 状态 + `Menu` 的 `onSelect` → `snoozeNotice(mode)`；选择后关闭菜单。部分 `skipped` 时保留提示并用刷新后的 id 重新武装菜单（现有逻辑不变）。
- Escape：提示内 `onKeyDown`，菜单关闭时关闭提示；菜单打开时 Menu 自己处理。
- 关闭按钮仍调用 `closeNotice`；「查看」仍调用 `openDialog`；生命周期/epoch 行为不变。

### 4.4 样式改造

- 删除：`.mrfw-toast` 的 `position: fixed; right: 24px; bottom: 24px`、`.mrfw-toastText`、`.mrfw-toastActions`、`.mrfw-toastSelect` 及其 360px 上限。
- 新增 `.mrfw-notice`（布局、表面、R16、阴影、无描边、动效）、`.mrfw-noticeIcon`、`.mrfw-noticeText`、`.mrfw-noticeActions`、`.mrfw-noticeClose`。
- 位置由 React 计算后通过内联自定义属性/样式提供（fixed 的 top/left/right/max-width），CSS 只描述形态与响应式；不在 CSS 里写死页面落点。
- `@media (pointer: coarse)` 与窄屏：两行形态、32px 控件。
- `@media (prefers-reduced-motion: reduce)`：去掉 translate，只保留 opacity。
- 不覆盖 primitives 内部类；只通过 `className` 做布局（关闭按钮的 28×28 除外，属布局尺寸）。
- 扩展 `tests/client-styles.spec.ts`：断言不再出现 `bottom: 24px` 的 Toast 定位、border 与 elevation 的互斥配方、R16、动画、粗指针规则与「无字面颜色」。

### 4.5 兼容矩阵与证据

在 2026-11-15 从 npm 下载已发布 tarball 并检查 `lib/types/index.d.ts` / `icons/index.d.ts`（安装 pin 为 `0.2.2-rc.3`）：

| 导出/探针 | 0.1.5-rc.2 | 0.1.7-alpha.1 | 0.2.0-rc.1 | 0.2.1-alpha.3 | 0.2.2-rc.3 |
| --- | --- | --- | --- | --- | --- |
| `Button` | ✓（普通函数） | ✓（普通函数） | ✓（**forwardRef**，ref 从该版本起可用） | ✓（forwardRef） | ✓（forwardRef） |
| `Menu` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `MenuItemButton` | ✗ | ✓ | ✓ | ✓ | ✓ |
| `MenuSurface` | ✗ | ✗ | ✓ | ✓ | ✓ |
| `Tooltip` / `Tag` / `Pill` / `Toast` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `data-phase`（hero/active） | ✓ | ✓ | ✓ | ✓ | ✓ |
| `data-composer-card` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `data-conversation-content` | ✗ | ✗ | ✗ | ✓ | ✓ |
| 关闭图标名 | `IconCloseOutline16` | `IconCloseOutlineRegular` | Regular | Regular | Regular |
| Chevron 图标名 | `IconChevronDownOutline14` | Regular | Regular | Regular | Regular |
| WorkspaceTree 图标 | ✗（既有 folder 回退） | Regular | Regular | Regular | Regular |

由此得到的硬约束：

- 只用 `Button` / `Menu` / `Tooltip` / 既有 compat 图标；**不用** `MenuSurface` / `MenuItemButton`（旧版本缺失）。
- **不要把 `Tooltip` 直接包在 `Button` 上**：已核对 `0.1.5-rc.2` / `0.1.7-alpha.1` 的 `Button` 是普通函数（无 ref），`0.2.0-rc.1` 起才是 forwardRef；`0.2.0-rc.1` 之前的版本上 Tooltip 注入 ref 会丢失。用普通 `span` 做 anchor，或旧版本不提供 Tooltip。
- `Menu` 只用 0.1.5 就有的 props（`open` / `anchor` / `items` / `onSelect` / `onClose` / `side` / `align` / `portal`）。
- 页面探针全部只读、按属性名读取，失败降级；不比较版本号，符合 ADR-0002/ADR-0009 的兼容策略。

### 4.6 测试计划

- 新增 `tests/client-notice-placement.spec.ts`：Hero/active/settling/无探针四种输入；`data-conversation-content` 缺失时 Header 测量回退；窄屏 max-width；右侧栏打开时 right 计算；rect 全 0 的降级。
- 更新 `tests/client-worktree.spec.tsx`：
  - 「稍后」从 `fireEvent.change(select)` 改为点击触发按钮 + 点击菜单项；断言 `snooze` 调用参数与现有完全一致。
  - 保留并继续断言：单次自动检查、无候选不显示、失败不重试、部分 skipped 保留提示、跨会话 epoch、StrictMode 幂等、View → Dialog。
  - 新增：区域 `aria-label`、文本在 live region 而控件不在、关闭 Tooltip/aria-label、Escape 关闭、菜单键盘关闭。
  - 新增：用合成 DOM 的 `data-phase`/rect 桩断言 Hero 顶部居中与对话页右上角（jsdom 无布局，必须桩 `getBoundingClientRect`）。
- 更新 `tests/client-styles.spec.ts`：无右下角落点；`border: 0` + elevation；R16；动画/reduced motion；粗指针；无字面颜色。
- 更新 `tests/client-icons.spec.ts`：`IconClose` 双名解析。
- 保持 `tests/client-bundle.spec.ts` 不变：primitives 已是模块表成员，不新增 external/peer。
- 手动 GUI 验收：`pnpm dev:web`，逐项检查 Hero、对话页、右侧栏打开、窄窗口、深浅主题、触控模拟；截图留档。

### 4.7 文档计划

- [ADR-0039](../../decisions/ADR-0039-worktree-aware-root-suggestions.md) 第二十一次修订：落点模型（Hero 顶部居中 / 对话页 Header 下右上）、不移动输入框、primitives 清单与版本降级、DOM 探针与失败方向、a11y、与官方 Toast 的关系、明确「不改行为」。
- 本计划转为实施计划并在 `docs/plans/completed/2026-11-09-worktree-aware-root-suggestions.md` 增加 P11 小节（与现有 P 系列同构）。
- 评审通过后登记 `docs/plans/README.md` 的 active 列表。
- README / README.en 更新用户可见描述；发版时补 CHANGELOG 双语条目。
- 进度证据只记[路线账本](../active/2026-09-12-multi-root-workspace.md#进度总账)，不在计划里预写。

## 5. 验收标准

1. **Hero**：提示顶边 = 40px（±1），水平中心与输入卡中心对齐（±2）；不与 Hero Header 的控件相交；不再出现右下角落点。
2. **对话页**：提示顶边 ≥ Header 下沿 + 8px（目标 +12），右边 = 对话列右缘 − 24px（±1）；不与 Header、输入卡矩形相交；右侧栏打开时仍在对话列内。
3. **切换**：Hero → 对话页（发送首条消息）时提示在一个测量周期内换位，无闪烁/重复/残留。
4. **控件**：提示内不存在 `<select>`、不存在 `.mrfw-btn`；查看/稍后/关闭全部来自 primitives；菜单可用鼠标与键盘打开、选择、Escape 关闭并把焦点交还触发按钮；关闭有 Tooltip 与 aria-label。
5. **可访问性**：区域有可读名称；`role=status` 只包文本；控件可 Tab 到达且有可见焦点；不改变非模态/无焦点陷阱语义。
6. **行为不变**：`tests/client-worktree.spec.tsx` 的全部既有行为断言在更新交互方式后继续通过；RPC 调用序列、`fresh/seen/snooze/resolve` 参数、epoch 归属、常驻/不自动消失不变。
7. **兼容**：24 个精确版本的 typecheck 车道通过（CI）；不新增 module table external、不新增 peer；旧版本探针缺失时落在 Hero 顶部居中且不崩溃。
8. **视觉**：深浅两套主题、窄屏、粗指针、reduced motion 通过；无字面颜色；`tests/client-styles.spec.ts` 更新后通过。
9. **文档**：ADR、计划、README、CHANGELOG（发版时）同步；`pnpm docs:check` 通过。
10. **质量门**：`pnpm lint`、`pnpm typecheck`、`pnpm test`（相关文件）、`pnpm build`、`pnpm docs:check`、`pnpm compat:check`、`pnpm pack:check` 通过。

## 6. 风险与缓解

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| 页面探针依赖上游 DOM 标记（`data-phase` 等） | 上游改标记时落点退化 | 只读、集中在一个模块；逐版本快照测试；缺失即降级到 Hero 顶部居中；不猜 class 名 |
| 与官方瞬时 Toast 在 Hero 顶部重叠 | 罕见但视觉干扰 | 接受（官方 Toast z 更高、4s 消失）；或按 Q9 下移；不为此做 hack 检测 |
| Menu portal 在固定浮层内的定位/裁剪 | 菜单被裁/错位 | `portal` + `align="end"` + `side="bottom"`；在 drawer/右侧栏组合下手动验证 |
| 旧版本 Button 不是 forwardRef | Tooltip 失效或 React 警告 | Tooltip 只包 `span`，不直接包 Button；或旧版本不渲染 Tooltip |
| 更新 select→Menu 改写既有测试时漏掉行为 | 回归未被覆盖 | 保留原行为断言只改交互动作；先写失败测试再改实现 |
| 顶部落点压住对话首行消息 | 阅读干扰 | 常驻提示允许覆盖内容，但限制宽度/高度并贴右上角；不做自动隐藏（ADR） |
| 设计选择（浅色卡 vs 深色 Toast 面）未定 | 返工 | Q10 先确认；两套都只用 token，切换成本低 |
| 右侧栏/抽屉/全屏宽度变化 | 提示跑出列外 | 用内容区 rect 而不是视口 rect；ResizeObserver 跟随 |

## 7. 实施顺序与估算

1. **P11-1** 新增纯位置解析器与单测（不依赖 DOM），确定 §3.1 的四条落点与降级。
2. **P11-2** DOM 探针适配器 + jsdom 测试；在 `0.1.5` 与 `0.2.2` 语义下各跑一次合成 DOM。
3. **P11-3** `WorktreePrompt` 提示区改为 primitives（Button/Menu/Tooltip/图标）+ Menu 状态 + Escape；保持所有 RPC/epoch 逻辑不动。
4. **P11-4** `styles.ts` 形态与响应式；`client-styles.spec.ts` 先行断言（无右下角、border 0、R16、动效、粗指针）。
5. **P11-5** 更新 `client-worktree.spec.tsx`（菜单交互 + a11y + placement 桩）；`client-icons.spec.ts` 补 `IconClose`。
6. **P11-6** 文档：ADR 第二十一次修订、P11 计划小节、README；发版时 CHANGELOG。
7. **P11-7** 质量门 + 手动 GUI 证据（Hero / 对话页 / 右侧栏 / 窄屏 / 深浅主题 / reduced motion）；证据记路线账本。

估算：实现 + 单测约 1.5–2 个工作日；评审/视觉复核约 0.5 天；不涉及 Host、协议或授权代码。

## 8. 需要用户拍板（汇总）

1. Q1/Q2/Q3：两套落点是否采纳？Hero 居中于输入卡还是视口？对话页右上是列内右上还是输入卡右缘？
2. Q4/Q5：Hero `top: 40px`、对话页 Header 下 12px 是否接受？
3. Q6：稍后改 Menu（推荐）还是保留原生 select？文案是否从「稍后」改为「稍后提醒」？
4. Q7：关闭是否加 Tooltip（需 span 包裹）？
5. Q8：窄屏/触控是否接受两行 + 32px 控件？
6. Q9：是否接受与官方 Toast 偶发重叠？
7. Q10：浅色常驻卡（推荐）还是官方深色 Toast 表面？
8. 本轮是否提交本报告（仅文档）到 `feat/workspace-toast`，还是先留在工作区？
