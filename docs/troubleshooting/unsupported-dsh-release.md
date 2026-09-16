# DSH 版本不在支持矩阵上（插件的 provider 不启动）

## 症状

出现下列任意一组：

- 插件装上了，但**行为完全等同于未安装**：`/workspace-folders` 存在或不存在都不影响，附加根一个都不授予，沙箱只认主根；
- 日志里有一条来自 `multi-root-compat` 的错误，开头是：

  ```text
  multi-root workspace: DSH <version> is not a supported release.
  ```

- 或者：

  ```text
  multi-root workspace: this installation mixes several DSH releases.
  ```

- 或者：

  ```text
  multi-root workspace: required DSH packages are not installed.
  ```

- 在仓库里跑 `pnpm compat:check` 直接失败，指出 allowlist / `peerDependencies` / 开发 pin / 已安装树之间某两者不一致；
- `pnpm install` 时出现 `@deepseek-ai/dsh-*` 的 unmet peer dependency 警告。

## 根本原因

本插件替换的是工作区围栏本身，并且 `src/dialects.ts` 是**靠观测 `super.confine` 产出的 argv 形状**识别内核 sandbox profile、再克隆它的 grant 拼法的（[ADR-0003](../decisions/ADR-0003-dialect-grant-widening.md)）。上游 `@deepseek-ai/dsh-*` 处于 pre-stable，对这些形状没有 semver 承诺。

因此插件维护一份**精确版本 allowlist**（`src/compat/dsh-version.ts` 的 `SUPPORTED_DSH_RELEASES`），并在启动时判定当前安装。`multi-root-compat` 是 patch 的第一行，四个安全相关的 provider 行都 inject 它：

```text
multi-root-fs
multi-root-sandbox
multi-root-registry
multi-root-instructions
```

cordis 不会启动 injected service 缺失的行。所以判定失败时这四行**根本不启动**，组合退化成“未安装本插件”——这是刻意的 fail-closed：在一个没验证过的上游版本上，宁可不授予附加根，也不要按一个可能语义不同的 profile 去授予。详见 [ADR-0009](../decisions/ADR-0009-dsh-compat-contract.md)。

四种判定：

| verdict | 含义 | 典型原因 |
| --- | --- | --- |
| `incomplete` | 必需包解析不到 | 宿主组合缺包，或 peer 未被安装 |
| `mixed` | 核心包对不上同一个版本 | 局部升级过某几个 `@deepseek-ai/dsh-*` |
| `unsupported` | 版本统一但不在 allowlist 上 | 宿主比插件新（或旧） |
| `supported` | 正常 | —— |

## 诊断方法

1. 读那条错误信息本身：`unsupported` / `mixed` / `incomplete` 三种都会把**每一个被检查包的实际版本**逐行列出，以及 allowlist 的内容。这通常已经足够定位。
2. 在插件仓库里跑：

   ```bash
   pnpm compat:check
   ```

   它复现同样的判定，并且额外检查 allowlist、`peerDependencies`、开发 pin、已安装树四者是否一致。

3. 想知道宿主侧每个包实际解析到什么版本：

   ```bash
   node scripts/upgrade-dsh.mjs --print-installed
   ```

## 已验证的解决方案

按判定分三种处理。

### `mixed`：把所有 `@deepseek-ai/dsh*` 对齐到同一个版本

这一种**永远是宿主侧的问题**，不要用下面的放宽开关绕过：混装意味着文件围栏和内核方言这两半分别对着不同的上游语义工作。把宿主 profile 里所有 `@deepseek-ai/dsh-*` 重新安装到同一个发布版本。

### `unsupported`：把宿主换到 allowlist 上的版本，或走提升流程

- 短期：把宿主降/升到 `SUPPORTED_DSH_RELEASES` 里的某个版本。
- 长期（想让插件支持这个新版本）：这是一次人工提升，不能靠 CI 自动完成。
  1. 在插件仓库里把 pin 指向候选版本并安装：

     ```bash
     node scripts/upgrade-dsh.mjs 0.1.7-alpha.1
     pnpm install --no-frozen-lockfile --config.minimumReleaseAge=0
     ```

  2. 用放宽开关跑完整矩阵（见下）：

     ```bash
     DSH_MULTI_ROOT_COMPAT=warn pnpm verify:all
     ```

  3. **全绿之后**才把该版本加入 `SUPPORTED_DSH_RELEASES`，并把每个 `@deepseek-ai/dsh*` 的 `peerDependencies` 改成新的 allowlist 逐项或（例如 `"0.1.5-rc.2 || 0.1.7-alpha.1"`）。
  4. `pnpm compat:check` 通过后，恢复开发 pin 到基线版本并作为一次受评审的改动提交。

  失败项落在哪里决定要不要写适配器：如果是上游 API 改了形状，改 `src/compat/`（[ADR-0009](../decisions/ADR-0009-dsh-compat-contract.md) 第 4 条），不要在业务代码里加版本判断。

### `incomplete`：补齐必需包

`REQUIRED_CORE_PACKAGES` 里的包是插件的硬依赖（被继承、被取值、或持有被 inject 的 service key）。在宿主 profile 里安装缺失的那些。可选包缺失是合法的，不会导致 `incomplete`。

## 关于 `DSH_MULTI_ROOT_COMPAT=warn`

它**只为升级车道存在**：让完整矩阵能在一个还不在 allowlist 上的版本上跑起来，而那次运行正是该版本获得资格的方式。`upgrade.yml` 设置它；CI 主车道不设置（`tests/workflows.spec.ts` 钉住了这一点）。

不要在生产部署里设置它。设置之后插件会在一个未验证的 sandbox profile 形状上授予附加根——警告文本本身就是这么写的。
