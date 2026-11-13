# DSH 0.2.2 接口与安全契约审查

2026-10-28 对上游发布 tag 做只读源码对照；发布包行为另由本仓库测试与真实 Host smoke 验证，执行状态只记[路线账本](../plans/active/2026-09-12-multi-root-workspace.md)。不修改上游 checkout，也不深导入其内部源码。

| tag | commit | npm dist-tag |
|---|---|---|
| `dsh-v0.2.1-rc.3` | `1f81c047fc48fa190a683e469daa699857e9afe8` | — |
| `dsh-v0.2.1-rc.4` | `504a01a9578abc2c6f1fb896b1dc322c9fe24f66` | `next` |
| `dsh-v0.2.2-alpha.2` | `f3803c96974ad4a94195fb97e5c637e9c2a3afe3` | `alpha` |

`rc.3 → rc.4` 共 9 个 commit：仅 ACP stdout 诊断（llm-deepseek-account、mcp-client、mcp-resources）与 ui-conversation 的 tab tooltip，不触及任何插件接缝；探针无需源码改动即全绿。`rc.4 → alpha.2` 共 2161 个 commit（中间无 alpha.1 标签，rc.4 是祖先），root engines 升至 Node `>=24.9.0`；`dsh` 依赖 cordis `~4.0.6-alpha.1`、schemastery `~3.18.6-alpha.1`。

## 接口差异逐项分类

下列源码路径均相对上游仓库。

| 接缝 / 上游源码 | 变化 | 分类与插件处理 |
|---|---|---|
| `dsh-agent` AgentRegistry | 新增 `static inject = ['sessionProjections']` | 测试 fixture 适配：挂 `AgentRegistry` 前必须先挂 `SessionProjectionRegistry`，否则 `ctx.agents` 为 `undefined`；插件源码不依赖 `ctx.agents` |
| `dsh-session-projection` | `register()` 改为 async、返回带 `stateOf(session)` 的 handle；`registry.stateOf(session,key)` 废弃（告警）；`SessionProjectionStateMap` 移除 | API 兼容检查通过：插件源码从不调用 `stateOf` |
| `agent-instructions` / `terminal-bash` | inject `agents` 并读 `ctx.agents.turnBoundaryOf`；terminal-bash 经 `sandboxPolicy.overrideOf` 读 mode | 不相关：插件不包装这两行 |
| `dsh-tools` 工具执行 | 拆分为独立执行器（`dsh-tool-executor-native` / `-ptc`）：`ctx.tools.setExecutor`、批量 `ctx.tools.execute({calls})`、`@deepseek-ai/dsh-tools/pipeline` 子路径 | 轻量测试适配：`tests/support/tool-executor.ts` 按 `setExecutor` 存在性动态挂等价分发器，调用按批量/单发双形态；公开 `tools/execute` waterfall 事件（aroundTool 接缝）保留，exec 字段（agent/callId/name）不变 |
| `dsh-sandbox` / `dsh-sandbox-local` | 新增 `SandboxExecutionPolicy.additionalWritableRoots`、`workspaceWritableRoots`、`SandboxInvalidRootError`、`SandboxUnsupportedPolicyError`；policy 配置键 `sandboxPolicy.additionalWritableRoots` | API 兼容但涉及安全审查：本插件不设该字段，scope 宽授权不变；Seatbelt/bwrap/Landlock/fs-sandbox 原生消费，windows-acl 拒绝；两路 grant 的复合由 `tests/upstream-additional-roots.spec.ts` 钉住；confine 仍异步、dialect 拼写不变 |
| `dsh-storage-domain` | 新增 `KvUnit.deleteRecords` / `KvTable.deleteMany` 与 `unknown-state` 隔离 | 新增面：Registry 的 put/delete 使用不受影响 |
| `dsh-session` | store 持有的 Session 在 `session/created` 完成前拒绝 append | 不相关：插件测试用独立 Session |
| `dsh-skill` / `dsh-tool-skill` | filesystem provider 把失败根报为 incomplete observation；tool-skill 发布 incomplete catalog | 行为不变：多根 skills provider 仍把嵌套 observation 当普通候选、忽略 `complete:false`（记为已知后续观察点） |
| `packages/client/ui-open-in-app` | 失败反馈移出按钮：controller `launch` 返回 outcome（`opened`/`skipped`/`failed:openError`），新 `report` 回调与 `shell.overlay` 应用级 toast；`open-failure-toast.tsx` 删除，新增 `open-toast.tsx`/`outcome.ts` | fork 重拷对齐（见 `src/client/open-in-app/FORK.md`）；overlay 入口 `multi-root-open-in-app.toast` 只在 adapter 建立时注册 |
| `packages/client/ui-sidebar-files` | hover 规则移入 `@media (hover: hover)`；locales 新增语言字典（`zh` 键集不变） | fork CSS 同步：`FilesBody.module.css` 重拷、`styles.ts` 的 `mrfw-ft*` 块补同样 media 包装 |
| `dsh-client-ui-primitives` | 新增 `isMobileDevice`；`Toast` 增 `tone`/`actions` | fork 侧 `device.ts` re-export 至 `src/compat/open-in-app-device.ts` 的结构探测 shim；`upstream-surface.d.ts` 增加 `Toast` 重载（0.1.5 像素期无 `tone`） |
| `packages/bundle/base/cordis.patch.yml` | `fs-sandbox`、`sandbox`、`bash-sandbox` 行 id 不变 | bundle 替换行的锚点 ID 不变，禁用/替换次序照旧 |
| typert `resolve` 声明、remotes（plugin-manager update state、tool results）、settings `effectiveConfig` | 新增 | 不相关：插件不消费这些面 |
| `packages/experimental` auto-review | 每条历史一条请求消息、locales、`AutoReviewFailedError` info、卸载规则变化 | 不跟进：可选 fork 钉死 `0.2.1-rc.2` 基线，`AUTO_REVIEW_RELEASE` 不动 |

## 环境要求变化

`0.2.2` 起 root `engines` 要求 Node `>=24.9.0`；CI verify 按已知旧版前缀（`0.1.*` / `0.2.0` / `0.2.1`）分流 Node `22.19.0`，其余版本（含 0.2.2 及以后）默认 Node `24.9.0`。`dsh` 的 cordis 依赖升至 `~4.0.6-alpha.1`，本插件 dev pin 与 peer 同步。

## 0.2.1-rc.5 后续审查（2026-10-30）

上游 `dsh-v0.2.1-rc.5` 指向 `b830ec950faba0a46dda564be3e2d854afed94f1`，npm 的 `latest` 和 `next` 均指向该版本；`alpha` 仍指向 `0.2.2-alpha.2`。两条发布线以 `0.2.1-rc.4` 为共同祖先，`rc.5` 与 `alpha.2` 互不包含，不能把后者视为已覆盖前者。

对比 `rc.4` 与 `rc.5`，除包版本号外，上游变化集中在聊天推理正文：`conversation.chat.reasoning.body` 的 owner 新增 `rawText`，`text` 改为适合显示的文本，推理摘要与翻译组件使用显示文本。插件不消费该 slot 或其类型，因此无需新增适配分支。`ui-sidebar-files`、`ui-open-in-app`、`workspace-files` 和 dockkit 的代码无变化；Files 的 `data-files-*`、dockkit 的 `data-dockkit-content` 及 open-in-app 的 `data-open-target` 钩子仍在。浏览器实机目检与各平台的执行证据见[路线账本](../plans/active/2026-09-12-multi-root-workspace.md)。


## 0.2.2-alpha.3 后续审查（2026-11-04）

上游标签 `dsh-v0.2.2-alpha.3` 指向 `05b1cae8db6e674c5685101494d4eec24652424a`。它与最近两条已发布基线 `0.2.2-alpha.2`（`f3803c9697`）和 `0.2.1-rc.5`（`b830ec950f`）分别比较；两条发布线并非线性祖先关系。alpha.2 到 alpha.3 的仓库 patch 涉及 2315 个文件，以下记录插件实际依赖的接缝。

- **文件变更接口**：`dsh-fs-local` 增加 `patchText`、`deleteFile` 和双端 `moveFile`，`tool-fs` 在发布配置中启用 `apply_patch`。插件继承 LocalFileSystem，若直接继承新方法就会绕开多根围栏，包括兼容门禁拒载但 provider 仍保留的情况。`src/compat/fs-patch.ts` 按方法是否存在安装包装；每次调用在同一次 Registry admission 内重新检查目标，move 的源和目标均须通过，沿用工具权限上限与撤权语义。旧后端不制造这些方法。
- **面板通道**：Connection 的公开 `rpc` getter 和 HTTP 形状未变，但 Cordis `4.0.6-alpha.2` 的 getter 追踪保留定义方上下文，原先从 root 取服务也可能在注册时解析不到 sibling `webServer`，导致真实 HTTP 405。`src/compat/connection-rpc.ts` 将公开 getter 绑定到同时注入 Connection 与 webServer 的消费 fiber；卸载该 fiber 释放路由。旧的属性形式也保留。
- **Files 页面**：页头从 `data-files-root` 祖先移到 `data-files-page`，原生树在 `data-files-content` 中；`data-dockkit-content` 保留。上游新增受控 `sidebar.files.tree` Factory。切换器识别两种页面并在新页面使用原生 Factory，旧版继续使用 alpha.2 复刻树；Factory 缺失时回退旧树。原生 open-in-app 六个复刻文件未变，上游新增的 locale 键已同步。新版预览旁的导航树与上下文菜单属于上游新功能，见 [files-tree fork](../../src/client/files-tree/FORK.md)。
- **其余接缝**：相对 alpha.2，workspace-files、sandbox、subprocess、terminal 的运行时代码未改变；系统提示新增 `TOOL_APPLY_PATCH` 顺序。上游保留 PTY 标记；Auto Review 仍以 `0.2.1-rc.2` 为独立精确基线。相对 rc.5 还包含 alpha.2 已审查的工具执行拆分、session projection 和原生额外可写根变化。

执行证据、各平台与矩阵状态只记录在[路线图账本](../plans/active/2026-09-12-multi-root-workspace.md)。

## 0.2.2-rc.1 后续审查（2026-11-05）

上游 tag `dsh-v0.2.2-rc.1` 指向 `66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db`。本次分别检查前两个发布版本 `0.2.2-alpha.3`（`05b1cae8db`）和 `0.2.2-alpha.2`（`f3803c9697`）到 rc.1 的完整 diff patch。

| 对照 | patch 范围 | 结论 |
| --- | --- | --- |
| alpha.3 → rc.1 | 387 个 `package.json`，各一行替换；所有源码和配置均无差异 | 378 个 DSH 包只更改版本号；9 个 vendor 包转入稳定版本，相对 alpha.3 未引入新 API 形状 |
| alpha.2 → rc.1 | 2315 个文件，87654 行新增 / 27240 行删除 | 包含上一节已审查并适配的 fs patch/delete/move、Connection getter、Files Factory 与 locale 变化；rc.1 未再改变这些接缝 |

发布生态从 Cordis `4.0.6-alpha.2` / Schemastery `3.18.6-alpha.2` / Cosmokit `1.8.7-alpha.2` 转为 `4.1.0` / `3.19.0` / `1.9.0`；loader、include、group、hmr、logger-console 为 `1.1.0`，timer 为 `1.2.0`。现有 Cordis 与 Schemastery peer 的稳定版本范围已覆盖这些版本，不能为了新开发 pin 删除旧宿主所需的具名 prerelease 分支。开发树同步重指 DSH 及其共享生态，并去除候选探测的临时 overrides 与全局 release-age 豁免。

稳定 vendor 发布暴露旧版回归安装树的宽范围陷阱：旧 DSH 的 loader `^1.0.3` 会接纳 `1.1.0`，但后者依赖新版 Cordis 的 `fiber.entry`，与 `4.0.2` 组合时 profile 启动失败。`scripts/lib/cordis-pin.mjs` 的 `ecosystemPin` 现对稳定版选择宿主声明 minor 线内的最新稳定 patch，对 prerelease 钉精确基线，未发布基线和复合范围直接拒绝。稳定线保留 patch 修复也有必要：Schemastery `3.18.2` 本身不含旧 Host 所需的 zod codec 支持，`3.18.5` 可用；不能把全部稳定线一律退回范围下限。对应 loader / timer / Schemastery 回归先红后绿；这属于矩阵安装工具修复，不在插件业务面新增版本判断。

`confine` 的返回形状、方言 grant、工具 dispatch、PTY 标记、Session/projection、Registry storage、Skills、Connection RPC 和 bundle 行锚点都沿用 alpha.3 的实现，无需新增适配器分支。上游 Files 的 `data-files-page` / `data-files-content`、`sidebar.files.tree` Factory、dockkit 与 open-in-app 钩子未变。open-in-app 六个 fork 文件与 locale 键集保持一致，出处记录提升到 rc.1；旧版 files-tree 仍保留 alpha.2 基线。可选 Auto Review 仍钉 `0.2.1-rc.2`。

原生平台、正式门禁、旧版回归与浏览器目检证据见[路线账本](../plans/active/2026-09-12-multi-root-workspace.md#dsh-022-rc1-兼容适配2026-11-05)。

## 0.2.2-rc.2 后续审查（2026-11-11）

上游 tag `dsh-v0.2.2-rc.2` 指向 `ddac96760b6edf8fa0fe17cbdcf0b512f4c12b2c`。审查时它尚未发布；现在 npm 已提供该精确版本（`next` 指向它，`latest` 仍为 `0.2.2-rc.1`）。本分支因此按 ADR-0009 完成提升：`SUPPORTED_DSH_RELEASES`、全部 DSH peer 与开发 pin 都指向 `0.2.2-rc.2`（23 个精确版本），开发树由 `scripts/upgrade-dsh.mjs 0.2.2-rc.2` 整体重指，候选期的临时 probe overrides 与临时 release-age 宽免已清理。

对照 `0.2.2-rc.1`（`66491b05e3`），rc.2 的仓库 patch 涉及 4645 个文件；下列是插件实际依赖的接缝。

| 接缝 / 上游源码 | 变化 | 分类与插件处理 |
|---|---|---|
| `dsh-sandbox` / `dsh-sandbox-local` / `dsh-sandbox-policy` / `dsh-sandbox-windows-acl` | `SandboxUnsupportedPolicyError` 删除，新增 `SandboxPreparationError`（`SANDBOX_PREPARATION_FAILED` / `SANDBOX_INVALID_TEMP_ROOT`，保留 `cause`）与 `SandboxEscalationError`（`SANDBOX_ESCALATION_*`）；Windows ACL 不再因 `additionalWritableRoots` 拒绝执行，进程侧忽略这些额外根、文件工具仍执行；`isTempRootInsideWorkspace` 与 `assertTempRootOutsideWorkspace` 并存；`workspaceWritableRoots` 的额外根比较改用 `relative()`（接受 Windows 大小写/分隔符差异），`writableRoots`、`SandboxExecutionPolicy`、`confine` 形状未变 | 无需新适配分支：插件 fs fence 从 `writableRoots(policy)` 起算，上游额外根自动进入文件写入集；deny 仍先于包含判断；authority unavailable 仍钳制到主根；Windows 进程 profile 只拼接插件 scope 根。`SandboxPreparationError`/新增 escalation 码只影响上游错误分类，插件不按错误类路由；真实 ACL 失败仍 fail-closed。结构化回归：`tests/upstream-additional-roots.spec.ts` 的 per-Session 小节，以及 `tests/sandbox-multi-root.spec.ts` 的 Windows ACL 组合用例（scope 根进入进程 profile，上游额外根不进入） |
| `dsh-sandbox-policy` 会话级授权 | 新增 `registerWritableRoot(session, directory): () => void`；`resolve({ session })` 把配置根与当前 Session 的活注册合并进 `additionalWritableRoots`，注册是运行时事实、恢复/分叉后不自动恢复；`sessionWorkspaceRoot` 对非法 cwd 抛 `SandboxInvalidRootError` | 上游第三个原生可写根通道。插件不设置该字段，但继承的 provider 与 fs fence 会消费它：POSIX 方言把注册根写进同一 profile，fs fence 允许其写入；scope 的 `read-only` deny 仍在包含判断前拒绝（回归钉住“deny 胜过原生注册”）；Windows 进程侧按上游语义忽略，文件工具仍生效；authority unavailable 时插件仍只保留主根。未新增公开 API，仅在兼容审查与契约文档记录 |
| `dsh-api-workspace-files` + `dsh-util-ripgrep` | 新增 `WorkspaceFiles.search(scope, request, signal)`：打包 `rg --files`，经 `ctx.subprocess` 执行，新增 `search` 预算配置与 `workspace-file/search-failed`，并新增 `@deepseek-ai/dsh-util-ripgrep` / `@vscode/ripgrep` 依赖；`/types` 增加搜索请求、匹配与结果类型 | `src/workspace-files.ts` 把 `search` 纳入共享 authority 的 `withOperation(..., 'files', ...)` 排序（与其他文件读同一 admission），并对其 **Session 根**应用 withheld 检查（`list`/`changes` 检查路径解析后的所选目录）：搜索根（`canonicalRoot`）落在在册未授权边界下时，在启动 `rg` 前以 `workspace-file/outside-workspace` 拒绝。**不路由**：搜索根是 Session cwd，插件没有附加根搜索 UI，路由无目标。未改上游 codec 与读取上限 |
| `ui-sidebar-files` | 新增导航器搜索条/结果树/搜索设置，store actions `searchBarShown`/`queried`/`searching`/`searched`/`searchToggled`，`FilesInjected` 增加 `setQuery`/`toggleSearch`/`retrySearch`/`setSearchPreferences`/`searchDrawn` 与 `keyedHooks.searchPreferences`；`sidebar.files.tree` Factory 增加可选 `highlight`、目录状态增加 `omitted`；页面新增 `data-files-search`、`data-files-search-status`、`data-files-search-toggle`、`data-files-view`；`focus()` 改为聚焦搜索框，Files 页搜索条由页头开关控制 | 旧版复刻树仍钉 alpha.2，行级定义不变；接管（Files 页附加根、预览导航重定向）时原生 body 已隐藏，搜索条、状态行与页头开关随 body 一起隐藏，避免“搜索主根、结果画进隐藏 body”的死控件；primary 根浏览保持上游原样。`focus()` 不再把键盘交给被接管的树（树行仍可 Tab/点击），作为已知降级记录；新增 CSS 规则与 DOM 回归见 `tests/client-styles.spec.ts` |
| `ui-open-in-app` | 两个复刻源只改注释；locale 新增 `menu.openIn`；Session header 入口迁往 context menu / `session-open-with`（不在 fork 范围） | 本分支已按 `src/client/open-in-app/FORK.md` 重拷 `OpenInAppAction.tsx` / `controller.ts`，把 baseline 移到 `ddac96760b`，并在 `OpenInAppKey` 补 `menu.openIn`；其余四个许可 delta 不变 |
| `ui-slots` / `ui-context-menu` / `ui-primitives` / `ui-renderer` | 新增 `hoc` slot kind 与 `contextMenu.button` Factory；`contextMenus.open` 增加 options、`registeredKinds`；移除 `useAnchoredPosition`，新增 `anchorPoint`、图标与 markdown 面 | 插件只使用 `slots.register`、`contextMenus.register`、`Menu`/primitives 的已探测导出；`open` 的调用面未使用，无适配 |
| `dsh-error`（新包） | `HarnessError` 基类迁入新共享包；`dsh-llm` re-export；`dsh-sandbox`、`dsh-subprocess`、`dsh-working-directory` 直接使用。跨包 `instanceof` 依赖宿主单例 | 加入 `OPTIONAL_CORE_PACKAGES` + `HOST_SERVICE_PACKAGES`，只经宿主锚点作证，用于发现混装；**不**列入 `peerDependencies`（rc.1 不存在该包，列入会让旧宿主安装失败）。插件不 import 它 |
| `dsh-subprocess` | 新增 `SubprocessError` / `SUBPROCESS_*`、`subprocessSpawnFailure`；`SubprocessExecutableNotFoundError` 改为编码错误；Linux launch 请求新增 `pipeFds`；Windows runner IPC 失败改为编码错误 | 插件 spawn 包装只改 argv 或按已铸造 profile 拒绝，按结构探测，不解析错误类；无适配 |
| `dsh-session` / `session-projection` / `working-directory` | `Session.append` 增加数组 overload；`working-directory/access` waterfall 与 `WorkingDirectoryError` 码；projection `stateVersion` 文档收紧 | 插件不包装 `Session.append`、不消费 `working-directory/access`；无适配 |
| `dsh-fs` | 新增 `fsErrorFromErrno`、`FS_ALREADY_EXISTS`，`FsError` 显式设置 `name` | 插件不按错误名或新码路由；无适配 |
| runtime-context 提醒、plugin-manager `BundleInfo.update`、`TerminalBackendCleanupError`、attachment 错误码、tool-fs/read_image | 各自语义变化 | 不在插件接缝；插件 runtime-context 贡献仍走上游公开 API，自动继承 reminder 包装 |

环境要求与 rc.1 相同：Node `>=24.9`、Cordis `4.1.0`、Schemastery `3.19.0`；可选 Auto Review 仍钉 `0.2.1-rc.2`。

### 发布后验证（已发布包）

在已发布的 `0.2.2-rc.2` 开发树上按 enforce 车道验证，不再使用自建候选树：

- `compat:check`：allowlist、peer、开发 pin、安装树一致（23 个精确版本）；
- lint、双端 `tsc --noEmit`、`build`、`docs:check`、`pack:check`、`auto-review:fork`：通过；
- 完整 `vitest`：**1368 通过 / 162 跳过 / 17 失败**。17 个失败全部是共享 authority 的核内 IPC 用例（`registry-*` / `authority-boundaries` / `b9-review-regressions` / `skills-authority` / `skills-registry`）：本会话运行在 DSH 自身的 Seatbelt 内，Peer 凭据被识别为 sandboxed peer；未改动的 rc.1 基线在同一环境同样失败 17 个（1364 通过 / 166 跳过），因此不是 rc.2 回归。
- 三个 Host smoke 与 packed：compose **56/56**、behavior **96 通过 / 8 跳过**、journey **85 通过 / 2 跳过**、packed **95 通过 / 8 跳过**，0 失败；跳过项是 Seatbelt 内无可用内核 runner 与共享 IPC。真实三 OS 矩阵与 Windows ACL 原生结果由 PR 的 CI 给出（[run 43227479998](https://github.com/cherrchen/dsh-plugin-multi-root-workspace/actions/runs/43227479998)，94/94 jobs）；浏览器目检不是 CI 项，按路线账本的人工记录。

### 提升步骤（本分支已执行）

1. 确认 npm 上 `0.2.2-rc.2` 可解析（`next` 指向它），执行 `node scripts/upgrade-dsh.mjs 0.2.2-rc.2` 重指 devDependencies / release-age / 生态 pin；
2. 在 `SUPPORTED_DSH_RELEASES` 末尾加入 `0.2.2-rc.2`，同步所有 DSH peer 列表与 dev pin；刷新 lockfile，并删除 probe overrides、补齐新传递包的 `minimumReleaseAgeExclude`；
3. 重拷 open-in-app 复刻源并移动 FORK.md 基线到 `ddac96760b`（rc.2 只有注释与 `menu.openIn` 差异）；
4. 以 enforce 重跑 `compat:check`、类型检查、构建、文档与打包检查；完整矩阵、Host smoke 与三 OS 原生结果由 PR 的 CI 覆盖；
5. 更新 `README` 的支持矩阵、`AGENTS.md` 的兼容契约段与路线账本的执行证据；`CHANGELOG` 条目随实际发版的发布流程写入，本分支不创建版本号或 tag。

执行证据、平台覆盖与发布状态只维护在[路线图账本](../plans/active/2026-09-12-multi-root-workspace.md)。

## 0.2.2-rc.3 后续审查（2026-11-13）

上游 tag `dsh-v0.2.2-rc.3` 指向 `38a6a5c965aa99ab525161efb7cc5cf1fe62fced`，npm 已发布该精确版本（`next` 指向它，`latest` 仍为 `0.2.2-rc.1`）。本分支按 ADR-0009 完成提升：`SUPPORTED_DSH_RELEASES`、全部 DSH peer 与开发 pin 都指向 `0.2.2-rc.3`（24 个精确版本），开发树由 `scripts/upgrade-dsh.mjs 0.2.2-rc.3` 整体重指，候选期的临时 probe overrides 已移除。

对照 `0.2.2-rc.2`（`ddac96760b`），rc.3 只有 6 个提交、515 个文件、10988 行新增 / 669 行删除；其中 380 个 `package.json` 只替换版本号，其余改动集中在下列面。插件实际依赖的 sandbox、fs、tools、session、storage、skills、lsp、workspace-files 与 Connection 运行时源码**全部未变**。

| 接缝 / 上游源码 | 变化 | 分类与插件处理 |
|---|---|---|
| `ui-sidebar` | 新增 `sidebar.session.action`（`hoc`）槽包住新会话行内容；`SidebarRoot.module.css` 把该行的边距/动画移到新的 `.newSessionRow` 外层，`data-slot='sidebar.session.action'` 作为无盒锚点；`sidebar.footer.action` 契约未变 | 纯新增。插件只注册 `sidebar.footer.action`，新会话行的 DOM/CSS 变化不触及页脚动作 seat；无适配 |
| `ui-workspace` | 新增 `workspace.picker` Factory（`SlotFactoryMap`）与第三个 directory-flow 洞 `workspace.picker.directoryFlow`；`WorkspacePicker` 抽出 `surfaceFlow` 供 slot 与 Factory 共用；新增只读类型导出 `WorkspacePickerInput` / `WorkspacePickerFactoryProps`，`WorkspacePickerProps` 与 `WorkspacePickerInjected` 未变 | 纯新增。插件只对 `@deepseek-ai/dsh-client-ui-slots` 做自身槽位的类型合并，不注册也不使用该 Factory；无适配 |
| `ui-directory-picker-browse` / `ui-directory-picker-native` | 两个 flow 包改为向三个 directory-flow 洞事务性注册（嵌套 `slots.inject`） | 插件不使用目录选择器；无适配 |
| `ui-primitives` | 新增 `IconUploadOutlineRegular` / `IconUploadOutlineMedium` 与 artwork 条目 | 纯新增导出；插件的图标探测按名字存在性判断，旧宿主照常回退；无适配 |
| `packages/experimental/deepseek-chat-import`（新包） | 可选实验 bundle：owner-only 上传 Remote `deepseekChatImport.limits`、内存内解压、逐会话导入；新增外部依赖 `fflate` 与 `zod 4.6.6`；`official-bundles` 把它列入 `OPTIONAL_BUNDLES` / `MORE_BUNDLES` / `EXPERIMENTAL_BUNDLES`，`apps/cli` 作为可选依赖携带 | 默认不挂载，与插件的围栏、Registry、范围无任何接缝；**不**加入 `OPTIONAL_CORE_PACKAGES`（该清单只登记会与插件交叉的副本）。新增的 `zod 4.6.6` 是它自己的精确 pin，不影响 `dsh-storage-domain` 的 `4.4.3` 与插件的 `storage-zod` 路径 |
| `session-log-export` | zip 导出对不可读附件降级：跳过 `ATTACHMENT_NOT_FOUND` / `INVALID_ATTACHMENT_REF` 并写入 `attachments-missing.txt`，其余失败仍整体失败 | 插件不消费会话导出；无适配 |
| `tool-cordis` `api-catalog` / `cordis-client-runner` `slot-catalog` | 生成目录随新 Remote 与槽位声明更新 | 纯生成物；插件不读取这些目录 |
| `apps/desktop` restart-status、`scripts/ci-verified-download.sh`、CI workflow | Windows 安装器重启状态目录锁修复；CI 下载校验 | 安装器/CI 面，不在插件运行时接缝 |

环境要求与 rc.1/rc.2 相同：Node `>=24.9`、Cordis `4.1.0`、Schemastery `3.19.0`；可选 Auto Review 仍钉 `0.2.1-rc.2`。open-in-app 与 files-tree 的复刻源在 rc.3 未变，基线保持 `ddac96760b`（open-in-app）与 `f3803c9697`（files-tree 旧版）。

### 提升步骤（本分支已执行）

1. 确认 npm 上 `0.2.2-rc.3` 可解析（`next` 指向它），执行 `node scripts/upgrade-dsh.mjs 0.2.2-rc.3` 重指 devDependencies / release-age / 生态 pin；
2. 在 `SUPPORTED_DSH_RELEASES` 末尾加入 `0.2.2-rc.3`，同步 28 个 DSH peer 列表与 dev pin；移除 probe overrides，`pnpm install --frozen-lockfile` 后 lockfile 中不再有任何 `0.2.2-rc.2` 包副本；
3. 把 rc.3 新增的唯一传递包 `@deepseek-ai/dsh-deepseek-chat-import` 补进 `minimumReleaseAgeExclude` 的精确传递包块；
4. 以 enforce 重跑 `compat:check`、lint、双端类型检查、构建、文档与打包检查；完整矩阵、Host smoke 与三 OS 原生结果由 PR 的 CI 覆盖；
5. 更新 README 支持矩阵、`AGENTS.md` 兼容契约段、兼容笔记双语 §18 与路线账本；`CHANGELOG` 条目随实际发版的发布流程写入，本分支不创建版本号或 tag。

### 安静陷阱（开发树）

- **peer-only 副本会留在 lockfile**：升级脚本只重指直接依赖与 release-age 条目。rc.2 → rc.3 之后，`@deepseek-ai/dsh-permission-presets` 与 `@deepseek-ai/dsh-util-values` 仍以 rc.2 副本满足 peer 边（rc.3 各包声明的是精确 peer），`pnpm peers check` 因此报 unmet peer；`pnpm dedupe`、`--force` 与 `--lockfile-only` 都不会改写这类仍“看似有效”的边。落地前必须让它们升到同一精确版本，最终 `pnpm peers check` 输出 `No peer dependency issues found`，lockfile 中 `0.2.2-rc.2` 只作为 peer 范围字符串出现。
- **新包不是契约成员**：`@deepseek-ai/dsh-deepseek-chat-import` 默认不挂载，与插件的授权面没有交点；把它写进 `CORE_PACKAGES` 只会让最小组合误报 `incomplete`。
- **升级脚本只重指既有条目**：`minimumReleaseAgeExclude` 的新增传递包仍需手工补一行，否则在启用发布年龄门禁的环境里 frozen install 会被拒绝。
