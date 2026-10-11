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

## 修订：加固与 Windows 全量验证（2026-10-11，Amendment）

Status 保持 **Accepted**；本节按 Windows CI 原生执行的实测结果补充安全边界与限制，不改变原有设计取舍。

### 确认的缺陷与处置

1. **Windows 网络/设备根按 `unsupported-path` 词法拒绝**。UNC（`\\server\share`）、`\\?\` 与 `\\.\` 设备路径、以及映射网络盘（`realpathSync.native` 会解析成 UNC）此前会被当成普通目录接受。restricted token 的 capability SID / Low integrity label 无法证明能约束 SMB 访问，而对 UNC 路径 `stat` 本身就会触发 SMB 认证。规则：注册表校验在任何 fs 触碰**之前**做词法判定（`isWindowsNetworkOrDevicePath`，`/^\\\\/`）；canonical 化之后再判一次（捕捉映射盘）；存量记录由 `classifyStoredRoots` 判 `invalid`；profile 扩展抛 `DialectUnrecognizedError`（→ `SandboxUnavailableError`）、runner exit 127——永远是 fail closed，绝不无约束执行。
2. **Windows runner 在授权后、spawn 前重新验证根**：每个传入根必须仍存在、是目录、且 canonical 身份与传入时一致；`--temp` 必须是已存在的目录。任何一项不满足即以上游兼容的 `windows-acl-run:` 签名退出 127，不启动无约束子进程（confine 与 spawn 之间根被移除的场景由原生用例钉住）。
3. **面板文件端点词法拒绝反斜杠**：POSIX 上 `..\..\x`、`\\server\share`、`\abs` 既不是绝对路径也不匹配 scheme，此前会解析到所选根**内部**并被服务——客户端只以 `/` 拼接，所以 `\` 一律拒绝。
4. **Windows reveal 接受 exit 0/1**：`explorer.exe` 在成功时也返回 1，原先只认 0 导致 Windows 上 reveal 恒报 `reveal-unavailable`。
5. **文件树 RPC 支持 AbortSignal**：`files` / `readFile` 在组件卸载、路径或会话变化时中止在飞调用；Connection RPC 本就支持 signal，host 端早已转发，修的是客户端不传。

### 实测确认的（上游）边界，保留并记录

- **Git Bash/MSYS 在 restricted token 下无法启动**：0.2.x 报 `NtCreateDirectoryObject(\BaseNamedObjects\msys-2.0…): 0xC0000022`，`0.1.5-rc.2` 报 `CreateFileMapping …, Win32 error 5`（exit 256）；上游 runner 与插件 runner 表现一致，Windows 受限 shell 就是 pwsh。
- **Ctrl+C 语义在两个 runner 下不同且都是既成事实**：上游 runner 调 `SetConsoleCtrlHandler(NULL, TRUE)`，ignore 标志被 confined 子进程继承（上游 confine 的子进程收不到 Ctrl+C）；插件 runner 用 Node SIGINT handler（不被继承），Ctrl+C 能到达子进程，runner 镜像其退出码。这不是缺陷，是两条实现路径的如实差异。
- **foreign-owned 根在 elevated host 上的可测边界**：unconfined 的 admin 进程不是有效探针（libuv `FILE_FLAG_BACKUP_SEMANTICS` + backup/restore 特权绕过 DACL，restricted token 不能）；接受两种结局——runner 在 spawn 前拒绝（127），或子进程跑起来且所有未授权写被内核拒绝。
- **不变的既有语义**：`Local\` 命名信号量按登录会话隔离，网络共享上的 `$DSH_HOME` 不受 lease 保护（同上游 SessionWriteLease）；standing workspace ACE 随根集合增长且不在活跃子进程下撤销；已启动进程保留启动时快照。
- **Windows enforcement 仍是上游 `partial`**。

### 验证义务（本修订新增）

Windows 内核证据不得再靠结构测试替代：`kernel:probe` 用真实上游 runner 验证 `windows-acl`（允许写 + 兄弟目录被拒，缺一不可）并导出方言；三冒烟在 Windows 以 pwsh 原生运行；`pack:check` 与 `smoke:packed` 证明 tarball 成员完整且安装副本可启动。CI 增加 `gate` job，矩阵被 skip/cancel 不得显示为成功。

## Related Documents

- [架构](../architecture/multi-root-workspace.md)
- [需求](../requirements/multi-root-workspace.md)
- [进度账本](../plans/active/2026-09-12-multi-root-workspace.md)
- [ADR-0003：方言扩展](./ADR-0003-dialect-grant-widening.md)
- [ADR-0005：客户端传输](./ADR-0005-out-of-tree-client-transport.md)
- [ADR-0009：兼容合同](./ADR-0009-dsh-compat-contract.md)
