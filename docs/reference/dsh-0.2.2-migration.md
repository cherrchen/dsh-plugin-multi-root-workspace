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
