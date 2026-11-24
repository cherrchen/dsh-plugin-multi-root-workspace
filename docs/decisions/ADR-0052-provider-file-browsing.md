# ADR-0052：按 Provider 分派的文件树浏览

## 状态

Proposed，2026-11-24。实施计划见[配套计划](../plans/active/2026-11-24-provider-remote-file-tree.md)；接受与否由维护者在 P1 合同评审时决定。

## 背景

Files 页签目前的附加根浏览是把**本地路径**当作身份来做的：选中的是一条 `RootView` 记录，但接管、树键、搜索记录全部以路径拼写键控。要让同一棵树浏览 SSH 远端 Workspace Root，路径身份不够用——两个不同环境可以拥有同一个路径拼写，同一环境重挂授权后路径未变而授权主体已变。

现状盘点（均以当前实现为准）：

- `RootSwitcher`（`src/client/RootSwitcher.tsx`）把选中的 `RootView` 存进每个 session 一份的 inject product、按 tab 分桶，接管记录以**路径**（`selectedPath`/`selectedId`）键控。
- `src/client/files-tree/adapter.tsx` 把懒解析的 DSH `remote.workspaceFiles` 命名空间绑定到 `filesFace`（`createList`/`createWatch`），本地树只认识这一个数据源。
- `src/client/files-tree/directory-node.ts` 的目录展开以 `watch` 迭代器的 ready 事件为门：先等 watch-ready，再消费 change 流；宿主不支持时按 `workspace-file/watch-unsupported` 退化。
- 旧版与受控两种树渲染器派生子项键都走 `childPath`（`src/client/files-tree/face.ts`）：`parent.replace(/[/\\]+$/, '') + '/' + name`，即裁剪尾部斜杠/反斜杠后拼字符串。
- 搜索状态（`search-state.ts`）以 `(tabId, rootPath)` 拼 `searchStateKey` 键控；Viewer 与行菜单消费的是本地地址（`fileAddressFor` + `sidebarRight.openResourceIn`）。
- 预览页 Folder 导航树（`navigator.tsx`）持有 hold/release 与 pane 记录记忆（`expanded`/`scrollTop`/`revealed` 随 pane 存活）。
- 原生主根路径与第三方插件接管时的静默退化保持不变。

远端侧的既有事实（本次 PoC 与代码核对）：

- `src/remote/sftp.ts` 的 `SftpClient` 可独立开 stdio SFTP 会话；对 `/usr/libexec/sftp-server -R` 的本地 PoC 观察到：协议 v3、POSIX 反斜杠与 Unicode 文件名按字面透传、目录项带 mode 位、`realpath` 给出重定向后的 canonical 路径、**不暴露 inode**。
- `src/remote/ssh-verifier.ts` 的 SFTP 端点校验只做 `realpath` 等于声明路径 + `isDirectory`，无 inode 可比，校验与后续 OPENDIR 之间的同名替换无法检出（源码注释亦自述此边界）。
- Helper 端 `fs.list` 走 `ctx.fs.listDir(target, signal)`，返回**数组**，没有按目录句柄（fd-bound）约束的列举原语。
- Broker（`src/remote/broker/`）协议目前只有进程 watch/stdio，**没有目录流方法**。
- `src/remote/personal/remote-paths.ts` 的目录选择器浏览是登记前的一次性列举，不是会话内持续浏览的语义。

## 决策

### 1. 逻辑身份与显示路径分离

根的逻辑身份是判别联合：

```text
RootRef = { kind: 'primary' }
        | { kind: 'additional', rootId }
        | { kind: 'remote', environmentId, rootId }
```

树内节点身份是 `{ root: RootRef, relativePath }`——根引用加根内相对路径。**显示路径只是元数据，不是身份**：远端路径拼写、本地 canonical 拼写、`user@host:port/path` 展示串都只用于呈现与诊断，绝不参与键控、授权或回写。两个环境共享同一路径拼写时身份仍不同；同一环境重挂授权（`bindingDigest`/授权代次变化）后旧身份自然失效。

### 2. 树键包含授权代次，异步生命周期不当身份用

树、搜索、导航记忆的状态键由 **session + tab/pane + RootRef + 授权代次（authorization incarnation）** 组成：授权撤消再授予即换代，旧键下的展开/滚动/搜索记录不得复活到新授权上。Provider 实例与记录信号（hold/release、dispose、opening 替换）是**异步生命周期信号**，参与资源回收与陈旧判断，但不是身份；SSH 侧的 generation（Helper/连接代次）只是**传输层事实**，不得升格为树键成分。

### 3. Provider 端口与本地拼写保持

本地与 SSH 是同一 Provider 端口的**独立实现**；浏览器组合根里的 resolver 按 RootRef 分派到实现。端口最小面是资源绑定的 `list`（句柄随 pane/接管生命周期释放），可选 `watch`/`search`/`preview`/行动作；GUI 行意图（打开、reveal、上下文菜单目标）一律经 Provider 端口分派，组件不自行拼地址。本地实现经 adapter 保持现有 `workspaceFiles` API 拼写不变——本地调用形状、错误码与退化行为逐字节对齐当前 fork。远端树键是**合成标识**，绝不当本地路径喂回 `openResourceIn`、`fileAddressFor` 或任何 workspaceFiles 调用。Provider 没有 `watch` 时的语义是**显式初始读、无流**：不做伪 ready 事件、不做轮询伪装。

### 4. Host 侧：独立端点 + 显式 UI 只读准入

Host 计划新增严格独立的 `remoteFiles.list` 端点（不复用 `workspaceFiles` 上行线，不伪造工具调用），会话权威照旧由 Host 从存活 session 推导（ADR-0008 同则）。授权走一条**显式声明为 UI 只读**的新入口，以 `purpose: 'read'` 进入 Registry 有序准入——绝不拿假 `exec.name` 骗 `toolAccess` 上限。网络 I/O 前后各取一次有序准入（前：授权在读时点上成立；后：读结果发布前授权未被撤）；Registry 秩序临界区内**不做任何网络 I/O**。错误只出经消毒的稳定码。原生 owner 变更（Registry 记录改写、授权撤消）触发失效，与既有变更通知同源。

### 5. 通道与预算

凭据与连接托管留在各自 manager：personal 由 `ssh-environment`、broker 由 broker client 持有，浏览不另建凭据通路。浏览用**请求自有的有界 SFTP 通道**：生命周期绑定本次列举，绝不 dispose `remote_copy`/共享缓存通道（共享通道被单请求中断牵连的教训见外部评审）。接受每个目录项之前先过流式预算——条目数与累计字节有界，超限即拒绝而不是截断后默默返回。

### 6. 各后端的诚实边界

- **SFTP（path 后端）**：校验只覆盖 canonical 路径 + mode 位，无 inode，校验与 OPENDIR 之间的符号链接竞争不可排除。**不得宣称任何 SFTP 后端对并发恶意 rename 健壮。** 该后端只在附带书面隔离条件（P3 定稿）下准入，且**绝不用于 Helper 对象（dev:ino）授权**。
- **Helper（object 后端）**：`listDir` 返回数组、无 fd-bound 列举；需要一份「对已准入 dev:ino 的目录、在真实 confinement 内做有界、按描述符锚定列举」的证据（实现或否决性证明），否则该后端 fail closed，不随本批发布。
- **Broker**：当前无目录流方法；没有兼容端口时 fail closed，不绕过 broker 自行开直连。

## 备选方案

- **给上游 `workspaceFiles` 线加根字段。** 上游线无法命名根/环境，且本插件不改上游包；与 ADR-0041 对 search 的同一结论一致——走插件自有通道。
- **复用 `remote_copy` 的共享 SFTP 会话做浏览。** 取消语义与生命周期耦合，单请求中断会伤及在飞传输；评审已记录同类故障模式。
- **以路径拼写当身份。** 跨环境路径撞名、重挂授权后旧状态复活、远端路径被当本地路径回写，三条都已在现状盘点中显形。
- **远端映射为本地 URI 再喂 `openResourceIn`。** 会让合成键泄漏进本地消费者，违反「远端树键绝不当本地路径」。
- **借 `tools/execute` 派发做浏览授权。** 浏览不是模型工具调用，假工具名既污染 `toolAccess` 语义也无对应 `exec.name`；选择显式 UI 只读准入入口。
- **为远端做伪 watch（轮询/一次性 ready）。** 伪流会让 DirectoryNode 的「watch-ready 才消费」语义失真，且掩盖「无流」真相；选择显式初始读。

## 影响

- 树、搜索、导航键控从「路径」改为「RootRef + 授权代次」：本地三键（session、tab/pane、根）保持等价语义，远端获得互不串扰的状态空间。
- Provider 端口是本地 fork 与远端实现之间唯一的接缝：本地 API 拼写不变保证旧宿主与主根零变化，远端能力差异（无 watch、无 search）在端口上以「缺省即无流/无面」表达。
- 授权语义收紧：浏览准入显式声明 UI 只读目的，网络 I/O 不进入 Registry 临界区，撤权在两个准入点之间必然被截获。
- 明确不承诺的安全边界：SFTP 校验—OPENDIR 竞争窗口、Helper 无 fd-bound 列举、Broker 无目录流——三者在证据补齐前分别「条件准入 / fail closed / fail closed」。
- 计划文档的 P0–P7 管线按此决策排布；P3 结束时要拿出 SFTP 隔离条件定稿与 Helper 后端证据或否决结论。

## 实施记录

- **P1（合同落地）**：`src/client/files-tree/provider.ts` 按本文 §1–§3 落地身份与端口类型 + `rowActions` 分派适配；`providers/resolver.ts` 为唯一组合槽，`providers/local.ts` 为本地实现（唯一 `fileAddressFor` 调用点）。
- **P2（本地迁移 + 门禁）**：fork 树/RootSwitcher/搜索态/导航记忆全部迁移到 provider + `providerKey`/`treeBucketId` 键控；指定七份 jsdom 规格 148 用例全过、`pnpm typecheck`/`compat:check`/`docs:check`/`git diff --check` 全零。证据明细见实施计划 §6。
- **P3（Host 列举服务，`a45e62c`）**：`remoteFiles.list` 契约（严格 schema、五预算、17 个稳定错误码）+ `RemoteFilesService`（并发 4 零排队、12s 含准入期限、双准入令牌比对、仅本端点撤权取消）；准入唯一条件为 per-binding `directoryListing:'stable-path'`——SFTP ABA 窗口无法以原语消解，此为部署断言非运行期证明；object 授权/Helper/Broker 一律 fail closed（Helper 本轮否决：无 fd-bound 列举证据）。自有有界 `openFilesSftp` 通道独立于 `remote_copy` 会话计数；`readdirBounded` 严格类型 + 致命 UTF-8 + wireBytes 截断；`browseAuthorization` 仅在 snapshot 与 live manifest digest 一致时签发。指定九份规格 158 用例过、`typecheck`/`lint`/`docs:check`/`diff --check` 全过，明细见实施计划 §6。
- **P4/P5（浏览器侧与生命周期，检查点 `ede0ee1`）**：浏览器 `RemoteFilesClient`（`list` + `wait`，`PANEL_CHANNEL`，严格响应解析，固定错误词表）；`providers/ssh.ts` 远端 provider（`treeRoot='/mrfw'`、`retainHiddenLevels:false`、无 watch/search/preview/menu/openInApp，仅 7 个授权类码触发 invalidated）；`resolver.ts` `Local|Remote` 顶层判别式选择记录 + 单开关工厂分派；`RootSwitcher` 远端行发现/禁用标签/token 对账，选择仅当新鲜 RemotesView 的 `browseAuthorization` 仍等于 incarnation 才挂 provider——换代即整记录失效落回 primary 不升级；授权租约 `remotes.waitForAuthorizationChange`（上限 16 零排队、4s 准入上界、15s 租约、元数据租约非 FS watch）；`remotesViewOf` 改在 `remoteList` 之后重读 manifest 再比对 digest；`service.supports` 并入 manager `capability.eligible`；个人配置 Helper-less 环境新增默认关闭 `directoryListing` 复选框（8 语言）；owner 死亡观察器连带清该 owner 持久选择。指定九份规格 274 用例过、`typecheck`/`lint`/`docs:check`/`diff --check` 全过，明细见实施计划 §6。
- **P4/P5 复审返工（检查点 `ede0ee1`）**：`RootSwitcher` 远端证明先于 provider 缓存命中（fresh `remoteRootSelection(endpoint)?.incarnation === selected.incarnation`）；`invalidateNow` 与发现失败/对账失效一律「live takeover 键 + 当前选择推导键」双闸匹配；租约循环 `AbortSignal.any` 合并 takeover 与次发中止；`refreshRemotes` 每次发现换新 `AbortController`；依赖取 `filesTree?.takeover`/`observeAuthority` 稳定座；远端 provider 开门限定 `pane !== null` + live session。`RemoteFilesService.wait` 租约内准入限流：同 token 在飞准入复用 + `pending` 集合于 slot 释放前 `allSettled` 排空（取消+重投不得绕过 16 上限）；编码失败先 `stateAbort.abort(error)` 再排空。新增回归：取消 16 条租约后新租约仍 `resource-budget` 直至底层 settle；`remotes.list` 换代发现路径（非仅租约失败）不再绘旧行也不提前列新根；被取代 provider 的迟到 invalidated 回调不弹出当前选择。真实 SSH loopback 与真 Chromium GUI 证据、版本×OS 矩阵缺口见实施计划 §8。规范文档：[file-browsing-providers.md](../architecture/file-browsing-providers.md)。
- **P6（预览端口评估，已完成，检查点 `ede0ee1`）**：fake-port 探针三条既有回归（`client-files-provider.spec.ts` 的 preview 端口手势/死 signal/缺端口 no-op）验证「选择 + 失效」机制可复用；结论为**预览端口暂不放行**——远端内容读取协议未定义、未接线，保留 fake 实现与失败关闭。架构与安全记录归档于 `docs/architecture/file-browsing-providers.md`。
- **P7（全量门禁 + 真实 SSH + GUI + 矩阵）**：**PARTIAL PASS**。跑过：`pnpm verify:all` 全段绿（2771 用例）、聚焦规格复测 4 文件 109 用例、真 Chromium 远端树/菜单截图（`.dsh-smoke/gui/`）、用户态 `sshd` loopback 上的生产 `SftpClient` 列举（`tests/ssh-loopback.e2e.ts`）。未跑：其余 25 个 DSH 发布与 CI macos/ubuntu/windows 车道（矩阵源 26 个精确发布、SSH 地板 5 个 `0.2.2-rc.1`–`rc.5`，仅本机 `0.2.2-rc.5` macOS 实测）、完整生产 DSH↔SSH 链路（`ssh -G` 身份校验按设计读用户 `~/.ssh/config`）、真实宿主 GUI 视觉对齐、远端 bash/copy 实机用例。验收明细与诚实限制见实施计划 §8。
- **P4/P5 终审补丁（检查点 `ede0ee1`）**：`providers/ssh.ts` 的 `listDirectory` 三个 signal 闸（请求前/await 后/catch 中先于 `failureOf`）——目录信号已止的迟到授权类失败不再触发 invalidated，非编码错误一律本地化 `connection-failed` 不回传原文；`RootSwitcher` `setSelected` 同步写 `selectedRef`（layout effect 跟随），租约循环改用种子选择 + 键匹配闸；`wait` 到期序列改为先停通知/等在飞重准入/全新最终准入，`admit` 并入 `manager.capability?.eligible` 闸；合同新增 `pathBytes:4096`/`absolutePathBytes:8192` 字节界（相对路径按 UTF-8 字节、opt-in 根路径 manifest 期拒绝、通道开启前装配路径预检）。

## 相关

- [配套实施计划](../plans/active/2026-11-24-provider-remote-file-tree.md)
- [外部评审：SSH 分支增量审查（2026-11-21）](../reviews/2026-11-21-ssh-branch-review.md)
- [ADR-0008](./ADR-0008-panel-session-derived-authority.md) — Host 推导的会话权威
- [ADR-0015](./ADR-0015-files-tab-plugin-owned-browsing.md) / [ADR-0016](./ADR-0016-files-tab-native-tree-fork.md) — Files 页签接管与原生树 fork
- [ADR-0030](./ADR-0030-environment-and-root-identity.md) / [ADR-0031](./ADR-0031-filesystem-routing.md) — 环境与根身份、文件系统路由
- [ADR-0041](./ADR-0041-additional-root-workspace-search.md) — 插件自有通道上的根命名搜索（同一「上游线无法命名根」结论）
- [ADR-0043](./ADR-0043-additional-root-preview-navigator-search.md) — 预览导航树的搜索接管
- [ADR-0049](./ADR-0049-ssh-custody-modes.md) — 凭据托管分档
