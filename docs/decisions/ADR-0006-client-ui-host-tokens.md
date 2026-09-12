# ADR-0006: 客户端 UI 复刻宿主原生样式（宿主 token，插件零硬编码颜色）

## Status

Accepted

## Date

2026-09-12

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
   - 侧栏触发器 ← `ui-settings-general/SettingsRoot.module.css` 的 `.trigger`（wide：高 42px、`padding 0 10px 0 8px`、r12、透明底、hover `interactive-bg-hover`；rail（`wide === false`）：36×36 圆形仅图标）；
   - 对话框 ← `ui-primitives/Modal.module.css`（遮罩 `bg-mask-1` + `backdrop-filter: var(--dsw-mask-blur)`；卡片 r24、`bg-layer-2`、`box-shadow: var(--dsw-elevation-prominent)`、`border: 0`；标题 16px/24px/500；关闭为 28px 图标按钮）；
   - 按钮 ← `ui-primitives/Button.module.css` 的 sm 胶囊（28px 高、r14、12px/18px），变体映射：添加确认 = primary、添加目录…/重试 = outline、行内动作 = ghost、移除 = ghost + hover `interactive-bg-hover-danger`；
   - 输入框 ← `ui-primitives/Input.module.css`（32px 高、0.5px `border-l4`、r8、`bg-layer-1`、`:focus` 边框 `brand-primary`、placeholder `label-dimmed`）；
   - 文字层级：分区标题 14px/22px/500 `label-primary`，说明/提示 12px/18px `label-tertiary`，路径 `var(--ds-font-family-code)` 13px/20px，错误 `state-error-primary`，不可用徽标 `state-warn-primary`。
4. **转发 owner prop `wide`**：`register` 的组件参数即框架组合后的 props（含侧栏的 `{ wide }` owner share），插件此前忽略了它。现在转发给触发器，侧栏折叠成图标栏时触发器渲染为原生一致的 36px 圆形图标钮。
5. **图标用 16px 内联 SVG**（`stroke: currentColor`）替换 emoji，与原生线性图标一致，颜色跟随文字 token。

## Alternatives Considered

| 方案 | 否决理由 |
| --- | --- |
| 继续内联样式，仅把颜色换成 `var(...)` 字符串 | 表达不了 `:hover` / `:focus` / `backdrop-filter`，原生观感的核心状态全部缺失 |
| 引入 CSS Modules / Tailwind / 组件库 | 为一张样式表引入构建管线与依赖，破坏出树包的零管线形态；上游文档明确反对 Tailwind |
| 带 `rgb(...)` fallback 的 `var()` | 复制静态调色板值，违反上游 web-styling 规则，且会在主题演进时悄悄漂移 |
| 深引 `ui-primitives` 的 Button/Modal 组件 | 外部依赖白名单只允许两个运行时都 seed 的平台词（ADR-0005 决策 6）；且组件库身份不是出树包可假设的运行时服务 |

## Consequences

- 面板观感由宿主 token 决定：明暗主题、以及未来宿主调色板调整都自动跟随，本仓库不再维护任何颜色常量。
- 样式表是类名与 token 名之间的**本地耦合面**：若上游重命名 alias token，面板颜色会退化为浏览器默认——这与上游特性组件同命运，属可接受风险；升级 smoke 时应目检面板两个主题下的渲染。
- `<style>` 注入点在 `document.head`，不触碰 `document.body`（cordis 插件开发规范的禁区是 body 内联样式）。
- `wide` 转发依赖 slot 框架把 owner props 传给注册组件这一公开行为；若某运行时不传，触发器保持 wide 形态，功能不受影响。

## Related Documents

- [ADR-0005 出树 client 半部的通道与落点](./ADR-0005-out-of-tree-client-transport.md)（样式机制的先前决策，已被本 ADR 修订）
- [架构文档 §7](../architecture/multi-root-workspace.md)
- 上游：`deepseek-harness/docs/web-styling.md`、`packages/client/ui-theme/src/styles/`、`packages/client/ui-primitives/src/*.module.css`
