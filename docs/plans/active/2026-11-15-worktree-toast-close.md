# Worktree 提示加回圆形关闭按钮 — 实施计划与退出验收

> 状态：**实施中**（2026-11-15，分支 `feat/worktree-toast-close`）。本轮收回 [ADR-0039 第二十一次修订](../decisions/ADR-0039-worktree-aware-root-suggestions.md#第二十一次修订2026-11-15) 的 D3「删除 ×」决定，只在常驻提示的呈现层加回一个正圆关闭按钮，不改变触发、RPC、授权、宿主复验与生命周期语义。

## 1. 需求与决定

| 编号 | 决定 |
| --- | --- |
| D1 | 在 Worktree 常驻提示（`发现 {count} 个可添加的工作目录` 卡片）右上角加回「×」关闭按钮，取代第二十一次修订 D3「没有单独关闭按钮、稍后提醒即关闭」的表述。 |
| D2 | 语义是**纯关闭**：只让本次激活的提示消失，不调用 `snooze` / `resolve`，不写 sidecar，不写 Registry，不打开 Dialog。提示显示时已经通过 `seen()` 在 Host 内存认领候选，因此本 Host 生命周期内不再自动提示；重启 Host 后候选重新可见（这是「关闭」与「稍后提醒」「永久不再提示」三者的区别）。 |
| D3 | 形态按维护者手绘：一个**正圆形**小按钮，圆形压（挂在）卡片右上角边框上，允许外凸到卡片之外；直径 20px、0.5px 细描边、底色与卡片一致、内含 12px 的 ×。 |
| D4 | 控件继续使用 primitives `Button`（`variant="ghost"`、`size="sm"`）与其它控件保持一致；正圆由插件样式用（双类）选择器强制，压过 primitives 单类的 `sm` 尺寸规则，避免样式表注入顺序改变形状。× 使用宿主 Regular close 字形，宿主未导出时回退本地 SVG 描边。 |
| D5 | 范围只在常驻提示上：确认 Dialog 保持自身标题栏关闭入口，不叠加第二个关闭控件；不加 Escape 关闭提示（键盘用户仍可 Tab 到 ×）。 |
| D6 | 关闭立即递增 `workEpoch` 并清空 `snoozeOpen`，使在飞的 snooze 完成不能再回写已关闭的提示（与 `openDialogFor` 相同的归属规则）。触发、RPC、侧车、授权与 owner 复验不变。 |

## 2. 设计细节

- **DOM 与顺序**：`section.mrfw-notice` 内新增最后一个子元素（`Button.mrfw-noticeClose`），Tab 顺序为 查看 → 稍后提醒 → 关闭；`role="group"` 仍只包含查看与稍后提醒，关闭按钮作为独立控件，不被读屏念成操作组成员。
- **可访问性**：`aria-label` 走新词典键 `worktree.toastClose`（中「关闭提示」/英 "Dismiss"）；`aria-live` 文本区不受影响；`:focus-visible` 用 `--dsw-alias-brand-primary` 环。
- **落点**：`position: absolute; top: 0; right: 0; transform: translate(50%, -50%)`，即圆心落在卡片右上角；宽屏与两行 compact 形态同款。外凸允许超出卡片与视口边缘（维护者明确接受），因此不额外收缩卡片宽度。
- **主题与 token**：描边 `--dsw-alias-border-l3`、底色 `--dsw-alias-bg-layer-2`（与卡片同色，形成角上开孔观感）、字形 `--dsw-alias-label-secondary`，hover 提到 `--dsw-alias-label-primary` + `--dsw-alias-interactive-bg-hover`；不引入字面色。
- **命中区**：视觉外径 20px；按钮盒不小于视觉圆形，触控用户点击圆内即可命中。

## 3. 文件改动

| 文件 | 改动 |
| --- | --- |
| `src/client/locales.ts` | 新增 `worktree.toastClose`（中/英）。 |
| `src/client/WorktreePrompt.tsx` | 新增 `closeNotice`（递增 epoch、清空提示与下拉状态，不发 RPC）；提示区末尾渲染关闭按钮与 × 字形回退。 |
| `src/compat/client-icons.ts` | 新增可选的 `IconClose`（宿主 Regular close 字形，缺失为 `undefined`）。 |
| `src/client/styles.ts` | 新增 `.mrfw-notice .mrfw-noticeClose` 正圆、角上定位、hover/focus-visible 规则。 |
| `tests/client-worktree.spec.tsx` | 更新 a11y 用例（关闭按钮存在且不属于操作组）；新增「× 纯关闭且不发 snooze/resolve」「关闭后在飞 snooze 不复活提示」用例。 |
| `tests/client-styles.spec.ts` | 固化正圆尺寸、角上定位与外凸、token 配色规则。 |
| `README.md` / `README.en.md` | 提示操作描述改为「查看 / 稍后提醒 / 右上角圆形关闭」，说明关闭不写提醒状态。 |
| `docs/decisions/ADR-0039-…` | 新增第二十五次修订，记录反转与语义。 |
| `docs/plans/README.md` / `README.en.md` | active 索引登记本计划。 |
| `docs/plans/active/2026-11-15-workspace-toast-implementation.md` | D3 标注已被本计划取代。 |

## 4. 测试与验证

```sh
pnpm vitest run tests/client-worktree.spec.tsx tests/client-styles.spec.ts tests/client-notice-placement.spec.ts tests/locale-parity.spec.ts tests/client-bundle.spec.ts
pnpm lint
pnpm typecheck
pnpm docs:check
```

GUI 复核（评审者）：Hero 与对话页、宽屏与两行 compact、浅/深主题下确认圆形完整、外凸可见、hover/focus 正常，且关闭后提示消失、不发生任何请求。

## 5. 退出验收

| 门 | 内容 | 证据 |
| --- | --- | --- |
| E1 | 计划、ADR 第二十五次修订、README 双语与索引同步；`pnpm docs:check` 通过 | 命令输出 |
| E2 | 组件测试覆盖：关闭按钮存在、纯关闭不产生 snooze/resolve、关闭后在飞完成不复活、操作组不含关闭按钮 | vitest 输出 |
| E3 | 样式测试固化正圆、角上定位、token 配色 | vitest 输出 |
| E4 | `lint`、双端 `typecheck`、聚焦 vitest 全绿；`client-bundle` 不新增 module table external/peer | 命令输出 |
| E5 | 提交、推送并创建 Draft PR，写明 GUI 复核缺口 | PR 链接 |

## 6. 风险

| 风险 | 缓解 |
| --- | --- |
| 外凸圆在极窄视口可能顶到内容边缘 | 维护者明确接受外凸；圆径仅 20px，卡片最大宽度已预留 32px 侧边内缩 |
| primitives `sm` 的 28px 高度/圆角覆盖插件样式 | 双类选择器提高特异性，样式测试固化 |
| 旧宿主不导出 Regular close 字形 | `maybeIcon` 探测缺失时渲染本地 12px 双线 ×，不抛错 |
| 关闭被误读为「稍后提醒」 | 关闭不发任何 RPC、不写状态；ADR 第二十五次修订明确三分语义 |
