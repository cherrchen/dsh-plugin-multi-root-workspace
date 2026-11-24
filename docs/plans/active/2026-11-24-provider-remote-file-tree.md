# Provider 化文件树与远端 Workspace Root 浏览（2026-11-24）

> 状态：**active — P1/P2 已提交 `4fa56c4`，P3 Host 列举服务已在工作树实现并过门禁**。决策拟议见 [ADR-0052](../../decisions/ADR-0052-provider-file-browsing.md)（Proposed）。
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
| P3 | Host 授权读服务与远端实现 | **已完成** | 工作树（未提交，基于 `4fa56c4`） |
| P4 | 三类根 UI 与对齐 | 未开始 | `bc39529` |
| P5 | 生命周期：撤权/复授、重试、tab 记忆 | 未开始 | `bc39529` |
| P6 | 预览端口评估（fake port + 架构/安全评审） | 未开始 | `bc39529` |
| P7 | 全量门禁、真实 SSH、截图与矩阵 | 未开始 | `bc39529` |

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
- 检查点：迁移工作树（未提交）。

### P3 · Host 授权读服务与远端实现

- 进入条件：P2 门禁通过。
- 内容：`remoteFiles.list` 端点；UI 只读 `purpose:'read'` 准入入口；网络 I/O 前后双准入；请求自有有界 SFTP 通道（不 dispose `remote_copy`/共享通道）；逐项前流式预算；abort 贯穿；稳定错误码；owner 变更失效。
- 强制门禁：**abort**（取消即断自有通道、不伤共享通道）、**budget**（条目数/字节超限即拒）、**symlink/canonical**（校验—列举一致性按后端诚实边界执行）三闸全过；**SFTP path 后端的隔离条件在本阶段定稿成文**，否则该后端不得准入；Helper fd-bound 列举证据在本阶段给出结论（证据或否决）。
- 结果：`remoteFiles.list` 独立契约（`src/remote/files-contract.ts`：严格请求/响应 schema、entries/responseBytes/wireBytes/deadline/concurrent 五预算、17 个稳定错误码 + 固定 message/retryable）；`src/remote/files-service.ts` 为唯一列举路径——并发 4 且零排队、12s 含准入总期限、claim 先于工作、令牌 `remoteFilesAuthorization(epoch, incarnation, bindingDigest, environmentDigest)` 在 SSH 前与字节返回前双准入比对、仅本端点失配才取消（无关 owner 变更不打断）；`binding.directoryListing:'stable-path'` 是 SFTP path 后端唯一准入条件（manifest 校验限定 sftp transport），缺席即 `capability-unsupported` 零 I/O，object 授权一律 fail closed；`SshEnvironmentManager.openFilesSftp` 与 `openTransferSftp` 共享自有通道机制但独立 `directorySessions` 表与上限 8，files 用途不要求 transfer block/hardlink/fsync，spawn 前复核 manifest digest；`readdirBounded` 严格类型 + 致命 UTF-8 + 名称校验去重 + 三预算；`SshEndpointVerifier` 对 opt-in binding 改走自有通道校验；`remotesViewOf` 仅在 snapshot 与 live manifest digest 一致且 ready/registered/read/path-target/supports 全满足时签发 `browseAuthorization`；`command.ts` 独立分支严格校验后调服务，错误信封只含稳定码 + `{retryable}`。
- 隔离条件定稿：SFTP path 后端的 ABA 竞争窗口无法以 SFTP 原语消解，唯一准入条件是部署方 opt-in `stable-path`——运维断言浏览期间无非可信进程可替换 workspace 或其祖先/后代目录、可改变挂载/符号链接解析；此为部署断言而非运行期证明。Helper 后端本轮否决：无 fd-bound 目录列举原语且 verifiedTarget 为 object，一律 fail closed；Broker 无目录流同样 fail closed。
- Helper 后端结论：**否决**（fail closed），理由如上；后续如有 fd-锚定证明再评估。
- 检查点：工作树（未提交，基于 `4fa56c4`）。

### P4 · 三类根 UI 与对齐

- 进入条件：P3 门禁通过。
- 内容：`RootSwitcher` 扩展 remote 类根；树/搜索面/导航记忆按新键控对三类根一致工作；远端无 watch 的显式初始读呈现；行意图经端口分派。
- 强制门禁：三类根的既有行为对齐测试（展开/折叠、搜索记录、导航记忆、退化路径）全绿；旧宿主（无远端能力）零变化。
- 检查点：UI 提交。

### P5 · 生命周期：撤权/复授、重试与 tab 记忆

- 进入条件：P4 门禁通过。
- 内容：授权撤消使远端树即时失效（owner 变更通知链路）；复授换代后旧状态不复活；列举失败的显式重试；tab/pane 级状态记忆在多 tab 下互不串扰。
- 强制门禁：撤权/复授、跨 tab 记忆、重试路径的专项测试全绿。
- 检查点：生命周期提交。

### P6 · 预览端口评估（fake port + 架构/安全评审）

- 进入条件：P5 门禁通过。
- 内容：以一个进程内 fake 预览 Provider 验证端口对 preview/打开路径的表达能力；产出预览端口的架构结论与安全评审（远端文件内容进入 Viewer 的信任边界）。
- 强制门禁：架构/安全评审记录归档；若结论为「预览端口暂不放行」，端口保留 fake 实现与失败关闭行为。
- 检查点：评估提交。

### P7 · 全量门禁、真实 SSH、截图与矩阵

- 进入条件：P6 完成。
- 内容：仓库全套脚本（`pnpm lint`、`pnpm typecheck`、`pnpm build`、`pnpm test`、`pnpm smoke`、`pnpm pack:check`、`pnpm compat:check`、`pnpm docs:check`）；至少一个真实 SSH 环境的浏览验收；GUI 截图目检；受支持 DSH 版本矩阵核对。
- 强制门禁：上述全部通过；真实远端与 GUI 证据归档。
- 检查点：最终提交。

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

### P1/P2（工作树，未提交，基于 `bc39529`）

| 检查 | 结果 | 退出码 |
| --- | --- | --- |
| `pnpm test tests/client-files.spec.tsx tests/client-switcher.spec.tsx tests/client-navigator.spec.tsx tests/client-search.spec.tsx tests/client-search-ownership.spec.ts tests/compat-files-page.spec.ts tests/client-files-provider.spec.ts`（指定七份规格） | 7 文件 148 用例全过，4.40s | 0 |
| `pnpm typecheck` | host + client tsc + auto-review 构建全过 | 0 |
| `pnpm compat:check` | 与 P0 一致，无漂移 | 0 |
| `pnpm docs:check` | 0 errors / 0 warnings | 0 |
| `git diff --check` | 无空白错误 | 0 |

新增回归 `tests/client-files-provider.spec.ts` 覆盖：`providerKey`/`treeBucketId` 区分同路径的会话/环境/根/代次；无 watch 的 list-only Provider 经真实 face+store 显式初始读（恰好一次 list 一条 entry）；hold 释放后迟到的旧响应不落盘；fake preview port 收到精确 `WorkspaceResourceRef` + `replaceTab`，死 signal 与缺 port 为 no-op；本地跨根资源零 wire 访问且 preview/openInApp 仍拼出 `dsh-resource://file` 地址。存量路径键控断言已迁移为 provider 键（fixture 的 `id`/`addedAt` + 实际 session）。

### P3（工作树，未提交，基于 `4fa56c4`）

| 检查 | 结果 | 退出码 |
| --- | --- | --- |
| `pnpm test tests/remote-files-service.spec.ts tests/remote-sftp.spec.ts tests/ssh-verifier.spec.ts tests/ssh-environment.spec.ts tests/ssh-environment-shutdown.spec.ts tests/remote-copy.spec.ts tests/remote-tools.spec.ts tests/remote-exec-root-identity.spec.ts tests/remote-personal.spec.ts`（指定九份规格） | 9 文件 158 用例过 / 1 skipped，10.94s | 0 |
| `pnpm typecheck` | host + client tsc + auto-review 构建全过 | 0 |
| `pnpm lint` | 0 errors（2 条既有 require-yield warning） | 0 |
| `pnpm docs:check` | 0 errors / 0 warnings | 0 |
| `git diff --check` | 无空白错误 | 0 |

新增 `tests/remote-files-service.spec.ts`（14 用例）覆盖：伪造/未知会话与未登记端点零开通道、opt-out 与 object 授权零开通道、过期令牌拒于 I/O 前、根与子级含字面反斜杠/空格/Unicode 名、符号链接祖先 `path-escapes-root` 且从不 READDIR、canonical 根重定向 `root-identity-changed`、挂起列举取消只关自有通道、4 并发 + 第 5 个 `resource-budget` 零排队、无关授权变更不打断在飞列举、撤权后旧数据不落盘、面板端点端到端 + 遍历/短令牌/多余键 `panel/bad-request`。`tests/remote-sftp.spec.ts` 新增 6 用例：严格 NAME/HANDLE/ATTRS 类型、斜杠名/空 NAME/重复名/致命 UTF-8 全 `invalid-listing`、wireBytes 超限截断、realpath/lstat 严格类型。未实现项：无（阶段内要求的用例均已落地）。

## 7. 退出验收

**全部强制门禁通过才可报告 PASS**：P2 本地 jsdom/compat 闸、P3 abort/budget/symlink 闸与隔离条件定稿、P4 三root对齐、P5 生命周期专项、P6 评审归档、P7 全量脚本 + 真实 SSH + 截图 + 矩阵。任一阶段以「环境原因跳过」记帐而非 PASS；P3 内 Helper 后端的否决结论是合法结果（fail closed 即完成），不算阻塞，但 Helper 证据缺失（既未证明 fd-bound 列举成立、也未给出否决结论）时整体不得记 PASS。
