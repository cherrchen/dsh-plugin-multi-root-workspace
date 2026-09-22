# ADR-0009: DSH 兼容性从文档约定变成代码契约（显式 allowlist + 启动门禁 + 适配层）

## Status

Accepted

## Date

2026-09-15

## Context

M1–M3 完成后，本插件与上游的耦合关系已经写清楚了（[ADR-0002](./ADR-0002-upstream-coupling-policy.md)、[ADR-0003](./ADR-0003-dialect-grant-widening.md)），但这些约定只存在于**文档**里。`package.json` 对外声明的是：

```text
"@deepseek-ai/dsh-sandbox-local": ">=0.1.2-alpha.4 <0.2.0"
```

而代码真正被验证过的只有一个版本（`0.1.5-rc.2`）。两者的差距不是措辞问题，是安全问题：

1. **插件替换的是围栏本身**。`MultiRootFileSystem` 继承 `LocalFileSystem`，`MultiRootSandboxProvider` 继承 `LocalSandboxProvider`，并且 `src/dialects.ts` 是**靠观测 `super.confine` 产出的 argv 形状**来识别 Seatbelt / bwrap / Landlock profile 并克隆 grant 拼法的（ADR-0003）。上游对这些形状没有任何 semver 承诺。
2. **一个未验证的上游版本上，失败方式是“静默放宽”**。如果 argv 形状变了而识别逻辑没跟上，最坏情况不是崩溃，而是 additional root 被授予了一个语义不同的 profile。
3. **npm 范围是对尚不存在的版本做预测**。`<0.2.0` 承诺了所有未来 0.1.x 发布；这类预测对一个“靠识别内部形状工作”的插件是不成立的。

同时，上游已经发布 `0.1.6-alpha.1`，并且相对 `0.1.5-rc.2` 带来了三处影响本插件的接口变化：

| 变化 | `0.1.5-rc.2` | `0.1.6-alpha.1` |
| --- | --- | --- |
| `SandboxProvider.confine` | 同步，返回 `ConfinedArgv` | 异步，返回 `Promise<ConfinedArgv>`，并新增可选 `signal` |
| instruction renderer | `renderWorkspaceContext(...)` | `renderAgentInstructions(...)` |
| LLM wire 协议 | chat-completions（`POST {base}/chat/completions`） | Messages（`POST {base}/v1/messages`，`message_start` / `content_block_*` / `message_delta` / `message_stop` 事件流） |

其中前两项直接落在插件代码面上；第三项不经过插件，但会打断 `smoke:journey` 的脚本化模型端点——也就是打断“插件在真实 agent 回合里是否正确”的唯一证据来源。

此外还存在一类此前无法被发现的故障：**混装**。宿主是由多个 `@deepseek-ai/dsh-*` 包组合出来的，如果 `dsh-sandbox-local` 是 `0.1.5-rc.2` 而 `dsh-fs-local` 是 `0.1.6-alpha.1`，那么文件围栏和内核方言这两半就分别对着不同的上游语义工作。npm 范围恰好**允许**这种组合。

## Decision

### 1. 支持矩阵是精确版本 allowlist，不是范围

`src/compat/dsh-version.ts` 是支持矩阵的唯一真源：

```ts
export const SUPPORTED_DSH_RELEASES = ['0.1.5-rc.2', '0.1.6-alpha.1'] as const
```

`peerDependencies` 里每一个 `@deepseek-ai/dsh*` 包都声明为 allowlist 的逐项或：

```text
"0.1.5-rc.2 || 0.1.6-alpha.1"
```

允许多个版本同时在列，但不允许范围。往 allowlist 里加一项**永远是人工动作**，且只在该精确版本跑完完整矩阵之后进行。

### 2. `multi-root-compat` 是启动门禁，不只是一个诊断服务

`src/compat.ts` 是 patch 里的第一行。四个安全相关的 provider 行全部 inject `multiRootCompat`：

```text
multi-root-fs
multi-root-sandbox
multi-root-registry
multi-root-instructions
```

cordis 不会启动一个 injected service 缺失的行，所以判定结果直接决定它们是否运行：

```text
compat 通过  →  ctx.multiRootCompat 存在  →  四个 provider 启动
compat 失败  →  该行抛错               →  四个 provider 永不启动
```

因此这一行实现为普通 `apply` 而**不是**直接挂载的 `Service` 子类：`Service` 的构造函数里 `super(ctx, name)` 已经抢占了 service key，等它能检查任何东西时，门禁的意义已经没了。

失败时 `ctx.fs` / `ctx.sandbox` 保持为上游行（或不存在），组合退化成“未安装本插件”的形态，而不是“围栏可疑”的形态。

### 3. 混装是独立的、优先于版本判断的失败

`classifyInstallation()` 按固定顺序给出四种判定，先出现的胜：

| verdict | 含义 |
| --- | --- |
| `incomplete` | 必需包解析不到 |
| `mixed` | 已安装的核心包对不上同一个版本 |
| `unsupported` | 版本统一，但不在 allowlist 上 |
| `supported` | 版本统一且在 allowlist 上 |

顺序是必要的：缺包时没有版本可比，混装时没有“单一版本”可以去 allowlist 里查。可选包**缺失**是合法的（最小组合没有 agent），但可选包**版本不一致**同样判为 `mixed`。

### 4. 版本差异只允许存在于 `src/compat/`，并且用结构探测而非版本比较

业务代码不出现任何版本判断。三个适配器：

- `src/compat/sandbox-confine.ts` —— `widenConfined()` **保形**：上游同步就同步返回，上游返回 promise 就返回 promise。绝不把同步结果包成 promise，因为在 `0.1.5-rc.2` 上那会把 `ctx.sandbox.confine()` 对组合里每一个调用方（bash executor、PTY backend）都变成 thenable。返回类型用 `ReturnType<LocalSandboxProvider['confine']>` 从**已安装的**基类推导，于是一份签名同时对两个版本成立。
- `src/compat/agent-instructions.ts` —— 业务层只调用 `renderInstructions(...)`；适配器按**导出名**挑选 `renderAgentInstructions ?? renderWorkspaceContext`。
- `src/compat/client-session.ts` —— 业务层只调用 `currentSessionIdOf(sessions)`；适配器先认非空的 `list.current`（0.1.5 / 0.1.6-alpha.1），否则取 `retainedBy.mainView > 0` 的目录行（0.1.6-alpha.2）。绝不回退 `ids[0]`。

一律用结构探测（是否 thenable、导出哪个名字、快照有没有 `current`）而不是比较版本号：结构探测还能应付上游在同一版本内改形状，或一个版本里同时保留两个名字。

**可选 peer 一律按需加载，不得静态值导入。** barrel（`src/index.ts`，即 carrier loader 行挂载的模块）的加载期依赖集合必须等于必需包集合：`@deepseek-ai/dsh-llm`、`@deepseek-ai/dsh-agent-instructions` 这类可选 peer 一旦被业务层的静态值导入，一个“本就不需要它”的最小组合会在加载 carrier 行时就失败。`@deepseek-ai/dsh-llm` 由 `src/compat/llm-message.ts` 承载：`createInstructionMessage()` 在**真正要构造消息的那一刻**才 `await import('@deepseek-ai/dsh-llm')`，peer 缺失时抛出带原因的 `Error`（静默丢上下文比报错更糟）。同理，`src/compat/agent-instructions.ts` 必须把“包没装”（`isPackageInstalled()` 探不到，返回 `undefined`）与“包装了但求值失败”（让异常浮出）区分开：后者是兼容性故障，不是可选缝。

### 5. `DSH_MULTI_ROOT_COMPAT=warn` 只为升级车道存在

升级车道必须在一个**还不在 allowlist 上**的版本上跑完整矩阵——那次运行正是该版本获得资格的方式。所以提供一个放宽开关，并且警告文本明确说明“即将在未验证的 sandbox profile 形状上授予 additional root”。生产部署不设置它。

**`warn` 只放宽 `unsupported` 一个判定**：即“版本一致、只是 allowlist 还没列名”的树——升级车道探测的正是这一种形状。`mixed` 与 `incomplete` 在两种模式下都拒绝：它们描述的是契约**根本无法评判**的安装（围栏的两半可能各自对着不同的上游语义工作，或某个必需包缺失），放宽它们等于让 `apply()` 在这类树上发布 `multiRootCompat`、让授权放宽行在一棵没人能判定的树上启动。`assertSupportedInstallation()` 因此是 `if (enforcement === 'enforce' || report.verdict !== 'unsupported') throw new DshCompatUnsupportedError(report)`。

单元套件也遵守同一条线：`tests/support/compat.ts` 挂载的是**真实的** compat 行（含门禁策略），因此在未列入的版本上 enforce 模式会直接让整个套件失败，而不是悄悄产出“对一个没人验证过的宿主”的证据。

### 6. 静态门禁与运行时门禁分工

运行时门禁保护的是**已安装的宿主**；`scripts/check-dsh-compat.mjs`（`pnpm compat:check`）保护的是**仓库**。后者是唯一能发现本 ADR 起因的检查——运行时门禁跑起来的时候，npm 早就按范围解析完了。四者必须互相一致：

```text
src/compat/dsh-version.ts   SUPPORTED_DSH_RELEASES   allowlist
package.json                peerDependencies         对外承诺
package.json                devDependencies          CI 实际跑的
node_modules                resolved versions        本地实际装的
```

它从 TypeScript 源码里**文本读取** allowlist 而不是 import：这个检查必须能在 `pnpm build` 之前、在没有 `lib/` 的干净 checkout 上运行。

### 7. 开发 pin 留在 `0.1.5-rc.2`，第二个版本由升级车道覆盖

`devDependencies` 与 lockfile 的主 pin 保持 `0.1.5-rc.2`，CI 主车道验证这个基线；`0.1.6-alpha.1` 由 `upgrade.yml` 矩阵覆盖。两个版本都必须能跑通全部检查。

### 8. 升级车道按周运行，且不得自行扩大支持矩阵

`upgrade.yml` 从纯手动扩展为 `schedule` + `workflow_dispatch`：解析 `@deepseek-ai/dsh` 最新 pre-release → `scripts/upgrade-dsh.mjs` 重指 pin → 安装 → lint / typecheck / build / kernel probe / unit / compose / behavior / journey。

**“CI 通过”不等于“支持该版本”。** 该 workflow 的权限是 `contents: read`，不提交、不推送、不碰 `SUPPORTED_DSH_RELEASES`；成功时只在 step summary 里写出人工提升的三步。`tests/workflows.spec.ts` 把这些性质钉住。

`compat:check` **不**在升级车道里运行：候选版本按设计就不在 allowlist 上，静态门禁会拒绝这个车道存在的意义所在的那棵树。

### 9. 单一套 smoke 同时服务整个矩阵

smoke 脚本不再假定任何单一版本的形状：

- `scripts/smoke-behavior.mjs` 一律 `await ctx.sandbox.confine(...)`（await 一个普通值是 no-op，而读 promise 的 `.argv` 会静默得到 `undefined`）；
- `scripts/smoke-journey.mjs` 的脚本化模型端点**按请求路径**回答两种 wire 协议，并且把“哪个请求是 agent step”从匹配 title 提示词改为判断**请求是否提供 tools**——某些版本会把整个 session log 随每个请求一起发送，文本匹配会把所有请求都判成 title。

## Alternatives Considered

| 方案 | 否决理由 |
| --- | --- |
| 保留 `>=0.1.2-alpha.4 <0.2.0` 范围，只在文档里写清楚 | 这正是本 ADR 要解决的问题：npm metadata 是机器读的，文档不是 |
| 按 semver 比较版本来分支（`if (version >= '0.1.6')`） | 上游是 pre-stable，同一版本内也会改形状；版本比较对此无能为力，结构探测可以 |
| 把 compat 做成挂载的 `Service` 子类，在构造函数里检查 | 构造函数执行时 `super(ctx, name)` 已注册 service key，门禁失去意义 |
| 只做运行时门禁，不做 `compat:check` | 运行时门禁跑起来时 npm 已按范围解析完成，无法发现“承诺 > 验证”这类仓库级漂移 |
| 只做 `compat:check`，不做运行时门禁 | 插件会被安装到任意宿主里，仓库检查管不到用户机器上的组合 |
| 在业务代码里写版本判断，不建 `src/compat/` | 每次上游改一次 API 就要在多处同步修改；适配层把改动收敛成一个文件 |
| 让 `widenConfined` 一律返回 promise，统一两个版本 | 在 `0.1.5-rc.2` 上会把 `ctx.sandbox.confine()` 对所有既有调用方变成 thenable，等于插件自己引入一次破坏性变更 |
| 升级车道通过后自动把版本加入 allowlist 并提交 | 会重新制造“承诺高于验证”的结构：绿灯是证据，不是授权。本插件的安全敏感性要求人工决定 |
| 把候选版本的传递依赖逐个写进 `minimumReleaseAgeExclude` | 一次一过的探测会产生 200 行 diff；升级车道改为安装时 `--config.minimumReleaseAge=0` |
| 只放宽 enforce 而不让单元套件感知车道 | 套件会在未验证版本上"通过"，产生看起来可信但无授权的证据 |

## Consequences

- 正面：“本插件支持哪些上游版本”现在是一个可执行的事实，而且由四处一致性检查守住，不再是 README 里的一句话。
- 正面：混装组合从“npm 允许、运行时沉默”变成启动期 fail loud，并且错误信息里列出每个被检查包的实际版本。
- 正面：未验证版本上的失败方式从“可能静默放宽围栏”变成“四个 provider 不启动、组合退化为未安装本插件”。
- 正面：`0.1.6-alpha.1` 的两处接口变化已经被适配层吸收，升级到它不需要改业务代码。
- 正面：smoke 与单元套件对两个版本都成立，所以“绿灯”对整个 allowlist 都是有效证据。
- 代价：上游每次发版都需要人工决定是否提升，并跑一遍升级车道。这是刻意的（见 Alternatives 最后几行）。
- 代价：allowlist 与 `peerDependencies` 必须同时改；`pnpm compat:check` 会在漏改时报错，但这确实是两处编辑。
- 代价：`src/compat/` 会随着支持的版本数量增长而积累适配分支。移除一个版本时应同时清掉只为它存在的分支。
- 代价：`peerDependencies` 使用 `a || b` 形式的精确版本或，下游若装了别的版本会得到 peer 警告——这是期望行为。

## 返工补充（2026-09-15，PR #1 评审）

PR #1（head `507c954`）的 P2-3 / P2-4 / P2-5 收紧了两条规则（内容见上面的第 4、5 条，此处只记落点与证据）：

| 规则 | 落点 | 钉住它的测试 |
| --- | --- | --- |
| `warn` 只放宽 `unsupported`，`mixed` / `incomplete` 两种模式都拒绝 | `src/compat.ts` 的 `assertSupportedInstallation()` | `tests/compat.spec.ts` 的 `describe('the gate policy')` 两条新用例（混装 / 缺包在 `warn` 下仍抛 `DshCompatUnsupportedError`） |
| 可选 peer 不得被静态值导入；“包没装”与“包装了但求值失败”必须区分 | `src/compat/llm-message.ts`（`createInstructionMessage()` 按需 `import`）、`src/compat/agent-instructions.ts`（`isPackageInstalled()` + `instructionsApi()` 只在真缺失时返回 `undefined`） | `tests/optional-peers.spec.ts`（barrel 与指令行加载时 `@deepseek-ai/dsh-llm` 未被解析；抛错的 mock peer 必须以 rejection 浮出而非被当成缺失） |

`src/index.ts` 因此 export `createInstructionMessage` 与 `InstructionMessageInput`；`src/instructions.ts` 只保留 `import type { UserMessage }`（类型导入被擦除，不构成加载期依赖）。

## 后续提升（2026-09-22）：纳入 `0.1.6-alpha.2`

按本 ADR 的人工提升流程，把 `0.1.6-alpha.2` 写入 `SUPPORTED_DSH_RELEASES`，`peerDependencies` 改为 `0.1.5-rc.2 || 0.1.6-alpha.1 || 0.1.6-alpha.2`。开发 pin 仍是 `0.1.5-rc.2`。

实测：该版本的 `confine` 仍是 `Promise<ConfinedArgv>`（可选 `signal`），instruction renderer 仍是 `renderAgentInstructions`，journey 的 Messages 协议端点无需改动。完整矩阵在 warn（纳入前）与 enforce（纳入后）下都全绿。基线 `0.1.5-rc.2` 在同一份 allowlist 上回归全绿。

**后续修正（2026-09-22）**：host 矩阵全绿不等于客户端形状没变。`0.1.6-alpha.2` 删除了 `SessionListState.current`，面板读这个字段时把已打开的会话显示成「当前没有活动会话」。结构探测落在 `src/compat/client-session.ts`：先认非空 `current`，否则取 `retainedBy.mainView > 0` 的目录行；禁止回退 `ids[0]`。`tests/client-session.spec.ts` 与 `tests/client-panel.spec.tsx` 钉住两种快照。升级车道的 journey smoke 不打开 Web 面板，这类客户端形状变化不会被 `pnpm verify:all` 抓住——纳入新版本时必须对照客户端 Session 快照，不能只看 host 矩阵。

## 后续提升（2026-09-22）：纳入 `0.1.7-alpha.1`

按本 ADR 的人工提升流程，把 `0.1.7-alpha.1` 写入 `SUPPORTED_DSH_RELEASES`，`peerDependencies` 改为 `0.1.5-rc.2 || 0.1.6-alpha.1 || 0.1.6-alpha.2 || 0.1.7-alpha.1`。开发 pin 仍是 `0.1.5-rc.2`。

`confine` 仍是带可选 `signal` 的 `Promise`，instruction renderer 仍是 `renderAgentInstructions`，journey 仍走 `/v1/messages`。这一版仍要改适配层，因为形状变了，而且不能靠比较版本字符串：

- session format 4 的编码器拒绝 `kind: 'plugin'`。`createInstructionMessage` 读取 `@deepseek-ai/dsh-session` 导出的 `SESSION_FORMAT_VERSION`：小于 4 时仍投 `{ kind: 'plugin', plugin, form: 'instructions' }`，从 4 起投 `{ kind: 'multi-root-workspace', plugin, form: 'instructions' }`。不用 `agent-instructions`，上游把那个 kind 的 `changes` 当作自己的协调权威。renderer 名字不能当这个探针：`0.1.6` 已经改名却仍接受 `plugin`。
- 工具失败位从 content block 的 `isError` 移到 `ToolResultMessage.isError`。`toolResultFailed` 两种都读。
- 面板图标从像素名改为 Regular 线宽。`client-icons.ts` 先取像素名，没有再取 Regular。
- `healProfilesModuleFallback` 不再导出。进程内启动在它是函数时仍调用它，否则 `createRuntimeResolution` 再在 `boot` 的 prepare 里挂 `PluginPackages`。
- `SandboxBashExecutor.run` 改成 `execute(spec)`，结果在返回的 execution 上 `result()`。smoke 的 `runForeground` 按方法名选择。

该版本的 `dsh` 依赖 cordis `^4.0.3`。探测树里若同时留下 `4.0.2`，pnpm 会给出两份 `dsh-tools`：agent-loop 持有的 `TOOL_RUNTIME_SCHEDULER` 是模块局部 `Symbol`，对不上另一份构造出来的 ToolRuntime，工具调用在第一步抛 `Cannot read properties of undefined (reading 'prepare')`。`upgrade-dsh.mjs` 因此把 cordis 开发 pin 改到候选 `dsh` 所声明范围里的那个精确版本。基线 pin 回到 `0.1.5-rc.2` 时 cordis 回到 `4.0.2`。

实测（macOS，seatbelt 可用，bwrap / landlock 不可用）：纳入前 warn、纳入后 enforce，以及 pin 回到 `0.1.5-rc.2`（cordis `4.0.2`）的基线回归，都是 329 passed / 3 skipped，compose 40/40，behavior 99/99，journey 55/55。

## Related Documents

- [ADR-0002：上游耦合策略](./ADR-0002-upstream-coupling-policy.md)（本 ADR 收紧了其中第 4 条关于 `peerDependencies` 范围的部分）
- [ADR-0003：方言 grant 拼接策略](./ADR-0003-dialect-grant-widening.md)（argv 形状识别，也是本契约存在的根本原因）
- [Agent Note：DSH 兼容性契约](../../.agent/note/dsh-compat-contract.md)
- [故障排查：不支持的 DSH 版本](../troubleshooting/unsupported-dsh-release.md)
- [开发工作流](../development/plugin-development-workflow.md)
- [开发计划：DSH 兼容性契约](../plans/completed/2026-09-15-dsh-compat-contract.md)
