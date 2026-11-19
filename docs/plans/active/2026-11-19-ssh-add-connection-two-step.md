# SSH「添加连接」两步式重构

> 状态：**已实施（2026-11-19）**；自动门禁通过，GUI 手工验收待维护者。共享 Registry follower 相关测试在本机 DSH sandbox 下失败（基线 HEAD 同样失败），见 §7.4。
> 本文是本轮 UI 重构的实施计划与退出验收清单；Host 侧运行事实仍以 [SSH 远端环境参考](../../reference/ssh-remote-environments.md) 和 [ADR-0049](../../decisions/ADR-0049-ssh-custody-modes.md) 为准。

## 1. 目标

把 SSH「添加连接」从**四步向导**缩短为**两步向导**，并把该流程从管理对话框的 Tab 抽成独立 Dialog；管理对话框收敛为三个 Tab（已有连接 / SSH Key / 模式设置），卡片式表单结构保持不变：

1. **连接**：选择凭据来源（本机 SSH 条目 / 插件托管凭据）→ 填写显示名、环境 ID、平台与 `user@host:port` → 点「扫描并测试连接」→ 在确认 Dialog 中确认主机密钥 → 自动保存并进入下一步。
2. **安装 Helper 并登记远端路径**：顶部保留 `user@host:port` 摘要与 Helper 操作（检测 Node / 安装 Helper / 测试连接 / 当前状态）；选择远端路径（输入器 + UI 路径选择器）；选择路径能力（文件传输 / 命令执行，命令执行在未安装 Helper 时禁用）；底部「跳过」「上一步」「绑定到本项目」。

目标是把“环境信息、凭据、主机钥、Helper、路径、绑定”收敛成两次明确决策，同时不改变 Host 侧的准入、CAS、凭据保管与绑定语义。

## 2. 背景与现状

- 当前 `src/client/ssh-panel.tsx` 的 `EnvironmentWizard` 有四个步骤：`info` → `key` → `helper` → `register`；环境保存发生在第 2 步，第 3/4 步对已保存环境做可选收尾。
- 第 1 步同时收集环境 ID、显示名、平台、workspace 与 exec/transfer 能力；第 2 步选择凭据并扫描主机钥。这与手绘图“环境信息不做远端工作目录和能力权限的登记”的意图相反：路径与能力应后移到第 2 步。
- 凭据来源当前是 radio/segmented，主机别名是自由文本；手绘图要求两个下拉选择器，并在选择“插件托管凭据”时出现「管理凭据」入口与凭据管理 Dialog。
- 主机钥确认当前是表单内的 radio 列表；手绘图要求扫描后弹出确认 Dialog，确认后自动进入下一步。
- 第 2 步需要“UI 选择”远端路径。个人模式环境已有 SFTP 连接实现（`src/remote/sftp.ts`）和托管 `ssh_config`，但没有暴露给面板的目录列举端点。
- 管理对话框保留 `Modal` + `SegmentedTabs` + `.mrfw-sshForm` 卡片结构，但收敛为三个 Tab（已有连接 / SSH Key / 模式设置）；「添加连接」改为从“已有连接”打开的独立 Dialog。

## 3. 范围

### 3.1 本轮做

- `SshManagementDialog` 收敛为三个 Tab；新增独立 `Modal` 承载 `AddConnectionWizard`，步骤指示器、校验、取消/重置、异步作用域隔离全部保留。
- 第 1 步改为“凭据来源下拉 + 对应选择器 + 显示名 / 环境 ID / 平台 + 目标行”；环境 ID 可按显示名自动生成，用户手动修改后停止联动。
- 主机钥扫描后弹出确认 Dialog；确认后保存环境并自动进入第 2 步。
- 新增「管理凭据」嵌套 Dialog，复用 SSH Key Tab 的凭据 CRUD（生成 / 导入 / 密码 / 删除）。
- 第 2 步承载 Helper 操作、远端路径输入与 UI 路径选择器、能力复选框，以及「绑定到本项目」（保存环境更新 → 保存到 primary 的绑定 → 在需要且可行时登记）。
- 新增两个只读 personal RPC：`sshConfigAliases`（本机 `~/.ssh/config` 的 Host 别名）与 `sshListDirectories`（经 SFTP 列远端目录）；两者都只读、只返回名称/路径，不返回文件内容或密钥。
- 八语言文案、样式、单元/交互测试与文档同步。

### 3.2 非目标

- 不改变绑定、准入、Registry、remote-1 或 `remote_copy`/`remote_bash` 的授权语义。
- 不新增“环境草稿”持久化格式；环境仍以 `sshEnvironmentSave` 落盘。第 1 步保存时使用 `/` 作为占位 workspace（第 2 步选中路径后立即覆盖）；跳过第 2 步时连接仍可用，只是没有项目绑定。
- 不把“链接 `~/.ssh/config`”重新做成独立步骤；只在第 2 步状态区保留一次性链接动作与提示。
- 不改变 team/hardened 档位的引导与只读形态。
- 不启用模型远端入口，不修改默认关闭的开关。

## 4. 用户动线与页面设计

### 4.1 第 1 步：连接

卡片结构：顶部步骤条（2 个 chip）→ 错误汇总区 → 「凭据」卡片 → 「远程主机」卡片 → 底部导航。

```text
[1. 连接]  →  [2. Helper 与远端路径]

凭据    [凭据来源 ▾]   [托管凭据 ▾]   [管理凭据]
主机    [显示名]       [环境 ID]       [平台 ▾]
        [user] @ [host] : [port]

                                      [扫描并测试连接 →]
```

- 布局：凭据来源、凭据选择与「管理凭据」同一行；显示名、环境 ID、平台同一行；窄屏回退为单列。
- 凭据来源为 `<select>`（`ssh.field.credentialSource`）：选项为 `ssh.field.alias`（本机 SSH 主机别名）与 `ssh.field.managed`（托管凭据）。
- 本机来源：别名输入使用 `<input list>` + 来自 `sshConfigAliases` 的 `<datalist>`，仍允许手输；别名不显示 user/host/port 字段，扫描时由 `ssh -G` 回填并展示解析结果。
- 托管来源：托管凭据下拉 + 「管理凭据」按钮；无凭据时显示空态与创建引导。点击「管理凭据」打开嵌套 Dialog，关闭后回到当前草稿。
- 环境 ID：未手动修改且非编辑态时，从显示名（为空时从别名）生成 slug；用户修改环境 ID 后停止自动同步。编辑已保存环境时 ID 只读。
- 「扫描并测试连接」：先做同一套前端校验，再调用 `sshHostKeyScan`；结果通过确认 Dialog 展示，不在表单内展开 radio。
- 主机钥确认 Dialog：标题「确认主机密钥」；显示目标 `user@host:port`（别名流显示解析后的目标）与候选指纹；「取消」只关闭 Dialog，「确认并继续」保存环境（`sshEnvironmentSave`）并进入第 2 步。保存失败时关闭 Dialog 并在对话框顶部显示本地化错误。

### 4.2 第 2 步：Helper 与远端路径

```text
[1. 连接]  →  [2. Helper 与远端路径]   （当前步骤）

Production · env-prod   [Linux]   deploy@prod.internal:22
[Helper 未安装]  [未链接 ~/.ssh/config]

Helper
[检测 Node] [安装 Helper] [测试连接]     当前状态：[Helper 未安装]
远端 node 路径：[________________]

远端路径
[________________________]  [UI 选择]
选择路径能力
[ ] 文件传输    [ ] 命令执行（未安装 Helper 时禁用）

[跳过]                          [上一步]  [绑定到本项目 →]
```

- 摘要行只读，来自已保存环境；如果第 1 步重新保存，摘要随之刷新。
- Helper：`检测 Node` 调 `sshEnvironmentTest` 并把返回的 node 路径回填；`安装 Helper` 调 `sshHelperInstall`；`测试连接` 再跑一次 `sshEnvironmentTest` 并显示结果；「当前状态」用 `Tag` 显示 helper 已装/未装，并附最近一次测试结果。
- 托管凭据且 `view.linked === false` 时，状态区显示 `ssh.linkBanner` 与「链接到 ~/.ssh/config」按钮；不占用独立步骤。
- 远端路径：输入器做 `checkRemotePath` 同规则的前端校验；「UI 选择」打开路径选择器 Dialog。选择器经 `sshListDirectories` 列目录，支持上一级、手动输入路径后跳转、点击目录进入；列目录失败时保留手动输入并显示错误，不阻塞绑定。
- 能力：`文件传输` 写环境 `transfer` 节；`命令执行` 写环境 `exec` 节，且仅在 helper 已安装且目标身份未变时可用（沿用 `exec-requires-helper`）。
- 「绑定到本项目」：保存环境（workspace + 两个能力）→ 保存 `rootId: 'primary'` 的绑定（actions 至少 `read`/`write`，执行开启时加 `exec`）→ helper 已装且 `remotes` 可用时调用 `remotes.add` 登记。成功后切到「已有连接」并显示保存提示；登记失败只显示错误，不撤销已保存的绑定。
- 「跳过」：保存当前可保存的路径/能力（路径非法则不更新 workspace），切到「已有连接」；连接保留，就绪链路继续显示未完成的 Helper/链接/绑定。
- 「上一步」：回到第 1 步，保留所有草稿与已保存环境；再次扫描保存时使用当前路径（若已填写）而不是覆盖回占位 `/`。

## 5. 技术设计

### 5.1 组件拆分

- `EnvironmentForm` 只保留给「已有连接」的平铺编辑器（仍显示全部字段；凭据来源改为下拉）。
- 新增 `ConnectStepForm`：第 1 步的凭据/环境/主机字段。
- 新增 `DetailsStepForm`：第 2 步的 Helper、路径、能力与绑定动作。
- 新增 `HostKeyConfirmDialog`、`CredentialManagerDialog`、`RemotePathDialog`，全部由 ui-primitives `Modal` 承载；嵌套 Modal 的 Escape/Tab 由 primitives 的 modal layer 栈处理。
- `EnvironmentWizard` 改为 `AddConnectionWizard`：`AddStep = 'connect' | 'details'`，沿用现有 `attempted` 校验标记、`savedId`、异步 `scope` 隔离与 secret 清理。

### 5.2 状态与保存顺序

- 草稿沿用 `EditorDraft`；第 1 步的 `workspace` 仅作为内部占位，不渲染。
- 第 1 步保存：`workspace = draft.workspace`（若已是合法远端路径）否则 `existing?.workspace ?? '/'`；不携带 `exec`/`transfer`（除非原有环境且目标未变，保留已有能力）。
- 第 2 步保存：提交 `workspace` + `exec`/`transfer`；随后 `sshBindingSave`；最后按条件 `remotes.add`。
- `submit` 改为可返回刷新后的 `SshStateView`（内部 `submitState`），以便进入第 2 步时拿到刚保存的环境行；所有旧调用点保持布尔语义。

### 5.3 新增只读 RPC

`src/remote/personal-contract.ts`：

- `sshConfigAliases`：`{ sessionId }` → `{ aliases: string[] }`；读取 `~/.ssh/config` 的 `Host` 行，跳过通配/否定/重复项。读取失败返回空数组。
- `sshListDirectories`：`{ sessionId, environmentId, path? }` → `{ path, parent, entries: [{ name, path }] }`；通过个人环境的 SFTP 连接列目录，只返回目录项，最多 500 条，按名称排序。SFTP 错误统一映射为 `remote-path-listing-failed`（带 Host 原文），不暴露文件内容。

`src/remote/sftp.ts`：`SftpClient.connect` 增加可选的 `configFile`（managed 环境传 `<credentialRoot>/ssh_config`，因此无需先链接 `~/.ssh/config` 也能浏览），其余强制参数不变。

`src/remote/personal/remote-paths.ts`：`listRemoteDirectories`，15 秒上限，`realpath` 后 `readdir`，只保留目录；`dispose` 走 `finally`。

### 5.4 文案、样式与兼容

- 新增/改写八语言键；保持 `tests/locale-parity.spec.ts` 的占位符与“非英语不得照抄英语”约束。
- 样式继续使用 `mrfw-` 前缀与 `var(--dsw-*)` token；新增步骤条、摘要卡、路径行、目录列表、嵌套 Dialog 的必要规则；窄屏沿用现有单列回退。
- 旧运行时：`Modal`、`Input`、`Button`、`Tag` 均已在支持矩阵内；不新增 primitives 依赖。

## 6. 实施步骤

1. **Host 只读接口**：`sshConfigAliases`、`sshListDirectories`、`SftpClient.configFile`、`remote-paths.ts`、契约 schema 与错误码。
2. **客户端契约**：`ssh-client.ts` 增加 `aliases` / `listDirectories`；`personal-contract` 答案解析。
3. **凭据管理抽取**：把 Keys Tab 的列表/新增表单抽成 `CredentialsPanel`，Keys Tab 与嵌套 Dialog 共用；秘密输入仍即时清空。
4. **两步向导**：`ConnectStepForm`、`HostKeyConfirmDialog`、`DetailsStepForm`、`RemotePathDialog`，重写 `AddConnectionWizard` 的步骤状态与保存顺序。
5. **编辑路径**：平铺 `EnvironmentForm` 改用凭据来源下拉，保留 workspace/能力字段与原有扫描/保存行为。
6. **文案与样式**：八语言字典、`styles.ts`。
7. **测试**：重写 `tests/client-ssh-panel.spec.tsx` 的 Add 流程；新增别名解析与目录项过滤的 Host 单测；保留既有 Connections/Keys/Mode/异步隔离测试。
8. **文档与门禁**：更新 `docs/reference/ssh-remote-environments.md` 的 RPC 清单与 GUI 章节；本计划完成后移到 `docs/plans/completed/`；运行 lint/typecheck/test/build/docs:check/pack:check。

## 7. 退出验收

### 7.1 自动化

- [x] `pnpm exec vitest run tests/client-ssh-panel.spec.tsx` 全绿，且新增用例覆盖：两步步骤条、自动环境 ID、凭据来源切换、主机钥确认 Dialog 的取消/确认、路径选择器成功与失败回退、能力开关、绑定到本项目、跳过。
- [x] `pnpm exec vitest run tests/locale-parity.spec.ts tests/remote-personal.spec.ts tests/remote-sftp.spec.ts` 全绿。
- [x] `pnpm typecheck` 通过。
- [x] `pnpm lint` 通过。
- [x] `pnpm build` 通过。
- [x] `pnpm docs:check` 通过。
- [x] `pnpm compat:check`、`pnpm pack:check` 通过（新增源码不得引入静态 SSH 可选包导入）。

### 7.2 手工验收（GUI）

> 手工验收前先 `pnpm build` 并重启/重新加载 DSH Host。仅刷新页面只会更新 client bundle；旧 Host 不认识 `sshConfigAliases` / `sshListDirectories`，且第 2 步的身份未变更新仍会因缺扫描 token 被拒。

- [ ] 管理对话框只有“已有连接 / SSH Key / 模式设置”三个 Tab；「添加连接」是独立 Dialog，由“已有连接”Tab 的按钮打开。
- [ ] 添加 Dialog 只有两个步骤 chip；第 1 步不出现 workspace、文件传输、命令执行字段；关闭后草稿丢弃、已保存连接保留。
- [ ] 显示名输入后环境 ID 自动生成；手动改 ID 后不再联动；编辑已保存环境时 ID 不可改。
- [ ] 托管凭据来源显示凭据下拉与「管理凭据」；点击打开凭据管理 Dialog，新建密钥后关闭，凭据选择器可见新条目。
- [ ] 本机条目来源显示别名输入；输入别名、扫描后确认 Dialog 显示解析后的 `user@host:port`，确认后进入第 2 步。
- [ ] 扫描确认 Dialog 点「取消」不保存、不前进；点「确认并继续」只保存一次并进入第 2 步。
- [ ] 第 2 步摘要正确；检测 Node、安装 Helper、测试连接、当前状态均有可见反馈。
- [ ] 「UI 选择」能列出远端目录、进入子目录、上一级、使用当前目录并回填；SFTP 失败时显示错误且仍可手输路径并绑定。
- [ ] 未安装 Helper 时「命令执行」禁用并显示原因；安装后可用。
- [ ] 「绑定到本项目」后切到「已有连接」，环境、绑定、登记状态（可行时）与预期一致。
- [ ] 「跳过」后连接保留，就绪链路显示未完成项；「上一步」返回后草稿与路径不丢失。
- [ ] 对话框宽度、滚动、嵌套 Dialog 的焦点与 Escape 行为正常；窄窗口无横向溢出。

### 7.3 文档

- [x] [SSH 远端环境参考](../../reference/ssh-remote-environments.md) 的 RPC 清单与 GUI 章节反映两步式流程和新端点。
- [ ] GUI 验收通过后，本计划移到 `docs/plans/completed/`；未发布分支不写 CHANGELOG。
- [x] `pnpm docs:check` 通过。

### 7.4 执行记录（2026-11-19）

- `pnpm exec vitest run tests/client-ssh-panel.spec.tsx`：54 passed（含凭据行/主机行布局断言）。
- `pnpm exec vitest run tests/locale-parity.spec.ts tests/remote-personal.spec.ts tests/remote-sftp.spec.ts`：45 passed。
- `tests/remote-personal-ops.spec.ts -t 'reuses the recorded host key'`：1 passed（身份未变时复用记录指纹；换目标或换指纹仍要求扫描 token）。
- `pnpm lint`、`pnpm typecheck`、`pnpm build`、`pnpm docs:check`、`pnpm compat:check`、`pnpm pack:check`：通过。
- 全量 `pnpm test`：20 个失败全部落在共享 Registry 的 follower/IPC 用例（`registry-*`、`authority-boundaries`、`skills-authority`、`remote-exec` 等），错误为 `contended` 而非 `follower`；排除这些文件后为 128 files / 2211 passed / 210 skipped，仍有 2 项 `authority-boundaries` 同类失败。同一失败在基线 HEAD 的 `tests/registry-lease.spec.ts` 上复现，且测试自身打印 “shared IPC refuses sandboxed peers”，属本机 DSH sandbox 的环境限制，不是本轮改动。
- 未执行：GUI 手工验收（§7.2）需要维护者在真实对话框中逐项走查。

## 8. 风险与回滚

| 风险 | 缓解 |
| --- | --- |
| 第 1 步先保存、第 2 步再更新，用户中途关闭会留下占位 `/` workspace | 第 2 步「跳过」尽量保存用户已填写的合法路径；连接行仍以绑定路径为准；文档说明该占位语义 |
| 托管环境未链接 `~/.ssh/config` 时 SFTP 目录列举失败 | SFTP 显式 `-F <credentialRoot>/ssh_config`；失败时降级为手动输入，并保留第 2 步的链接按钮 |
| 嵌套 Modal 抢焦点/Escape | 使用 ui-primitives `Modal` 的 modal layer 栈；不自行实现焦点陷阱 |
| 新增 RPC 扩大攻击面 | 只读、仅 personal 模式、仅返回目录名/路径；不返回文件内容、不返回密钥；沿用 sessionId 派生主根与既有拒绝码 |
| 文案/八语言漂移 | 一次改齐 `src/client/locales/*.ts`，跑 parity 测试 |
| 旧测试大量依赖四步向导 | 只改 Add 流程相关用例；Connections/Keys/Mode/异步隔离用例保持行为断言 |

回滚：本轮只涉及客户端 Add Dialog、两个只读 RPC 与文档；回滚时恢复 `ssh-panel.tsx` 的向导与 `personal-contract` 的两个端点即可，不改已有持久化格式。

## 9. 文档影响

- 更新 `docs/reference/ssh-remote-environments.md`：RPC 端点表、GUI 管理面板章节的添加连接流程。
- 本计划文件在完成后移入 `docs/plans/completed/`。
- `docs/plans/active/2026-09-12-multi-root-workspace.md` 若有本轮进度条目，按其既有格式登记（仅一条链接，避免复制本文）。

## 10. 2026-11-19 追加：三 Tab 与独立「添加连接」Dialog

- 管理对话框只保留“已有连接 / SSH Key / 模式设置”三个 Tab；`SshDialogTab` 去掉 `add`，Tab 条不再渲染“添加连接”。
- “添加连接”成为管理对话框之上的独立 `Modal`（`.mrfw-sshAddDialog`），入口是“已有连接”Tab 内的按钮；Workspace Folders 远端区块只保留“管理 SSH 远端…”，模式页的引导按钮改为切到“已有连接”。
- 关闭添加 Dialog 会丢弃草稿，但第 1 步已保存的连接保留；会话或托管档位切换会同时关闭该 Dialog。
- 自动化：`tests/client-ssh-panel.spec.tsx` 56 passed（新增三 Tab、入口、关闭丢弃草稿、模式页跳转用例）；`tests/client-styles.spec.ts` 覆盖 `.mrfw-sshAddDialog` 宽度。
