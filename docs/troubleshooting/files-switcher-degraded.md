# Files 页签根选择器退化：上游 `data-*` 钩子失效

## 症状

四种可分别出现的退化（每条对应一类失效的钩子）：

- **路径标签出现两次/位置错乱**：选择器以普通菜单钮的身份停在 actions 区原位，上游路径标签恢复显示，与选择器自带的 `PathLabel`（`.mrfw-switcherPath`）并存——`[data-files-root]:has(.mrfw-rootSwitcher) [data-files-path]:not([data-files-entry])` 或 `.mrfw-rootSwitcher { order: -1 }` 失效（上游把扁平 flex header 换了结构，或属性挪了位置）。
- **选中附加根但原生树仍在**：菜单状态变了、触发钮显示根名，树区却仍是主根原生树——`[data-root-kind="additional"]` 条件下的 `display:none` 规则失效，或 `closest('[data-files-root]')` 找不到祖先（portal 目标缺席时组件**主动不渲染**自绘树）。
- **原生 reload 还留着 / 附加根态出现两个刷新钮**：与上一条同源的 `:has()` 失效——接管态下原生 reload 应隐藏、由 header 内的 `.mrfw-switcherReload` 顶替（点击原地重拉自绘树，不清屏）；两者同时可见即规则失配。
- **附加根态出现两个「在应用中打开」钮 / 原生钮点回主根**：`data-open-target="directory"` 钩子（`ui-open-in-app` 分离按钮的锚点属性）改名或挪位——隐藏规则失配时原生钮在附加根态重新露出，点击仍打开**主根**（P9 修复前的旧 bug 回归）；复刻钮自身带 `.mrfw-openSplit`、被 `:not()` 保住，仍开选中根。若连复刻钮都不见了，先查 adapter 是否因 `*Regular` 图标族缺席而未建（0.1.x 像素名运行时的预期降级），再查 `GET open-in-app/apps` 是否 404/空数组（上游「无应用即无按钮」同型行为）。
- **复刻钮与窗口右缘间距像素级偏差（已修，留作诊断参考）**：根因查明——上游 `ui-renderer` 给每个槽位渲染点包 `<div data-slot="<key>" style="display:contents">`，`.header` 的子项是该包装而非 occupant 的 Menu 锚 span；旧的 `> * > *` 隐藏选择器命中包装自身，样式表 `display:none` 敌不过内联 `display:contents` 而惰性，原生 `.split` 只被内层兜底藏住、空的 Menu 锚 span 仍以零宽 flex 项多占一个 header gap。现第一选择器锚定 `[data-slot="sidebar.right.tab.files.actions"] > *:has(...)` 隐藏 occupant 项本身。**若该 `data-slot` 锚点改名或挪位，同一症状回归**：DevTools 中在 `.mrfw-rootSwitcher` 之前的同槽位查找一个无内容的 Menu 锚 span——仍占位即确认（原生 `.split` 被藏而锚壳残留），再对照该版本 `scoped-slots.tsx` 的包装实现找新锚。

所有症状共享一个性质：**功能不坏**。选择器菜单依然列出主根与附加根、能打开管理对话框；变的是视觉接管退回了原生布局。

## 根本原因

`data-files-root` / `data-files-path` / `data-files-reload` / `data-files-body` 落在上游 `FilesBody` 的 flex 项本体上，`data-open-target="directory"` 落在 `ui-open-in-app` occupant 的锚点上，`data-slot="sidebar.right.tab.files.actions"` 落在渲染器给槽位渲染点包的 `display:contents` 包装上（occupant 项级隐藏经它定位）——它们都是上游渲染器的实现细节，**不是 `files.actions` 槽位契约的一部分**。上游改 DOM（换布局、改属性名、给 flex 项包 wrapper）时，插件的 `:has()` 规则和 `closest()` 查找同时失去目标——这正是设计选择的失效路径：静默退化而非破碎头部（[ADR-0015](../decisions/ADR-0015-files-tab-plugin-owned-browsing.md)）。

## 诊断方法

1. 打开 Files 页签，DevTools 检查 pane：四个 `data-files-*` 属性是否仍在对应元素上（`data-files-root` 在 pane、`data-files-path`/`data-files-reload` 在 header 的 flex 项、`data-files-body` 在树区），`data-open-target="directory"` 是否仍在 open-in-app 分离按钮的锚点上，`data-slot="sidebar.right.tab.files.actions"` 包装是否仍包着 actions 区全部 occupant（其内联 `display:contents` 是故意的——不能对它 `display:none`，要隐藏的是包装内的 occupant 项）。`.header` / `.body` 的 class 是 CSS-module hash，不能锚。注意 `data-files-path` 有双重含义：**每个树行也携带它**（值是该行绝对路径），所以命中表头标签的选择器必须是 `[data-files-path]:not([data-files-entry])`——如果症状是「主根树区整片空白」，先查这条限定符还在不在。
2. 确认 `.mrfw-rootSwitcher` 确实渲染进了 actions 区（footer 面板存在 ⇒ client bundle 在跑；选择器不在则说明 slot 注册本身出了问题，另查 `files.actions` 槽位是否还声明）。
3. 选中一个附加根后看 `.mrfw-rootSwitcher` 是否带上 `data-root-kind="additional"`：带了但原生树仍可见 ⇒ `:has()` 规则失配；不带 ⇒ 组件状态问题而非钩子问题。
4. 复刻钮缺失的排查顺序：`.mrfw-openSplit` 元素是否存在（不存在 ⇒ adapter 未建，查 `*Regular` 图标与 `open-in-app/apps` 路由）；存在但被隐藏 ⇒ 检查 `:not(.mrfw-openSplit)` 限定符是否还在隐藏规则里。

## 已验证的解决方案

1. 对照该上游版本的 `FilesBody` 与 `ui-open-in-app` 源码找出新钩子：属性改名就改选择器，flex 项被包了一层就调整 `:has()` 的组合路径，`closest()` 的目标同理（`src/client/RootSwitcher.tsx` 与 `src/client/styles.ts` 是唯一两处消费点）。
2. 保持 `:has()` 守卫结构：任何命名上游元素的规则都必须以本插件元素在场为前提，失效路径才会继续是"退化"而非"误伤"。
3. 复刻控件自身的漂移（上游 `ui-open-in-app` 改了组件结构/路由/注入面）按 `src/client/open-in-app/FORK.md` 的同步步骤重拷对照——唯一许可差异是 css specifier 的 `.ts` 后缀。
4. 若上游彻底移除了可用钩子（例如 flex 项不再携带任何稳定标识），接受退回槽内菜单形态——选择器仍可用，但树区接管不再可行；此时重新评估方案（上游 seam 出现的可能性见 ADR-0015 备选节），不要为了视觉接管去锚 hash class。

升版验收时的目检清单（三态：无附加根原生观感 / 附加根选中接管 / 切回主根还原）记录在 `.agent/note/dsh-compat-contract.md` 第 12 节。
