# 按 Provider 分派的远端文件预览（冻结合同）

> 状态：**已实现，待维护者审查，未发布**。实测组合、旧宿主降级与未验证场景见[验收报告](../plans/completed/2026-11-27-provider-remote-file-preview.md#最终验收报告)；决策见 [ADR-0053](../decisions/ADR-0053-provider-remote-file-preview.md)，承接 [ADR-0052 的远端浏览分层](file-browsing-providers.md)。

远端文件预览让 Files 页签里的 SSH 远端**普通文件行**经插件自有的 Resource/Viewer 打开只读内容，并复用同一棵 `FilesPane` 做远端 Navigator。Viewer 的外层视觉与基础交互对齐宿主文档预览（38px 路径头、查看器选择、换行/刷新/目录树工具、居中状态、源码/Markdown 排版、可拖宽的 push/overlay/fill Navigator），但这是插件独立实现的**视觉适配**，不是复制或挂载上游 Viewer 内部组件树；远端授权、一次性完整读取、安全子集与无 `open-in-app` 的合同不变。全部路径都建在既有构件上：DSH Tab/Dockkit、`resources`/`sidebarRightTabs`、Connection binary attachment、托管的 SFTP v3 通道与 Registry 逐次有序准入。**不引入**编辑、落盘、回写、watch、轮询、搜索、LSP、diff、下载、挂载、同步、新 transport/凭据或上游修改/原生 Viewer fork。

## 1. 数据通路与复用端口

完整链路：

```text
RootSwitcher/FilesPane → SSH WorkspaceFilesProvider.preview
  → opaque Remote Resource router
  → DSH resources/sidebarRightTabs/Tab/Dockkit
  → 插件 Viewer（可选内嵌同一 FilesPane 作 Navigator）
  → RemoteContentProvider.read(resource, signal)
  → RemoteFilesClient.read(request, signal)
  → PANEL_CHANNEL remoteFiles.read
  → RemoteFilesService
  → live Registry 有序准入 + owned SFTP v3
```

- **复用 provider 端口**：`WorkspaceFilesProvider.preview` 是可选端口；SSH provider 在行打开时调用 `preview.open`，由它走 `sidebarRight.openResourceIn`，`replaceTab` 使用**真实 tab ID**（不使用 pane id 当 TabId）。本地 Viewer 路径完全不变。
- **记忆键**：Navigator 的展开/滚动/reveal 记忆以 `session + provider incarnation + PaneId` 键控，pane 移动不吊销授权。
- **reveal 输入**：FilesTree 接受判别化/类型化的相对路径 reveal 输入；远端键绝不经过本地 `relativeUnderRoot`（它会把字面反斜杠规范化）。
- **行闸**：只对普通文件行（既有 row kind）开放预览；打开时复核根范围、非空已验证路径、活 grant 与 Viewer candidates——**Host 不信任行类型**，所有校验在服务端重做。

## 2. 资源地址与不透明身份

- 复用 `FilesProviderIdentity + WorkspaceResourceRef`：`session/env/root/incarnation/path`，不含绝对路径与远端 target；身份在关闭或授权失效前稳定。
- 资源地址是内存中的随机 UUID v4：`dsh-resource://mrfw-remote/<uuid>`。地址**不携带**任何会话、环境、根、授权或路径事实——实时条目以逻辑键（identity + path）映射，同一键复用同一 id 以便去重。
- 生命周期：条目在最后一次 DSH 资源 pin（occurrence 生命周期）释放；打开失败、失效、被替换、dispose 的条目移除；总数有界。
- 资源流只承载**元数据与生命周期**（地址/身份/标签/失效信号），不承载内容快照——上游 resource 语义在失败时保留上一次成功值，故字节帧绝不经过 `ctx.resources`；内容读取走独立的 content-view 端口并经 generation+signal 围栅。
- 语法兼容陈旧地址：过期地址仍是合法拼写，Viewer 可以渲染显式失效态；**无持久化身份查找、凭据、权威摘要或内容**——reload 后已释放记录不可复活，fail closed。
- 头部路径沿用宿主 `PathLabel` 的目录/文件名排版，但目录部分只由环境标签、root ID 与相对路径组成；绝不显示原始 SSH target 或远端绝对路径。
- Viewer 在 occurrence pin 到位前只显示加载状态，不启动读取；pin/lease 与 Body 分开管理。`keepMounted:false` 允许卸载非活跃 Body；隐藏时丢弃内容，关闭/替换经 tab signal 中止，活跃 session、Viewer 本地 signal 与请求 generation 围栅迟到读取。

## 3. 授权：`filePreview:'stable-path'`

- 独立 opt-in，默认缺席（不随 `read` 或 `directoryListing` 继承）；前置条件是已具备 `read` 与既有 `directoryListing` opt-in。
- 新增断言显式保护**目标文件名/对象映射与全部祖先、挂载、符号链接、硬链接来源**在整个操作期间稳定（可信部署语义，非 inode 保证）。
- 旧 manifest 不迁移到该权限；绑定摘要包含该字段，保存等价比较亦包含该字段。
- 共享租约复用 `browseAuthorization` 摘要作为 incarnation：它是对**实时四元组**（存储 epoch、授予登记、绑定摘要、环境摘要）的普通 SHA-256——不是 HMAC、凭据或独立授权证明。
- Host 的每次操作在 Registry 上做初始/复核/最终三段独立准入，与摘要无关；准入内部显式要求 `filePreview`。仅 `list` 权限无法读文件。
- 预览设置变更走正常的绑定摘要重登记/重选语义；`browse` 能力独立。
- 范围仅个人托管（SFTP 直连与带独立 SFTP 路径授予的 Helper；其余 transport/custody 一律 fail closed）。
- `RemoteEndpointView.preview?: 'sftp-binary-v1'` 仅为发现提示：只在 `browseAuthorization` 与 Host 服务/transport/标志门禁全部通过后设置；未知或缺失值只丢预览。服务/Host 处理器内部同样有 API 门禁，旧 Host 保持 list-only 兼容。
- 客户端额外要求 RPC 服务与活的 Viewer candidates；初版仅限 `0.2.3-alpha.2`，其余 exact peer 支持不变。扩大预览支持前须给对应版本补生产内容链路证据。
- 不维护第二份版本真值表：版本门只有 `src/compat/remote-file-preview.ts` 一处。

## 4. `remoteFiles.read` 线协议

单一严格操作（本 release 无 stat/range）：请求 `{sessionId, environmentId, rootId, relativePath, authorization}`（`relativePath` 非空）。

- Host 发 `{ ...metadata, bytes: null }` + 恰好一个 `{ path: ['bytes'], bytes }` binary attachment；metadata 为 `kind:'file', size, modifiedAt?, complete:true`，线端严格，JSON 只承载元数据。
- Connection 自身校验 multipart 数量/路径/类型并还原为单个 `Uint8Array`；客户端再做严格终形校验 + 实际长度核对；无附加字段、无 JSON fallback。
- 双侧强制 2 MiB 上限；空文件以零字节附件承载；客户端判定不支持的类型只展示元数据或状态；超限报稳定错误、绝不截断。
- 永不记录 Host 原始异常/stderr/路径/授权材料。

## 5. Host 读取管线（单 owned channel 全序）

整个读取在同一条 owned channel 上完成，可取消、有序准入：

1. 有序准入 → LSTAT 根 + canonical `realpath` 并 LSTAT 祖先与目标（仅常规文件）+ canonical 最终路径；
2. 严格只读 OPEN → FSTAT（必须仍是常规文件类型且大小/元数据匹配——只核对 size/mtime 不够，非常规 mode 即 `file-changed`）；
3. 深度 1 的串行 128 KiB READ（`maxReadRequests` 65 含 EOF；允许正向前进的短 DATA，禁止零进展；精确 size 与 EOF 确认）；
4. 发布前再次 FSTAT（常规类型 + 比对）+ **整条祖先链与 canonical 根的重探针**（目标自身 lstat/realpath 仍可答不能豁免祖先中途被替换）→ 通道存活内严格 CLOSE；
5. **先关闭 owned channel**（回收在最终证明之前完成，撤权落进 dispose 窗口也不会带出字节；复核监听器在关闭期间仍挂载）→ drain 通知复核 + 全新最终有序准入 → 返回；槽位在读取清理与最终证明都结束后才释放。

取消关闭自有 channel 并持位到实际清理完成；Registry 临界区内无 SSH I/O。size/类型/观察到的 mtime 变化一律拒绝 `file-changed`（不是强快照）。拒绝 FIFO/link/device/unknown；SFTP v3 无 inode/fd-bound/ABA 防护，无法证明硬链接来源、无法防御远端并发恶意改名——`stable-path` 断言覆盖探针之外的部分。

错误语义：permission/not-regular/missing/too-large/changed/invalid-content 是文件本地失败；授权失效独立；载体/预算/取消语义稳定；文件级失败绝不逐出树。Broker 无自有文件方法、不复用传输配额；不绕过 broker/transfer 预算。

## 6. 租约、客户端预算与渲染边界

- 每个 `session/env/root/incarnation` 一份共享引用计数元数据租约，供树/Viewer/Navigator 三方；只在最后观察者释放；disposal 后不再续租；待决租约提交有界（沿用 Host 16 上限）；避免 cancel/resubmit 洪泛；权威不可判定时 fail closed；无轮询、无陈旧文件系统内容。
- 客户端预算：至多 8 个活资源记录、4 个保留 Viewer 内容、2 个在途读取。满额时，Folder 原位替换可暂存一个仅含元数据的候选。宿主提交替换并移除旧资源的最后一个标签后，新资源接过旧槽位；打开失败时旧标签和内容保持可用。需要第 9 个活资源时提示用户关闭一个预览标签。关闭、卸载或取消即释放，无共享文件缓存、Blob 或落盘。
- 渲染：Markdown ≤128 KiB / ≤4096 节点，按安全白名单文本 AST 渲染；标题、段落、列表、引用、围栏代码与粗体/斜体/行内代码可呈排版样式，但仍无图片、HTML、链接、网络或远端内嵌，链接/图片语法只作为文本而非活动对象。语法类与主动格式（HTML/SVG 等）一律源码回退；致命 UTF-8 校验（BOM 剥离），拒绝 NUL/二进制控制；空文件与无扩展名接受；PDF/Office/其他二进制只报元数据/不支持；无位图图片；超限 Markdown 回退源码。
- 资源 tab 标题和图标采用宿主公开原语，Viewer 对各版本的可选组件和图标按导出名探测。源码有高亮语法且最多 128 KiB、4096 行时可使用宿主 `CodeBlock`（含行号、复制、换行和语法高亮）。组件缺席或超出预算时显示完整纯文本，默认选择、手动切换和刷新后恢复选择均使用同一预算。布局 token 直接继承，预览保持只读。
