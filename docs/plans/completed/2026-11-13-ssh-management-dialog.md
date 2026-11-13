# SSH 远端管理面板抽离（2026-11-13）

## Goal

把个人模式的 SSH 管理从 Workspace Folders 面板内联区块抽离为独立的“SSH 远端管理”对话框。Workspace Folders 面板只保留：

1. 已添加/已部署的远端工作区列表（沿用附属工作目录的列表行样式与登记/移除动作）；
2. SSH 远端管理入口（新增与管理两个入口）。

新对话框提供四个 Tab：添加连接、已有连接管理、SSH Key 管理、模式设置。平台字段在 GUI 上显示实际系统名称（Linux / macOS）；托管档位决定“添加连接”的引导方式。

本计划只改变浏览器端 UI 组织与文案，不改变 Host 侧协议、存储、准入或凭据语义。

## Background

ADR-0041 为 SSH 远端环境增加了三档凭据托管模式，并在 Workspace Folders 面板远端区块内直接渲染个人管理区（`src/client/ssh-panel.tsx`）和托管档位选择器（`src/client/remote-custody.tsx`）。该内联区块同时承担“工作区远端列表”和“全局 SSH 设置/凭据/环境/绑定管理”，在个人模式下体积过大，挤占了工作区面板的主要职责。

## Current State

- Workspace Folders 面板远端区块（`src/client/WorkspaceFoldersAction.tsx`）在控制面未停用时渲染：
  - 托管档位徽标；
  - `SshCustodySection`（三档单选、team 字段、降级风险确认）；
  - personal 且控制面 ready 时的 `SshPersonalArea`（链接横幅、凭据、环境、绑定）；
  - 部署端点列表（登记/移除）。
- `SshPersonalArea` 已经具备完整的个人模式管理能力：秘密输入提交即清、keyscan → 指纹 → token+fingerprint 保存、environment edit/delete、helper/access key、绑定表单、CAS 冲突重取。
- `ssh*` RPC、`SshStateView`、`RemotesView` 和 `RemoteModeControl` 都已存在，且不依赖新的 Host 端点。
- 现有测试：`client-ssh-panel.spec.tsx`（13 例，整体经 WorkspaceFoldersDialog 驱动）、`client-panel.spec.tsx` 的远端区块用例、`client-ops-settings.spec.tsx` 的档位切换用例。

## Scope

### In scope

- 新增独立 `SshManagementDialog`（独立 Dialog，内嵌四个 Tab）。
- Workspace Folders 远端区块改为“远端工作区列表 + 新增/管理入口”。
- 平台值的显示层映射：`linux` → Linux、`darwin` → macOS；连接测试结果显示同样映射。
- 托管档位影响“添加连接”的引导：personal 显示可用的图形化表单；team/hardened 显示部署侧引导与只读说明。
- 模式设置 Tab 复用现有 `RemoteCustodyModeControl` 与同一 `multi-root-remote-tools` form/CAS。
- 现有个人模式能力全部保留（凭据、环境编辑、主机密钥扫描、helper、访问密钥、绑定、链接 ssh_config）。
- 双语 locale、`mrfw-*` 样式、单元/DOM 测试、参考文档与路线图进度账本更新。

### Non-goals

- 不新增、不修改任何 Host RPC 端点或 `SshStateView`/`RemotesView` 线形。
- 不改变登记（register）语义：连接保存后仍在远端工作区列表中显式登记。
- 不改变 team/hardened 的 broker 证明、清单来源或凭据托管行为。
- 不给模型暴露任何新入口；实验性开关仍默认关闭。
- 不重做插件详情设置卡的启用开关。

## Design

### Workspace Folders 远端区块

- 区块标题保留 `panel.remote` 与托管档位徽标。
- 标题下加入两枚入口按钮：
  - `panel.remoteAdd`：打开对话框的“添加连接”Tab；
  - `panel.remoteManage`：打开对话框的“已有连接”Tab。
- 远端工作区列表沿用 `.mrfw-row` / `.mrfw-rootText` / `.mrfw-rootName` / `.mrfw-accessBadge` / `.mrfw-rootPath` / `.mrfw-note` 的附属根行结构；平台徽标使用实际系统名称。
- 列表保留登记/移除动作；控制面未 ready 时仍显示现有不可用说明。
- 不再内联渲染 `SshPersonalArea` 和 `SshCustodySection`。

### 对话框外壳

- 使用 `@deepseek-ai/dsh-client-ui-primitives` 的 `Modal`（复用遮罩、焦点、Escape、Portal）。
- Tab 条优先使用 `SegmentedTabs`；该导出在 0.1.7-alpha.1 才出现，因此通过 `maybeComponent` 探测，旧运行时降级为本地按钮式 tablist（仍保留 `role="tab"`、`aria-selected`、`aria-controls` 与方向键导航）。
- 每个 Tab 一个 `role="tabpanel"`，`aria-labelledby` 指向对应 tab。
- 对话框标题 `ssh.dialog.title`；关闭按钮/底部关闭动作复用 `panel.close`。
- 会话缺失、控制面未就绪、personal RPC 不可用时，各 Tab 显示可读说明而不是假装空列表。

### Tab 1：添加连接

- personal：
  - 顶部引导条说明连接保存在本机凭据根；
  - 编号步骤：连接目标（环境 ID、显示名、hostname、port、user、平台）→ 凭据（ssh-config 别名或托管凭据；无凭据时引导去 Key Tab）→ 远端目录与能力（workspace、exec/transfer）→ 主机密钥（扫描、指纹单选）；
  - 保存沿用现有 `sshEnvironmentSave` 线形、revision、token/fingerprint 语义；
  - 保存成功后清空草稿与扫描状态，并触发父面板刷新；端点仍需在列表显式登记。
- team：显示部署清单/broker 引导，不渲染个人表单，提供“打开模式设置”入口。
- hardened：显示加固部署引导，明确 GUI 只读，提供“打开模式设置”入口。
- 控制面未 ready：显示原因，不渲染表单。

### Tab 2：已有连接管理

- personal：
  - 链接横幅（managed 环境存在且 `linked === false`）；
  - 已保存环境行：名称/ID、实际平台名、helper 徽标、`user@host:port`、workspace、凭据来源、访问密钥；
  - 动作：测试连接、安装 helper、安装访问密钥（密码凭据）、编辑、行内确认删除；
  - 编辑表单复用“添加连接”的表单组件，保存沿用现有 revision 与秘密清理规则；
  - 本项目绑定区保留原有列表与新增表单（环境下拉、rootId、远端路径、动作、本地传输对端）。
- team/hardened：显示部署清单中的端点只读列表（名称、实际平台名、rootId、路径、登记状态），并说明在部署侧管理。

### Tab 3：SSH Key 管理

- personal：
  - 凭据列表（标签、类型、指纹、复制公钥、行内确认删除）；
  - 生成密钥 / 导入私钥 / 保存密码三个添加表单，秘密输入提交后立即清空且永不由状态回填；
  - 说明访问密钥随其环境显示，在“已有连接”中安装/查看。
- team/hardened：说明凭据由部署 broker 托管，GUI 不读取或创建凭据。

### Tab 4：模式设置

- 复用 `RemoteCustodyModeControl`：三档单选、team 四个字段、hardened 只读说明、降级风险确认；写入同一个 `multi-root-remote-tools` form 和 CAS revision。
- 增加“档位如何影响添加连接”的说明：personal → 图形化表单；team → 部署清单 + broker；hardened → 部署 profile + 全量证明。
- 宿主未提供配置 form 时显示说明，不渲染无法写入的控件。

### 平台显示

新增 locale 映射：

- `ssh.platform.linux` = `Linux`；
- `ssh.platform.darwin` = `macOS`；
- 未知平台保留原字符串。

所有平台徽标、下拉选项、连接测试结果统一经 `platformLabel()` 渲染。

### 状态与刷新

- 对话框在 personal 且拿到 `sessionId` 时读取一次 `sshState`；每次 mutation 采纳返回的完整 `SshStateView`。
- `personal-config-conflict` 先重取 `sshState` 再显示本地化错误。
- mutation 成功后调用父级 `onChanged()`，让 Workspace Folders 的 `remotes.list` 重新读取；档位变化也经现有 `remoteMode.subscribe` 触发父级刷新。
- 会话切换时重新加载；过期应答不得覆盖新会话。
- dialog 关闭后不再渲染任何管理状态。

## Implementation

### Phase 1：入口与外壳

修改内容：

- `src/client/WorkspaceFoldersAction.tsx`：删除内联 `SshPersonalArea`/`SshCustodySection`，加入远端工作区列表 + 新增/管理入口 + 对话框状态。
- 新建 `src/client/ssh-panel.tsx` 的 `SshManagementDialog` 外壳、Tab 导航、Modal、无障碍结构。
- `src/client/locales.ts`：增加对话框/入口/平台/Tab/引导文案；`src/client/styles.ts`：对话框、Tab、引导卡样式。
- 更新远端区块现有 DOM 测试。

退出验收标准：

- 打开 Workspace Folders 后远端区块只出现列表与两枚入口按钮，不再出现内联凭据/环境/档位控件。
- 点击新增/管理分别打开同一对话框的“添加连接”/“已有连接”Tab。
- 对话框可用 Escape/关闭按钮关闭，焦点不泄漏到背景；四个 Tab 均可键盘切换。
- 旧运行时（无 `SegmentedTabs`）通过 compat fallback 仍能渲染 tablist。

### Phase 2：个人模式管理迁移

修改内容：

- 把 `SshPersonalArea` 的链接横幅、凭据、环境、绑定逻辑迁移进对话框的对应 Tab。
- 抽出共享的 `EnvironmentForm`（新增/编辑复用）与 mutation helper。
- 保留秘密清理、keyscan token、CAS 冲突重取、行内删除确认。
- `onChanged` 接线到父面板 `refreshRemotes`。

退出验收标准：

- 个人模式下现有 13 个管理行为全部有测试覆盖并在新对话框内通过。
- 秘密字节不出现在 DOM 或状态回填中；提交后输入框清空。
- 保存/删除/测试/helper/access key/绑定都携带当前 revision，成功后父面板重新读取远端列表。

### Phase 3：模式感知引导

修改内容：

- 添加连接 Tab 按 `custodyMode` 分支：personal 表单、team/hardened 部署引导。
- 已有连接/Key Tab 在 team/hardened 显示只读说明和部署端点列表（已有/连接）。
- 模式设置 Tab 加入档位对添加流程的说明。
- 平台显示映射接入所有平台出现点。

退出验收标准：

- personal 下显示表单；team/hardened 下不显示表单且显示对应引导，也不会调用 `sshState`。
- 模式切换后添加 Tab 的引导立即跟随父面板的新 `custodyMode`。
- 平台下拉/徽标/连接测试结果分别显示 Linux 与 macOS，不直接显示 `linux`/`darwin`。

### Phase 4：回归、文档与交付

修改内容：

- 更新 `tests/client-ssh-panel.spec.tsx`、`tests/client-panel.spec.tsx` 相关用例；新增模式引导/入口/平台显示用例。
- 更新 `docs/reference/ssh-remote-environments.md` GUI 节、README 双语 SSH 段、路线图进度账本与 AGENTS.md 的 Issue #32 段落。
- 本计划在完成后移入 `docs/plans/completed/` 并补记验证证据。

退出验收标准：

- `pnpm lint`、`pnpm typecheck`、`pnpm build`、`pnpm docs:check`、`pnpm compat:check`、`pnpm pack:check` 全部通过。
- 全量 `pnpm test` 通过；新增/修改的 client 用例在无真实 Host 的 jsdom 环境中稳定。
- 本地 `pnpm verify:all`（或其中适用于本机的完整门禁）通过；不适合本机运行的平台用例按既有约定跳过并在结果中标注。
- 提交后推送分支并手动触发 CI，检查工作流通过。

## Validation

| 检查 | 命令 | 通过标准 |
| --- | --- | --- |
| 兼容契约 | `pnpm compat:check` | allowlist/peers/dev pin 一致 |
| Lint | `pnpm lint` | 0 warning |
| 类型 | `pnpm typecheck` | host + client 两套 tsconfig 通过 |
| 构建 | `pnpm build` | 类型与 bundle 成功 |
| 文档 | `pnpm docs:check` | 0 error / 0 warning |
| 单元与 DOM | `pnpm test` | 0 failed |
| 打包 | `pnpm pack:check` | 入口成员与静态导入规则通过 |
| 冒烟 | `pnpm smoke` / `pnpm smoke:packed` | 组合、行为、旅程、打包安装通过 |
| CI | `gh workflow run ci.yml --ref feat/ssh-workspace` | 触发的 run 所有 job success |

## Risks

- **旧运行时缺少 `SegmentedTabs`**：通过 `maybeComponent` 探测并降级；不得静态导入新导出。
- **嵌套 Modal 的焦点与 Escape**：内层 `Modal` 自己注册 modal layer；外层自绘对话框的键盘处理不拦截内层事件；测试覆盖 Escape/关闭。
- **功能回归**：迁移时逐项对照现有 `SshPersonalArea` 行为，保留全部 mutation 与错误路径。
- **状态过期**：会话切换时清空旧 view 并忽略过期应答；mutation 的应答仍以完整 `SshStateView` 为准。
- **文案漂移**：zh/en 同步新增键，`docs:check` 与 locale 测试兜底。
- **列表刷新**：对话框不直接调用 `remotes.list`，只通过父级 `onChanged` 刷新，避免两个数据源。

## Documentation Impact

- 本计划：`docs/plans/completed/2026-11-13-ssh-management-dialog.md`。
- 参考：`docs/reference/ssh-remote-environments.md` 的“GUI 管理面板（个人模式）”整节。
- 用户入口：`README.md` / `README.en.md` 的 SSH 远端环境段。
- 进度账本：`docs/plans/active/2026-09-12-multi-root-workspace.md` 增加本轮小节。
- Agent 说明：`AGENTS.md` Issue #32 段落中 GUI 组件文件与入口描述。

## Completion Criteria

1. Workspace Folders 远端区块只保留远端工作区列表与新增/管理入口。
2. 新 SSH 管理对话框含四个 Tab，且每个 Tab 的目标内容按本计划落地。
3. personal 下全部原有管理能力可用；team/hardened 下显示模式对应的引导与只读信息，不创建凭据或连接。
4. 平台在 GUI 中显示为 Linux / macOS。
5. 模式设置仍写入同一个 settings form，不新增写入路径。
6. 所有静态检查、单元/DOM 测试、docs check 和适用的 smoke 通过。
7. 分支已提交、推送，手动触发的 CI 通过。

## Verification（2026-11-13，本机 macOS arm64 / Node 24.18.0 / DSH 0.2.2-rc.2）

| 检查 | 结果 |
| --- | --- |
| `pnpm lint` | 0 warning / 0 error |
| `pnpm typecheck` | host + client 通过 |
| `pnpm build` | 类型与 bundle 通过（client 615.05 kB） |
| `pnpm docs:check` | 0 error / 0 warning |
| `pnpm compat:check` | allowlist / peers / dev pin / installed tree 一致 |
| `pnpm pack:check` | 254 members，静态 SSH 导入规则通过 |
| `pnpm kernel:probe` | 通过；本会话无可用 kernel runner，断言按既有机制 skip |
| `pnpm smoke` | compose 58 passed；behavior 96 passed / 8 skipped；journey 85 passed / 2 skipped |
| `pnpm smoke:packed` | 通过（scratch profile 安装、build-approval 恢复、behavior 95 passed / 8 skipped） |
| `pnpm auto-review:fork` / `pnpm smoke:auto-review` | 通过（可选集成目标按既有版本条件 skip） |
| 特性相关 spec | client-ssh-panel 23、client-panel 82、client-ops-settings 35、client-styles 22、locale-parity 6；共 168 passed |
| 全量 `pnpm test` | 1570 passed / 201 skipped / 0 failed（排除本会话无法运行共享 Registry IPC 的 10 个既有 authority 文件）；完整套件的未过滤运行中，这 10 个文件因“Host itself is sandboxed; shared IPC refuses sandboxed peers”失败，属执行环境限制，由干净 runner 上的 CI 覆盖 |
| CI（手动触发） | [run 43447653166](https://github.com/cherrchen/dsh-plugin-multi-root-workspace/actions/runs/43447653166) @ `be5a489`：**26/26 jobs success，0 failed**；抽查 `0.2.1-rc.2` / ubuntu-latest 产物为 **1875 passed / 156 skipped**（含 `client-ssh-panel.spec` 23 passed） |

本会话运行在 DSH Agent 文件沙箱内，`registry IPC refuses a different user or sandboxed peer` 是仓库既有的 fail-closed 设计；过滤运行明确保留了所有与本改动相关的 client、locale、style、build、smoke 与打包用例。
