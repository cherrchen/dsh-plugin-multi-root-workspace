# 技术参考（Reference）

English: [README.en.md](./README.en.md)

## 这里存放什么

稳定的参考资料，例如：

- configuration reference；
- API reference；
- schemas；
- protocols；
- file formats。

## 不应该存放什么

- Proposal 或 Target Design；
- brainstorming 与临时讨论；
- 开发计划；
- 尚未确定的设想。

这里只放已经确定、相对稳定的事实性参考内容。

## 当前状态

- [multi-root-skills-seams.md](./multi-root-skills-seams.md) — 附加根 Skills 的 Session、原生 ID、Effective CWD、文件解析、Settings 与 Web 接缝源码事实及可复现原型方法。
- [auto-review-compatibility.md](./auto-review-compatibility.md) — Auto Review `0.2.1-rc.2` 的上下文、来源分类、工具调度时机与外部兼容接缝调研。
- [multi-root-workspace-research.md](./multi-root-workspace-research.md) — 上游官方仓库 Workspace / Sandbox / 插件体系现状调研快照（master `c291e7961a`；§8 为"不改上游"机制的补充调研）。

## 推荐命名

使用小写中划线命名，例如：

```text
<topic>.md
```

- [dsh-0.2.1-migration.md](./dsh-0.2.1-migration.md) — DSH 0.2.1 三个上游 tag 的接口、安全不变量与 Worktree 约束审查。
- [dsh-0.2.2-migration.md](./dsh-0.2.2-migration.md) — DSH 0.2.1-rc.4、0.2.1-rc.5 与 0.2.2-alpha.2 的接口与安全契约审查（sessionProjections 注入、工具执行拆分、additionalWritableRoots、Node 24 要求）。
