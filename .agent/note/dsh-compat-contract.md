# DSH 兼容性契约：Agent 需要先知道的事

English: [dsh-compat-contract.en.md](./dsh-compat-contract.en.md)

这份笔记记录的是**改动本仓库之前必须知道、否则很容易踩坑**的兼容性机制。决策理由在 [ADR-0009](../../docs/decisions/ADR-0009-dsh-compat-contract.md)，用户侧排查在 [故障排查条目](../../docs/troubleshooting/unsupported-dsh-release.md)。这里只写"作为 Agent 你会撞到什么"。

## 1. 支持矩阵的唯一真源

```text
src/compat/dsh-version.ts  →  SUPPORTED_DSH_RELEASES
```

是**精确版本数组**，不是 semver 范围。当前：

```ts
export const SUPPORTED_DSH_RELEASES = ['0.1.5-rc.2', '0.1.6-alpha.1', '0.1.6-alpha.2', '0.1.7-alpha.1', '0.1.7-alpha.2', '0.1.7-rc.1', '0.1.7-rc.2', '0.2.0-rc.1', '0.2.0-rc.2', '0.2.1-alpha.1', '0.2.1-alpha.2', '0.2.1-alpha.3', '0.2.1-alpha.4', '0.2.1-alpha.5', '0.2.1-rc.1', '0.2.1-rc.2', '0.2.1-rc.3', '0.2.1-rc.4', '0.2.1-rc.5', '0.2.2-alpha.2', '0.2.2-alpha.3', '0.2.2-rc.1', '0.2.2-rc.2'] as const
```

改它的时候，下面四处必须同时一致，否则 `pnpm compat:check` 失败：

```text
src/compat/dsh-version.ts   SUPPORTED_DSH_RELEASES   allowlist
package.json                peerDependencies         "0.1.5-rc.2 || 0.1.6-alpha.1 || 0.1.6-alpha.2 || 0.1.7-alpha.1 || 0.1.7-alpha.2 || 0.1.7-rc.1 || 0.1.7-rc.2 || 0.2.0-rc.1 || 0.2.0-rc.2 || 0.2.1-alpha.1 || 0.2.1-alpha.2 || 0.2.1-alpha.3 || 0.2.1-alpha.4 || 0.2.1-alpha.5 || 0.2.1-rc.1 || 0.2.1-rc.2 || 0.2.1-rc.3 || 0.2.1-rc.4 || 0.2.1-rc.5 || 0.2.2-alpha.2 || 0.2.2-alpha.3 || 0.2.2-rc.1 || 0.2.2-rc.2"
package.json                devDependencies          allowlist 中的某一项（当前 0.2.2-rc.2）
node_modules                实际解析到的版本          allowlist 中的某一项
```

`scripts/check-dsh-compat.mjs` 是**文本读取** TypeScript 源码里的这个数组，不是 import。所以：**不要把它改成非 `export const NAME = [...]` 字面量形式**（比如从别处拼出来、或者加类型断言以外的表达式），否则静态检查会直接抛错。原因是这个检查必须能在 `pnpm build` 之前、在没有 `lib/` 的干净 checkout 上跑。

非 `dsh-*` 的共享上游包（`cordis`、`schemastery`、`node-addon-system`）同样**只能是 peer**：它们是宿主树自带的单例——`dsh-sandbox-local` 在每个受支持版本上都直接依赖后两者，插件私带一份就是第二份。放进 `dependencies` 的实际后果（issue #30）：profile 里装出 schemastery `3.18.5` 对宿主 `3.18.6-alpha.1`、cosmokit `1.8.6` 对 `1.8.7-alpha.1` 和一份同版本的 node-addon-system，启动器依赖自检报 `profile-core-mixed` / `profile-core-copy`。机制要记牢：`^3.18.2` 这类范围**不匹配** prerelease（`3.18.6-alpha.1` 不满足它），所以 peer 范围必须像 cordis peer 那样"稳定线用范围 + alpha 线逐个具名"（`>=3.18.2 <4.0.0 || 3.18.5-alpha.1 || 3.18.5-alpha.2 || 3.18.6-alpha.1 || 3.18.6-alpha.2`），升版纳入新 alpha 线时同步扩并集；`devDependencies` 钉开发 pin 宿主自带的精确版本，由 `upgrade-dsh.mjs` 随 ecosystemPins 重指。`compat:check` 与 `tests/compat.spec.ts` 硬性检查 `dependencies` / `optionalDependencies` 里没有任何 `@deepseek-ai/*` 名字。

同一单例规则对**原生镜像**也成立：`koffi` 仍是合法 `dependencies`（独立场景的兜底），但安装进 profile 后必须 dlopen 宿主那份——`dsh plugin add` 会在宿主已加载的 koffi 旁再装一份私有副本，两个 `koffi.node` 镜像同进程在 darwin-arm64 指针校验（PAC）下直接 SIGBUS，进程无声退出（2026-11-01 packed smoke 实锤；main 上同样崩，属 F4 既有回归）。全部 FFI 调用点统一走 `src/compat/koffi.ts` 的 `loadHostKoffi()`；需要同步读取 Git 元数据的 Worktree 使用同一模块的 `loadHostKoffiSync()`。两者都以必需 peer `dsh-fs-local`（每个受支持版本都携带 koffi）为锚点解析宿主副本，解析不到才回退包内自带。`tests/compat.spec.ts` 扫描 `src/` 禁止 `compat/koffi.ts` 之外出现裸 `import('koffi')`。

## 2. 你写的测试可能因为门禁而失败——这是对的

`multi-root-compat` 是 patch 第一行，以下**宽授权行** inject 它：

```text
multi-root-providers
multi-root-registry
multi-root-instructions
multi-root-lsp
multi-root-workspace-files
multi-root-process-fence
```

cordis 不会启动 injected service 缺失的行。所以在测试里 mount 上述任何行（或经它们间接受门控的行，如注入 `multiRootRegistry` 的 `multi-root-command`）之前，必须先：

```ts
import { mountCompat } from './support/compat.ts'

await mountCompat(ctx)
```

否则 `ctx.get('multiRootRegistry')` 之类是 `undefined`。这不是 bug，是门禁在工作（`tests/compat.spec.ts` 里有专门断言）。

**两个 provider 行（`multi-root-fs` / `multi-root-sandbox`）刻意不 inject 门禁**：它们的放宽由 scope 驱动，而被门禁的 registry 永远不会在被拒安装上填充 scope，所以它们在门禁失败时退化为上游 provider。这必须保持：patch 已经无条件禁用了上游 `fs-sandbox` / `sandbox`，provider 一缺席，`ctx.fs` / `ctx.sandbox` 消失 → `ctx.shell`（inject `sandbox`）起不来 → `permissionPresets`（inject `shell`）起不来 → 整个 profile 瘫痪（`permissionPresets/catalog` 报 service-unavailable）。门禁失败的正确形状是"插件功能缺席、profile 完好"，从来不是"profile 死"。

`mountCompat` 挂载的是**真实的** compat 行，含门禁策略。所以整个单元套件在一个不在 allowlist 上的版本上会直接失败——这是刻意的，见下面第 5 条。

## 3. `confine` 在不同版本上是同步/异步的

```text
0.1.5-rc.2     confine(argv, policy): ConfinedArgv
0.1.6-alpha.1  confine(argv, policy, signal?): Promise<ConfinedArgv>
0.1.6-alpha.2  confine 形状与 0.1.6-alpha.1 相同（2026-09-22 实测）。会话目录的形状不同，见下一节。
0.1.7-alpha.1  confine 形状与 0.1.6-alpha.1 相同（2026-09-22 实测；这一版别的形状变了，见第 4 条）
0.1.7-alpha.2  与 0.1.7-alpha.1 相同（2026-09-24 实测）
0.1.7-rc.1     与 0.1.7-alpha.1 相同（2026-09-24 实测）。这一版新增的是安装期 peer 门禁，见第 4 条末尾
0.1.7-rc.2     与 0.1.7-rc.1 相同（2026-09-25 对照 tag 实测）。cordis 仍是 `~4.0.4`
```

**不要**在 `src/sandbox.ts` 里手写签名去迁就某一个版本。统一走 `src/compat/sandbox-confine.ts` 的 `widenConfined()`，它**保形**：上游同步就同步返回，上游返回 promise 就返回 promise。

绝不要"统一包成 promise"。在 `0.1.5-rc.2` 上那会把 `ctx.sandbox.confine()` 对组合里每一个调用方（bash executor、PTY backend）都变成 thenable，等于插件自己引入一次破坏性变更。

测试和 smoke 里读结果时：

- 单元测试用 `tests/support/confine.ts` 的 `confined(provider, argv, policy)`；
- smoke 脚本一律 `await ctx.sandbox.confine(...)`。

**这是一个安静的坑**：`await` 一个普通值是 no-op，但直接读 promise 的 `.argv` 会得到 `undefined`，报错形如 `Cannot read properties of undefined (reading 'some')`，看起来完全不像版本问题。

## 4. 上游改过的 API 只能在 `src/compat/` 里分支，且用结构探测

业务代码不出现任何版本判断。目前的适配器：

| 文件 | 吸收的差异 |
| --- | --- |
| `src/compat/sandbox-confine.ts` | `confine` 的同步/异步与 arity |
| `src/compat/agent-instructions.ts` | renderer 改名：`renderWorkspaceContext`（0.1.5）→ `renderAgentInstructions`（0.1.6，0.1.7 未再改） |
| `src/compat/client-session.ts` | 当前会话：`list.current`（0.1.5 / 0.1.6-alpha.1）→ 目录行 `retainedBy.mainView > 0`（0.1.6-alpha.2 与 0.1.7-alpha.1 至 0.1.7-rc.2；0.1.7 挪走了别的目录字段，主视图谓词没变） |
| `src/compat/llm-message.ts` | session format 3 及更早投 `{ kind: 'plugin', plugin, form: 'instructions' }`；format 4（`0.1.7` 的 `SESSION_FORMAT_VERSION`）拒绝 `kind: 'plugin'`，改投 `{ kind: 'multi-root-workspace', plugin, form: 'instructions' }`。探针是 session 包导出的格式常量，**不是** renderer 名字——0.1.6 已经改名却仍接受 `plugin`。不要用 `agent-instructions`：上游把那个 kind 的 `changes` 当自己的协调权威 |
| `src/compat/tool-result.ts` | 失败位：0.1.5/0.1.6 在 `content[0].isError`，0.1.7 在消息自身的 `isError`。`event.data.error` 两边都还在 |
| `src/compat/client-icons.ts` | 面板图标：0.1.5/0.1.6 是像素名（`IconFolderClose16`），0.1.7 是线宽名。上游 UI 用的是 Regular，不是 Medium。先取像素名，没有再取 Regular。纯装饰字形走 `maybeIcon` 软探测（缺失降级为无图标，不抛错），带必需 fallback 的可选字形走 `selectIconOr`——权限字形 `IconWorkspaceWrite`/`IconReadOnly` 仅 0.1.7+ 存在 |
| `src/compat/process-entrypoints.ts` | 进程栅栏包装哪些公开入口：`ctx.shell` 上 `execute`/`run`/`start` 的存在性探测（`start` 存在于 0.1.6 及更早），`ctx.ptcRuntime` 只认公开 `run`（具体实现的 `execute` 是私有 helper，不作跨包接缝） |
| `scripts/lib/profile-boot.mjs` | `healProfilesModuleFallback` 是函数就调用它；否则 `createRuntimeResolution`，并在 `boot` 的 prepare 里 `hostCtx.plugin(PluginPackages, { resolution })`。0.1.7 不再导出 heal |
| `scripts/lib/shell-exec.mjs` | `shell.run` 存在就用它；否则 `shell.execute(spec)` 再 `execution.result()`。0.1.7 的 `SandboxBashExecutor` 改了名从 run 到 execute |

一律用**结构探测**（是否 thenable、导出哪个名字、快照有没有 `current`），不要比较版本号。上游是 pre-stable，同一版本内也会改形状；结构探测能应付，版本比较不能。

`0.1.7-alpha.2`、`0.1.7-rc.1` 与 `0.1.7-rc.2` 相对 `0.1.7-alpha.1` 没有改上面这张表里的形状（2026-09-24 对照 `alpha.1` / `alpha.2` / `rc.1`；2026-09-25 对照 `rc.1` → `rc.2`）。`rc.1` 新增的是**安装期**门禁，不在 `src/compat/`：`dsh plugin add` 与 `loadProfile` 用 `semver.satisfies(runtime, peerRange, { includePrerelease: true })` 检查每一个 `@deepseek-ai/dsh*` peer，不满足就拒绝安装或跳过 bundle。因此把一个 `0.1.7-rc.1` 及以后的版本放进 allowlist 时，`peerDependencies` 必须在同一改动里带上那个精确版本，否则 smoke 的 `dsh plugin add` 会在本插件的运行时门禁之前就失败。`DSH_MULTI_ROOT_COMPAT=warn` 放宽不了这一关。

**这是一个安静的坑**：`0.1.6-alpha.2` 的 host 矩阵（`confine`、instruction renderer、journey Messages 端点）与 alpha.1 相同，所以当时按"适配层无改动"纳入 allowlist。客户端 Session Controller 却在 `6830e1460d` 把 `SessionListState.current` 删掉了，导航改由主视图 `retain(..., { source: 'mainView' })` 持有。面板仍读 `list.current` 时，已打开的对话会显示「当前没有活动会话」，并且**不向 host 发请求**。

探测顺序：非空的 `current` 优先（旧形状），否则取第一条 `retainedBy.mainView` 为正数的目录行。目录有行但没有一行被主视图持有时返回 `undefined`——**绝不要**回退 `ids[0]`，那会把操作打到操作者没在看的会话。`getSnapshot` 必须按方法调用，抽出来再调会丢掉 store 的 `this`。

`agent-instructions` 是**可选 peer**：最小组合里可能既没有它也没有 agent。`instructionsApi()` 在包不存在时返回 `undefined`（贡献为空），但包存在却两个 renderer 名字都没有时**抛错**——那是需要修适配器的兼容性破坏，不是可选接缝。

`@deepseek-ai/dsh-llm` **同样是可选 peer，且只能按需加载**：barrel（`src/index.ts`）正是 carrier loader 行挂载的模块，它的加载期依赖集合必须等于必需包集合，所以任何静态值导入都会让一个根本不构造消息的最小组合加载失败。消息构造统一走 `src/compat/llm-message.ts` 的 `createInstructionMessage()`，它在真正要构造消息时才 `await import('@deepseek-ai/dsh-llm')`。`tests/optional-peers.spec.ts` 钉住了这一点：加载 `src/index.ts` 与 `src/instructions.ts` 时该包不会被 resolve。

`instructionsApi()` 还要把**包不存在**与**包在但求值失败**分开：先用 `isPackageInstalled()` 单独探测安装情况（`createRequire(import.meta.url).resolve`，与 `readInstalledVersion` 同一模式），只有 `MODULE_NOT_FOUND` / `ERR_MODULE_NOT_FOUND` 算"不存在"；其余失败（例如传递依赖缺失导致 `import()` 抛错）必须向上抛，绝不缓存成 `undefined`——那会让整个进程静默停止投递附加根指令。

## 5. `DSH_MULTI_ROOT_COMPAT=warn` 不是给你用的调试开关

它只为升级车道存在：让完整矩阵能在一个还不在 allowlist 上的版本上跑起来。

它只放宽**一个**判定：`unsupported`（版本一致、只是还没被 allowlist 点名的树——升级车道唯一会探测的形状）。`mixed` 与 `incomplete` 在 `enforce` 和 `warn` 下**都**拒绝。

如果你在本地遇到门禁拒绝，**不要**用它绕过去继续开发。正确做法是确认宿主/`node_modules` 是否真的在 allowlist 上（`pnpm compat:check`）。只有在你确实在做"提升一个新上游版本"这件事时才用它，流程写在[故障排查条目](../../docs/troubleshooting/unsupported-dsh-release.md)。

`upgrade.yml` 设置它，CI 主车道不设置，`tests/workflows.spec.ts` 钉住了这条分界。

## 6. 升级车道不会自动扩大支持矩阵

`upgrade.yml` 按周跑，权限是 `contents: read`，不提交不推送，也不碰 `SUPPORTED_DSH_RELEASES`。绿灯是**证据**，不是授权。提升版本是人工动作。

`compat:check` **不**在升级车道里跑：候选版本按设计就不在 allowlist 上。如果你往那个 workflow 里加 `run: pnpm compat:check`，`tests/workflows.spec.ts` 会失败。

升级/探测用：

```bash
node scripts/upgrade-dsh.mjs 0.1.7-alpha.1          # 重指 pin
node scripts/upgrade-dsh.mjs --latest-prerelease     # 指向最新 pre-release
node scripts/upgrade-dsh.mjs --print-latest-prerelease
node scripts/upgrade-dsh.mjs --print-installed       # 实际解析到的版本
pnpm install --no-frozen-lockfile --config.minimumReleaseAge=0
git checkout -- package.json pnpm-workspace.yaml pnpm-lock.yaml   # 回退
pnpm install --frozen-lockfile                                     # node_modules 也回基线
```

安装候选版本时**必须**加 `--config.minimumReleaseAge=0`。否则 pnpm 会因为 release-age 门禁把整棵新树往 `pnpm-workspace.yaml` 的 `minimumReleaseAgeExclude` 里追加两百多行——那是一次性探测不该留下的东西。

`0.1.7-alpha.1` 的 `dsh` 依赖 cordis `^4.0.3`；`0.1.7-alpha.2`、`0.1.7-rc.1` 与 `0.1.7-rc.2` 依赖 `~4.0.4`。`upgrade-dsh.mjs` 会把 `@deepseek-ai/cordis` 的开发 pin 和 `pnpm-workspace.yaml` 里那一行 release-age 改到这个范围中的精确版本。不要在同一棵树里留下 `4.0.2`：pnpm 会拆出两份 `@deepseek-ai/dsh-tools`，agent-loop 持有的 `TOOL_RUNTIME_SCHEDULER` 是模块局部 `Symbol`，对不上另一份构造的 ToolRuntime，工具调用在第一步抛 `Cannot read properties of undefined (reading 'prepare')`。回基线时 cordis 随开发 pin 回到 `4.0.2`。

两个只在本地咬人的坑（CI 每次都是干净 checkout，碰不到）：

- **那句 `git checkout` 会把三个文件整体退回 HEAD**，连同你对它们的未提交修改。在脏的 manifest 上跑探测之前先提交或 stash。
- 候选版本装上之后，`pnpm <script>` 的**依赖自检**会因为同一个 release-age 门禁判定"依赖不同步"并触发一次重装，而那次重装同样会失败，把 `node_modules` 撕成半截（`.bin` 消失、`.package-map.json` 只剩一条）。这时 `pnpm install` 会说 "Already up to date" 却修不好，唯一出路是 `rm -rf node_modules` 重装。要避免它，探测期间绕开 pnpm 的脚本包装，直接用 `PATH="$PWD/node_modules/.bin:$PATH"` 跑 `oxlint` / `tsc` / `vitest` / `node scripts/*.mjs`。

**混树坑（2026-10-28 踩实）**：重指旧版本时，committed lockfile 里已有的 alpha 行 cordis 生态包会被 pnpm 优先沿用——`dsh-app-boot` 的 `cordis-plugin-loader` / `-group` / `-include` peer 范围同时接纳稳定版与 alpha，`rc.3` 树上的 `0.2.1` 运行时曾跑到 `1.0.7-alpha.1` 的 loader 上，Settings 的 volatile 写够不到 live Config（`tests/skills-settings.spec.ts` 的 enabled 断言静默留在 `true`）。`upgrade-dsh.mjs` 现在除了 DSH/cordis pin，还会从目标版本自身的 `dsh` / `dsh-app-boot` / `cordis` / `dsh-sandbox-local` manifest 推导 `cordis-plugin-*`、`schemastery`、`cosmokit`、`node-addon-system` 的精确版本，写进同一个临时 `overrides` 块，并同步重指这些包留在 `devDependencies` 里的开发 pin；跨预发行线回退旧版本后，务必确认解析出的 loader/group/include 是该版本自带的稳定版再下结论。

## 7. journey smoke 的模型端点同时说两套 wire 协议

`0.1.6-alpha.1` 把默认 LLM 协议从 chat-completions 换成了 Messages：

```text
0.1.5-rc.2     POST {base}/chat/completions    choices[].delta，finish_reason
0.1.6-alpha.1  POST {base}/v1/messages         message_start / content_block_* / message_delta / message_stop
0.1.6-alpha.2  与 0.1.6-alpha.1 相同（journey 55/55，端点未改）
0.1.7-alpha.1  与 0.1.6-alpha.1 相同（journey 55/55，仍是 `/v1/messages`）
0.1.7-alpha.2  与 0.1.7-alpha.1 相同（journey 55/55）
0.1.7-rc.1     与 0.1.7-alpha.1 相同（journey 55/55）
0.1.7-rc.2     与 0.1.7-rc.1 相同（`/v1/messages` 未改；未声明 `toolUpdate` 的路由会剥掉 developer 消息）
```

这个变化不经过插件代码，但会打断 `scripts/smoke-journey.mjs` 的脚本化端点。它现在**按请求路径**选择应答协议，两个构造函数分别是 `chatCompletionFrames()` 与 `messagesFrames()`。

同一处还有一个曾经踩过的坑：**不要用"请求体里是否含 title 提示词"来判断哪个请求是 agent step**。某些版本会把整个 session log 随每个请求一起发送，于是所有请求都被判成 title、agent 一步都不跑、而 smoke 报出的却是二十多条"模型没看到附加根"之类的下游失败。现在的判据是**请求是否提供 tools**。

调试模型看到了什么：

```bash
DSH_SMOKE_KEEP=1 pnpm smoke:journey
# 结束后读 .dsh-smoke/journey-<pid>/model-requests.json
```

## 8. 一条命令跑完整矩阵

```bash
pnpm verify:all   # lint → typecheck → build → test → kernel:probe → smoke
```

它**故意不含** `compat:check`，因为升级车道要在未列入的版本上跑它。CI 主车道单独跑 `compat:check`（在 lint 之前）。

## 9. DSH 0.2 与新的开发基线

写本节时开发 pin 是 `0.2.0-rc.2`，cordis 是 `4.0.4`（当前基线见 §1）。回到开发基线不再表示回到 `0.1.5-rc.2` / `4.0.2`；前文的旧版探测记录是历史事实。恢复探测前保存的 manifest / workspace / lockfile，并重装安装树，绝不把未提交的支持声明退回 HEAD。

`0.2.0-rc.1` / `rc.2` 保留了现有适配器的接缝。0.2 的 agent-loop 异常恢复会在关闭 step 前补保守的失败 `tool/result`：`message.isError: true`、纯文本 content，并带 `data.error`。它绝不能算成功文件 touch；`tests/instructions.spec.ts` 同时钉住旧 content block、新 message 与恢复事件三种失败形状。Windows 新增 ACL diagnosis skill 由继承的上游 provider 自动软注册，本插件仍不承诺 Windows 内核多根授权。风险与各版验证证据见[路线图记录](../../docs/plans/active/2026-09-12-multi-root-workspace.md#dsh-02-兼容提升2026-09-30)。

CI 用 `scripts/list-dsh-releases.mjs` 从 allowlist 直接读取版本轴，所有支持版本都跑所有启用的 OS，主车道始终 enforce。`pnpm-workspace.yaml` 对开发版本的传递 DSH 包与 LibreOffice host tooling 逐项使用精确发布年龄豁免：pnpm 11 不接受带版本的包名通配模式，而且运行脚本前也会校验整棵锁文件。安装候选仍使用 `--config.minimumReleaseAge=0`，临时 pin 与临时豁免必须恢复。

候选重指脚本还从这些 DSH 条目派生一个 workspace-only 的 DSH / cordis `overrides` 块，确保旧版的宽预发布范围不会在 runtime resolution 下变成混装；已有自定义 overrides 时脚本拒绝覆盖。这个块是探测产物，不随插件发布，探测结束恢复保存的 workspace 文件。

Windows 的 Node 不能直接 `execFileSync('npm')` 启动 `npm.cmd`，旧版矩阵会在重指前报 `spawnSync npm ENOENT`。升级脚本统一走 `scripts/lib/npm-cli.mjs`：Windows 用当前 Node 执行其安装目录的 `node_modules/npm/bin/npm-cli.js`，POSIX 继续直接执行 npm；不拼 shell 命令，带空格的路径与参数边界由回归测试覆盖。

## 10. B1–B3 的新接缝

LSP / workspace-files 只包装公开方法，卸载必须恢复原属性描述符；不要比较 Cordis 代理函数的引用。旧版 `changes(scope, signal)` 与新版 `changes(scope, path, signal)` 由 `src/compat/workspace-files.ts` 按 arity 适配。读面 `stat`/`read`/`readBytes` 同样被包装——上游对它们不做 workspace 围限，边界由 `routeWorkspacePath` + `registry.list()` 的「在册未授权」词法检查补齐（拒绝用 `workspace-file/outside-workspace`）；`readBytes` 第三参跨版本形态不同（`WorkspaceByteRange` ↔ `WorkspaceByteReadOptions`），wrapper 保留 range 与其余选项，只在路由时改写 `baseFile`，关联尾路径语义见 [ADR-0011 的读面修订](../../docs/decisions/ADR-0011-multi-root-workspace-consumers.md#修订面板-files--readfile-端点下线2026-10-12amendment)。Windows 非空 scope 的 runner 必须用整个根集合的 SID，不能把主根 SID 授予附加根，否则移除后仍可写。可选 peer 均纳入混装检查，carrier barrel 不得静态加载这些可选包。混装检查的"证词"按谁真正加载解析到的副本来分（`src/compat/dsh-version.ts`）：`RUNTIME_OPTIONAL_PACKAGES` 是本插件自己动态 `import()` 的（`dsh-agent-instructions` / `dsh-llm` / `dsh-session` / `dsh-typert-protocol`），私有副本真的会执行，任何位置的命中都作证；`HOST_SERVICE_PACKAGES` 只作为宿主挂载的服务或类型被消费，落在**本插件目录内**的副本永远不可能执行——`link:` 安装的检出会把 `dsh-lsp` / `dsh-lsp-stdio` / `dsh-working-directory` 解析到自己的 devDependencies，不剔除就会把一个版本统一的宿主幻影判成 `mixed`。宿主锚点回退（经 `@deepseek-ai/dsh` 的 package.json）只对这些宿主服务包开放，且同样受插件根边界约束。还有第三类 `RUNNER_ANCHORED_PACKAGES`：`dsh-sandbox-windows-acl` 由独立 runner 进程经 `profile.upstreamRunner` 自引用加载，执行副本是已安装 `dsh-sandbox-local` 树里的兄弟副本——只从该锚点取证，锚点解析不到即缺席（runner 同样加载不到），命中一律作证（锚点即执行链，含插件根内命中）；自解析与 dsh 宿主锚点都不反映这里的执行情况。新增可选包时必须按"谁会加载这份副本、经哪个锚点"归入其一，不要混进另一个列表。完整决策见 [ADR-0011](../../docs/decisions/ADR-0011-multi-root-workspace-consumers.md)，各平台验证状态只见[路线账本](../../docs/plans/active/2026-09-12-multi-root-workspace.md#b1b3第二期-p12026-10-02)。

## 11. DSH 0.2.1 目录语义

当前开发基线为 `0.2.2-rc.2` / Cordis `4.1.0`。前述开发 pin 是历史记录。Registry 身份和 grants 始终绑定不可变的 Session 原始项目；effective cwd 使用上游 workingDirectory，不能按共享目录反查会话。LSP 从工具 dispatch 携带 Session，instructions 优先捕获成功 fs observation 的实际路径。精确候选与原生平台执行证据只见[路线账本](../../docs/plans/active/2026-09-12-multi-root-workspace.md)，目录与进程快照设计见 [ADR-0012](../../docs/decisions/ADR-0012-session-origin-and-effective-cwd.md)，上游差异见[接口审查](../../docs/reference/dsh-0.2.1-migration.md)。

升级脚本接受单一 Cordis prerelease 版本，仍输出精确 pin。新的安装期 peer gate 需要在隔离候选 smoke profile 使用精确 allow-version 豁免；warn 模式下豁免在第一次 `add` 前授予（构建审批恢复路径内部的 remove+add 同样有版本 gate），只用于升级车道，正式矩阵和生产仍 enforce。当前 package 为 `0.1.6` 且 `v0.1.6` tag 已存在，本迁移不创建 release。

`0.2.1-alpha.3` 起 `dsh-storage-domain` 把 `zod` 从 `^4.4.3` 钉死为 `4.4.3`，与本包浮动的 `^4.6.x` 分裂成两个解析副本；zod v4 按构建 minor 打类型标记，`domainTable` 声明的 `ZodType` 只认它自己那一份。域 schema（`src/registry.ts` 的 `persistedRoot` / `persistedPrimaryRoot`）必须由 `src/compat/storage-zod.ts` 构建——它从 storage-domain 的解析路径取 zod，值与边界类型永远同源。不许回退到包级 `import { z } from 'zod'` 构建域 schema，也不许把本包 zod pin 到上游版本（旧支持版本的 `^4.4.3` 会把分裂移到另一侧）。本包 `zod` 仍用于 `src/contract.ts` 的面板 wire schema——那是本插件自有边界，与上游类型无关。`alpha.4` 起上游安装门禁优先 `engines.dsh`、回退 `peerDependencies`；本插件仍以 peers 为唯一版本契约，不引入第二处版本列表。

## 12. 浏览器侧的上游 DOM 钩子（升版目检）

`src/client/` 里有两处**不是槽位契约**的上游结构依赖，结构探测管不到它们，只能靠目检：

| 依赖 | 消费方 | 失效表现 |
| --- | --- | --- |
| `FilesBody` 扁平 flex header + flex 项上的 `data-files-root` / `data-files-path` / `data-files-reload` | `styles.ts` 的 `:has()` 规则（`.mrfw-rootSwitcher` 接管路径标签位置、隐藏 `[data-files-path]`——选择器自带 `PathLabel`（`.mrfw-switcherPath`）显示选中根完整路径、自带 `.mrfw-switcherReload` 在附加根态顶替原生 reload；`[data-root-kind="additional"]` 时隐藏 `[data-files-body]` 与 `[data-files-reload]`） | 规则停止匹配：上游路径标签恢复显示、与选择器自带 PathLabel 并存（路径出现两次），选择器退回槽内默认位序，仅剩菜单可用——静默退化，功能不坏 |
| `closest('[data-files-root]')` 命中本 pane | `RootSwitcher.tsx` 的 portal 目标查找 | 找不到祖先即不渲染复刻树，切附加根只改菜单态；原生布局不受影响 |
| dockkit tabHost 上的 `data-dockkit-content`（值为 tab id） | `RootSwitcher.tsx` 的复刻树 store bucket 键（scroll/展开态记忆） | 属性缺席时退回生成 id——功能不受影响，只是滚动/展开记忆跨接管不保留；属性若改名或挪位，bucket 键与原生 tab 失配 |
| `ui-open-in-app` 分离按钮锚点上的 `data-open-target="directory"` | 附加根态的隐藏规则（`:not(.mrfw-openSplit)` 保住复刻按钮自身） | 属性改名/移除 → 原生按钮在附加根态露出、点击仍开主根（旧 bug 回归）；选择器失效只影响隐藏，不碰功能 |
| `sidebar.right.tab.document.actions` 槽（0.2.2-alpha.3 起 `documentpreview` 声明） | `navigator.tsx` 预览导航接管的挂载位，owner `absolutePath` 是被预览文件的宿主路径 | 宿主不声明该槽 → `slots.inject` 不注册，预览导航全程原生（该导航器本来就不存在）；槽在但 owner 字段改名 → occupant 拿不到路径、零渲染，原生树不受影响 |
| 预览根上的 `data-textpreview-url`（tab contentId）与内容行上的 `data-textpreview-content` | `navigator.tsx` 的预览定位、跨会话校验（`parseFileAddress` 必须解析出本会话的 session-scope 地址）与 aside 观察范围 | 钩子缺席/改名 → 找不到预览或会话校验不通过，永不接管——原生导航树零影响 |
| `aside[data-files-navigator]`（值为 dockkit pane id）与其内 `[data-files-body]` | `navigator.tsx` 的接管目标与 pane 记账键；`styles.ts` 的 `aside[data-mrfw-navigator] > [data-files-body]` 隐藏规则 | aside 不出现 → 永不接管（该导航器未开）；属性值不再是 pane id → bucket/快照改键、跨 `replaceTab` 的展开/滚动记忆丢失但功能不坏 |
| dockkit 的 pane 载体：非空 pane 的 id 骑在其**选中 tab 的 host**（`data-dockkit-pane`）上、空 pane 由 `TabPanel` 携带、浮动 pane 用 `data-dockkit-float`——pane 本体**没有**稳定元素 | `navigator.tsx` 的 pane 死亡观察是查询式的（文档中仍有携带该 id 的元素即存活），death-watch 独立于 takeover 生命周期、cleanup 永远赢不了它的竞速 | 载体属性的拼写/归属改变 → 存活判定失真：误报死会让快照提前丢弃（记忆降级、功能不坏）；误报活则快照留到会话结束 |

⚠️ `data-files-path` 有**双重含义**：表头 `PathLabel` 携带裸值（`"true"`），而**每个树行**（`data-files-entry` 的 `li`）也携带它、值是该行自己的绝对路径。任何想命中表头标签的选择器都必须写 `[data-files-path]:not([data-files-entry])`——不带限定符的 `display:none`/`order` 会作用到整棵原生树（曾真实发生：主根树区全空）。其余三个钩子（`root`/`body`/`reload`）各只出现一次。

提升上游版本时（升级车道跑完、人工验收阶段）必须目检三态：无附加根时 Files 页签是原生观感；选中一个附加根时树区换成逐字节复刻的原生 Files 树（行高/图标/缩进/空态/截断/失败行应与原生逐项一致）、原生 reload 由 header 内的同款 `.mrfw-switcherReload` 顶替、原生 open-in-app 按钮由复刻按钮顶替（点开 chevron 菜单应与原生同款）；切回主根时原生树、reload 与 open-in-app 完整还原。预览侧 Folder 导航器另有四态：预览附加根文件时打开 Folder → 树以该附加根为根、祖先已展开、当前文件高亮在视口内、从树里打开文件替换当前预览 tab 且树仍挂在新 tab 的 pane 上；预览主根文件时原生导航树原样（根=cwd）；折叠再展开 Folder 时展开/滚动位置回到离开时的样子，且直接画出保留的行、不闪 loading；同一预览 pane 从 A 附加根切到 B 再切回 A → A 的折叠与滚动位置各自恢复、B 的地址没有写进 A 的 `revealed`（两端记忆互不串写）。任一项失真先查这五个 `data-*` 属性还在不在对应 flex 项上（`.header` / `.body` 的 class 是 CSS-module hash，不能锚）。退化症状与修法见 [故障排查条目](../../docs/troubleshooting/files-switcher-degraded.md)，决策见 [ADR-0015](../../docs/decisions/ADR-0015-files-tab-plugin-owned-browsing.md)。

**files-tree 旧版复刻面**：`src/client/files-tree/` 保留旧宿主使用的上游 `ui-sidebar-files` 树体逐字节 fork（基线 `f3803c9697` = `0.2.2-alpha.2`；清单、shim 对照、外壳 delta 与同步步骤见该目录 `FORK.md`）。变更旧版基线时按 FORK.md 重拷并对照——`directory-node.ts`/`store.ts`/`FilesBody.module.css` 与 `FilesBody.tsx` 的行级定义必须字节级一致；`face.ts` 带 hold/release 生命周期 delta（`start`/record-abort 重播或丢弃 bucket，`hold`/`release` 让 Folder 关闭只关节点/watch、保留已列 levels），其余部分保持字节级。许可差异有：外壳函数根源改写、css specifier 的 `.ts` 后缀、文件行的 reveal 标记（`Entry` 按钮上的 `ref`/`data-files-current`/`aria-current` 与 `TreeContext` 的 `current`/`currentRef`）、`reveal`/`saved`/`onScrollOffset` 三个 prop 及其外壳逻辑、body 的 `tabIndex` 与原生 `scroll` 监听（portal 外的事件委托到不了，必须用元素自身监听）；同时检查上游 `locales.ts` 的 `zh` 键集（shim 的 `SidebarFilesKey` 联合须同步）、`workspaceFiles` remote 面与 `data-dockkit-content` 钩子。复刻体类名 `mrfw-ft*`、不携带 `data-files-root`/`data-files-body`（防本插件 `:has()` 隐藏规则误伤）； primitives 探针失败时整棵复刻树不渲染（同型降级，不崩）。**remote 面只能经 `ctx.get` 懒解析**：`remote.workspaceFiles` 是 cordis 嵌套服务，context 代理路径（`remote.workspaceFiles` 或 `ctx['remote.workspaceFiles']`）受 inject 守卫（未声明 fiber 直接抛 `without inject`），而本版 cordis 的 inject 条目全 required（声明会把整行 gate 在可选服务上）——`lazyFilesRemote` 用 `ctx.get('remote')`/`ctx.get('remote.workspaceFiles')` 免守卫直查 store，一切查找失败折叠成 `gateway/internal` 失败行（verbatim `load` 的 `.then` 无 `.catch`，逃逸 rejection 会静默钉死 loading）。**编译面同理钉在 dev-pin**：`0.2.0-rc.2` 之前 `workspaceFiles.changes` 是 2 参（session 级 watch），`tsconfig.client.json` 的 `paths` 把 `@deepseek-ai/dsh-api-remotes/client` 映射到 `client-remote.d.ts`（本地声明拼的是 path-watch 时代的 3 参签名），让 verbatim `face.ts` 在矩阵旧版本上也能过 typecheck——安全前提是 `files.actions` 槽位在旧版不存在、调用永不会执行。

**open-in-app 复刻面**：`src/client/open-in-app/` 是上游 `ui-open-in-app` client 包的逐字节 fork（基线 `ddac96760b` = `0.2.2-rc.2`；清单、shim 对照与同步步骤见该目录 `FORK.md`）。升版时按 FORK.md 重拷并对照——许可差异只有 `OpenTargetButton.tsx` 里 css specifier 的 `.ts` 后缀与 `open-toast.tsx` 的两行（丢 layout 副作用导入、`isMobileDevice` 改从 `./device.ts` 导入——它 re-export `src/compat/open-in-app-device.ts` 的探测 shim）；同时检查上游 `locales.ts` 的 `zh` 键集是否新增（shim 的 `OpenInAppKey` 联合须同步）、`shared.ts` 路由常量是否变化（devDep 版本即出处记录）、`OpenInAppActionInjected` 的 hook 名是否漂移。复刻组件拼写 `*Regular` 图标族：0.1.5/0.1.6 像素名运行时不建 adapter、不渲染按钮（同型降级，不崩）。

## 13. B9 进程栅栏接缝（Full-access bypass）

全部 19 个支持版本的四个进程面在 `danger-full-access` 下都绕过 `ctx.sandbox.confine()`：bash/pwsh executor 的 `execute`（`0.1.5/0.1.6` 还有 `start`）、`dsh-terminal-bash` 模块私有 `spawnArgv`、`dsh-ptc-runtime-node`（run_code）。subprocess spec 不携带 `sandboxPolicy`，无法在下层恢复授权意图——`multi-root-process-fence` 行用 `AsyncLocalStorage` 注入 deny 上下文：包装 `ctx.shell.execute`（旧版 `run` / `start`）/`ctx.ptcRuntime.run` 置上下文，`ctx.subprocess.spawn` 见到上下文才重写 argv。PTY 的可达接缝只有共享的 `ctx.subprocess.spawnTerminal`（`persistent-shell` 组 `isolate: terminals`，组内 backend 不可达），会话从 `env.DSH_SESSION_ID` 恢复（`Agent.enter` 强制 `agent.id === session.id`）再 `sandboxPolicy.resolve({session})`；会话不可解析且存在显式只读根时 fail closed。受限 prefix 不私有调 runner：以 read-only policy 探 `super.confine(['true'])` 拆出 profile 骨架，再 `restrictProfileArgs` 变换（保同步/异步形状）。决策见 [ADR-0017](../../docs/decisions/ADR-0017-three-state-root-access-and-sandbox-modes.md)，测试见 `tests/process-fence.spec.ts`。

PTC 的具体实现 `execute` 是 private；包装公开 `run`。Windows 宽字符串指针用 `koffi.decode(ptr, 'char16_t', -1)` 解码指向的数据，不能用 `str16`（那会再解引用一次，把字符串头当地址并原生崩溃）。旧属性候选的 TokenSecurityAttributes 查询采用 native UNICODE_STRING，不能与 Win32 claim 的 PWSTR 布局混用。runner 从 broker 接收 token handle，再读回派生 token 的普通 TokenGroups，确认每根 deny-only 且非 enabled；不能信任 broker ACK。普通 deny-only 组与可取交集删除的 restricting SID list 是两个列表；安装与安全边界链接 ADR-0020，不在本笔记复制进度。

PTY 的 agent/用户判别是 §13 唯一的静默 fail-open 接缝：`DSH_PTY_SESSION_ID` 只由 agent PTY 的启动路径盖章（面板终端控制器只盖 `DSH_SESSION_ID`），下游 release 一旦不再盖章，agent PTY 会被当作用户终端直通放行。`src/compat/pty-marker.ts` 在启动时探测已安装 `@deepseek-ai/dsh-terminal-bash` 的构建产物里有没有这个常量——探的是产物内容，不是版本号也不是 in-process shape（远端打包/裁剪后的构建不执行本机代码也能验证）。后端不存在 = 无 PTY 接缝、放行；存在但探不到 = 启动拒载，`DSH_MULTI_ROOT_COMPAT=warn` 也放宽不了（warn 只放行「未列名但自洽的候选版本」，不放行「合同已经破裂」）。测试在 `tests/pty-marker.spec.ts`。

旧版 Windows process binding 的 `GetFileType` 可能缺失；fd 7 适配必须通过公开 `extendWin32ProcessBindings` 补齐，不能依赖开发 pin 的表形状。

## 14. DSH 0.2.2 接缝与安静陷阱

`0.2.2-alpha.2` 是一次 2000+ commit 的大跨越（rc.4 之后无 alpha.1 标签）。插件源码不需要适配，但测试与宿主组合有几处必须知道的变化：

- **AgentRegistry 新增 `static inject = ['sessionProjections']`**：任何测试栈在 `ctx.plugin(AgentRegistry)` 之前必须先挂 `SessionProjectionRegistry`，否则 `ctx.agents` 静默为 `undefined`，首个 `ctx.agents.enter()` 报 `Cannot read properties of undefined (reading 'enter')`——fixture 缺口，不是插件缺陷。`sessionProjections.register()` 改为 async 且返回 handle；`registry.stateOf(session,key)` 已废弃。
- **工具执行拆出 `dsh-tools`**：执行器是独立行（`dsh-tool-executor-native` / `-ptc`），`ctx.tools.execute` 收批量 `calls` 输入；`@deepseek-ai/dsh-tools/pipeline` 子路径只在 0.2.2 起存在。测试侧的统一处理是 `tests/support/tool-executor.ts`：`ctx.tools.setExecutor` 存在才动态挂上等价分发器，调用按批量/单发两种形态分发。**注意**：`import('@deepseek-ai/dsh-tools/pipeline')` 这类字面动态导入会被 Vite 在转换期解析，在旧版本上直接炸整份 spec——动态导入的 specifier 必须在运行时才拼得出——即 `import()` 的实参写成模板字符串拼接，而不是一段完整字面量。
- **Sandbox 原生第三路可写根**：`SandboxExecutionPolicy.additionalWritableRoots` + `workspaceWritableRoots`（policy service 配置键 `sandboxPolicy.additionalWritableRoots`）由 Seatbelt/bwrap/Landlock/fs-sandbox 原生消费；windows-acl 以 `SandboxUnsupportedPolicyError` 拒绝。本插件不设该字段，宽授权照旧来自自身 scope；两路 grant 的复合由 `tests/upstream-additional-roots.spec.ts` 钉住（旧版本按 `workspaceWritableRoots` 导出存在性结构性跳过）。
- **Session/store**：store 持有的 Session 在 `session/created` 完成前拒绝 append——插件测试用独立 Session，不受影响。`dsh-storage-domain` 新增 `deleteRecords`/`deleteMany` 与 `unknown-state` 隔离，均为新增面。
- **Node ≥24.9**：0.2.2 起的 lanes 需要 Node 24；CI verify 按已知旧版前缀走 22.19.0、其余走 24.9.0。
- **Auto Review 不动**：上游实验性 auto-review 在 0.2.2 有变化（每条历史一条请求消息、AutoReviewFailedError、卸载规则），但可选 fork 仍钉死 `0.2.1-rc.2` 基线，`AUTO_REVIEW_RELEASE` 不随开发 pin 走。
- **上游 Skills 语义微调**：filesystem provider 把失败根报为 incomplete observation、tool-skill 发布 incomplete catalog；本插件的多根 skills provider 仍把嵌套 observation 当普通候选、忽略 `complete:false`——行为不变，记为已知后续观察点。


## 15. DSH 0.2.2-alpha.3 接缝

上游新增 patch、delete 和双端 move：不能直接继承而绕过围栏。结构适配器只在后端具备方法时安装包装，move 两端共享一次 Registry admission。Cordis 的 getter 追踪也改变，Connection 适配器将公开 RPC getter 绑定到消费 fiber。新版 Files 页面使用宿主文件树 Factory，旧界面保留 alpha.2 复刻树。见[接口审查](../../docs/reference/dsh-0.2.2-migration.md#022-alpha3-后续审查2026-11-04)和各 fork 的同步步骤。

升级探测遇到 vendor 预发布范围时取声明的精确基线，即使 npm 同范围还返回更新的预发布版本。alpha.1 Cordis 混入 alpha.2 loader 会破坏旧宿主；alpha.3 阶段的稳定版范围仍取最高匹配版本（已由 §16 修订）。

## 16. DSH 0.2.2-rc.1 转稳定生态

rc.1 相对 alpha.3 的 patch 只改包版本。沿用既有适配器，保留旧宿主所需的具名 prerelease peer 分支；稳定 peer 范围已覆盖 Cordis 4.1.0 / Schemastery 3.19.0。开发树须整体重指，提交前移除临时 probe overrides。稳定版 vendor 范围只能取声明 minor 线内的最新稳定 patch（prerelease 仍钉精确基线）：旧 loader peer `^1.0.3` 会接纳新发布的 `1.1.0`，却在 Cordis `4.0.2` 的 `fiber.entry` 处崩溃。升级 helper 现在对未发布基线或复合范围拒绝猜测，不跨入新的 vendor minor 或把 prerelease 混入稳定线。详见[接口审查](../../docs/reference/dsh-0.2.2-migration.md#022-rc1-后续审查2026-11-05)；执行证据仍在路线账本，可选 Auto Review 仍钉 0.2.1-rc.2。

## 13. 新会话 Hero 入口（`conversation.hero.options`）

`conversation.hero.options` 是 `list` / `session` 槽，`0.2.1-alpha.3` 起由 `ui-conversation` 声明（commit `3f1d5dfcfa`），渲染在 blank session 工作区行的 workspace / 模式选择器之后；`.heroOptions` 自带 `margin-left: auto`，条目组落在整行右端。本插件在其中注册 `multi-root-folders.hero`（order 10，无 `label`），occupant 直接使用 composed `sessionId` 并 memoize 成稳定回调，与侧栏 `sidebar.footer.action` 共用 `WorkspaceFoldersDialog`、RPC、错误码与文案。槽是 `list`，outlet 以 `display: contents` 挂在 `.heroOptions` 内，本入口不 grow/不绝对定位/不占满宽度，不会独占该槽；当前组合只有本入口是安装事实。

- **可用版本**：`0.2.1-alpha.3` 及更新；`0.1.5-rc.2` ～ `0.2.1-alpha.2` 没有该槽。
- **缺席行为**：`ctx.slots.inject` 静默不触发，新会话页没有该入口；侧栏入口、host 侧、RPC 与授权语义全部不变。
- **依赖形态**：**不依赖** `ui-conversation`（不 import 类型、不加 devDependency、不进 `dsh.client.inject`）。typecheck 矩阵包含 `0.2.1-alpha.3` 之前的版本，它们的 SlotMap 没有该键；注册走窄结构接口（`inject` + `spec` + `register`），`spec` 查不到声明就直接返回空 disposer。只有声明了该槽的版本会注册并显示入口；旧版本不显示，侧栏入口不受影响。
- **用公开的 `spec` 探测，不要用 `specDynamic`**：`specDynamic` 只存在于 `SlotCore`，`ctx.slots`（`SlotRegistry` 服务）只公开 `spec`、`entries` 等方法。测试替身必须使用真实 `SlotRegistry`，否则会把不存在的服务方法伪装成可用；`tests/client-slot-probe.spec.ts` 通过浏览器模块加载器实例化真实服务并声明槽位。
- **会话权威**：槽是 `session` scope，composed props 的 `sessionId` 是确定值；不要在 hero occupant 里回退到全局 current-session 解析（侧栏 fallback 是另一条路径）。
- **形态约束**：与相邻 workspace / 模式选择器同几何，但因打开对话框而非菜单**没有 chevron**；图标优先 `IconWorkspaceTreeOutlineRegular`，旧运行时经 `selectIconOr` 回退 `IconFolderOpen`（不使用像素时代名）；文字在左、icon 在右，以贴合该行右对齐的阅读顺序；trigger 另加 `margin-right: 4px`，因为上游行 padding 是 `0 16px 0 20px`，这样按钮盒与工作区选择器一样内缩 20px。hero 行没有容器祖先，`≤560px` 用视口媒体查询退化为 28×28 图标按钮。上游若改成容器查询，再同步切换。
- **无 DOM 钩子**：入口只依赖槽位契约；上游改名或移除该槽时按上面的缺席路径静默退化，不需要目检表更新。

## 17. DSH 0.2.2-rc.2 支持与发布

- **状态**：上游 tag `dsh-v0.2.2-rc.2` 指向 `ddac96760b`，npm 已发布（`next` 指向该版本，`latest` 仍为 `0.2.2-rc.1`）。本分支已把 `SUPPORTED_DSH_RELEASES`、全部 DSH peer 与开发 pin 提升到 `0.2.2-rc.2`（23 个精确版本），并用 `scripts/upgrade-dsh.mjs 0.2.2-rc.2` 整体重指开发树；临时 probe overrides 已移除，新增的 10 个传递包（`dsh-agent-team`、`dsh-client-ui-account-notifications`、`dsh-client-ui-agent-team`、`dsh-error`、`dsh-mcp-manager`、`dsh-office-kit`、`dsh-terminal-panel`、`dsh-tool-agent-team`、`dsh-tool-office`、`dsh-util-ripgrep`）已补 `minimumReleaseAgeExclude`，否则 frozen install 会被发布年龄门禁拒绝。
- **新增接缝**：`dsh-sandbox` 用 `SandboxPreparationError` / `SandboxEscalationError` 取代未编码错误，Windows ACL 不再因额外根报错而是进程侧忽略；`SandboxPolicyService.registerWritableRoot` 让 Session 把目录并入 `resolve()` 的额外根；`workspaceFiles.search` 用打包 rg 经 `ctx.subprocess` 搜索；`dsh-error` 成为 `HarnessError` 的新共享基类；`dsh-subprocess` 与 `working-directory` 改为编码错误，后者新增 `working-directory/access` waterfall。插件均按结构消费，未新增版本判断。
- **安静陷阱 1（Windows ACL 语义翻转）**：上游在 Windows 进程侧**忽略** `additionalWritableRoots`，只让文件工具执行；插件自己 scope 根的进程授予仍来自 `widenWindowsProfile` 拼进的 ACE 参数，两者不可混为一谈。`tests/upstream-additional-roots.spec.ts` 的 per-Session 小节钉住“原生注册根可被 fs fence 写入、scope read-only deny 仍胜出”。
- **安静陷阱 2（authority 降级优先）**：`registerWritableRoot` 的根随 policy 进入 `writableRoots()` 与 POSIX profile，但插件在 authority unavailable 时仍只保留主根与显式 deny；不要把“上游已授权”当作可用 authority 的证据。
- **安静陷阱 3（搜索根）**：`workspaceFiles.search` 做共享 authority 的 admission，不做事先的多根路由——搜索根是 Session cwd；但它和 `list`/`changes` 一样受**根级** withheld 检查：canonical 搜索根落在在册未授权边界下时在启动 `rg` 前拒绝。接管附加根时原生搜索条、状态行与 Files 页开关随原生 body 一起隐藏；primary 根浏览保持上游原样。
- **安静陷阱 4（fork 基线）**：rc.2 的 `ui-open-in-app` 复刻源只有两处注释变化并新增 `menu.openIn`；本分支已按 FORK.md 重拷 `OpenInAppAction.tsx` / `controller.ts`、把 baseline 移到 `ddac96760b`，并在 `OpenInAppKey` 补 `menu.openIn`。files-tree 旧版复刻仍钉 alpha.2。
- **契约检查**：`@deepseek-ai/dsh-error` 已加入 `OPTIONAL_CORE_PACKAGES` 与 `HOST_SERVICE_PACKAGES`（只经宿主锚点作证，发现跨包单例混装）；**不要**把它写进 `peerDependencies`——rc.1 没有该包，会让旧宿主安装失败。
- **验证（已发布包）**：在已发布的 `0.2.2-rc.2` 开发树上，`compat:check`、lint、双端 typecheck、`build`、`docs:check`、`pack:check` 与 `auto-review:fork` 通过；完整 vitest 为 **1368 通过 / 162 跳过 / 17 失败**。17 个失败全部是当前 Seatbelt 会话的 sandboxed-peer registry IPC 用例；rc.1 基线在同一环境同样失败 17 个（1364 / 166），不是 rc.2 回归。本机 `smoke:compose` **56/56**、`smoke:behavior` **96 通过 / 8 跳过**、`smoke:journey` **85 通过 / 2 跳过**、`smoke:packed` **95 通过 / 8 跳过**，均 0 失败（跳过项是 Seatbelt 内无可用内核 runner 与共享 IPC）。三 OS 矩阵与 Windows ACL 原生结果由 PR 的 CI 给出（[run 43213164748](https://github.com/cherrchen/dsh-plugin-multi-root-workspace/actions/runs/43213164748)，94/94 jobs）；浏览器目检不是 CI 项，按路线账本的人工记录。
