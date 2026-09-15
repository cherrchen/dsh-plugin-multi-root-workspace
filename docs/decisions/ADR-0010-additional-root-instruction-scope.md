# ADR-0010: 附加根指令注入的范围与分期

## Status

Accepted

## Date

2026-09-15

## Context

上游 `agent-instructions` 从一个 session cwd **向上走**发现指令文件（`AGENTS.md` / `CLAUDE.md` 及各自的 local overlay），外加一个 user-global 文件。多根工作区里这条上行路径**永远到不了附加根**：`repo-b/AGENTS.md` 对一个被允许写 `repo-b` 的模型是不可见的。这是"多根可写沙箱"与"多根 coding workspace"之间最直接的语义缺口——权限已经放开，规则却没有送达。

同时上游对 **primary workspace** 已经在做两层发现：启动时的基线（session cwd 向上），以及成功 `read` / `write` / `edit` 之后按 touched path 的 nested instructions 更新。后者依赖 tool-result 投影语义；该语义在 `0.1.6-alpha.1` 引入了 `SessionMessageProjection`，需要独立评估。

可用的投递通道是 DSH message model 自带的：

```ts
createUserMessage({
  content: [{ type: 'text', text }],
  source: { kind: 'plugin', plugin: '@dsh-electron/dsh-plugin-multi-root-workspace', form: 'instructions' },
})
```

它仍是 **user role** 的 producer-supplied context，不会被提升成 system authority，且随请求落 model history（满足 model-visible ⟺ logged）。

## Decision

1. **范围只到附加根的顶层。** 每个附加根按 `discoverBaselineInstructionFiles({ cwd: root, projectRoot: root })` 发现，再以 canonical 包含过滤，只保留位于该根内部的文件。**nested instructions（H4 Phase 2）本期不做**；恢复的前置条件是先完成 `SessionMessageProjection` 评估，再决定如何复用 primary 的 touched-path reconcile 语义。
2. **不是 system prompt 贡献。** 指令文本走 user-role 的 `form=instructions` 消息，不进 `systemPrompt.context`。把一个用户可写文件变成 system authority 会抬高它的权限层级，而它并不具备该层级。
3. **切入点是 `agent/pre-step`，不是 session 生命周期事件。** `pre-step` 是 awaited waterfall，因此发现、读取、渲染都在它服务的那一步**之前**确定性完成（含第一步）；同步的 `systemPrompt.context` 回调无法 await，emit 式的生命周期监听会与第一步竞争。此外 `agent/session-start` 在 `0.1.6-alpha.1` 已被删除，挂生命周期事件会额外引入一条版本分支。
4. **发现被钉在根自身。** `cwd` 与 `projectRoot` 都取该附加根，再加上 canonical 包含过滤——这就是把 `$DSH_HOME/AGENTS.md`、主根的 `AGENTS.md`、以及任何祖先目录的文件挡在外面的机制（上游已经在管它们，不需要本插件再注入一遍）。
5. **预算全局共享。** `maxBytes` 默认 65536，是**全部附加根合计**的预算，不是每个根一份；各根按 scope 顺序消耗。否则 10 个根理论上会额外吞掉 640 KiB context。非正预算等于关闭该行。
6. **每 session 按根记录已交付文本的摘要**，内容不变就不重复注入；只重发发生变化的那一个根。
7. **撤销必须显式。** 根被移除、消失（`missing`）或被替换（`redirected`，见 ADR-0004 的"不授予"语义）时，必须注入一条明确的撤销文案：历史对话里原来的指令仍然存在，沉默不等于撤回。
8. **零贡献是硬不变量。** 零附加根、无 `fs` seam、无 agent、或上游 `agent-instructions` 不存在时，该行一条 message 都不注入，空根组合与未装插件保持逐字节一致（`fs` 与 `agent-instructions` 都是软依赖）。
9. **渲染走适配层。** 业务层只调用 `src/compat/agent-instructions.ts` 的 `renderInstructions(...)`；该层按**导出名**结构探测（`renderAgentInstructions ?? renderWorkspaceContext`，见 ADR-0009）。业务代码不写版本判断。

## Alternatives Considered

| 方案 | 否决理由 |
| --- | --- |
| 用 `systemPrompt.context` 注入指令文本 | 把 producer-supplied context 提升成 system authority；用户可写文件不该获得该层级 |
| 挂 `agent/session-start` 或 emit 式生命周期事件 | `0.1.6-alpha.1` 已删除该事件，且 emit 监听会与第一步竞争；会多出一条版本分支 |
| 本期把 nested instructions 一起做 | 需要 tool-result 投影语义（`SessionMessageProjection`）；未评估就复用 primary 的 reconcile 相当于重新实现一遍上游机制 |
| 每个附加根各给 64 KiB 预算 | 预算随根数量线性膨胀，根多时静默挤占 context |
| 根离场后只是不再发送 | 历史 conversation 里的指令仍然生效，模型会继续按已撤销的规则工作 |
| 只发一次、不做去重 | 长会话每一步都重复同一段文本，纯浪费 context |

## Consequences

- 模型在会话第一步之前就能看到每个附加根顶层的规则；主根与 user-global 的指令链仍由上游负责，不重复注入。
- 额外的 context 开销有上界：全部附加根合计一份 64 KiB 预算，且内容未变不重发。
- **已知缺口**：附加根子目录里的 nested instructions 不会进入模型上下文（H4 Phase 2），已登记进需求文档 §4 第二期。
- 撤销语义使"根被移除/替换"在模型侧可观测，而不是只撤了内核授权却留着指令。
- 验收判据落在需求文档 §5 的 7.8，回归测试在 `tests/instructions.spec.ts`。

## Related Documents

- [ADR-0004 Root 注册表的持久化形态与校验语义](./ADR-0004-root-registry-persistence-and-validation.md)（`missing` / `redirected` 不授予）
- [ADR-0009 DSH 兼容性代码契约](./ADR-0009-dsh-compat-contract.md)（门禁、适配层、结构探测）
- [架构文档 §6.1](../architecture/multi-root-workspace.md)
- [需求文档 §4/§5](../requirements/multi-root-workspace.md)
- [compat 计划 §5/§5b](../plans/completed/2026-09-15-dsh-compat-contract.md)
