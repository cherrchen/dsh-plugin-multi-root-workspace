# DSH 兼容性代码契约与 0.1.6-alpha.1 纳入

> 编号口径：本计划是 `v0.1.1` 硬化批次的 **H3（兼容性契约）+ H4 Phase 1（附加根顶层指令）**；H4 Phase 2（nested instructions）见本文 §5b，**未实现**，属第二期。批次总账见[路线图](../active/2026-09-12-multi-root-workspace.md#进度总账)。

## Goal

把“本插件支持哪些 DSH release”从 npm peer metadata 的宽范围承诺，变成**启动时可执行、可测试、可审计的代码契约**：

1. `peerDependencies` 只声明实际验证过的版本，不再用 `<0.2.0` 这类范围over-promise；
2. 进程启动时校验实际安装的上游版本落在显式 allowlist 内，且核心包**没有混装**，否则 fail loud；
3. 校验通过才允许其余安全相关 provider 启动；
4. 版本相关的 API 差异集中在 `src/compat/` 适配层，业务代码不写版本判断；
5. 在此基础上把 `0.1.6-alpha.1` 与 `0.1.5-rc.2` 一起纳入 allowlist。

## Background

`package.json` 当前声明的 peer 范围是 `>=0.1.2-alpha.4 <0.2.0`，而 `src/dialects.ts` 的方言识别是**对 `0.1.5-rc.2` 实测 argv 形状的观测结果**（ADR-0003）。也就是说 npm metadata 承诺的兼容范围远高于代码真正验证过的范围：装到一个未验证的 0.1.x 上，插件会照常 resolve、照常替换 `ctx.fs` / `ctx.sandbox`，然后在方言识别处才发现形状不对——而这是一个安全边界。

ADR-0002 决策 4 当时选择“peerDependencies 采用生态惯例范围以兼容已安装运行时”。本 plan 取消该选择，由 ADR-0009 记录新决策并把 ADR-0002 的对应条目标注为被取代。

## Current State

以下都是本次改动前实测确认的事实，不是推断。

### 基线

- `devDependencies` / lockfile pin 在 `0.1.5-rc.2`。
- 基线是绿的：`pnpm typecheck` 干净，`pnpm test` 为 237 passed / 3 skipped（16 个文件）。
- npm 上 `@deepseek-ai/dsh` 的最新版本是 `0.1.6-alpha.1`（`0.1.5-rc.2` 之后没有别的版本）。
- `@deepseek-ai/dsh-agent-instructions` 是默认 bundle 的一行（`@deepseek-ai/dsh-base` 的 `cordis.patch.yml` 中 id 为 `agent-instructions`，config 为 `maxBytes: 65536`），本仓库此前未直接依赖它。

### 0.1.5-rc.2 → 0.1.6-alpha.1 的破坏性变更

按发布包 `lib/types/**` 逐文件对比得到：

1. **`confine()` 变成异步**（唯一命中本仓库代码的破坏性变更）

   ```text
   0.1.5-rc.2  confine(argv, policy): ConfinedArgv
   0.1.6-alpha.1  confine(argv, policy, signal?): Promise<ConfinedArgv>
   ```

   `@deepseek-ai/dsh-sandbox` 的抽象方法与 `@deepseek-ai/dsh-sandbox-local` 的实现同时改了。命中 `src/sandbox.ts` 的 `override confine`，以及 `tests/sandbox-passthrough.spec.ts`、`tests/sandbox-multi-root.spec.ts`、`tests/parity-matrix.spec.ts`、`scripts/smoke-behavior.mjs` 的全部调用点。

2. **instruction renderer 改名**（签名不变，纯重命名）

   ```text
   0.1.5-rc.2     renderWorkspaceContext(files, options)  RenderedWorkspaceContext
   0.1.6-alpha.1  renderAgentInstructions(files, options)  RenderedAgentInstructions
   ```

   同时 `renderWorkspaceInstructionSet` → `renderAgentInstructionSet`。`discoverBaselineInstructionFiles` / `loadBaselineInstructions` / `loadBaselineInstructionSet` 的名字与签名都没变。

3. **`agent/session-start` 被删除**（影响 instruction 注入的切入点选择）

   ```text
   0.1.5-rc.2     'agent/session-start'  @mode emit    首个 startup-driving 扩展点
                  'agent/created'        @mode emit    composition-only
   0.1.6-alpha.1  'agent/session-start'  已移除
                  'agent/created'        @mode serial  awaited，新增 source / signal
   ```

   这条决定了 `multi-root-instructions` **不能**挂在 session 生命周期事件上，否则会引入第三条版本分支。见 Design §5。

### 0.1.6-alpha.1 的增量变更（不破坏本仓库，但需记录）

- `dsh-sandbox`：新增 `diagnostics` 模块导出（`classifyRunnerFailure`、`isRunnerSpawnFailure`、`matchesSignature`）。
- `dsh-system-prompt`：`PromptContribution` 新增 `interpolate?: boolean`；order 常量新增 `TOOL_COMPUTER_USE: 3000`、`MCP_SERVERS: 3100`。
- `dsh-fs-local`：新增 `localDisplayPath` 导出。
- `dsh-client-connection`：`ClientTransportHooks.fetch` 由必填变可选，新增 `rpc` / `ConnectionInstallOptions` / `ConnectionLocation`，移除 `client/fixture.d.ts`（本仓库未引用）。
- `dsh-session`：新增 `SessionMessageProjection` 相关导出，`Session.create` / `fromRestore` 新增可选 `projections` 参数，同步事件读取 API 标注 `@deprecated`（本仓库未使用）。
- `dsh-agent`：不再发 `agent/session-start`，改为 await serial `agent/created` 监听器。
- `dsh-commands`：新增 `CommandDefinitionId`。
- `dsh-workspace`：新增 `unarchiveSession`。
- `dsh-sandbox-policy`：仅注释与 import 形式变化。

## Scope

- 新增 `src/compat.ts`（Cordis row `multi-root-compat`，提供 `ctx.multiRootCompat`）。
- 新增 `src/compat/dsh-version.ts`（纯逻辑：allowlist、核心包清单、已安装版本解析、混装判定、诊断文本）。
- 新增 `src/compat/sandbox-confine.ts`（同步/异步 `confine` 适配）。
- 新增 `src/compat/agent-instructions.ts`（instruction renderer 适配，业务层只调用 `renderInstructions`）。
- 新增 `src/instructions.ts`（Cordis row `multi-root-instructions`）。
- 新增 `scripts/check-dsh-compat.mjs` 与 `compat:check` 包脚本。
- `multi-root-fs` / `multi-root-sandbox` / `multi-root-registry` / `multi-root-instructions` 全部 inject `multiRootCompat`。
- `peerDependencies` 改为显式 allowlist 析取；**开发 pin 与 lockfile 留在基线 `0.1.5-rc.2`**（见「已决策 1」：CI 主 lane 始终验证已证明的基线，allowlist 里更新的那一版由 upgrade 车道覆盖）。
- `upgrade.yml` 从纯手动扩展为 weekly 定时探测 + 显式版本矩阵。
- 文档：ADR-0009、`.agent/note/dsh-compat-contract.md(.en.md)`、troubleshooting 条目、架构与开发流程文档同步。

## Non-goals

- **不自动扩大 allowlist**。CI 绿不等于支持；把版本写进 `SUPPORTED_DSH_RELEASES` 永远是人工动作。
- 不支持 `0.1.5-rc.2` 之前的任何版本（从未验证过，现在明确不承诺）。
- 不重新实现上游 agent-instructions 的 session projection / 增量 reconcile 机制。
- 不改动 registry 持久化格式、panel 协议、client 端样式。

## Design

### 1. 版本契约的三条判定（`src/compat/dsh-version.ts`）

纯模块，不 import cordis，可被脚本和测试直接复用。

- `SUPPORTED_DSH_RELEASES = ['0.1.5-rc.2', '0.1.6-alpha.1']` —— 显式 allowlist，**精确字符串**，不是 range。
- `CORE_PACKAGES`：区分 `required`（缺失即 fail：`dsh-sandbox`、`dsh-sandbox-local`、`dsh-fs`、`dsh-fs-local`、`dsh-sandbox-policy`、`dsh-storage-domain`）与 `optional`（缺失允许，装了就必须同版本：`dsh-agent-instructions`、`dsh-system-prompt`、`dsh-commands`、`dsh-session`、`dsh-client-connection`、`dsh-subprocess`）。
- 版本读取：`createRequire(...).resolve('<pkg>/package.json')` 再读 `version`。声明为 peer 的包会解析到宿主提供的那一份，这正是要检查的对象。
- 三条判定：
  1. **完整性**：每个 required 包都能解析出版本；
  2. **一致性**：所有解析到的核心包版本相同（用户举的 `dsh-sandbox-local 0.1.5-rc.2` + `dsh-fs-local 0.1.6-alpha.1` 属于 `mixed`，直接 fail loud）；
  3. **allowlist**：该唯一版本在 `SUPPORTED_DSH_RELEASES` 内。
- 输出一个 `CompatReport`：`{ verdict, release?, packages, message }`，`verdict ∈ 'supported' | 'mixed' | 'unsupported' | 'incomplete'`。诊断文本要直接可读：列出每个包实测到的版本、指出哪几个不一致、给出 allowlist 与 troubleshooting 链接。
- enforcement 由 `DSH_MULTI_ROOT_COMPAT` 控制：默认 `enforce`（throw），`warn` 只记日志。**`warn` 的唯一用途是 upgrade smoke**——要在一个还没进 allowlist 的版本上跑完整测试，必须能临时放行，否则 upgrade workflow 自己就起不来。

### 2. 启动门禁（`src/compat.ts`）

row `multi-root-compat` 导出 `apply`（不是 Service 类），因为门禁必须发生在**服务注册之前**：

```ts
export function apply(ctx: Context): void {
  const report = classifyInstallation()
  if (report.verdict !== 'supported' && enforcement() === 'enforce') {
    throw new DshCompatUnsupportedError(report)   // 服务从未注册
  }
  if (report.verdict !== 'supported') ctx.logger.warn(report.message)
  ctx.plugin(MultiRootCompatService, report)      // 提供 ctx.multiRootCompat
}
```

`apply` 抛错 → 该行加载失败 → `ctx.multiRootCompat` 永不存在 → 四个 inject 了它的 provider 全部不启动。这就是用户要求的“compat check 成功 → 其他安全 provider 才能启动”。

`ctx.multiRootCompat` 暴露 `release`、`report`、以及各适配层需要的能力查询。

**设计原则**：适配层优先做**结构探测**（返回值是不是 thenable、模块导出了哪个函数名），而不是按 `release` 字符串分支。版本号只用于门禁与诊断。结构探测对“上游在同一版本内改了形状”也成立，版本分支不成立。

### 3. `confine` 同步/异步适配（`src/compat/sandbox-confine.ts`）

widening 本身是纯字符串运算（`src/dialects.ts`），所以适配层只需保证**进来什么形状，出去什么形状**：0.1.5 同步进同步出，0.1.6 异步进异步出。

- 返回类型用 `ReturnType<LocalSandboxProvider['confine']>` 表达，随安装版本自动解析为 `ConfinedArgv` 或 `Promise<ConfinedArgv>`，不需要两套签名。
- `super.confine` 的调用通过一个容忍 2/3 参数的调用类型转发，把唯一一处 cast 关在这个文件里。
- `src/sandbox.ts` 的 `override confine` 保持“只决定何时 graft”的职责，widening 逻辑与 fail-closed 语义（`SandboxUnavailableError`）不变。
- 测试侧加 `tests/support/confine.ts`，统一 `await`（await 非 Promise 值在 0.1.5 下同样正确），这样一套测试同时适用两个版本。

### 4. instruction renderer 适配（`src/compat/agent-instructions.ts`）

业务层只调用 `renderInstructions(files, options)`。适配层用 namespace import 取 `renderAgentInstructions ?? renderWorkspaceContext`，两个都没有就抛带诊断的 compat 错误。返回值归一化成本仓库自己的 `RenderedInstructions` 类型，避免把上游改过名的类型泄漏到业务层。以后 0.1.7 再改名，只改这一个文件。

### 5. `multi-root-instructions`（`src/instructions.ts`）—— Phase 1：additional root 顶层 instruction

上游 agent-instructions 只从 session cwd 向上发现 instruction 文件，**additional root 里的 `AGENTS.md` / `CLAUDE.md` 对模型完全不可见**——这是多根工作区的真实缺口。本 provider 补上它。

**不使用 `systemPrompt`。** instruction 是 producer-supplied context，不该被提升成 system authority；DSH 的 message model 本身就有这个位置，且在两个版本中**逐字节相同**（实测 `dsh-llm/lib/types/message.d.ts`）：

```ts
createUserMessage({
  content: [{ type: 'text', text }],
  source: {
    kind: 'plugin',
    plugin: '@dsh-electron/dsh-plugin-multi-root-workspace',
    form: 'instructions',
  },
})
```

它仍然是普通 user-role context。

**切入点是 `agent/pre-step`**，不是 session 生命周期事件。理由有两条，都是硬的：

1. `agent/session-start` 在 0.1.6 已被删除（见 Current State），挂生命周期事件就要写版本分支；`agent/pre-step` 的签名与 `PreStepDecision` 在两个版本中完全相同。
2. `agent/pre-step` 是 `@mode waterfall` 且 awaited，discovery / 读文件 / 渲染都是异步的，只有在这里才能**确定性地**在模型看到第一个 step 之前完成——挂同步的 `systemPrompt.context({ text })` 回调做不到，挂 emit 模式的生命周期事件则会和第一个 step 竞争。

```ts
ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
  const decision = await next()
  if (decision.kind !== 'enter') return decision
  const seeded = await this.pending(agent, signal)      // 无变化时为空
  if (seeded.length === 0) return decision
  return { ...decision, messages: [...seeded, ...decision.messages] }
})
```

**每个 additional root 的发现范围**，复用上游公开 API 并按 canonical 路径收窄：

```ts
discoverBaselineInstructionFiles({ cwd: root, projectRoot: root, signal })
// 然后只保留 canonicalPath(file) 仍在该 root 之内的
```

这一步筛选自然排除了 `$DSH_HOME/AGENTS.md`、primary root 的 `AGENTS.md`、以及 additional root 上级目录的 `AGENTS.md`——**user-global instruction 不会被重复注入**（原生 agent-instructions 已经在管它）。

**预算是共享的。** 不是每个 root 各 64 KiB：`additionalInstructionsMaxBytes` 默认 `65536`，是整个 additional-root instruction snapshot 的总预算，否则 10 个根理论上会额外吞掉 640 KiB context。渲染走 `renderInstructions`，即适配层的真实消费者。

**每 session 状态**用于避免每一步重复塞同样内容：

```ts
WeakMap<Session, Map<AdditionalRootId, InstructionState>>
// InstructionState: { digest, renderedText, relevantPath }
```

**撤销语义是必须的**：一个 root 变成 `removed` / `missing` / `redirected` 时，不能只是停止发送——历史 conversation 里原来的 instruction 仍然存在。必须发一条 replacement context 明确告诉模型该 root 的 instruction 不再适用。root 恢复后（`refresh()` 之后）重新出现。

`fs` 作为**软依赖**（`ctx.get('fs')`）：没有 fs seam 的组合不贡献任何内容，而不是加载失败——与 `multi-root-scope` 对 `systemPrompt` 的处理一致。

### 5b. `multi-root-instructions` Phase 2 —— nested instructions（本次不实现）

上游对 primary workspace 已经在做“tool result 成功 → 按 touched path 更新 nested instructions”。插件可以复用同一语义：tool result 成功 → 取 `file_path` → 判断属于哪个 additional root → 从 root 到 `dirname(file_path)` 发现 instruction → 与上次 signature 比较 → 有变化则在下一个 model step 前插入新的 `form=instructions` context。

本次只做 Phase 1（顶层），Phase 2 单独排期，理由是它需要 tool-result 投影语义，而那一块在 0.1.6 引入了 `SessionMessageProjection`，需要独立评估。

### 6. `scripts/check-dsh-compat.mjs`

CI 与本地都能单独跑的静态门禁，复用同一份 allowlist：

1. 打印每个核心包实测解析到的版本；
2. 校验完整性 / 一致性 / allowlist；
3. **校验 `package.json` 的 `peerDependencies` 范围与 allowlist 完全一致**——这是防止 metadata 再次 over-promise 的那一条，光有运行时检查不够；
4. 任一条不满足则非零退出。

### 7. `upgrade.yml`

- 保留 `workflow_dispatch` 的显式 version 输入。
- 新增 weekly `schedule`：`npm view @deepseek-ai/dsh versions --json` → 取最新 pre-release → 升级整个 `@deepseek-ai/*` → 跑完整矩阵。
- 探测出的版本若不在 allowlist，用 `DSH_MULTI_ROOT_COMPAT=warn` 跑，并在 summary 中**明确写出“绿灯不等于已支持，需人工加入 allowlist”**。
- 矩阵同时覆盖 allowlist 中的每一个版本，这样“已声明支持的版本”始终有 CI 证据。

## Implementation

### Phase 1 — 契约骨架（仍在 0.1.5-rc.2 上）

1. `src/compat/dsh-version.ts` + `src/compat.ts` + `tests/compat.spec.ts`。
2. `scripts/check-dsh-compat.mjs` + `compat:check` 脚本。
3. `cordis.patch.yml` 插入 `multi-root-compat`（第一行，在 fs/sandbox 之前）；四个 provider 加 inject。
4. `package.json` exports / `tsdown.config.ts` entry / `tests/patch.spec.ts` / `scripts/smoke-compose.mjs` 的行数与断言同步。
5. 此时必须仍然全绿——契约骨架不改变 0.1.5 上的任何行为。

### Phase 2 — upgrade smoke 到 0.1.6-alpha.1

按用户给定顺序跑：typecheck → build → unit → fs parity → sandbox passthrough → dialect tests → kernel probe → behavior smoke → journey smoke。

1. 升级全部 `@deepseek-ai/*` 到 `0.1.6-alpha.1`，同步 `pnpm-workspace.yaml` 的 `minimumReleaseAgeExclude`。
2. 用 `DSH_MULTI_ROOT_COMPAT=warn` 跑（此时 0.1.6 还不在 allowlist），逐项修到全绿：
   - `src/compat/sandbox-confine.ts` + `src/sandbox.ts` + 四处测试/smoke 的 `confine` 调用点；
   - 其余实测暴露出来的问题（`dsh-llm` 的 API 形态变化可能影响 `scripts/smoke-journey.mjs` 里那个 scripted model endpoint，需实跑确认）。
3. **回归验证 0.1.5-rc.2 仍然绿**——双版本都必须过，否则 allowlist 是假的。

### Phase 3 — 固化支持矩阵

1. `SUPPORTED_DSH_RELEASES` 写入两个版本，移除 `warn` 依赖。
2. `peerDependencies` 改为 `0.1.5-rc.2 || 0.1.6-alpha.1`。
3. `upgrade.yml` 定时探测 + 矩阵；`ci.yml` 在 typecheck 之前加 `compat:check`。
4. 文档：ADR-0009、`.agent/note/dsh-compat-contract.md(.en.md)`、`docs/troubleshooting/unsupported-dsh-release.md`、架构文档的 provider 表、`plugin-development-workflow.md` 的升级流程、ADR-0002 决策 4/6 标注被取代、AGENTS.md 的 invariant 列表。
5. `pnpm docs:check`，plan 移入 `completed/`。

## Validation

| 项 | 判据 |
| --- | --- |
| `pnpm compat:check` | 0.1.5-rc.2 与 0.1.6-alpha.1 下均通过；peer 范围与 allowlist 一致 |
| `tests/compat.spec.ts` | 混装、未知版本、缺包、warn/enforce 各有回归用例 |
| 启动门禁 | 未支持版本下 `ctx.multiRootCompat` 不存在，四个 provider 均不启动 |
| `pnpm typecheck` / `pnpm test` | 两个版本下都全绿 |
| fs parity / sandbox passthrough / dialect | 两个版本下都全绿，空根仍与未装插件逐元素一致 |
| `pnpm kernel:probe` + `smoke:behavior` + `smoke:journey` | 两个版本下都通过 |
| `pnpm smoke:compose` | 新增行数与 id 断言更新后通过 |
| `pnpm docs:check` | 通过 |

`multi-root-instructions` Phase 1 的验收场景：

| 场景 | 判据 |
| --- | --- |
| `primary/AGENTS.md` + `repo-a/AGENTS.md` + `repo-b/AGENTS.md` | first request 时三者语义同时存在 |
| `$DSH_HOME/AGENTS.md` | 不被本插件重复注入（原生 agent-instructions 已管） |
| primary root 的 `AGENTS.md` | 不被本插件重复注入 |
| additional root 上级目录的 `AGENTS.md` | 不注入（canonical 收窄筛掉） |
| 零 additional root | 一条 message 都不注入 |
| 移除 repo-a | 后续 context 明确撤销 repo-a 的 instruction |
| repo-a 被换成 symlink（redirected） | instruction 与 writable grant 同时撤销 |
| 恢复 repo-a 后 `refresh()` | instruction 重新出现 |
| 同一 root 连续多个 step | 内容不变则不重复注入 |
| 10 个 root | 总字节受 `additionalInstructionsMaxBytes` 约束，不是每根一份预算 |

## Risks

- **门禁把插件变成单点失败**：compat 不通过时四个 provider 都不启动，而 patch 已经 disable 了上游 `fs-sandbox` / `sandbox` 行——此时组合里没有 fs/sandbox provider。必须保证错误信息足够明确（指向 troubleshooting 文档与具体版本清单），并在 troubleshooting 中写清恢复办法（卸载插件行或对齐版本）。
- **`ReturnType<...>` 随安装版本变化**：这是刻意的，但意味着 `src/sandbox.ts` 的签名在两个版本下解析成不同类型。必须两个版本都跑 typecheck 才算验证过。
- **~~0.1.6 的 `agent/created` 语义变化~~**：已通过设计规避——`multi-root-instructions` 挂 `agent/pre-step`（两版完全相同）而不是生命周期事件，所以 `agent/session-start` 的移除不构成第三条版本分支。
- **instruction 注入改变了模型看到的内容**：这是本次唯一一处“空根之外的行为新增”。必须保证零 additional root 时该 provider 一条 message 都不注入，否则会破坏“空根与未装插件逐元素一致”的不变量。
- **journey smoke 的 scripted model**：0.1.6 的 llm API 形态变化可能要求改那个 SSE 端点的应答格式，只能实跑确认。

## 已决策

1. **主 pin 留在 `0.1.5-rc.2`**。CI 主 lane 继续验证已证明的 baseline，`0.1.6-alpha.1` 由 upgrade 矩阵覆盖；两版都在 allowlist 内，都必须绿。
2. **`multi-root-instructions` 做完整 Phase 1**：additional root 顶层 `AGENTS.md` / `CLAUDE.md` 经 `renderInstructions` 以 `form=instructions` 的 plugin user context 注入，共享 64 KiB 预算，带撤销语义。nested instructions 为 Phase 2，本次不实现。

## Documentation Impact

- 新增 `docs/decisions/ADR-0009-dsh-compat-contract.md`；ADR-0002 决策 4/6 标注被取代。
- 新增 `.agent/note/dsh-compat-contract.md` / `.en.md`（0.1.5 → 0.1.6 的实测差异清单属于“重新考古成本高”的知识）。
- 新增 `docs/troubleshooting/unsupported-dsh-release.md`。
- 更新 `docs/architecture/multi-root-workspace.md`（provider 表新增两行、门禁关系）、`docs/development/plugin-development-workflow.md`（升级流程与 `compat:check`）、`docs/reference/multi-root-workspace-research.md`（0.1.6 形状确认）、各 README 与 `AGENTS.md`。

## Completion Criteria

1. allowlist、`peerDependencies`、`compat:check`、运行时门禁四者对同一份支持矩阵达成一致，任一处漂移都会让 `compat:check` 失败。
2. `0.1.5-rc.2` 与 `0.1.6-alpha.1` 两个版本下，typecheck / unit / parity / passthrough / dialect / kernel probe / behavior / journey 全绿。
3. 未支持版本与混装版本都能 fail loud，且有回归测试。
4. 版本相关分支只存在于 `src/compat/`，业务代码无版本判断。
5. `pnpm docs:check` 通过，plan 归档到 `docs/plans/completed/`。

## 实施结果

全部 Completion Criteria 达成。两个版本都在 **enforce** 模式下跑完同一套矩阵（macOS，`kernel:probe` 报 seatbelt 可用、bwrap/landlock 不可用，因此 Linux 方言的真实执行用例按设计 skip 并说明原因）：

| | `0.1.5-rc.2`（开发 pin） | `0.1.6-alpha.1` |
| --- | --- | --- |
| `compat:check` | 通过 | 通过 |
| `lint` / `typecheck` | 干净 | 干净 |
| `test` | 18 文件，292 passed / 3 skipped | 18 文件，292 passed / 3 skipped |
| `smoke:compose` | 40/40 | 40/40 |
| `smoke:behavior` | 99/99 | 99/99 |
| `smoke:journey` | 43/43 | 43/43 |

单测数在两个版本上相同不是巧合，而是这次的设计目标：适配层做的是**结构探测**，所以没有任何一条用例需要按版本 skip。基线在改动前是 237 passed；新增的 55 条全部来自 `tests/compat.spec.ts` 与 `tests/instructions.spec.ts`，以及 `tests/workflows.spec.ts` 里钉住升级车道性质的几条。

### 与计划的偏差

1. **`verify:all` 里不含 `compat:check`**。计划没写这一点，实施时发现必须如此：升级车道按设计运行在一个还不在 allowlist 上的版本，`compat:check` 在那里**应该**失败。所以它属于 `ci.yml` 的第一步，而不属于 `verify:all`；`tests/workflows.spec.ts` 反过来断言升级车道里没有它。
2. **`tests/compat.spec.ts` 需要按 enforcement 模式分叉**。同一套断言无法同时适用于 enforce 与 warn，因为 allowlist 命中与否恰恰是两者的区别。用 `it.skipIf(upgradeLane)` / `it.runIf(upgradeLane)` 把"支持的版本上门禁必须放行"和"未支持的版本上门禁必须拒绝"分开表达。
3. **journey smoke 的 agent-step 判据换了**。原来靠 `body.includes('Create a concise title')` 区分标题侧调用，在 0.1.6 上失效——某些版本会把整段会话日志（含那句话）塞进每个请求。改成判断请求是否提供了 `tools`：只有真正的 agent step 会。这是结构判据，不是字符串巧合。
4. **`pnpm-workspace.yaml` 的 release-age 例外不再逐个枚举**。候选版本会拖进两百多个刚发布的传递依赖，枚举它们会把一次性探测变成 200 行 diff。改为安装时加 `--config.minimumReleaseAge=0`。
5. **`scripts/upgrade-dsh-dependencies.mjs` 被 `scripts/upgrade-dsh.mjs` 取代**，后者同时负责重指 pin、解析最新 pre-release、以及打印**实际解析到**的树——声明的 pin 和解析结果是两个事实，只有后者是测试真正跑过的东西。

### 实施中确认的一处工具链陷阱

升级探测的回退步骤 `git checkout -- package.json pnpm-workspace.yaml pnpm-lock.yaml` 在 CI 里安全（每次都是干净 checkout），在本地会把这三个文件**整体**退回 HEAD，连同未提交的改动。此外候选版本装上后，pnpm 的 run 前依赖自检会因为 release-age 门禁触发一次注定失败的重装，把 `node_modules` 撕成半截且 `pnpm install` 自称 "Already up to date"。两者都已写进 `scripts/upgrade-dsh.mjs` 的模块注释、`plugin-development-workflow.md` §6 与 Agent Note。
