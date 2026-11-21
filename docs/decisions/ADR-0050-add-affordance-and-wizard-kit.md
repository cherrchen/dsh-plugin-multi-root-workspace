# ADR-0050：工作区面板「添加」收口为单一按钮，并以向导设计套件承载远端登记

**状态** Accepted · 2026-11-29。本文记录工作区面板底栏的控件收口、新增目录的信任确认，以及为后续迁移预留的向导设计套件（`src/client/wizard/`）。

## 背景（Fact）

- 旧底栏在同一行混放四类控件：`+` 选择器按钮、手动绝对路径输入框、内联权限选择器、「添加」「重试」按钮。其中手动输入与选择器重复，内联权限选择器在新用户面前既不必要也难理解。
- 远端工作区落地后，「添加」有了第二个去向（远端目录登记），旧底栏没有它的位置；SSH 功能由 `multi-root-remote-tools` 设置表单的 `enabled` 控制，面板的形态必须跟随该开关即时切换。
- 旧 SSH 管理弹窗的连接向导是 Tag 步骤条 + 平铺表单，视觉过时；远端登记需要「环境 → 绑定 → 登记」的串联流程，但不应复制旧视觉。

## 决策

### 1. 底栏收口为一个 `+` 按钮（双形态）

- 移除手动路径输入、内联权限选择器、「添加」「重试」按钮；`panel.retry`/`panel.addManual` 文案保留给仍在使用的 SSH 弹窗。
- `enabled === true`（`WorktreeSettingsSignal.remoteEnabled()` 读 watched remote 表单的快照）：`+` 是打开器，hover（`onPointerEnter`）或点击弹出向上 `Menu`（`side="top"`、`closeOnPointerLeave`、portal），两项——「添加附属目录」（进入本地流程）与「添加远端工作目录」（进入远端向导）。`remotes`/`ssh` 客户端缺席时远端项禁用。
- 开关非 true 或表单缺席：`+` 即动作本体，单击直接走本地流程；达到上限时整钮禁用并以 `panel.limitReached` 作为可达名。
- 失败重试依赖会话与目录通知的自动刷新（会话出现/切换均触发 `refresh`），不再有手动重试入口。

### 2. 本地添加增加信任确认（`add-root-confirm.tsx`）

选择器返回的路径先暂存，弹出确认 Dialog：路径、风险说明（Agent 将按所选权限读写该目录）、权限选择（沿用 `inherit`/`read-only`/`read-write` 三档；只有显式选择才随请求发送 `access`）、取消/确认。确认后才 `mutate('add')`；失败保留 Dialog 供重试或取消。这与 SSH 启用确认的信任语义一致——一次显式授权，而不是路径一落地就登记。

### 3. 向导设计套件 `src/client/wizard/`（迁移预留）

- `kit.tsx` 提供与业务解耦的壳层与控件：`WizardShell`（宽幅卡片 + 左侧步骤导轨 + 内容区 + 固定底部操作条）、`ChoiceCard`（单选大卡）、`WizardField`/`WizardCheckbox`/`WizardSegment`、`ChecklistRow`（状态点 + 说明 + 内联修复动作）、`WizardPicker`（按钮式 Menu 触发器）。
- 套件尽量落在 host 原语上：`Modal`/`useModalLayer`、`Menu`、`Input`、`Tag`、`Checkbox`、`SegmentedControl`、`StateDot`；缺失的原语按 `maybeComponent` 探测降级为等价原生标记（与 `pending.tsx` 既有模式相同）。旧 SSH 弹窗本次不动，后续迁移时整体换上这套壳层与控件即可。
- `add-remote.tsx` 用该套件实现三步：选/建环境（含 host key 扫描确认、Helper/access key/config link/连通性测试的就绪清单、能力开关）→ 绑定目录（路径 + 远端目录浏览 + 动作与传输配对）→ 摘要确认并 `remotes.add`。校验与草稿逻辑抽到 `ssh-draft.ts` 与旧弹窗共享，不复用旧视觉。

### 4. 开关读数经既有信号进入面板

`installSkillsSettingsCard` 的 `WorktreeSettingsSignal` 增加 `remoteEnabled()`：只读 watched remote 表单的 `value.enabled === true`，缺失/未就绪一律为 false（与 `enabled()` 的「未知即开」语义相反——加号形态是能力展示，宁可回落到直连形态）。`subscribeRemote` 复用为 `useSyncExternalStore` 的订阅源，开关拨动即切换形态。

## 影响

- 本地新增多一步显式确认；远端登记不再要求先开管理弹窗。
- 无 channel/契约变化；`WorkspaceFoldersAction` 的 props 新增 `remoteEnabled`（可选，缺席时按 OFF 形态渲染）。
- 后续工作：把 `SshManagementDialog`/`SshWorkspaceBindingsDialog` 迁到 `wizard/kit.tsx`，并考虑移除 `sshWizardSteps` 旧样式。
