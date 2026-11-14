# Auto Review 多基线适配计划（DSH 0.2.1-rc.2 之后）

> 状态：执行中。上游事实见[多基线接口审查](../../reference/auto-review-0.2.2-migration.md)；既有能力基线见 [ADR-0021](../../decisions/ADR-0021-auto-review-context-companion.md) 与 [ADR-0022](../../decisions/ADR-0022-auto-review-loader-entry.md)，本批的多基线合同见 [ADR-0040](../../decisions/ADR-0040-auto-review-multi-baseline.md)。进度、平台证据与发布状态唯一真源是[路线账本](./2026-09-12-multi-root-workspace.md#进度总账)。

## Goal

把可选 Auto Review 集成从“仅精确支持 DSH `0.2.1-rc.2`”扩展为覆盖普通支持合同 `0.2.1-rc.2` 之后全部 8 个发布：`0.2.1-rc.3`、`0.2.1-rc.4`、`0.2.1-rc.5`、`0.2.2-alpha.2`、`0.2.2-alpha.3`、`0.2.2-rc.1`、`0.2.2-rc.2`、`0.2.2-rc.3`。每个被声明的发布都要在真实安装树上通过同一组门禁：契约检查、按基线的类型检查、差分门禁、完整单测、真实 profile 的联合冒烟、打包安装检查。

约束：

- 不修改上游仓库任何包；fork 仍以逐字节上游源码为基线，允许差异显式记录并被脚本重建校验。
- 多根上下文、权限投影、来源身份、freshness、审查协议与卸载语义继续遵循 ADR-0021/0022；本批不扩大 reviewer 的授权面，不新增读取目标文件内容的能力。
- 普通插件支持合同（24 个精确版本）不变；本批只把 Auto Review 的联合合同提升到同一发布集合的后 8 个发布。

## 现状：Auto Review 的原理、实现与耦合（Deliverable 1）

### 上游原理

Auto 是权限 preset，其底层 sandbox mode 为 `danger-full-access`。官方 `@deepseek-ai/dsh-experimental-auto-review` 在置前的 `tools/pre-execute` listener 中对每次 native 调用与每个已开始的 PTC 内层调用做一次 LLM 审查：它从当前 Session 的可见 surface 与持久事件重建 reviewer 输入（环境 cwd、项目指令、历史、待审动作与 schema），固定 `REVIEW_POLICY` 风险政策，用主 Agent 当前 header 的 provider/model 发一次 `ctx.llm.stream` 请求，严格解析 JSON 决策；`never` 下 deny 为最终拒绝，`ask` 下 deny 转人工审批。卸载时把存活 Auto Session 迁移为 Full access。官方不继承主 Agent 的 system prompt 或 tool results，也不提供专用上下文贡献接口。

### 本插件实现

- 交付：主包 `./auto-review` 子路径 + 默认 `disabled` 的 `multi-root-auto-review` Loader 行；关闭时无 reviewer、无 context 服务、不注册 Auto preset。
- 接管：`src/compat/auto-review-loader.ts` 在 Loader `internal/plugin` 与 group update 接缝上运行时停用并移除官方行，保证唯一 owner；卸载按官方语义迁移 Session 并恢复官方配置。
- 上下文：`src/review-context.ts` 提供只读 `multiRootReviewContext` 服务，复用既有 scope/registry/instructions 数据源输出 `ReviewContext`（Session origin、effective cwd、sandbox mode、authority、根与有效写/拒写集合、protectedHome、ambientWrites、当前附加根约束、来源根集合、fingerprint）。不建立第二套授权表。
- fork：`src/auto-review/upstream.ts` 保存固定上游源码，`fork.ts` 由 `fork.patch` 明确重建，`scripts/check-auto-review-fork.mjs` 校验基线哈希、patch 重建、policy/身份/协议/注册与卸载尾部的未改动，以及 `api.d.ts` 的导出面。允许差异只有：调用只读 context builder、环境与当前 constraint 数据、native 指令去重/降级、发送前/模型等待后/dispatch 前的 freshness 复核、`tools/execute` 前的 token 关联复核、精确执行副本检查。
- 门禁：`scripts/build-auto-review.mjs` 仅在开发 pin 等于精确基线时对 fork 做实现类型检查；`vitest.config.ts` 只在同一 pin 下运行 `tests/auto-review/**`；`scripts/ci/plan.mjs`/`run-group.mjs` 只在基线车道跑 `auto-review:fork` 与 `smoke:auto-review`；`scripts/upgrade-dsh.mjs` 只在精确 pin 时把 `AUTO_REVIEW_DEVELOPMENT_PACKAGES` 写进开发树。

### 耦合面

| 耦合 | 具体点 |
| --- | --- |
| 源码级 | fork 是上游 `index.ts` 的完整副本；上游改 reviewer 输入模型即要求重做 fork，而不是改一个适配器 |
| 类型/包 | `dsh-llm`（StreamChunk/GenerateOptions/BlockAssembler/RequestMessage）、`dsh-tools`（ToolExecution/PreToolDecision/两处 waterfall）、`dsh-session`（snapshot/surface/requestHeader/isOwnSeq/事件变体）、`dsh-permission-presets`（AUTO_PRESET/registerAuto/current/set）、`dsh-working-directory`（ensure）、`cordis`（effect/on/root.fiber.state/FiberState） |
| 执行副本 | fork 以值导入 `dsh-llm`、`dsh-tools`、`dsh-permission-presets`、`dsh-util-values`，并要求它们与宿主同一精确发布；`assertForkPackages` 校验 |
| 数据模型 | 依赖 Session 事件与 surface 的既有形状、tool call 的 token 身份、`tools/execute` 的 prepend 包装语义 |
| 生命周期 | Loader entry 身份、owner 唯一性、卸载排空与官方行恢复 |

## 上游变更与版本差异（Deliverable 2）

完整事实、tag commit、blob 与逐项差异见[多基线接口审查](../../reference/auto-review-0.2.2-migration.md)。要点：

1. `0.2.1-rc.2` 至 `0.2.1-rc.5` 的 auto-review 源码完全相同（`d4975b54f5`），只有包版本号变化；该线对 fork 是纯版本提升。
2. `0.2.2-alpha.2` 对 reviewer 输入模型做了重写：policy 变为 `system`，每个保留项一条 user message，项目指令以 constraint 项进入 history，`tool-schema` 项按需出现一次，`ShownSchemas` 跨审查复用，角色 `human-instruction` 改名 `user-instruction`，继承创建提示降为 fact，失败带 `AUTO_REVIEW_FAILED`，卸载只在实时移除时迁移 Session。
3. `0.2.2-alpha.2` → `alpha.3` 只新增两个请求身份字段（`sessionId`、`purpose: 'auto-review'`）与 `LlmRequestPurposeMap` 声明；`alpha.3` 至 `rc.3` 源码相同。
4. 被 fork 消费的接缝（tools waterfall/ToolExecution 字段、session snapshot API、presets API、working-directory ensure）在两条线上保持形状；0.2.2 的工具执行拆分只影响测试与冒烟的 `tools.execute` 调用形态，不影响 listener。
5. 发布线非线性：`0.2.1-rc.5` 与 `0.2.2-alpha.2` 是兄弟；两者都在 `0.2.2-rc.3` 的祖先中，必须分别覆盖。
6. `cordis` 4.0.x 没有 `FiberState` 值导出，基线 B 的上游源码使用了它，因此两代实现不能静态同时进入模块图。

## 适配方案（Deliverable 3）

### 基线模型

`AUTO_REVIEW_BASELINES`（`src/compat/auto-review-contract.ts`，单一事实源）：

| 基线 id | 发布 | 编译 pin | fork 上游基线 |
| --- | --- | --- | --- |
| `0.2.1` | `0.2.1-rc.2`、`rc.3`、`rc.4`、`rc.5` | `0.2.1-rc.5`（该线被消费的 .d.ts 与 rc.2 相同） | `dsh-v0.2.1-rc.2` `687f282e86`，`index.ts` `d4975b54f5` |
| `0.2.2` | `0.2.2-alpha.2`、`alpha.3`、`rc.1`、`rc.2`、`rc.3` | `0.2.2-rc.3` | `dsh-v0.2.2-alpha.3` `05b1cae8db`，`index.ts` `29df7771f0` |

编译 pin 是按基线做实现类型检查的唯一开发 pin：`0.2.2-alpha.2` 的 `GenerateOptions.purpose` 仍是闭集，同一份 baseline B 源码无法在该发布的 .d.ts 下通过类型检查；运行时不变量由该车道的完整单测与冒烟覆盖。旧线 rc.2–rc.5 的被消费包源码未变，因此 rc.5 的编译结果覆盖整条线。

`AUTO_REVIEW_RELEASES` 由两张表扁平化得到，仍以精确发布为声明单位；`autoReviewBaseline(release)` 是运行时与所有脚本共用的唯一映射。

### 目录与分发

```
src/auto-review/
  entry.ts                 # Loader entry：契约/执行副本门禁、context 服务、按基线动态加载实现
  api.d.ts                 # 公开子路径声明（导出面与 entry.ts 一致）
  partition.ts             # 基线无关的 native/当前约束核对（A 的 context.ts 算法提取）
  legacy/                  # 基线 0.2.1
    upstream.ts  fork.ts  fork.patch
    context.ts             # 适配旧 history 模型
  current/                 # 基线 0.2.2
    upstream.ts  fork.ts  fork.patch
    locales.ts             # 上游 locales.ts 逐字节副本
    context.ts             # 适配新 history/消息模型
```

- 两份实现各自成为 tsdown host entry（`auto-review-legacy`、`auto-review-current`），`entry.ts` 用 `new URL(..., import.meta.url)` 计算路径动态 `import()` 选中的实现并做最小成员校验后 `ctx.plugin` 挂载。因此 0.2.1 车道的模块图不加载基线 B 的 `FiberState` 导入，也不做无关类型解析。
- 类型检查拆成 `tsconfig.auto-review-legacy.json` 与 `tsconfig.auto-review-current.json`（各自 include 基线目录 + entry/api/partition）；`scripts/build-auto-review.mjs` 按开发 pin 的基线选一个编译，另一份只在 vitsest 对应车道运行。
- `assertForkPackages` 改为按发布校验 `dsh-llm`/`dsh-tools`/`dsh-permission-presets`/`dsh-util-values` 的精确执行副本；`assertAutoReviewRelease` 的报错列出全部支持发布与两个基线。

### 基线 B 的 fork 允许差异

以 `0.2.2-alpha.3` 源码为基线，除既有允许差异外新增/调整：

1. `snapshotAutoReview` 额外接收 `multiRoot: ReviewContext`；constraint 项与历史项的原生指令按 `partition.ts` 核对：可证明为附加根来源且已陈旧的整帧降为 `fact`，由当前快照完全替代的帧丢弃，混合帧仍按既有规则失败关闭。
2. `reviewMessages` 渲染：`ENVIRONMENT` 消息合入 `multiRoot.environment` 与 `executionFence`；当前附加根约束作为 constraint 项插入在环境消息之后、历史项之前（镜像基线 A 的 `PROJECT_INSTRUCTIONS` 位置），保持“环境固定、历史按 Session 顺序只追加、待审调用最后”的上游前缀缓存前提。
3. `classifyRisk`：先 `multiRootReviewContext.build`，校验 effective cwd 一致，发送前与模型返回后 `assertCurrent`；`0.2.2-alpha.2` 不发送 `sessionId`/`purpose`（该发布的官方行为），`alpha.3` 起发送。该分支由 `autoReviewRequestIdentity(release)` 决定，版本知识只出现在 `src/compat/`。
4. `apply`：`assertForkPackages`、`assertCompatible`、`tools/execute` prepend 的 token 关联 fresh 复核（覆盖人工审批等待），以及既有的发送前/下游 gate 后复核。
5. 保留上游新语义：失败 `AUTO_REVIEW_FAILED`、唯一 text block 协议、`deniedDisplayReason`、应用关闭时保留 Auto、`ShownSchemas` 前缀缓存。

### 测试、脚本与 CI

- 测试目录按基线拆分：`tests/auto-review/legacy/`（现有官方回归 + 上下文测试迁入）、`tests/auto-review/current/`（`0.2.2-alpha.3` 官方回归副本 + 新渲染的上下文/围栏测试）；`parent.ts` 与 `loader.spec.ts` 基线无关，保留在 `tests/auto-review/`。`vitest.config.ts` 只包含当前开发 pin 对应基线的目录。
- 差分门禁 `check-auto-review-fork.mjs` 对每个基线分别校验 baseline 哈希、patch 重建、policy/受保护函数、注册与卸载尾部、`api.d.ts` 导出面，并按 `AUTO_REVIEW_BASELINES` 驱动，不再写死单个发布。
- `auto-review-development.mjs` 按基线维护开发包清单（旧线不含 0.2.2 才有的 executor/testkit 包）；`upgrade-dsh.mjs` 按目标发布的基线安装对应清单，避免在 0.2.1 车道写不存在的包。
- `smoke-auto-review.mjs` 在开发 pin 属于 `AUTO_REVIEW_RELEASES` 时运行，报告当前基线；冒烟电池跨两代解析 reviewer 消息（合并全部 message 文本），并对 `ctx.tools.execute` 的批量/单发形态做结构探测。
- `check-dsh-compat.mjs` 校验 `AUTO_REVIEW_RELEASES` 全部属于普通 allowlist；`ci/plan.mjs` 要求矩阵包含全部联合发布；`ci/run-group.mjs` 在每个联合发布车道执行 `auto-review:fork`、`smoke:auto-review` 与完整单测。

## 阶段、提交与退出验收

每个阶段一个提交；进入下一阶段前必须完成本阶段验收并记录命令与结果。

### P0 调研、上游审查与计划（提交 1）

交付：本计划、`docs/reference/auto-review-0.2.2-migration.md`、ADR-0040、`docs/reference/auto-review-compatibility.md` 的基线/接缝状态更新。

退出验收：

- 上游 tag commit/blob、两条发布线拓扑、alpha.2→alpha.3 差异与接缝结论均可由 `git show <tag>:<path>` 复核，文中引用的 SHA 与仓库一致。
- 设计决策（基线分组、动态加载、按车道类型检查、alpha.2 请求身份例外、约束插入位置与前缀缓存前提）已写入 ADR-0040。
- `pnpm docs:check` 通过；`git status` 只含文档改动，源码与门禁行为零变化。

### P1 多基线契约与车道模型（提交 2）

交付：`AUTO_REVIEW_BASELINES`（先只含 `0.2.1`）、`autoReviewBaseline`、按发布的 `assertForkPackages`、`legacy/` 目录迁移（`upstream.ts`/`fork.ts`/`fork.patch`/`context.ts`）、`partition.ts` 提取、`entry.ts` 的基线分发骨架、按基线选择的 `tsconfig.auto-review-*.json` 与 `build-auto-review.mjs`、`vitest.config.ts` 车道门控、`check-auto-review-fork.mjs` 的基线循环、`smoke-auto-review.mjs` 车道门控、`check-dsh-compat.mjs` 的集合校验。

退出验收（本机开发 pin `0.2.2-rc.3` 不在联合集合内，行为应与未安装该集成一致）：

- `pnpm compat:check`、`pnpm lint`、`pnpm typecheck`、`pnpm build`、`pnpm pack:check` 通过；`pnpm test` 全绿且 `tests/auto-review/legacy/**` 被跳过。
- `pnpm auto-review:fork` 通过（单基线循环）；`pnpm smoke:auto-review` 以“当前车道无联合基线”明确跳过并退出 0。
- 基线 A 车道证据：在独立工作树把开发 pin 重指 `0.2.1-rc.5`（该基线编译 pin）后，`pnpm compat:check`、`pnpm typecheck`、`pnpm auto-review:fork`、`pnpm test`、`pnpm build`、`pnpm smoke:auto-review` 全绿；`0.2.1-rc.2` 车道至少 fork + 单测 + build + smoke 通过（该车道不编译实现类型，与既有“只在精确基线车道编译实现”的规则一致）。
- 迁移后的旧版目录内容与迁移前逐字节一致（除导入路径），fork 差分门禁与 `api.d.ts` 导出面校验通过。

### P2 基线 B 实现与分发（提交 3）

交付：`current/` 的 `upstream.ts`（逐字节 `05b1cae8db`）、`locales.ts`、`fork.ts`/`fork.patch`、`context.ts`；契约加入 `0.2.2` 五个发布与 `autoReviewRequestIdentity`；`entry.ts` 两个基线分发；tsdown 两个 entry；基线 B 开发包清单与 `upgrade-dsh` 维护；冒烟电池跨代解析与 `tools.execute` 双形态；`check-auto-review-fork.mjs` 增加 B 的受保护函数/归一化。

退出验收（本机开发 pin `0.2.2-rc.3` 现在是活跃车道）：

- `pnpm compat:check`、`pnpm lint`、`pnpm typecheck`（只编译 B）、`pnpm build`、`pnpm pack:check` 通过；tarball 同时包含 `lib/auto-review.js`、`lib/auto-review-legacy.js`、`lib/auto-review-current.js` 与声明。
- `pnpm auto-review:fork` 通过两个基线的哈希/patch/受保护行为/导出面校验。
- `pnpm smoke:auto-review` 在 source/link 与 packed 两条车道、web/headless × 官方 bundle 前后两种顺序下全部通过：真实 reviewer 请求包含多根环境与当前 constraint，脚本化 allow 对可写根写入成功、对只读根不能写入且原字节不变，行开关的接管/恢复/drain 语义不变。
- 基线 A 源码在基线 B 车道的 bundle 内不执行：入口在 `0.2.2` 车道不动态加载 legacy chunk，日志/断言确认选中基线。
- 基线 B 的 typecheck 不把 `legacy/` 拉入程序（改动 legacy 文件不会使本车道类型检查失败或变慢）。
- Loader 接管在开发 pin 的 cordis loader `1.1.0` 上行为可用：`tests/auto-review/loader.spec.ts` 在本车道真实执行并通过（当前它在 0.2.2 车道被排除，是已知未验证项）；若 loader 内部字段与 `1.0.6` 有差异，只在 `src/compat/auto-review-loader.ts` 做结构探测适配，并补对应回归。

### P3 基线 B 测试套件（提交 4）

交付：`tests/auto-review/current/upstream.spec.ts`（上游 `rc.3` 官方回归副本，按既有方式只调整导入、context stub 与新增环境字段断言）、`tests/auto-review/current/context.spec.ts`（新消息模型下的多根上下文、真实 fs 围栏、PTC、freshness、OPS 交互）、`tests/auto-review/legacy/*` 迁移完成、`vitest.config.ts` 包含当前基线目录。

退出验收：

- 本机开发 pin `0.2.2-rc.3` 下 `pnpm test` 全绿，`tests/auto-review/current/**` 实际执行（不是 skip），`tests/auto-review/legacy/**` 被排除；`tests/auto-review/loader.spec.ts` 与 `overlap.spec.ts` 在每条车道都执行。
- 官方回归副本覆盖前缀缓存追加、inherited creation prompt、shutdown 保留 Auto、失败码、ask/never、PTC 与卸载迁移，且全部通过。
- 上下文测试覆盖：当前拓扑/有效权限写入 reviewer、旧 native 帧降级、附加根指令替换与混合帧失败关闭、fingerprint 在发送前/模型后/下游 gate 后的复核、只读根写失败、authority unavailable 收窄、零附加根不扫描文件。
- `pnpm auto-review:fork` 与 `pnpm docs:check` 通过。

### P4 CI、文档与最终验收（提交 5）

交付：`scripts/ci/plan.mjs`/`run-group.mjs` 在全部联合发布车道执行 auto-review 门禁；`upgrade-dsh.mjs` 按基线维护开发包；README/README.en、`src/auto-review/README(.en).md`、`FORK.md`、`docs/reference/auto-review-compatibility.md`、AGENTS.md 兼容契约段、CHANGELOG 与 CHANGELOG.en、路线账本新记录与表格行、`docs/plans/README` 与完成态迁移。

退出验收：

- 本机开发 pin `0.2.2-rc.3` 完整门禁：`pnpm compat:check`、`pnpm lint`、`pnpm typecheck`、`pnpm build`、`pnpm kernel:probe`、`pnpm test`、`pnpm smoke:compose`、`pnpm smoke:behavior`、`pnpm smoke:journey`、`pnpm pack:check`、`pnpm smoke:packed`、`pnpm auto-review:fork`、`pnpm smoke:auto-review`、`pnpm docs:check` 全部退出 0；平台相关 skip 逐项说明，环境限制导致的失败必须与未改动基线的同环境结果对照，不能记为通过。
- 基线 A 代表性车道（`0.2.1-rc.2` 与 `0.2.1-rc.5`）在独立工作树完成 `typecheck`/`auto-review:fork`/`test`/`build`/`smoke:auto-review` 全绿。
- `CHANGELOG` 只记录用户可见变化；支持声明与平台证据只写 README/AGENTS/路线账本。
- 分支推送后开 Draft PR，PR 描述包含变更范围、两代基线说明、逐项验收命令与结果、未覆盖项与剩余风险。

## 验证矩阵

| 场景 | 需要的证据 |
| --- | --- |
| 未启用行（默认） | 无 reviewer owner、无 context 服务、无 Auto preset、无额外文件扫描；与未安装集成一致 |
| 启用 + 零附加根 | reviewer 请求与官方语义一致（除插件标识），不因空多根扫描文件 |
| 主根 + inherit + read-only 根 | 环境含拓扑/有效权限；当前约束以 constraint 进入；脚本化 allow 写只读根仍被真实 fs 围栏拒绝 |
| native 指令重叠 | 附加根旧帧降 fact、当前帧保留、混合帧显式失败；不解析 prose 猜分区 |
| 指令变化/根撤销/文件消失/freshness | 发送前、模型等待后、下游 gate 后、dispatch 前复核；变化使 body 不执行 |
| PTC 内层调用 | 内层单次审查、父层 cap 不得解除；外层 `run_code` 不重复审查 |
| 工具执行双形态 | 0.2.1 单发 `tools.execute({...})` 与 0.2.2 批量 `{calls}` 在测试/冒烟中都能驱动真实 dispatch |
| 两代 reviewer 协议 | 基线 A 五段单消息；基线 B system + 逐项 message，待审调用最后，前缀可复用 |
| 生命周期 | 行开关接管/恢复、reload、packed 安装、卸载迁移（实时移除）与应用关闭保留 Auto |
| 版本矩阵 | 每个声明的发布在 CI 车道执行 compat/typecheck/fork/test/build/journey/packed/smoke-auto-review |

## 风险与不变量

- **两代实现的维护成本**是最主要成本：上游再改 reviewer 输入模型时必须重做对应基线；差分门禁与官方回归副本是唯一防线，不允许“绿色冒烟即扩大支持”。
- **按基线动态加载**必须保证 0.2.1 车道不加载基线 B 模块；新增任何共享 chunk 时不得把 B 的值导入泄进 legacy chunk。`FiberState` 是 const enum，运行时不存在该导出，基线 B 的 fork 必须以带注释的字面量 `2` 表达 `ACTIVE`（与 `entry.ts` 现有写法一致）。
- **契约声明仍是精确发布**：`AUTO_REVIEW_RELEASES` 的每一项都必须有真实车道证据；未声明发布即使绿也不扩。
- **多根约束插入位置**是基线 B 前缀缓存语义的一部分；不得把约束插到历史中间或改变环境消息位置。
- **alpha.2 请求身份例外**只允许按精确发布省略字段，不得把 `purpose: 'auto-review'` 发给 alpha.2 的 provider。
- **普通插件合同不变**：24 个精确版本、provider 门禁例外、默认 Auto 行为、fs/进程围栏均不因本批变化。
- 回退方式：两代实现与契约都在同一分支；把 `AUTO_REVIEW_RELEASES` 收回 `0.2.1-rc.2` 并把入口分发固定到 legacy 即可回到本批之前的行为，无需修改普通插件门禁。

## 文件范围

新增：`src/compat/auto-review-contract.ts`（改写）、`src/compat/auto-review-packages.ts`（改写）、`src/auto-review/entry.ts`（改写）、`src/auto-review/partition.ts`、`src/auto-review/legacy/*`、`src/auto-review/current/*`、`tests/auto-review/legacy/*`、`tests/auto-review/current/*`、`tsconfig.auto-review-legacy.json`、`tsconfig.auto-review-current.json`、`docs/reference/auto-review-0.2.2-migration.md`、`docs/decisions/ADR-0040-auto-review-multi-baseline.md`、本计划。

修改：`tsdown.config.ts`、`package.json`、`pnpm-workspace.yaml`、`vitest.config.ts`、`scripts/{build,smoke,verify,check}-auto-review*.mjs`、`scripts/lib/auto-review-development.mjs`、`scripts/upgrade-dsh.mjs`、`scripts/check-dsh-compat.mjs`、`scripts/ci/{plan,run-group}.mjs`、`src/client/locales.ts`、`docs/reference/auto-review-compatibility.md`、`src/auto-review/{README,README.en,FORK}.md`、`README(.en).md`、`AGENTS.md`、`CHANGELOG(.en).md`、路线账本。

## 与既有决策的关系

ADR-0021/0022 的上下文契约、来源身份、freshness、协议与生命周期决策继续有效；被本批替代的只有“联合支持集合必须恰好是一个精确发布”的旧结论。ADR-0009 的兼容合同原则不变：支持声明是人工行为，绿色车道是证据而不是授权。

## 实施落点

当前分支 `feat/auto-review-adapt-1114`，开发 pin `@deepseek-ai/dsh` `0.2.2-rc.3`（cordis `4.1.0`，Node `24.18.0`，macOS 本机）。每个阶段的提交、命令与结果记录在路线账本的新章节；只有全部阶段验收通过后才准备 Draft PR。
