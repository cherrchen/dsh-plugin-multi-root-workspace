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
| `dsh-client-ui-primitives` | 新增 `isMobileDevice`；`Toast` 增 `tone`/`actions` | fork 侧 `device.ts` 结构探测 shim；`upstream-surface.d.ts` 增加 `Toast` 重载（0.1.5 像素期无 `tone`） |
| `packages/bundle/base/cordis.patch.yml` | `fs-sandbox`、`sandbox`、`bash-sandbox` 行 id 不变 | bundle 替换行的锚点 ID 不变，禁用/替换次序照旧 |
| typert `resolve` 声明、remotes（plugin-manager update state、tool results）、settings `effectiveConfig` | 新增 | 不相关：插件不消费这些面 |
| `packages/experimental` auto-review | 每条历史一条请求消息、locales、`AutoReviewFailedError` info、卸载规则变化 | 不跟进：可选 fork 钉死 `0.2.1-rc.2` 基线，`AUTO_REVIEW_RELEASE` 不动 |

## 环境要求变化

`0.2.2` 起 root `engines` 要求 Node `>=24.9.0`；CI verify 按已知旧版前缀（`0.1.*` / `0.2.0` / `0.2.1`）分流 Node `22.19.0`，其余版本（含 0.2.2 及以后）默认 Node `24.9.0`。`dsh` 的 cordis 依赖升至 `~4.0.6-alpha.1`，本插件 dev pin 与 peer 同步。
