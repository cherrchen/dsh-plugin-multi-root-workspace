# 安装停在构建授权（`ERR_PNPM_IGNORED_BUILDS`）

## 症状

`dsh plugin --profile <name> add @dsh-electron/dsh-plugin-multi-root-workspace`（或 tarball / git 来源）以非 0 退出，输出里同时有：

```text
[ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: koffi@3.3.0

Run "pnpm approve-builds" to pick which dependencies should be allowed to run scripts.
dsh: pnpm failed in profile directory <$DSH_HOME>/profiles/<name>
```

安装**没有完成**：该 profile 的 `dsh.profile.bundles` 里没有本插件，`dsh --profile <name>` 也就完全没有多根能力。再执行一次 `add` 仍然是同样的失败——它不是瞬时错误。

## 根本原因

本插件带一个需要构建的原生依赖 `koffi`（Windows 上 Registry Authority 的 FFI 封装，见 [ADR-0007](../decisions/ADR-0007-registry-authority-lease.md)），而 pnpm ≥10 **默认不运行任何依赖的生命周期脚本**：未在 profile 的 `pnpm-workspace.yaml` 里显式表态的构建脚本会被跳过，pnpm 以非 0 退出，`dsh plugin add` 随即把这次安装判定为失败。

这是 pnpm 的供应链纪律，不是本插件的 bug——但 v0.1.1 之前本插件没有原生依赖，所以**四种安装来源现在都多出这一次表态**（`v0.1.0` 及更早版本的 npm / tarball 来源没有这一步）。

## 诊断方法

1. 看该 profile 的 `pnpm-workspace.yaml`：`dsh` **可能**把待决项留在文件里，形如

   ```yaml
   allowBuilds:
     koffi: set this to true or false
   ```

   出现 `set this to true or false` 就说明卡在构建授权。**但它也可能不出现**：实测（DSH `0.2.1-alpha.2`，tarball 来源，全新 profile）文件里只有 `packages:` 而没有待决标记——此时以 `[ERR_PNPM_IGNORED_BUILDS]` 输出为准，不要因为没有标记就排除本条目。
2. 确认 profile 目录：`<$DSH_HOME>/profiles/<name>`（桌面端是 `desktop`，CLI 常用 `web` / `headless`）。
3. 想要更完整的 pnpm 输出，可以直接在 profile 目录里跑 `pnpm install`——`dsh plugin add` 只转述了最后一行。

## 已验证的解决方案

1. 把待决行改成 `true`；如果文件里**没有**待决标记（上面的第二种情况），直接追加：

   ```yaml
   allowBuilds:
     koffi: true
   ```

2. 重新执行同一条 `add`。这一次会看到 `node_modules/koffi install: Done`。
3. **验证激活**：打开该 profile 的 `package.json`，确认 `dsh.profile.bundles` 里出现 `@dsh-electron/dsh-plugin-multi-root-workspace`（不只是 `dependencies` 里有它）。实测（DSH `0.2.1-alpha.2`，tarball 来源）出现过这种情况：被构建授权打断的第一次 `add` 已经把依赖写进 `dependencies`，于是恢复后的 `add` 退出 0 却**不激活**——plugin-manager 的 reconcile 只处理"本次运行新增"的依赖。此时执行一次

   ```sh
   dsh plugin --profile <name> remove @dsh-electron/dsh-plugin-multi-root-workspace
   dsh plugin --profile <name> add <原来源>
   ```

   即可激活，`dsh --profile <name> --dump-config` 应看到两行 disabled 加插件的 insert 行。
4. git 来源还要多回一个待决项：本包自己的 `prepare`（现场构建 `lib/`），即

   ```yaml
   allowBuilds:
     '@dsh-electron/dsh-plugin-multi-root-workspace': true
     koffi: true
   ```

把 `koffi` 置 `true` 意味着**允许该依赖的安装脚本在你的机器上执行**（不在 agent 运行的任何沙箱之内）；它的脚本只做本地预编译。置 `false` 也能让 pnpm 退出 0，但 koffi 的原生二进制就不会被准备，Windows 上的 Registry Authority 会因此在运行时失败——不确定时选 `true`。

## 相关

- [README §安装](../../README.md)（四种安装来源与 `allowBuilds` 说明）
- [故障排查：DSH 版本不在支持矩阵上](./unsupported-dsh-release.md)（装完之后插件仍不生效的另一种原因）
