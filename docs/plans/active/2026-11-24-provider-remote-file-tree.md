# Provider 化文件树与远端 Workspace Root 浏览（2026-11-24）

> 状态：**active — P0–P6 已完成；P7 PARTIAL PASS。** 实现检查点 `ede0ee1`，未完成的强制门禁见 §8。设计取舍见 [ADR-0052](../../decisions/ADR-0052-provider-file-browsing.md)（Proposed）。
>
> 关联：[ADR-0052](../../decisions/ADR-0052-provider-file-browsing.md)、[ADR-0015](../../decisions/ADR-0015-files-tab-plugin-owned-browsing.md)、[ADR-0016](../../decisions/ADR-0016-files-tab-native-tree-fork.md)、[ADR-0030](../../decisions/ADR-0030-environment-and-root-identity.md)、[ADR-0031](../../decisions/ADR-0031-filesystem-routing.md)、[ADR-0041](../../decisions/ADR-0041-additional-root-workspace-search.md)、[ADR-0049](../../decisions/ADR-0049-ssh-custody-modes.md)、[外部评审（2026-11-21）](../../reviews/2026-11-21-ssh-branch-review.md)、[SSH 远端环境参考](../../reference/ssh-remote-environments.md)。

## 1. 目标与范围

把 Files 页签的文件树从「以本地路径为身份的单一数据源」重构为**按 Provider 分派的三类根浏览**：primary（主根）、additional（本地附加根）、remote（SSH 远端 Workspace Root）。远端根经插件自有的 Host 端授权读服务提供列举，本地两类的 API 拼写与退化行为保持现状。

**范围内：**

- 逻辑身份与状态键控：`RootRef` 判别联合 + `{root, relativePath}` 节点身份，树/搜索/导航状态键加入 session、tab/pane 与授权代次。
- Provider 端口与本地实现迁移：现有 fork 树收编到端口之后，本地调用形状不变。
- Host 端 `remoteFiles.list`：独立端点、UI 只读准入、I/O 前后双准入、稳定错误码。
- 三类根的 UI 选择与既有行为对齐（树、搜索面、导航记忆、行意图）。
- 撤权/复授、重试与 tab 记忆的生命周期语义。
- 预览端口（preview port）的架构与安全评估。

**非目标：**

- 远端写入、编辑、删除或任何变更语义；本批只做浏览读。
- 远端 `watch` 流（无 watch 即显式初始读、无流）；远端 `search` —— 本批明确不实现远端搜索面，Provider 合同仅预留可选能力位。
- 宣称 SFTP 后端对并发恶意 rename 健壮（做不到，见 ADR-0052 §6）。
- 用 path 后端为 Helper 对象（dev:ino）授权。
- Broker 目录流（无兼容端口则 fail closed）；team/hardened 托管档的新增能力。
- 修改上游任何包；改变原生主根行为或第三方插件接管时的静默退化。
- 远端文件的 Viewer/编辑器打开路径的完整落地（P6 只评估预览端口形态与风险）。

## 2. 背景

远端 Workspace Root 已经能登记、执行 `remote_bash`、跑 `remote_copy`；Files 页签却只能在本地根之间切换。要让同一棵树浏览远端根，障碍不在「再开一条 SFTP」，而在身份模型：现在从 `RootSwitcher` 的选中记录到树键、搜索键、导航记忆，全部以路径拼写键控，而两个环境可以共享一条路径拼写、同一环境重挂授权后路径不变主体已变。[外部评审（2026-11-21）](../../reviews/2026-11-21-ssh-branch-review.md)记录了 SSH 分支上共享通道、授权身份与撤权传播的既有教训，本设计按其结论收敛：身份与传输分离、授权代次进状态键、浏览通道请求自有。

身份模型、Provider 端口形状、Host 端点与准入、各后端诚实边界的完整决策见 [ADR-0052](../../decisions/ADR-0052-provider-file-browsing.md)，本计划不复述。

## 3. 现状盘点（P0 核对的代码事实）

- `RootSwitcher`：`RootView` 选中存于每 session inject product、按 tab 分桶；接管以路径键控。
- `adapter`：懒解析 `remote.workspaceFiles` 绑定 `filesFace`；本地树唯一数据源。
- `DirectoryNode`：展开前先等 watch-ready 迭代事件，`watch-unsupported` 时退化。
- 树键：两种渲染器都经 `childPath` 裁剪尾部 `[/\\]` 拼接；搜索键 `tabId\0rootPath`；Viewer/菜单消费 `fileAddressFor` 本地地址；导航树 hold/release + pane 记忆。
- `SftpClient`：PoC 观测 v3、POSIX 反斜杠与 Unicode 字面透传、mode 位、重定向后 canonical 路径、无 inode。
- `SshEndpointVerifier`：SFTP 端点仅 canonical 路径 + mode 位校验；Helper `fs.list` 返回数组无 fd-bound 列举；Broker 无目录流。

## 4. 实施管线（P0–P7）

每阶段记录**状态 / 下一步 / 检查点提交**。检查点提交是该阶段最后一次验证所基于的提交；未开始的阶段一律记为基线 `bc39529`。除标「建议」的门禁外均为**强制门禁**：任一不过，该阶段不得声明完成，最终报告不得写 PASS。

| 阶段 | 内容 | 状态 | 检查点提交 |
| --- | --- | --- | --- |
| P0 | 机械基线与文档（本阶段） | **已完成** | `bc39529` |
| P1 | 端口与身份合同 | **已完成** | `4fa56c4` |
| P2 | 本地实现迁移 + 本地门禁 | **已完成** | `4fa56c4` |
| P3 | Host 授权读服务与远端实现 | **已完成** | `a45e62c` |
| P4 | 三类根 UI 与对齐 | **已完成** | `ede0ee1` |
| P5 | 生命周期：撤权/复授、重试、tab 记忆 | **已完成** | `ede0ee1` |
| P6 | 预览端口评估（fake port + 架构/安全评审） | **已完成** | `ede0ee1` |
| P7 | 全量门禁、真实 SSH、截图与矩阵 | **PARTIAL PASS（待补：完整生产 DSH↔SSH、真实宿主 GUI 视觉对齐、全版本×OS 矩阵）** | `ede0ee1` |

### P0 · 机械基线与文档（已完成）

- 内容：分支基线验证（指定 Vitest 子集、`pnpm compat:check`、本地 SFTP 子系统 PoC），建立本计划与 ADR-0052。
- 结果：见 §6 证据。
- 下一步：进入 P1。

### P1 · 端口与身份合同

- 进入条件：P0 完成；ADR-0052 维持 Proposed 或转入 Accepted（合同冻结以 ADR 评审结论为准）。
- 内容：`RootRef`/节点身份类型；Provider 端口（资源绑定 `list` + 可选 `watch`/`search`/`preview`/行动作）；状态键组成（session + tab/pane + RootRef + 授权代次）；`remoteFiles.list` 的请求/响应线形与稳定错误码集合；远端合成树键的编码与「绝不当本地路径」的类型隔离。
- 强制门禁：内部合同评审（开发阶段不设用户/维护者批准闸；ADR-0052 仍记为 Proposed）；合同测试锁定键控组成；不改生产行为。
- 结果：`src/client/files-tree/provider.ts` 落地合同（`WorkspaceRootRef`/`WorkspaceResourceRef`/`FilesProviderIdentity`、可选端口即能力合同、`rootKey`/`providerKey`/`treeBucketId`/`validRelativePath`/`belongsTo`、`rowActions` 行意图适配）；`providers/resolver.ts` 为唯一组合槽。证据见 §6 P1/P2 表。

### P2 · 本地实现迁移 + 本地门禁

- 进入条件：P1 合同冻结。
- 内容：现有 fork 树、`RootSwitcher`、搜索态、导航记忆迁移到端口与身份键控；本地 Provider 保持 `workspaceFiles` 拼写；primary/additional 行为逐字节对齐。
- 强制门禁：相关 jsdom 客户端测试全绿 + `pnpm compat:check` 通过——**这是进入 P3 的前置闸门**，门禁不过不得开始 Host 远端实现。
- 结果：`providers/local.ts` 收编 `createList`/`createWatch` 与唯一的 `fileAddressFor` 调用点；`face.ts`/`store.ts`/`directory-node.ts`/`tree-view.tsx`/`FilesTree.tsx`/`pane.tsx` 按 provider + `treeBucketId` 重写；接管与保存记忆按 owner + `providerKey` 键控；`RootSwitcher`/`navigator.tsx` 组合 `resolveProvider`；`tests/client-files-provider.spec.ts` 新增回归；`FORK.md` 差集清单同步更新。证据见 §6 P1/P2 表。
- 检查点：`4fa56c4`。

### P3 · Host 授权读服务与远端实现

- 进入条件：P2 门禁通过。
- 内容：`remoteFiles.list` 端点；UI 只读 `purpose:'read'` 准入入口；网络 I/O 前后双准入；请求自有有界 SFTP 通道（不 dispose `remote_copy`/共享通道）；逐项前流式预算；abort 贯穿；稳定错误码；owner 变更失效。
- 强制门禁：**abort**（取消即断自有通道、不伤共享通道）、**budget**（条目数/字节超限即拒）、**symlink/canonical**（校验—列举一致性按后端诚实边界执行）三闸全过；**SFTP path 后端的隔离条件在本阶段定稿成文**，否则该后端不得准入；Helper fd-bound 列举证据在本阶段给出结论（证据或否决）。
- 结果：`remoteFiles.list` 独立契约（`src/remote/files-contract.ts`：严格请求/响应 schema、entries/responseBytes/wireBytes/deadline/concurrent 五预算、17 个稳定错误码 + 固定 message/retryable）；`src/remote/files-service.ts` 为唯一列举路径——并发 4 且零排队、12s 含准入总期限、claim 先于工作、令牌 `remoteFilesAuthorization(epoch, incarnation, bindingDigest, environmentDigest)` 在 SSH 前与字节返回前双准入比对、仅本端点失配才取消（无关 owner 变更不打断）；`binding.directoryListing:'stable-path'` 是 SFTP path 后端唯一准入条件（manifest 校验限定 sftp transport），缺席即 `capability-unsupported` 零 I/O，object 授权一律 fail closed；`SshEnvironmentManager.openFilesSftp` 与 `openTransferSftp` 共享自有通道机制但独立 `directorySessions` 表与上限 8，files 用途不要求 transfer block/hardlink/fsync，spawn 前复核 manifest digest；`readdirBounded` 严格类型 + 致命 UTF-8 + 名称校验去重 + 三预算；`SshEndpointVerifier` 对 opt-in binding 改走自有通道校验；`remotesViewOf` 仅在 snapshot 与 live manifest digest 一致且 ready/registered/read/path-target/supports 全满足时签发 `browseAuthorization`；`command.ts` 独立分支严格校验后调服务，错误信封只含稳定码 + `{retryable}`。
- 隔离条件定稿：SFTP path 后端的 ABA 竞争窗口无法以 SFTP 原语消解，唯一准入条件是部署方 opt-in `stable-path`——运维断言浏览期间无非可信进程可替换 workspace 或其祖先/后代目录、可改变挂载/符号链接解析；此为部署断言而非运行期证明。Helper 后端本轮否决：无 fd-bound 目录列举原语且 verifiedTarget 为 object，一律 fail closed；Broker 无目录流同样 fail closed。
- Helper 后端结论：**否决**（fail closed），理由如上；后续如有 fd-锚定证明再评估。
- 检查点：`a45e62c`。

### P4 · 三类根 UI 与对齐（已完成）

- 进入条件：P3 门禁通过。
- 内容：`RootSwitcher` 扩展 remote 类根；树/搜索面/导航记忆按新键控对三类根一致工作；远端无 watch 的显式初始读呈现；行意图经端口分派。
- 强制门禁：三类根的既有行为对齐测试（展开/折叠、搜索记录、导航记忆、退化路径）全绿；旧宿主（无远端能力）零变化。
- 结果：`src/client/remote-files-client.ts`（`RemoteFilesClient`：`list`/`wait` 走 `PANEL_CHANNEL`，严格 `remoteFilesListing`/`{unchanged:true}` 解析，固定词表错误、传输失败归 `provider-unavailable`、caller abort 归 `cancelled`）；`src/client/files-tree/providers/ssh.ts`（`createSshWorkspaceProvider`：`treeRoot='/mrfw'`、`belongsTo`+`validRemoteRelativePath` 双闸、symlink 归 `other` 惰性行、无 watch/search/preview/menu/openInApp 端口、`retainHiddenLevels:false`；`directory-not-found`/`not-directory`/`path-escapes-root` 映射上游 `workspace-file/*` 码，其余归本地化 `gateway/internal`，仅 7 个授权类码触发 invalidated）；`providers/resolver.ts`（`FilesRootSelection = LocalRootSelection | RemoteRootSelection` 顶层 `kind` 判别式、`remoteRootSelection` 仅在 registered+read+合法 token 时签发、`resolveWorkspaceFilesProvider` 单开关、`ssh` 工厂缺席即 `undefined`）；`adapter.tsx`（surface 增加 `resolveProvider(root, onInvalidated)` 与 `observeAuthority`、remoteFiles client/localize 进 seats、provider 级 `takeover.invalidate(owner,key)`）；`RootSwitcher`（`remotes.list` 独立发现 + generation/abort/session 闸，菜单远端行 `rootId · 显示名 (environmentId) · path · SSH`、无 token 行禁用并标注 `switcher.remoteDisabled`、trigger 标签/path 遵循远端选择、绝不展示凭据或 `target` URI）；个人配置在既有 Workspace 绑定编辑器加默认关闭 `directoryListing` 复选框（Helper 环境隐藏，8 语言文案 + 警告说明），`SshBindingDraft`/`SshBindingView`/`BindingDraft`/`bindingDraftOf` 往返保存、`sshBindingSave` 空提交比对含该字段。旧宿主（无 `remoteFiles` 通道、无远端视图）行为零变化。
- 检查点：`ede0ee1`。

### P5 · 生命周期：撤权/复授、重试与 tab 记忆（已完成）

- 进入条件：P4 门禁通过。
- 内容：授权撤消使远端树即时失效（owner 变更通知链路）；复授换代后旧状态不复活；列举失败的显式重试；tab/pane 级状态记忆在多 tab 下互不串扰。
- 强制门禁：撤权/复授、跨 tab 记忆、重试路径的专项测试全绿。
- 结果：远端授权租约 `remotes.waitForAuthorizationChange`（`RemoteFilesService.waitForAuthorizationChange`：独立上限 16 零排队、监听先于首次准入、脏标志合并通知、仅在 lease 结束前的最终准入仍匹配时才回 `{unchanged:true}`、每次准入 4s 上界、租约随 caller/hide/disconnect/unmount 释放；注释明确其为**授权元数据租约而非文件系统 watch**，无 SSH/FS 探测）；`command.ts` 独立 wait 分支 + `remotesViewOf` 在 `remoteList` 之后重读 manifest 比对 snapshot digest 才签 token；`RootSwitcher` 远端选择仅当**新鲜** RemotesView 含同 environmentId+rootId 且 `browseAuthorization` 等于 selection incarnation 才挂 provider——token 换代/撤权/未注册即整记录失效并落回 primary（绝不自动升级到新 token）、lease 循环失败走同一 `invalidateNow`（keyed invalidate + primary + 重刷视图）；隐藏即结束远端 takeover（`retainHiddenLevels:false`，无缓存行可在授权复核前重绘）、owner 死亡的死亡观察器连带清理该 owner 的持久选择（回收 id 不继承）；单槽 provider 缓存；`openInApp` 删除 triggerPath 回退（仅 provider 端口给出路径才渲染）；`searchSeat` 恒取 filesTree 座（hook 顺序不变），仅 provider 具 search 能力时启用。
- 检查点：`ede0ee1`。

### P6 · 预览端口评估（已完成）

- 进入条件：P5 门禁通过。
- 内容：以一个进程内 fake 预览 Provider 验证端口对 preview/打开路径的表达能力；产出预览端口的架构结论与安全评审（远端文件内容进入 Viewer 的信任边界）。
- 强制门禁：架构/安全评审记录归档；若结论为「预览端口暂不放行」，端口保留 fake 实现与失败关闭行为。
- 结果：fake-port 探针的既有三条回归已验证「选择 + 失效 + replaceTab 路由」机制可复用——`tests/client-files-provider.spec.ts` 的 `hands the preview port the exact resource reference and the replace-tab route`、`swallows gestures whose tree key maps to no resource, and dies with the signal`、`reports no open and no openable rows when the provider has no preview port`（不重跑其余套件）。结论：**预览端口暂不放行**——远端文件内容读取协议（`remoteFiles.read` 或等价物）未定义、未接线，端口保留 fake 实现与失败关闭行为；架构与安全记录归档于 `docs/architecture/file-browsing-providers.md` §6/§7 与 ADR-0052。
- 检查点：`ede0ee1`。

### P7 · 全量门禁、真实 SSH、截图与矩阵

- 进入条件：P6 完成。
- 内容：仓库全套脚本（`pnpm lint`、`pnpm typecheck`、`pnpm build`、`pnpm test`、`pnpm smoke`、`pnpm pack:check`、`pnpm compat:check`、`pnpm docs:check`）；至少一个真实 SSH 环境的浏览验收；GUI 截图目检；受支持 DSH 版本矩阵核对。
- 强制门禁：上述全部通过；真实远端与 GUI 证据归档。
- 检查点：`ede0ee1`；先补齐 §8 列出的门禁，再迁入 completed。

## 5. 风险

- **SFTP 校验—OPENDIR 竞争窗口**：无解，只能以书面隔离条件限定使用场景（P3 定稿）；文档与错误口径不得暗示更强保证。
- **本地 fork 对齐漂移**：端口迁移可能改变 fork 与上游的行为差集；P2 的对齐测试与 jsdom 门禁是唯一防线，迁移面保持最小。
- **授权代次泄漏**：远端状态若按路径而非代次键控，重挂授权会复活旧浏览态；P1 合同与 P5 测试双重把关。
- **共享通道牵连**：浏览误用 `remote_copy` 共享 SFTP 会重演单请求中断伤及在飞传输的模式；通道请求自有 + P3 abort 闸覆盖。
- **Helper/Broker 后端缺口**：fd-bound 列举证据或目录流端口不成立时对应后端 fail closed，不降级为不安全路径。
- **远端合成键泄漏**：合成树键若被当本地路径回写本地消费者会造成错路径 I/O；类型隔离 + 行意图一律经端口分派。

## 6. 证据

环境：macOS arm64 / Node 24.18.0 / pnpm 11.25.0 / 开发 pin DSH `0.2.2-rc.5`。

### P0（检查点 `bc39529`）

| 检查 | 结果 | 退出码 |
| --- | --- | --- |
| `pnpm test`（client-files / client-switcher / client-navigator / client-search / client-search-ownership / compat-files-page / remote-sftp / ssh-verifier / remote-exec-root-identity 九份规格） | 9 文件 151 用例全过，6.13s | 0 |
| `pnpm compat:check` | allowlist / peers / 开发 pin / 安装树一致（含 SSH floor） | 0 |
| 本地 SFTP 子系统 PoC（`/usr/libexec/sftp-server -R`，仅临时夹具） | 观测：v3；POSIX 反斜杠与 Unicode 文件名字面透传；目录项 mode 位正确区分 regular/symlink；`realpath` 返回重定向后 canonical 路径；`lstat` 无 inode（本地 `lstat` 对照 `ino > 0`） | 0 |
| `pnpm docs:check` | 0 errors / 0 warnings | 0 |

环境备注：切换分支后 `pnpm` 的 deps-status 检查要求重装 `node_modules`，已以 `CI=true pnpm install` 恢复（14.7s，含 `prepare` 构建）。

### P1/P2（检查点 `4fa56c4`）

| 检查 | 结果 | 退出码 |
| --- | --- | --- |
| `pnpm test tests/client-files.spec.tsx tests/client-switcher.spec.tsx tests/client-navigator.spec.tsx tests/client-search.spec.tsx tests/client-search-ownership.spec.ts tests/compat-files-page.spec.ts tests/client-files-provider.spec.ts`（指定七份规格） | 7 文件 148 用例全过，4.40s | 0 |
| `pnpm typecheck` | host + client tsc + auto-review 构建全过 | 0 |
| `pnpm compat:check` | 与 P0 一致，无漂移 | 0 |
| `pnpm docs:check` | 0 errors / 0 warnings | 0 |
| `git diff --check` | 无空白错误 | 0 |

新增回归 `tests/client-files-provider.spec.ts` 覆盖：`providerKey`/`treeBucketId` 区分同路径的会话/环境/根/代次；无 watch 的 list-only Provider 经真实 face+store 显式初始读（恰好一次 list 一条 entry）；hold 释放后迟到的旧响应不落盘；fake preview port 收到精确 `WorkspaceResourceRef` + `replaceTab`，死 signal 与缺 port 为 no-op；本地跨根资源零 wire 访问且 preview/openInApp 仍拼出 `dsh-resource://file` 地址。存量路径键控断言已迁移为 provider 键（fixture 的 `id`/`addedAt` + 实际 session）。

### P3（检查点 `a45e62c`）

| 检查 | 结果 | 退出码 |
| --- | --- | --- |
| `pnpm test tests/remote-files-service.spec.ts tests/remote-sftp.spec.ts tests/ssh-verifier.spec.ts tests/ssh-environment.spec.ts tests/ssh-environment-shutdown.spec.ts tests/remote-copy.spec.ts tests/remote-tools.spec.ts tests/remote-exec-root-identity.spec.ts tests/remote-personal.spec.ts`（指定九份规格） | 9 文件 158 用例过 / 1 skipped，10.94s | 0 |
| `pnpm typecheck` | host + client tsc + auto-review 构建全过 | 0 |
| `pnpm lint` | 0 errors（2 条既有 require-yield warning） | 0 |
| `pnpm docs:check` | 0 errors / 0 warnings | 0 |
| `git diff --check` | 无空白错误 | 0 |

新增 `tests/remote-files-service.spec.ts`（14 用例）覆盖：伪造/未知会话与未登记端点零开通道、opt-out 与 object 授权零开通道、过期令牌拒于 I/O 前、根与子级含字面反斜杠/空格/Unicode 名、符号链接祖先 `path-escapes-root` 且从不 READDIR、canonical 根重定向 `root-identity-changed`、挂起列举取消只关自有通道、4 并发 + 第 5 个 `resource-budget` 零排队、无关授权变更不打断在飞列举、撤权后旧数据不落盘、面板端点端到端 + 遍历/短令牌/多余键 `panel/bad-request`。`tests/remote-sftp.spec.ts` 新增 6 用例：严格 NAME/HANDLE/ATTRS 类型、斜杠名/空 NAME/重复名/致命 UTF-8 全 `invalid-listing`、wireBytes 超限截断、realpath/lstat 严格类型。未实现项：无（阶段内要求的用例均已落地）。

### P4/P5（检查点 `ede0ee1`）

| 检查 | 结果 | 退出码 |
| --- | --- | --- |
| `pnpm test tests/client-switcher.spec.tsx tests/client-files-provider.spec.ts tests/client-files.spec.tsx tests/client-navigator.spec.tsx tests/client-search.spec.tsx tests/client-search-ownership.spec.ts tests/remote-files-service.spec.ts tests/client-ssh-panel.spec.tsx tests/remote-personal.spec.ts`（指定九份规格） | 9 文件 274 用例过，8.26s | 0 |
| `pnpm typecheck` | host + client tsc 全过 | 0 |
| `pnpm lint` | 0 errors（2 条既有 require-yield warning：parked-watch 生成器为契约所需空 yield 迭代器，未改动） | 0 |
| `pnpm docs:check` | 0 errors / 0 warnings | 0 |
| `git diff --check` | 无空白错误 | 0 |

`tests/client-switcher.spec.tsx` 新增远端切换器块（15 用例）：远端行发现与禁用行/标签、选远端后仅根级列举、`literal\` 目录字面 RPC 路径与 Unicode 名、primary↔远端↔本地往返、跨环境同路径 bucket 隔离、同环境两次授权 bucket 隔离、文件行无本地 viewer/菜单/搜索/open-in-app、刷新与瞬时 SSH 故障保留树与错误、授权撤消/换代（租约失败与 `remotes.list` 刷新两条路径）即时失效落回 primary 且复选走新 token、被取代 provider 的迟到 invalidated 回调不弹出新选择、settings 关闭远端项、unmount 在飞取消与重挂不绘旧行。`tests/remote-files-service.spec.ts` 新增租约用例：同授权 `{unchanged:true}` 仅最终准入后返回、无关变更不唤醒、撤权/换代即时唤醒、预中止/4s 准入上界/15s 租约、上限 16 零排队、取消后槽位保留至底层准入 settle（取消+重提交不得绕过预算）、全程零 SSH 通道。

复审返工已并：`RootSwitcher` 远端证明先于 provider 缓存命中（`remoteRootSelection(endpoint)?.incarnation === selected.incarnation`）；`invalidateNow` 与发现失败/对账失效一律按「live takeover 键 + 当前选择推导键」双闸键匹配，不波及无关 local takeover；授权租约改 `AbortSignal.any` 且仅当 takeover 键与当前选择匹配才装；`refreshRemotes` 每次发现换新 `AbortController` 并于替换/会话切换/卸载时中止；依赖取 `filesTree?.takeover`/`observeAuthority`/`sessionId` 稳定座而非整个 surface；远端 provider 开门限定 `pane !== null` + 非空 session；`RemoteFilesService.wait` 的 lease 内准入限流为「同 token 在飞准入复用 + pending 集合于 slot 释放前 `allSettled` 排空」，编码失败先 `stateAbort.abort(error)` 再排空（caller 取消仍胜出）。

当前限制（诚实记录）：远端树 list-only——无 watch/search/preview/menu/open-in-app/内容读取；open-in-app 无 `triggerPath` 回退（provider 无端口即无按钮）；隐藏即结束远端 takeover——`RootSwitcher` 对远端记录既不调用 save 也不供给 saved，**不做**展开/滚动持久化：仅在手动刷新存活期间 expanded/scrollTop 保留，隐藏后新 hold 一律从空白展开开始（本地根的既有保留行为不变）；后端矩阵为 SFTP-path opt-in 可入 / Helper 否决（无 fd-bound 列举）/ Broker 无目录流——Helper/Broker 条件**未通过**，非「全部后端通过」。未实现项：无（阶段内要求的用例均已落地）；GUI 真机与真实 SSH 留待 P7。

## 7. 退出验收

**全部强制门禁通过才可报告 PASS**：P2 本地 jsdom/compat 闸、P3 abort/budget/symlink 闸与隔离条件定稿、P4 三root对齐、P5 生命周期专项、P6 评审归档、P7 全量脚本 + 真实 SSH + 截图 + 矩阵。任一阶段以「环境原因跳过」记帐而非 PASS；P3 内 Helper 后端的否决结论是合法结果（fail closed 即完成），不算阻塞，但 Helper 证据缺失（既未证明 fd-bound 列举成立、也未给出否决结论）时整体不得记 PASS。

## 8. 复审返工后的验收报告（P7 范围）

### 实际跑过的证据

| 证据 | 内容 | 位置/退出码 |
| --- | --- | --- |
| 真实 SSH（loopback） | 用户态 OpenSSH `sshd`（127.0.0.1，一次性 host/user 密钥，不触碰 `~/.ssh`、不用外部主机），生产 `SftpClient` 经生成 `ssh_config`（`-F`）连接——即 `listRemoteDirectories` 对托管个人环境使用的同一机制；SFTP v3 握手、根/嵌套 `readdirBounded`、字面 POSIX 名（空格 / Unicode / 字面反斜杠）逐字节透传、`realpath`/`lstat` 一致 | `tests/ssh-loopback.e2e.ts`（`DSH_MULTI_ROOT_SSH_LOOPBACK=1` 门禁，默认 skip），1/1 通过 |
| GUI 截图（真 Chromium） | 同一 `client.apply` + 真实 `RootSwitcher`/`FilesPane` 在 headless Chromium（vitest browser mode + Playwright）渲染：菜单远端行、远端树绘制（含 Unicode/反斜杠名）、展开产生第二条 `remoteFiles.list` RPC、`withheld` 行禁用态；Host 侧为录制 stub（文档化） | `tests/client-remote-tree.browser.tsx` + `vitest.remote-tree-browser.config.ts`；截图 `.dsh-smoke/gui/remote-*.png`（4 张） |
| `ssh -G` 身份校验边界 | `SshEnvironmentManager.openFilesSftp` 的身份检查走 `ssh -G <alias>`，当前调用没有传入隔离配置；本次没有改用户配置，也没有用 loopback 覆盖这段生产路径 | 本次仅由进程内规格覆盖；`DSH_MULTI_ROOT_SSH_LIVE` 未执行 |
| **真实宿主 GUI 端到端（P7 补证）** | 打包 tarball 装入隔离 scratch `DSH_HOME` 的 `web` profile（四个 SSH peer 包经 `dsh plugin add` 装入 profile 依赖树，与线上 install-ssh-deps 同一机制）→ 进程内启动真实 `dsh web`（0.2.2-rc.5）→ 真实 Google Chrome 驱动：侧边栏开真实会话 → 右侧栏 Workspace files → Files pane → Workspace Folders 对话框远端区列出两个种子端点 → 行菜单登记 sftp（`Registered`、`browseAuthorization: present:64`）与 helper（`Registered`、`browseAuthorization: absent`）→ RootSwitcher 菜单 sftp 行可用、helper 行置灰「not browsable」→ 远端树绘制全部 7 个夹具项（`literal\dir`/`space dir`/`uni-名字.md`/`alias.link` 原样）→ `deep/inner` 两级展开再发两次 `remoteFiles.list`。远端夹具 `/root/dsh-live-browse` 每次运行前创建、结束即删；`~/.dsh` 仅只读复制（凭据 root + 清单），测试侧全在 scratch 目录 | `DSH_LIVE_GUI=1 node scripts/live-remote-gui.mjs`，**9/9 通过**；证据 `.dsh-smoke/live-gui/evidence/`（截图 01–08、DOM dump、`evidence.json`、wire 日志） |
| **真实 DSH↔SSH 全栈（P7 补证）** | 旧专用测试 VPS `64.118.149.252` 已在 SSH 层失联（TCP 通、banner 前断）；改用 `~/.dsh` 保存的真实 `ali` 环境（`8.137.81.239`，root，helper `/root/.dsh-helper/0.2.2-rc.5/helper-entry.mjs`）：`~/.dsh-ssh-test/` 新增 `live-ali.json`（复用清单里的 nodePath/helperPath/helperSha256/hostKey，`account`/`xfer*` 均 `root`、host 均 `dsh-ali`）并在其 `ssh_config` 追加 `dsh-ali` Host 块（IdentityFile/UserKnownHostsFile 引用受管路径，只读）+ `Host *` 补 `BatchMode yes`/`UpdateHostKeys no`（`parseSshConfig` 现行硬要求）。`remote_bash` 全组（注册/身份漂移/受限命令边界·截断·超时/中途撤权零 spawn/环境隔离与重开再生）、`remote_copy` 全组（sha256 校验、0B+1MiB 回环、既有目标/符号链接/多链接/源变更/撤权取消/并发单提交/下载/只读拒/relay/relay 变更/超预算拒/只读会话拒/未见证拒）全部实机通过 | `PATH=~/.dsh-ssh-test/bin:$PATH DSH_MULTI_ROOT_SSH_LIVE=~/.dsh-ssh-test/live-ali.json pnpm vitest run tests/remote-ssh.live.e2e.ts`，**19/19 通过**（38s）；夹具目录 `/root/dsh-live/{app,lib}`、`/root/dsh-live-outside/sentinel.txt`、`/import` 留在 VPS 供复跑 |

### 门禁（复审返工后重跑）

| 检查 | 结果 | 退出码 |
| --- | --- | --- |
| `pnpm test tests/client-switcher.spec.tsx tests/client-files-provider.spec.ts tests/remote-files-service.spec.ts tests/locale-parity.spec.ts`（**最终补丁聚焦复测**） | 4 文件 109 用例全过 | 0 |
| `pnpm test:panel-browser` | 3/3 | 0 |
| `pnpm vitest run --config vitest.remote-tree-browser.config.ts` | 2/2（真实 Chromium） | 0 |
| `DSH_MULTI_ROOT_SSH_LOOPBACK=1 pnpm vitest run tests/ssh-loopback.e2e.ts` | 1/1 | 0 |
| `pnpm compat:check` | allowlist/peers/pin/安装树一致 | 0 |
| `pnpm docs:check` | 0 errors / 0 warnings | 0 |
| `git diff --check` | 无空白错误 | 0 |
| `pnpm verify:all`（lint→typecheck→build→licenses→kernel:probe→test→smoke→pack:check→smoke:packed→auto-review:fork→smoke:auto-review） | 全段通过（上一批改动时的完整跑通；最终补丁未重跑全量，以上一条聚焦复测为准）：lint 0 errors（2 条既有 warning）、typecheck/build/licenses 干净、kernel:probe seatbelt ok、test **171 文件 2771 用例过 / 134 skipped**、smoke:compose 58 + smoke:behavior 137 + smoke:journey 98、pack:check 334 成员、smoke:packed 136、auto-review:fork + 4×auto-review 全过 | 0 |
| `pnpm typecheck`（最终补丁后） | host + client tsc 全过 | 0 |
| `pnpm lint`（最终补丁后） | 0 errors（同 2 条既有 require-yield warning） | 0 |
| `pnpm docs:check`（最终补丁后） | 0 errors / 0 warnings | 0 |
| `git diff --check`（最终补丁后） | 无空白错误 | 0 |
| `DSH_LIVE_GUI=1 node scripts/live-remote-gui.mjs`（P7 补证） | 9/9：bundle 服务、对话框、两端点列出、sftp/helper 登记、helper 行禁用、远端树全量绘制、deep/inner 展开 | 0 |
| `PATH=~/.dsh-ssh-test/bin:$PATH DSH_MULTI_ROOT_SSH_LIVE=~/.dsh-ssh-test/live-ali.json pnpm vitest run tests/remote-ssh.live.e2e.ts`（P7 补证） | 19/19 实机用例（remote_bash + remote_copy） | 0 |
| `pnpm vitest run tests/remote-copy.spec.ts tests/remote-copy-local-link-classification.spec.ts tests/remote-local-transfer-admission.spec.ts tests/local-transfer-authority.spec.ts`（TransferIO 修复后） | 4 文件 61 用例全过 | 0 |

全量门禁的原始关键行见[核验日志摘录](../../reference/file-browsing-verification-20261124.txt)。

### 复审返工期间新发现并已修的问题（全量套件才暴露）

- `tests/remote-personal-ops.spec.ts` 的手写 registry stub 缺 `setRemoteFilesService` 端口 → `mountRemoteTools` 内 `ctx.effect` 抛 TypeError 连带取消 `ctx.tools.register` → stub 已补该端口（74/74）。
- `locale-parity` 枚举的扫描类（`SshEnvironmentError`/`RemoteAdmissionError`）新增 `capability-unsupported`、`session-unavailable` 两个字面码（P3 引入、focus 清单未含该规格）→ 八语字典补 `error.*` 键（11/11）。

### P7 补证期间新发现并已修的问题（真实 WAN 链路才暴露）

- **`TransferIO` 清理窗口饥饿**：cleanup 路径共享的 1 秒窗口自**首次** `cleanupClient` 调用起算——`staging.finish()` 内的 `closeHandle` 与 `verify()` 内的 `close` 在 publish 的清理运行前就把窗口耗尽；本地/低延迟链路下各调用 <1ms 不会暴露，真实 VPS RTT 下 `verify`+`hardlink` 阶段轻易超过 1s，`remove()` 见到 `remaining <= 0` 即 `transfer-timeout` → 已提交的复制把 `.dsh-staging-<id>` 留成 `residual`。修复：cleanup 调用改为**逐次自有** 1 秒窗口（清理调用在结构上有限，逐次限界仍满足「有界、与取消无关」的设计意图）。`remote-copy` 系 4 份规格 61 用例回归通过；live e2e 11 个 residual 失败全部转通过。

### 未跑项与限制（诚实记录）

- **全版本 × OS CI 矩阵待复验。** 合并 `main` 后，分支按更新后的 27 个精确 DSH 版本在四个镜像上运行矩阵。两个 Ubuntu 镜像全部通过，Windows 八组均在远端文件服务规格失败。macOS 第 4 组的 DSH `0.2.1-alpha.5` 在 worktree 用例删除 `.git` 之前返回 `lost`，第 6、8 组取消且无步骤日志。[首次矩阵运行](https://github.com/cherrchen/dsh-plugin-multi-root-workspace/actions/runs/45416659541)
- 依赖真实 SSH 控制面的列举和租约规格限 macOS/Linux 执行。所有平台仍校验 UTF-8 路径预算和 RPC 不可用响应，Windows 另断言开启实验时控制面为 `platform-deferred`（[ADR-0030](../../decisions/ADR-0030-environment-and-root-identity.md)）。worktree 重新挂载规格先用被动检查建立有效快照，确认没有 watcher 后再删除 `.git`，由重新挂载触发失效判断。独立的 watcher 失效和恢复规格继续验证通知路径。
- **远端树仍为 list-only**：无 watch/search/preview/menu/open-in-app/内容读取；预览端口为 fake-port 结论、未接线。
- **live e2e 环境口径**：旧专用 VPS（`64.118.149.252`）SSH 层失联，本次以 `~/.dsh` 的 `ali` 环境承载 `remote-ssh.live.e2e.ts`（`live-ali.json` + `~/.dsh-ssh-test/ssh_config` 的 `dsh-ali`/`Host *` 块——均为测试环境文件，`~/.dsh` 本体未写）。四个 helper/sftp 环境共用一个 `root` 账号与同一台主机，账户/主机隔离语义弱于原双账号双别名夹具；`xfer` 的「托管 SFTP 账户」语义以同机同用户近似。旧 VPS 恢复后可用原 `live.json` 复跑。
- **GUI 截图局限**：真实宿主 GUI 证据已由 `live-remote-gui` 驱动补齐（真实 `dsh web` + 真实 Chrome + 真实 VPS，见上表）；此前的 Chromium 替身截图仍只作行为证据。真实桌面壳（非 `dsh web` 浏览器面）未截图。
- 既有 `require-yield` warning ×2（`face.ts`/`local.ts` 的 parked-forever 迭代器为契约所需）保持不变。
- CHANGELOG 无 Unreleased 节且用户禁止发版动作——本批变更的发布叙述留在本文件，不写入已发布节、不 bump 版本。

### 最终结论

**PARTIAL PASS**。实现及最终补丁已提交至 `ede0ee1`（其后 P7 补证提交：live-gui 驱动脚本、`TransferIO` 清理窗口修复、本节证据更新）。P7 三项强制门禁已补齐两项：**真实 DSH↔SSH 端到端**（`remote-ssh.live.e2e.ts` 19/19 实机通过，remote_bash 经 helper 传输 + remote_copy 经 sftp 传输）与**真实宿主 GUI**（`live-remote-gui` 9/9，真实 `dsh web` 0.2.2-rc.5 + 真实 Chrome + 真实 `ali` VPS，远端树绘制/展开/登记/禁用态截图齐全）。仅剩**全版本×OS 矩阵**未验收，本计划保留 active。
