# Workspace Folders 面板的 Worktree 清理 UX 收敛 — 实施计划

> 状态：Completed（2026-11-16 实施与验收完成）。外部技术评审 2026-11-16 通过、无阻断项；评审的 P2/P3 注意项（错误归属、迟到成功、菜单状态清理、措辞）已并入本文件。
> 决策：[ADR-0045](../../decisions/ADR-0045-worktree-cleanup-panel-ui.md)。
> 关联：[ADR-0039](../../decisions/ADR-0039-worktree-aware-root-suggestions.md)（清理资格、授权、空结果静默）、[ADR-0006](../../decisions/ADR-0006-client-ui-host-tokens.md)（token 与 primitives 边界）、[ADR-0008](../../decisions/ADR-0008-panel-session-derived-authority.md)（面板 session 权威）、[ADR-0015](../../decisions/ADR-0015-files-tab-plugin-owned-browsing.md)（官方 info Toast 先例）。
> 基线：`fix/worktree-delete-panel` @ `53ae34d`（2026-11-16），与 `main` 同点。

## Goal

在不改变授权、清理资格、RPC 契约与「永不自动清理」语义的前提下，完成用户 2026-11-16 提出的四项面板 UX 修改：

1. 批量清理入口从 footer 移到「附属工作目录」标题行右侧，删除确认改为覆盖在面板上的官方 Dialog；
2. `cleanupEligible`（目录确认缺失）的 worktree 行只保留 标题 + 权限徽标 + 路径，右侧改为红色删除按钮 + 原有 `...` 菜单，去掉技能、reveal、重新登记与多余文字；
3. 移除 footer 中的批量按钮后，footer 不再横向溢出/裁切；
4. 手动 Worktree 发现没有可添加候选时，用官方 info Toast 给出反馈，不再静默关闭面板。

并在同一次变更中更新测试、双语 README、指南、架构文档与路线账本；本文件先作为评审对象，评审通过后再进入实施。

## Background

### 用户需求（2026-11-16）

| 编号 | 需求原意 | 关键约束 |
| --- | --- | --- |
| R1 | 「清理已删除的 worktree 根（N）」红色按钮移到「附属工作目录」标题右侧；有可清理项才显示；确认从面板顶部普通文字+按钮改为覆盖在面板上的 Dialog，删除确认保留 | 行为/可见条件不变；不新增入口 |
| R2 | 失效 worktree 行保持标题/path/权限分布不变，右侧图标改为红色删除 + 原 `...`；去掉 skill 与 folder（reveal）按钮；整体布局与正常附加目录行相同，不添加多余文字（原文「三个图标」；截图实际为四个：刷新、技能、folder、`...`，见下方澄清） | 仅 cleanupEligible 行（见下方澄清） |
| R3 | 底部红色按钮挤占横向空间导致按钮超出；移动后解决 | footer 其余控件不动 |
| R4 | 手动点击 Worktree 发现按钮、没有新 Worktree 时面板直接关闭且无任何面板出现；用官方 Toast 做 Info 提示 | 只提示，不写状态、不自动弹空 Dialog |

### 需求澄清（2026-11-16，维护者已确认）

- **失效行的行内补充文字移除**：现有橙色状态文字（「目录不存在，暂不授予」「Worktree 已删除」）与「该 worktree 已不存在。清理前，同一路径的新目录可能继承此授权。」不留在行内，行结构与正常附加目录行对齐；路径复用风险提示移入删除确认 Dialog。
- **改造范围仅 `cleanupEligible` 行**：`unregistered` / `moved` / `changed` 等不可清理状态保持现状（橙色状态文字 + 普通动作 + 普通 Remove）。
- **重新登记按钮一并移除**：截图里的 `cleanupEligible` 行实际有四个图标（刷新/重新登记、技能、reveal、`...`），需求原文说的「三个图标」指普通行的常规动作集；目标动作集明确为「红色删除 + `...`」两个按钮，因此刷新也一并移除。维护者在需求澄清中选择的范围即「仅 cleanupEligible 行，显示红色删除并去掉 skill/folder/刷新」。补救路径：目录重新出现后 Registry 路径级恢复会在下一次 `refresh`/`list`（面板打开或「重试」）重新分类为 `available`，清理按钮随之消失；普通 missing 根（无 worktree 信息或不可清理）的重新登记不受影响。

### 为什么现在做

- 现有实现把清理入口放在 footer，长文案按当前字号估算会让 `.mrfw-actions` 超出（见下方量化）；用户 2026-11-16 截图（未入库）中「Worktree 建议」按钮已被裁切到只剩「Worktr…」，面板宽度低于 640px 最大值。精确宽度与断点以实现时的实机复测为准。
- 现有单行动作里，reveal 必然失败、重新登记在目录重现前不会成功；技能开关虽可持久化，但路径缺失期间没有可见效果。这些按钮与两条橙色文字、一条长提示共同把失效行撑成与普通行完全不同的结构。
- 现有确认在 body 顶部内联渲染，与面板已有的权限升级 Modal 不一致，且会把列表下推。
- 现有手动入口在 overlay 拿到空候选时直接 `closeDialog()`，面板却已先关闭：一次点击没有任何结果。

### ADR 编号与文件名核查（2026-11-16）

- `docs/decisions/`：主线现有 ADR-0001–0029、0035–0044（rebase 后；含合入时新增的预览导航搜索 0043 与 sidebar footer 对齐 0044），本计划为 0045；0030–0034 已在 `feat/ssh-workspace` 分支预留，该分支另有 0040/0041 的历史 SSH 编号（与主线用途不同），主线从 0035 起跳；编号口径见 `docs/decisions/README.md` / `README.en.md`。
- 起草时扫描全部本地与远程分支后，**ADR-0043 未被占用**；`docs/plans/active/2026-11-16-*` 也不存在同名计划，本计划按 0043 / 2026-11-16 起草。rebase 到 main 时 0043/0044 已被合入的预览导航搜索与 sidebar footer 对齐占用，本 ADR 改号为 **0045**（决策内容不变）。

## Current State（`53ae34d`，2026-11-16）

### 1. 面板组件

文件：`src/client/WorkspaceFoldersAction.tsx`。

- `WorkspaceFoldersDialog` 的 `DialogState` 持有 `view/error/busy/noSession`；另有本地状态 `cleanupFor: readonly string[] | undefined`。
- 点击批量按钮（footer 内，`worktree.cleanupBatch`，仅 `RootsView.worktreeCleanupCount > 0`）或行菜单的 `worktree-cleanup` 项时，把 id 集合写入 `cleanupFor`。
- `cleanupFor !== undefined` 时，`mrfw-body` 顶部渲染 `<div className="mrfw-note" role="alert">`：`worktree.cleanupConfirm` 文本 + danger 的 `worktree.cleanupDo` + 取消按钮。**这就是要被 Dialog 取代的内联确认。**
- `runCleanup(ids)` 调用 `props.worktrees.cleanup(sessionId, ids)`；成功时用应答的 `roots` 覆盖 `state.view` 并清空 `cleanupFor`；失败时只设置 `state.error`，`cleanupFor` 保持（内联确认留在屏幕上）。
- 行渲染：对所有行输出 `rootText`（显示名 + 权限徽标 + `PathCopy`），随后按条件输出：`root.state !== 'available'` 的状态文字、`root.worktree.state !== 'active'` 的 worktree 状态文字、`worktree.pathReuse` / `worktree.pathReused` 提示、`root.state === 'missing'` 的重新登记按钮、`root.skillsEnabled !== undefined` 的技能开关、reveal 按钮、`Menu`（`...`）以及别名编辑行。
- `onDialogKeyDown` 的 Escape 守卫检查 `menuFor / accessMenuOpen / upgradeFor`；Tab 守卫在 `upgradeFor !== undefined` 时直接返回（把焦点交给权限升级 Modal）。新确认层必须加入同一套守卫。
- 已有 `Action`（胶囊按钮）、`IconButton`（28px 方形图标按钮，支持 `variant`）、`VARIANT_CLASS`（含 `danger`）与 `Modal`（primitives）可直接复用。

### 2. 样式

文件：`src/client/styles.ts`。

- `.mrfw-sectionTitleRow`（`display:flex; align-items:baseline; gap:8px; padding:8px 0 4px`）当前只装标题/说明，primary 与 additional 两个 section 共用；本次只在 additional 行加修饰类，避免改变 primary 行的换行行为。
- `.mrfw-row` 是 `display:flex; flex-wrap:wrap; align-items:center; gap:8px`；`.mrfw-rootText` 为 `flex: 1 1 240px`。
- `.mrfw-actions`（footer）：`display:flex; flex-wrap:nowrap; gap:8px`；仅 `@media (max-width:560px)` 允许换行；`.mrfw-actions .mrfw-btn` 高 32px、圆角 16px。
- `.mrfw-btnDanger` 使用 `--dsw-alias-state-error-primary`；`.mrfw-iconBtn` 宽 28px、padding 0、圆角 8px。
- `.mrfw-dialog` 宽度 `min(640px, 100%)`；`.mrfw-body` 左右 padding 24px。

**溢出量化（估算，待实机复测）**：对话框内容宽 = 640 − 48 = 592px。footer 固定项约：添加图标 32 + 权限下拉 ~100 + 「添加」~52 + 清理按钮 ~200（中文长文案）+ 「重试」~44 + 「Worktree 建议」~86 + 6×8 gap = 约 570px，再加输入框最小 80px ≈ 650px > 592px；因此即便在 640px 全宽也溢出，截图中的窄面板更严重。移除清理按钮（~200px + gap）后常规状态约 440px；但**到达根上限时** footer 还多一条 `panel.limitReached` 长文案（约 80–200px，取决于语言/换行），因此 R3 的结论限定为「常规状态恢复单行」，达上限的窄宽度场景列入实机矩阵并允许既有 `≤560px` 换行规则兜底。

### 3. 发现入口与空结果

- 面板按钮 `worktree.panelOpen` → `requestWorktreePrompt(sessionId)`（`src/client/worktree-prompt-bus.ts`，window CustomEvent）→ overlay 的 `onWorktreePromptRequest` → `openWorktreePrompt`（接受条件：client 可用、当前无 Dialog、session 与当前一致、设置未关闭）→ `openDialogFor(session)` 置 `dialogOpen`，面板在请求被接受后 `props.onClose()`。
- Dialog 的 effect 调用 `client.prompt(session, undefined)`；`answer.prompts.length === 0` 时执行 `closeDialog()`，Dialog 从未渲染（`dialogRows` 要求 `rows.length > 0`），面板也已关闭 → 无任何反馈。
- 组件在第 600 行附近有 `if (visibleNotice === undefined && dialogRows === undefined) return null`；新增 Toast 状态时必须纳入这个提前返回，否则 Toast 不会渲染。

### 4. 现有测试

- `tests/client-worktree.spec.tsx` 的 `describe('panel cleanup controls')`：
  - `'asks in place and cleans up the exact eligible ids'` 明确断言「确认是内联的，不是第二个 overlay dialog」——本次必须改成 Dialog 断言。
  - 手动入口的显示/隐藏在同一个 describe；Files 管理器入口透传在独立的 `describe('Files manager worktree entry')`（约 1054 行），本次只做回归、不改其断言。
- `tests/client-panel.spec.tsx`：missing 根（无 worktree 信息）的重新登记、权限升级 Modal 等用例不受影响；需回归确认。
- `tests/client-styles.spec.ts`：`.mrfw-rootName/.mrfw-accessBadge/.mrfw-pathCopy/.mrfw-btnDanger` 已有正则断言；新增 section 标题行动作与换行规则断言。
- 测试用 `tests/stubs/ui-primitives.tsx` 的 `Modal` 是 `role=dialog` 的 portal 桩（含 title/description/footer/children），`Toast` 是 `role=status` 的桩。确认 Modal 是面板 `.mrfw-dialog` 的 React 兄弟节点，其键盘事件不经过面板 `onKeyDown`；单测只能验证守卫分支，真实 Escape/焦点/Toast a11y 由实机目检覆盖。

### 5. 现有文档

- `README.md` / `README.en.md` 的 Worktree 小节（中文约 272–284 行）描述「面板提供逐条或批量清理」「清理前…面板会显示该提示」。
- `docs/guide/README.md` 「删除与清理」段（约 75 行）描述「批量清理只接受面板列出并显式确认的精确 id」「面板会提示」。
- `docs/architecture/multi-root-workspace.md` 的 Client 半部（约 209 行）描述附加根行动作（其中「在文件管理器中显示 / 上移 / 下移为图标按钮」已落后于现状），需按实现后的动作集更新。
- `docs/decisions/README.md`、`docs/plans/README.md` 索引；`CHANGELOG.md` / `CHANGELOG.en.md` 与路线账本只在实施完成/发版时更新（CHANGELOG 只记录已发布版本）。

## Scope

### In scope

| 需求 | 实施内容 | 主要文件 |
| --- | --- | --- |
| R1 | 批量按钮迁到 section 标题行；内联确认换成 `Modal`；批量/单行共用确认 | `WorkspaceFoldersAction.tsx`、`styles.ts`、`locales.ts` |
| R2 | `cleanupEligible` 行只留 标题/权限/路径 + 红色删除 + `...`；移除技能/reveal/重新登记/橙字/长提示 | `WorkspaceFoldersAction.tsx`、`styles.ts`（如需）、`locales.ts` |
| R3 | 由 R1 释放 footer 空间；不新增 footer 布局改动，实机复测 | 无（验证项） |
| R4 | 手动打开 Dialog 且首次 `prompt` 为空时，官方 info `Toast` | `WorktreePrompt.tsx`、`locales.ts` |
| 配套 | 组件/样式测试、双语文档、路线账本（完成时） | `tests/client-worktree.spec.tsx`、`tests/client-styles.spec.ts`、README 双语、guide、architecture |

## Non-goals

- 不改 host、Registry、worktree 服务、端点、wire schema、`RootsView` / `WorktreeRootView` / `WorktreeCleanupView`；不新增端点或依赖。
- 不改清理资格判定与 owner 复验；不把清理自动化；不改普通 Remove；不改 `unregistered` / `moved` / `changed` 行。
- 不改自动发现触发：`fresh: true` 空结果继续静默；不改 notice 的触发、形态、snooze 与生命周期。
- 不为清理的 `skipped` 新增逐行错误 UI（保持「刷新后的视图即结果」现状）。
- 不改 Files 页签管理器、RootSwitcher、Toast 关闭按钮等其他已完成 UI；不改支持矩阵与 CHANGELOG（发版时处理）。
- 不重构整个面板 footer / section 布局；不引入新的颜色、图标或第三方组件。

## Design

### D1. 批量清理入口（R1、R3）

- 在第二个 `<section className="mrfw-section">` 的 `mrfw-sectionTitleRow` 内、`panel.additional` 标题之后增加一个右对齐容器 `<span className="mrfw-sectionAction">`，其中放现有 danger `Action`：
  - 文案：`t('worktree.cleanupBatch', { count: view.worktreeCleanupCount })`（不变）；
  - 条件：`(view?.worktreeCleanupCount ?? 0) > 0`（不变）；
  - 点击：从 `view.roots` 过滤 `worktree.cleanupEligible === true` 的 id，`setCleanupFor(ids)`；
  - `pending={state.busy}`（不变）。
- 从 `.mrfw-actions` 删除同一按钮；footer 其余控件（添加/输入/权限/添加确认/重试/Worktree 建议/limit 提示）顺序不变。
- CSS：给 additional 的 `mrfw-sectionTitleRow` 加修饰类 `.mrfw-sectionTitleRowAction { flex-wrap: wrap; }`（不改 primary 行），新增 `.mrfw-sectionAction { margin-left:auto; align-self:center; display:inline-flex; }`。按钮使用 `.mrfw-btn` 默认 28px 高（不在 `.mrfw-actions` 上下文中，故不会命中 32px 规则；文案与语义不变，尺寸从 footer 的 32px 变为 28px）。
- 预期结果：640px 面板下 footer 单行不再裁切；窄容器下 section 标题行换行而不是横向溢出。R3 不新增 footer CSS；若实机在 560–640px 仍溢出，再单独评估（见 Risks）。

### D2. 删除确认 Dialog（R1）

- 在 `WorkspaceFoldersDialog` 返回值中、权限升级 `Modal` 之后增加一个 `Modal`：

  ```tsx
  <Modal
    open={cleanupFor !== undefined}
    onClose={() => { setCleanupFor(undefined) }}
    title={t('worktree.cleanupTitle')}
    description={cleanupFor === undefined ? '' : t('worktree.cleanupConfirm', { count: cleanupFor.length })}
    closeLabel={t('panel.close')}
    footer={/* 取消 + danger 确认 */}
  >
    {cleanupFor === undefined ? null : (
      <p className="mrfw-note">
        {t(cleanupFor.length === 1 ? 'worktree.pathReuse' : 'worktree.pathReuseMany')}
      </p>
    )}
    {/* cleanupError 时：<p role="alert" className="mrfw-alert">本地化错误</p> */}
  </Modal>
  ```

- **错误归属**：新增独立状态 `cleanupError: PanelError | undefined`；确认层不复用、不清空面板 body 的 `state.error`（复制失败/reveal 失败等无关错误保持原样）。清理失败写入 `cleanupError`，只显示在确认 Dialog 正文；未提交关闭时随 `cleanupFor` 一起清空。若请求进行中关闭确认 Dialog 后失败，则用 `cleanupForRef`（镜像当前 `cleanupFor` 的 ref）判断并写入 `state.error`，由面板 body 既有 alert 显示，不重开 Modal。
- 宽度：使用 primitives `Modal` 的默认卡片宽度（与现有权限升级确认一致），不新增加宽类；长文案自然换行。
- 互斥与前置清理：打开清理确认时清空 `upgradeFor`、`menuFor`、`accessMenuOpen`；打开升级确认时清空 `cleanupFor`、`cleanupError`；同一时刻只有一个确认 Modal。
- 迟到结果：成功时采用应答 roots，并仅在 `cleanupFor` 仍指向本次提交的同一个 id 数组时清空（`setCleanupFor(current => current === ids ? undefined : current)`），防止旧请求成功误关「请求中关闭后又打开」的新确认；同一 id 重新打开是新数组，不会被旧结果关闭。
- 确认按钮 `pending={state.busy}`，点击执行 `void runCleanup(cleanupFor)`；成功由 `runCleanup` 清空 `cleanupFor` 并采用应答 roots；失败时 `cleanupFor` 保持、Modal 保持打开，正文显示与面板 body 同一套 `errorKeyOf` 文案（`unavailable/panel-internal` 追加 message 的现有规则不变）。
- 请求进行中，footer 取消按钮置 `disabled`；×/遮罩/Escape 只关闭请求中的确认 Dialog、不撤销已提交的删除请求（primitives `Modal` 的固定关闭控件无法真正禁用；与其留一个死控件，不如明确「关闭不撤销」），请求成功仍按应答 roots 刷新面板。未提交时取消/关闭只清空 `cleanupFor`/`cleanupError`，不发送请求。
- 删除 body 顶部的内联确认块（含 `role="alert"` 容器、危险与取消 `Action`）。
- 键盘守卫：`onDialogKeyDown` 的 Escape 条件追加 `cleanupFor !== undefined`；Tab 的提前返回条件同样追加（与 `upgradeFor` 一致）。Modal 自身负责焦点陷阱与 Escape。
- 单行入口：行尾红色删除按钮点击 `setCleanupFor([root.id])`；与批量共用同一 `cleanupFor`/Modal，无第二套确认。

### D3. `cleanupEligible` 行（R2）

对每个 `root` 计算 `const cleanable = root.worktree?.cleanupEligible === true`，仅当 `cleanable` 时（截图实际有四个图标：刷新、技能、reveal、`...`；目标动作集为红色删除 + `...`）：

| 元素 | 现状 | 目标 |
| --- | --- | --- |
| 显示名 + 权限徽标 + path | 有 | **保留不变**（徽标显示「不可用 / unavailable」） |
| 根状态橙字（`state.missing`） | 有 | 移除 |
| worktree 状态橙字（`directory-missing`） | 有 | 移除 |
| `worktree.pathReuse` 行内提示 | 有 | 移除（移入 D2 Dialog） |
| 重新登记（刷新图标，`root.state === 'missing'`） | 有 | 移除 |
| 技能开关 | 有 | 移除 |
| reveal / 在文件管理器中显示 | 有 | 移除 |
| `...` 菜单 | 有 | **保留原样**（菜单项不变，含清理与移除） |
| 红色删除按钮 | 无 | **新增**：`IconButton variant="danger"` + `IconTrash`，`label/title = t('worktree.cleanup')`，`onClick={() => setCleanupFor([root.id])}`，`pending={state.busy}` |

- 非 `cleanable` 行完全保持现状（包括 missing 根无 worktree 信息时的重新登记、other worktree 状态的橙字）。
- 行结构与普通行一致：同样两行文本列 + 右侧图标按钮；红色按钮与普通图标按钮同为 28×28，位置在 `...` 之前。
- 不新增行内文字；新增文案只出现在 D2 Dialog 与 D4 Toast。

### D4. 空发现 Toast（R4）

- `WorktreePrompt` 增加：
  - `manualDialogOpen` ref：`openWorktreePrompt`（手动入口）调用 `openDialogFor(session, { manual: true })` 时置 true；notice 的「查看」（`openDialog`）与关闭/会话切换/设置关闭时置 false。
  - 空结果处理：Dialog effect 中 `answer.prompts.length === 0` 分支在 `closeDialog()` 前，若 `manualDialogOpen.current === true` 则发布一次 info Toast。
  - Toast 状态：`{ seq: number } | undefined`（seq 用于重挂载）；渲染 `<Toast key={...} text={t('worktree.noCandidates')} holdMs={WORKTREE_EMPTY_NOTICE_HOLD_MS} onDone={...} />`；不传 icon/tone。
  - 提前返回：`if (visibleNotice === undefined && dialogRows === undefined && emptyNotice === undefined) return null`。
  - 清理：session 切换、设置关闭、新的手动打开时重置 Toast（避免旧提示残留/覆盖）；`onDone` 仅在 seq 仍匹配时清理。
  - 常量 `WORKTREE_EMPTY_NOTICE_HOLD_MS = 5000`（导出供测试；与 `FILES_PAGE_NOTICE_HOLD_MS` 同值，但不跨模块耦合）。
- 不写 `seen/snooze/resolve`，不打开空 Dialog，不改变自动 `fresh` 路径。
- 位置：官方 Toast 自带固定落点；此时面板已关闭、notice 已被 `openDialogFor` 清除，不存在遮挡/避让问题。

### 文案

| Key | 中文 | English | 用途 |
| --- | --- | --- | --- |
| `worktree.cleanupTitle`（新） | 清理已删除的 worktree 根？ | Clean up deleted worktree roots? | 确认 Dialog 标题 |
| `worktree.cleanupConfirm`（沿用） | 将删除 {count} 个已确认目录缺失的受跟踪 worktree 根登记；此操作不可撤销。 | Remove {count} tracked worktree root registration(s) whose directories are confirmed missing? This cannot be undone. | 确认 Dialog 描述 |
| `worktree.pathReuse`（沿用） | 该 worktree 已不存在。清理前，同一路径的新目录可能继承此授权。 | This worktree no longer exists. Until it is cleaned up, a new directory at the same path can inherit this registration. | 确认 Dialog 正文（count = 1） |
| `worktree.pathReuseMany`（新） | 这些 worktree 已不存在。清理前，同一路径出现的新目录可能继承相应授权。 | These worktrees no longer exist. Until they are cleaned up, a new directory at the same path can inherit the corresponding registration. | 确认 Dialog 正文（count > 1） |
| `worktree.cleanupDo`（沿用） | 确认清理 | Clean up | 确认按钮 |
| `panel.aliasCancel`（沿用） | 取消 | Cancel | 取消按钮 |
| `worktree.cleanup`（沿用） | 清理附加根 | Clean up additional root | 行内红色删除的 `aria-label`/title（同时仍是菜单项） |
| `worktree.noCandidates`（新） | 当前没有可添加的 Worktree。 | No worktrees are available to add right now. | 空发现 Toast |
| `worktree.cleanupBatch`（沿用） | 清理已删除的 worktree 根（{count}） | Clean up deleted worktree roots ({count}) | section 标题行按钮 |

### 可访问性

- 红色删除：`aria-label`/`title` 使用 `worktree.cleanup`；`pending` 期间 `aria-busy` 且不响应点击（沿用 `IconButton`）。
- 确认 Dialog：用 primitives `Modal` 的 `title/closeLabel/footer`；焦点陷阱与 Escape 由 Modal 自身管理（不手写 focus trap）；风险披露是正文文本，不是仅 title 提示。
- 面板 Escape/Tab 守卫与权限升级 Modal 一致（防御性：真实 Modal 的 Escape 由 primitives 的 document 监听处理，确认 Modal 是 `.mrfw-dialog` 的 React 兄弟节点，其键盘事件不经过面板 `onKeyDown`；单测直接派发 keydown 只证明守卫分支，真实路由由实机目检覆盖）。
- Toast：官方组件负责呈现与 `holdMs` 到期后的 `onDone`，不可手动关闭、不抢焦点、不阻塞、不写状态；测试桩用 `role=status` + 点击触发 `onDone`，真实 primitives 的 a11y 呈现由实机目检覆盖。

### 边界与状态处理

| 场景 | 预期 |
| --- | --- |
| 清理成功后 | Modal 关闭；列表采用应答 roots；`worktreeCleanupCount` 随之更新；batch 按钮在 0 时消失 |
| 清理失败 | Modal 保持；正文显示本地化 `cleanupError`；`cleanupFor` 不变；可重试/取消 |
| 清理返回 `skipped` | 按现状刷新视图；被跳过的行留在列表，不新增逐行提示 |
| 会话切换 / 关闭功能 | 关闭 Dialog/notice/Toast；`cleanupFor` 已在既有 session 切换 effect 中清空，保持 |
| 权限升级 Modal 与清理 Modal | 打开一侧时清空另一侧状态，同一时刻只有一个确认 Modal（实现显式保证，测试覆盖） |
| 手动入口被 overlay 拒绝 | 面板不关闭、不弹 Toast（现状） |
| 自动 `fresh` 空 / notice「查看」竞态空 | 静默，不变 |
| 手动打开时 `prompt` 抛错 | 静默关闭（非空结果，不在本轮 R4 范围；记录为残余） |
| 清理请求进行中 | footer 取消 `disabled`；×/遮罩/Escape 只关闭请求中的确认 Dialog，请求继续并按结果刷新 |
| 请求中关闭确认 Dialog 后失败 | 错误写入面板 body 的既有 alert（`state.error`），不重新打开 Modal；下次打开确认层只清 `cleanupError` |
| 打开清理确认 | 清 `cleanupError`、`menuFor`、`accessMenuOpen`；与升级确认互斥；不动 `state.error` |
| 达根上限 | footer 多一条 `panel.limitReached`；窄宽度由既有换行规则兜底，R3 只承诺常规状态 |
| 窄容器 | section 标题行换行；footer 在 `≤560px` 仍走既有换行规则 |

## Implementation

### Phase 0 — 评审门禁

- 外部评审通过本 ADR 与计划（Proposed → Accepted 由维护者决定）后才开始代码实施。
- 若评审改变 D2/D3/D4 的呈现选择，同步更新 ADR 的 Decision/Alternatives 后再开工。

### Phase 1 — 面板（R1、R2、R3）

1. `src/client/WorkspaceFoldersAction.tsx`
   - 新增 `isCleanupEligible` 辅助（或直接内联 `root.worktree?.cleanupEligible === true`）。
   - 从 `.mrfw-actions` 移除批量清理 `Action`；在第二个 section 的 `mrfw-sectionTitleRow` 增加 `.mrfw-sectionAction` 包裹的同一 Action。
   - 删除 body 顶部内联确认；在权限升级 `Modal` 之后增加清理确认 `Modal`（D2），正文按 `cleanupFor.length` 选择 `worktree.pathReuse` / `worktree.pathReuseMany`，错误来自独立 `cleanupError`；打开时清 `cleanupError`/`menuFor`/`accessMenuOpen`、与 `upgradeFor` 互斥；成功用 functional update 只清本次数组；`busy` 时 footer 取消置 `disabled`，×/遮罩/Escape 只关闭请求中的确认 Dialog、不撤销请求。
   - 新增 `openCleanup(ids)`/`closeCleanup()` 小 helper 统一上述状态转换，避免批量、单行、菜单三处入口各写一遍；`cleanupForRef` 与 `cleanupFor` 同步，供 `runCleanup` 的 catch 判断错误归属。
   - `onDialogKeyDown`：Escape 与 Tab 守卫加入 `cleanupFor !== undefined`（防御性；真实 Escape 由 Modal 自己处理）。
   - 行渲染：`cleanable` 时跳过 D3 列出的移除项、追加 danger `IconButton`；其余行不动。
   - 更新文件头/相关注释（内联确认与 footer 按钮的说明）。
2. `src/client/styles.ts`
   - 新增 `.mrfw-sectionTitleRowAction`（`flex-wrap: wrap`），只挂在 additional section 的标题行。
   - 新增 `.mrfw-sectionAction`（`margin-left:auto; align-self:center; display:inline-flex`）。
   - 不改 `.mrfw-sectionTitleRow` 本体、`.mrfw-actions`、`.mrfw-row`、`.mrfw-btnDanger`、`.mrfw-iconBtn`。
3. `src/client/locales.ts`
   - 中英各新增 `worktree.cleanupTitle`、`worktree.pathReuseMany`；D4 的 `worktree.noCandidates` 可同批加入（Record 类型强制双语齐全）。
4. `tests/client-worktree.spec.tsx`
   - 改写 `'asks in place and cleans up the exact eligible ids'` 为 Dialog 版本：点击 batch → `getByRole('dialog', { name: 'worktree.cleanupTitle' })` → 确认 → `cleanup('s1', ['r1'])`；断言不再有内联确认文案。
   - 新增：batch 按钮位于 section 标题行、footer 不再有 danger 按钮；count=0 时 batch 按钮不渲染；点行内红色删除只提交该 id；`...` → `worktree-cleanup` 菜单项打开同一个确认 Dialog；`cleanable` 行不渲染技能/reveal/重新登记按钮且不含 `worktree.pathReuse` / `state.missing` / `worktree.state.directory-missing` 文本；权限徽标与 path 仍在；非 eligible 的 unregistered 行保持现状（worktree 状态文字 + 普通动作；若 `root.state === 'missing'` 仍保留重新登记）；单条确认正文含 `worktree.pathReuse`、批量 >1 含 `worktree.pathReuseMany`；失败时 Dialog 保持且正文显示 `cleanupError`、不污染 `state.error`；请求中关闭 Dialog 后失败回到 body alert；`busy` 时 footer 取消 `disabled`、关闭确认 Dialog 不取消请求且成功仍采用新视图；迟到成功不关闭重新打开的新确认（functional update）；两个确认互斥（打开清理时升级状态被清空）；红色删除按钮的 `aria-label`/`title` 为 `worktree.cleanup`；Escape 在 Dialog 打开时不关闭面板（在面板容器上派发 keydown 断言 `onClose` 未调用，仅证明守卫分支）。
5. `tests/client-styles.spec.ts`
   - 断言 `.mrfw-sectionTitleRowAction` 的 `flex-wrap` 与 `.mrfw-sectionAction` 的 `margin-left:auto`（行内动作位置与窄宽兜底的承重规则）。

### Phase 2 — 空发现 Toast（R4）

1. `src/client/WorktreePrompt.tsx`
   - 引入 `Toast`（primitives）；导出 `WORKTREE_EMPTY_NOTICE_HOLD_MS = 5000`。
   - `manualDialogOpen` ref 与 `emptyNotice` 状态；`openDialogFor(session, { manual })`；空 `prompts` 分支发布 Toast；提前返回纳入 Toast；会话切换/设置关闭重置；`onDone` seq 守卫。
   - 自动 `fresh` 与 View 竞态路径不触发。
2. `src/client/locales.ts`：确认 `worktree.noCandidates` 双语（Phase 1 已加则复用）。
3. `tests/client-worktree.spec.tsx`
   - 新增：手动请求（`requestWorktreePrompt('s1')` 或直接渲染后调用总线监听）且 `prompt` 返回 `[]` → `role=status` 出现 `worktree.noCandidates`、无 `role=dialog`；自动激活 `fresh` 空结果静默；notice「查看」竞态空保持静默；手动打开 `prompt` 抛错静默（记录残余）；session 切换/设置关闭清除已显示的 Toast；stub Toast 的 `onDone` 只通过点击模拟（stub 无到期路径），且只清理匹配 seq；真实 Toast 的定时淡出由实机目检覆盖。

### Phase 3 — 文档与账本

1. 实现同批更新：
   - `README.md` / `README.en.md`：Worktree 小节的清理入口位置、确认 Dialog、失效行动作、空发现 Toast；「面板会显示提示」改为「在删除确认中披露」。
   - `docs/guide/README.md`：「删除与清理」段同步；补充「清理确认是覆盖在面板上的 Dialog」。
   - `docs/architecture/multi-root-workspace.md`：Client 半部的附加根行动作描述改为当前动作集（普通行：技能/reveal/`...`；`cleanupEligible` 行：红色删除/`...`），补批量清理入口位置与空发现 Toast 一句；同时把「ui-primitives 展示型组件的 import 边界见 ADR-0006」改为「token 与 primitives 边界见 ADR-0006，确认层 Modal/Toast 由该 ADR 决策 7 覆盖」。
   - `docs/plans/active/2026-09-12-multi-root-workspace.md` 进度总账：实施完成后登记批次与证据（唯一真源，不在本计划复制状态）。
   - `docs/decisions/README.en.md` / `docs/plans/README.en.md`：本次评审批已随中文索引同步新增 ADR-0045 / 本计划条目；实施批如再改索引需保持双语一致。
   - `CHANGELOG.md` / `CHANGELOG.en.md`：发版时写入用户可见变更（本计划不预写）。
2. `pnpm docs:check` 通过；检查本 ADR/计划链接与索引。
3. 完成后将本计划移入 `docs/plans/completed/` 并在 `docs/plans/README.md` 更新位置与状态；ADR-0045 由维护者决定是否转 Accepted。

## Validation

### 自动化

| 命令 | 目的 |
| --- | --- |
| `pnpm exec vitest run tests/client-worktree.spec.tsx tests/client-panel.spec.tsx tests/client-styles.spec.ts` | 受影响客户端套件（可视情况先 `pnpm build`） |
| `pnpm lint` | oxlint |
| `pnpm typecheck` | 双面类型（locale Record 强制双语齐全） |
| `pnpm build` → `pnpm test` | 仓库要求 `pnpm test` 在 build 后（`tests/client-bundle.spec.ts` 断言产物） |
| `pnpm docs:check` | 文档结构/链接/编号 |
| 仓库既有强制门禁 | `pnpm kernel:probe`、三个 smoke、`pack:check`、`smoke:packed` 按 AGENTS 要求随 PR/CI 执行；本次无 host/打包面变化，仍不得跳过 |

### 实机目检（必须，jsdom 无法渲染 primitives 与真实布局）

在 DSH Web profile 中构建并安装本分支后，制造一个 `cleanupEligible` 场景（`git worktree add` 创建 worktree → 开启 Worktree 建议 → 在面板添加该根 → `rm -rf` worktree 目录 → 打开面板）：

1. 「附属工作目录」标题右侧出现红色批量按钮，footer 不再有该按钮；footer 在 640 / 600 / 560 / 480 CSS px 下不裁切（≤560 按既有规则换行）；另在**根数量达到上限**（出现 `panel.limitReached`）的同一组宽度下复测，确认既有换行规则可兜底。R3 的验收以常规状态为主，达上限的窄宽度只要求不出现新的溢出回归。
2. 批量按钮与行内红色删除都打开覆盖在面板上的 Dialog；标题/数量/不可撤销/路径复用披露/取消/确认齐全；未提交时遮罩、Escape、关闭按钮只取消、不发送请求；请求进行中 footer 取消置灰，×/遮罩/Escape 只关闭请求中的确认 Dialog 且请求继续。
3. 确认后请求成功 → Dialog 关闭、行消失、计数下降；模拟失败（例如 host 返回 not-eligible）→ Dialog 保持并显示本地化错误。
4. `cleanupEligible` 行只有 标题 + 「跟随会话（不可用）」+ path + 红色删除 + `...`；无橙字、无长提示、无技能/reveal/刷新；普通行与非 eligible 失效行保持原动作；浅色/深色主题下红色按钮与图标对比正常。
5. 手动 Worktree 入口在无候选时：面板关闭后出现官方 info Toast（无图标/无警告色），到期自动淡出（官方 Toast 不可手动关闭）；有候选时行为不变。
6. 键盘：Dialog 打开时 Tab 不进入背后面板、Escape 先关 Dialog 再关面板；焦点返回合理位置。

### 需求追溯

| 需求 | 设计 | 测试/验收 |
| --- | --- | --- |
| R1 | D1 + D2 | batch 位置测试、Dialog 确认/取消/失败/Escape 测试、实机 1/2/3 |
| R2 | D3 | cleanable 行动作/文本测试、非 eligible 回归、实机 4 |
| R3 | D1 | footer 宽度实机 1（含 640/600/560/480，以及达根上限的同一组宽度） |
| R4 | D4 | 手动空结果 Toast / 自动空静默 / View 竞态静默测试、实机 5 |

### 证据记录（2026-11-16 实施完成）

| 项 | 结果 | 证据 |
| --- | --- | --- |
| 受影响单测 | 3 个文件 **199 passed / 0 failed**（含 footer 提示行布局的两个新用例） | `pnpm exec vitest run tests/client-worktree.spec.tsx tests/client-panel.spec.tsx tests/client-styles.spec.ts` |
| 全量 `pnpm test`（build 后） | 2042 用例：**1860 passed / 165 skipped / 17 failed**；17 个失败全部是本机 DSH 外层沙箱下共享 Registry 的 IPC/租约用例（`contended` 而非 `follower`），与既有基线记录的失败集合同形，与本批改动无交集；client 与 worktree 套件全部通过 | `pnpm build` → `pnpm test` |
| `pnpm docs:check` | **0 errors、0 warnings** | 命令输出 |
| 实机目检 | 隔离 DSH Web profile（scratch `DSH_HOME`、DSH `0.2.2-rc.3`、Chrome 157 headless + CDP、真实 link 安装）：fixture 为真实 git main checkout + linked worktree，经面板「Worktree 建议」流程登记后 `rm -rf` 制造 `cleanupEligible`。视口 1280 / 640 / 600 / 560 / 480 px × 浅/深主题；覆盖批量与单行 Dialog、取消、请求中 footer 取消置灰与 × 关闭不撤销请求、成功行消失且计数下降、失败时的本地化错误、`cleanupEligible` 行动作集、普通 missing 行回归、Tab 焦点陷阱与 Escape 先关 Dialog 再关面板、空发现 Toast 自动淡出 | 截图：`.dsh-smoke/manual-verify/qa/**/*.png`（gitignored 本地证据，路径清单见下） |
| 强制门禁 | `kernel:probe`：本机无可用受限执行（seatbelt `runner-failed: sandbox_apply: Operation not permitted`；bwrap / landlock 未安装），内核断言按既有规则显式 skip。`smoke:compose` **56/56**；`smoke:behavior` **96 passed / 8 能力 skip**；`smoke:journey` **88 passed / 2 能力 skip**；`pack:check` **227 members**；`smoke:packed` **95 passed / 0 failed / 8 能力 skip**（tarball 经 `dsh plugin add` 装进隔离 scratch home，载荷解析在 checkout 之外） | 命令输出 |

### 实机目检证据

- 环境：macOS arm64 / Node `24.18.0` / DSH `0.2.2-rc.3` / Chrome `157.0.8103.52`；隔离 `DSH_HOME` 为 `.dsh-smoke/manual-verify/home`，插件经 `dsh plugin --profile web add` 以 `link:` 安装；fixture 与截图均在 gitignored 的 `.dsh-smoke/manual-verify/` 下。
- 面板与入口：`qa/width2/panel-{1280,640,600,560,480}-light.png`；`qa/limit-width/limit-{1280,640,600,560,480}-light.png`（根数量达上限、footer 出现 `panel.limitReached` 的同一组宽度）。测量结果：五个宽度下 footer `scrollWidth <= clientWidth + 1`、最后一个 footer 按钮与 section 标题行按钮都在 Dialog 右缘内；560/480 按既有 `≤560px` 规则换行（footer 高 51→91/107/131/215 px），无横向溢出。
- 确认层：`qa/dialog/dialog-batch-light.png`、`dialog-single-light.png`、`after-escape-light.png`；`qa/busy/dialog-busy-light.png`、`after-cleanup-light.png`；`qa/failure2/dialog-error-light.png`；`qa/keyboard/dialog-tab-focus.png`。DOM 断言记录：Dialog 文本含标题/数量/不可撤销/路径复用/取消/确认；请求中 `取消` `disabled=true`、确认按钮 `aria-busy=true`；× 关闭后面板保留且请求继续，成功后行消失、批次按钮消失、行数 16→15；失败时 Dialog 保持且正文显示本地化 `该 Worktree 根当前不满足清理条件。`，不显示 host 原文；Tab 从确认按钮→关闭→取消循环且始终在 Modal 内（`inPanel=false`）；第一次 Escape 只关 Dialog（面板仍在、焦点回到面板），第二次关面板。
- 行动作集：`qa/step5b/panel-cleanup-eligible.png`（`cleanupEligible` 行仅 名称/权限徽标/路径 + 红色删除 + `…`，无技能/reveal/重新登记/橙字/行内提示；批量入口在「附属工作目录」标题行，footer 无 danger 按钮）；`qa/plain-missing/panel-plain-missing-light.png`（普通 missing 行保留 `目录不存在，暂不授予` + 重新登记 + 技能 + reveal）。
- 主题：`qa/dark2/panel-dark-1280.png`、`qa/dark2/dialog-dark-1280.png`（`color-scheme: dark`，body 背景 `rgb(21,21,23)`）。
- 空发现 Toast：`qa/toast2/toast-empty-visible.png`（官方 info Toast「当前没有可添加的 Worktree。」，无 icon/警告色，面板已关闭、无 Dialog）与 `qa/toast2/toast-empty-faded.png`（约 6 秒后 DOM 中已消失，自动淡出）。有候选时手入口仍打开单候选确认 Dialog（`qa/step3/prompt.png`、`qa/linked2/prompt-second.png`）。
- 目检未覆盖（由单测覆盖）：真实鼠标点击遮罩关闭（与 × 走同一 `onClose`）、Toast 的精确 5000ms 时刻（以“出现→6 秒后消失”证明自动淡出）。

### 实施说明与偏差

- D2 的“迟到成功不关闭重新打开的新确认”由 identity guard 实现（`setCleanupFor(current => current === ids ? undefined : current)`）。该竞态在 UI 上不可达：请求进行中所有清理入口（批量、行内删除、菜单项）都因 `busy` 处于 pending 状态、不会再次打开确认层，因此单测锁定其可达部分（应答仍被采用、确认层保持关闭），identity 分支由代码审查覆盖。
- 实机目检发现的事件顺序与单测一致，未发现需要偏离 ADR/计划的实现问题。
- rebase 到 main（2026-11-16）：main 新合入的 ADR-0043（预览导航搜索）与 ADR-0044（sidebar footer 对齐）占用原编号，本 ADR 改号为 **ADR-0045**；冲突仅出现在 `docs/decisions/README`、`README.en.md`（索引与编号口径）、`ADR-0006` 的 Status 行与 `docs/architecture/multi-root-workspace.md` 的 Client 半部，均按「保留 main 新增内容 + 重放本批文案」解决；其余文件自动合并。
- 维护者后续要求（2026-11-16，目检后）：把 `panel.limitReached` 从控件之间移到 footer 内独立的提示行——提示独占一行、正式的添加控件行在其下方，两行都在 footer 顶部分割线之下。这是对 D1「footer 其余控件顺序不变」的后续修订，`WorkspaceFoldersAction.tsx`（提示移到 `.mrfw-actions` 首子元素，新增完整占位的 `.mrfw-actionsNote`）、`styles.ts`（`.mrfw-actions` 允许换行）与 `architecture` Client 半部已同步；新增两个测试（样式规则与 panel 首子元素结构），控件顺序、文案与禁用语义不变。

## Risks

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| 嵌套 Modal 的 Escape/Tab 归属错误 | 关闭确认层时误关面板，或 Tab 焦点逃逸 | 面板 keydown 守卫加入 `cleanupFor`；单测直接派发 keydown；实机键盘目检 |
| 路径复用风险披露从列表移到确认层后被认为不够显著 | 安全披露可见性下降 | 确认 Dialog 正文强提示 + 「不可用」徽标常驻；ADR-0045 记录为维护者接受的取舍；外部评审可复核 |
| footer 在极窄宽度/达上限时仍溢出 | R3 未完全解决 | 先按「移除按钮」验证 640/600/560/480 与达上限场景；若 560–640 常规状态仍溢出，再评估 footer 换行断点（最小化改动，需更新 ADR）；达上限的长文案属既有行为，本轮只要求不回归 |
| Toast 与 notice/面板关闭的时序竞态 | 重复提示或漏提示 | seq + `onDone` 守卫；session/设置变化清理；只允许手动路径触发 |
| 测试桩 Modal 不模拟真实焦点陷阱/Escape | 单测信心不足 | 单测断言插件自己的 keydown 分支；真实 Modal 行为由实机目检覆盖 |
| 文档漂移（README/guide/architecture 仍描述内联确认） | 评审/发布文档不一致 | Phase 3 同批更新；`pnpm docs:check`；ADR-0039 增加指向 ADR-0045 的取代说明 |
| 把非 `cleanupEligible` 行也误改 | 隐藏有效动作，行为回退 | D3 明示仅 `cleanupEligible`；新增非 eligible 行回归测试 |

## Documentation Impact

### 本次（ADR/计划评审批）

- 新增 `docs/decisions/ADR-0045-worktree-cleanup-panel-ui.md`（Proposed）与 `docs/plans/2026-11-16-worktree-cleanup-panel-ux.md`（本文件；评审批新增于 `plans/active/`，实施完成后移入 `plans/completed/`）。
- `docs/decisions/README.md` / `README.en.md` 追加 ADR-0045 索引；`docs/plans/README.md` / `README.en.md` 追加本计划索引（README 双语成对维护）。
- `docs/decisions/ADR-0039-worktree-aware-root-suggestions.md` 增加指向 ADR-0045 的取代说明：Status、§3.2 徽标呈现、§6.2 徽标/副行与确认形态、§6.5 提示位置、Alternatives 清理弹窗条目（只加指针，不改授权/分类/生命周期正文）。
- `docs/decisions/ADR-0006-client-ui-host-tokens.md` 增加 2026-11-16 修订（决策 7）：正式追认确认层 `Modal` 与瞬时 `Toast` 的直接 import；既有 P8/ADR-0039/ADR-0015 的使用是依据。
- 本批不做实现，因此 README/guide/architecture/CHANGELOG/路线账本保持描述当前已发布行为，避免把 Proposed 写成现状。

### 实施批（评审通过后）

- README 中英、guide、architecture 同批更新（见 Phase 3）。
- 路线账本登记实施/验收证据；本计划移动到 completed。
- 发版时 CHANGELOG 双语记录用户可见变更；版本号由发布流程决定，不在本计划承诺。

## Completion Criteria

1. R1–R4 全部按 D1–D4 实现，且实机目检 1–6 全部通过（含窄宽度、浅/深主题、键盘）。
2. 受影响客户端测试新增/更新并通过；`pnpm lint`、`pnpm typecheck`、`pnpm build` 后 `pnpm test`、`pnpm docs:check` 全部通过；仓库既有强制门禁不回归。
3. 无 host / wire / 存储 / 依赖 / 支持矩阵变化；授权与清理语义零改动（可用现有 host 测试作为回归证据）。
4. README 双语、guide、architecture、ADR-0039 指针、ADR-0006 修订与中英索引全部同步；路线账本在完成时登记证据。
5. 外部评审通过（ADR-0045 由维护者转 Accepted，或按评审意见修订后接受），本计划移入 `docs/plans/completed/` 并记录证据。
