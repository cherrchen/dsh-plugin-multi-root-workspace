# Auto Review 多基线接口审查（DSH 0.2.1-rc.2 之后）

2026-11-14 对上游发布 tag 做只读源码对照，范围是 Auto Review 可选集成从 `0.2.1-rc.2` 之后的全部受支持发布：`0.2.1-rc.3`、`0.2.1-rc.4`、`0.2.1-rc.5`、`0.2.2-alpha.2`、`0.2.2-alpha.3`、`0.2.2-rc.1`、`0.2.2-rc.2`、`0.2.2-rc.3`。执行进度、平台证据与支持声明只记[路线账本](../plans/active/2026-09-12-multi-root-workspace.md)，适配设计与阶段验收见[适配计划](../plans/active/2026-11-14-auto-review-multi-baseline.md)。本文件不修改上游 checkout。

## 版本拓扑与基线分组

| tag | commit | auto-review `src/index.ts` blob |
| --- | --- | --- |
| `dsh-v0.2.1-rc.2` | `687f282e8625c6b8d11ff58211a90524be2e4317` | `d4975b54f5` |
| `dsh-v0.2.1-rc.3` | `1f81c047fc48fa190a683e469daa699857e9afe8` | `d4975b54f5` |
| `dsh-v0.2.1-rc.4` | `504a01a9578abc2c6f1fb896b1dc322c9fe24f66` | `d4975b54f5` |
| `dsh-v0.2.1-rc.5` | `b830ec950faba0a46dda564be3e2d854afed94f1` | `d4975b54f5` |
| `dsh-v0.2.2-alpha.2` | `f3803c96974ad4a94195fb97e5c637e9c2a3afe3` | `f612447720` |
| `dsh-v0.2.2-alpha.3` | `05b1cae8db6e674c5685101494d4eec24652424a` | `29df7771f0` |
| `dsh-v0.2.2-rc.1` | `66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db` | `29df7771f0` |
| `dsh-v0.2.2-rc.2` | `ddac96760b6edf8fa0fe17cbdcf0b512f4c12b2c` | `29df7771f0` |
| `dsh-v0.2.2-rc.3` | `38a6a5c965aa99ab525161efb7cc5cf1fe62fced` | `29df7771f0` |

发布线不是线性的：`0.2.1-rc.5` 与 `0.2.2-alpha.2` 是 `0.2.1-rc.4` 的两个后继兄弟；`0.2.2-alpha.2` 依次经过 `alpha.3` → `rc.1` → `rc.2` → `rc.3`，而 `0.2.1-rc.5` 也在 `0.2.2-rc.3` 的祖先中（两条线随后合并）。因此不能把 `0.2.2-alpha.2` 当作已覆盖 `0.2.1-rc.5`。

三处源码代际决定了 fork 必须按基线分组：

- **基线 A（0.2.1 线）**：`0.2.1-rc.2` 至 `0.2.1-rc.5` 的 auto-review 源码完全相同，仅 package version 随发布改写。
- **基线 B（0.2.2 线）**：`0.2.2-alpha.3` 至 `0.2.2-rc.3` 源码相同；`0.2.2-alpha.2` 与它们的差异只有两处请求身份字段（见下），其余协议、角色、schema、locale、故障码与生命周期语义一致。

## 基线 B：从 rc.2 到 alpha.2 的功能重写

上游 `0.2.2-alpha.2` 对 `packages/experimental/auto-review/src/index.ts` 的净改动为 268 行（新增 174 / 删除 94 附近），相关提交包括 `feat(headless): support unattended experimental Auto review`、`fix(auto-review): send one message per review item so message-end caches hit`、`fix(auto-review): keep inherited creation prompts as facts`、`fix(auto-review): preserve Auto during application shutdown`。改动不是增量 API，而是 reviewer 输入模型的替换：

| 维度 | 基线 A（rc.2 代） | 基线 B（alpha.2 代） |
| --- | --- | --- |
| 请求结构 | 单条 user message，按 `REVIEW_POLICY`/`ENVIRONMENT`/`PROJECT_INSTRUCTIONS`/`FILTERED_HISTORY`/`PENDING_ACTION` 五段拼接 | 固定 policy 作为 `system`，环境为首条 user message，其余每个保留项一条 user message；历史按 Session 顺序追加，待审调用是最后一条 |
| 角色名 | `human-instruction` | `user-instruction`（policy 同步改写为 "user"，并说明来源 metadata 不能升级角色） |
| 项目指令 | 独立 `projectInstructions` 数组，`snapshotAutoReview` 分别产出 history 与待审动作 | constraint 项直接进入 history；`tool-schema` 项在同类工具第一次调用前出现一次；待审调用为 `{key, schema}` |
| 前缀缓存 | 每次请求重新拼接整段；上游无跨请求缓存 | 每次审查把上次的待审调用作为历史重放，按 message 追加，供只按 message 边界缓存的 provider 复用；`ShownSchemas` 按 Session 记录已展示 schema |
| 子会话创建提示 | 只识别 `subagent` 自身创建提示 | `creationPrompts` 同时识别当前与继承 Session 的模型创建提示；继承的创建提示降为 fact |
| 失败与本地化 | 失败是普通 deny；`displayReason` 内联 en/zh | 失败带 `AutoReviewFailedError`/`AUTO_REVIEW_FAILED`；`deniedDisplayReason()` 提供 en/zh/ja/es/fr/de/ru/pt |
| 卸载 | 卸载即迁移存活 Auto Session | 只在插件行被实时移除时迁移；整应用关闭时保留 Auto 选择（`ctx.root.fiber.state === FiberState.ACTIVE`） |
| 依赖类型 | 无需额外 type augmentation | 新增 `@deepseek-ai/dsh-tool-executor-ptc/types`（PTC 事件来源）与 `RequestMessage`；使用 `FiberState` 值导出 |
| 测试 | `auto-review.spec.ts` 1832 行 | `auto-review.spec.ts` 2083 行，新增前缀缓存、headless reviewer fixture、shutdown/restart 语义 |

`0.2.2-alpha.2` → `0.2.2-alpha.3` 的源码差异（`fix(auto-review): route review requests by their Session`）只有：

1. `declare module '@deepseek-ai/dsh-llm/types' { interface LlmRequestPurposeMap { 'auto-review': true } }`；
2. `GenerateOptions` 增加 `sessionId: agent.session.id` 与 `purpose: 'auto-review'`。

该差异必须按发布保留：`0.2.2-alpha.2` 的 `GenerateOptions.purpose` 仍是 `'compaction' | 'session-title'`，deepseek adapter 会把 `purpose` 原样放进 request extension，而 alpha.2 的 extension 类型也只接受这两个值，未知 purpose 属于未验证的 provider 输入。因此 `0.2.2-alpha.2` 必须按它自己的官方行为不发送这两个字段；alpha.3 起发送。这是基线 B 内唯一按精确发布分支的行为差异。

`0.2.2-rc.1` → `rc.2` 只改 auto-review 的 `files`（发布源码与声明映射），`rc.2` → `rc.3` 只改 version。

## 被 fork 消费的接缝在 0.2.1→0.2.2 的变化

| 接缝 | 变化 | 对 fork 的影响 |
| --- | --- | --- |
| `dsh-tools` 工具执行 | `0.2.2-alpha.2` 拆出独立 executor（`tool-executor-native`/`tool-executor-ptc`），`ctx.tools.execute` 改为批量 `{calls}`，新增 `setExecutor`；`ToolExecution` 仍有 `token`/`rootCallId`/`schema`/`parent`，`tools/pre-execute` 与 `tools/execute` waterfall 保留 | fork 的 listener 与 `exec.token` 关联逻辑不变；测试与冒烟 fixture 的“单发 execute”需按批量/单发双形态适配 |
| `dsh-llm` | `GenerateOptions.sessionId` 自 rc.2 已存在；`purpose` 从闭集变为 `LlmRequestPurposeMap` 声明合并（alpha.3）；`BlockAssembler`、`RequestMessage`、`StreamChunk` 形状未变 | 基线 A 不需要这些字段；基线 B 在 alpha.3 起加入，alpha.2 保持官方行为 |
| `dsh-session` | `snapshotEvents`、`surface.nodes`、`requestHeader`、`isOwnSeq` 与 `tool/call`、`tool/ptc-dispatch-start` 等事件形状未变；新增 `developer/message`、`system/message` 等无关变体 | 两代 snapshot 代码均可继续使用 |
| `dsh-permission-presets` | `AUTO_PRESET`、`registerAuto`、`current`、`set`、`names` 未变 | 无适配 |
| `dsh-working-directory` | `ensure(agent, signal)` 未变；rc.3 前新增错误类只影响错误分类 | 无适配 |
| `dsh-agent` | `AgentRegistry` 新增 `inject: ['sessionProjections']` | 只影响测试栈挂载顺序（既有 `tests/auto-review/parent.ts` 已处理） |
| `cordis` | 4.0.x → 4.1.0；`FiberState` 在所有 tag 都是 `export const enum`（类型层），发布包 `lib/index.js` 不导出运行时值；官方 auto-review 的已发布 bundle 内联为 `ctx.root.fiber.state === 2` | 基线 B 的 fork 必须把 `FiberState.ACTIVE` 改写为带注释的字面量 `2`，否则打包产物会保留一个宿主不存在的值导入；两代实现必须按车道**动态加载**，不能静态同时导入 |
| Node engines | `0.2.2` 起 `>=24.9` | CI 车道 Node 版本已按发布前缀分流，无需新增判断 |

结论：`0.2.1-rc.3`–`rc.5` 对基线 A 的 fork 是**接口与运行时兼容的纯版本提升**；`0.2.2` 线需要一份按 `0.2.2-alpha.3` 基线重做的 fork（alpha.2 复用同一实现，仅按精确发布省略请求身份字段）。不需要第三份实现。

## 对本插件适配的含义

- 支持集合从单一精确版本扩展为“基线 + 发布集合”，并继续以精确发布为声明单位；每份 fork 仍以固定上游 tag 的逐字节源码为基线，差分门禁按基线独立运行。
- 两份实现不能静态同时进入宿主模块图（基线 B 的 `dsh-tool-executor-ptc/types` 与 `LlmRequestPurposeMap` 噪声、以及平台差异），入口必须按已安装发布选择并动态加载对应实现；两个 bundle 都进入 tarball，但每个车道只执行其中一份。
- 每份实现只在基线的编译 pin（0.2.1 线取 `0.2.1-rc.5`，0.2.2 线取 `0.2.2-rc.3`）上做实现类型检查：`0.2.2-alpha.2` 的 `purpose` 仍是闭集，同一源码无法在该发布的 .d.ts 下同时通过类型检查；运行时不变量由该车道的完整单测与冒烟覆盖。
- 类型检查必须按车道只编译当前基线，否则 0.2.1 车道会因基线 B 的 `@deepseek-ai/dsh-tool-executor-ptc/types` 等新包解析失败；构建（打包）不受影响，因为上游包是 external。
- 官方回归测试、上下文测试与差分门禁都要按基线成对维护；冒烟电池（真实 profile 的 reviewer 请求与写围栏）需要能跨两代解析消息结构，并对 `ctx.tools.execute` 的批量/单发形态做结构探测。
- 上游在 0.2.2 线新增的前缀缓存语义改变了 reviewer 输入的可复用性；多根约束的插入位置必须保持“环境消息固定、历史只追加”的前提，否则会破坏上游刚建立的缓存前缀，fork 的允许差异需要显式记录这一点。

## 证据边界

本文只记录 tag 源码事实与接口判断；没有在本机运行 0.2.2 之前的任意宿主，也没有把源码兼容当成执行验证。每个基线支持声明的依据是该发布在 CI 矩阵车道上的真实安装树、完整单测与联合冒烟，以及本机对活跃开发 pin 的完整门禁；执行证据只写[路线账本](../plans/active/2026-09-12-multi-root-workspace.md)。
