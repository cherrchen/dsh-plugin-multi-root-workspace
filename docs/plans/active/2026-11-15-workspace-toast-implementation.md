# Workspace 发现提示位置与形态重构 — 实施计划与退出验收

> 状态：**已实施，待退出验收**（2026-11-15，分支 `feat/workspace-toast`）：代码、单元/组件测试与构建门禁已通过，Draft PR [#60](https://github.com/cherrchen/dsh-plugin-multi-root-workspace/pull/60) 已创建；GUI 视觉复核（E5）待评审者完成。需求分析、缺点清单与初始方案见 [需求同步与修改计划报告](./2026-11-15-workspace-toast-placement.md)；本文件是评审后的最终实施计划，冲突处以本文件为准。

## 1. 评审决定（2026-11-15）

| 编号 | 决定 |
| --- | --- |
| D1 | 两页统一水平居中：Hero 页顶部居中；对话页 Header 下方、会话内容列居中。 |
| D2 | Hero `top: 40px`；对话页 Header 下 `12px`。 |
| D3 | 删除「×」关闭按钮。**「稍后提醒」就是关闭提示的操作**；不再保留「只关闭、不写状态」的指针操作，也不新增 Escape 关闭。**已被 [2026-11-15-worktree-toast-close.md](./2026-11-15-worktree-toast-close.md) 取代**（加回正圆 ×，语义为纯关闭）。 |
| D4 | 「稍后提醒」由原生 `select` 改为拆分按钮：左半文字按钮应用默认档位（直到出现新 worktree），右半 chevron 按钮打开 primitives `Menu`（三个档位）。 |
| D5 | 提示卡表面随主题自适应：浅色模式浅色卡、深色模式深色卡（与官方 Toast 的「两套主题都深色」不同）；所有颜色只用 `--dsw-*` token。 |
| D6 | 窄屏（可用宽度不足）或粗指针（`pointer: coarse`）时改为两行形态，控件高度 32px。 |
| D7 | 尽量降低与官方瞬时 Toast 的重叠概率：默认 Hero `top: 40px`；检测到 `body` 直属 `role="alert"` 的官方 Toast 时，提示临时下移一个 Toast 高度 + 间距（56px），官方 Toast 消失后恢复。 |
| D8 | 不移动输入框、不改 sticky composer、不改上游 DOM/样式/插槽契约。 |
| D9 | 触发、RPC、授权、宿主复验、生命周期与 epoch 归属全部不变；唯一行为变化是删除「×」及其「只关闭不写状态」路径。 |

## 2. 落地设计

### 2.1 落点

- 只读探针：主会话根 `[data-phase]`（`0.1.5-rc.2` 起存在）；Hero 水平中心取 `[data-composer-card]` 中心，回退会话根中心、视口中心。
- 对话页：内容区顶部优先 `[data-conversation-content]`（`0.2.1-alpha.3+`），否则测量会话根第一个子元素（Header）的 `bottom`；`top = 内容区顶部 + 12`，水平中心 = 内容区中心；最大宽度 `min(560, 内容区宽度 − 48)`。
- Hero：`top = 40 + (官方 Toast 可见 ? 56 : 0)`；最大宽度 `min(560, 列宽 − 32)`。
- 探针失败（无 `[data-phase]`、rect 全 0、元素缺失）→ Hero 顶部居中；禁止回右下角。
- 重测：`window.resize`、当前会话根/输入卡/内容区/Header 的 `ResizeObserver`，以及兼容探针识别的节点和属性变化。会话节点挂载或替换时重绑观察对象，客户端以微任务合并重测。
- 页面切换（Hero → 对话页）时提示若仍可见，重测换位。

### 2.2 形态

- 单行（宽屏）：图标 16 + 文本 14/22 + 操作区（查看、稍后提醒）。
- 卡片：`border: 0`、`border-radius: var(--dsw-radius-lg)`（R16）、`background: var(--dsw-alias-bg-layer-2)`、`box-shadow: var(--dsw-elevation-panel)`、`padding: 10px 12px`、`gap: 12px`；随主题明暗切换。
- 操作：`Button variant="primary" size="sm"`（查看）；「稍后提醒」为拆分按钮——左半 `Button variant="ghost" size="sm"` 直接应用 `until-new-worktree`，右半 chevron `Button` 作为 primitives `Menu` 的 anchor（三个 snooze 档位复用现有文案；`side="bottom"`、`align="end"`、`portal`）；拆分控件外围与中间分割线使用同一条 `--dsw-alias-border-l3` 细线。
- 手动入口：Workspace Folders 面板「重试」右侧的「Worktree 建议」按钮经 `worktree-prompt-bus` 向 shell overlay 发起带管理器会话的请求，overlay 接受后面板关闭。添加行保持单行：手动路径输入是唯一可收缩项（`flex: 1 1 120px`，min 80px），窄视口才回退换行。
- 紧凑（窄屏或粗指针）：两行（文本行 + 操作行），控件 32px，卡片宽度取测量后的 `maxWidth`。
- 动效：160ms `opacity + translateY(-4px)` 入场；`prefers-reduced-motion` 下取消动画。
- 不覆盖 primitives 视觉；插件样式只做布局与表面。

### 2.3 可访问性

- 容器 `section` + `aria-label`（新词典键 `worktree.toastLabel`）。
- 文本 `p role="status" aria-live="polite"`；按钮/菜单在该 live region 之外。
- 操作组 `role="group"` + `aria-label`（新词典键 `worktree.toastActions`）。
- 菜单由 primitives 提供键盘导航与 Escape；触发按钮带 `aria-haspopup="menu"` 与 `aria-expanded`。
- 不移动焦点、不加 backdrop、不加 focus trap。

## 3. 文件改动

| 文件 | 改动 |
| --- | --- |
| `src/client/notice-placement.ts`、`src/compat/client-conversation-layout.ts` | 客户端负责纯落点解析和 React 生命周期，兼容层负责上游 DOM 探针、Header 回退及观察 |
| `src/client/WorktreePrompt.tsx` | 提示区改用 `Button`/`Menu`/compat 图标；删除 × 与 `closeNotice`；新增 `snoozeOpen` 与 placement；其余 RPC/epoch 逻辑不变 |
| `src/client/styles.ts` | 删除 `.mrfw-toast*`；新增 `.mrfw-notice*`（表面、紧凑、动效、reduced motion） |
| `src/client/worktree-prompt-bus.ts`（新增） | 面板 → shell overlay 的一次性打开请求，携带管理器会话并返回确认 |
| `src/client/WorkspaceFoldersAction.tsx` / `index.ts` / `HeroWorkspaceEntry.tsx` | 面板「重试」右侧的「Worktree 建议」入口和 `worktreePromptEnabled` 透传 |
| `src/client/locales.ts` | 新增 `worktree.toastLabel`/`worktree.toastActions`/`worktree.toastLaterOptions`/`worktree.panelOpen`；`worktree.toastLater` 改为「稍后提醒」/「Remind me later」；删除 `worktree.toastClose` |
| `tests/client-notice-placement.spec.ts`（新增） | 纯解析器 + 合成 DOM 探针 + 官方 Toast 偏移 + 降级 |
| `tests/client-worktree.spec.tsx` | select → Menu 交互；删除 × 用例；新增 placement/a11y/菜单用例 |
| `tests/client-styles.spec.ts` | 新增提示卡规则断言（无右下角、无描边 + elevation、R16、主题 token、紧凑、动画） |
| `docs/decisions/ADR-0039-worktree-aware-root-suggestions.md` | 第二十一次修订：落点、形态、删除 ×、primitives、DOM 探针、主题、a11y |
| `docs/plans/active/2026-11-09-worktree-aware-root-suggestions.md` | P11 实施项与验收 |
| `docs/plans/README.md` | active 索引登记本计划与报告 |
| `README.md` / `README.en.md` | Worktree 建议的呈现描述（位置、操作） |

## 4. 分阶段提交

1. `docs(plan):` 已批准的实施计划与退出验收（本文件）+ 报告状态更新。
2. `feat(client):` 新增 `notice-placement` 与单测（纯解析器 + DOM 探针）。
3. `feat(client):` 提示 UI 改用 primitives、删除 ×、主题自适应样式、词典与客户端测试。
4. `docs(adr):` ADR-0039 第二十一次修订、P11、README/索引。
5. `chore(verify):` 质量门与证据；推送分支并准备 Draft PR。

每阶段独立可回退；阶段 2 不改变任何用户可见行为。

## 5. 测试与验证

- `pnpm vitest run tests/client-notice-placement.spec.ts tests/client-worktree.spec.tsx tests/client-styles.spec.ts tests/client-panel.spec.tsx tests/locale-parity.spec.ts`
- `pnpm lint`、`pnpm typecheck`、`pnpm test`（全量）、`pnpm build`、`pnpm docs:check`、`pnpm compat:check`、`pnpm pack:check`
- `tests/client-bundle.spec.ts` 必须保持通过（不新增 module table external/peer）。
- 手动 GUI（`pnpm dev:web`）证据：Hero 页、对话页、右侧栏打开、窄窗口、浅色/深色主题、reduced motion；确认不与 Header/输入框相交、与官方 Toast 不重叠（官方 Toast 出现时提示下移）。
- CI 车道：24 个精确版本的 typecheck/build 由 PR CI 覆盖；本地固定 pin 先全绿。

## 6. 退出验收机制

**退出条件（全部满足才可结束本任务）**

| 门 | 内容 | 证据 |
| --- | --- | --- |
| E1 | 计划、ADR、README、索引同步；`pnpm docs:check` 通过 | 命令输出 |
| E2 | 新增/更新单测覆盖落点解析、探针降级、官方 Toast 偏移、紧凑形态、拆分按钮、a11y、面板手动入口；相关测试全绿 | vitest 输出 |
| E3 | 既有 worktree 客户端行为（fresh/seen/snooze/resolve/epoch/StrictMode/skipped）无回归 | `tests/client-worktree.spec.tsx` 全绿 |
| E4 | `lint`、双端 `typecheck`、`build`、`compat:check`、`pack:check` 通过；`client-bundle` 断言不变 | 命令输出 |
| E5 | GUI 验收：Hero 顶部居中、对话页 Header 下居中、右侧栏/窄屏/两主题正确；与输入框/Header 不相交；官方 Toast 出现时下移避让；拆分按钮细框与面板手动入口可用 | 截图或录屏 |
| E6 | 无新增 module table external、无新增 peer、无宿主/RPC/授权改动 | diff 与 bundle 测试 |
| E7 | 分支已提交、推送，Draft PR 已创建并写明验收缺口 | PR 链接 |

**停止/回退条件（出现即暂停并报告，不硬推）**

- 探针在所有支持版本都无法稳定定位，且降级方案仍会遮挡 Header/输入框：停止实施，回到评审选择单一顶部居中方案。
- primitives `Menu`/`Button` 在支持矩阵任一版本不可用或行为不可接受：改用版本探测/降级，不得扩大 peer 或 module external。
- 删除 × 导致既有行为测试无法在不改变语义的前提下更新：停止并请用户确认「×」的替代 dismiss 路径。
- 主题自适应在深色模式对比度不达标：停止并调整 token，不引入字面颜色。

**完成定义**：E1–E7 全绿；D1–D9 均有对应测试或人工证据；无开放 P0/P1 缺陷。随后把本计划从 `active/` 迁到 `completed/`，在路线账本补证据（发版后）。

## 7. 风险

| 风险 | 缓解 |
| --- | --- |
| DOM 探针依赖上游 `data-phase`/`data-conversation-content` | 只读、集中在一个模块；缺失降级；不猜 class 名；合成 DOM 单测 |
| 官方 Toast 检测依赖 `role="alert"` 直属 `body` | 检测不到时仅保留偶发重叠；不移除 40px 默认落点 |
| 删除 × 后指针用户只能通过「稍后提醒」或「查看」离开提示 | 按 D3 执行，并在 ADR 说明该行为变化 |
| Menu portal 在固定浮层/右侧栏下的定位 | `portal` + `align="end"` + `side="bottom"`；GUI 验证 |
| 更新 select→Menu 的既有测试 | 保留原行为断言，仅替换交互动作；先红后绿 |
