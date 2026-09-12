# M2 开发计划：附加根数据源与多根 provider（方言 grant + parity）

> 状态：completed（2026-09-12 实施完成并验证）| 日期：2026-09-12 | 里程碑：M2（共 M1/M2/M3）
> 目标运行时：dsh `0.1.5-rc.2`（pin）；同时兼容已安装桌面运行时 `0.1.2-rc.1`
> 里程碑划分：[2026-09-12-multi-root-workspace.md](../active/2026-09-12-multi-root-workspace.md)；设计：[multi-root-workspace.md](../../architecture/multi-root-workspace.md)；需求与验收：[multi-root-workspace.md](../../requirements/multi-root-workspace.md) §5；上游事实：[multi-root-workspace-research.md](../../reference/multi-root-workspace-research.md)
> 决策依据：[ADR-0001](../../decisions/ADR-0001-provider-replacement-scope.md)、[ADR-0002](../../decisions/ADR-0002-upstream-coupling-policy.md)、[ADR-0003](../../decisions/ADR-0003-dialect-grant-widening.md)

## 目标

让附加根在 macOS（Seatbelt）与 Linux（bwrap/Landlock）**端到端真正可用**：`fs` 工具与 bash/PTY 对同一份 scope 给出同一张允许矩阵，且空根时仍与未装插件逐项一致。

成功标准（可判定）：

1. `lint` / `typecheck` / `test` / `docs:check` 全绿，`build` 产出 `lib/`。
2. **空根零回归**：`smoke:compose` 仍是 30/30（patch 不变）；`smoke:behavior` 的空根 plugin↔baseline 逐项比对仍全绿。
3. **多根生效**：非空 scope 下 `ctx.fs` 可写附加根及其子目录；`ctx.sandbox.confine` 的 argv 在三种方言下都显式授予同一组附加根；`read-only` 下两种 provider 都不授予任何附加根。
4. **单一权限世界**（需求 §4 / 验收 4）：同一 scope 下，fs fence 的写判定与「从方言 argv 解析出的授予集合」在全部路径类别上逐项一致，且解析器由测试侧独立实现。
5. **失败要响亮**：方言无法识别时抛 `SandboxUnavailableError`；`win32` 上非空 scope 保持 super 输出并输出一次显式告警。
6. **Agent 认知**（验收 6）：workspace-write 且有附加根时 `systemPrompt.context` 贡献稳定拓扑；空根 / 只读 / 无 agent 时零输出。
7. 上游仓库零改动；`cordis.patch.yml` 不变。

## 背景与当前状态（实施前实测）

- M1 已完成：插件经 `dsh plugin` 安装、替换两行 provider、空根行为与未装插件逐项一致。`src/fs.ts` 的 containment **在 M1 就已按多根实现**（`writableRoots(policy)` ∪ `scope.additionalRoots`），M2 的 fs 侧增量因此是「证明与方言授予一致 + 多根 denial 文案回归」。
- `LocalSandboxProvider` 发布形态的公开面**只有** `confine(argv, policy)` 与 `internals`：`runnerArgv` / `landlockLauncher` / `seatbeltExec` / `windowsAclRunnerArgv` 在发布 `.d.ts` 中是 TS-private。方言只能从 `super.confine` 的**输出**识别（ADR-0002 决策 2）。
- `confine` 输出结构固定为 `[...profileArgs, '--', ...callerArgv]`，分隔符可精确计算并逐元素校验。
- 四种方言的 profile 形状、bash/PTY 在 `danger-full-access` 下不调用 `confine` 等事实，见调研文档 §10。
- 上游 `writableRoots` 与 bwrap/Landlock 的授予集合本就存在 `tmpdir()` 差异（上游自认的 per-runner 差异）；插件只并入附加根，不修正上游既有差异。

## 对路线图 M2 段落的修正

| 路线图原文 | 本计划 | 依据 |
| --- | --- | --- |
| `MultiRootFileSystem`：多根 containment 待实现 | M1 已实现；M2 只补「与方言授予集合逐项一致」的 parity 证据与 deny 文案回归 | `src/fs.ts#rootsFor` |
| 「scope 数据源：把空表换成附加根集合」 | 数据源仍是 `setAdditionalRoots`（测试/冒烟注入），M2 不引入插件存储（M3 接 `dsh-storage-domain`） | 避免与 M3 冲突 |
| 方言 grant 由「克隆 `super.confine` 的 grant 模板」实现（未定手法） | 定为**结构识别 + 观测克隆 + 已授予跳过**；**不**用「合成 policy 二次调 super.confine」探测（win32 上会真实物化 ACL grant） | ADR-0003 |
| 「Windows 仅 fs fence 用例」 | 不新增 `windows-latest` CI 腿；win32 行为用 `internals.chain = ['windows-acl']` 在任意宿主上钉住 | 避免符号链接/临时区相关的 Windows 抖动 |
| `systemPrompt.context` 拓扑快照 | 落在 `MultiRootScopeService` 内（不新增 patch 行），仅 workspace-write + 非空根输出 | `cordis.patch.yml` 不动 ⇒ `smoke:compose` 断言不失效 |

## 范围

- `src/dialects.ts`（新）：方言识别 + 授予段拼接的纯函数模块。
- `src/sandbox.ts`：接入拼接；mode 门控；win32 warn-once；fact 透传。
- `src/scope.ts`：拓扑文案纯函数 + `ctx.inject(['systemPrompt','sandboxPolicy'])` 注册。
- 测试：`tests/dialects.spec.ts`、`tests/parity-matrix.spec.ts`、`tests/sandbox-multi-root.spec.ts`（新），`tests/support/dialect-grants.ts`（新，测试侧独立解析器），`tests/sandbox-passthrough.spec.ts` 与 `tests/scope.spec.ts`（改）。
- `scripts/smoke-behavior.mjs`：多根 battery（真实 scope 注入 + 真实方言 argv + 可用时真实受限执行）。
- `package.json` / `pnpm-workspace.yaml` / lockfile：新增三个 devDependency。
- 文档：ADR-0003、调研 §10、架构 §5.3/§6、开发流程、路线图、plans 索引、根 README（中英）、`AGENTS.md`。

## 非目标

- 插件存储、root 注册表、校验规则、`/workspace-folders` 命令、client 半部、e2e（M3）。
- `workspace_roots` 内省工具（M3 先验证拓扑文案是否够用）。
- Windows 内核级多根（pwsh/ACL）。
- 附加根存在性 re-check 与用户通知（M3）。
- 「以附加根作为 bash/PTY 默认工作目录」（`policy.workspaceRoot` 语义不变）。

## 设计

### D1 方言识别与拼接（`src/dialects.ts`）

```ts
export type RunnerDialect = 'seatbelt' | 'bwrap' | 'landlock' | 'windows-acl'
export class DialectUnrecognizedError extends Error {}          // provider 唯一转译的错误类型
export function splitConfined(confinedArgv, commandArgv): ConfinedShape
export function detectDialect(profileArgs): RunnerDialect
export function widenProfileArgs(dialect, profileArgs, policy, additionalRoots): string[]
```

- `splitConfined`：`separator = confinedArgv.length - commandArgv.length - 1`，并校验 `confinedArgv[separator] === '--'` 且其后逐元素等于调用方 argv。
- `detectDialect`：结构标记唯一匹配才通过（0 个或多个都抛错）：seatbelt `[…, -p, <SBPL>]`（profile 是最后一个元素）、windows-acl 含 `--mode`、landlock 含 `--rw`、bwrap 含 `--ro-bind`（`runnerCommand` 配置情形与 bwrap 同形）。
- `widenProfileArgs`：要求 `workspace-write`；按方言克隆观测到的拼写：
  - seatbelt：定位 `(allow file-write* (subpath "…") …)` 形式，把新根以 `(subpath "…")` 追加进**该形式内部**；字面量转义与上游 `sbplString` 同实现。
  - bwrap：从 `<workspaceRoot>` 的 bind 三元组克隆 flag（排除 `--ro*`），在分隔符前追加 `[flag, root, root]`。
  - landlock：取 `<workspaceRoot>` 前一个元素作为 rw flag，追加 `[flag, root]`。
  - 已授予即跳过：解析该方言**已存在**的授予集合（subpath 字面量 / `--tmpfs` 目标与 bind 目标 / `--rw` 路径），与之相等的附加根不再重复授予（与 fs fence 的 `roots.includes` 去重对齐，并避免 bwrap 上真实 `/tmp` 覆盖 `--tmpfs /tmp`）。
  - windows-acl：不拼接、不抛错（provider 走告警分支）。

### D2 provider 接入（`src/sandbox.ts`）

`super.confine` 先取上游结果（facts 的唯一来源）→ `scope.resolve(policy)` → 非 workspace-write 或空根即原样返回 → `splitConfined` + `detectDialect` → windows-acl 走 warn-once → 其余返回 `{ ...confined, argv: [...widenProfileArgs(...), '--', ...argv] }`；`DialectUnrecognizedError` 转译为 `SandboxUnavailableError`（fail closed，绝不静默单根）。

### D3 拓扑快照（`src/scope.ts`）

- 纯函数 `renderWorkspaceRootsContext(primaryRoot, additionalRoots)`；贡献名 `multi-root:scope`，order = `getContextOrder('SANDBOX_POLICY') + 1`（紧接策略句之后）。
- 软注入：`ctx.inject(['systemPrompt','sandboxPolicy'], scope => …)`；回调内用**该 scoped ctx** 读取服务（cordis 代理要求 inject 才允许属性访问）。
- 输出条件：有 agent → 策略 mode 为 workspace-write → scope 非空；否则返回空串（空段被 `renderContextSections` 过滤，快照与未装插件逐字节相同）。

### D4 依赖与构建面

`devDependencies` 新增精确 pin 的 `@deepseek-ai/dsh-agent`、`dsh-session`、`dsh-system-prompt`（三者都已在 lockfile/store 的传递闭包中；仅类型与测试使用，运行时导入图不变，`peerDependencies` 不变）；`pnpm-workspace.yaml#minimumReleaseAgeExclude` 追加对应条目；`package.json#exports`、`tsdown.config.ts#entry`、`cordis.patch.yml` 不变（`src/dialects.ts` 为内部模块，被内联进 `lib/sandbox.js`）。

## 实施

| 任务 | 内容 | 验收点 |
| --- | --- | --- |
| T0 | 用 `internals.chain` 实测四方言 + `runnerCommand` 的 `confine` argv 形状、分隔符算法、TS-private 面；确认三个 devDependency 可安装；确认本机无法嵌套 Seatbelt | 结论写入调研 §10 |
| T1 | `src/dialects.ts` 按 D1 | 单测全绿 |
| T2 | `src/sandbox.ts` 按 D2 | provider 级断言全绿 |
| T3 | `src/scope.ts` 按 D3 | 拓扑断言全绿 |
| T4 | devDependency 与 `pnpm-workspace.yaml` | `pnpm install` 仅改三个 importer |
| T5 | 测试：方言单测、provider 多根、parity 矩阵、测试侧独立解析器；改造 `sandbox-passthrough.spec.ts`（删除 M1 边界断言）与 `scope.spec.ts`（拓扑） | `vitest` 全绿（真实执行项按宿主能力显式 skip） |
| T6 | `smoke-behavior.mjs` 多根 battery | 空根 54/54 不回归 + 多根断言通过 |
| T7 | 文档：ADR-0003、调研 §10、架构、开发流程、路线图、索引、README、`AGENTS.md` | `docs:check` 0 error |
| T8 | 全量验证、双运行时回归、计划归档并补实施结果 | 见「验证」 |

## 验证

```sh
export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:/opt/homebrew/bin:$PATH"   # 本机 PATH 缺 node/pnpm
pnpm lint && pnpm typecheck && pnpm test
pnpm build
pnpm smoke:compose      # 期望 30/30（不变）
pnpm smoke:behavior     # 期望：空根比对 + 多根 battery 全绿；无 runner 的项显式 skipped
pnpm docs:check
DSH_CLI=<另一运行时 dsh 入口> pnpm smoke    # 双运行时回归
```

`smoke:behavior` 多根断言清单：

1. scope 解析出注册的附加根（canonical）与主根；
2. `workspace-write`：fs 写附加根成功；写第三个目录被拒且文案含 `FS_SANDBOX_DENIED` 与 `allowed roots:`，并列出主根与附加根两个路径；根外不留文件；
3. **宿主真实方言**（不注入 internals）的 `confine` argv 含附加根；`read-only` 下不含；
4. 受限 bash：可用时写附加根成功、写根外被拒；不可用时显式 skip 并说明原因（本机为嵌套内核沙箱限制）；
5. 空根阶段（不注入根）与未装插件的 profile 逐项一致（M1 安全网不回归）。

## 风险

| # | 风险 | 影响 | 处置 |
| --- | --- | --- | --- |
| 1 | 上游改动方言 flag 拼写/结构 | 多根静默失效或误授予 | 结构识别 + 观测克隆 + 识别失败抛 `SandboxUnavailableError`；parity 矩阵 + 升级 smoke |
| 2 | 本机无法真实执行受限 bash | 本地无法端到端证明内核授予 | 本地 argv 级 + fs 级矩阵；CI 实跑；skip 必须显式带原因 |
| 3 | 三个 devDependency 装不上 | 拓扑测试形态受限 | T0 先验；回退为「纯渲染函数单测 + 假 systemPrompt seam」，并记录偏差 |
| 4 | bwrap 上附加根位于 `/tmp` 与 `--tmpfs` 冲突 | 语义漂移 | 「已授予即跳过」避免重复挂载真实 `/tmp` |
| 5 | 附加根路径含 `"`/`\` 导致 SBPL 转义错误 | profile 被拒（fail-closed）或匹配错路径 | 与上游同实现的转义 + 单测 |
| 6 | 附加根不存在 | bwrap/landlock 运行时失败 | M2 不做存在性判断（M3 负责）；fail-closed 行为记录 |
| 7 | 拓扑注入影响 prompt cache | 长会话成本 | 空根/只读零输出（逐字节断言） |
| 8 | win32 上 fs 可写但 bash 不可写 | 「单一权限世界」在 Windows 不成立 | 第一期已知限制：warn-once + 需求文档明示 |
| 9 | 上游 `writableRoots` 与 bwrap/landlock 的 `tmpdir()` 差异 | 矩阵断言误报 | 断言语义限定为「附加根集合」；/tmp 行仅对本机原生方言比较（见 T5 说明） |
| 10 | `SANDBOX_POLICY + 1` 与未来上游新增 context 序号冲突 | 排序错位 | 仅影响相邻段顺序；测试断言自身 name/text |

## 文档影响

新增：本文件、[ADR-0003](../../decisions/ADR-0003-dialect-grant-widening.md)、调研 §10。
更新：架构文档（§5.3/§6 + 状态头）、`docs/architecture/README.md`、开发流程文档、路线图（M2 段 + 风险表）、`docs/plans/README.md` 与 `README.en.md`、根 `README.md`/`README.en.md`、`AGENTS.md`。
SSOT 分工：设计事实 → 架构文档；验收判定 → 需求文档；上游事实 → 调研文档；排期/任务/验证证据 → 本计划。

## 完成判据

1. 「目标」7 条成功标准逐条可复现，证据写入「实施结果」。
2. 非空 scope 下三方言的 argv 授予集合与 fs fence 判定逐项一致，由测试侧独立解析器给出。
3. `cordis.patch.yml` 与上游仓库零改动；`smoke:compose` 仍 30/30。
4. `docs:check` 0 error，且架构/需求/调研/路线图/计划之间无「M2 是否已实现多根」的矛盾表述。
5. 计划文件移入 `docs/plans/completed/`，路线图 M2 段落与 plans 索引同步。

## 实施结果（2026-09-12）

| 门禁 | 结果 |
| --- | --- |
| `pnpm lint`（oxlint） | 0 warnings / 0 errors |
| `pnpm typecheck` | 通过 |
| `pnpm test`（vitest） | **79 项：76 passed / 3 skipped**（3 项为真实受限执行，宿主不可用） |
| `pnpm build` | `lib/{index,fs,sandbox,scope}.js` + 2 个共享 chunk + `lib/types/**/*.d.ts` |
| `pnpm smoke:compose` | 30/30 checks passed（patch 未变） |
| `pnpm smoke:behavior` | **69/69 checks passed**（4 项显式 skipped：受限 bash 执行 ×2、多根受限 bash ×2） |
| `pnpm docs:check` | 0 errors |
| 双运行时矩阵 | 两个冒烟在 `0.1.5-rc.2`（pin）与 `0.1.2-rc.1`（已安装桌面运行时）上均通过 |

用例分布：`scope.spec.ts` 15（含拓扑 6）、`dialects.spec.ts` 23、`sandbox-multi-root.spec.ts` 9、`sandbox-passthrough.spec.ts` 8、`fs-parity.spec.ts` 7、`parity-matrix.spec.ts` 10（3 skipped）、`patch.spec.ts` 7。

交付物：`src/dialects.ts`（新）、`src/sandbox.ts`、`src/scope.ts`、`tests/dialects.spec.ts`、`tests/sandbox-multi-root.spec.ts`、`tests/parity-matrix.spec.ts`、`tests/support/dialect-grants.ts`、`tests/sandbox-passthrough.spec.ts`、`tests/scope.spec.ts`、`scripts/smoke-behavior.mjs`、`package.json`/`pnpm-workspace.yaml`/`pnpm-lock.yaml`，以及本文件、ADR-0003、调研 §10 与架构/开发流程/路线图/README/`AGENTS.md` 的同步更新。`cordis.patch.yml` 与上游仓库零改动。

### T0 探查结论

1. **四方言形状与调研 §10.3 完全一致**：`confine` 输出恒为 `[...profileArgs, '--', ...callerArgv]`，分隔符可精确计算并校验；seatbelt 在 `read-only` 下没有 subpath form，bwrap/Landlock 在 `read-only` 下没有可写授予，windows-acl 恒含 `--mode`。
2. **一处实现前未预料的细节（由测试首先发现）**：`profileArgs` 含 runner 程序本身（seatbelt 为 `['sandbox-exec','-p',<SBPL>]`），因此 seatbelt 的识别不能看"首元素是否 `-p`"，必须看"倒数第二个元素是 `-p` 且 profile 是最后一个元素"。这条已固化在 `detectDialect` 与测试里，并写入调研 §10.3。
3. **依赖面**：三个新 devDependency 均已在 lockfile/store 的传递闭包中，`pnpm install` 只改了三个 importer（lockfile +9 行），运行时导入图不变（`tsdown` 外部化集合与 `peerDependencies` 均未变）。
4. **工具链现实**：仓库 pin 的 pnpm `11.25.0` 由其版本管理器安装，需要写用户级 pnpm 目录（沙箱内被拒，需一次提权）；而冒烟里的 profile 安装走 PATH 上的 pnpm（`10.33.0`），无需提权。仅跑门禁时可用 `sh node_modules/.bin/<tool>` 绕过 pnpm（本次验证即如此）。
5. **本机受限执行不可用**：`sandbox-exec` 在外层内核沙箱内以 `sandbox_apply: Operation not permitted` 失败，bwrap/Landlock 在本机不存在，因此本地真实执行类断言全部显式 skip 并打印原因；真实执行覆盖留给 CI（macOS Seatbelt、Linux bwrap 或 Landlock）。

### 与计划的偏差

- **矩阵的「平台临时区」一行限定为本机原生方言**：把 Linux 方言强制到 darwin 上时，bwrap 的 `--tmpfs /tmp` 与 Landlock 的 `--rw /tmp` 是字面拼写，而 darwin 的 canonical 临时区是 `/private/tmp`，该行不可比（上游既有差异，非插件引入）。`read-only` 下该行仍对全部方言生效（两侧都拒）。这是计划风险 #9 的实际处置，已写进测试注释。
- **冒烟的多根阶段只断言 plugin profile**，不与 baseline 比较：baseline 没有多根能力，多根差异正是被测对象；空根阶段的两 profile 逐项比对保持原样。
- **升级指引的端到端未在 M2 冒烟驱动**：冒烟断言的是 provider 级 `FS_SANDBOX_DENIED` + `allowed roots:` 文案，经 `tool-fs` escalation UI 的完整用户旅程留给 M3 e2e（该 UI 的上游输入 `ctx.fs.sandboxMode` 已在冒烟中断言）。
- **拓扑测试按计划落在 `tests/scope.spec.ts`**（未新建文件），并额外新增一条"无 systemPrompt seam 时仍可挂载"的软依赖断言。

### 留给 M3

附加根注册表与校验纯函数、`/workspace-folders` 命令、可选 `workspace_roots` 工具、client 半部与 Workspace Folders 面板、e2e（web + headless + 桌面端）、附加根存在性 re-check 与用户通知、Windows 内核级多根的评估。
