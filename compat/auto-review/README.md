# Multi-root Auto Review 兼容层

English: [README.en.md](./README.en.md)

仅适用于 DSH `0.2.1-rc.2`，需显式启用官方 Auto Review 与 Multi-root Workspace `0.1.8`。普通 Multi-root 安装不会开启 Auto。

先停止目标 profile，显式选中官方 Auto Review 与 Multi-root，然后安装本仓库构建的 companion tarball。主仓库 `pnpm build` 同时构建两包；分别在仓库根和本目录运行 `pnpm pack`。

在目标 profile 的目录中可用安装后的 bin；也可直接执行：

```sh
node "<profile-directory>/node_modules/@dsh-electron/dsh-plugin-multi-root-auto-review/configure.mjs" enable "<profile-directory>"
```

完成后重启或重新组合 profile。此命令把 companion 放在已选官方 bundle 之后；缺少官方或 Multi-root 选择时拒绝启用。不得在启用后把官方 bundle 移到 companion 后面。`disable` 从 bundle 列表撤下兼容层，恢复官方组合；它保留依赖和其他配置。

卸载/禁用存活的 Auto owner 会按官方逻辑把 Auto Session 迁移为 Full access。重新加载不会自动把它们切回 Auto；Multi-root 写围栏继续生效。

当前拓扑与指令进入 reviewer 数据分区，项目文本只作为 constraint。预算、I/O、取消或快照变化使本次调用失败。纯附加根 native 旧帧降为历史 fact，由当前文件替代。混合 native 帧如果不能证明附加文件仍当前，则失败关闭，须先刷新 native baseline。bash/pwsh 只收集已知目录链，不能推断任意脚本的全部目标。普通源码自动读取不在本版范围内。

Fork 基线与同步规则见 [FORK.md](./FORK.md)。完整设计与验证记录保存在主仓库文档中。
