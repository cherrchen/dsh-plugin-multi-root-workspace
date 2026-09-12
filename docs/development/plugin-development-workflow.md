# 插件开发工作流：构建、测试与冒烟

> 状态：M1、M2 与 M3 已落地。本文记录本仓库当前**真实存在**的命令、运行时约束与验证机制；未实现的流程不要写在这里。
> 相关：[需求](../requirements/multi-root-workspace.md)、[架构](../architecture/multi-root-workspace.md)、[ADR-0002 上游耦合策略](../decisions/ADR-0002-upstream-coupling-policy.md)、[ADR-0003 方言 grant 拼接](../decisions/ADR-0003-dialect-grant-widening.md)

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
pnpm lint               # oxlint（host 与 client 半部都扫）
pnpm typecheck          # tsc -p tsconfig.host.json 与 -p tsconfig.client.json 各一次
pnpm test               # vitest run：单测 + 校验规则 + 注册表 + 命令/通道 + 空根差分 parity + 方言 grant 矩阵 + client 制品/面板 + 词典 parity + patch 不变量
pnpm build              # tsc 出两面 lib/types/**/*.d.ts + tsdown 出 lib/*.js（host ESM）与 lib/client.js（浏览器闭包工厂）
pnpm smoke:compose      # 组合门禁（需要先 build）
pnpm smoke:behavior     # 空根直通 + 多根 battery + 注册表/命令 battery（需要先 build）
pnpm smoke:journey      # 跨两个 git repo 的 web/headless 双 profile 旅程（需要先 build）
pnpm smoke              # compose + behavior + journey
pnpm docs:check         # 文档结构检查
```

三个冒烟都要求 `lib/` 已构建（冒烟脚本会检查并提示 `pnpm build`）。

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
5. 无法嵌套内核沙箱的宿主上，受限 bash 的两项显式 skip 并打印原因（`git diff` 与 `repo-b` 检查的断言随之 skip），其余断言照常执行。

### 4.4 环境变量

| 变量 | 作用 |
| --- | --- |
| `DSH_CLI` | 指定要驱动的 `dsh` 入口；默认用 `devDependencies` 里 pin 的那份。用于双运行时矩阵 |
| `DSH_SMOKE_HOME` | 冒烟临时根目录（默认 `tmpdir()/dsh-multi-root-smoke`） |
| `DSH_SMOKE_KEEP=1` | 保留临时 `$DSH_HOME` 与夹具，便于事后检查；`docs:check` 已忽略 `.dsh-smoke/` |

冒烟永远不会写操作者真实的 `$DSH_HOME`：脚本在组合 profile 前会把进程内 `DSH_HOME` 指向临时目录，并在启动时断言目标不是真实家目录。

### 4.5 已知环境限制

在被外层内核沙箱约束的进程里（例如 Coding Agent 自己的受控 shell 中）**无法嵌套** macOS Seatbelt：`sandbox-exec` 会以 `sandbox_apply: Operation not permitted` 失败，`SandboxBashExecutor` 随即 fail-closed 抛出 `SANDBOX_UNAVAILABLE`。此时：

- `smoke:behavior` 会把"受限 bash 实际执行"（含多根 battery 的两项）显式标记为 **skipped**（并在输出里说明原因），而不是静默通过或误报失败；
- 两个 profile 面对的失败完全相同，因此"插件与未装插件行为一致"的比对仍然成立；
- 内核方言的 argv 等价性由 `tests/sandbox-passthrough.spec.ts` / `tests/sandbox-multi-root.spec.ts` 在每个环境下覆盖（用 `internals.chain` 强制 seatbelt / bwrap / landlock 三种方言，不执行 runner）；
- `tests/parity-matrix.spec.ts` 的"真实受限执行"用例同样按宿主能力 skip（`unavailable` / `runner-failed` 都算不可用），并且只有在 runner 真的跑起来、却仍然写不进附加根时才判失败。

在没有外层约束的终端（或 CI runner）中，同样的冒烟与用例会真实执行受限 bash。

### 4.6 构建面：两面一体

| 面 | 入口 | 产物 | 关键约定 |
| --- | --- | --- | --- |
| host | `src/{index,fs,sandbox,scope,registry,command}.ts` | `lib/*.js`（ESM）+ `lib/types/**/*.d.ts` | `dependencies` / `peerDependencies` 一律 external（ADR-0002） |
| client | `src/client/index.ts` | `lib/client.js`（CJS 闭包工厂）+ `lib/types/client/**/*.d.ts` | `window.__ModuleLoader__.load({ id, factory })`；只用两个运行时都 seed 的平台词作 external（react / react-dom / cordis / client-store / ui-slots / ui-primitives），其余内联 |

client 面**不能**复用上游的 `clientBundle` preset：它不在任何包的 `exports` 里，且以 monorepo 布局（glob `packages/*/*/package.json`）为前提。本仓库的 `tsdown.config.ts` 自己声明两个配置；client 侧的 TSX 由 `tsconfig.client.json`（`jsx: react-jsx`、DOM lib）负责类型检查，host 侧 tsconfig 用 `exclude` 把 `src/client/**` 排除在外。

client 测试分两层：`tests/client-bundle.spec.ts` 断言**制品字节**（banner、`exports.apply`/`exports.inject`、唯一 external 是 react、manifest 的 `./client` 与 `dsh.client` 声明）；`tests/client-panel.spec.tsx` 在 jsdom 里直接应用真实 client 入口、渲染注册的组件，并断言它对通道发出的 `(channel, endpoint, payload)` 三元组。

## 5. 安装到真实运行时

```sh
dsh plugin --profile web add <本仓库路径>
dsh --profile web --dump-config     # 应看到两行 disabled + 三行 insert
```

`dsh plugin` 是 pnpm 的转发器：它在 profile 目录里执行 pnpm，并把解析到 `dsh.bundle` 声明的依赖回填进 `dsh.profile.bundles`。桌面端（Electron）保留自己的 `$DSH_HOME/profiles/desktop`，安装方式同源；本插件当前不声明 `dsh.client`（客户端半部属于 M3），因此不会影响 Web client graph。

发布形态的 `files` 现在包含 `lib/*.js`（含 `lib/client.js`）与两面的 `lib/types/**/*.d.ts`；client 制品必须在 `pnpm pack` 之前构建好（宿主直接读盘，不做编译）。

两种安装形态都已验证（M1）：

| 形态 | 依赖解析 | 验证结果 |
| --- | --- | --- |
| 本地路径（`link:`） | 插件按自身真实路径解析，使用本仓库 pin 的 `@deepseek-ai/*` 副本 | 三行全部挂载，冒烟全绿 |
| 打包安装（`pnpm pack` + `file:`，即发布形态） | 包内不含 `node_modules`，`@deepseek-ai/*` 由宿主运行时/模块回退目录提供 | 三行全部挂载，provider 身份正确 |

发布形态的包内容为：`package.json`、`cordis.patch.yml`、`lib/*.js`（含共享 chunk）、`lib/types/**/*.d.ts`、README、LICENSE —— 因此**不要**假设任何 `src/` 路径在安装后存在（见 §6）。

## 6. 上游耦合与升级流程

- **只允许包入口导入**。发布包里没有 `src/`，`pkg/src/*` 在安装形态下不存在；需要上游内部实现时改为本地实现 + 注明出处 + 差分测试钉住（见 `src/containment.ts`）。
- 子类只使用上游公开方法面（不碰 TS-private、不做原型替换）。`dsh-sandbox-local` 公开面只有 `confine` + `internals`，因此方言适配是**观测克隆 + 结构识别 + 识别失败即抛错**（`src/dialects.ts`，见 [ADR-0003](../decisions/ADR-0003-dialect-grant-widening.md)）；新增或改变方言必须同时更新调研 §10 与本文件的测试清单。
- **升级流程**：改 pin → `pnpm install` → `pnpm test`（差分 parity + 方言矩阵 + patch 不变量）→ `pnpm build` → `pnpm smoke:compose` → `pnpm smoke:behavior`。任一差异即视为破坏性变更，先定位再改 pin。
- 双运行时回归：`DSH_CLI=<另一运行时的 dsh 入口> pnpm smoke`。

## 7. CI

`.github/workflows/ci.yml` 在 `ubuntu-latest` 与 `macos-latest` 上执行：`lint` → `typecheck` → `test` → `build` → `smoke:compose` → `smoke:behavior` → `docs:check`。

Linux 覆盖 bwrap / Landlock 的方言选择与 argv 等价，macOS 覆盖 Seatbelt；`tests/parity-matrix.spec.ts` 与 `smoke:behavior` 的真实受限执行用例会在 runner 可用时真实执行（Linux 至少 bwrap 或 Landlock 之一，macOS 为 Seatbelt），不可用时显式 skip 并打印原因——CI 不会把"没跑"记成通过。Windows 内核级多根不在第一期范围（Windows 写路径由 fs fence 覆盖，见需求文档），因此没有 `windows-latest` 腿。

## 8. 常见失败与处置

| 症状 | 原因 | 处置 |
| --- | --- | --- |
| `smoke:compose` 报某行差异多于预期 | 上游 base patch 行 id 或名字变了 | 对照 `@deepseek-ai/dsh-base` 的 `cordis.patch.yml` 更新 `cordis.patch.yml`，并同步 `tests/patch.spec.ts` |
| boot 抛出 "service ... has been registered" | disable 行未生效（id 不匹配） | 同上；这是插件刻意的 fail-loud 设计 |
| bash 报 `SANDBOX_UNAVAILABLE` 且文案含 "cannot grant the additional workspace roots" | 上游改了方言 profile 形状，插件拒绝静默降级 | 按调研 §10 核对新形状并更新 `src/dialects.ts` 的识别/克隆逻辑与 `tests/dialects.spec.ts` |
| 多根 session 里 fs 能写附加根、bash 不能 | win32 的 ACL rung 无法表达附加根（第一期限制） | 查看是否已输出一次性告警；这是已知限制，需求文档已明示 |
| `smoke:*` 提示 `lib/ is missing` | 未构建 | 先跑 `pnpm build` |
| bash 断言整体 skipped | 当前进程已被内核沙箱约束，无法嵌套 | 在不被约束的终端或 CI 中运行以覆盖该项 |
| `pnpm <script>` 报 `EPERM ... /Library/pnpm/.tools` | 仓库 pin 的 pnpm 版本需要写用户级 pnpm 目录 | 在可写该目录的终端（或提权）执行；仅跑门禁时可用 `sh node_modules/.bin/<tool>` 绕过 pnpm |
| `pnpm <script>` 报 `ERR_PNPM_UNEXPECTED_STORE` 或 `ABORTED_REMOVE_MODULES_DIR_NO_TTY` | checkout 里存在一个陈旧的 `.pnpm-store/`（被 gitignore），而 `node_modules` 是从磁盘级 store（如 `<挂载点>/.pnpm-store/v11`）链接的；pnpm 运行脚本前的依赖自检因此想重装 | 三种等价处置：删掉陈旧的仓库内 `.pnpm-store/`；或 `pnpm config set store-dir <node_modules 实际链接的 store>`；或直接用 `sh node_modules/.bin/<tool>` / `node scripts/<smoke>.mjs` 跑门禁（CI 不受影响，它用默认 store 安装） |
| `ERR_PNPM_IGNORED_BUILDS` | 有构建脚本的依赖未在 `pnpm-workspace.yaml` 声明 | 把该依赖加入 `allowBuilds`（需要构建）或 `allowBuilds: false`（明确不需要）；当前 `esbuild`（经 vite/vitest 引入）声明为 `false` |
| 面板在 Web GUI 里看不到 | 组合里没有声明 `sidebar.footer.action` 的侧栏，或该面没有 host `connection`（headless 组合） | 面板是软注册（`slots.inject` 不触发即不出现）；用 `/workspace-folders list` 确认注册表本身可用 |
| 面板报 "根目录登记的存储不可用" | `$DSH_HOME/storages/multi_root_workspace.json` 损坏或版本不符 | 按提示修复或删除该文件后重启 dsh；插件不会因此拒绝启动（ADR-0004） |
| 注册的根标着 `missing` 且写不进去 | 目录当前不存在（或不是目录） | 恢复目录后 `/workspace-folders list` 或面板刷新即可；`missing` 的根不会被授予 |
