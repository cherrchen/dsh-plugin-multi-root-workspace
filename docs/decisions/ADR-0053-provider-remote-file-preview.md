# ADR-0053：按 Provider 分派的远端文件预览

## 状态

Proposed，2026-11-27。实现与验收见[配套计划](../plans/completed/2026-11-27-provider-remote-file-preview.md)，接受与否由维护者决定；实施已随 PR [#81](https://github.com/cherrchen/dsh-plugin-multi-root-workspace/pull/81)（`4ea9312`）合入 `main`，并随 `v0.1.25-beta.2` 发版；冻结合同见 [remote-file-preview](../architecture/remote-file-preview.md)。承接 [ADR-0052](ADR-0052-provider-file-browsing.md)（远端浏览身份/权威/传输分层，不改写）。

## 背景

ADR-0052 交付了 SSH 远端根的只读目录浏览，并在 `WorkspaceFilesProvider` 保留可选的 `preview` 端口。原生 Viewer 的资源标识和读取方式绑定本地路径，不能直接承接有独立授权代次的 SSH 资源；远端预览需要独立的内容读取与授权契约。

## 决策

按 Provider 分派远端文件预览：SSH provider 的可选 `preview` 端口把普通文件行路由到插件自有的不透明 Resource（`dsh-resource://mrfw-remote/<uuid v4>`）与 capability-gated 只读 Viewer；内容经单一严格 `remoteFiles.read` 操作（Connection binary attachment，一次完整读取，无 stat/range）；授权是独立的 `filePreview:'stable-path'` opt-in；范围只覆盖个人托管 SFTP 路径，初版仅限 `0.2.3-alpha.2`。逐节合同以 [remote-file-preview](../architecture/remote-file-preview.md) 为唯一规范来源。

要点：

1. **通路**：`FilesPane → provider.preview → opaque Resource router → DSH resources/sidebarRightTabs/Tab/Dockkit → 插件 Viewer（可内嵌同一 FilesPane 作 Navigator）→ RemoteFilesClient.read → PANEL_CHANNEL → RemoteFilesService → Registry 有序准入 + owned SFTP`。Navigator 复用真实 `FilesPane`，记忆以 `session + provider incarnation + PaneId` 键控；`replaceTab` 用真实 tab ID。
2. **身份**：资源地址是内存随机 UUID v4，不携带会话/授权/路径事实；无持久化身份、凭据或内容；reload 后陈旧地址只渲染失效态。
3. **授权**：`filePreview:'stable-path'` 独立于 `read`/`directoryListing` 且默认缺席；断言保护目标名/对象映射与祖先、挂载、符号链接、硬链接来源在整个操作期稳定；Host 每次操作做初始/复核/最终三段 Registry 准入，与浏览摘要无关。`RemoteEndpointView.preview?: 'sftp-binary-v1'` 仅为发现提示，门禁在服务/Host 内部。
4. **线协议**：请求即 list 身份 + 非空 `relativePath`；响应为严格 metadata + 恰好一个 `bytes` binary attachment，双侧强制 2 MiB、严格终形校验、超限稳定报错不截断。
5. **读取管线**：单 owned channel 完成 准入 → LSTAT/realpath 根与祖先 → 只读 OPEN → FSTAT → 深度 1 串行 128 KiB READ → 发布前再探 → CLOSE → 最终准入；取消关自有通道并持位至清理完成；size/类型/mtime 变化拒绝 `file-changed`。
6. **预算与渲染**：共享引用计数租约；≤8 资源记录 / ≤4 Viewer 内容 / ≤2 在途读；Markdown ≤128 KiB/4096 节点安全 AST；无图片/主动内容/HTML/SVG 渲染（源码回退）；无编辑/watch/搜索/diff/下载/同步。
7. **界面边界**：Viewer 的外观与基础操作对齐宿主文档预览，但只作为插件独立实现的视觉适配；不得 fork/挂载上游 Viewer 的内部组件树或状态机，不实现 Host handoff/`open-in-app`。可复用宿主公开 primitives（如 `PathLabel`、`Menu`、`CodeBlock`），缺席时降级而不改变读取与授权合同。

## 备选方案（已拒绝）

- **临时文件 + 本地 Viewer**：远端字节落盘再交给本地路径 Viewer——引入落盘/清理/生命周期与本地路径身份泄漏，违背"无落盘、无本地 API"边界。
- **覆盖/复用原生 Viewer fork**：fork 上游 Viewer 组件——把上游内部 API 当稳定面维护，违反"无上游修改/原生 Viewer fork"。
- **上游新增 transport/凭据**：为预览引入新 SSH transport 或额外凭据——超出"复用 owned SFTP + 现有连接"的边界。
- **SSH 直接旁路 broker/预算**：预览直开 SFTP 绕过 Registry 准入与 channel 预算——破坏逐次有序准入与 owned-channel 封顶。
- **默认 Base64 JSON 载荷**：内容以 base64 放进 JSON——放大约 33% 线体积并绕过 Connection 既有 binary attachment 校验/还原路径。

## 安全与运行时后果

- 全链路只读：无编辑、无回写、无 watch、无轮询；取消/关闭经 tab signal 中止自有通道。
- 个人托管支持路径外（其他 transport/custody）一律 fail closed；未知 `preview` 提示值只丢预览。
- `filePreview` 是不被任何既有 opt-in 继承的独立开关；授权失效经既有 incarnation 换代自然失效。
- 资源地址不透明：无持久化身份查找、凭据、权威摘要或内容；泄露一个地址不等于泄露目标。
- 预算全部有界（2 MiB 内容、128 KiB 块、65 次 READ、2 并发、20 s 截止、8 记录、4 视图、16 租约）；文件级失败不逐出树；Host 永不回传原始异常/路径/授权材料。

## 链接

- 冻结合同：[remote-file-preview](../architecture/remote-file-preview.md)
- 前置：[ADR-0052](ADR-0052-provider-file-browsing.md)、[file-browsing-providers](../architecture/file-browsing-providers.md)
- 计划与验收：[2026-11-27-provider-remote-file-preview](../plans/completed/2026-11-27-provider-remote-file-preview.md)
