# SSH 远端绑定能力新增清单

English: [remote-binding-capability-checklist.en.md](./remote-binding-capability-checklist.en.md)

这份笔记回答一个反复踩坑的问题：**给 SSH 远端 Workspace 绑定增加一种能力/权限/部署断言时，到底要同步改哪些地方**。

它不是 `directoryListing` 的设计文档。浏览能力本身的安全决策唯一真源是 [ADR-0052](../../docs/decisions/ADR-0052-provider-file-browsing.md)，架构真源是 [file-browsing-providers.md](../../docs/architecture/file-browsing-providers.md)。这里记录的是跨层实施地图，避免以后只改一个向导、一个 schema 或一个菜单，造成“有的地方能开、有的地方保存后丢失、Host 又拒绝”的断裂。

## 0. 先分类：不是所有能力都是 `action`

动手前先判断新增能力属于哪一类：

1. **模型工具动作授权**：类似 `read` / `write` / `exec`，直接决定 `remote_copy` / `remote_bash` 能做什么。只有这一类才应进入 `binding.actions`、`RemoteAction` 和 `remote.capability.*` 动作词表。
2. **传输配对**：类似 `transfers`，它不是动作，而是“允许哪两个 root 之间复制”的有向配对。
3. **部署断言或后端能力**：类似 `directoryListing: 'stable-path'`，它声明远端部署满足一个无法由协议运行时完全证明的前提。它可以要求某个 action（例如 `read`），但它本身不是模型动作。
4. **连接级能力**：类似 environment 的 `exec` / `transfer` stanza，属于连接而不是某个 workspace binding。不要把连接级开关复制成绑定级权限，反之亦然。

分类错了，后面所有层都会错。尤其不要因为“UI 上也是一个勾选项”就把它塞进 `actions`。

## 1. 记住完整数据通路

个人模式的绑定能力至少穿过这条链：

```text
各个客户端编辑表面
  → SshBindingDraft（remote/personal-contract.ts）
  → sshBindingSave 严格请求 schema
  → remote/personal-endpoints.ts 的 sshBindingSave CAS 写入
  → remote/personal/config.ts 的 bindings 持久化
  → toDeploymentManifest(...)
  → remote/manifest.ts 的共享 bindingSchema + parseDeploymentManifest 语义校验
  → bindingDigest / grant state / withheld 判定
  → SshEndpointVerifier 登记校验
  → remoteCapabilitiesOf / remotesViewOf / 工具准入 / remoteFiles 等服务准入
  → RootSwitcher、provider、快捷菜单等浏览器消费者
```

deployment 模式没有 personal UI 和 personal store，但它共享后半条链：`remote/manifest.ts`、digest、verifier、registry、runtime admission。**只改 personal 层不算完成；只改共享 manifest 也不够，因为 strict wire schema 会先把客户端请求拒掉。**

## 2. 全层清单

按下面顺序核对。顺序本身也是依赖方向，尽量不要倒着补。

### 2.1 语义、安全边界与默认态

- 明确它是动作、配对、部署断言，还是连接级能力。
- 默认必须是安全方向：默认关闭、显式 opt-in，或至少不因旧配置缺失而自动获得新权力。
- 写清跨字段不变量。例如 `directoryListing` 必须同时允许 `read`；Host 必须权威校验，客户端禁用只是 UX。
- 写清它是否会改变授权身份。共享 `bindingDigest` 对整个 binding 做规范化摘要；新增持久字段默认会改变 digest，导致既有 grant `withheld`，这通常是正确且必要的，但必须是有意决定。
- 若能力涉及 path / object / transport 身份，先在 ADR 或架构文档写清不得混淆的授权域。`directoryListing` 的关键教训是：Helper 的 dev:ino object grant 不能被 reinterpret 成 path grant。

### 2.2 共享 manifest schema 与语义校验

位置：`src/remote/manifest.ts`

- `bindingSchema` 增加字段，或在 `actions` 枚举中加入新动作。
- `parseDeploymentManifest` 增加跨字段校验、重复值校验、预算校验和 transport/backend 约束。
- 如果字段只应在 personal binding 或 deployment binding 一侧出现，检查 `bindingId` / `options.personal` 的既有边界，不要悄悄让一侧接受另一侧保留字段。
- deployment manifest 是 operator 手写/生成的入口，personal config 也会经 `toDeploymentManifest` 走到同一校验。不要把校验只写进 personal endpoint。

### 2.3 持久化与 personal → deployment 转换

位置：`src/remote/personal/config.ts`

- personal bindings store 直接复用共享 `bindingSchema`；确认新字段在读写往返中保留。
- `toDeploymentManifest` 通常不需要逐字段复制 binding（它直接传 `config.bindings`），但 environment/transport 派生可能影响新字段的合法性。
- 检查旧配置兼容：字段应 optional 并有安全默认；不要把旧配置变成 invalid，除非这是有意的 breaking migration。
- 如果字段影响文件保护、路径预算或 primary 关系，同步 `checkPersonalFileProtection` / 相关校验。

### 2.4 面板 wire contract

位置：`src/remote/personal-contract.ts`

必须同时改三处，缺一就会出现“前端发了 Host 拒”或“Host 返回前端解析失败”：

1. `sshBindingSave` 请求里的 strict binding schema；
2. `SshBindingView` / `SshBindingDraft` TypeScript 类型；
3. `bindingViewSchema` / `sshStateSchema` 的响应解码。

schema 是 `.strict()`：没加字段时客户端即使构造出来也会在 Host 边界被拒。view schema 没加时，即使保存成功，下一次 `sshState` 也会让客户端 `panel/bad-response` 或丢字段。

如果能力影响远端端点视图，还要改 `src/remote/panel-contract.ts`：`RemoteAction`、`RemoteCapabilitiesView`、`RemoteEndpointView`、对应 zod schema 和注释。

### 2.5 Host 保存端点与 CAS/no-op 判定

位置：`src/remote/personal-endpoints.ts` 的 `sshBindingSave`

- 增加跨字段请求校验，但不要让 endpoint 替代 manifest 校验；两层职责不同。
- **no-op 比对必须包含新字段**。这里曾经是最容易漏的地方：如果比对漏了，用户只改新字段时 Host 认为“没有变化”，返回旧 config，UI 看似保存成功实际没写入。
- 如果字段改变 rootId 复用、path 匹配、transfer 合法性或 deployment-style pairing，更新对应逻辑。
- 保持 revision CAS 语义；不要为新字段开旁路写。

### 2.6 登记、授权身份与重登记

位置：`src/remote/ssh-verifier.ts`、`src/registry.ts`、`src/command.ts`、`src/remote/records.ts`、`src/remote/plane.ts`

- 决定登记时是否需要额外 probe。若能力依赖远端事实，不要只信声明。
- probe 必须属于正确的授权域。path probe 不能给 object 授权扩容，object probe 也不能变成 path 授权。
- digest 变化应自然导致 `withheld` 和重登记；确认 UI 文案和流程能走到重新登记。
- 如果 personal binding 重建，`bindingId` incarnation 也不能让旧 grant 复活。
- 若能力改变 `verifiedTarget`、grant 形状或登记证据，检查 `records.ts` 的严格持久化 schema 与版本/incarnation 语义；`backup-and-skip` 是损坏记录的兜底，不是迁移方案。
- `plane.ts` 的 `grantState` / `admit` 决定 withheld/revoked 与 purpose 准入。新增真正的模型动作时，还要检查 `contract.ts` 的 `RemotePurpose` 是否必须扩展；部署断言通常不应假装成一个 action。

### 2.7 运行时准入与工具/服务

位置视能力而定：

- `src/command.ts` 的 `remoteCapabilitiesOf` / `remotesViewOf`；
- `src/remote/plane.ts` 的 purpose/pairing 准入；
- `src/remote/tools.ts`、`src/remote/tools-registration.ts`、`src/remote/transfer.ts`、`src/remote/exec*.ts`、`src/remote/tool-arguments.ts`；
- `src/remote/files-contract.ts` / `src/remote/files-service.ts` / `src/remote/files-authorization.ts` 这类独立服务合同、准入与令牌；
- `src/remote/ssh-environment.ts` 的通道开启门禁；
- `src/remote/capabilities.ts` 的模型可见拓扑投影。真正的模型动作要进入 `ACTION_ORDER`/`renderBinding`；`directoryListing` 这类非动作部署断言不要只因 UI 暴露就投影给模型。

原则：

- 每次真实 I/O 前后都要有权威准入；客户端 projection 不是授权。
- 若需要独立于既有传输的通道，通道仍要复核宿主身份、manifest/environment digest、SFTP 版本和 owned-channel 生命周期。
- 新增稳定错误码时同步错误词表、locale `error.*`、测试和文档；不要把底层 SSH 文本直接透传给 UI。

### 2.8 浏览器能力投影与消费

位置：`src/remote/panel-contract.ts`、`src/command.ts`、`src/client/ssh-client.ts`、`src/client/remotes-client.ts`、`src/client/remote-files-client.ts`、`src/client/files-tree/providers/resolver.ts`、`src/client/RootSwitcher.tsx`、相关 provider/client。

- 如果浏览器需要直接调用 Host 服务，考虑是否需要类似 `browseAuthorization` 的 opaque token，以及 token 由哪些 digest/epoch/incarnation 组成。
- `remotesViewOf` 必须在 live manifest 与 grant snapshot 一致时才签发；不要让异步 rebind 后产生的旧视图继续授权。
- RootSwitcher/provider 只消费 projection；不要在校验缺失时自己“推断”能力。

### 2.9 所有绑定编辑表面

这是最容易漏的一层。当前必须检查以下全部入口：

| 表面 | 文件 | 必查点 |
| --- | --- | --- |
| `+ → 添加远端工作目录` | `src/client/wizard/add-remote.tsx` | `BindingForm` / `blankBinding` / 动作联动 / 保存 draft / confirm summary / helper-less 或 transport gate |
| 添加/编辑连接向导（边界检查，通常不放绑定能力） | `src/client/wizard/add-connection.tsx`、`src/client/wizard/env-parts.tsx` | 这里拥有的是连接级 Helper/exec/transfer；除非该向导真的创建 binding，不要把绑定级字段塞进连接表单 |
| 绑定对话框的“添加绑定”向导 | `src/client/wizard/add-binding.tsx` | draft 初始化、checkbox 联动、保存、confirm summary |
| 已有绑定的内联编辑表单 | `src/client/ssh-panel.tsx` + `src/client/ssh-draft.ts` | `BindingDraft`、`bindingDraftOf`、编辑 existing binding 的回填、动作联动、禁用原因和提示 |
| 远端目录行尾 `…` 的“修改能力”快捷菜单 | `src/client/remote-root-menu.tsx` + `src/client/WorkspaceFoldersAction.tsx` | `CapabilityDraft` 回填、菜单项、跨字段清理、changed 计算、保存 payload、父组件刷新/重登记 wiring；**不暴露时也必须显式保留，不得静默丢字段** |
| 绑定列表/确认页展示 | `src/client/ssh-panel.tsx`、两个 wizard 的 summary | 用户能否在保存前看见该能力会启用 |
| RootSwitcher/Files 行 | `src/client/RootSwitcher.tsx`、providers | 已授权能力如何出现、禁用原因如何表达 |

如果新增字段在快捷菜单中因为 UX 原因不直接暴露，正确做法只有两种之一：

1. 保存时逐字保留原字段；或
2. 不允许在该菜单编辑会受影响的 binding，引导用户去完整编辑器。

**不允许静默丢字段。** `directoryListing` 最初就踩过这个坑；现在快捷菜单直接暴露该选项，并把部署断言的安全前提放进可选项行内。

### 2.10 本地化与可访问性

- `src/client/locales/` 八种语言全部同步：`zh/en/ja/es/fr/de/ru/pt`。
- 至少检查动作名、选项名、hint、summary、错误码和 disabled 文案。
- 跑 `tests/locale-parity.spec.ts`；不要只改 zh/en。
- 安全前提不要只放在视觉上存在、屏幕阅读器读不到的旁注里。快捷菜单的实现把 hint 放进可选项行内，就是为了让它随菜单项一起进入 accessible name。

### 2.11 测试矩阵

按层补测试，不要只补一个 UI snapshot：

- manifest/schema：`tests/remote-manifest.spec.ts`；
- personal store/endpoint：`tests/remote-personal*.spec.ts`；
- verifier：`tests/ssh-verifier.spec.ts`；
- runtime service：`tests/remote-files-service.spec.ts` 或对应工具规格；
- Host projection：`tests/command.spec.ts` / remotes 相关规格；
- 添加远端向导：`tests/client-ssh-wizard.spec.tsx`；
- 绑定对话框、内联编辑、快捷能力菜单：`tests/client-ssh-panel.spec.tsx`；
- locale parity：`tests/locale-parity.spec.ts`；
- 共享测试替身：`tests/support/fake-remote.ts`、`tests/support/remote-tools.ts`（否则新增字段在大量 Host/service 测试里根本不存在）；
- 若涉及真实 SSH：`tests/remote-ssh.live.e2e.ts`；
- 若涉及真实浏览器 GUI：`scripts/live-remote-gui.mjs`。

### 2.12 文档同步

至少检查：

- 用户指南：`docs/guide/user/ssh-remote-environments.md` 与 `.en.md`；
- 技术参考：`docs/reference/ssh-remote-environments.md`；
- 架构真源：`docs/architecture/file-browsing-providers.md`（若涉及浏览/provider）；
- ADR：`docs/decisions/ADR-0052-provider-file-browsing.md` 或新 ADR；
- active plan：当前实施计划；
- 本 note 仅在清单本身过时的时候更新，不要把它当成功能文档。

## 3. `directoryListing` 案例：正确形状

`directoryListing: 'stable-path'` 是“绑定级部署断言”，不是 `action`。它的正确形状是：

- schema：`bindingSchema` optional literal，Host 强制必须伴随 `read`；
- wire：`sshBindingSave` 请求、`SshBindingView/Draft`、response view schema 都认识它；
- 保存：`sshBindingSave` no-op 比对包含它；
- 身份：它进入 binding digest，切换后 binding `withheld`，必须重新登记；
- 登记：Helper binding 在 object probe 后追加独立 SFTP v3 path probe；
- 运行时：`RemoteFilesService` 每次 listing 仍在 owned SFTP channel 上 probe canonical path，并在 I/O 前后比对授权；
- 投影：`remotesViewOf` 只在 registered + read + opt-in + live manifest/snapshot 一致 + service supports 时签发 `browseAuthorization`；
- UI：添加远端向导、添加绑定向导、内联编辑、快捷能力菜单四处都可显式修改；取消 `read` 会清掉它；Host 而不是客户端拥有最终裁判权；
- 模型投影：它故意不进入 `src/remote/capabilities.ts` 的动作词表，因为它不是模型工具动作；
- 文档：用户指南、reference、architecture、ADR、plan 同步描述同一语义。

## 4. 反复出现的坑

1. **只改 manifest，不改 strict wire schema**：前端保存被 Host 拒。
2. **只改请求 schema，不改 view schema**：保存后状态回读失败或字段消失。
3. **no-op 比对漏字段**：用户只改新能力时保存变成无声 no-op。
4. **只改完整编辑器，不改快捷菜单**：快捷菜单保存一次就把新能力丢掉。
5. **把跨字段清理只写在 UI**：Host 必须同样拒绝非法组合。
6. **把能力默认打开**：旧配置升级后静默获得新权力，通常不可接受。
7. **混淆 object/path 授权**：Helper dev:ino 是 object 身份，不是路径稳定的证明。
8. **只看 projection 就做 I/O**：projection 是 UX，运行时准入才是授权。
9. **只跑客户端测试**：digest/revocation/race 问题通常只在 Host/service 测试或 live e2e 中暴露。
10. **文档只改一处**：用户指南说能开、reference 说不支持、ADR 又保留旧限制，后续开发会照错文档实现。
11. **新增 action 却只改 UI 词表**：`plane.ts`/`RemotePurpose` 不准入、`capabilities.ts` 不投影、工具 schema 不认识，最终模型看得到或看不到都与 Host 不一致。

## 5. 最小验证命令

按变更范围选择，但涉及绑定能力的完整改动通常至少需要：

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm docs:check
pnpm compat:check
pnpm pack:check
pnpm smoke
```

涉及真实 SSH 或 GUI 时再加：

```bash
PATH="$HOME/.dsh-ssh-test/bin:$PATH" \
  DSH_MULTI_ROOT_SSH_LIVE="$HOME/.dsh-ssh-test/live-ali.json" \
  pnpm exec vitest run tests/remote-ssh.live.e2e.ts

DSH_LIVE_GUI=1 node scripts/live-remote-gui.mjs
```

这些 live 命令依赖本机测试环境文件；没有该环境时不要伪造通过证据，在计划中如实记录未跑原因。
