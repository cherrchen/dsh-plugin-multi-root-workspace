# 安装停在构建授权（`ERR_PNPM_IGNORED_BUILDS`）

## 症状

`dsh plugin --profile <name> add <来源>` 以非 0 退出，输出里同时有：

```text
[ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: ...

Run "pnpm approve-builds" to pick which dependencies should be allowed to run scripts.
dsh: pnpm failed in profile directory <$DSH_HOME>/profiles/<name>
```

安装**没有完成**：该 profile 的 `dsh.profile.bundles` 里没有本插件，`dsh --profile <name>` 也就完全没有多根能力。再执行一次 `add` 仍然是同样的失败——它不是瞬时错误。

## 根本原因

pnpm ≥10 **默认不运行任何依赖的生命周期脚本**：未在 profile 的 `pnpm-workspace.yaml` 里显式表态的构建脚本会被跳过，pnpm 以非 0 退出，`dsh plugin add` 随即把这次安装判定为失败。

从下一个版本（`0.1.21`）起，插件**不再把 `koffi` 放进生产依赖**：koffi 改为由宿主提供的可选 peer，pnpm 不会安装可选 peer。因此 **npm / tarball / 本地路径安装不再触发这一步**，也不需要 `allowBuilds: koffi`。

仍可能遇到这一步的只有两类：

1. **GitHub 源码安装**：`add` 会运行本包自身的 `prepare`（tsdown 直接转译 `src/`，不做类型检查），npm 要求 profile 先授权这个包；
2. **插件版本 `≤ 0.1.20` 的 npm / tarball 安装**：那时 `koffi` 仍是生产依赖。

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

### GitHub 源码安装

1. 在 profile 的 `pnpm-workspace.yaml` 里授权本包自身的 `prepare`：pnpm 的报错会打印一行 exact key（含来源与 commit，形如 `@dsh-electron/dsh-plugin-multi-root-workspace@github:...#<commit>`），把那一行原样写进 `allowBuilds`。只写包名、不带来源与 commit 的键对 git 来源**不生效**（实测 pnpm `11.28.5`：`ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED` 仍然拒绝）：

   ```yaml
   allowBuilds:
     '@dsh-electron/dsh-plugin-multi-root-workspace@github:cherrchen/dsh-plugin-multi-root-workspace#<commit>': true
   ```

2. 重新执行同一条 `add`。
3. **验证激活**：打开该 profile 的 `package.json`，确认 `dsh.profile.bundles` 里出现 `@dsh-electron/dsh-plugin-multi-root-workspace`（不只是 `dependencies` 里有它）。实测出现过这种情况：被构建授权打断的第一次 `add` 已经把依赖写进 `dependencies`，于是恢复后的 `add` 退出 0 却**不激活**——plugin-manager 的 reconcile 只处理"本次运行新增"的依赖。此时执行一次

   ```sh
   dsh plugin --profile <name> remove @dsh-electron/dsh-plugin-multi-root-workspace
   dsh plugin --profile <name> add <原来源>
   ```

   即可激活，`dsh --profile <name> --dump-config` 应看到两行 disabled 加插件的 insert 行。

### 插件版本 `≤ 0.1.20` 的 npm / tarball 安装

优先升级到 `0.1.21` 或更新版本后重新安装——新版本不再需要这一步。

如果必须留在旧版本：把 `koffi` 置 `true`，重跑 `add`，再做上面的 `remove` + `add` 激活检查。把 `koffi` 置 `true` 意味着**允许该依赖的安装脚本在你的机器上执行**（不在 agent 运行的任何沙箱之内）；它的脚本只做本地预编译。置 `false` 也能让 pnpm 退出 0，但 koffi 的原生二进制就不会被准备，Windows 上的 Registry Authority 会因此在运行时失败——不确定时选 `true`。

## 相关

- [README §安装](../../README.md)（四种安装来源与 `allowBuilds` 说明）
- [故障排查：DSH 版本不在支持矩阵上](./unsupported-dsh-release.md)（装完之后插件仍不生效的另一种原因）
- [故障排查：DSH Desktop 安装后缺少 bundle 登记](./desktop-install-missing-bundle.md)（Desktop 自带 CLI 的 `remove` + `add` 恢复路径）
