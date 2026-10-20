# Multi-root Workspace 与 Auto Review 接缝调研

调研日期：2026-10-18。本文记录已核实的上游源码事实；适配设计与实施步骤见[适配计划](../plans/completed/2026-10-18-auto-review-context-adaptation.md)。进度和支持声明只记[路线账本](../plans/active/2026-09-12-multi-root-workspace.md#进度总账)。

## 基线与证据范围

| 对象 | 本次核对基线 |
| --- | --- |
| 本插件 | `package.json` 为 `0.1.8`，检出 commit `15c1d26351d069242944aa1f276e6e85aa743632`；调研开始时工作区干净 |
| 上游 | `dsh-v0.2.1-rc.2`，commit `687f282e8625c6b8d11ff58211a90524be2e4317` |
| 已安装运行时 | 本插件安装树中，从 `@deepseek-ai/dsh/package.json` 锚定解析的 Auto Review、tools、llm、permission-presets、working-directory 均为 `0.2.1-rc.2` |

用户提供的上游 checkout 最初停在 `dsh-v0.2.0-rc.2`（`639ed01539`）。经用户授权，在确认没有未提交改动后切到上述 `0.2.1-rc.2` tag；没有编辑上游源码，也没有重装其依赖。本次以 tag 源码和本插件已安装的发布包交叉核对，不将 checkout 原有的构建产物或 node_modules 当作新 tag 的运行证据。

**上游事实：官方审查入口不包含完整的多根上下文。** 本仓库当前采用显式启用的 companion fork 补齐，设计见 [ADR-0021](../decisions/ADR-0021-auto-review-context-companion.md)；运行证据、平台与支持范围只记路线账本。下表保留未适配的官方入口行为。

## Auto Review 实际获取的上下文

上游源码链接均固定到该 commit：

| 接缝 | 已核实行为 | 源码 |
| --- | --- | --- |
| 注册入口 | 包入口只公开 `name`、`inject`、`apply`；`ReviewSnapshot`、快照构造、提示词与决策解析均非公开接口 | [Auto Review](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/experimental/auto-review/src/index.ts) |
| 调用阶段 | 在置前的 `tools/pre-execute` listener 中审查；只审查有 agent 且当前 preset 为 Auto 的执行；外层 `run_code` 跳过，其已开始的 PTC inner calls 分别审查 | 同上 `apply` |
| 环境 | `workingDirectory.ensure(agent, signal)` 得到 effective cwd；`ENVIRONMENT` 只渲染 `{ cwd }` | 同上 `classifyRisk`、`reviewUserText` |
| 项目约束 | 只把可见 surface 中 `source.kind === 'agent-instructions'` 的 user message 放入 `PROJECT_INSTRUCTIONS`，标为 `constraint` | 同上 `isProjectInstruction`、`snapshotAutoReview` |
| 历史 | human、direct-parent、checkpoint 分别分类，其他 user 文本通常为 `fact`；保留历史工具调用的名字、参数 | 同上 `textRole`、`filteredUserEntries` |
| 排除内容 | 不继承主 agent 的 system message、assistant 正文/reasoning、tool results；`kind: 'tool'` 的 user message 也排除 | 同上 surface 遍历；[上游回归](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/experimental/auto-review/tests/auto-review.spec.ts) |
| 待审动作 | native schema 来自 request header，并与日志核对；PTC 使用可信执行元数据里的 binding schema，并核对持久化 dispatch 身份 | 同上 `nativeAction`、`ptcAction` |
| 模型请求 | 使用主 agent 当前 header 的 provider/model，固定 `REVIEW_POLICY`，冻结请求后直接调用 `ctx.llm.stream`；没有 tools schema 赋予 reviewer 主动读文件的能力 | 同上 `classifyRisk` |
| 拒绝/故障 | reviewer deny 在 `never` 下最终拒绝；`ask` 下只有后续 listener 允许时才交人工审批；格式错误、技术故障使调用失败 | 同上 `apply`、`failed` |
| 生命周期 | 卸载关闭准入、将存活 Auto session 迁移到 Full access，再中止并等待在途 review 结束，撤回 listener/contribution | 同上 `apply` |

与 `0.2.0-rc.2` 相比，本文件的关键差异是新增 `workingDirectory` 注入并使用 effective cwd，五分区与来源分类规则没有变化。因此不能把 `session.header.cwd` 当作 `0.2.1-rc.2` reviewer 的当前目录。

## 未启用 companion 时如何进入审查视野

| 能力 | 当前实际状态 | 依据与边界 |
| --- | --- | --- |
| 两插件装配 | 普通插件与官方 Auto 可共存；显式 companion 替代 owner 的证据见路线账本 | Auto Review 增加 pre-execute listener/preset contribution；本插件替换 fs/sandbox 并包装进程面，职责分离不等于运行验证 |
| 附加根工具调用 | 在满足 Auto 条件时进入相同审查入口 | 路径/参数可见；工具名字或路径本身不证明该根已登记 |
| 多根拓扑 | 没有结构化输入 | [scope](../../src/scope.ts) 的拓扑通过 `systemPrompt.context` 贡献；reviewer 不继承这个 system 内容 |
| 根访问策略 | 不知道 `inherit` / `read-only` / `read-write` 与当前工具的有效交集 | 注册策略、会话 mode、tool cap、authority 和 deny 边界不能只用一个“可写根列表”替代 |
| 附加根指令 | 插件自行发出的消息在可见 surface 中通常归 `fact` | [消息适配器](../../src/compat/llm-message.ts) 在 format 4 使用 `kind: 'multi-root-workspace'`，旧格式使用 `plugin`，均不匹配上游的唯一项目来源 |
| native 重叠指令 | 可能已作为 `constraint` 可见 | cwd 进入附加根时，上游 native discovery 可能已覆盖同一文件；本插件[按绝对路径和摘要去重](../../src/compat/instruction-overlap.ts)。不能笼统声称所有附加根指令都是 fact |
| 文件内容 | 没有独立的目标文件快照，也不继承历史 read 的结果 | `write` 参数中的新内容、`edit` 的 old/new 片段，以及历史工具调用参数仍可能可见；“完全看不到文件内容”不准确 |
| 执行围栏 | 源码已覆盖 Full-access 下的显式只读根及其他拒写边界 | [fs](../../src/fs.ts)、[sandbox](../../src/sandbox.ts)、[process-fence](../../src/process-fence.ts) 共用 scope；联合执行证据与未覆盖平台见路线账本 |

这里的“未适配”主要指 reviewer 无法从可信宿主获取当前多根视图，不代表必须把主 agent 的整个 system prompt 或历史工具结果复制过去。上游有意区分授权指令、只能收窄的约束和事实，这一边界应保留。

## 容易遗漏的四个问题

### 审查早于 tool cap 的 ALS 上下文

上游 tools 先执行 `tools/pre-execute`，获准后才执行 `tools/execute`（[调度实现](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/core/tools/src/index.ts)）。本插件在后者通过 [aroundTool](../../src/compat/tool-context.ts) 建立 ALS cap。

[scope.resolve](../../src/scope.ts) 在没有 dispatch 上下文且配置了任一 `toolAccess` 时，刻意采用最严格 cap。因而 pre-execute 时直接 `resolve(policy)` 会把一个实际未受限工具的附加根也描述为不可写。PTC 内层的审查还可能处于外层 dispatch 的 cap 中，必须保留父层收窄。适配需要同源的只读“待执行工具视图”，而非在 reviewer 前伪造执行上下文或另算权限表。

### 历史增量不是当前约束集合

[instructions](../../src/instructions.ts) 发送新增/变更、文件消失和根撤销消息；delivery state 只记 scope、摘要等信息。把所有 `multi-root-workspace` 历史消息简单升级为 `constraint`，会同时保留旧文本、撤回文本和更新文本；压缩或 surface 变化还可能使历史不完整。reviewer 应读取当前有效约束快照，旧消息继续保留事实身份，不从历史 prose 反推现行授权。

### 第一次操作子目录时尚未产生成功 touch

主 agent 的 nested discovery 由成功 `read/write/edit` 的持久化事件驱动。首次直接 edit `B/src/index.ts` 时，`B/src/AGENTS.md` 可能还没有注入。审查若要遵守该路径约束，应额外考察待审 fs 目标的父目录至根的链；这属于 reviewer 的只读发现，不能伪记成成功 touch 或改变主 agent 的投递状态。bash/pwsh 无法靠任意参数或命令文本可靠枚举全部目标，应明确这一局限。

### Full access 不等于“只有登记根可访问”

Auto 是权限 preset，其底层 sandbox mode 为 `danger-full-access`，并不新增一个 multi-root mode。健康 authority 下，本插件继续执行明确的 deny/tool cap；未登记路径不因“不是附加根”自动成为禁止读取或 Full-access 禁写路径。显式只读也是写限制，不能描述为读取隔离。authority unavailable 时则按现有规则收窄为主根写入，deny 仍优先；进程和已启动 kernel snapshot 的边界见 [ADR-0017](../decisions/ADR-0017-three-state-root-access-and-sandbox-modes.md)。

## 可用扩展面与局限

专用 Auto Review 上下文贡献接口目前不存在；这不同于“上游完全没有可扩展接缝”。

- `tools/pre-execute` 是公开 waterfall，可增加单调拒绝/审批逻辑，但 `next()` 不接受一个替换过的 review snapshot，不能直接补给既有 reviewer。
- [LLM runtime](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/llm/llm/src/index.ts) 有公开 `llm/stream` waterfall，允许观察/包装/短路 stream。可是 review 请求没有专用 purpose/session/action 标记，且 Auto 自己 deep-freeze 请求；`next()` 也没有替换 options 的参数。使用 ALS、识别 policy/分区文本、克隆后重新发请求理论上可做，但会依赖 listener 顺序、私有提示词形状、重入和 retry/replay 语义，不能当作稳定的专用接口。
- 伪装成 `agent-instructions` 会占用上游 baseline/changes 协调来源；伪装 human 或 direct-parent 会错误提高权威，均不应采用。
- 在下游追加第二次独立 review 无法纠正上游第一次 review 的上下文缺失，还会产生双重审查和费用。
- 外部 bundle 可以替换 `auto-review` loader 行，以本地 fork 保留上游 gate/lifecycle，仅替换快照拼装。这不编辑上游包，符合 out-of-tree 约束，但需要明确的 fork、精确基线、差分测试和可选启用机制。

据此，短期路线已定案为**显式启用的独立 companion，固定 fork 该版审查入口**，长期迁移到正式 context contribution API。当前接口与失败边界见 [ADR-0021](../decisions/ADR-0021-auto-review-context-companion.md)，安装及同步步骤见 [companion](../../compat/auto-review/README.md)。普通支持列表和发布版本不因该可选集成自动改变；本次不提交上游提案。
