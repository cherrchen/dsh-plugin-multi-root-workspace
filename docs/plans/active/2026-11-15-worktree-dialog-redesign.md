# Worktree 建议 Dialog 视觉重构 — 需求同步与修改报告（草案）

> 状态：**已实施（方案 B + 分支展示），待 CI/GUI 验收**（2026-11-15，分支 `feat/workspace-toast`）。Draft PR #60 上的 5 个 CI run（queued/in_progress）已全部取消；随后按本报告的实现方案提交了新 commit，CI 随新 push 重新触发。

## 1. 需求同步

| 用户要求 | 同步结论 | 备注 |
| --- | --- | --- |
| Worktree Dialog 当前视觉很丑 | 属实：沿用 `Modal` 的 380px 默认宽度，每个候选是一张带边框/圆角的卡片，路径在右侧长文本换行。 | 见 §2 现状 |
| Dialog 调宽 | 目标宽度建议 `min(860px, calc(100vw - 48px))`；内容区超高时内部滚动，标题/footer 固定。 | 具体像素可调 |
| 列表改为连续列表，不要每个 worktree 一个气泡 | 改为参考 Workspace Folders 面板「附属工作目录」的 `.mrfw-row` 行样式：行间 0.5px 分隔线、无卡片背景/描边、行内 hover。 | 见 §3.1 |
| 参考手绘图布局 | 每行：左侧 checkbox → 文件夹名（主文本）+ 路径（code/tertiary，第二行）→ 可选 git branch chip → 右侧权限选择器；底部左侧 snooze 下拉，右侧「暂不处理」「添加所选」。 | 手绘图与现有契约有两处缺口，见 §4 |
| 删除「勾选要登记为 inherit 附加根…当前有效权限：读写」整段说明 | 列表模式不再传 `description`；标题保留「发现 N 个可添加的工作目录」。 | 单候选模式也建议统一为一行，详见 Q4 |
| 新面板已有权限选择器，默认 inherit | **当前契约没有该选择器**：`WorktreePromptView.access` 被固定为 `'inherit'`，`resolve` 的 `add` 分支在 Registry 里硬编码 `access: 'inherit'`。要做真实选择器必须扩协议/Registry 并改 ADR；只做 UI 会出现「可选但无效」的假控件。 | §4.1；需要拍板 |
| 手绘图里的 git branch | 当前 `WorktreePromptView` 没有分支字段；宿主发现阶段只读 HEAD 做身份核对，未解析分支名。 | §4.2；建议本期先不放或另开任务 |
| 底部下拉使用官方组件 | 现有实现是原生 `select`；改为 primitives `Menu` + `Button`（与 toast 的「稍后提醒」同一套）。 | 无协议影响 |
| 先取消本 PR 的全部 CI，再开发 | 已取消：5 个 run 已 cancelled，无 queued/in_progress。 | 已执行 |

## 2. 现状（代码事实）

- Dialog 由 `src/client/WorktreePrompt.tsx` 的 `Modal` 渲染（第 565–662 行）。未传 `className`，使用 primitives `Modal` 的默认卡片宽度 `width: min(380px, 100%)`（`Modal.module.css`）。
- 列表行：`.mrfw-worktreeRow` 是 `padding: 10px 12px + border + border-radius: 8px` 的独立卡片；`.mrfw-worktreeRowHead` 是单选 checkbox + `Worktree 源码树`类型文字 + 路径；路径在同一行右侧，窄宽度下大量换行。
- 描述：list 模式传入 `worktree.listDescription`，内容正是要删除的「勾选要登记为 inherit 附加根的目录。登记是工作区级的…当前有效权限：…」。
- 权限：`WorktreePromptView.access` 类型是字面量 `'inherit'`；`WorktreeService.resolve` 的 `action === 'add'` 分支固定 `access: 'inherit'`；`MultiRootRegistry.addNew` 也固定写入 `inherit`。`AddNewRootOptions.access` 已存在但注释写明「ADR fixes this to inherit; anything else is refused」。
- 底部：原生 `select`（snooze 档位）+ 自绘 `.mrfw-btn`（暂不处理/添加所选）；没有用 primitives。
- 单候选与多候选是两套 body：`singlePrompt` 走 path/policy/shared 说明，多候选走卡片列表。标题和 footer 文案也随之不同。

## 3. 目标设计

### 3.1 Dialog 与列表

    发现 4 个可添加的工作目录                                        x
    [v] plugin-multi-root-workspace-autoreview        [inherit v]
        /Volumes/.../dsh-plugin-multi-root-workspace-autoreview
    ───────────────────────────────────────────────────────────────
    [v] plugin-multi-root-workspace-experiment        [inherit v]
        /Volumes/.../dsh-plugin-multi-root-workspace-experiment
    ───────────────────────────────────────────────────────────────
    [v] plugin-multi-root-workspace-ssh               [inherit v]
        /Volumes/.../dsh-plugin-multi-root-workspace-ssh
    [直到出现新 worktree v]        [暂不处理]        [添加所选（4）]

- Dialog：`className="mrfw-worktreeDialog"`，CSS `width: min(860px, calc(100vw - 48px))`；`contentClassName` 负责滚动；标题与 footer 固定。
- 列表：`.mrfw-worktreeList` 只负责纵向滚动与分隔线；行使用 `display: flex; align-items: center; padding: 12px 0; border-bottom: 0.5px solid var(--dsw-alias-border-l2)`，最后一行去边；checkbox、名称/路径列、权限选择器同一行垂直居中。
- 名称：文件夹 basename，14px/20px/500；路径：code 12px/18px/tertiary，第二行，`overflow-wrap: anywhere`；名称过长省略号。
- 选中态/悬停：行 hover 用 `--dsw-alias-interactive-bg-hover` 淡底（与面板行一致），不改变行高；checkbox 原生。
- 单候选与多候选统一为同一行组件：单候选只是列表长度为 1，footer 主按钮文案改为「添加」；保留主 checkout 的安全说明（见 Q3）。
- 删除 list 模式 description；标题、行、footer 自解释。

### 3.2 Footer

- snooze 下拉：`Button`（ghost/outline）+ primitives `Menu`，side bottom/align start/portal；选项仍为「直到出现新 worktree / 7 天 / 30 天 / 永久不再提醒」。
- 「暂不处理」「添加所选（N）」：优先用 primitives `Button`（outline/primary）替换自绘按钮；至少下拉必须是官方组件。
- 添加按钮在无选中时 disabled；busy 时整组 disabled。

## 4. 手绘图暴露的两个契约缺口（需要拍板）

### 4.1 每行权限选择器

用户要求「权限选择器（与工作区面板相同），默认 inherit」。现状**没有**可用的权限写入通道：

- `WorktreePromptView.access` 是固定 `'inherit'`；
- `WorktreeRequest` 没有每行 access 字段；
- `WorktreeService.resolve` 固定 `access: 'inherit'`；
- `MultiRootRegistry.addNew` 固定 `inherit`，注释明确 ADR 只允许 inherit。

三条可选路线：

| 方案 | 内容 | 影响 | 建议 |
| --- | --- | --- | --- |
| A. 仅视觉（不动授权） | 行内显示只读徽标（继承/读写等），不放下拉；说明固定 inherit。 | 纯客户端，0 协议改动，今天就能做 | 若本轮只追求视觉，推荐 |
| B. 完整选择器（需扩授权） | `WorktreePromptView.access` 改为 `RootAccess`；`WorktreeRequest` 增加每行 access（例如 `entries: [{ id, access }]`）；host resolve 校验并传 `addNew.access`；Registry 使用传入值并补 ADR-0013/0039 修订。 | 改动宿主、双端 schema、Registry、授权语义与全套测试；worktree 根不再固定 inherit，需要安全评审 | 若必须按手绘图实现，推荐这个，但工作量和风险显著高于纯视觉 |
| C. 假选择器 | 放下拉，但只允许/只显示 inherit。 | 视觉满足、行为无效，不推荐 | 不推荐 |

**需要用户确认**：是否接受 B 的授权语义变化（worktree 候选可以以 read-only / read-write 登记）？若只是想要「看起来像面板」，建议 A。

### 4.2 git branch 列

当前 `WorktreePromptView` 没有 branch 字段，宿主发现只读 HEAD 做身份校验，没有解析分支名。选项：

- **本期不放 branch**（推荐）：用现有 kind 徽标（Worktree 源码树 / 主 checkout）占位，视觉最接近手绘图的同时不改宿主。
- **本期加 branch**：给 `WorktreePromptView` 增可选 `branch?: string`，宿主从 admin HEAD/refs 解析（需处理 detached HEAD、bare、旧格式、degraded 快照），并加契约/宿主/客户端测试；工作量约 +0.5–1 天。

**需要用户确认**：branch 是硬需求还是可以先省略？

## 5. 实施计划（待确认后按阶段提交）

### 阶段 1：纯视觉重构（不碰授权）

1. `WorktreePrompt.tsx`：给 `Modal` 加宽类；列表模式移除 description；行改为连续列表（checkbox + 名称/路径 + 权限徽标或禁用选择器）；footer 改 primitives 下拉/按钮；单候选统一为一行。
2. `styles.ts`：新增 `.mrfw-worktreeDialog`、重写 `.mrfw-worktreeList/.mrfw-worktreeRow*`、footer 按钮/菜单布局；删除卡片描边/圆角；保留窄屏回退。
3. 测试：`tests/client-worktree.spec.tsx` 更新列表断言（行数、无卡片类、checkbox、路径、footer 菜单）；新增宽度/无 description 断言；`client-styles.spec.ts` 增加列表与宽度规则。

### 阶段 2（可选，按 §4.1 选项 B）：权限选择器

4. 契约：`WorktreePromptView` 增加 access；`WorktreeRequest` 增加每行 access；双端 strict schema。
5. 宿主：`resolve` 校验 access 白名单并传 `addNew`；Registry 使用之；ADR-0013/0039 修订 + 授权测试。
6. 客户端：每行 `Menu` 选择器（默认 inherit），与面板相同的 access 视觉；失败/跳过路径保持。
7. 测试：契约互斥/非法 access、addNew access 生效、read-only/read-write 的 effectiveAccess、cleanup 跟踪、客户端选择器默认值。

### 阶段 3（可选）：git branch

8. 宿主解析可选 branch；契约/客户端展示；detached/bare/旧格式降级为空。

### 阶段 4：文档与门禁

9. ADR-0039 第二十二次修订（Dialog 形态、宽、列表、删除说明、权限选择器是否扩授权、branch 是否展示）。
10. README 双语、P11/P12 记录；`pnpm lint/typecheck/test/build/docs:check/compat:check/pack:check`。

## 6. 需要用户拍板

1. **权限选择器**：选 A（只读徽标，不扩授权）还是 B（真实选择器，扩协议/Registry/ADR）？若选 B，确认 worktree 根不再固定 inherit。
2. **git branch**：本期省略（推荐）还是本期加宿主解析？
3. **单候选**：是否也统一成一行列表？主 checkout 的安全说明保留在行下还是 footer？
4. **权限选择器的视觉**：与工作区面板相同（access 菜单/徽标）还是手绘图的「下拉」形态？
5. **宽度**：860px 是否合适（窄屏回退为 calc(100vw - 48px)）？
6. footer 是否全部改用 primitives Button，还是只要求下拉用 Menu？

## 7. 风险与退出

| 风险 | 缓解 |
| --- | --- |
| 扩授权（B）改变 worktree 根的安全边界 | 单独阶段、独立 ADR 修订、授权/cleanup 全套测试；未批准前不做 |
| 列表行在窄 Dialog 下路径/名称/选择器挤压 | 名称省略、路径第二行、选择器固定宽；窄屏把选择器换到下一行 |
| 单候选与多候选两套逻辑分叉 | 抽出同一行组件，单候选只改 footer 文案与主 checkout 说明 |
| Dialog 加宽影响遮罩/焦点 | 使用 Modal 自带滚动与 focus 管理；只在 className 上加宽，不重写 Modal |
| 删除说明后用户不理解 inherit | 权限选择器/徽标本身表达继承；footer 或行内只保留必要的主 checkout 安全说明 |

**本轮退出条件**：报告获确认 → 按选定阶段实现 → 相关测试与 build/docs 门禁通过 → Draft PR #60 更新；未获授权前不进入阶段 2/3。

## 8. 已确认并实施（2026-11-15）

维护者选择：

1. **权限选择器走方案 B**：真实扩展契约、宿主与 Registry，worktree 根不再固定 `inherit`；每行默认 `inherit`，可改 `read-only` / `read-write`。
2. **分支按手绘图展示**：候选 admin HEAD 解析分支；主 checkout 取 common HEAD；detached HEAD 不显示。

落地内容：

- **契约**：`WorktreePromptView.branch?`；`WorktreeRequest.accesses?: [{ id, access }]`；`worktreePromptResolve` 只接受 access 在 `add`，校验 id 属于 `promptIds`、不重复、三档取值；`branch` 非空可选。
- **宿主**：`resolve` 二次校验并按 id 取 access，传 `addNew`；`addNew` 用 `grantFields` 写只读/读写 grant；分支从 HEAD 解析，主 checkout 用 common HEAD。
- **客户端**：Dialog 加宽、连续列表、删除说明行、行内 checkbox/名称/路径/分支/权限选择器、footer 走 primitives；单候选共用行结构；提交时按选中行携带 `accesses`。
- **测试**：`client-worktree` 54、`client-styles` 43、`worktrees-contract` 16、`worktrees-discovery` 28、`worktrees-common` 14；新增 access 契约/授权、分支、detached、只读 grant、逐行选择测试。
- **文档**：ADR 第二十二次修订、README 双语、P11/P12、本报告、计划索引。

验证与未完成项：

- 已通过 `pnpm lint`、`pnpm typecheck`、专项 306 passed / 1 skipped、`pnpm build`、`pnpm docs:check`、`pnpm compat:check`、`pnpm pack:check`。
- 仍待 CI matrix 与 GUI 视觉复核（宽度、连续列表、权限选择器、分支 chip、footer 下拉）。
