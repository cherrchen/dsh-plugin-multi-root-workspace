# DSH Desktop 插件页安装后缺少 dsh.profile.bundles 登记（issue #57）

## 症状

DSH Desktop 的**插件**页安装本插件后，出现下面任意一组：

- `~/.dsh/profiles/desktop/package.json` 的 `dependencies` 里有 `@dsh-electron/dsh-plugin-multi-root-workspace`，但 `dsh.profile.bundles` 里没有；
- 插件页显示已安装、开关也像是打开的，但启用时报 `启用失败`，组件列表停在 pending / 异常；
- 报错包含：

  ```text
  dsh: warning: 12 entries did not activate
  multi-root-fs (.../fs): Error: service "fs" has been registered at <SandboxedFileSystem>
  multi-root-sandbox (.../sandbox): Error: service "sandbox" has been registered at <LocalSandboxProvider>
  multi-root-providers ...: pending (waiting for services: fs, sandbox)
  ```

- 手工把包加到 `dsh.profile.bundles` 后，完全退出 Desktop 再冷启动可以正常使用；但在运行中的 Desktop 里关闭再启用本包会回到失败状态。

## 根本原因

### 安装和启用是两步

插件页的**添加插件**不是 CLI 的 `dsh plugin add` 的等价入口。普通输入框安装时，客户端把 `enabled: false` 传给宿主：这次调用只把包写进 `dependencies`，不写 `dsh.profile.bundles`。安装完成后的**立即启用**（或之后切换包开关）才单独写入 `dsh.profile.bundles`。

因此“`dependencies` 有包、`dsh.profile.bundles` 没有”本身是安装中间态，不是 bundle 登记被删除。重跑一次 `add` 也不会补上：`dsh plugin` 的 reconcile 只登记“本次运行新增”的依赖，而失败或中途中止的安装已经把依赖留在了 `dependencies` 里。

### 热启用会撞上仍在运行的旧 provider

本插件的 bundle patch 先禁用上游 `fs-sandbox` / `sandbox` 两行，再插入自己的 `multi-root-fs` / `multi-root-sandbox`（[ADR-0001](../decisions/ADR-0001-provider-replacement-scope.md)）。冷启动时组合器先得到最终行表，被禁用的旧行从未启动，所以不会冲突。

运行中启用 bundle 时，宿主走的是热重组。从 Loader 的实现看，`EntryGroup.update` 会并行处理所有新行和已存在行：旧 `fs-sandbox` / `sandbox` 行收到 `disabled: true` 后开始 dispose，但 Cordis 的 Fiber 要等所有依赖者卸载后才释放 service；与此同时，新插入的 `multi-root-fs` / `multi-root-sandbox` 已经开始注册 `fs` / `sandbox`。旧 service 还在，Cordis 便以重复注册拒绝。错误里的 `<SandboxedFileSystem>` 和 `<LocalSandboxProvider>` 正是旧行拥有的实现，不是本插件重复插入。

这是宿主热重组的执行顺序问题，不是两个 provider 类的实现缺陷；`v0.1.18` 到 `v0.1.19` 的 provider 替换补丁没有变化。

### bundle 登记消失的实际写入者

本轮**没有复现**“刷新列表或安装其它插件会删除 `dsh.profile.bundles` 条目”：

- 在隔离 Web 宿主里点插件页**刷新**不写 `package.json`（mtime 不变），登记保持；
- 在同一宿主安装一个无关插件只新增它自己的依赖，本包登记保持。

对本插件，启动时的 `initProfile` 只在 `package.json` 缺失时创建文件，不会重写已存在的 bundle 列表；`normalizeShippedProfile` 只重写与内置模板完全相同的 bundle tuple，`dropRetiredBundles` 只删除已退役的内置 bundle，两者都不匹配本包。能改本包登记的路径只有：插件页显式关闭/卸载本包、`dsh plugin remove` / `add`、以及 Desktop 原生恢复对话框的“禁用第三方插件并重启”（`sanitizeProfile` 会把 bundle 列表恢复为内置模板）。Windows Desktop 窗口内的复现和实际写入者仍待验证；如果再次出现，建议在 Windows 上对该文件做写入进程审计（例如 ProcMon）并同时保留 Desktop 诊断日志。

## 诊断方法

1. 读 `~/.dsh/profiles/desktop/package.json`（设置了 `DSH_HOME` 时读 `$DSH_HOME/profiles/desktop/package.json`），同时检查 `dependencies` 和 `dsh.profile.bundles`。只有前者时，按下面的恢复步骤做 `remove` + `add`。
2. 看插件页组件列表：本包应显示运行中；`multi-root-fs` / `multi-root-sandbox` 异常且原因包含 `service "fs" has been registered` 时，属于热启用冲突，冷启动后再看。
3. 区分“刷新”和“写入”：在插件页点刷新前后比较 `package.json` 的 mtime；刷新只重新读取，不会补写 bundle 登记。

## 已验证的解决方案

完全退出 Desktop（含托盘），用 Desktop 安装目录内 `resources/runtime/cli/bin` 随附的 `dsh` 管理 `desktop` profile：

```sh
dsh plugin --profile desktop remove @dsh-electron/dsh-plugin-multi-root-workspace
dsh plugin --profile desktop add @dsh-electron/dsh-plugin-multi-root-workspace@0.1.19
```

确认 `dsh.profile.bundles` 出现本包后再打开 Desktop。完整步骤和构建授权（`allowBuilds: { koffi: true }`）的处理见 [README §安装](../../README.md#安装)的 DSH Desktop 小节。

隔离验证（临时 `desktop` profile + Desktop 自带 CLI）确认了这个恢复路径：第一次 `add` 因 `koffi` 构建授权失败并留下 `dependencies`；补上 `allowBuilds` 后重跑 `add` 退出 0，但 `dsh.profile.bundles` 仍为空；执行 `remove` + `add` 后才写入本包。

## 复现记录

环境为 DSH Desktop 自带运行时的隔离 Web 入口（同一 Host 代码，不是 Windows Desktop 窗口）。每一步的 profile 状态与运行时结果：

| 步骤 | `dependencies` | `dsh.profile.bundles` | `fs-sandbox` / `sandbox` 的 `disabled` | provider / 组件状态 | 启用错误 |
| --- | --- | --- | --- | --- | --- |
| 初始 profile | 无 | `dsh-base`、`dsh-web-app` | 缺省 `false` | 上游 provider 运行中 | 无 |
| 插件页添加插件 | 有本包 | 未变 | 缺省 `false` | 本插件行未启动 | 无 |
| 点“立即启用” | 有本包 | 加入本包 | 组合结果为 `true`，但运行时旧行尚未释放 | 12 条 pending / 异常 | 见下 |
| 插件页刷新 | 未变 | 未变 | 未变 | 错误保持 | mtime 不变 |
| 安装无关插件 | 增加无关包 | 本包仍在 | 未变 | 错误保持 | 无删除 |
| 完全退出后重启 | 未变 | 本包仍在 | `true` | 15 运行中、1 默认关闭 | 无 |
| 关闭本包开关 | 未变 | 移除本包 | `false` | 本插件行全部关闭 | 无 |
| 重新打开开关 | 未变 | 重新加入 | 运行时旧行仍占用 | 再次异常 | 同下 |

完整启用错误：

```text
启用失败: dsh: warning: 12 entries did not activate
multi-root-fs (@dsh-electron/dsh-plugin-multi-root-workspace/fs): Error: service "fs" has been registered at <SandboxedFileSystem>
multi-root-sandbox (@dsh-electron/dsh-plugin-multi-root-workspace/sandbox): Error: service "sandbox" has been registered at <LocalSandboxProvider>
multi-root-providers (@dsh-electron/dsh-plugin-multi-root-workspace/providers): pending (waiting for services: fs, sandbox)
multi-root-ops-compatibility (@dsh-electron/dsh-plugin-multi-root-workspace/ops-compatibility): pending (waiting for service: multiRootProviders)
multi-root-registry (@dsh-electron/dsh-plugin-multi-root-workspace/registry): pending (waiting for service: multiRootProviders)
multi-root-skills (@dsh-electron/dsh-plugin-multi-root-workspace/skills): pending (waiting for services: multiRootProviders, multiRootRegistry)
multi-root-worktrees (@dsh-electron/dsh-plugin-multi-root-workspace/worktrees): pending (waiting for services: multiRootProviders, multiRootRegistry)
multi-root-instructions (@dsh-electron/dsh-plugin-multi-root-workspace/instructions): pending (waiting for service: multiRootProviders)
multi-root-lsp (@dsh-electron/dsh-plugin-multi-root-workspace/lsp): pending (waiting for service: multiRootProviders)
multi-root-workspace-files (@dsh-electron/dsh-plugin-multi-root-workspace/workspace-files): pending (waiting for service: multiRootProviders)
multi-root-process-fence (@dsh-electron/dsh-plugin-multi-root-workspace/process-fence): pending (waiting for services: multiRootProviders, sandbox)
multi-root-command (@dsh-electron/dsh-plugin-multi-root-workspace/command): pending (waiting for service: multiRootRegistry)
```

## 上游修复建议

热重组应在启动新行之前，先处理本次 generation 里“由启用改为禁用”或不再列出的旧行，并等待它们的 Fiber 释放 service；随后再插入并启动新 provider 行。最小回归可以用一个 bundle patch 覆盖：禁用上游 `fs-sandbox` / `sandbox`，插入两个同名 service 的替身，然后在运行中的应用里从 bundle 未选中切到选中，断言旧行完成 dispose 后新行才进入 ACTIVE。

## 相关

- [README §安装](../../README.md#安装)（Desktop 恢复步骤与 CLI 参数）
- [安装停在构建授权](./install-stops-at-build-approval.md)（`allowBuilds` 与“重跑 add 不激活”的同一恢复形态）
- [ADR-0001：provider replacement scope](../decisions/ADR-0001-provider-replacement-scope.md)
