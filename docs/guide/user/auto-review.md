# Auto Review 多根审查

English: [auto-review.en.md](./auto-review.en.md)

开启后，Auto Review 也会看到附加根的目录结构、访问级别和指令文件，把附加根一并纳入审查。

## 开启

侧栏「插件」→ Multi-root Workspace 详情页：

- 在组件列表中启用默认关闭的 Auto Review 行；或
- 在设置卡中打开 **多根 Auto Review（实验性）**。

两个入口等价，默认都关闭。普通安装不会自动启用或选择 Auto Review。

## 可用范围

该集成只随提供它的 DSH 精确发布生效。不在范围内时，普通安装和原有功能不受影响，只是没有这个审查增强。

## 与权限的关系

Auto Review 的增强只影响审查能看到的内容，不改变沙箱写权限。附加根能否被写，仍然由访问级别和当前会话模式决定。
