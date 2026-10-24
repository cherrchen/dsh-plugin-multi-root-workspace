# DSH 0.2.1 接口与安全契约审查

2026-10-10 对上游发布 tag 做只读源码对照（至 `alpha.2`）；2026-10-17 补查 `alpha.3` 至 `rc.2`；2026-10-23 补查 `rc.3`。发布包行为另由本仓库测试和真实 Host smoke 验证，执行状态只记[路线账本](../plans/active/2026-09-12-multi-root-workspace.md)。不修改上游 checkout，也不深导入其内部源码。

| tag | commit |
|---|---|
| `dsh-v0.2.0-rc.2` | `639ed015397290b3745d163aafe02ffee4aa3f84` |
| `dsh-v0.2.1-alpha.1` | `5badb15009ae1756c3afe0ae0cef1faafc290ccc` |
| `dsh-v0.2.1-alpha.2` | `6851e496285b2c9670066fdd142e7e46da586649` |
| `dsh-v0.2.1-alpha.3` | `2fbf4359b82fb94c03dcce0b831660d87f12ea5c` |
| `dsh-v0.2.1-alpha.4` | `86a402200d95fecef4529d969836f1fe13c6cb0d` |
| `dsh-v0.2.1-alpha.5` | `1517a4dbca0a2789ff1d41ba439600f8547d23fa` |
| `dsh-v0.2.1-rc.1` | `1600d8a1e140dcde43a1a0941940a0480712c011` |
| `dsh-v0.2.1-rc.2` | `687f282e8625c6b8d11ff58211a90524be2e4317` |
| `dsh-v0.2.1-rc.3` | `1f81c047fc48fa190a683e469daa699857e9afe8` |

## 实际组合与不变量

bundle 禁用上游 `fs-sandbox` / `sandbox` 两行，插入 compat gate、scope、两个 provider、Registry、instructions、LSP / workspace-files 包装、command 和 bare-package client anchor。bash / subprocess / terminal / policy 不由插件替换。fs fence 与 confine 共用 scope；Registry 的 store-wide 内核 lease 先于 storage domain open，队列排空和 close 先于 lease release。client 使用 Connection 通道 `/multi-root-workspace`；所有 authority 都由 live Session header 推导。

现有代码已经实现 Windows root-set SID runner、真实 LSP stdio 路由和附加根 lazy tree，README 中较早的 Windows 限制与发版准备描述不能代替代码状态。`main` 的 package 是 `0.1.5`，本地存在 `v0.1.5` tag；此次分支保持 package version，不创建 release。

| 安全性质 | 迁移前 | 迁移后 |
|---|---|---|
| 注册归属 | canonical header root | 相同；effective cwd 永不参与 key |
| 授权来源 | policy writableRoots + 验证后的 scope | 相同；cwd / Worktree 不新增 grant |
| redirected / missing | 保留记录、暂不授予 | 相同；指令 I/O 后追加 scope 复核 |
| fs 与 kernel | 同一 scope，模式受上游控制 | 相同；新旧执行 cwd 可不同但 grants 不漂移 |
| unknown dialect / unsupported / mixed | 不执行扩权 provider / 抛 unavailable | 相同，无 unrestricted fallback |
| authority lease | 单一跨进程 owner，queue → close → release | 相同，不加 PID/TTL 锁 |
| 已启动进程 | 启动时内核 snapshot | 相同，不会随 cwd 或 Registry 自动更新 |
| 指令层级 | user context、按 session/scope 记账 | 相同，增加实际执行路径捕获与 native batch 去重 |
| 面板 | live session header authority | 相同，cwd 独立显示且丢弃跨 Session 旧响应 |

## 接口差异逐项分类

下列源码路径均相对上游仓库，指上述三个 tag。

| 接缝 / 上游源码 | rc.2 → alpha.1 | alpha.1 → alpha.2 | 分类与插件处理 |
|---|---|---|---|
| `packages/fs/fs-local/src/`、`fs-sandbox/src/` | 无变化 | 无变化 | API 兼容；继续真实 target re-resolution 和 containment，不移除 fence |
| `packages/fs/fs/src/` | 注册 invariant 移除 | 公开 fs 方法不变 | 不相关：插件不依赖 invariant 注册；`fs/observed` 接缝兼容 |
| `packages/sandbox/sandbox-policy/src/index.ts` | 无变化 | 无变化 | API 兼容；resolve 仍取 header.cwd，sessionId 仍透传 |
| `packages/sandbox/sandbox-local/src/`、`sandbox/src/`、Windows ACL `src/` | 无变化 | 无变化 | API 兼容但涉及安全审查：继续对发布包实际 confine argv 做独立 grant parity，不仅凭无 diff 复用 |
| Seatbelt / bwrap / Landlock profiles | builder 与包装输出源码不变 | 不变 | 观测克隆可保留，unknown/ambiguous 仍 fail-closed；平台执行证据分别记录 |
| `packages/subprocess/subprocess/src/` | 无变化 | 无变化 | API 兼容：spec.cwd 仍由 caller 指定；插件不同步修改 child |
| `subprocess-local/src/index.ts`、`terminal.ts` | 无关键变更 | Windows PTY 使用 bundled OpenConsole (`useConptyDll: true`) | API 兼容；不是新增目录授权，ConPTY 必须真实 Windows 验证 |
| `packages/session/working-directory/src/index.ts` | 不存在 | 新增 service / projection / `working-directory/change` | 安全契约变化；复用上游，身份与 cwd 分离，见 ADR-0012 |
| Session header / log / projection | Session 校验/invariant 调整 | 新 working-directory event 加入已知事件、projection；Session surface API 扩展 | API 兼容；header.cwd 不变，session format 仍为 4；replay 新事件由上游负责 |
| `packages/fs/tool-fs/src/session-cwd.ts` | 仍用 header cwd | async workingDirectory.ensure | 轻量适配：instructions capture call cwd / actual fs observation；fs provider 无需换 policy |
| `packages/shell/tool-bash/src/index.ts` | 旧 workdir 逻辑 | 默认/相对 workdir 用 effective cwd | 安全契约变化但无需替换工具；confine 仍读原始 policy；新启动与 persistent process 分开 |
| `packages/terminal/terminal-bash/src/index.ts` / terminal controller | 原始目录 | 新 terminal default cwd 用 ensure，已有 terminal 不改 | API 兼容；多根仍由相同 confine 服务完成 |
| `packages/context/agent-instructions/src/` | 少量 renderer 校验调整 | 共享 agents home、global 分组去重、display scope escape；baseline 从 effective cwd 发现 | 轻量适配与上下文契约审查：根内过滤、global 排除、call 快照、actual target、native metadata overlap、I/O 后撤销 |
| `packages/lsp/tool-lsp/src/index.ts` | header cwd | effective cwd 作为 query workspaceRoot，无 Session 字段 | 需修改 routing 实现：around-dispatch Session identity + 执行目录相对解析；LSP 公共 query/stdio provider 自身未变 |
| `packages/api/workspace-files/src/` | 无变化 | 无变化 | API 兼容；原生 scope 保持 header，附加树 root-entry 不变；新增 cwd 仅在插件 RootsView 展示 |
| Cordis / loader / runtime resolution | cordis `4.0.4` | cordis `~4.0.5-alpha.1` | 轻量 tooling 适配：精确 prerelease pin；provider 生命周期与公开 wrapper disposal 仍复验 |
| `packages/experimental/worktree/src/` / `tool-worktree` | 不存在 | 新建 checkout，默认 `.agents/worktrees`，保持原 policy | 安全契约协作；不重实现，不自动登记；失败保留 artifacts，cwd 仅成功时更新 |
| 上游移除 invariant rows、tool mutation result 展示与 Session title 实现 | 有变化 | 有变化 | 不相关于根授权；真实 Host composition / journey 检查组合影响 |

## alpha.2 → rc.2 补充审查（2026-10-17）

`alpha.2` 到 `rc.2` 的上游变化集中在 Connection Peer 认证重设计、plugin-market/客户端基础设施和一个依赖 pin；fs / sandbox / storage 语义、Seatbelt / bwrap / Landlock profile、session format 4、`working-directory` 与 fork 源 `src/client/` 子树均无源码 diff。

| 接缝 / 上游源码 | 变化 | 分类与插件处理 |
|---|---|---|
| `packages/storage/storage-domain/package.json` | `alpha.3` 起 `zod` 由 `^4.4.3` 改为精确 `4.4.3` | **类型边界变化**：本包 `zod@^4.6.2` 从此解析出第二副本；zod v4 的 `ZodType` 按构建 minor 标记，两副本互不兼容。域 schema 改由 storage-domain 自身解析的 zod 构建（`src/compat/storage-zod.ts`），值与 `domainTable` 声明的 `ZodType` 始终同源；不 pin 本包 zod（旧支持版本的 `^4.4.3` 会把分裂移到另一侧） |
| `packages/client/connection/src/` | `alpha.3`：`OperatorPeer` 移除，新增 `Peer`（principal/interactions/signal/disposal）、`createPeer`/`admitConnection`/`ConnectionAdmission`；RPC handler 多收一个认证后的 Peer 参数；`HostConnectionService` 跟踪 browser/API Peer；connection 增加 WebSocket/interactions API | API 兼容：插件只调用 `connection.rpc.handle`（处理器参数更少对新增参数向后兼容）与 `connection.rpc.call`；`/multi-root-workspace` 通道语义不变。Peer 模型不改变面板的 live-session authority 推导 |
| `packages/api/workspace-files/src/index.ts` | `alpha.3`：`workspaceFileScope` 查找新增 `resource: 'session'` | API 兼容：附加元数据字段，scope 构造与包装路径不变 |
| `packages/boot/plugin-manager`、`plugin-market` | `alpha.4` 起第三方插件的版本需求优先读 `engines.dsh`，缺省回退 DSH `peerDependencies`；plugin-market 新增 source repository / Custom markets / Discover | API 兼容：本插件仍以 `peerDependencies` 为唯一版本契约（`compat:check` 四处一致），不引入 `engines.dsh` 这第二处版本列表；`allow-version` 豁免路径照旧只用于候选 lane |
| `packages/fs/tool-fs/src/read.ts` | `alpha.5`：read 失败提示由 "cat, sed, head, or tail" 收敛为只提 `cat` | 模型可见文案微调；工具事件名与 `fs/observed` 契约不变，指令 capture 不受影响 |
| `@deepseek-ai/dsh` → cordis | `alpha.3`–`alpha.5`：`~4.0.5-alpha.2`；`rc.1`/`rc.2`：`~4.0.5`（解析为 `4.0.5` 稳定版） | 轻量 tooling 适配：`scripts/lib/cordis-pin.mjs` 按候选版本选精确 pin；provider 生命周期与 wrapper disposal 仍由测试复验 |
| `packages/extensions/cordis-client-runner/src/client/slot-catalog.ts` | `rc.2`：新增 `conversation.input.model.label` slot 与 `client-ui-deepseek-model-label-1017` 注册 | 不相关：不占本插件 slot；`sidebar.footer.action` 注册不变 |
| client 模块 release 门控 / manifest（`alpha.4`） | client 模块清单带 Host release 身份，release 变化触发模块重载 | API 兼容：`dsh.client` 加载通道不变；panel 与 files-tree 由客户端 bundle 测试与 journey 验证 |
| remote-access rbac（`alpha.3`） | 非 owner 调用与事件按 rbac policy 拦截 | 不相关：插件未使用 remoteAccess；本地 profile 的 Connection 通道无 rbac 影响 |

## rc.2 → rc.3 补充审查（2026-10-23）

`rc.2` 到 `rc.3` 的上游变化全部为新增：导航条目自定义带来两个新 sidebar 槽位与导航 pins 与选择态分离、导航/预设埋点，以及 DeepSeek API-key 路由接入官方 `/models` 列表。fs / sandbox / storage / session / working-directory / Connection RPC / fork 源 `src/client/` 子树均无源码 diff（`packages/client/ui-sidebar-files/src/client` 与 `packages/client/ui-open-in-app/src` 逐字节一致）。

| 接缝 / 上游源码 | 变化 | 分类与插件处理 |
|---|---|---|
| client slot catalog / navigation（#6247、#6883、#6600） | 新增 `sidebar.panellist.actions` 与 `sidebar.right.tab.guide.actions` 槽位；navigation pins 与 selection 分离并加菜单图标；新增导航条目/预设选择埋点 | 不相关：新槽位与本插件的 `sidebar.footer.action`、`sidebar.right.tab.files.actions` 注册不冲突；pins/埋点是宿主内部 UI 状态 |
| `dsh-llm` DeepSeek API-key 路由（#6944） | 模型列表改走官方 `/models` listing | 不相关：本插件的 LLM 接缝只包装工具调用消息形状（`llm-message`），不触碰模型枚举 |
| `packages/client/ui-sidebar-files/src/client`、`packages/client/ui-open-in-app/src` | 与 `rc.2` 逐字节一致 | fork 基线只前移 revision 至 `1f81c047fc`，不重新拷贝 |
| cordis / storage-domain zod / session format / install 门禁 | 无变化：`dsh` 仍依赖 cordis `~4.0.5`（解析 `4.0.5`）；zod pin、session format 4、`engines.dsh` 优先的装门禁语义同 `rc.2` | 无新适配分支；storage-zod 适配与 peers 契约原样覆盖 |

## Worktree 约束

Worktree 的 `.git` 是指向 source repository metadata 的普通文件。checkout、common gitdir、pool 必须已在 workspace-write 的可写集合里；external gitdir 或 custom pool 位于集合外应失败。source root 内的默认 pool 与 Additional root 内的默认 pool 都无需新增授权。普通目录 symlink 仍按 canonical path 判定，不能把 worktree 名称当授权依据。

上游硬性调用 Git `--no-lazy-fetch`。Apple Git `2.39.5` 的真实返回是 unknown option，创建在首个命令失败，Registry 不变。测试可通过 `DSH_TEST_GIT_COMMAND` 指定已有新 Git；不能删掉参数、修改 upstream package 或把失败当成功。上游失败/取消可保留部分 checkout/branch，本插件没有隐式清理或 Registry mutation。

## 验证与局限

运行 lint、双面 typecheck、build、kernel probe、完整 test、compose/behavior/journey、docs check，以及精确版本矩阵。内核探针还从公开 `node-addon-system/landlock-run` 定位 DSH 自带 launcher，真实 Landlock parity 不再使用结构测试的 inert launcher；Linux CI 安装 bubblewrap，并上传成功/失败测试日志。无法实际执行的方言仍明确记为未验证。fixture 位于自动 temp grants 外，拒绝断言不会被 `/tmp` 权限掩盖。新版原生测试从被测 DSH 自身解析 workingDirectory/Worktree；旧版缺少服务明确 skip，已安装服务求值失败不伪装为缺失。

候选阶段保持 allowlist 和 peers 不变。新版 install-time peer 拒绝有独立失败证据；smoke 在 `DSH_MULTI_ROOT_COMPAT=warn` 的隔离 profile 中使用上游 `allow-version` 精确豁免。缺包/混装依然拒绝。正式提升后使用正常 enforce 安装再跑，不依赖该豁免。

read-only 并不表示阻止所有读取；上游文件策略主要约束修改，平台 runner 的读取/网络限制及 Windows partial enforcement 被继承。路径 revalidation 缩小异步窗口，不能证明抗任意敌对并发目录替换的原子文件身份。已运行内核进程保留 grant snapshot，撤销后需要终止旧进程。

上游 instruction baseline 的 `workspaceBaselineIdentity` 以 `relative(cwd, projectRoot)` 标识 project，而没有绝对 cwd；两个同构目录之间切换可能复用 baseline identity。插件不将这个标识用于 Registry / grants，自己的附加根指令保持绝对 scope；native batch 去重要求具体绝对目标与完整内容摘要同时匹配。上游 primary/global baseline 的协调属于上游，仍需独立修正此身份边界；不以重写 prose 或第二套 cwd 状态规避。

设计唯一真源见 [ADR-0012](../decisions/ADR-0012-session-origin-and-effective-cwd.md)，支持列表唯一真源仍为 `src/compat/dsh-version.ts`，各平台实际执行/skip 和发布状态只见[路线账本](../plans/active/2026-09-12-multi-root-workspace.md)。
