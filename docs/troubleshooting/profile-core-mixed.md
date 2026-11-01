# 启动器报 profile-core-mixed / profile-core-copy（issue #30）

## 症状

在 DSH profile 里安装本插件后，启动器的依赖自检报告 profile 混入了核心包副本，并提示"该 profile 的工具调用可能全部失败"。`$DSH_HOME/profiles/<name>/node_modules` 下出现本不该存在的多余副本，例如：

```text
@deepseek-ai/schemastery@3.18.5        （CLI 树携带的是 3.18.6-alpha.1）
@deepseek-ai/cosmokit@1.8.6            （CLI 树携带的是 1.8.7-alpha.1）
@deepseek-ai/node-addon-system@0.1.2   （与宿主同版本，但仍是第二份）
```

## 根本原因

`v0.1.13` 及更早版本把两个共享上游包写进了 `dependencies`：

- `@deepseek-ai/node-addon-system`（`^0.1.2`，自 v0.1.1 的 Registry Authority lease 起）；
- `@deepseek-ai/schemastery`（`^3.18.2`，自 v0.1.10 的 Skills 起）。

这两个包本来就由宿主树提供——`dsh-sandbox-local` 在每个受支持版本上都直接依赖它们。把它们作为 shipped dep 会让包管理器在 profile 里装出**第二份**副本：

- `^3.18.2` 不匹配 prerelease，宿主自带的 `3.18.6-alpha.1` 满足不了它，pnpm 于是为插件单独装了一份 `3.18.5`（连带它的传递依赖 `cosmokit@1.8.6`）；
- `node-addon-system` 虽然只有 `0.1.2` 一个发布版，但物理上仍是第二份副本。

schemastery 这类单例被复制后，宿主自身依赖它的包（如 `dsh-settings` 的 `~3.18.6-alpha.1` peer）可能被绑定到插件那份不满足范围的副本上——这是启动器告警想拦的失败形态。

## 诊断方法

1. 看插件版本：`dsh plugin --profile <name> list`，`v0.1.13` 及更早存在此问题。
2. 看 profile 的 `node_modules/@deepseek-ai/`：与 CLI 树版本不一致的 `schemastery` / `cosmokit`，或任何多余的 `node-addon-system` 副本即命中。

## 已验证的解决方案

升级到携带修复的插件版本：这两个包已移入 `peerDependencies`，由宿主提供唯一副本；`koffi` 与 `zod` 不是 `@deepseek-ai/*` 上游包，保留在 `dependencies` 不受影响。

对已经装上旧版的 profile：先 `dsh plugin --profile <name> remove` 再 `add` 新版本，让包管理器重建该 profile 的 `node_modules`；残留的孤立副本一并清除即可。

## 防回归

`pnpm compat:check`（`scripts/check-dsh-compat.mjs`）与 `tests/compat.spec.ts` 现在硬性拒绝 `dependencies` / `optionalDependencies` 里的任何 `@deepseek-ai/*` 名字，并钉住两个包的 peer 形态：范围必须覆盖每个受支持版本实际携带的版本，alpha 线逐个具名（裸 `^x.y.z` 不匹配 prerelease）；开发树上它们的解析路径必须与 `dsh-sandbox-local` 自己加载的副本是同一个文件。
