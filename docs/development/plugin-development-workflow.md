# 插件开发工作流：构建、测试与冒烟

> 状态：MVP（M1/M2/M3）与 `v0.1.1` 硬化批次（H1–H4）均已落地；进度、编号与发布状态的唯一真源见[路线图 §进度总账](../plans/active/2026-09-12-multi-root-workspace.md#进度总账)。本文记录本仓库当前**真实存在**的命令、运行时约束与验证机制；未实现的流程不要写在这里。
> 相关：[需求](../requirements/multi-root-workspace.md)、[架构](../architecture/multi-root-workspace.md)、[ADR-0002 上游耦合策略](../decisions/ADR-0002-upstream-coupling-policy.md)、[ADR-0003 方言 grant 拼接](../decisions/ADR-0003-dialect-grant-widening.md)、[ADR-0009 DSH 兼容性代码契约](../decisions/ADR-0009-dsh-compat-contract.md)

## 1. 目标运行时与版本策略

| 项 | 值 | 说明 |
| --- | --- | --- |
| 开发目标版本（基线） | `0.2.1-rc.2` | 精确 pin 在 `devDependencies`；CI 主车道对全部支持版本与启用的 OS 做笛卡尔积验证 |
| 支持矩阵 | [`SUPPORTED_DSH_RELEASES`](../../src/compat/dsh-version.ts) | **精确版本 allowlist**；`peerDependencies` 逐项或，不承诺未来版本 |
| 实测证据 | [路线图兼容提升记录](../plans/active/2026-09-12-multi-root-workspace.md#dsh-021-后续兼容提升2026-10-17)（历次记录同档） | 升级与旧版回归都运行完整矩阵；`upgrade.yml` 只探测候选，不自动扩大 allowlist |
| 运行时门禁 | `multi-root-compat` 行 | 版本不在 allowlist 或核心包混装时，四个安全相关行根本不启动（ADR-0009） |
| cordis | 基线 `4.0.5`；旧版按 `dsh` 声明的范围下限精确 pin | `upgrade-dsh.mjs` 同步重指，并从精确 release-age 条目派生 workspace-only 的 DSH probe overrides，避免预发布范围导致混装、重复副本导致工具调度 Symbol 不一致。已有自定义 overrides 时拒绝覆盖；探测后恢复保存的 workspace |

**必须精确 pin**：`@deepseek-ai/dsh-*` 的 `latest` dist-tag 指向陈旧的 `0.0.1-rc.1`，真正的新版发布在 `next`；范围依赖会解析到错误版本。`pnpm-workspace.yaml` 里的 `minimumReleaseAgeExclude` 对开发版本的直接与传递 DSH 包、宿主 document tooling 都逐项列出精确版本，供 frozen install 与运行脚本前的依赖自检使用；不使用跨版本通配豁免。它是为此配套的（pnpm 的发布年龄门禁会拦下刚发布的预发布版本）。

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
pnpm compat:check       # DSH 兼容性契约：allowlist / peerDependencies / 开发 pin / 已安装树四者一致
pnpm lint               # oxlint（host 与 client 半部都扫）
pnpm typecheck          # tsc -p tsconfig.host.json 与 -p tsconfig.client.json 各一次
pnpm build              # tsc 出两面 lib/types/**/*.d.ts + tsdown 出 lib/*.js（host ESM）与 lib/client.js（浏览器闭包工厂）
pnpm test               # vitest run：单测 + 校验规则 + 注册表（含并发/替换/恢复/跨进程 lease/reclassify/上限）+ 命令/通道 + 空根差分 parity + 方言 grant 矩阵（含 rw/ro）+ per-tool cap（真实 tools/execute waterfall + 方言实跑）+ provider 冲突 + 提示词快照 + client 制品/面板 + 词典 parity + patch 不变量
pnpm bench:roots        # 0–64 根的分类耗时与各方言 argv/profile 字节测量（不进 CI 门禁；输出参考 docs/reference/bench-root-scale-darwin.json）
pnpm kernel:probe       # 本机是否真能受限执行（Windows 上用真实上游 runner 双向验证 windows-acl）；能跑的方言写入 DSH_PROBE_VERIFIED_DIALECTS，使其断言必须真跑
pnpm smoke:compose      # 组合门禁（需要先 build）
pnpm smoke:behavior     # 空根直通 + 多根 battery + 注册表/命令 battery（需要先 build）
pnpm smoke:journey      # 跨两个 git repo 的 web/headless 双 profile 旅程（需要先 build）
pnpm smoke              # compose + behavior + journey
pnpm pack:check         # 打包产物门禁：tarball 成员（含 lib/windows-runner.js）、exports 目标、patch 引用模块与传递 chunk
pnpm smoke:packed       # tarball 经 dsh plugin add 装进隔离 $DSH_HOME，从安装副本跑完整 behavior battery（需要先 build）
pnpm verify:all         # lint → typecheck → build → kernel:probe → test → smoke → pack:check → smoke:packed
pnpm docs:check         # 文档结构检查
```

三个冒烟都要求 `lib/` 已构建（冒烟脚本会检查并提示 `pnpm build`）。

`pnpm verify:all` **故意不含** `compat:check`：升级车道需要在一个还不在 allowlist 上的候选版本上跑完整矩阵，而静态门禁按设计会拒绝那棵树。CI 主车道单独跑 `compat:check`，位置在 lint 之前（见 §9）。

**`pnpm test` 必须在 `pnpm build` 之后**：`tests/client-bundle.spec.ts` 断言的是**构建产物** `lib/client.js`（浏览器闭包工厂形态、模块表依赖清单）；`tests/windows-multi-root.spec.ts` 的原生执行用例加载 `lib/sandbox.js`，以便 provider 的 `import.meta.url` 定位同目录的 `lib/windows-runner.js`。从源码加载 provider 会指向不存在的 `src/windows-runner.js`，不能作为发布制品的执行验证。`/lib/` 被 gitignore，`prepare` 只预构建 JS，完整类型产物仍需 `pnpm build`；CI 与升级工作流都按 `lint → typecheck → build → test` 排序。

## 4. 冒烟机制

两个冒烟脚本都是普通 Node 程序，**不需要模型凭据**，并且一律在隔离环境中运行。

### 4.1 `smoke:compose`

1. 在临时 `$DSH_HOME` 下初始化一个**不含插件**的 profile（`dsh plugin --profile <name> install`）。
2. 用 `dsh plugin --profile <name> add <本仓库>` 把插件真正装进另一个 profile（这一步包含 pnpm 安装与 `dsh.profile.bundles` 回填）。
3. 对两个 profile 各跑一次 `dsh --profile <name> --dump-config`，解析成行集合后逐行比对。
4. 断言：只有 `fs-sandbox` 与 `sandbox` 两行变成 `disabled: true`，只新增插件的 10 行（`multi-root-compat` / `fs` / `sandbox` / `scope` / `registry` / `instructions` / `lsp` / `workspace-files` / `command` / client 载体 `multi-root-client`），其余行逐字段相同、顺序不变；`dsh` stderr 中不出现 patch 未匹配的告警。

这一层专门捕捉"disable 静默失效"：上游 patch 语义在 id 匹配不到时只 warn + skip，只有与基线 dump 对照才能把它变成硬失败。

### 4.2 `smoke:behavior`

1. 同样用真实安装流程准备两个 profile（`mr-plugin` 与 `mr-baseline`）。
2. 在**进程内**用 `@deepseek-ai/dsh-app-boot` 的 `boot()` 挂载整棵配置树（走的是所测运行时自己的 app-boot 副本）。
3. 对 `ctx.fs` / `ctx.shell` 跑同一组操作：主根内写、主根外写、临时区写、根内编辑、根外读、bash `pwd`、bash 根内写、bash 根外写。
4. 在 `workspace-write` 与 `read-only` 两种模式下各跑一轮，并把 `mr-plugin` 的结果与 `mr-baseline` 的结果逐项比较：**空附加根时两者必须完全一致**，而 provider 身份必须不同。
5. 额外断言身份：`ctx.fs` 是本插件的类且与宿主的 `FileSystem` 同一份定义、`ctx.sandbox` 继承上游 `LocalSandboxProvider`、`ctx.shell` 仍是上游 `SandboxBashExecutor`。
6. **多根 battery（M2）**：在同一个插件 profile 上再 boot 一次，用 `ctx.multiRootScope.setAdditionalRoots()` 注册一个附加根，然后断言——
   - fs 写附加根成功；写「第三个目录」（根外）被 `FS_SANDBOX_DENIED` 拒绝，且文案含 `allowed roots:` 并同时列出主根与附加根；根外不留文件；
   - **宿主真实方言**（不注入 `internals`）的 `ctx.sandbox.confine` argv 含该附加根，`read-only` 下不含；
   - 受限 bash：可用时能写附加根、不能写根外；不可用时显式 skip 并打印原因。
   多根 battery 只断言 plugin profile，不与 baseline 比较（baseline 没有多根能力，这正是被测差异）。

夹具目录放在仓库内被忽略的 `.dsh-smoke/` 下，而不是系统临时目录：`writableRoots()` 自动授予 `/tmp` 与 `tmpdir()`，放在那里的工作区永远无法演示"根外被拒"。

### 4.3 `smoke:journey`

1. 隔离的 `$DSH_HOME` 与仓库内被忽略的 `.dsh-smoke/journey-<pid>/` 夹具：两个真实 git 仓库（`repo-a` 为主根、`repo-b` 为附加根）与一个"根外"目录。
2. 在进程内启动一个**脚本化的模型端点**（OpenAI 兼容 SSE，`DEEPSEEK_BASE_URL` 指向它），按顺序回放五个工具调用：读 `repo-b/README.md` → 写它 → `git -C repo-b diff --stat` → 在 `repo-b` 里跑它的检查脚本 → 往根外写一个文件（必须被拒）。
3. 两条腿：
   - **web**：进程内启动 web 组合（`provideCmdline(['--no-open','--port','0'])`），创建带模型选择与 agent preset 的 root agent，用 `/workspace-folders add` 注册附加根，再驱动一轮真实 turn；
   - **headless**：以真实 CLI 子进程 `dsh --profile headless "<task>"` 跑一次性任务，注册通过预写注册表存储完成（那是子进程唯一可用的登记路径）。
4. 断言全部落在**世界**上：`repo-b/README.md` 的字节、`repo-a` 与根外文件的字节不变、根外没有留下文件、`git status/diff` 由冒烟自己重跑、以及模型请求体里出现的拓扑快照（附加根路径 + "additional roots of this session's workspace" + cwd 不变）。工具结果从**模型自己的请求体**里读（工具结果会回传给模型），因此两条腿用同一套判据。
5. 无法嵌套内核沙箱的宿主上，两条腿的受限 shell 断言显式 skip 并打印原因：包括 per-tool cap 的附加根拒写 / 主根可写文件标记、`git diff` 与 `repo-b` 检查。只有 runner 可用时才检查这些产物，避免命令根本没执行却把缺少主根标记误报为失败，或把缺少附加根标记当成 cap 生效。fs 工具、拓扑与指令断言照常执行。

### 4.4 环境变量

| 变量 | 作用 |
| --- | --- |
| `DSH_CLI` | 指定要驱动的 `dsh` 入口；默认用 `devDependencies` 里 pin 的那份。用于支持矩阵回归 |
| `DSH_SMOKE_HOME` | 冒烟临时根目录（默认 `tmpdir()/dsh-multi-root-smoke`） |
| `DSH_SMOKE_KEEP=1` | 保留临时 `$DSH_HOME` 与夹具，便于事后检查；`docs:check` 已忽略 `.dsh-smoke/` |
| `DSH_SMOKE_PLUGIN_SOURCE` | `smoke:behavior` 用 `dsh plugin add` 安装的来源（目录或 tarball）；`smoke:packed` 内部使用它指向打出的 `.tgz` |

冒烟永远不会写操作者真实的 `$DSH_HOME`：脚本在组合 profile 前会把进程内 `DSH_HOME` 指向临时目录，并在启动时断言目标不是真实家目录。

### 4.5 已知环境限制

在被外层内核沙箱约束的进程里（例如 Coding Agent 自己的受控 shell 中）**无法嵌套** macOS Seatbelt：`sandbox-exec` 会以 `sandbox_apply: Operation not permitted` 失败，`SandboxBashExecutor` 随即 fail-closed 抛出 `SANDBOX_UNAVAILABLE`。此时：

- `smoke:behavior` 会把"受限 bash 实际执行"（含多根 battery 的两项）显式标记为 **skipped**（并在输出里说明原因），而不是静默通过或误报失败；
- 两个 profile 面对的失败完全相同，因此"插件与未装插件行为一致"的比对仍然成立；
- 内核方言的 argv 等价性由 `tests/sandbox-passthrough.spec.ts` / `tests/sandbox-multi-root.spec.ts` 在每个环境下覆盖（用 `internals.chain` 强制 seatbelt / bwrap / landlock 三种方言，不执行 runner）；
- `tests/parity-matrix.spec.ts` 的"真实受限执行"用例同样按宿主能力 skip（`unavailable` / `runner-failed` 都算不可用），并且只有在 runner 真的跑起来、却仍然写不进附加根时才判失败。

在没有外层约束的终端（或 CI runner）中，同样的冒烟与用例会真实执行受限 bash。

### 4.5.1 P2（B4–B8）专项测试

- `tests/tool-access.spec.ts`：per-tool cap 经**真实 `tools/execute` waterfall** 驱动（工具名在 dispatch 入口解析）；本机可用方言做真实受限执行（macOS 上是 Seatbelt 的 `bash -c`——封顶工具写附加根被拒、写主根可），嵌套只收窄、并发隔离、dispatch 外 fail closed、非法配置封顶；bwrap/Landlock 行按 runner 可用性 skip。
- `tests/prompt-context.spec.ts`：`renderWorkspaceRootsContext` 的平台 × 模式 × 根组合 × cappedTools 内联快照，以及连续装配稳定性（alias 不改变文案）。
- `tests/provider-conflict.spec.ts`：真实组合 + 冲突 stub 插件（fs-only / sandbox-only × 前后顺序），断言门禁缺席 ⇒ 注册表缺席 ⇒ 空 scope 且无宽化。
- `scripts/smoke-journey.mjs` cap leg：真实组合配置 `toolAccess: { bash: 'read-only' }`，脚本化模型调用**真实 bash 工具** `touch` 附加根（失败 / 文件缺席）与主根（成功）、真实 `write` 工具写附加根（成功），并断言模型请求含封顶文案。
- Windows：`tests/windows-multi-root.spec.ts` 的 SID/argv 结构用例全平台跑；`tests/windows-native.e2e.ts` 的 access 矩阵（Node / PowerShell / ConPTY、`setAccess` 翻转、移除）在 Windows CI 原生执行，POSIX 下按既有 win32-gating skip，不新增跳过条件。
- `pnpm bench:roots` 测量 0/1/4/16/32/64 条存储记录的分类耗时与各内核方言 argv/profile 字节（Windows 上另测 `workspaceScopeSid` 与 runner argv），输出 JSON；它为 `maxAdditionalRoots` 默认值提供证据，不进 CI 门禁。

### 4.6 构建面：两面一体

| 面 | 入口 | 产物 | 关键约定 |
| --- | --- | --- | --- |
| host | `src/{index,fs,sandbox,scope,registry,command}.ts` | `lib/*.js`（ESM）+ `lib/types/**/*.d.ts` | `dependencies` / `peerDependencies` 一律 external（ADR-0002） |
| client | `src/client/index.ts` | `lib/client.js`（CJS 闭包工厂）+ `lib/types/client/**/*.d.ts` | `window.__ModuleLoader__.load({ id, factory })`；只用两个运行时都 seed 的平台词作 external（react / react-dom / cordis / client-store / ui-slots / ui-primitives），其余内联 |

client 面**不能**复用上游的 `clientBundle` preset：它不在任何包的 `exports` 里，且以 monorepo 布局（glob `packages/*/*/package.json`）为前提。本仓库的 `tsdown.config.ts` 自己声明两个配置；client 侧的 TSX 由 `tsconfig.client.json`（`jsx: react-jsx`、DOM lib）负责类型检查，host 侧 tsconfig 用 `exclude` 把 `src/client/**` 排除在外。

`bundle` 在调用 tsdown 之前先跑 `scripts/clean-lib.mjs`，删掉 `lib/` 里上一轮的 **JavaScript** 面。两个原因：两个 tsdown 配置共用 `lib/` 且都设 `clean: false`（整目录清理会让 host / client 两面互相删除，并把 `build:types` 先产出的 `lib/types/` 一起带走），而共享 chunk 的文件名带内容哈希、内容一变旧名字就永久留在原地。`files` 发布的是 `lib/*.js`，所以这一清理是"`pnpm pack` 绝不把历史 chunk 当死代码打进去"的保证——CI 在干净 checkout 上永远碰不到这个问题，**只有本地打包会**。`lib/types/**/*.d.ts` 不匹配该清理的扩展名，保持不动。

client 测试分两层：`tests/client-bundle.spec.ts` 断言**制品字节**（banner、`exports.apply`/`exports.inject`、唯一 external 是 react、manifest 的 `./client` 与 `dsh.client` 声明）；`tests/client-panel.spec.tsx` 在 jsdom 里直接应用真实 client 入口、渲染注册的组件，并断言它对通道发出的 `(channel, endpoint, payload)` 三元组。

### 4.7 打包产物验证（`pack:check` / `smoke:packed`）

- `pnpm pack:check`（`scripts/check-pack.mjs`）：`pnpm pack` 到临时目录后用自带的 tar 解析器（ustar + GNU `L` + pax，不依赖 GNU tar，Windows 可用）列出全部成员，并断言——必备文件（`package.json`、`cordis.patch.yml`、双语 README/CHANGELOG、LICENSE、`lib/index.js` / `client.js` / `windows-runner.js`）、`exports` 声明的每个 `default` / `types` 目标、`cordis.patch.yml` 每行可解析的包内模块、以及 packed `lib/*.js` 相对 `import`/`from`/`import()` 闭包里的每个共享 chunk 都在包内；外加一条 runner 专项——`lib/windows-runner.js` 及其传递 chunk 的每个非相对 specifier 必须是 `node:` 内置（它是独立进程，宿主的插件包解析不适用，见[账本缺陷 #7](../plans/active/2026-09-12-multi-root-workspace.md)）。当前 tarball 为 71 个成员。
- `pnpm smoke:packed`（`scripts/smoke-packed.mjs`）：先 `pack:check` 同款打包，再让 `smoke:behavior` 在仓库**之外**的 scratch `$DSH_HOME` 里以 `DSH_SMOKE_PLUGIN_SOURCE=<tgz>` 经真实 `dsh plugin --profile <p> add <tgz>` 安装，断言被加载的插件解析在 checkout 之外（`lib/windows-runner.js` 在 Windows 上据此做真实受限 pwsh 写）。tarball 的首次 `add` 会停在 `koffi` 构建授权（`ERR_PNPM_IGNORED_BUILDS`），共享 installer 按[故障排查条目](../troubleshooting/install-stops-at-build-approval.md)恢复——待决标记可能不存在、恢复后可能还需 remove+add 才激活，两种情况都会逐字打印输出。

## 5. 安装到真实运行时

```sh
dsh plugin --profile web add <本仓库路径>
dsh --profile web --dump-config     # 应看到两行 disabled + 十行 insert
```

`link:` 来源用的是本仓库已装好的依赖，因此不需要 `allowBuilds` 表态；npm / tarball / git 来源都需要，原因与处置见 [README §安装](../../README.md) 与[故障排查：安装停在构建授权](../troubleshooting/install-stops-at-build-approval.md)。

`dsh plugin` 是 pnpm 的转发器：它在 profile 目录里执行 pnpm，并把解析到 `dsh.bundle` 声明的依赖回填进 `dsh.profile.bundles`。桌面端（Electron）保留自己的 `$DSH_HOME/profiles/desktop`，安装方式同源。

**client 扫描锚点（不变量）**：web 的 client-module 扫描只从挂在**裸包名**上的 loader 行读取 `dsh.client` 声明——子路径行永远不是 client 行（上游 `locatePkgJson` 对子路径 specifier 短路，见 [troubleshooting 记录](../troubleshooting/client-bundle-not-in-boot-graph.md)）。因此 patch 必须始终包含 `id: multi-root-client`、`name: '@dsh-electron/dsh-plugin-multi-root-workspace'` 这一行（载体插件，`apply` 有意为空）；少了它，`lib/client.js` 不会进启动图，`sidebar.footer.action` 的注册静默失效。

发布形态的 `files` 现在包含 `lib/*.js`（含 `lib/client.js`）与两面的 `lib/types/**/*.d.ts`；client 制品必须在 `pnpm pack` 之前构建好（宿主直接读盘，不做编译）。

**`prepare` 脚本（git 安装入口）**：`package.json` 的 `prepare` 只跑 `pnpm run bundle`（tsdown 直接转译 `src/`，无项目引用、不做类型检查，配置自包含，符合上游 [publish 文档](https://github.com/deepseek-ai/deepseek-harness/blob/main/docs/user/develop/basic/publish.zh.md)对 git 安装的要求）。它的三个触发点：git 方式 `dsh plugin add` 后由 pnpm 现场构建（用户需先授权 profile 的 `allowBuilds`）；`pnpm publish` 打包前保证 `lib/*.js` 新鲜；本仓库根目录 `pnpm install` 也会顺带产出 JS 面（`.d.ts` 仍需 `pnpm build` 的 `build:types`）。CI 里 install 阶段的这次预构建是预期行为，显式 `pnpm build` 保持不变。

两种安装形态都已验证（M1）：

| 形态 | 依赖解析 | 验证结果 |
| --- | --- | --- |
| 本地路径（`link:`） | 插件按自身真实路径解析，使用本仓库 pin 的 `@deepseek-ai/*` 副本 | 三行全部挂载，冒烟全绿 |
| 打包安装（`pnpm pack` + `file:`，即发布形态） | 包内不含 `node_modules`，`@deepseek-ai/*` 由宿主运行时/模块回退目录提供 | 三行全部挂载，provider 身份正确 |

发布形态的包内容为：`package.json`、`cordis.patch.yml`、`lib/*.js`（含共享 chunk）、`lib/types/**/*.d.ts`、README、LICENSE —— 因此**不要**假设任何 `src/` 路径在安装后存在（见 §6）。

## 6. 上游耦合与升级流程

- **只允许包入口导入**。发布包里没有 `src/`，`pkg/src/*` 在安装形态下不存在；需要上游内部实现时改为本地实现 + 注明出处 + 差分测试钉住（见 `src/containment.ts`）。
- 子类只使用上游公开方法面（不碰 TS-private、不做原型替换）。`dsh-sandbox-local` 公开面只有 `confine` + `internals`，因此方言适配是**观测克隆 + 结构识别 + 识别失败即抛错**（`src/dialects.ts`，见 [ADR-0003](../decisions/ADR-0003-dialect-grant-widening.md)）；新增或改变方言必须同时更新调研 §10 与本文件的测试清单。
- **支持矩阵是精确版本 allowlist**（`src/compat/dsh-version.ts` 的 `SUPPORTED_DSH_RELEASES`），不是 semver 范围；`peerDependencies` 声明为 allowlist 的逐项或。运行时由 `multi-root-compat` 门禁把判定变成前置条件，四个安全相关的 provider 行全部 inject `multiRootCompat`，判定失败时它们根本不启动。详见 [ADR-0009](../decisions/ADR-0009-dsh-compat-contract.md)。
- **版本差异只允许存在于 `src/compat/`**，且用结构探测而非版本比较（`confine` 的同步/异步、instruction renderer 改名、客户端当前会话、session format 4 的 source kind、工具失败位、面板图标）。业务代码不写版本判断。
- **升级流程**（提升一个候选版本）：

  ```sh
  # 先确认这三个文件没有未提交改动 —— 最后一步会把它们整体退回 HEAD
  git status --porcelain package.json pnpm-workspace.yaml pnpm-lock.yaml

  node scripts/upgrade-dsh.mjs 0.1.7-alpha.1                         # 重指 devDependencies 与 release-age 条目
  pnpm install --no-frozen-lockfile --config.minimumReleaseAge=0     # 候选版本的整棵树都是刚发布的
  DSH_MULTI_ROOT_COMPAT=warn pnpm verify:all                         # 候选按设计还不在 allowlist 上
  git checkout -- package.json pnpm-workspace.yaml pnpm-lock.yaml    # 回退
  pnpm install --frozen-lockfile                                     # 把 node_modules 也退回基线
  ```

  最后两步在 CI 里无所谓（每次都是干净 checkout），在本地则**会连同你对这三个文件的未提交修改一起抹掉**——先提交或 stash。

  全绿之后才人工把版本加入 `SUPPORTED_DSH_RELEASES` 并同步 `peerDependencies`，最后 `pnpm compat:check`。**"CI 通过"不等于"支持该版本"**：绿灯是证据，不是授权。
- `upgrade.yml` 不维护手写包名清单：`scripts/upgrade-dsh.mjs` 从 `package.json` 枚举所有直接 `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` 依赖，统一重指并可输出每个包**实际解析到**的版本（`--print-installed`）。新增直接 DSH 依赖不需要另外修工作流。
- 支持矩阵回归：`DSH_CLI=<另一受支持版本的 dsh 入口> pnpm smoke`（CI 由 `upgrade.yml` 车道按周自动跑）。
- 跨版本编写 smoke/测试时的两处安静坑（`confine` 的 promise、journey 的 agent-step 判据）记在 [Agent Note](../../.agent/note/dsh-compat-contract.md)。

## 7. CI

`.github/workflows/ci.yml` 的 `releases` job 用 `scripts/list-dsh-releases.mjs` 从 `SUPPORTED_DSH_RELEASES` 读取版本轴，`verify` 将该轴与启用的 OS 做笛卡尔积。开发 pin 使用 frozen lockfile，其他版本先用 `upgrade-dsh.mjs` 重指 DSH / cordis 后重新安装；制品名同时含 OS 与 DSH 版本。主车道在 `ubuntu-latest`、`ubuntu-22.04`、`macos-latest` 与 `windows-latest`（变量见下）上执行**同一份全部门禁**：**`compat:check`** → `lint` → `typecheck` → **`build`** → **`kernel:probe`** → `test` → `smoke:compose` → `smoke:behavior` → `smoke:journey` → `pack:check` → `smoke:packed` → `docs:check`。`compat:check` 放在最前，因为后续每一步的结果只有对"契约真正声明的版本"才算证据。探针必须先于单测，否则它导出的方言集无法约束本次单测的 skip。

最后一个 `gate` job（`needs: [releases, verify]`，`if: always()`）只在两个上游 job 都恰好 `success` 时通过：矩阵被跳过、取消或部分失败都不能再显示为绿。release 的 `publish` 依赖的正是这个 gate（见[发版流程](./release-workflow.md)）。

`.github/workflows/upgrade.yml` 是**按周**运行的升级车道（也可手动触发指定版本）：解析 `@deepseek-ai/dsh` 最新 pre-release → 重指 pin → 安装 → 与主车道同样顺序的完整矩阵，全程 `DSH_MULTI_ROOT_COMPAT=warn`。它的权限是 `contents: read`，不提交、不推送、不碰 allowlist；成功时只在 step summary 里写出人工提升的三步。它**不**跑 `compat:check`（候选按设计不在 allowlist 上）。这些性质由 `tests/workflows.spec.ts` 钉住。 手动版本输入及 candidate output 只通过 step `env` 传入 shell，禁止把 GitHub 表达式直接嵌进 `run`；写入 `$GITHUB_OUTPUT` 前校验为单行版本，避免 shell 代码执行与多行输出注入。

Linux 覆盖 bwrap / Landlock 的方言选择与 argv 等价，macOS 覆盖 Seatbelt。**"没跑"不会被记成通过**，机制分两层，而且**按方言**判定：

1. `pnpm kernel:probe`（`scripts/check-kernel-runner.mjs`）用原始机制逐个探测本机能否受限执行（`sandbox-exec` + allow profile / `bwrap` 绑定 flags / Landlock launcher；Windows 上换成 `windows-acl`——直接运行**真实上游 runner**，同时验证一次允许写与一次兄弟目录被拒，只放不放的不算 sandbox），把**确实跑通的那几个方言**写进 `$GITHUB_ENV` 的 `DSH_PROBE_VERIFIED_DIALECTS`；一个都跑不通时打印每条机制的原因。
2. `tests/parity-matrix.spec.ts` 与 `smoke:behavior` 的内核断言：**探针证明本机跑得通的方言必须真跑**（runner 不可用即失败），本机没有的方言永不要求（在 macOS 上要求 bwrap、或在 Linux 上要求 Seatbelt，都只会制造与本插件无关的红灯），未跑探针时一律不要求（开发机照旧打印原因后 skip）。判定集中在 `tests/support/kernel-runner.ts`；`DSH_REQUIRE_KERNEL_RUNNER=1` 可强制要求全部方言，用来检查 skip 本身是否诚实。

### Windows 验证腿

`ci.yml` 在仓库变量 `DSH_WINDOWS_CI=1` 时才把 `windows-latest` 加入动态矩阵。自 B1–B3 加固批起 Windows 与其他两平台跑**同一份门禁**：`kernel:probe`（`windows-acl` 探针，见上）、`smoke:compose` / `smoke:behavior` / `smoke:journey`（以 `SandboxPwshExecutor` 与 pwsh 工具原生执行——**不经 Git Bash**，行为 battery 的多根断言用受限 pwsh 实写）、`pack:check` / `smoke:packed`（安装副本在 Windows 上真的经 `lib/windows-runner.js` 做一次受限多根 pwsh 写），外加 `tests/windows-native.e2e.ts` 的原生组：restricted-token Node、PowerShell 与 ConPTY 覆盖两根可写、第三目录拒绝、read-only、移除根/foreign-owned/junction/8.3 别名、撤销快照、并发 private temp、退出码与流镜像、ConPTY Ctrl+C 与 Git Bash parity；`tests/windows-multi-root.spec.ts` 的结构用例同样实跑。POSIX 方言的真实执行断言在该平台按方言显式 skip。目录 symlink 无权限时，仅省略矩阵中依赖该链接的行（junction 取代），workspace-write 与 read-only 使用同一条件，其余行继续验证。

该变量**当前已置 1**：本仓库是公开仓库，标准 runner 在公开仓库上不计费（计费的 2× 倍率只作用于私有仓库），因此这条腿没有理由停着。清掉变量即回到两 OS 矩阵。

它抓的是"只在某个平台成立"的假设——最典型的一类是**期望值里的路径分隔符**：产品侧一律交回 `canonicalPath()` 的结果（Windows 是 `\`），而测试里用 `` `${base}/third` `` 拼出来的期望只在 POSIX 上等于它。写这类断言时用 `canonicalPath(...)` 或 `join(...)`，不要用字符串拼接。

LSP 源码回传断言应比较读盘得到的完整源码。夹具里的路径经 `JSON.stringify()` 写入源码时，Windows 的反斜杠已转义，不能再用未转义的原始路径作子串断言。B1–B3 各版本和平台的验收证据只记在[路线账本](../plans/active/2026-09-12-multi-root-workspace.md#b1b3第二期-p12026-10-02)。

失败可诊断：`test` 与各冒烟的输出同时写入 `vitest.log` / `smoke-*.log`（`tee` + `set -o pipefail`，红不会被吞成绿），由 `actions/upload-artifact@v4` 以 `if: always()` 上传——成功与失败的日志都能下载，公共仓库无需管理员权限。

`smoke:packed` 的 scratch home 由父进程在行为子进程的 `close` 之后严格删除：父进程显式设置 `DSH_SMOKE_DEFER_HOME_CLEANUP=1`，行为子进程不先尝试删除 home。Windows 会把从安装副本加载的 `koffi.node` 映射到子进程退出为止，进程自身重试删除不能解除映射。仅设置 `DSH_SMOKE_HOME` 不转交清理责任；`DSH_SMOKE_KEEP=1` 仍保留调试现场。`scripts/lib/smoke-cleanup.mjs` 对整棵树最多删除四次、间隔 250 ms，每次递归删除禁用内层重试（`maxRetries: 0`），持久锁或权限错误仍使冒烟失败；不得把失败文件名包含 `.node` 当作清理成功。Node 的递归重试会在锁定文件的每层祖先重复放大等待，曾使 Windows packed battery 已通过后仍等待约 118 分钟。CI 将 Packed smoke 限为 15 分钟、verify job 限为 45 分钟，step 超时后仍执行日志上传和 broker 卸载；这些超时不替代实际清理与行为断言。

Windows 的 foreign-owned ACL 夹具按**先 DACL、后 owner**搭建：用 `whoami /user` 的数字 SID 显式保留读/执行、`WRITE_DAC` 与 `WRITE_OWNER`，移除继承并加 Everyone 的写/删除 deny 后，最后把 owner 转交 SYSTEM 的数字 SID。这样后续 ACL 编辑和清理不依赖 elevated token 的 restore 特权；测试同时读回 SYSTEM owner 与 deny ACE，并执行真实受限写断言。任何搭建失败在 CI 仍是失败，不以整项 retry 或 skip 掩盖。若未来出现新的瞬态故障，应先按日志区分夹具、进程/管道、内核断言与安装网络问题；只有已确定可恢复的夹具或清理操作适合有次数上限的重试。

原生 piped 子进程探针在 `close` 而非 `exit` 事件拼接输出：Node 的 `exit` 不保证 stdout/stderr 已关闭，过早解析会把完整 verdict 截断；`close` 才能证明输出管道已经结束。见 [Node child_process 文档](https://nodejs.org/api/child_process.html#event-close)。

CI 的日志捕获使用 Git Bash，其 PATH 可能让同名 GNU 命令覆盖 Windows 工具。ACL 夹具的 `whoami.exe` / `icacls.exe` / `takeown.exe` 均按 `%SystemRoot%/System32` 绝对路径执行；不要用裸 `whoami /user`，否则命中 GNU whoami 后参数会被拒绝。

## 8. 常见失败与处置

| 症状 | 原因 | 处置 |
| --- | --- | --- |
| `smoke:compose` 报某行差异多于预期 | 上游 base patch 行 id 或名字变了 | 对照 `@deepseek-ai/dsh-base` 的 `cordis.patch.yml` 更新 `cordis.patch.yml`，并同步 `tests/patch.spec.ts` |
| boot 抛出 "service ... has been registered" | disable 行未生效（id 不匹配） | 同上；这是插件刻意的 fail-loud 设计 |
| bash 报 `SANDBOX_UNAVAILABLE` 且文案含 "cannot grant the additional workspace roots" | 上游改了方言 profile 形状，插件拒绝静默降级 | 按调研 §10 核对新形状并更新 `src/dialects.ts` 的识别/克隆逻辑与 `tests/dialects.spec.ts` |
| 多根 session 里 fs 能写附加根、bash 不能 | win32 的 ACL rung 无法表达附加根（第一期限制） | 查看是否已输出一次性告警；这是已知限制，需求文档已明示 |
| `smoke:*` 提示 `lib/ is missing` | 未构建 | 先跑 `pnpm build` |
| 一批测试报 `Cannot read properties of undefined (reading 'confine')` / `ctx.get('fs')` 为 `undefined` | 该 spec mount 了被门禁保护的 provider，但没先 mount `multiRootCompat` | 在 mount provider 之前 `await mountCompat(ctx)`（`tests/support/compat.ts`）；这是门禁在工作，不是 bug |
| 插件装上但行为完全等同未安装，日志里有 `is not a supported release` / `mixes several DSH releases` | 宿主的 DSH 版本不在 allowlist 上，或多个 `@deepseek-ai/dsh-*` 混装 | 见[故障排查：DSH 版本不在支持矩阵上](../troubleshooting/unsupported-dsh-release.md)；`mixed` 永远按宿主问题处理，不要用 `DSH_MULTI_ROOT_COMPAT=warn` 绕过 |
| `pnpm compat:check` 失败 | allowlist / `peerDependencies` / 开发 pin / 已安装树四者不一致 | 按报错逐条对齐；改 allowlist 必须同时改 `peerDependencies`（ADR-0009） |
| 内核方言断言报 `Cannot read properties of undefined (reading 'some')` | 在返回 promise 的上游版本上同步读了 `confine()` 的结果 | 一律 `await ctx.sandbox.confine(...)`；单测走 `tests/support/confine.ts` |
| bash 断言整体 skipped | 当前进程已被内核沙箱约束，无法嵌套 | 在不被约束的终端或 CI 中运行以覆盖该项 |
| `pnpm <script>` 报 `EPERM ... /Library/pnpm/.tools` | 仓库 pin 的 pnpm 版本需要写用户级 pnpm 目录 | 在可写该目录的终端（或提权）执行；仅跑门禁时可用 `sh node_modules/.bin/<tool>` 绕过 pnpm |
| `pnpm <script>` 报 `ERR_PNPM_UNEXPECTED_STORE` 或 `ABORTED_REMOVE_MODULES_DIR_NO_TTY` | checkout 里存在一个陈旧的 `.pnpm-store/`（被 gitignore），而 `node_modules` 是从磁盘级 store（如 `<挂载点>/.pnpm-store/v11`）链接的；pnpm 运行脚本前的依赖自检因此想重装，而在没有 TTY 时无法确认删除 | 最快解除：`CI=true pnpm <script>`（pnpm 只在 CI 下继续而不交互确认）。根治：删掉陈旧的仓库内 `.pnpm-store/`；或 `pnpm config set store-dir <node_modules 实际链接的 store>`；或直接用 `sh node_modules/.bin/<tool>` / `node scripts/<smoke>.mjs` 跑门禁（CI 不受影响，它本来就有 `CI=true`） |
| `ERR_PNPM_IGNORED_BUILDS` | 有构建脚本的依赖未在 `pnpm-workspace.yaml` 声明 | 把该依赖加入 `allowBuilds`（需要构建）或 `allowBuilds: false`（明确不需要）；当前 `esbuild`（经 vite/vitest 引入）声明为 `false` |
| 面板在 Web GUI 里看不到 | 组合里没有声明 `sidebar.footer.action` 的侧栏，或该面没有 host `connection`（headless 组合） | 面板是软注册（`slots.inject` 不触发即不出现）；用 `/workspace-folders list` 确认注册表本身可用 |
| 面板显示「当前没有活动会话」 | 浏览器当前没有被主视图持有的 Session；或客户端仍在读已删除的 `list.current`（0.1.6-alpha.2 起导航在 `retainedBy.mainView` 上） | 确认主界面已打开会话后点重试。host 不会猜测主根（ADR-0008）。若会话明明开着仍出现这条，检查 `src/compat/client-session.ts` 是否同时认 `current` 与 `retainedBy.mainView`，且没有回退 `ids[0]` |
| 面板报 "根目录登记的存储不可用" | `$DSH_HOME/storages/multi_root_workspace.json` 损坏或版本不符 | 按提示修复或删除该文件后重启 dsh；插件不会因此拒绝启动（ADR-0004） |
| 面板报 "无法连接到 dsh 主进程" 且括号里是 **HTTP 405** | 通道前缀路由未注册，请求落到了 SPA 静态回退——典型根因是 `rpc.handle` 的调用形态违反 cordis 属性解析纪律（服务必须从根上下文读取，依赖必须同时声明 `connection` 与 `webServer`） | 用 `curl -X POST http://127.0.0.1:<port>/multi-root-workspace/list` 区分：401 = 路由在（只是 curl 未认证），405 = 路由缺；详见[故障排查：面板 HTTP 405](../troubleshooting/panel-channel-http-405.md) |
| 注册的根标着 `missing` 且写不进去 | 目录当前不存在（或不是目录） | 恢复目录后执行 `/workspace-folders list`（或在面板里刷新/重试）即可重新授予——这正是 `registry.refresh()` 的作用，不需要重启；`missing` 的根在被重新校验前不会被授予 |
| 注册的根标着 `redirected` 且写不进去 | 该路径现在解析到的目录与登记时授予的目录不同（常见原因：登记目录被替换成指向别处的符号链接，或链接链中某一段改了） | 这是刻意行为：重新解析不等于重新授权，授权不会被转移到新目标。把目录恢复成登记时那个（或删掉那层符号链接）后执行 `/workspace-folders list` 即可复原；若确实想改到新目录，先 `remove` 再 `add` 一次，等于重新确认 |
| 列表里有一条 `invalid`，说明写着"重复的 id"或"没有说明授予目录" | 存储被手工改过，或来自缺少 `recordedPath` 字段的旧记录 | 该记录不授予任何权限，可用 `/workspace-folders remove <n>` 或面板里的"移除"逐条删除（删除是按位置/单条进行的，不会一次删掉多条） |
| 内核断言在本地/CI 被 skip | 宿主不能受限执行（外层沙箱禁止嵌套，或缺 bwrap/Landlock launcher） | 本地属正常；CI 里 `pnpm kernel:probe` 会在能执行的宿主上导出 `DSH_REQUIRE_KERNEL_RUNNER=1`，此时 skip 会变成失败。要在本地强制检查，可自行 `DSH_REQUIRE_KERNEL_RUNNER=1 pnpm test`（预期在看到各条原因后失败） |

B9 的 Linux 原生执行证据分两类：latest 保留实际 Landlock 选择与宿主限制，22.04 增加真实 bubblewrap 允许/拒绝证据，全部受支持版本均覆盖两条 Linux 腿。不会关闭 latest 的 AppArmor/user namespace 策略以换取绿灯；不能执行 bubblewrap 的宿主须按安装前置条件或 runnerFailure 如实报告。Windows 腿在原生测试前通过 tarball 同源的管理员脚本安装 token-attribute broker，安装资源的打包完整性由 pack:check 验证。


## 9. 可选 Auto Review 子路径

装配与生命周期见 [ADR-0022](../decisions/ADR-0022-auto-review-loader-entry.md)，使用与旧 companion 迁移见 [Auto Review README](../../src/auto-review/README.md)。原约束、快照与审查语义继续由 [ADR-0021](../decisions/ADR-0021-auto-review-context-companion.md) 说明。

主包 patch 只增加一条默认 disabled 的 `multi-root-auto-review`。它拥有 context 和 reviewer，不需要第二个 context 开关、独立包或 configure。主包 `bundle` 总是生成 `lib/auto-review.js` 及其共享 chunks；`prepare` 的 git 安装路径也包含它。host 类型检查排除 `src/auto-review/**`，`scripts/build-auto-review.mjs` 在精确联合 pin 上单独检查实现类型，并为全部普通车道保留相同的公开 Loader 声明；原始 `upstream.ts` 不参与编译或构建。

原 companion 的开发/测试依赖并入主开发 manifest。`scripts/lib/auto-review-development.mjs` 记录其归属；普通旧版 probe 删除这些仅供 fork 使用的 dev 条目，避免安装尚未发布的旧版本包，恢复精确 fork pin 时重新补齐。它们不是第二个支持版本列表；精确 release 门禁仍在 `src/compat/auto-review-contract.ts`。回退 probe 文件时仍禁止覆盖未提交修改。

`pnpm auto-review:fork` 重放显式差异并钉住 policy、身份、角色、协议和 owner teardown。`pnpm smoke:auto-review` 验证 source/link 与单一 tarball、web/headless × 官方前后顺序、默认零挂载、重复 reload 不写配置、真实请求/围栏、live disable/restore/re-enable 和重启。`tests/auto-review/loader.spec.ts` 额外模拟延迟 import 与异步 drain；普通旧版跳过联合集成测试，继续原有门禁。

不再维护第二个版本、发布清单或 tarball。平台执行证据与发布状态只记[路线账本](../plans/active/2026-09-12-multi-root-workspace.md#auto-review-内置入口迁移2026-10-20)。

## Skills 接缝回归

新增 `tests/skills-*.spec.ts`、`tests/client-skills.spec.tsx` 与 `tests/support/skills-stack.ts` 随既有版本矩阵执行。现代 Loader/Settings 测试从 app-boot 的公开安装锚点解析 ConfigEditor；缺少该能力的旧版改跑真实 legacy SettingsProvider 的 namespace 写回测试，不声明不存在的旧版 ConfigEditor 包。

`tests/skills-windows.e2e.ts` 仅在 Windows 实跑：大小写不同的 effective cwd、Root 被 junction 替换后的旧 ID/预览撤销、junction 改目标的观察失效，以及真实文件句柄读取中替换、删除、撤销和取消后的结果丢弃与句柄关闭。读取竞态只在句柄已读到内容、尚未返回时暂停，不以替换整个 Provider 的 `get()` 模拟文件句柄；它不声称防住任意祖先 rename 的原子竞态。该文件已包含在普通 `pnpm test` 中。

复制源码建立隔离版本安装树时，应放在主工作树及其他带 `node_modules` 的祖先目录之外，防止缺席的可选包从父树回退解析而混装；完整 smoke 的夹具固定在副本内，因此副本本身也须在自动 temp grant 之外。可设置 `DSH_TEST_FIXTURE_PARENT` 指向可写且不在自动 temp grant 内的目录，但它只影响测试夹具；测试仍执行原有 `assertOutsideTempGrants`，不能用此变量绕过权限负对照。主工作树的 manifest、lockfile、安装树和支持列表不随隔离验证修改。安装可使用 `CI=true`，本地测试不能因此假定具备 CI runner 的第二块固定磁盘或修改目录属主的权限；`DSH_PROBE_VERIFIED_DIALECTS` 仍须传入探针实际通过的方言，不放宽内核断言。

`bootProfile` 为 in-process smoke 补齐 CLI 的完整 `profileContext`（home、patchPath、installAnchor、startedBundles 等），优先保留调用者提供的事实，否则现代 ConfigEditor/Settings 会因缺少注入而静默不启动，或在首次写回时报路径缺失。profile 重组使用该次 boot 返回的 appBoot 模块实例，避免安装/解析变化后落入另一个实例的 root Include WeakMap。`smoke:journey` 额外验证真实 web/headless 首步 Skill Catalog、原生按需 get、用户命名空间调用，以及全局关闭/恢复和 native cwd 旁路。

`node --experimental-transform-types scripts/measure-multi-root-skills.mjs` 在可清理的真实 Registry/native Skills 栈上测量 16 根、128 Skills 的首次目录、重复目录及受检预览耗时，同时断言目录不含正文。它输出本机 IO 样本，不作为跨平台性能阈值；结果与执行环境只记路线账本。
