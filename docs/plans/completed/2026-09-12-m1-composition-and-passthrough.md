# M1 开发计划：Bundle 组合与空根直通

> 状态：completed（2026-09-12 实施完成并验证）| 日期：2026-09-12 | 里程碑：M1（共 M1/M2/M3）
> 目标运行时：dsh `0.1.5-rc.2`（同时兼容已安装桌面运行时 `0.1.2-rc.1`）
> 里程碑划分：[2026-09-12-multi-root-workspace.md](../active/2026-09-12-multi-root-workspace.md)；设计：[multi-root-workspace.md](../../architecture/multi-root-workspace.md)；需求与验收：[multi-root-workspace.md](../../requirements/multi-root-workspace.md)；上游事实：[multi-root-workspace-research.md](../../reference/multi-root-workspace-research.md)
> 决策依据：[ADR-0001](../../decisions/ADR-0001-provider-replacement-scope.md)、[ADR-0002](../../decisions/ADR-0002-upstream-coupling-policy.md)

## 目标

让插件能被 `dsh plugin` 装入，并在**零附加根**下与未装插件的运行行为等价；同时把 M2 之后不会再变的骨架（替换行集合、scope 单源、门禁与冒烟）一次性固化。

M1 追求的是**结构性风险清零**，不是功能：附加根的解析、存储、命令与 UI 全部属于 M2/M3。

成功标准（可判定）：

1. `pnpm lint && pnpm typecheck && pnpm test` 全绿，`pnpm docs:check` 全绿。
2. **组合无副作用**：`pnpm smoke:compose` 断言装入插件后的 `dsh --dump-config` 与基线 dump 的差异只有“两行 `disabled: true` + 三行 insert”，其余行逐字节相同。
3. **空根直通**：`pnpm smoke:behavior` 在 dsh `0.1.5-rc.2` 与已安装桌面运行时 `0.1.2-rc.1` 上均通过——provider 身份为本插件类、主根内写入成功、根外写入被 `FS_SANDBOX_DENIED` 拒绝、临时区可写、`read-only` 全拒、bash 与 PTY 走同一份 scope。
4. **差分 parity**：本插件 fs fence 与上游 `SandboxedFileSystem` 在“模式 × 路径类别”矩阵上结论逐一相同；`confine` 在空根时与上游 `LocalSandboxProvider` 输出逐元素相同。
5. **失败要响亮**：故意去掉 disable 行的 patch 会让 boot 直接抛错；冒烟中的身份断言会让“静默未生效”失败。

## 背景

需求、目标架构、开发路径与上游调研已定稿（见文首链接）。当前仓库只有文档系统与文档检查脚本，尚无任何代码、依赖与构建。

本计划修正了路线图 M1 段落中的四处描述，修正理由见下文“对既有路线图的修正”。

## 当前状态（本轮实测事实）

### 上游与运行时

- 上游 checkout 位于本机，HEAD 为 master `c291e7961a`（2026-09-12），其中各包版本 `0.1.5-rc.2`；已安装桌面运行时的包版本为 `0.1.2-rc.1`。
- 上游 checkout 的 CLI 已构建：`node <checkout>/apps/cli/lib/bin.js --version` 输出 `0.1.5-rc.2`，并支持 `--profile` / `--patch` / `--dump-config` / `--dump-default-config`。
- registry 的 dist-tag 陷阱：`@deepseek-ai/dsh-*` 的 `latest` 指向陈旧的 `0.0.1-rc.1`，真正的新版在 `next`（`0.1.5-rc.2`）；`0.1.2-rc.1` 亦已发布。**精确 pin 是必需项，不是运维偏好。**
- `$DSH_HOME` 默认指向用户家目录下的 `.dsh`，profile 目录为 `$DSH_HOME/profiles/<name>`；`dsh plugin --profile <name> add <spec>` 只是“在 profile 目录里跑 pnpm + 回填 `dsh.profile.bundles`”的转发器。

### patch 与组合语义

- `vendor/include` 的 `applyEntryPatches`：非 insert patch 的**任意键**（含 `inject`）覆盖目标行同名键；`{ insert: [...] }` 不带 `id` 时追加到该层列表末尾；`id` 匹配不到只 `warn + skip`。因此“替换是否生效”必须自证，不能依赖它报错。
- 两个运行时中相关行 id 与 provider 名一致：`sandbox`→`@deepseek-ai/dsh-sandbox-local`、`sandbox-policy`→`@deepseek-ai/dsh-sandbox-policy`、`bash-sandbox`→`@deepseek-ai/dsh-bash-sandbox`、`fs-sandbox`→`@deepseek-ai/dsh-fs-sandbox`。
- 子路径行名（形如 `<pkg>/fs`）在代码层受支持（`packageEntryFromPackage` 会为非通配子路径建立解析入口），但上游 patch 中无先例，列为 T0 必测项。
- 同一作用域重复 provide 同一 service key 会直接抛错（cordis `reflect.provide`）：这既是“disable 必须先于 insert”的原因，也是 patch 未生效时的天然 fail-loud。

### bash / PTY 不需要插件自行实现多根

- `SandboxBashExecutor.confine` 只做一件事：`this.ctx.sandbox.confine(['bash','-c',command], policy)`（`packages/shell/bash-sandbox/src/index.ts` 约 177-179 行）。
- PTY 同理：`dsh-terminal-bash` 取 `ctx.get('sandbox').confine(argv, policy)`（`packages/terminal/terminal-bash/src/index.ts` 约 105-108 行），cwd 用 `policy.workspaceRoot`。
- `policy` 只有单值 `workspaceRoot`；`SandboxBashExecutor.resolve` 只补 `sandboxPolicy: request.sandboxPolicy ?? ctx.sandboxPolicy.resolve()`。
- 结论：**多根 grant 只需在 `ctx.sandbox` 一处表达**，替换 `bash-sandbox` 是多余的（见 [ADR-0001](../../decisions/ADR-0001-provider-replacement-scope.md)）。

### 禁止深导入

- 发布 tarball 实测：`@deepseek-ai/dsh-fs-sandbox@0.1.5-rc.2` 只含 8 个文件（`lib/index.js`、`lib/types/*.d.ts`、README、LICENSE、`package.json`），**没有 `src/`**；`exports["./src/*"]` 在安装形态下是死路径。
- 因此 `fs-sandbox/src/containment.ts` 的 `isPathUnder`、`sandbox-local/src/profiles.ts` 的方言 builder 都不可引用。本机 profile `node_modules` 中带 `src/` 的副本是指向应用内副本的符号链接，不能当作可用事实。
- `lib/index.js` 是自包含打包产物，因此从**包入口**导入 `LocalFileSystem` / `SandboxedFileSystem` / `LocalBashExecutor` / `SandboxBashExecutor` / `LocalSandboxProvider` 完全可用。

### 可复用的上游公开面

- `LocalSandboxProvider.confine(argv, policy)` 是 public，`internals` 是公开测试钩子（可强制平台与探针），因此空根的“逐元素等价”可断言。
- `LocalFileSystem`：`static Config`（`cwd`、`diffBasisMaxBytes`）、`writeText` / `editText` 的五参签名、`sandboxMode` getter 语义。
- `@deepseek-ai/dsh-sandbox` 导出 `writableRoots(policy)`、`canonicalPath()`、`SandboxProvider` 与类型；`FsError` / `FS_SANDBOX_DENIED` 来自 `@deepseek-ai/dsh-fs`。
- 消费者只用结构化事实：`tool-fs` 的 `FsSandboxController` 读 `ctx.fs.sandboxMode`；全仓没有 `instanceof SandboxedFileSystem`，因此同 key 替换 provider 安全。
- `boot(binName, absoluteConfigPath, patches, prepare?)` 是 `@deepseek-ai/dsh-app-boot` 的导出，上游自身测试即用 `await boot(NAME, join(dir, 'cordis.yml'))` 在进程内挂载整棵配置树——这使**不依赖 LLM 凭据**的端到端行为冒烟成为可能。

### 两版本差异清单（双运行时矩阵的核对依据）

- 逐字节相同：`fs-sandbox/src/index.ts`、`fs-sandbox/src/containment.ts`、`sandbox/src/roots.ts`、`sandbox-policy/src/index.ts`、`terminal-bash/src/index.ts`。
- 有差异：`sandbox-local` 的 landlock 导入路径（`@deepseek-ai/node-addon-landlock-run` → `@deepseek-ai/node-addon-system/landlock-run`）；`bash-local` / `bash-sandbox` 内部把 provider rejection 表述与参数名改为 spawn failure（公开签名兼容）；`fs-local` 新增 `readByteRange`。

## 对既有路线图的修正

| 路线图/架构原文 | 本计划 | 依据 |
| --- | --- | --- |
| disable 三行（`fs-sandbox` / `bash-sandbox` / `sandbox`），M2 做 `MultiRootBashExecutor` | 只替换两行，`bash-sandbox` 保持上游 | bash 与 PTY 的 confinement 全部经 `ctx.sandbox`；替换面越小，pre-stable 升级风险越低，“单一权限世界”由构造保证 |
| M1 三个 provider “零改动直通 super” | fs provider 在 M1 即实现 fence（根列表来自 scope，M1 恒为 1 根），用差分测试钉住与上游等价 | `LocalFileSystem` 本身没有 fence，“直通 super”会丢掉 fence，不是“与上游一致”；上游 `checkedTarget` 是 TS-private，无法复用 |
| scope 服务放 M2 | scope 服务在 M1 落地（空表） | M1 的“直通”必须走 M2 将要复用的同一条代码路径，安全网才成立 |
| 方言 grant 优先调用上游 builder | 上游 builder 不可引用（发布包无 `src/`），M2 改为“从 `super.confine` 输出克隆 grant 模板”，识别失败时 fail loud | 深导入事实 + landlock 导入路径已在版本间变化 |

上述修正已同步到 [架构文档](../../architecture/multi-root-workspace.md) 与 [需求文档](../../requirements/multi-root-workspace.md)。

## 范围

- bundle 骨架与两行替换（`fs-sandbox`、`sandbox`）。
- scope 服务（空表 + 测试注入接口）。
- 多根就绪的 fs fence（根列表长度恒为 1）。
- sandbox provider：空根直通 + 非空根 fail loud。
- 单测 / 差分 / 组合 / 行为四类门禁与脚本；工具链与 CI。
- 文档同步。

## 非目标

- 附加根的解析、校验、持久化、`/workspace-folders` 命令、`workspace_roots` 工具、`systemPrompt.context` 拓扑（M2/M3）。
- client 半部与 `dsh.client` 声明（M3；M1 不声明，避免影响 web client graph）。
- Windows 内核级 grant（无；M2 起非空根在 win32 保持 super 并输出一次显式告警，文档明示限制）。
- Linux 实机执行断言（M1 只做 bwrap / Landlock 的 argv 等价，实机执行留给 M2 的 Linux CI）。
- `*.dsh-workspace.json`、SDK API、向上游贡献通用 seam。

## 设计

- **D1 替换集合**：`cordis.patch.yml` = ① `{ id: fs-sandbox, disabled: true }` ② `{ id: sandbox, disabled: true }` ③ `{ insert: [multi-root-fs, multi-root-sandbox, multi-root-scope] }`。`sandbox-policy`、`bash-sandbox`、`tool-fs`、`tool-bash`、`terminal-bash` 一行不动；insert 追加到列表末尾（消费者靠 `inject` 等待，顺序无关）。
- **D2 依赖与导入面**：`peerDependencies` = `@deepseek-ai/cordis`、`dsh-fs`、`dsh-fs-local`、`dsh-sandbox`、`dsh-sandbox-local`、`dsh-sandbox-policy`（运行时不打包、不自带副本，保证 cordis 与服务定义单副本）；`devDependencies` 精确 pin `0.1.5-rc.2`；**只允许包入口导入**；`isPathUnder` 本地实现并在文件头注明来源与复制范围，由差分测试钉住。
- **D3 版本目标**：以 `0.1.5-rc.2` 为开发/CI 目标（= 本地上游 checkout，也是 registry 的 `next`）；`peerDependencies` 用生态惯例范围（`>=0.1.2-alpha.4 <0.2.0`）以兼容已安装的 `0.1.2-rc.1`；两运行时都进冒烟矩阵，差异按“两版本差异清单”核对。
- **D4 fs 空根直通的定义**：行为等价（不是 super 直通，也不是委托实例化上游 `SandboxedFileSystem` 这类依赖脱离上下文构造的做法）；保持单一代码路径，M2 只把根列表从 1 根换成 1+N 根。
- **D5 scope 单源**：`FilesystemScope { primaryRoot, additionalRoots }`；`MultiRootScopeService`（key `multiRootScope`）以 canonical `primaryRoot` 为索引键；M1 数据源为空表 + 测试注入接口，M3 换插件存储；任何 provider 不得自行判断路径或根，一律经它解析。
- **D6 sandbox provider 的契约**：空根 `return super.confine(argv, policy)`（逐元素等于上游）；非空根 M1 抛显式的“未实现”错误（M2 换 splice）。无论哪条路径，`enforcement` / `denialSignatures` / `runnerFailureRules` 必须原样透传，否则 `SandboxBashExecutor` 的 denial / enforcement 上报会失真。
- **D7 失败要响亮**：三重保障——duplicate-provide 的天然抛错；冒烟断言 `ctx.fs` / `ctx.sandbox` 是本插件实例且 `ctx.fs instanceof FileSystem`（同副本检测）；`smoke:compose` 的 dump 差分断言。
- **D8 工具链**：pnpm（仓库现有 `11.25.0`）+ TypeScript（strict、独立 host face）+ tsdown（逐入口 ESM bundle，`@deepseek-ai/*` 保持 external）+ tsc 出 `.d.ts` + vitest + oxlint（与上游一致，M1 不开 type-aware）+ GitHub Actions。
- **D9 平台**：M1 三平台行为无差异（根列表恒为 1 根）；win32 的 `bash-sandbox` 行维持上游平台门控不动。
- **D10 包与入口**：包名 `@dsh-electron/dsh-plugin-multi-root-workspace`，版本 `0.1.0`，`private: true`；`exports` 为 `.`（纯 barrel，无副作用）、`./fs`、`./sandbox`、`./scope`、`./package.json`；`dsh.bundle.patch = ./cordis.patch.yml`；`files` 只含 `lib/**`、`cordis.patch.yml`、README、LICENSE。

## 实施

### T0 前置探查（先做，结论必须写进文档）

1. 子路径行名实测：用手写最小 cordis.yml 插一行 `name: '<pkg>/fs'` 并 boot。可用则保持 D10；不可用则回退为“每个 provider 独立小包”或“单行 apply 插件在同一 ctx 上实例化多个 Service”，并记录取舍。
2. `dsh plugin --profile <name> add <仓库路径>` 全链路：确认本地目录链接形态、是否必须先 `pnpm build`、bundle 是否自动进入 `dsh.profile.bundles`、以及 loader 对 `version` / `files` 的要求。
3. 解析锚点：确认 `@deepseek-ai/*` 在两条运行时下分别从哪一层解析（profile 级 `node_modules`、模块回退目录、安装锚点），验证 D2 的单副本假设；若必须自带副本才能解析，则退回“自带副本 + 断言同一 cordis 实例”，并升级为高优先级风险。
4. 冒烟环境：确认隔离 `DSH_HOME` 下的 `--dump-config` 与进程内 `boot()` 均不依赖 LLM 凭据（`--dump-config` 已初验可用）。

### T1 仓库脚手架

`package.json`（名称、版本、exports、scripts、`dsh.bundle.patch`、精确 pin 的依赖）、`pnpm-workspace.yaml`（原生依赖的 build 许可，必要时排除新版本发布年龄限制）、`tsconfig.json` + `tsconfig.host.json`、`tsdown.config.ts`、`vitest.config.ts`、`.oxlintrc.json`、`.gitignore` 增补、`.github/workflows/ci.yml`。

scripts：`build` / `typecheck` / `lint` / `test` / `smoke:compose` / `smoke:behavior`，并保留既有 `docs:check`。

验收点：`pnpm install --frozen-lockfile` 后 `build`、`typecheck`、`lint`、`test` 全绿。

### T2 cordis.patch.yml

按 D1 形态落地。验收点：`smoke:compose` 差分断言通过。

### T3 scope 服务

`src/scope.ts`：`FilesystemScope`、`MultiRootScopeService extends Service`、`ctx.multiRootScope` 的类型增强、空表 + 测试注入 + `scopeOf(primaryRoot)`。

验收点：单测覆盖“未登记主根返回空列表”“登记后返回规范化且去重的根”“canonical 键等价（含 `..` 与家目录展开）”。

### T4 MultiRootFileSystem

`src/fs.ts` 继承 `LocalFileSystem`；`sandboxMode` getter 取部署默认模式；`writeText` / `editText` 按上游语义实现（`danger-full-access` 放行；`read-only` 以既有文案抛 `FS_SANDBOX_DENIED`；`workspace-write` 先重新解析取得 fresh target，再对 `[primaryRoot, ...additionalRoots, /tmp, tmpdir()]` 逐个 containment 判定，失败时文案列出全部允许根）。`src/containment.ts` 为带出处的本地 `isPathUnder`。

验收点：差分 parity 套件（模式 × 路径类别，含兄弟前缀路径不误判、symlink 别名、`..` 归一）全绿；临时区行为与上游一致；`static Config` 形状与上游一致（部署侧仍可配置 `cwd` 与 `diffBasisMaxBytes`）。

### T5 MultiRootSandboxProvider

`src/sandbox.ts` 继承 `LocalSandboxProvider`，按 D6 实现空根直通与非空根 fail loud。

验收点：用 `internals` 强制 seatbelt / bwrap / landlock 三种方言，断言本插件空根输出与同进程内新建的上游 provider 输出逐元素相同（argv、`enforcement`、`denialSignatures`、`runnerFailureRules`）；非空根抛错且错误信息表明尚未实现。

### T6 冒烟

- `scripts/lib/dsh-runtime.mjs`：CLI 发现顺序为环境变量 → PATH 上的 `dsh` → 本地开发依赖中的 `dsh` 入口；失败时给出修复指引。
- `scripts/smoke-compose.mjs`：隔离 `DSH_HOME`，先产出基线 dump，再装入插件后产出 dump，逐行 diff 断言只差预期行。
- `scripts/smoke-behavior.mjs`：隔离 `DSH_HOME`，scratch profile 的 bundles 为基础 bundle + 本插件；进程内 `boot()`；断言见“验证”。

验收点：脚本在 macOS 本地与 CI（ubuntu + macos）可运行；runner 不可用时仍断言 argv 等价，执行类断言按平台跳过并显式标记。

### T7 文档同步

新增两份 ADR；更新架构、需求、调研、路线图与计划索引；待命令真实存在后补充 `docs/development/` 的工具链与流程文档（含双运行时矩阵、隔离 `DSH_HOME` 冒烟食谱、CI）并同步其中英 README；更新根 README 与 `AGENTS.md` 的项目状态。

## 验证

```sh
pnpm install --frozen-lockfile
pnpm lint && pnpm typecheck && pnpm test
pnpm build
pnpm smoke:compose      # 组合差分断言（隔离 DSH_HOME）
pnpm smoke:behavior     # 空根直通行为矩阵（隔离 DSH_HOME，进程内 boot）
pnpm docs:check
```

`smoke:behavior` 断言清单（空根）：

1. `ctx.fs` 与 `ctx.sandbox` 分别是本插件的实例；`ctx.fs instanceof FileSystem`（同副本）；`ctx.shell` 仍是上游 `SandboxBashExecutor`。
2. `ctx.fs.sandboxMode` 等于部署默认模式。
3. 主根内 `writeText` / `editText` 成功；主根外写入抛 `FS_SANDBOX_DENIED` 且文案与上游一致；系统临时区与用户临时目录可写。
4. 会话模式为 `read-only` 时全部写入被拒；`danger-full-access` 放行（与上游一致）。
5. `ctx.shell.run` 的 `pwd` 为主根；主根内 bash 写文件成功；根外 bash 写文件被拒（Seatbelt / bwrap / Landlock 至少其一在本机实际执行）。
6. 基线对照：同一断言集在**未装插件**的同一 scratch profile 上跑通，结论与装插件后相同。

升级韧性：改动 pin 后重跑 T4 差分套件、`smoke:compose` 与 `smoke:behavior`，任一差异即报警。

## 风险

| # | 风险 | 影响 | 处置 |
| --- | --- | --- | --- |
| 1 | 子路径行名不被 loader 支持 | 结构需改 | T0 第 1 项先测；回退为“每 provider 一包”或“单行 apply 多 Service”，并在 ADR 记录 |
| 2 | peer 依赖解析锚点在两运行时不同，或被迫自带 dsh 副本（cordis 双副本导致服务注册失效） | 装载失败 | T0 第 3 项实测；冒烟加身份与 `instanceof FileSystem` 断言；若必须自带副本则升级为高优先级风险 |
| 3 | 上游升级改动 fence 细节，而插件已本地实现 `isPathUnder` 与 fence | 安全语义漂移 | 差分套件作为升级门禁；文件头注明出处；升级后必跑 smoke |
| 4 | patch disable 静默失效（行 id 变动导致 warn + skip） | 替换未生效 | duplicate-provide 天然抛错 + dump 差分断言 + 身份断言 |
| 5 | 非空根时 win32 无法做内核级 grant | Windows bash 场景 | M2 起保持 super + 一次显式告警；文档明示限制（第一期已知限制） |
| 6 | oxlint / tsdown / vitest 版本摩擦或原生依赖需要 build 许可 | 门禁无法运行 | `pnpm-workspace.yaml` 显式声明 build 许可；lint 不开 type-aware 以降复杂度 |
| 7 | 进程内 `boot()` 在纯基础 bundle 下缺少表面服务 | 冒烟不可行 | 回退：真实 CLI + 隔离 `DSH_HOME` + 只做断言的 probe overlay 插件 |
| 8 | 冒烟误改用户真实 `$DSH_HOME` | 环境污染 | 冒烟一律使用临时 `DSH_HOME`，脚本开头断言不等于默认家目录 |

## 文档影响

随本计划一并提交（已完成）：

- 新增：本文件、`docs/decisions/ADR-0001-provider-replacement-scope.md`、`docs/decisions/ADR-0002-upstream-coupling-policy.md`。
- 更新：架构文档（总览图、patch 示例、§5.2、§6、§8、§10）、需求文档（依据、机制表、第一期范围、验收标准、开放问题）、调研文档（§8.6 收窄说明 + 新增 §9 发布形态与运行时解析）、路线图计划（M1/M2 段落与风险表）、`docs/plans/README.md` 与 `README.en.md`、`docs/decisions/README.md` 与 `README.en.md`。

M1 实施期（T7）更新：`docs/development/` 工具链与流程文档及其中英 README、根 `README.md` 与 `README.en.md`、`AGENTS.md` 项目状态。

SSOT 分工：设计事实以架构文档为唯一真源，需求与验收以需求文档为唯一真源，上游事实以调研文档为唯一真源；本计划只承载里程碑级的排期、任务与验证，不重复上述内容。

## 实施结果（2026-09-12）

全部任务完成，验证证据如下（命令均在本仓库根目录执行）：

| 门禁 | 结果 |
| --- | --- |
| `pnpm lint` | 0 warnings / 0 errors |
| `pnpm typecheck` | 通过 |
| `pnpm test` | 32 passed（scope 单测 9、patch 不变量 7、fs 差分 parity 7、sandbox 空根等价 9） |
| `pnpm build` | `lib/{index,fs,sandbox,scope}.js` + `lib/types/*.d.ts` |
| `pnpm smoke:compose` | 30/30 checks passed |
| `pnpm smoke:behavior` | 54/54 checks passed（2 项按环境限制显式 skipped，见下） |
| `pnpm docs:check` | 0 errors / 0 warnings |
| 双运行时矩阵 | 两个冒烟在 `0.1.5-rc.2`（pin）与 `0.1.2-rc.1`（已安装桌面运行时）上均通过 |

交付物：`package.json`、`cordis.patch.yml`、`src/{scope,fs,sandbox,containment,index}.ts`、`tests/{scope,patch,fs-parity,sandbox-passthrough}.spec.ts`、`tests/support/`、`scripts/{smoke-compose,smoke-behavior}.mjs`、`scripts/lib/{dsh-runtime,profile-boot,check}.mjs`、`.github/workflows/ci.yml`、`pnpm-workspace.yaml`、`tsconfig*.json`、`tsdown.config.ts`、`vitest.config.ts`、`.oxlintrc.json`，以及 `docs/development/plugin-development-workflow.md`。

### T0 探查结论

1. **子路径行名可用**：`name: '@dsh-electron/dsh-plugin-multi-root-workspace/fs'`（以及 `/sandbox`、`/scope`）三行全部挂载成功，`ctx.fs` / `ctx.sandbox` / `ctx.multiRootScope` 均为本插件实例，`ctx.shell` 保持上游 `SandboxBashExecutor`。因此按 D10 的单包多入口落地，无需回退为"每 provider 一包"。
2. **`dsh plugin add` 全链路可用**：profile 自动初始化、pnpm 以 `link:` 形式安装本仓库、`dsh.profile.bundles` 自动追加本包。因为安装形态是链接（解析到本仓库真实路径），冒烟与安装流程都要求先 `pnpm build`。
3. **解析锚点与两种安装形态**：以本地路径安装（`link:`）时，插件的 `@deepseek-ai/*` 运行时导入按其自身 realpath 解析到本仓库 pin 的副本，宿主配置树使用所测运行时自己的副本；两个副本并存下服务注册、身份断言与行为比对全部通过，并额外验证了跨版本（`0.1.2-rc.1` 宿主 + 本插件 pin 副本）可用。以 `pnpm pack` 产物安装（发布形态，包内无 `node_modules`）时，`@deepseek-ai/*` 由宿主运行时/模块回退目录提供，三行同样全部挂载、身份正确——两种形态均无"自带副本才能加载"的问题。
4. **隔离 `$DSH_HOME` 冒烟可行且无凭据依赖**：`--dump-config` 与进程内 `boot()` 均不需要模型调用；同时发现 `healProfilesModuleFallback` 从**进程环境**读取 `$DSH_HOME`（不是 profile 对象），脚本已在组合前显式把它固定到临时目录，并保留"拒绝使用真实家目录"的断言。

### 与计划的偏差

- **受限 bash 执行断言在本机环境显式跳过**：本机运行在 DSH 会话内核沙箱内，macOS 不允许嵌套 `sandbox-exec`（`sandbox_apply: Operation not permitted`），`SandboxBashExecutor` 因此 fail-closed 抛 `SANDBOX_UNAVAILABLE`。两个 profile 的失败完全一致，所以"与未装插件一致"的比对依然成立；受限执行的方言 argv 等价由 `tests/sandbox-passthrough.spec.ts` 覆盖。在不被外层约束的终端或 CI runner 上，同一冒烟会真实执行受限 bash。
- 额外新增 `tests/patch.spec.ts` 与 `scripts/lib/*`（T2/T6 的落地细节）：前者把"disable 的 id 必须存在于 pin 的上游 bundle"变成单测级硬约束，后者承载运行时发现、profile 组合与断言汇总。
- `src/fs.ts` 的多根 denial 文案在**存在**附加根时才追加允许根列表；空根时与上游逐字符一致（M1 恒为空根，因此 `smoke:behavior` 的逐项比对成立）。

### 留给 M2/M3

附加根 grant 的方言拼接（M2）、附加根数据源（M2/M3）、`systemPrompt.context` 拓扑快照（M2）、命令与 client 半部（M3）。

## 完成判据

1. 本计划“目标”一节的五条成功标准全部可复现。
2. T0 的四项探查结论有明确记录；与“设计”一节冲突时，先更新本计划与对应 ADR，再进入后续任务。
3. `pnpm docs:check` 为 0 error；架构、需求、路线图、调研四份文档间不存在关于“替换几行、bash 是否替换、M1 是否做 fence”的矛盾表述。
4. 里程碑推进时按路线图把本文件移入 `docs/plans/completed/`，而不是删除。
