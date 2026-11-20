# SSH 环境与 Workspace Root 绑定拆分

状态：已实施并通过本地门禁（2026-11-20），跨平台矩阵由本分支的手动 CI 验证。

## 目标

插件级 SSH 环境可以独立创建、测试和安装 Helper。当前 Workspace 从已有连接绑定远端目录。同一 Workspace 可以多次选择同一连接，每条绑定有独立的 Root ID、目录和权限。当前两个入口都在 Workspace Folders，后续可以独立迁移 SSH 管理入口。

## 实施顺序

1. 拆分 personal 存储和保存契约。连接记录移除 `workspace`，绑定以本地主根归档。读取旧格式时保留已明确保存的路径、权限和连接，首次变更安全迁移。沿用 Host 派生主根、跨进程 CAS、文件保护和既有绑定校验。
2. 接入 Root 范围的 Helper。personal 模式用核验或准入中的绑定目录启动与缓存 Helper，文件传输仍复用连接。保留 team/hardened 的部署清单约束。
3. Workspace Folders 保留 SSH 管理入口，另设绑定入口。连接创建确认主机密钥后即完成；绑定对话框从现有环境选择目录和权限，支持逐条登记和解绑。同步八语言界面与参考文档。
4. 修复上一轮 CI 的 Windows personal 投影测试平台假设，以及 Ubuntu 上复制反馈定时器在 React 卸载后更新状态的问题。
5. 验证旧格式迁移、无 Root 创建、同连接多 Root、跨 Workspace 隔离、绑定权限及回归测试。运行本地常规门禁和可运行的完整验证，提交推送到 `feat/ssh-workspace`，手动触发 CI 并检查矩阵结果。

## 验收

- SSH 保存请求无需远端工作路径。单独创建连接后 Workspace 绑定保持为空。
- 两个 Root 可以引用同一环境。解绑一个只撤回对应 Root，其他绑定和连接继续存在。
- 既有绑定路径来自绑定记录，Helper 的 personal 远端执行范围来自对应 Root。
- 本地验证和手动 CI 的结果可追溯。

当前行为及配置见 [SSH 远端环境参考](../../reference/ssh-remote-environments.md)。

## 验证记录

- macOS arm64、Node 24.18.0、pnpm 11.25.0。本地 `pnpm verify:all` 通过，Vitest 2477 通过、133 按条件跳过；compose 58/58，behavior 137/137，journey 95/95，打包产物的 behavior 136/136，Auto Review fork 与联合冒烟通过。
- `pnpm docs:check` 和 `pnpm compat:check` 通过。
- [上一次失败的 CI](https://github.com/cherrchen/dsh-plugin-multi-root-workspace/actions/runs/44558186924) 中，Windows 投影测试错误地统一期待 `ready`，Ubuntu 上的剪贴板反馈定时器在组件卸载后触发 React 更新。修复保留 Windows 的 `platform-deferred` 平台行为，并在组件卸载时清理定时器。
