# ADR-0006: 客户端 UI 复刻宿主原生样式（宿主 token，插件零硬编码颜色）

## Status

Accepted（2026-09-13 修订：放开 ui-primitives 展示型组件的直接 import，见决策 6）

## Date

2026-09-12（修订 2026-09-13）

## Context

M3 交付的面板 UI（侧栏 footer 触发器 + 工作区目录对话框）最初用内联样式实现，颜色是硬编码值（`rgba(127,127,127,…)` 灰阶、`crimson`、`darkorange`、`canvas` 系统色）。对照宿主原生界面（侧栏"设置"行、原生 Modal/设置对话框）可见明显偏差：边框卡片感 vs 原生的无底框行、无 hover 反馈、无遮罩模糊、直角矩形 vs 原生大圆角，且完全不适配宿主的明暗主题。

宿主的样式事实（均已在 `deepseek-harness/packages/client/ui-theme` 与 `ui-primitives` 源码核实）：

1. **token 挂在 `body` 上**：`ui-theme` 的 `design-platform.css` 在 `body` 上声明 `--dsw-alias-*` 语义 token（背景层级、文字四级、边框四级、按钮 fill/hover、error/warn/success 状态色等），暗色主题由 `body[data-ds-dark-theme]` 切换同一批 token 的取值；`gradient-shadow-text.css` 提供 `--dsw-elevation-*` 阴影与 `--dsw-mask-blur`；`base.css` 提供 `--ds-font-family-code`、`--ds-ease-in-out`、`--ds-transition-duration-*`。**插件 DOM 渲染在 `body` 下，`var(--dsw-...)` 无需任何宿主配合即可解析。**
2. **上游官方规则**（`deepseek-harness/docs/web-styling.md`）：特性组件只消费 `--dsw-alias-*` 语义 token；不复制静态调色板值、不写字面色；插件 CSS 中不得出现主题选择器（`body[data-ds-dark-theme]` 覆盖是被禁止的——alias token 自己会切换）。
3. **内联样式表达不了原生观感**：hover 底色、`:focus` 聚焦描边、`backdrop-filter` 遮罩模糊都依赖伪类与属性，内联 style 对象做不到。

## Decision

1. **样式机制 = 插件自注入一张样式表**：`src/client/styles.ts` 导出 CSS 文本，client 入口在 `ctx.effect` 中幂等注入 `<style id="multi-root-workspace-styles">`，插件卸载时随 effect 移除。组件只挂 `mrfw-` 前缀类名，不再写内联样式。仍不引入 CSS 管线与组件库依赖——一张纯文本样式表保持了出树包零构建侧依赖的形态。
2. **颜色零硬编码**：样式表中每个颜色都是 `var(--dsw-alias-*)` / `var(--ds-*)`，**不带静态色 fallback**（与上游特性组件一致；若某组合未加载 ui-theme，宿主自己的组件同样退化，插件不单独兜底）。
3. **几何与状态配方逐值复刻宿主原生组件**（对照源文件核实，不凭截图估计）：
   - 侧栏触发器 ← `ui-settings-general/SettingsRoot.module.css` 的 `.triggerRow` + `.trigger`（外层行 `width calc(100% + 4px)`、`margin 4px -2px`——向两侧外溢 2px 吃掉侧栏壳 12px 内边距，使图标墨线落在距列边 18px 处，与下方"设置"齿轮逐像素对齐；按钮 wide：`box-sizing border-box`、高 42px、`padding 0 10px 0 8px`、r12、透明底、hover `interactive-bg-hover`；rail（`wide === false`）：行 `width 36px`、`margin 8px 0 10px`，按钮 36×36 圆形仅图标、图标 18px）；
   - 对话框 ← `ui-primitives/Modal.module.css`（遮罩 `bg-mask-1` + `backdrop-filter: var(--dsw-mask-blur)`；卡片 r24、`bg-layer-2`、`box-shadow: var(--dsw-elevation-prominent)`、`border: 0`；标题 16px/24px/500；关闭为 28px 图标按钮）；
   - 按钮 ← `ui-primitives/Button.module.css` 的 sm 胶囊（28px 高、r14、12px/18px），变体映射：添加确认 = primary、添加目录…/重试 = outline、行内动作 = ghost、移除 = ghost + hover `interactive-bg-hover-danger`；
   - 输入框 ← `ui-primitives/Input.module.css`（32px 高、0.5px `border-l4`、r8、`bg-layer-1`、`:focus` 边框 `brand-primary`、placeholder `label-dimmed`）；
   - 文字层级：分区标题 14px/22px/500 `label-primary`，说明/提示 12px/18px `label-tertiary`，路径 `var(--ds-font-family-code)` 13px/20px，错误 `state-error-primary`，不可用徽标 `state-warn-primary`。
4. **转发 owner prop `wide`**：`register` 的组件参数即框架组合后的 props（含侧栏的 `{ wide }` owner share），插件此前忽略了它。现在转发给触发器，侧栏折叠成图标栏时触发器渲染为原生一致的 36px 圆形图标钮。
5. **图标用 16px 内联 SVG**（`stroke: currentColor`）替换 emoji，与原生线性图标一致，颜色跟随文字 token。（2026-09-13 起被决策 6 取代；同日触发器图标错位修复后，侧栏触发器也改用宿主组件——自绘 stroke 字形墨量与宿主 fill 图标不一致，即使几何对齐观感仍偏移。）
6. **（2026-09-13 修订）展示型组件直接 import ui-primitives**：面板行内图标（`IconCopyOutline16`、`IconFolderOpenOutline16`、`IconChevronUpOutline14`、`IconChevronDownOutline14`、`IconEllipsisOutline16`、`IconPlusOutline16`、`IconEditOutline16`、`IconTrashOutline16`）、侧栏触发器图标（`IconFolderClose16`，wide 16px / rail 18px，同宿主"设置"行的尺寸惯例）与行菜单（`Menu`）从 `@deepseek-ai/dsh-client-ui-primitives` import，字形与交互行为跟宿主完全一致。依据：该包本就在 `tsdown.config.ts` 的 `CLIENT_EXTERNALS` 白名单里，且是 web shell 种子模块表的平台词（`packages/client/web/src/platform.ts` 的 `PLATFORM_MODULES`，另见 ui-renderer README 的 Identity 一节）——运行时浏览器解析到的是 shell 打包的单一身份，`require` 不会引入第二份 React 树或样式。**边界**：仅限无状态的展示型组件（图标、Menu 这类局部弹层）；Button/Modal 等结构组件仍按本 ADR 决策 3 自绘（已验证的配方，且避免出树包假设宿主的组件级上下文）。jsdom 测试经 `vitest.config.ts` 的 alias 指到 `tests/stubs/ui-primitives.tsx` 替身（发布包的 barrel 带宿主侧裸依赖，测试环境不可解析），真实组件由 journey smoke 的 web 腿覆盖。

## Alternatives Considered

| 方案 | 否决理由 |
| --- | --- |
| 继续内联样式，仅把颜色换成 `var(...)` 字符串 | 表达不了 `:hover` / `:focus` / `backdrop-filter`，原生观感的核心状态全部缺失 |
| 引入 CSS Modules / Tailwind / 组件库 | 为一张样式表引入构建管线与依赖，破坏出树包的零管线形态；上游文档明确反对 Tailwind |
| 带 `rgb(...)` fallback 的 `var()` | 复制静态调色板值，违反上游 web-styling 规则，且会在主题演进时悄悄漂移 |
| 深引 `ui-primitives` 的 Button/Modal 组件 | 组件库身份不是出树包可假设的运行时服务；结构组件的上下文依赖（portal 容器、主题 provider）无法逐值核实。2026-09-13 起收窄为"仅结构组件"——展示型组件（图标、Menu）已由决策 6 放开 |
| 自绘下拉菜单与逐个复制图标 SVG path | 与宿主的字形/交互随时间漂移，且 Menu 的定位、pointer grace、键盘导航属可观察行为，复刻成本高于直接 import 一个已 seed 的平台词 |

## Consequences

- 面板观感由宿主 token 决定：明暗主题、以及未来宿主调色板调整都自动跟随，本仓库不再维护任何颜色常量。
- 样式表是类名与 token 名之间的**本地耦合面**：若上游重命名 alias token，面板颜色会退化为浏览器默认——这与上游特性组件同命运，属可接受风险；升级 smoke 时应目检面板两个主题下的渲染。
- `<style>` 注入点在 `document.head`，不触碰 `document.body`（cordis 插件开发规范的禁区是 body 内联样式）。
- `wide` 转发依赖 slot 框架把 owner props 传给注册组件这一公开行为；若某运行时不传，触发器保持 wide 形态，功能不受影响。

## Related Documents

- [ADR-0005 出树 client 半部的通道与落点](./ADR-0005-out-of-tree-client-transport.md)（样式机制的先前决策，已被本 ADR 修订）
- [架构文档 §7](../architecture/multi-root-workspace.md)
- 上游：`deepseek-harness/docs/web-styling.md`、`packages/client/ui-theme/src/styles/`、`packages/client/ui-primitives/src/*.module.css`
