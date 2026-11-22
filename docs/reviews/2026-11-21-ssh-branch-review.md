# SSH 分支增量审查（2026-11-21）

## 范围与结论

审查分支 `feat/ssh-workspace`，被审提交 `0574ef6`。范围是[上次审查](./2026-11-15-ssh-branch-review.md)（被审树 `b4027dc`）之后分支自身的 37 个非合并提交，包括 R1–R10/C1 修复、SSH helper 包根解析与安装失败链、添加连接向导的几轮重构、目录浏览端点与已记录主机密钥复用、连接与 Workspace Root 绑定拆分（personal 存储 v2）、Root 范围 Helper、插件详情 SSH 设置通道、面板 UI（共享行、请求反馈、Toast 报错、图标按钮）以及八语言文案。两次合并 main（`9477b28`、`d93eb2b`）只检查冲突解决，不复审 main 带入的内容。

**结论：需要修改。** 确认 4 项 P2、7 项 P3，未发现 P0/P1。F1 是门禁失败；F2–F5 各有针对性复现用例；其余为代码路径分析，文中标明。R1–R10 与 C1 的修复逐项核对，与上次记录一致，但 R4 的终止条件过宽，见 F3。

## 确认问题

### F1 · P2 · `pnpm lint` 失败，CI 的 lint 步骤会失败

位置：[ssh-panel.tsx](../../src/client/ssh-panel.tsx) 第 9 行的 `errorKeyOf`，[WorkspaceFoldersAction.tsx](../../src/client/WorkspaceFoldersAction.tsx) 第 46 行的 `errorHasDetail`、`errorKeyOf`。`0036419` 把内联错误改为 Toast 后，这三个导入不再使用，oxlint 报 3 个 `no-unused-vars` 错误。`.github/workflows/ci.yml` 会运行 `pnpm lint`。最新 4 个提交尚未推送，CI 还没有运行到它们。删除这三个导入即可。

### F2 · P2 · 旧运行时上，任意面板错误都会让 Workspace Folders 面板崩溃

位置：[error-toast.tsx](../../src/client/error-toast.tsx) 第 2、45 行。组件静态导入 `IconWarningOutlineRegular`，并把它作为 `Toast` 的 icon。核对 npm 上的 `@deepseek-ai/dsh-client-ui-primitives`：`0.1.5-rc.2` 与 `0.1.6-alpha.2` 都在 `SUPPORTED_DSH_RELEASES` 内，只导出 `IconWarningOutline16`，没有 Regular 名；它们的 `Toast` 存在，并会把 `icon` 渲染进一个 span。客户端产物用 CJS `require` 读取 primitives，缺失的名字只是 `undefined`，渲染 `<undefined />` 时 React 抛出 “Element type is invalid”。

`0036419` 之后，根列表错误、`view.unavailable`、远端区错误、SSH 管理对话框、绑定对话框与托管模式控件都经过这个组件。这些运行时上一旦出错，面板就整块崩溃；原来的内联 alert 可以正常显示。测试用的 primitives 桩导出了这个名字，所以现有测试发现不了。main 的 `skills-settings.tsx` 已有同样的静态导入，本轮把它带进了所有支持版本都会渲染的核心面板。

复现：R-C。修复：通过 [client-icons.ts](../../src/compat/client-icons.ts) 的 `maybeIcon(['IconWarningOutline16', 'IconWarningOutlineRegular'])` 取图标，取不到时不传 icon。`skills-settings.tsx` 的同类导入一并改掉，并用缺少 Regular 名的桩加一条回归。

### F3 · P2 · 任何远端授权写入都会终止所有在飞的 `remote_bash`

位置：[exec.ts](../../src/remote/exec.ts) 第 220–236 行的 `checkGrant`（R4 修复引入）；[plane.ts](../../src/remote/plane.ts) 第 64、163、271 行。`RemoteControlPlane.revision` 是整个 plane 的单一计数：任何 primary 的 grant 写入（`commitAdd`、`remove`）都会递增它，`admit()` 把它写进操作身份。`checkGrant` 只要发现 revision 与启动时不同，就 `terminateOnce('revoked')`。

后果是：在同一项目登记另一个远端目录，或在另一个项目（共享 Registry 时也包括其他 Host 上的项目）登记或移除任何远端目录，都会以 `revoked` 终止一条自身授权从未变化的命令。参考文档写的是“revision 变化保守终止该存储上的在飞命令”，但这个存储由所有项目共享。防止“同一授权 remove+re-add 后复活”并不需要这么大的范围。

复现：R-A 两例。同一 primary 与不同 primary 下，terminate 都被调用 1 次，结果为 `termination: 'revoked'`；随后同一端点的新命令正常运行，说明这条命令自己的授权没有变化。修复建议：比较该命令自己的 grant 身份（例如 grant 的 `addedAt` 或一个 grant incarnation，再加上 `bindingDigest`），或者按 primary 维护 revision；remove+re-add 通过 grant 身份变化识别。

### F4 · P2 · “添加连接”会静默覆盖同 ID 的已有连接

位置：[personal-endpoints.ts](../../src/remote/personal-endpoints.ts) 第 199–277 行的 `sshEnvironmentSave`；[ssh-panel.tsx](../../src/client/ssh-panel.tsx) 的 `AddConnectionForm` 与 `saveEnvironment`。Host 不区分新建与更新，按 `environmentId` 过滤后直接追加。添加向导按显示名自动生成 ID，不检查 ID 是否已存在。两个都叫 “Production” 的连接会得到同一个 ID `production`，第二次添加会造成三个后果：

- 第一条连接的目标与凭据被替换。
- 该 ID 下的所有 Workspace 绑定保留，转而指向新主机。环境变化会让已登记授权变为 withheld；用户重新登记后，同样的路径就作用在另一台机器上。
- 原访问密钥（`purpose: 'access-key'`，`environmentId` 仍是该 ID）成为孤儿，并显示在新连接下。

复现：R-B。修复建议：保存请求显式区分新建与更新，例如新建时 ID 已存在就返回 `environment-exists`；客户端在添加时对已存在的 ID 给出校验提示，或自动加后缀。

### F5 · P3 · 编辑连接必须重新扫描主机密钥，Host 的“复用已记录指纹”路径在 UI 中不可达

位置：[ssh-panel.tsx](../../src/client/ssh-panel.tsx) 第 359–365 行与第 1404–1451 行。打开编辑时执行 `setFingerprint(undefined)`，而 `canSave` 要求 fingerprint 已定义，所以只改显示名或执行/传输开关也得先扫描。托管凭据会因此再次触网，并改写插件的 known_hosts。`ed4c236` 为两步向导加入的身份不变复用例外（ADR-0049 的 2026-11-19 修订、参考文档中 `sshEnvironmentSave` 的说明），在 11-20 拆分后已经没有调用方。

复现：R-D。建议：编辑时用 `existing.hostKey` 预填 fingerprint，身份字段变化后再要求扫描；或者删除 Host 侧例外与文档说明，不保留无人使用的放宽路径。

### F6 · P3 · 一次传输取消或超时，会断开同一环境上的其他并发传输

位置：[transfer.ts](../../src/remote/transfer.ts) 的 `TransferIO.clients`（`onInterrupt` 调用 `target.dispose()`）与 `openSftpEndpoint`；[ssh-environment.ts](../../src/remote/ssh-environment.ts) 的 `openSftp` 与 `openSftpFresh`。SFTP 会话按 `environmentId` 缓存共享，被中断的传输 dispose 的却是这个共享 client。`openSftpFresh` 把第一个调用者的 signal 挂在共享 opening 上；中断发生在打开之后时，`openSftpEndpoint` 还会 dispose 刚取到的、可能被他人使用的会话。并发的 `remote_copy`（例如并行工具调用）会因此得到 unknown 或 residual。结果仍然如实报告为 unknown，不会静默损坏数据。

未复现，依据代码路径。建议：被中断的传输只废弃自己的待决请求，或者每次传输独占 SFTP 通道；opening 的取消至少要等所有等待者都取消后才生效。

### F7 · P3 · personal 配置的任何保存都会重挂工具子树，打断全部在飞远端操作（既有机制，本轮扩大了触发面）

位置：[config.ts](../../src/remote/personal/config.ts) 第 99 行，`configVersion: personal-${revision}` 进入清单摘要；[registry.ts](../../src/registry.ts) 第 1754–1776 行的 `refreshRemotePersonal` 调用 `notifyRemoteChange`；[tools.ts](../../src/remote/tools.ts) 第 155–161 行以摘要作为重挂载键，第 102 行在卸载时 `manager.disposeAll()`。

每次 personal 保存，即使只改显示名或在另一个 Workspace 增删绑定，都会改变摘要并触发子树卸载，关闭所有 Helper 与 SFTP 连接；owner 还会重新监听 remote-1，follower 重新连接。`b4027dc` 已有这一机制。11-20 起连接变为插件级、绑定按 Workspace 分存，于是一个项目里的绑定编辑会打断所有项目的远端命令与传输，结果为 unknown。

未复现，依据代码路径。建议：摘要不包含单调递增的 revision，或者只在受影响环境或绑定的摘要变化时 dispose 对应的 Helper，不要整树重挂。

### F8 · P3 · ssh-config 连接的目录浏览不核验已记录的身份

位置：[remote-paths.ts](../../src/remote/personal/remote-paths.ts) 的 `listRemoteDirectories`。浏览直接运行 `ssh -s <alias> sftp`，只依赖用户 known_hosts 与命令行强制的 `StrictHostKeyChecking=yes`，不像连接路径的 `verifyHostIdentity` 那样核对 `ssh -G` 账户与已记录指纹。用户修改别名指向后，选择器会列出另一台主机的目录。浏览只返回目录名，登记时还会再核验一次，所以风险低。托管连接通过 `-F <credentialRoot>/ssh_config` 固定了插件 known_hosts，不受影响。建议：浏览前复用现有身份解析，与已记录的值比较。

### F9 · P3 · 解绑没有确认；原样保存也会让授权变为 withheld

位置：[ssh-panel.tsx](../../src/client/ssh-panel.tsx) 的 `SshWorkspaceBindingsDialog`；[personal-endpoints.ts](../../src/remote/personal-endpoints.ts) 第 363 行。垃圾桶按钮直接调用 `sshBindingRemove`，已登记授权随即失效，而删除连接有二次确认。`sshBindingSave` 每次都生成新的 `bindingId`。绑定对话框的保存不判断是否有变化，原样保存也会让已登记授权变为 withheld、需要重新登记；“…”菜单的保存有变化判断，对话框没有。建议：解绑加确认；path、actions、transfers 都不变时，Host 保留原 `bindingId`，或客户端禁用保存。

### F10 · P3 · 语言一致性门禁的中性键对所有语言生效

位置：[locale-parity.spec.ts](../../tests/locale-parity.spec.ts)（`0f9918a`）。`ssh.tab.mode`、`ssh.field.port`、`remote.mode.team` 等加入了全局 neutral 集合，理由是“在选择它的语言里拼写相同”，但豁免对日语、中文、俄语等同样生效，这些语言漏译时门禁不再报警。建议按语言列出豁免。

### F11 · P3 · 可复制地址 `user@host:port/path` 与 scp 语法冲突

位置：Workspace Folders 远端行与绑定对话框。scp 和 rsync 会把 `user@host:22/srv/app` 解释为远端家目录下的相对路径 `22/srv/app`，用户粘贴到命令行会写错位置。参考文档明确采用了这个格式，因此只作为可用性提示。建议使用 `ssh://user@host:port/path`，或复制 `user@host:/path` 并单独显示端口。

## 修复核对（R1–R10、C1）

- R1：SFTP 子进程在命令行强制 `StrictHostKeyChecking=yes`、`ForwardAgent=no`、`UpdateHostKeys=no` 并关闭复用；新增的 `-F` 只用于托管配置。
- R2：OPEN 编码为 flags=4 加 permissions，未给权限时为 flags=0。
- R3：broker 客户端在即时与缓冲两条路径都把 `BROKER-LOST` 映射为 lost。
- R4：撤权通知、250ms 轮询和 1 秒复核超时都已到位，只终止一次，清理有界；终止条件过宽，见 F3。
- R5：总 I/O 预算覆盖准入、连接、每次 SFTP 请求与再准入，清理共享 1 秒预算；副作用见 F6。
- R6：cwd 先做前缀检查，再由 helper 只读探针验证，realpath 必须等于目标，符号链接被拒绝；不再依赖 transfer 配置。
- R7：`accessKeyId` 只在 credentialId、目标三元组与 hostKey 都不变时保留。
- R8：超限块保留前缀，截断时按 stream 方式解码。
- R9：路径按 ssh_config 规则引用与转义，拒绝换行和 NUL；`parseSshConfig` 只在字段完整匹配时保留托管 known_hosts 路径。
- R10：管理对话框用 scope 与请求世代隔离；绑定对话框用生命周期 AbortController。
- C1：exited 的拒绝提前挂接，启动阶段与 `lossBeforeStart` 竞速。

## 检查过、未发现问题的部分

- personal 存储 v2：两个文件共用内核租约与 CAS；读取绑定前后比对连接文件文本，防止撕裂读；迁移以 v2 连接文件的原子替换作为提交点；拆分后单次操作只能改一个存储；保护检查覆盖两个文件。
- Root 范围 Helper：personal 下的缓存键是 (environmentId, workspace)，`openFresh` 要求 workspace 等于该环境某条绑定的 path；被取代的 opening 不会写回缓存。
- `bindingId` 只允许出现在 personal 清单中，并进入 `bindingDigest`，重建同名绑定不会复活旧授权。
- 插件详情设置通道：端点白名单不含绑定、浏览与登记，请求体严格，不接受 `sessionId`。
- 合并冲突：两次合并只有 `src/client/styles.ts` 与 `tests/command.spec.ts` 有内容冲突；被丢弃的 `.mrfw-field` 规则在代码中没有引用。

## 验证证据与边界

审查宿主：macOS，Node 24.18.0、pnpm 11.25.0，开发树 DSH 0.2.2-rc.5。

| 检查 | 结果 |
| --- | --- |
| `pnpm compat:check` | 通过，SSH 下限 `0.2.2-rc.1`–`rc.5` |
| `pnpm lint` | 失败：3 个 `no-unused-vars`（F1） |
| `pnpm typecheck` / `pnpm build` / `pnpm docs:check` | 通过 |
| `pnpm pack:check` | 通过，包内 316 个成员 |
| 全量 `pnpm test` | 143 个文件通过、8 个跳过；2490 个用例通过、133 个跳过、0 失败 |
| 针对性复现 | 2 个文件、5 个用例全部命中，断言的是错误现状 |

本次运行环境中，registry IPC follower 相关套件全部通过，没有出现上次记录的 sandbox 对端拒绝。未运行：`pnpm smoke`、`pnpm smoke:packed`、`pnpm kernel:probe`、live e2e、跨 OS 与 DSH 版本矩阵，以及 GUI 手工验收（[两步式计划](../plans/completed/2026-11-19-ssh-add-connection-two-step.md) §7.2 仍未勾选）。F2 的运行时事实来自 npm 上 `0.1.5-rc.2`、`0.1.6-alpha.2`、`0.1.7-alpha.1` 三个版本 primitives 包的类型声明与 `lib/index.js`，没有在真实的 0.1.x 宿主中加载面板。

复现脚本保存在[复现补丁](./2026-11-21-ssh-branch-review-repros.patch)。在被审提交上应用后运行：

```bash
git apply docs/reviews/2026-11-21-ssh-branch-review-repros.patch
pnpm exec vitest run tests/review-20261121-host.spec.ts tests/review-20261121-client.spec.tsx --reporter=verbose
```

用例覆盖 R-A（F3）、R-B（F4）、R-C（F2）、R-D（F5），不连接真实远端、不读取用户凭据。修复后这些用例会失败；正式回归测试应断言正确行为，不能用这些历史断言判断修复是否通过。

## 修复复核（2026-11-21）

上面的分析与复现补丁保留被审提交 `0574ef6` 的行为。当前分支使用正式回归测试验证修复后的合同。

| 问题 | 状态 | 回归证据 |
| --- | --- | --- |
| F1 | 已修复 | 删除三个未使用的导入，`pnpm lint` 通过。 |
| F2 | 已修复 | Toast 和 Skills 设置通过兼容层探测图标。[旧 primitives 回归](../../tests/client-error-toast.spec.tsx) 验证没有 Regular 导出时仍能显示错误。 |
| F3 | 已修复 | [命令回归](../../tests/remote-exec.spec.ts) 覆盖同主根与跨主根的无关登记、同一登记移除重加，以及绑定、凭据与主机钥变更。操作身份经过 owner/follower 的 wire schema，旧登记复核使用原有的时间戳。 |
| F4 | 已修复 | Host 区分创建与更新，重复 ID 保留原连接和绑定。[Host](../../tests/remote-personal-ops.spec.ts) 与[面板](../../tests/client-ssh-panel.spec.tsx) 分别验证错误码与提交前提示。 |
| F5 | 已修复 | [面板回归](../../tests/client-ssh-panel.spec.tsx) 验证显示名保存零扫描，以及身份变化丢弃扫描结果。[Host 回归](../../tests/remote-personal-ops.spec.ts) 验证指纹复用与令牌约束。 |
| F6 | 已修复 | [传输回归](../../tests/remote-copy.spec.ts) 验证取消一个 upload 后另一个提交成功、迟到的共享 opening 保持可用，以及超时与清理依然有界。[SFTP 管理器回归](../../tests/ssh-environment.spec.ts) 验证两个等待者独立取消。 |
| F7 | 已修复 | [真实本机 IPC 回归](../../tests/remote-personal-ops.spec.ts) 验证 digest 变化后保留授权域和已有 follower 信道。[工具生命周期回归](../../tests/remote-tools-switch.spec.ts) 在暂停的传输中保存无关绑定与连接，工具只挂载一次且传输成功。[命令回归](../../tests/remote-exec.spec.ts) 覆盖瞬时 IPC 错误重试。 |
| F8 | 已修复 | [目录浏览回归](../../tests/remote-personal-ops.spec.ts) 覆盖目标主机、端口、账号及主机钥漂移，验证拒绝时未打开 SFTP。 |
| F9 | 已修复 | [解绑](../../tests/client-ssh-panel.spec.tsx) 和[移除登记](../../tests/client-panel.spec.tsx) 都经确认。本条原样保存问题（任务清单 F10）由[运行中命令回归](../../tests/remote-exec.spec.ts) 验证原 revision、登记及在飞命令得到保留。 |
| F10 | 已修复 | 审查报告中的语言门禁问题也已处理。[词典校验](../../tests/locale-parity.spec.ts) 按语言校验中性文案豁免。 |
| F11 | 已修复 | [面板复制回归](../../tests/client-ssh-panel.spec.tsx) 与 [Host 目标格式回归](../../tests/command.spec.ts) 覆盖自定义端口和 IPv6。连接行也显示 SSH URI 的目标部分，便于和目录行对照。 |

现行行为与旧 personal 登记的一次性重登记要求见 [SSH 远端环境参考](../reference/ssh-remote-environments.md)。

修复验证在 macOS、Node 24.18.0、pnpm 11.25.0、DSH 0.2.2-rc.5 上完成。

| 检查 | 修复后结果 |
| --- | --- |
| `pnpm lint`、`pnpm typecheck`、`pnpm build`、`pnpm compat:check`、`pnpm docs:check` | 全部通过 |
| `pnpm pack:check` | 通过，包内 319 个成员 |
| `pnpm test` | 144 个文件通过、8 个跳过。2509 个用例通过、133 个跳过、0 失败。包含真实本机 Unix socket 的 Registry owner/follower 测试。 |
| `pnpm smoke` | compose 58、behavior 137、journey 98 项通过。首轮 journey 的 DSH 子进程继承了 `GIT_CONFIG_COUNT` 但未继承对应项，导致 `git diff --stat` 失败。重跑仅为 smoke 进程设置 `GIT_CONFIG_COUNT=0`。 |
| `pnpm smoke:packed` | 通过，从 tarball 安装后 136 项通过。 |
| 真实远端 SSH/broker E2E、GUI 手工验收 | 未验证。面板与旧 primitives 通过 mock 形状测试验证。 |

本次未运行跨 OS 或全 DSH 版本矩阵。
