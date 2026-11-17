# ADR-0045: Workspace Folders 面板的 Worktree 清理 UI 与失效行收敛

## Status

Proposed（2026-11-16；外部技术评审 2026-11-16 通过、无阻断项，转 Accepted 由维护者决定）

## Date

2026-11-16

## Context

### 1. 背景与现状

ADR-0039 交付了 B 根（worktree 附加根）的删除生命周期：Registry 只对 `cleanupEligible`（映射存在、`record.path` 确认缺失、`addedAt` 匹配）的登记开放专用清理，清理前必须由用户显式确认，永不自动删除。当前实现（`main` 的 `53ae34d`）把该确认与入口放在 Workspace Folders 面板里：

- 批量清理按钮位于对话框 footer 的 `.mrfw-actions` 行内（`worktree.cleanupBatch`，仅当 `RootsView.worktreeCleanupCount > 0` 时渲染），排在「添加」与「重试」之间。
- 单行清理入口在行内 `...` 菜单中（`worktree.cleanup`）。
- 用户点击批量按钮或菜单项后，`WorkspaceFoldersDialog` 把待清理 id 写入 `cleanupFor: readonly string[]`，并在对话框 **body 顶部**渲染一段普通文字 + 红色「确认清理」/「取消」按钮（`worktree.cleanupConfirm` / `worktree.cleanupDo`）。它不是 Dialog，触发按钮在 footer、确认区在 body 顶部、待清理行在列表中段，三者分离。
- `cleanupEligible` 行当前保留普通附加根行的全部动作：`skillsEnabled` 技能开关、在文件管理器中显示、`...` 菜单，外加 `root.state === 'missing'` 的重新登记（刷新图标）；同时渲染两条橙色状态文字（根状态 `state.missing` 与 `worktree.state.directory-missing`）和一条长提示（`worktree.pathReuse`：「该 worktree 已不存在。清理前，同一路径的新目录可能继承此授权。」）。
- 面板的「Worktree 建议」手动入口（footer、新会话 Hero、Files 管理器打开的是同一个对话框）经 `worktree-prompt-bus` 请求 shell overlay 打开建议 Dialog；overlay 的 Dialog 生命周期在首次 `worktreePrompt(sessionId)` 返回空列表时直接 `closeDialog()`，而面板在该请求被接受后已先关闭，因此「没有可添加的 Worktree」时用户只看到面板消失，没有任何反馈。

### 2. 问题

1. **footer 横向溢出**：`.mrfw-actions` 在视口宽于 560px 时是 `flex-wrap: nowrap`，批量清理按钮的长中文文案（约 200px）使固定控件加输入框最小宽度超过面板内容宽，行尾的「重试」与「Worktree 建议」被挤出或裁切（用户 2026-11-16 截图即此状态；精确宽度以实现时的实机复测为准）。这不是文字问题，而是控制行总宽超出容器。
2. **确认区与触发点分离**：内联确认在 body 顶部，会把列表整体下推，且与已有的「权限升级」确认层（primitives `Modal` 覆盖在面板上）交互不一致；删除是不可撤销操作，确认应出现在用户注意力所在的位置，并复用宿主 Dialog 的焦点/遮罩语义。
3. **失效行动作与行结构失配**：`cleanupEligible` 行的路径已确认缺失，reveal 必然失败，重新登记（`add` 同路径）在目录重新出现前也只会得到 `missing`，技能开关虽可持久化但在路径缺失期间没有可见效果；同时四个图标按钮 + 两段橙字 + 一条长提示使该行行高、换行与普通附加根行完全不同，按钮还会被挤到提示文字之后。
4. **空发现无反馈**：手动入口的语义是「再检查一次并打开建议 Dialog」，但 overlay 在空列表时静默关闭 Dialog，面板又已关闭，形成一次没有结果的点击。

### 3. 约束与既有决策

- 授权、清理资格、owner 复验（`rootId + path + addedAt`）、端点形状与「永不自动清理」均保持不变；本次是纯客户端呈现层变更，不新增端点、不新增依赖、不改宿主与协议。
- 客户端 UI 只使用宿主 `--dsw-*` token 与既有的 `mrfw-*` 样式（ADR-0006）；Dialog/Toast 使用 `@deepseek-ai/dsh-client-ui-primitives` 的官方组件（`Modal`/`Toast` 的直接 import 由 ADR-0006 的 2026-11-16 修订正式追认，见该 ADR 决策 7）。
- 面板主根与行数据由 host session 推导（ADR-0008），因此面板内的确认只作用于当前视图已经列出的 id，不存在「非当前 workspace 的清理弹窗无法定位」的旧问题。
- **ADR-0039 的冲突条款**：§6.2 明确「没有 overlay 清理对话框」，并在 Alternatives Considered 中以「用户要求面板内处理；且非当前 workspace 的清理弹窗无法正确定位」否决过「清理弹窗/overlay」；此外 §3.2/§6.2 的 deletion 徽标/副行与 §6.5 的路径复用提示位置也需要随本轮 UI 调整。本 ADR 取代这些**呈现层**结论，理由见 Decision §2 与 §5；§6.5 的披露义务本身保留，只把载体从行内移到删除确认层。
- **编号核查**（2026-11-16，`53ae34d`）：主线 `docs/decisions/` 现有 ADR-0001–0029、0035–0042；其他分支（如 `feat/ssh-workspace`）另有 SSH 系列的预留/历史编号（0030–0034 及该分支上的 0040/0041 等，见 `docs/decisions/README.md` 的编号口径），ADR 编号以当前分支/主线为准。扫描全部本地与远程 refs 后，**0043 未被任何 ref 占用**，故本 ADR 起草时使用 0043。（2026-11-16 rebase：main 已合入占用 0043 的预览导航搜索 ADR 与占用 0044 的 sidebar footer 对齐 ADR，本 ADR 改为 **0045**，决策内容不变。）

## Decision

### 1. 批量清理入口移到「附属工作目录」标题行右侧

- 触发点从 footer 的 `.mrfw-actions` 移到第二个 section 的 `mrfw-sectionTitleRow`，右对齐（`margin-left: auto`），与标题同一行。
- 可见条件不变：仅当 `RootsView.worktreeCleanupCount > 0` 时渲染，且仍只有这一处批量入口。
- 文案与语义不变：沿用现有 danger 胶囊按钮与 `worktree.cleanupBatch` 文案（含数量），不新增/改写文案；尺寸随 section 标题行动作采用 `.mrfw-btn` 的默认 28px 胶囊（不再是 footer 内的 32px 配方）。
- 点击行为不变：收集当前视图中全部 `root.worktree.cleanupEligible === true` 的 id，打开确认层（见 §2）。
- 响应式兜底：additional 标题行使用修饰类 `.mrfw-sectionTitleRowAction { flex-wrap: wrap }`；窄容器下按钮换到标题下一行并保持右对齐，不挤压标题、不溢出（primary 标题行不受影响）。
- footer 不再为清理按钮预留宽度；footer 的其余控件、层级与顺序不变，也不新增其他布局调整。

理由：清理动作的对象就是「附属工作目录」中的失效条目，入口放在该 section 标题上语义更近；移除后常规状态下 footer 恢复单行，达根上限时的窄宽度由既有 `≤560px` 换行规则兜底。

### 2. 确认层是覆盖在面板上的官方 Dialog

- 用 `@deepseek-ai/dsh-client-ui-primitives` 的 `Modal` 替换 body 顶部的内联确认；批量与单行共用同一个 `cleanupFor: readonly string[]` 状态与同一个 Modal 实例，仅 `count` 不同（确认文案通过 `worktree.cleanupConfirm` 的 `{count}` 表达）。
- 结构：`title`（新增 `worktree.cleanupTitle`）、`description`（既有 `worktree.cleanupConfirm`，说明将删除 N 个确认目录缺失的受跟踪登记且不可撤销）、正文中的路径复用风险披露（`count === 1` 用既有 `worktree.pathReuse`，`count > 1` 用新增的 `worktree.pathReuseMany`）、footer 的「取消」+ 红色「确认清理」（`worktree.cleanupDo`）。
- 宽度：使用 primitives `Modal` 的默认卡片宽度（与现有权限升级确认一致），不新增加宽类；长文案在卡片内自然换行。
- 视觉：不传 `tone`，与现有权限升级确认保持一致；`tone: 'warning'` 属可选视觉增强，不在本轮范围。
- 错误归属：确认层使用**独立的 `cleanupError` 状态**，不复用也不清空面板 body 的 `state.error`（复制失败、reveal 失败等无关错误保持原样）；正文错误只来自本次清理请求，取消/未提交关闭时连同 `cleanupError` 一起清除。若请求进行中用户关闭了确认 Dialog，随后失败则写入 `state.error`，由面板 body 的既有 alert 显示，不重新打开 Modal。
- 互斥与前置清理：打开确认层时清空 `upgradeFor`、`menuFor` 与 `accessMenuOpen`（防御性，避免残留菜单/升级层与确认层叠加）；打开升级确认时清空 `cleanupFor` 与 `cleanupError`。同一时刻只有一个确认 Modal。
- 迟到结果：请求成功时采用应答 `roots`，并仅在 `cleanupFor` 仍指向本次提交的同一个 id 数组时清空（functional update `current === ids`），避免「请求中关闭 → 再打开另一条确认 → 旧请求成功」误关新确认；同一 id 数组重新打开是新的数组实例，不会被旧结果关闭。
- 生命周期：
  - 请求进行中 confirm 按钮 `pending`，footer 取消按钮置 `disabled`；此时 × / 遮罩 / Escape 只关闭请求中的确认 Dialog、不撤销已提交的请求，请求成功仍按应答 roots 刷新面板（primitives `Modal` 的固定关闭控件无法真正禁用，与其留一个看起来可用的死控件，不如明确「关闭不撤销」）；
  - 成功：关闭 Modal，并直接采用 `worktreeRootsCleanup` 应答中的 `roots` 视图（与现状一致，不额外发 `list`）；
  - 失败：Modal **保持打开**，在 Modal 正文内显示本地化的 `cleanupError`，行数据不动，操作者可重试或取消；
  - 未提交时，取消 / 遮罩 / Escape 关闭只丢弃 `cleanupFor` 与 `cleanupError`，不发送任何请求。
- 层级归属：面板的 `onKeyDown` 把「`cleanupFor` 已设置」视为顶层 Modal 存在（防御性守卫，与既有 `upgradeFor` 一致）：即使事件到达面板也不关闭面板、不接管 Tab；实际的焦点陷阱、Escape 与遮罩语义由 primitives `Modal` 的 document 监听负责。这样同一时刻至多一个确认层持有键盘。
- id 授权语义不变：Modal 只展示；提交仍走 `worktreeRootsCleanup`，owner 仍逐 id 复验 `rootId + path + addedAt` 与路径缺失。确认层不是授权来源。

理由（取代 ADR-0039 §6.2 的「没有 overlay 清理对话框」）：旧结论的两个前提是「用户要求面板内处理」与「非当前 workspace 的清理弹窗无法正确定位」。本实现仍是面板内处理——Modal 属于面板组件、由面板状态驱动（面板关闭即随之不存在），不能脱离面板单独出现；面板本身已是 session 派生的模态 Dialog（ADR-0008），待清理 id 来自当前视图，不存在跨 workspace 定位问题。与此同时，嵌套 Modal 已是本面板既有的确认模式（权限升级），删除确认复用同一模式可消除两套键盘/焦点处理。

### 3. `cleanupEligible` 行收敛为「标题 + 权限徽标 + 路径 + 红色删除 + 更多」

- **仅** `root.worktree?.cleanupEligible === true` 的行应用本收敛；其他非 `active` 的 worktree 状态（`unregistered` / `moved` / `changed`，以及 `cleanupEligible === false` 的 `directory-missing`，例如 `addedAt` 已不绑定）不具备清理资格，保持现行呈现与普通 Remove，不在本决策范围。
- 行内实际有四个图标（重新登记刷新、技能、reveal、`...`）；需求原文的「三个图标」指普通附加根行的常规动作集，而目标动作集明确为「红色删除 + `...`」两个按钮，因此重新登记也一并移除。这是维护者在需求澄清中确认的范围（仅 `cleanupEligible` 行，显示红色删除并去掉 skill/folder/刷新）。目录重新出现后，Registry 的路径级恢复会在下一次 `refresh`/`list` 时重新分类该登记（`available` 恢复、清理按钮消失），不依赖重新登记按钮；普通 missing 根（无清理资格）的重新登记不受影响。
- 保留：显示名、权限徽标（此时通常显示「跟随会话（不可用）/ unavailable」，该徽标本身就是不可用状态的说明）、可复制的路径、`...` 菜单。
- 移除：两条橙色状态文字（根 state 与 worktree state）、`worktree.pathReuse` 行内提示、重新登记（刷新）、技能开关、在文件管理器中显示。理由：reveal 与重新登记对确认缺失的路径没有可成功的结果，技能开关在缺失期间没有可见效果；这些元素也是行高/换行失配的来源。
- 新增：行尾一个 icon-only 的红色删除按钮（danger 变体的 28px 方形图标按钮，即 `.mrfw-btnDanger` + `.mrfw-iconBtn`，圆角 8px；trash 图标，`aria-label`/`title` = `worktree.cleanup`），点击后 `cleanupFor = [root.id]`，打开 §2 的同一个确认 Dialog。红色删除是「此行可清理」的主要可见信号，`aria-label`/`title` 与对应测试是可达性要求的一部分。
- `...` 菜单内容不变（仍含重命名、Skill 命名空间、权限、清理、移除），不新增文字；红色删除只是同一清理端点的行内快捷入口，不引入第二种语义。
- 路径复用风险披露从行内移到 §2 的确认 Dialog：披露时机从「浏览列表时」变为「执行不可撤销删除前」；ADR-0039 §6.5 的披露义务本身保留，呈现位置按 §5 修订，并在决策点更有效。

### 4. 手动发现为空时使用官方 info Toast

- 触发条件（且仅此条件）：用户在 Workspace Folders 面板点击手动 Worktree 入口 → `requestWorktreePrompt(sessionId)` 被 overlay 接受 → 面板关闭 → overlay 为这次**手动打开**执行的首次 `worktreePrompt(sessionId)`（非 `fresh`）返回 `prompts: []`。
- 呈现：`@deepseek-ai/dsh-client-ui-primitives` 的 `Toast`，只给 `text`（新增 `worktree.noCandidates`）、`holdMs` 与 `onDone`；**不传 `icon`、不传 `tone`**，即官方组件的最低/信息级形态（与 ADR-0015 修订中 Files 页接管提示的做法一致）。
- 语义：瞬时、非模态、不写任何状态——不调用 `seen` / `snooze` / `resolve`，不写 sidecar / Registry，不打开空 Dialog，不重试。官方 `Toast` 只负责按 `holdMs` 自动淡出（不可手动关闭），结束后不留下任何持久状态。
- 失败范围：手动打开时 `worktreePrompt` 抛错（设置竞态、传输错误等）仍按现状静默关闭，不新增错误 Toast——本轮只解决「成功查询但结果为空」这一用户报告的静默死路，失败分类留给既有错误面。
- 自动激活的 `fresh: true` 空结果**保持静默**（ADR-0039 §20.1 不变）；notice 的「查看」路径在竞态下拿到空列表时也保持现行静默关闭（候选曾存在，属于极窄竞态，不新增提示）。
- 会话切换、设置开关关闭时清除尚未消失的 Toast；手动入口被拒绝（overlay 不接受：当前无活动 session / 已有 Dialog / 功能关闭）时面板不关闭，也不弹 Toast（现状不变）。

### 5. 不变量

- 授权、清理资格、owner 复验、`worktreeRootsCleanup` 端点形状、`RootsView` / `WorktreeRootView` 契约均不变；无 host、wire、存储或兼容矩阵变更。
- 永不自动清理；清理只删除 mapped + `cleanupEligible` 的 B 根；普通 Remove 与其他非 eligible 状态不变。
- 不新增运行时依赖；样式继续只用 `--dsw-*` token；文案中英双语同时补齐（`Record<Key, string>` 强制）。
- ADR-0039 的授权、分类与生命周期结论继续有效，本 ADR 只取代其以下**呈现层**结论：§3.2 的 deletion 状态/徽标映射所对应的徽标呈现（仅对 `cleanupEligible` 行）、§6.2 的徽标/副行呈现要求、§6.2 的确认形态（内联、「没有 overlay 清理对话框」）、§6.5 的路径复用提示呈现位置（从列表常驻改为删除确认层）、以及 Alternatives 中「清理弹窗/overlay」的否决。

## Alternatives Considered

- **保留内联确认，只把确认块移到 section 标题附近。** 仍会在 body 顶部/列表上方引入 reflow，且与权限升级的 Modal 模式不一致；删除确认也没有独立焦点语义。否决。
- **保留 footer 批量按钮，缩短文案或让 footer 换行。** 缩短文案不解决后续控件增长；让 footer 换行改变整行控件高度与主操作位置，且不解决「清理入口与附属目录语义脱节」。否决。
- **行内删除用带文字按钮（如「清理」）。** 违背「不要添加多余的文字」且破坏与普通行 icon 动作同高的布局。否决。
- **把所有非 active worktree 行都套用本收敛。** 不可清理状态没有安全的删除动作（只能普通 Remove），隐藏其状态文字会让「为何只有普通 Remove」更难理解。仅 `cleanupEligible`，其余保持现状。
- **空发现时打开一个空的建议 Dialog。** 空 Dialog 是死胡同，且面板已关闭；用户需要的是「这次检查没有结果」的瞬时说明。否决。
- **空发现复用自绘的常驻建议卡（notice）。** 该卡是为候选建议设计的持久、可操作表面；空结果没有候选可操作，用官方 info Toast 更轻且符合用户对「官方 Toast」的明确要求。否决。
- **notice「查看」路径的空结果也弹 Toast。** 该路径仅在候选曾存在而竞态消失时出现，属于罕见自愈场景；新增提示会增加噪音并扩大本决策范围。保持现行静默。
- **删除 `...` 菜单中重复的「清理」项，让红色按钮成为唯一入口。** 菜单契约与既有测试保持不变、行为零损失；重复入口不构成安全问题。保留菜单项，避免无必要的交互变更。
- **把路径复用风险留在行内、确认层只写数量。** 行结构与普通行仍不一致，且双份披露冗余；用户已明确选择「行内移除、移入确认 Dialog」。否决。

## Consequences

- **正面**：常规状态 footer 恢复单行、不再裁切（达上限的窄宽度由既有换行规则兜底）；清理入口语义就近；删除确认与其他危险确认统一为宿主 Dialog；失效行与普通行结构一致、动作可预期；空发现有一次明确反馈。
- **代价/残余**：
  - 路径复用风险不再在列表中常驻可见，只在确认删除时披露；列表仍通过「不可用」权限徽标暴露状态。这是对 ADR-0039 §6.5「面板必须显著提示」的呈现层修订（披露义务保留、载体改为删除确认层），由维护者本轮明确接受（2026-11-16 需求澄清）。
  - 面板多了一层 Modal，键盘归属与嵌套遮罩需要测试锁定（Escape 不关闭面板、Tab 不进面板）。
  - Toast 是瞬时信息、不可手动关闭，可能被错过；因为它不改变任何状态，漏看无副作用。手动打开时 `worktreePrompt` 失败仍静默（不在本轮范围）。
  - 清理请求的 `skipped`（候选在确认后变化）仍按现状被刷新后的视图吸收，不新增逐行错误提示。
- **文档影响**：新增本 ADR 与实施计划；ADR-0006 增加 2026-11-16 修订、ADR-0039 增加指向本 ADR 的取代说明；实现时同步 README 双语、`docs/guide/README.md`、`docs/architecture/multi-root-workspace.md` 的 Client 半部与控制行描述；发版时更新 CHANGELOG 与路线账本。`docs/decisions/README.md`/`README.en.md`、`docs/plans/README.md`/`README.en.md` 索引随本 ADR/计划更新。
- **测试影响**：`tests/client-worktree.spec.tsx` 现有「内联确认」断言改为 Dialog 断言，并新增行动作、Modal 层级、错误保持、Toast 等用例；`tests/client-styles.spec.ts` 增加 section 标题行动作与响应式规则。宿主、契约与 Registry 测试不需要改动。

## Related Documents

- [ADR-0039: Worktree 感知的附加根建议、Git 元数据授权与删除生命周期](./ADR-0039-worktree-aware-root-suggestions.md) — §6.1–§6.5 的清理资格与披露义务、§20.1 的空结果静默、第二十一次修订的手动入口。
- [ADR-0006: 客户端 UI 复刻宿主原生样式](./ADR-0006-client-ui-host-tokens.md) — `--dsw-*` token 与 primitives 边界；2026-11-16 修订（决策 7）正式追认确认层 `Modal`/`Toast` 的直接 import。
- [ADR-0008: 面板主根由 host session 推导](./ADR-0008-panel-session-derived-authority.md) — 面板的 session 权威，确认层作用的 id 范围。
- [ADR-0015: Files 页签插件自有浏览](./ADR-0015-files-tab-plugin-owned-browsing.md) — 官方 info Toast（无 icon/tone）的先例。
- [实施计划：Workspace Folders 面板的 Worktree 清理 UX 收敛](../plans/completed/2026-11-16-worktree-cleanup-panel-ux.md)
- 现状代码：`src/client/WorkspaceFoldersAction.tsx`（`cleanupFor`、`runCleanup`、footer 与行渲染）、`src/client/WorktreePrompt.tsx`（Dialog 生命周期）、`src/client/styles.ts`、`src/client/locales.ts`、`src/client/worktree-prompt-bus.ts`。
