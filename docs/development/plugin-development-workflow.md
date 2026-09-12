# 插件开发工作流：构建、测试与冒烟

> 状态：M1 已落地。本文记录本仓库当前**真实存在**的命令、运行时约束与验证机制；未实现的流程不要写在这里。
> 相关：[需求](../requirements/multi-root-workspace.md)、[架构](../architecture/multi-root-workspace.md)、[ADR-0002 上游耦合策略](../decisions/ADR-0002-upstream-coupling-policy.md)

## 1. 目标运行时与版本策略

| 项 | 值 | 说明 |
| --- | --- | --- |
| 开发/CI 目标版本 | `0.1.5-rc.2` | 精确 pin 在 `devDependencies`；与上游 checkout master `c291e7961a` 的包版本一致 |
| 兼容下限 | `>=0.1.2-alpha.4 <0.2.0` | `peerDependencies` 范围，使插件能装进已发布的其他运行时 |
| 已实测的第二个运行时 | `0.1.2-rc.1` | 桌面端安装的运行时；`smoke:compose` 与 `smoke:behavior` 均已在其上通过 |
| cordis | `4.0.2` | 与服务定义包一样必须单副本，由宿主提供 |

**必须精确 pin**：`@deepseek-ai/dsh-*` 的 `latest` dist-tag 指向陈旧的 `0.0.1-rc.1`，真正的新版发布在 `next`；范围依赖会解析到错误版本。`pnpm-workspace.yaml` 里的 `minimumReleaseAgeExclude` 是为此配套的（pnpm 的发布年龄门禁会拦下刚发布的预发布版本）。

## 2. 工具链

| 用途 | 工具 | 配置 |
| --- | --- | --- |
| 包管理 | pnpm `11.25.0` | `package.json#packageManager` |
| 类型检查与声明产出 | TypeScript `6.x` | `tsconfig.host.json`（strict、`exactOptionalPropertyTypes`、`noUncheckedIndexedAccess`、`verbatimModuleSyntax`、`rewriteRelativeImportExtensions`） |
| 打包 | tsdown（rolldown） | `tsdown.config.ts`：逐入口 ESM bundle 到 `lib/`，`@deepseek-ai/*` 与 cordis 保持 external |
| Lint | oxlint | `.oxlintrc.json`（与上游仓库同一选择） |
| 测试 | vitest | `vitest.config.ts`（`tests/**/*.spec.ts`，`pool: forks`） |

源码里的相对导入写 `.ts` 后缀（`./containment.ts`）：tsc 以 `rewriteRelativeImportExtensions` 重写为 `.js`，tsdown 在打包时直接解析。

## 3. 命令

```sh
pnpm install            # 安装（首次或改依赖后）
pnpm lint               # oxlint
pnpm typecheck          # tsc --noEmit
pnpm test               # vitest run：单测 + 差分 parity + patch 不变量
pnpm build              # tsc 出 lib/types/*.d.ts + tsdown 出 lib/*.js
pnpm smoke:compose      # 组合门禁（需要先 build）
pnpm smoke:behavior     # 空根直通行为门禁（需要先 build）
pnpm smoke              # compose + behavior
pnpm docs:check         # 文档结构检查
```

两个冒烟都要求 `lib/` 已构建（冒烟脚本会检查并提示 `pnpm build`）。

## 4. 冒烟机制

两个冒烟脚本都是普通 Node 程序，**不需要模型凭据**，并且一律在隔离环境中运行。

### 4.1 `smoke:compose`

1. 在临时 `$DSH_HOME` 下初始化一个**不含插件**的 profile（`dsh plugin --profile <name> install`）。
2. 用 `dsh plugin --profile <name> add <本仓库>` 把插件真正装进另一个 profile（这一步包含 pnpm 安装与 `dsh.profile.bundles` 回填）。
3. 对两个 profile 各跑一次 `dsh --profile <name> --dump-config`，解析成行集合后逐行比对。
4. 断言：只有 `fs-sandbox` 与 `sandbox` 两行变成 `disabled: true`，只新增三个插件行，其余行逐字段相同、顺序不变；`dsh` stderr 中不出现 patch 未匹配的告警。

这一层专门捕捉"disable 静默失效"：上游 patch 语义在 id 匹配不到时只 warn + skip，只有与基线 dump 对照才能把它变成硬失败。

### 4.2 `smoke:behavior`

1. 同样用真实安装流程准备两个 profile（`mr-plugin` 与 `mr-baseline`）。
2. 在**进程内**用 `@deepseek-ai/dsh-app-boot` 的 `boot()` 挂载整棵配置树（走的是所测运行时自己的 app-boot 副本）。
3. 对 `ctx.fs` / `ctx.shell` 跑同一组操作：主根内写、主根外写、临时区写、根内编辑、根外读、bash `pwd`、bash 根内写、bash 根外写。
4. 在 `workspace-write` 与 `read-only` 两种模式下各跑一轮，并把 `mr-plugin` 的结果与 `mr-baseline` 的结果逐项比较：**空附加根时两者必须完全一致**，而 provider 身份必须不同。
5. 额外断言身份：`ctx.fs` 是本插件的类且与宿主的 `FileSystem` 同一份定义、`ctx.sandbox` 继承上游 `LocalSandboxProvider`、`ctx.shell` 仍是上游 `SandboxBashExecutor`。

夹具目录放在仓库内被忽略的 `.dsh-smoke/` 下，而不是系统临时目录：`writableRoots()` 自动授予 `/tmp` 与 `tmpdir()`，放在那里的工作区永远无法演示"根外被拒"。

### 4.3 环境变量

| 变量 | 作用 |
| --- | --- |
| `DSH_CLI` | 指定要驱动的 `dsh` 入口；默认用 `devDependencies` 里 pin 的那份。用于双运行时矩阵 |
| `DSH_SMOKE_HOME` | 冒烟临时根目录（默认 `tmpdir()/dsh-multi-root-smoke`） |
| `DSH_SMOKE_KEEP=1` | 保留临时 `$DSH_HOME` 与夹具，便于事后检查 |

冒烟永远不会写操作者真实的 `$DSH_HOME`：脚本在组合 profile 前会把进程内 `DSH_HOME` 指向临时目录，并在启动时断言目标不是真实家目录。

### 4.4 已知环境限制

在被外层内核沙箱约束的进程里（例如 Coding Agent 自己的受控 shell 中）**无法嵌套** macOS Seatbelt：`sandbox-exec` 会以 `sandbox_apply: Operation not permitted` 失败，`SandboxBashExecutor` 随即 fail-closed 抛出 `SANDBOX_UNAVAILABLE`。此时：

- `smoke:behavior` 会把"受限 bash 实际执行"的断言显式标记为 **skipped**（并在输出里说明原因），而不是静默通过或误报失败；
- 两个 profile 面对的失败完全相同，因此"插件与未装插件行为一致"的比对仍然成立；
- 内核方言的 argv 等价性由 `tests/sandbox-passthrough.spec.ts` 在每个环境下覆盖（用 `internals.chain` 强制 seatbelt / bwrap / landlock 三种方言，不执行 runner）。

在没有外层约束的终端（或 CI runner）中，同样的冒烟会真实执行受限 bash。

## 5. 安装到真实运行时

```sh
dsh plugin --profile web add <本仓库路径>
dsh --profile web --dump-config     # 应看到两行 disabled + 三行 insert
```

`dsh plugin` 是 pnpm 的转发器：它在 profile 目录里执行 pnpm，并把解析到 `dsh.bundle` 声明的依赖回填进 `dsh.profile.bundles`。桌面端（Electron）保留自己的 `$DSH_HOME/profiles/desktop`，安装方式同源；本插件当前不声明 `dsh.client`（客户端半部属于 M3），因此不会影响 Web client graph。

两种安装形态都已验证（M1）：

| 形态 | 依赖解析 | 验证结果 |
| --- | --- | --- |
| 本地路径（`link:`） | 插件按自身真实路径解析，使用本仓库 pin 的 `@deepseek-ai/*` 副本 | 三行全部挂载，冒烟全绿 |
| 打包安装（`pnpm pack` + `file:`，即发布形态） | 包内不含 `node_modules`，`@deepseek-ai/*` 由宿主运行时/模块回退目录提供 | 三行全部挂载，provider 身份正确 |

发布形态的包内容为：`package.json`、`cordis.patch.yml`、`lib/*.js`（含共享 chunk）、`lib/types/**/*.d.ts`、README、LICENSE —— 因此**不要**假设任何 `src/` 路径在安装后存在（见 §6）。

## 6. 上游耦合与升级流程

- **只允许包入口导入**。发布包里没有 `src/`，`pkg/src/*` 在安装形态下不存在；需要上游内部实现时改为本地实现 + 注明出处 + 差分测试钉住（见 `src/containment.ts`）。
- 子类只使用上游公开方法面（不碰 TS-private、不做原型替换）。
- **升级流程**：改 pin → `pnpm install` → `pnpm test`（差分 parity + patch 不变量）→ `pnpm build` → `pnpm smoke:compose` → `pnpm smoke:behavior`。任一差异即视为破坏性变更，先定位再改 pin。
- 双运行时回归：`DSH_CLI=<另一运行时的 dsh 入口> pnpm smoke`。

## 7. CI

`.github/workflows/ci.yml` 在 `ubuntu-latest` 与 `macos-latest` 上执行：`lint` → `typecheck` → `test` → `build` → `smoke:compose` → `smoke:behavior` → `docs:check`。

Linux 覆盖 bwrap / Landlock 的方言选择与 argv 等价，macOS 覆盖 Seatbelt；Windows 内核级多根不在第一期范围（Windows 写路径由 fs fence 覆盖，见需求文档）。

## 8. 常见失败与处置

| 症状 | 原因 | 处置 |
| --- | --- | --- |
| `smoke:compose` 报某行差异多于预期 | 上游 base patch 行 id 或名字变了 | 对照 `@deepseek-ai/dsh-base` 的 `cordis.patch.yml` 更新 `cordis.patch.yml`，并同步 `tests/patch.spec.ts` |
| boot 抛出 "service ... has been registered" | disable 行未生效（id 不匹配） | 同上；这是插件刻意的 fail-loud 设计 |
| `smoke:*` 提示 `lib/ is missing` | 未构建 | 先跑 `pnpm build` |
| bash 断言整体 skipped | 当前进程已被内核沙箱约束，无法嵌套 | 在不被约束的终端或 CI 中运行以覆盖该项 |
| `ERR_PNPM_IGNORED_BUILDS` | 有构建脚本的依赖未在 `pnpm-workspace.yaml` 声明 | 把该依赖加入 `allowBuilds`（需要构建）或 `allowBuilds: false`（明确不需要） |
