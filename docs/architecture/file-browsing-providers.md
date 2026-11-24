# 架构文档：Files 标签页的文件浏览 Provider（本地 + SSH 远端）

> 状态：**已实现**（P1–P5，见[实施计划](../plans/active/2026-11-24-provider-remote-file-tree.md)；决策记录 [ADR-0052](../decisions/ADR-0052-provider-file-browsing.md)）。尚属 Target：预览面板（preview）对远端根的扩展——其 fake-port 探针结论已记录但未接线；远端文件内容读取协议未实现。
> 相关文档：宿主侧 RPC 契约与服务的实现细节见 ADR-0052 与本文件 §6；用户配置见 [SSH 远端环境使用指南](../guide/user/ssh-remote-environments.md)；Fields 树 fork 的上游对齐职责见 [FORK.md](../../src/client/files-tree/FORK.md)。

## 1. 总览

Files 标签页的根切换器（`RootSwitcher`）把「当前浏览的目录树」抽象为 `WorkspaceFilesProvider`。主根由上游原生 Files 树绘制；每个附加本地根与每个已登记的 SSH 远端绑定各由一个 provider 实例接管同一面板区域。远端与本地共用同一棵 fork 树（`files-tree/`），共用接管（takeover）、展开/滚动记忆与失效路径——远端不引入独立渲染器，浏览器 bundle 不 import 任何 SSH 代码。

```text
宿主进程（node）                                浏览器（client bundle）
┌──────────────────────────────┐             ┌──────────────────────────────────┐
│ RemoteFilesService           │             │ RootSwitcher（files.actions 占位）│
│  ├─ list（名额/期限/双重准入）│             │  ├─ remotes.list 发现（每代一       │
│  └─ waitForAuthorizationChange│◄── RPC ────┤  │   AbortController，替换即中止） │
│     （元数据租约，16 并发封顶）│ PANEL_CHANNEL│  ├─ FilesRootSelection 联合        │
│        │                      │             │  │   {kind:'additional'|'remote'} │
│        ▼                      │             │  └─ selectedProvider（一槽缓存）   │
│ SshEnvironmentManager        │             │        │                          │
│  └─ openFilesSftp（8 通道封顶）│             │        ▼                          │
│        │                      │             │ resolver 单点 switch              │
│        ▼                      │             │  ├─ local 工厂 → WorkspaceFiles   │
│ SftpClient（ssh -s … sftp）   │             │  │   Provider（workspaceFiles RPC）│
│  └─ readdirBounded/realpath/  │             │  └─ ssh 工厂   → WorkspaceFiles   │
│     lstat（严格帧解析）        │             │      Provider（remoteFiles RPC）  │
└──────────────────────────────┘             │        │                          │
                                             │        ▼                          │
                                             │ 同一棵 fork FilesPane/TreeView    │
                                             │（接管面板 body；门户+失效同一套） │
                                             └──────────────────────────────────┘
```

## 2. 组件依赖

```text
client.apply（src/client/index.ts）
  └─ createFilesTreeSeats(ctx, {panel, remoteFiles, preferences})
       ├─ store / inject ──► slots 注册（files.actions / document.actions）
       ├─ lazyFilesRemote ─► ctx.get('remote' | 'remote.workspaceFiles')   ← 本地 provider 的线端口
       └─ remoteFiles ─────► createRemoteFilesClient(connectionHandle)      ← SSH provider 的线端口
  └─ FilesActionsOccupant ─► createFilesTreeSurface(props, t, seats)
       └─ resolver.resolveWorkspaceFilesProvider(selection, {local, ssh})
            ├─ providers/local.ts   listDirectory → workspaceFiles.list / changes
            └─ providers/ssh.ts     listDirectory → remoteFiles.list
```

依赖方向全部向内：provider 只依赖「线端口 + 身份」，`RootSwitcher` 只依赖「选择 + surface」，宿主侧只依赖「RPC 契约 + 环境管理器」。`remoteFiles` 席位缺省（无 Connection）时 `ssh` 工厂为 `undefined`，远端行仍出现在菜单但不可选——与本地附加根在 tree 不可挂载时同一降级形状。

## 3. 资源 vs 身份 vs 权威 vs 传输

| 概念 | 拼写 | 语义 |
| --- | --- | --- |
| 资源（resource） | `/mrfw` 树内的相对路径（provider 的 `treeRoot` 下） | 只是键：定位树节点与 RPC `relativePath`，不带权限 |
| 身份（identity） | `{sessionId, environmentId, rootId}` + `incarnation`（浏览令牌） | 一次「绑定 + 登记 + 令牌铸造」的唯一化；令牌是 HMAC 化的授权摘要 |
| 权威（authority） | 宿主 `RemoteFilesService` 的双重 `admit` | 每次 list 在 SSH I/O 之前与返回字节之前各做一次准入；比对令牌散列与代际 |
| 传输（transport） | `SftpClient`（`ssh -s <alias> sftp`） | 只承载帧协议；不携带、也不推导权限 |

选择（`FilesRootSelection`）携带 ref + incarnation + path + view 四类字段：展示元数据与身份字段分开存放，展示字段从不充当身份。`providerKey` 由 ref + incarnation + sessionId 导出——同一 environmentId/rootId 的两次授权产生不同 providerKey，旧缓存与旧回调天然失配。

## 4. 能力矩阵

| 能力 | local provider | ssh provider |
| --- | --- | --- |
| `treeRoot` | 根绝对路径 | `/mrfw`（虚拟前缀；资源经 `validRemoteRelativePath` 还原为相对路径） |
| `listDirectory` | `workspaceFiles.list` | `remoteFiles.list` RPC |
| `watch` | `workspaceFiles.changes` 流 | **无**（见 §6 元数据租约） |
| `search` | 宿主搜索席位（可用时） | **无** |
| `preview` / 打开文件 | `sidebarRight.openResourceIn` | **无**（文件行惰性，点击不产生本地查看器） |
| `menu` / context menu | 宿主菜单注册表 | **无** |
| `openInApp` | 有（真实路径） | **无**（`rootResource` 无适配器即不渲染，无 triggerPath 兜底） |
| `joinChild` | 平台 join | `` `${parent}/${name}` ``（POSIX 语义） |
| `retainHiddenLevels` | 保留本地页签既有驻留行为 | `false`——隐藏即结束接管，重挂时重新准入和列举 |

## 5. 时序

### 5.1 本地附加根（既有路径）

```text
用户点击菜单行「payments」
  → selectRoot(selection{kind:'additional'})            会话作用域快照，按 tabId 键控
  → selectedProvider: resolveWorkspaceFilesProvider      local 工厂，providerKey=root ref
  → takeover effect（key+signal 校验一致才接管）
  → FilesPane 门户进 data-files-body；DirectoryNode.load → workspaceFiles.list
  → watch: changes 流 push change → 目录节点增量刷新
```

### 5.2 SSH 远端根

```text
打开菜单 → refreshRemotes: remotes.list（代际+中止守卫）
  → remoteRootSelection(endpoint): 仅 registered+read+有 browseAuthorization 才可产选择
用户点击「out · Build Box (device) · /srv/root · SSH」
  → selectRoot(selection{kind:'remote', ref:{environmentId,rootId}, incarnation})
  → selectedProvider: 先校验当前 remotes 视图仍存在同 rootId 且
       remoteRootSelection(endpoint)?.incarnation === selected.incarnation（新鲜证明）
       否则不落 providerCache、立刻 key 化 invalidateNow + 回退 primary（不自动升级）
  → ssh 工厂造 provider（remoteFiles 席位缺失 → 无 provider）
  → observeAuthority 租约循环（takeover.signal + AbortController 合并信号）
       └─ RPC remotes.waitForAuthorizationChange{…, authorization:incarnation}
  → DirectoryNode.load → provider.listDirectory
       └─ remoteFiles.list{sessionId,environmentId,rootId,relativePath,authorization}
            宿主侧：名额 → 双重 admit → 打开 SFTP → probe(root/祖先/目标)
            → readdirBounded → 终 admit → 响应
  → 失配时（令牌重铸/绑定变更/连接丢失）wait 以固定错误码终结
       → invalidateNow(owner,key) 校验仍为当前接管后中止+遗忘并回退 primary
```

### 5.3 失效错误码的处理二分

仅授权类错误码终结 provider：`provider-unavailable`、`capability-unsupported`、`session-unavailable`、`root-unregistered`、`root-identity-changed`、`binding-changed`、`environment-changed`。**不**失效： `permission-denied`（目录级 FS 语义，行内错误）、`resource-budget`、`connection-failed`、`timeout`、`cancelled`、`invalid-listing`（单请求错误，树保持 ready）。

## 6. 元数据租约（不是文件监视）

`remotes.waitForAuthorizationChange` 是**授权元数据租约**，不是文件系统监视：请求体只有 `{sessionId, environmentId, rootId, authorization}`（`remoteFilesListRequest` 去掉 `relativePath`），成功响应为 `{unchanged:true}`。宿主侧行为：

- 独立并发上限 16、零排队（超额即 `resource-budget`）；等待通知的窗口为 15 秒，首次、通知及最终准入分别有 4 秒的响应预算。
- 租约内对 `onRemoteChange` 通知做 dirty 合并重准入；释放前 `await Promise.allSettled(pending)`——取消的租约在其底层准入真正落地前**不释放名额**，连续取消+重投无法绕过上限。
- 仅在新的最终 `admit` 仍成立时返回 `{unchanged:true}`；准入失效或预算耗尽时以固定错误码终结租约。租约不探测 SSH 连接或远端文件。
- 客户端在 takeover 存活期间循环续租（每次单独请求）；隐藏页签、关面板、卸载、会话切换都合并进中止信号立即放租。**租约存活期不产生任何远端 I/O**——无 OPENDIR、无 stat、无轮询。

## 7. 生命周期

```text
select ──► provider 创建（一槽缓存 {key,provider}）
   │          │ fresh 证明失败 → 不落缓存，key 化 invalidateNow
   ▼          ▼
接管 FilesPane（owner=occupant, providerKey）
   │ observeAuthority 租约循环存活
   ▼
三类终点：
  ① 面板隐藏/页签关闭 → 立即结束远端接管，不保留列举结果、展开或滚动位置
     （retainHiddenLevels:false；未关闭的页签可保留选择，同代次重挂也重新列举）
  ② 租约终结（授权类错误码）→ 中止+遗忘桶/搜索/记忆，回退 primary + refreshRemotes
  ③ 会话切换/组件卸载 → 合并中止信号触发，remoteDiscovery 中止，无全局可变态残留
```

本地接管沿用原有驻留语义（`retainHiddenLevels` 不设）；远端由 provider 显式声明生命周期策略，核心 UI 不做环境特判。

## 8. 有界安全姿态

- **浏览器零 SSH**：client bundle 不含 `src/remote/*` 传输代码；唯一的远端面是 `PANEL_CHANNEL` 上两条 RPC（`remoteFiles.list`、`remotes.waitForAuthorizationChange`），全部经严格 schema 解析。
- **固定错误码词表**：17 个稳定码；传输层任何异常折叠为固定码，绝不向 UI 透传原始 SSH 文本；listing 载荷双重限界（条目数 + 序列化字节）。
- **字面路径保真**：POSIX 名字逐字节透传（空格、Unicode、字面反斜杠均是合法段）；`readdirBounded` 对非法 UTF-8、重名、越界名直接 `invalid-listing`，预算触顶返回前缀而非挑短名。
- **身份探测**：`probe` 每次先对 root 做 `lstat`（拒绝符号链接置换，不跟随），`realpath` 前后各一次规范祖先校验；段级 `lstat` 先于 `realpath`。
- **部署断言非运行时证明**：绑定的 `directoryListing:'stable-path'` 要求浏览期间不可信进程无法替换根、祖先或根下目录，也无法改变挂载或符号链接解析。Host 清单校验权威，GUI 仅为无 Helper 的纯 SFTP 绑定暴露默认关闭的勾选。
- **授权不落盘**：浏览令牌仅存于会话内 RPC 与内存选择；菜单与 header 只展示 `rootId · 环境名 · 路径`，不展示凭据或 `target` URI。

## 9. 面板适配与搜索偏好

本地 provider 的搜索席位按能力探测（`search` 方法存在时接线 `useSearchState`），菜单/打开方式沿用宿主注册表；`searchSeat` 仅在选中 provider 声明 `search` 时暴露，搜索 key 只在能力/记录匹配期有效。远端 provider 不声明这些能力——同一面板代码天然走「无搜索、无菜单、无打开」分支。会话切换 mint 新 inject 产物，选择不跨会话泄漏；owner 死亡由接管文档观察者清扫（仅匹配 owner/key）。

## 10. Target：预览面板扩展（未实现）

预览面板（document preview 的 `NavigatorRetarget`）目前只对本地附加根改向。远端预览需要内容读取协议（`remoteFiles.read` 或等价物）——fake-port 探针已验证「选择+失效」机制可复用，但读取协议未定义、未接线。按本文件 §6，预览扩展不得引入文件监视或长连接流。
