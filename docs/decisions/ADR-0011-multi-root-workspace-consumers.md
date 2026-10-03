# ADR-0011: LSP、Windows ACL 与文件树共享多根 scope

## Status

Accepted

## Date

2026-10-02

## Context

MVP 已统一 fs fence 与 POSIX runner 的授权，但 LSP 查询仍以主根初始化服务器，Windows runner 只有单 workspace SID，客户端目录列表也被主根包含性限制。继续遵守不修改上游、不读取私有字段、不建立第二份根数据源的约束。

## Decision

### 公共方法接缝

新增 `multi-root-lsp` 与 `multi-root-workspace-files` 两个 additive 行，均以 `multiRootCompat` 为前置条件；仅在对应服务存在时安装公开方法包装。没有追加根时传入上游原始参数，卸载时恢复实例原有属性描述符；不替换上游原型、provider 注册表、Remote 元数据或生成的 codecs。

Cordis 读取方法时产生带调用上下文的代理，不能用普通函数引用比较判断是否仍持有包装。`method-wrapper.ts` 使用公开属性描述符读取原始方法并安装实例属性，卸载只恢复仍由本包装持有的属性。包装以当前调用的 `this` 委托上游，保留 Remote invocation 与 fiber 上下文。

### LSP 路由

`routeWorkspacePath()` 把相对路径解析为主根 cwd 下的文件，再用 `ctx.fs.contains()` 检查 canonical target 所在根。附加根来源只有 `multiRootScope.scopeOf(primary)`，异步解析后再次检查授权。附加根内文件以绝对文件路径与对应根的 `workspaceRoot` 调用原 `lsp.query`。主根文件和不匹配的路径保留上游处理，不按 basename 搜索仓库，也不向全体仓库广播查询。

`lsp-stdio` 原本就按 canonical workspace 池化进程，所以每个附加仓库得到自己的 cwd、initialize `rootUri` / `workspaceFolders`、项目配置和服务器生命周期。模型工具参数、坐标、超时、结果上限不变。根删除后新查询不再路由到它；已运行的查询与服务器由上游生命周期管理。

### Windows root-set capability

非空 `workspace-write` 的 Windows profile 改用插件打包的 `windows-runner.js`。严格识别 `[node, runner, --workspace, ..., --mode, ...]` 及可选成对的 workspace/temp SID；未知、重复、缺值的 flag 均拒绝。空根与 read-only 继续使用上游 runner，返回值的同步/异步形状、enforcement、denialSignatures 和 runnerFailureRules 不变。

插件 runner 只用公开导出的 `AclSandbox`、`workspaceWriteSid`、`tempWriteSid` 与 `assertTempRootOutsideWorkspace`，不深导入 Win32/token 模块。执行前确认所有传入根仍是同一 canonical 目录，验证上游 SID 与路径的对应关系。每次执行创建自有 private temp，所有根必须与它的父 temp 分离；失败输出上游兼容的 `windows-acl-run:` 签名并退出 127，绝不启动无约束子进程。

workspace capability 是整个 canonical 根集合的 SHA-256 派生 SID：路径大小写归一、去重、排序，四个 30-bit subauthority 加固定域标记 `2`。所有 workspace 目录都给该集合 SID 授予写 ACE，private temp 仍有独立 SID。集合改变会改变 SID，后续 token 因而不能使用旧集合的 standing ACE。**不能把主根 SID 同时授予附加根**：那会让移除根后的主根 token 继续写被移除目录。workspace ACE 与上游一样 standing，集合变化会留下不再被新 token 使用的 ACE；不在活跃子进程下面撤销 ACL。已启动子进程保留启动时 scope，和 POSIX 沙箱快照语义相同。

restricted-token 的读取、网络、Everyone/hard-link 等边界及各版本的完整性机制继承上游；enforcement 仍是 `partial`。目录须存在、caller-owned，不能覆盖 private temp 父树。runner 保留 inherited stdio、Ctrl+C 等待、完整退出码与新版 subprocess control fd 7 转发；上游没有 control 传输的旧版不传这个环境标记。

### 文件树与隔离

现有 `workspaceFiles.list` 对附加根绝对路径按同一 scope 选择根，再把 host 派生的 scope 与绝对 target 委托上游，保留它的目录类型检查和配置的 entry cap。异步完成后根若被删除、消失或 redirect，丢弃结果。现代三参数 `changes(scope, path, signal)` 同样路由；根撤销的 scope publication 中止等待中的流，逐帧再验 canonical scope。旧版二参数、会话级 `changes(scope, signal)` 没有可路由的 path，原样保留；差异只在 `src/compat/workspace-files.ts` 按 arity 探测。

浏览器复用 ADR-0005 的 Connection 通道，增加 `files` / `readFile`，每个端点有自己的 response schema；均必须有 live `sessionId`。host 从 session 得主根，`registry.refresh()` 重验根，再根据 exact entry 定位；只接收所选根内的相对路径，canonical 包含性拦截 traversal / symlink escape，I/O 后重验登记与路径身份。新端点复用原 `workspaceFiles.list` / `read`，保留 host 配置的资源上限。preview 最多请求前 200 行，非 EOF 明示截断。

附加根的 lazy tree 放在现有 Workspace Folders 对话框，每个 available 根可展开；目录点击加载下一层，文件点击显示文本 preview，手动刷新重建树。主根的原生 Files tab 保留；存在 `sidebar.right.tab.files.actions` 时加入打开该对话框的动作，旧版仍从 footer 进入。浏览器不替换 DOM，不建立 Typert namespace，不安装一份私有客户端服务身份。

### 兼容与验证

新增可选 peer 均按既有 exact allowlist 声明，并纳入混装检查；缺少 LSP 或 workspace-files 服务的组合不激活对应包装。runner 的 Windows 包只在执行时 import，不成为 carrier barrel 的加载期依赖。

LSP 测试启动真实 stdio 协议进程并确认 root/cwd/URI、源码和进程池隔离；文件服务与面板用真实 fs 和 registry 验证跨主根、撤销、redirect、symlink escape、I/O 中删除、配置上限与卸载恢复；客户端验证 lazy tree、预览、过期响应和可选 Files actions 入口。Windows 平台测试必须真实启动 restricted token 子进程，覆盖 Node、PowerShell 与 ConPTY 传输，检查两根可写、第三目录与撤销后的根不可写、read-only 拒绝写入以及终端退出码保留；非 Windows 显式跳过，不将结构测试计为 Windows 内核实跑证据。各版本和平台的执行状态只记在路线账本。

## Alternatives Considered

- 替换 `tool-lsp` / 自建 LSP provider：会复制工具协议、进程池与取消机制，只为改变已公开的 workspaceRoot 参数不划算。
- 扩大 fs.contains 的全局含义：会影响所有消费者的安全检查，尤其不能令不同 session 的 roots 混成全局授权。
- 把附加目录 ACL 赋给 primary workspace SID：移除根后仍有能力，拒绝。
- 深导入上游 token 实现以添加每个 root 的 SID：发布包没有这些稳定入口，违反 ADR-0002。
- 替换上游 FilesBody 或生成 Remote clients：依赖上游打包内部结构，跨版本维护成本高；选择公开 actions slot 与既有 Connection 通道。

## Consequences

三个消费方始终以 canonical 主根索引同一个 scope。公共方法和 Windows argv 形状仍是精确支持合同的一部分；上游变动必须经测试确认。Windows standing ACL 数量随使用过的根集合增长；旧版目录变化不支持附加根自动监听，新增树明确使用手动刷新。

## Related Documents

- [架构](../architecture/multi-root-workspace.md)
- [需求](../requirements/multi-root-workspace.md)
- [进度账本](../plans/active/2026-09-12-multi-root-workspace.md)
- [ADR-0003：方言扩展](./ADR-0003-dialect-grant-widening.md)
- [ADR-0005：客户端传输](./ADR-0005-out-of-tree-client-transport.md)
- [ADR-0009：兼容合同](./ADR-0009-dsh-compat-contract.md)
