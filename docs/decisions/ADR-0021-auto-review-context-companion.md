# ADR-0021: 可选 Auto Review fork 与当前多根上下文

## Status

Accepted

交付结构已由 [ADR-0022](./ADR-0022-auto-review-loader-entry.md) 取代：独立 companion、bundle 排序与 configure 退役。本文其余上下文及安全语义继续适用，下文保留原始决策历史。

## Date

2026-10-18

## Context

DSH `0.2.1-rc.2` 的 Auto Review 没有专用上下文贡献接口；它不继承主 Agent 的 system prompt，多根增量消息只被归为 fact。通用 `llm/stream` 缺少可靠的 review purpose 身份。源码事实与排除路线见[接缝调研](../reference/auto-review-compatibility.md)。

## Decision

### 可选装配与唯一 owner

新增独立 companion 包 `@dsh-electron/dsh-plugin-multi-root-auto-review`，源码位于 `compat/auto-review/`，固定 fork commit `687f282e8625c6b8d11ff58211a90524be2e4317`。原源码、MIT 许可、允许差异和同步规则保存在该目录，`pnpm auto-review:fork` 校验基线哈希、显式 patch 和安全敏感函数。

普通包仅导出 `review-context` 入口；普通 `cordis.patch.yml` 不安装上下文行、不注册或选择 Auto。显式安装 companion 后，用其 `configure.mjs enable <profile-directory>` 校验已选官方和 Multi-root bundle，并把 companion 排到最后。Loader 的 patch 只能修改前面已存在的行，因此此步骤是装配契约；不声称任意手写 bundle 排序均有效。companion 禁用官方 `auto-review` 行，插入 required 的兼容 owner。重复 owner 仍由官方 `registerAuto` 拒绝；缺少 context/brand/compat 等依赖时不能静默退回缺上下文审查。

`disable` 仅撤下 companion 的 bundle 选择，保留其他 profile 配置。正常卸载包也会撤下其 bundle。两种方式均恢复原官方组合。live recompose 必须先结束旧 owner，再启动新 owner；保持官方卸载语义：存活 Auto Session 迁移到 Full access，重新安装不自动切回 Auto。已有 Multi-root 围栏继续执行。

### 同源权限与当前快照

`multiRootScope.previewForTool(policy, execution.name)` 与 `resolve()` 共用内部投影和 cap 计算；preview 读取父层 ALS cap 并以本工具 cap 收窄，不写 ALS。`resolve()` 在未知执行上下文时仍按配置 fail closed。主根由可信 Session/policy 决定，effective cwd 只解释相对路径；Full access 的未登记路径保持 ambient 访问，显式只读仍仅限制写入。

`multiRootReviewContext` 注入原 compat、provider brand、scope、Registry、instructions、policy 和 workingDirectory。每次 build 调用 Registry `refresh()`，只从现有 scope 读取权限。返回 Session origin、effective cwd、注册策略、工具实际 writable/deny 集合、protected home 和 authority。没有新的根授权表。

指令行提供只读 facade，复用现有 `planRoot` / `loadDirectory`，严格模式不吞掉探测、读取、超限或取消。收集当前有效根的顶层、成功活动目录链、本次显式 read/write/edit 目标目录链，以及 effective cwd 位于有效附加根内时从该目录到根的链。cwd 链在首次 bash/pwsh、尚无成功文件活动时也收集，避免将 native 已提供的嵌套约束降为历史后遗漏当前副本；它仅作为本次只读发现入口，不登记成功 touch 或消费投递状态。不运行脚本猜目标，不读取普通目标源码。读取自己的 delivery scope 索引副本，不提交投递或成功 touch。成功活动也从持久化 native/PTC start/result 配对重建，以覆盖不发 `session/event` 的 seed/resume。相对成功操作若跨越 cwd 变化，检查已知候选目录链；不声称恢复了未持久化的 canonical observation。

每源默认上限 32 KiB，全部附加约束及元数据共用原 instructions 预算；新增完整 context JSON 另受 64 KiB 上限。成功路径索引和未完成 durable activity 均有 512 项上限，超限使该次 review 技术失败。零有效根不扫描指令文件。不存在的普通候选是正常缺席，I/O 错误、权限错误、超大源、预算不足和接口缺席均失败关闭；只返回 complete 快照，不把 incomplete 折叠为空数组。

### 来源与 native 重叠

新鲜文件以带绝对路径、所属根、目录范围和摘要的 constraint 数据项进入 PROJECT_INSTRUCTIONS；主 Agent 的旧增量消息继续是历史 fact。主 system prompt、assistant reasoning 和历史工具结果不复制给 reviewer。human、direct-parent、checkpoint、fact 的原判定和风险 policy 均不变。

仅在原 scope/现有 delivery 索引能证明是附加根来源时协调 native 重叠；不把未登记 cwd 的 native 项目指令撤下。遵循 producer 的显式 replacement baseline 标记，旧 baseline 帧只保留为历史 fact。当前 baseline 内仅含附加根内容的 native 旧帧也降为历史 fact，由当前文件快照替代。混合 global/primary/附加根内容的 native 帧没有公开的逐文件正文接口：每个附加文件必须能以路径和完整摘要证明仍当前，才保留整帧并去重；陈旧、撤回或缺失 scope metadata 则技术失败，要求重建 native baseline（必要时新建 Session），普通 delta 不足以拆分旧混合帧。禁止解析 prose 猜分区，或为消除重复而漏掉 global/primary 约束。这是首版明确的失败关闭边界。

### 新鲜度、执行与维护边界

撤销后的来源识别使用 Session 内独立的历史根集合：指令投递（含借用 native 副本）成功后记录根，撤销根或删除文件仅清理当前投递索引，不删除历史来源。该集合只参与 native 旧帧降为 fact 的判定，不授予访问、不触发已撤销目录的扫描，review 的只读快照也不写入它。与现有投递索引一样，该集合仅在进程内保留；这项修复不承诺跨进程恢复已撤销根的来源。

fingerprint 覆盖权限、cwd、authority、当前约束及 native producer 的可见元数据/正文摘要。收集完成后、发送前、模型返回后、后续 gate 后及真正 dispatch 前均复核；dispatch 用官方 registry token 关联，覆盖人工批准等待。发生变化使 body 不执行，不自动循环重试。新复核受同一取消和 owner drain 管理。

reviewer allow 和人工批准都不提供 fs/kernel 围栏豁免。官方 native/PTC 身份核验、严格输出解析、ask/never、下游单调 gate、取消和卸载迁移逻辑保留。fork 首批只接纳 DSH `0.2.1-rc.2`；普通插件原支持集合不缩减。fork 执行的 llm/tools/permission-presets/util-values 副本独立检查精确版本，普通插件不因 companion 的私有开发副本误报混装。旧版验证时 probe 不把全局 overrides 应用于独立 companion 开发树。

正式 context contribution API 满足计划中的来源、预算、失败与生命周期合同后，迁移为 collector 并删除 fork，保留同一联合测试。绿色 upgrade lane 不授权扩大支持声明。

## Alternatives Considered

- 等正式接口：长期路线，当前不能交付。
- 匹配 REVIEW_POLICY 文本或全局拦截 LLM 重发：缺身份，重入与顺序不稳定。
- 第二 reviewer、伪装 human/direct-parent/agent-instructions：费用重复或越过来源边界。
- 混合 native 帧按文本切片：不可靠，可能删除其他约束，拒绝。

## Consequences

承担安全敏感 fork 的人工同步成本，新增装配顺序和混合 native 帧的显式失败边界。固定 allow 只证明请求输入与执行围栏独立，不能证明模型语义判断质量。TOCTOU、已启动进程的 kernel snapshot、Linux/Windows 原生验证边界沿用既有决策；平台执行和发布状态仅记[路线账本](../plans/active/2026-09-12-multi-root-workspace.md#auto-review-多根上下文适配2026-10-18)。

## Related Documents

- [适配计划](../plans/completed/2026-10-18-auto-review-context-adaptation.md)
- [companion 操作与 fork 维护](../../src/auto-review/README.md)
- [ADR-0009](./ADR-0009-dsh-compat-contract.md)、[ADR-0010](./ADR-0010-additional-root-instruction-scope.md)、[ADR-0013](./ADR-0013-per-root-and-per-tool-access.md)
