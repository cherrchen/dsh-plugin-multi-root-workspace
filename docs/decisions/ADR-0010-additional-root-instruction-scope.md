# ADR-0010: 附加根指令注入的范围与分期

## Status

Accepted（2026-09-15：第 1、4、6、7 条改写为 H4 Phase 2 已实现的 nested 规则）

## Date

2026-09-15

## Context

上游 `agent-instructions` 从一个 session cwd **向上走**发现指令文件（`AGENTS.md` / `CLAUDE.md` 及各自的 local overlay），外加一个 user-global 文件。多根工作区里这条上行路径**永远到不了附加根**：`repo-b/AGENTS.md` 对一个被允许写 `repo-b` 的模型是不可见的。这是"多根可写沙箱"与"多根 coding workspace"之间最直接的语义缺口——权限已经放开，规则却没有送达。

同时上游对 **primary workspace** 已经在做两层发现：启动时的基线（session cwd 向上），以及成功 `read` / `write` / `edit` 之后按 touched path 的 nested instructions 更新。第二期（H4 Phase 2）最初被推迟，前置条件是评估 `0.1.6-alpha.1` 引入的 `SessionMessageProjection`；实施时的结论是**不需要**它：触碰可以从两个受支持版本都有的 `session/event` firehose 上取（`tool/call` 与 `tool/result` 按 call id 配对），因此本行不必依赖 tool 层的包，也不必离开兼容契约（ADR-0009）。

可用的投递通道是 DSH message model 自带的：

```ts
createUserMessage({
  content: [{ type: 'text', text }],
  source: { kind: 'plugin', plugin: '@dsh-electron/dsh-plugin-multi-root-workspace', form: 'instructions' },
})
```

它仍是 **user role** 的 producer-supplied context，不会被提升成 system authority，且随请求落 model history（满足 model-visible ⟺ logged）。这个 helper 属于**可选 peer** `@deepseek-ai/dsh-llm`，因此在本插件里只经 `src/compat/llm-message.ts` 按需加载（见第 9 条），业务层不静态导入它。

## Decision

1. **范围覆盖附加根的顶层及其下「本会话工作过的」子目录。** 每个被考察目录按 `discoverBaselineInstructionFiles({ cwd: <该目录>, projectRoot: root })` 发现，再以 canonical 包含过滤，只保留位于该根内部的文件。被考察目录恰好三类：**根自身**（每一步都考察，因此顶层文件被改写或被删除都会被察觉）、**已投递过 nested 文件的目录**（无需新的触碰即可察觉变化与消失，与上游 `reconcileInstructionContext` 的语义一致）、以及**被触碰路径的父目录及其每个祖先目录（直到该附加根）**。第三类必须走满整条祖先链，因为上游的 discovery 是**向上走**的：考察 `<root>/a/b` 时它会**上报** `<root>/a/AGENTS.md` 这个候选，但下面的“候选必须精确位于本次考察目录”过滤只保留被考察目录自己的候选，于是 `<root>/a` 从未被考察、它的文件也就永远到不了模型——`<root>/a` 必须自己成为一次考察的起点。触碰来自持久化的 `session/event`：`tool/call` 与其 `tool/result` 按 call id 配对，只有**成功**的 `read` / `write` / `edit` 才算触碰（失败的调用可能根本没碰到文件）。第二期不做的事：主根的 nested 发现仍归上游；不识别 `read` / `write` / `edit` 之外的工具名（例如 `str_replace_editor`）；投递状态不跨进程、不跨 resume。
2. **不是 system prompt 贡献。** 指令文本走 user-role 的 `form=instructions` 消息，不进 `systemPrompt.context`。把一个用户可写文件变成 system authority 会抬高它的权限层级，而它并不具备该层级。
3. **切入点是 `agent/pre-step`，不是 session 生命周期事件。** `pre-step` 是 awaited waterfall，因此发现、读取、渲染都在它服务的那一步**之前**确定性完成（含第一步）；同步的 `systemPrompt.context` 回调无法 await，emit 式的生命周期监听会与第一步竞争。此外 `agent/session-start` 在 `0.1.6-alpha.1` 已被删除，挂生命周期事件会额外引入一条版本分支。
4. **发现被钉在根上，起点是该次考察的目录。** `projectRoot` 始终是该附加根（上行走到根为止），`cwd` 是被考察的那个目录（顶层考察时等于根自身，nested 考察时是子目录），再加上 canonical 包含过滤——这就是把 `$DSH_HOME/AGENTS.md`、主根（含其 nested 文件）、以及任何祖先目录的文件挡在外面的机制（上游已经在管它们，不需要本插件再注入一遍）。
5. **预算全局共享。** `maxBytes` 默认 65536，是**全部附加根合计**的预算，不是每个根一份；各根按 scope 顺序消耗。否则 10 个根理论上会额外吞掉 640 KiB context。非正预算等于关闭该行。一个根内部的目录按「浅 → 深」渲染，同一目录内保持 discovery 顺序；撤销与撤回文案不计入预算（被截断的撤回比超预算更糟）。
6. **投递状态按 session、按 scope 记录。** scope 身份是 `(根, 相对目录, 文件名)` 三元组；记录的是**文件内容**的 SHA-256，内容不变就不重复注入，内容变化则重发该文件。之所以按 scope 而不是按根：同一根的不同目录必须能各自增量更新。状态在进程内存里（`WeakMap`，键为 session 对象），因此 resume 之后可能把已经给过的指令再给一次——这是与第一期相同的取舍，换来的是"不猜、不落盘"。
7. **撤销与撤回必须显式。** 根被移除、消失（`missing`）或被替换（`redirected`，见 ADR-0004 的"不授予"语义）时，必须注入一条明确的**撤销**文案；一条已投递的指令文件在考察中被判定"不再存在"时，必须注入一条明确的**撤回**文案（点名该文件的绝对路径）。理由是同一个：历史对话里原来的指令仍然存在，沉默不等于撤回。"目录走查本身失败"不构成撤回（读不到 ≠ 不存在），"候选存在但被体积上限或读取失败过滤掉"同样不构成撤回。
8. **零贡献是硬不变量。** 零附加根、无 `fs` seam、无 agent、或上游 `agent-instructions` 不存在时，该行一条 message 都不注入，空根组合与未装插件保持逐字节一致（`fs` 与 `agent-instructions` 都是软依赖）。
9. **渲染走适配层。** 业务层只调用 `src/compat/agent-instructions.ts` 的 `renderInstructions(...)`；该层按**导出名**结构探测（`renderAgentInstructions ?? renderWorkspaceContext`，见 ADR-0009）。业务代码不写版本判断。**消息构造同样走适配层**：`{ kind: 'plugin', form: 'instructions' }` 的 user message 由 `src/compat/llm-message.ts` 的 `createInstructionMessage()` 构造，它在**真正要构造消息的那一刻**才 `await import('@deepseek-ai/dsh-llm')`——该包是**可选 peer**，静态值导入它会让一个从不构造任何消息的最小组合在加载 carrier loader 行时就失败（ADR-0009 第 4 条）。peer 缺失时它抛出带原因的 `Error`，而不是静默丢弃这段上下文。

## Alternatives Considered

| 方案 | 否决理由 |
| --- | --- |
| 用 `systemPrompt.context` 注入指令文本 | 把 producer-supplied context 提升成 system authority；用户可写文件不该获得该层级 |
| 挂 `agent/session-start` 或 emit 式生命周期事件 | `0.1.6-alpha.1` 已删除该事件，且 emit 监听会与第一步竞争；会多出一条版本分支 |
| 用 `tools/result` cordis 事件取触碰（上游的做法） | 该事件的类型声明属于 `@deepseek-ai/dsh-tools`，本插件并不依赖该包：用它在业务层要么新增依赖、要么 cast。`session/event` 是已类型化、已在依赖图里的缝，且两个受支持版本都提供 |
| 复用上游 `reconcileInstructionContext` 的增量机制 | 需要 `SessionMessageProjection`、版本缓存等未公开语义；跨版本复用等于把上游内部结构写进本插件，违反 ADR-0002/ADR-0009。本行只复用**语义**（被考察目录的集合、撤销而非沉默） |
| nested 目录只在"有触碰的那一步"重新考察 | 已投递的 nested 文件在被改写或被删除后，只要没有新的触碰就永远保持旧文本；上游的 reconcile 也是在每次求值时重看全部有效 scope |
| 为**主根**也做 nested 发现 | 那是上游 `agent-instructions` 的职责：两份实现会在模型上下文里打架 |
| 每个附加根各给 64 KiB 预算 | 预算随根数量线性膨胀，根多时静默挤占 context |
| 根离场、文件消失后只是不再发送 | 历史 conversation 里的指令仍然生效，模型会继续按已撤销的规则工作 |
| 只发一次、不做去重 | 长会话每一步都重复同一段文本，纯浪费 context |

## Consequences

- 模型在会话第一步之前就能看到每个附加根顶层的规则；它真正工作过的子目录里的规则，会在下一次 model step 之前补上。主根（含其 nested 文件）与 user-global 的指令链仍由上游负责，不重复注入。
- 额外的 context 开销有上界：全部附加根合计一份 64 KiB 预算，且一个文件的内容未变就不重发。
- 目录考察的代价有上界：每一步考察的目录 = 根 ∪ 已投递 nested scope 所在目录 ∪ 本次触碰路径的父目录及其每个祖先目录（直到该附加根）（去重）；每 session 的投递 scope 上限 512、待用触碰上限 64，触顶即停发 nested 并只告警一次（“降级但正确”）。
- 撤销与撤回语义使"根被移除 / 被替换"和"已投递的指令文件消失"都在模型侧可观测，而不是只撤了授权却留着指令。
- **已知限制**：nested 文件只会在其目录**被考察到时**重新检查（根层每一步，nested 依赖已投递目录或新的触碰）；投递状态是进程内的，resume 之后可能把已给过的指令再给一次。
- 验收判据落在需求文档 §5 的 7.8，回归测试在 `tests/instructions.spec.ts`，端到端证据是 `pnpm smoke:journey` 两条腿里"触碰后才注入 nested 文件"的断言。

## 返工补充（2026-09-15，PR #1 评审）

PR #1（head `507c954`）的 P1-2 指出：`planRoot()` 只把**被触碰文件自己的目录**加入被考察目录集合，于是 `<root>/a/b/file` 的触碰虽然让上游 discovery 上报了 `<root>/a/AGENTS.md`，却被“候选必须精确位于本次考察目录”的过滤丢掉——中间目录的指令永远到不了模型。修复是让 `planRoot()` 沿父目录逐级上溯直到附加根（第 1 条已改写）。证据：`tests/instructions.spec.ts` 的新用例（触碰 `repo-b/src/deep/entry.mjs` 后，下一步同时含 `src/AGENTS.md` 与 `src/deep/AGENTS.md`），端到端证据是 `pnpm smoke:journey` 两条腿中“中间目录 + 更深目录”各两条断言。

同时（P2-4）：消息构造收进 `src/compat/llm-message.ts`，`@deepseek-ai/dsh-llm` 按需加载（第 9 条）。

## Related Documents

- [ADR-0004 Root 注册表的持久化形态与校验语义](./ADR-0004-root-registry-persistence-and-validation.md)（`missing` / `redirected` 不授予）
- [ADR-0009 DSH 兼容性代码契约](./ADR-0009-dsh-compat-contract.md)（门禁、适配层、结构探测）
- [架构文档 §6.1](../architecture/multi-root-workspace.md)
- [需求文档 §4/§5](../requirements/multi-root-workspace.md)
- [compat 计划 §5/§5b](../plans/completed/2026-09-15-dsh-compat-contract.md)
