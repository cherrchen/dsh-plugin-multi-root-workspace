# 可选 Auto Review

English: [README.en.md](./README.en.md)

Auto Review 已内置于 `@dsh-electron/dsh-plugin-multi-root-workspace/auto-review`，仅支持 DSH `0.2.1-rc.2`。安装主包后，在插件管理器中展开 Multi-root Workspace 的行列表，打开 `multi-root-auto-review`。该行出厂关闭；关闭时不挂载 reviewer 或 review context，也不注册 Auto preset。无热重载的 profile 需要按管理器提示重启。

启用后，同一个开关挂载当前多根 context 与 reviewer，并在运行时停止同组官方 `@deepseek-ai/dsh-experimental-auto-review` 行。官方 bundle 位于主包前后均可；后续 reload 仍保持单一 owner。接管不修改官方的持久配置。关闭后，官方仅在仍被选择且原配置允许启用时随 reload/restart 恢复；官方未被选择时不会自动安装或启用。官方 bundle 未被选择时，该行仍独立提供同一份 reviewer（自带注册 Auto preset），只是没有可接管的官方 owner。

也可在 profile 的 `cordis.patch.yml` 中显式设置：

```yaml
- id: multi-root-auto-review
  disabled: false
```

卸载任何存活的 Auto owner 都保留官方语义：Auto Session 迁移为 Full access；新 owner 不会自动把它们切回 Auto。需要继续使用 Auto 时，在 Session 中重新选择。Multi-root 的写围栏继续执行。

从旧 companion 迁移时，先停止目标 profile，移除其 bundle 选择和 `@dsh-electron/dsh-plugin-multi-root-auto-review` 依赖，再安装/更新主包并打开上述行。可使用现有 `dsh plugin --profile <name> remove @dsh-electron/dsh-plugin-multi-root-auto-review` 清理旧包；保留官方 bundle 的原有选择。旧版 configure 不再使用。残留旧 companion 与内置入口共存时会明确拒绝启动，不会自动重写用户 manifest。

约束、预算、混合 native 帧与 freshness 语义沿用原 fork：当前拓扑和指令进入 reviewer 数据分区，项目文本仅为 constraint；预算、I/O、取消或快照变化使本次调用失败。bash/pwsh 只收集已知目录链，不能推断任意脚本的全部目标；普通源码自动读取不在范围内。

Fork 基线、允许差异与同步规则见 [FORK.md](./FORK.md)。
