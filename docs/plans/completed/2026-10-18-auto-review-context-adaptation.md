# Auto Review 多根上下文适配计划

> 范围：Phase 0–2；实施决策见 [ADR-0021](../../decisions/ADR-0021-auto-review-context-companion.md)。Phase 3 普通目标源码自动读取不在本批范围。源码事实见[接缝调研](../../reference/auto-review-compatibility.md)，执行进度与兼容/发布状态唯一真源为[路线账本](../active/2026-09-12-multi-root-workspace.md#进度总账)。

## Goal

让 Auto Reviewer 从可信宿主获得当前 Session 的多根拓扑、注册访问策略、待审工具的有效写限制和当前项目约束，减少合法跨根操作的上下文误判；审查结果继续由原有 fs/进程/kernel 围栏执行。保持“不修改上游包”、唯一 scope 和用户约束不升为 system authority 的不变量。

本批 Phase 0–2 不提供普通源码的自动读取，不复制主 agent 的完整 system/history，不赋予 reviewer 自主工具。Phase 3 文件内容证据另行评估，不阻塞基础适配。

## Background

当前 `0.2.1-rc.2` 没有专用 context contribution API，不能只增加一条 systemPrompt contribution 就使既有 reviewer 看见它。本插件的普通支持列表也不能直接充当联合 Auto Review 的支持列表。

本计划保留最初的设计草图；实际接口、预算、native 混合帧限制、显式启用步骤和维护合同以 ADR-0021 与源码为准。验证和发布状态仅见路线账本。

## 路线选择

| 路线 | 能解决的问题 | 代价/结论 |
| --- | --- | --- |
| 等上游增加正式接口 | 保留原版 reviewer owner，适配成本低 | 长期首选；当前版本没有，不能据此承诺已可实现 |
| 可选外部兼容 bundle，fork Auto Review 入口 | 在现有版本控制快照组装，保留决策协议和权限围栏 | **建议的短期实施候选**；固定 `687f282e86`，需维护 fork 与 lifecycle 差分 |
| 通用 `llm/stream` 拦截重发 | 可能避免复制完整入口 | 无可靠 request purpose 身份；冻结输入、listener 顺序和重入代价高，不作为首版 |
| 伪装 `agent-instructions` 或 human 来源 | 看起来可以进入既有分区 | 破坏来源所有权/权威边界，排除 |
| 追加第二 reviewer 或只在历史里写拓扑 | 可以补一个检查或事实 | 无法修复既有 reviewer 的首轮误判，不满足目标 |

短期兼容层应显式安装/启用，不放入普通 `cordis.patch.yml` 的默认路径，不因安装 Multi-root 自动注册或选中 Auto。建议以独立 companion bundle 交付：声明并校验准确的宿主版本，禁用原 `auto-review` 行，加载本地兼容入口，保证只有一个 `registerAuto` owner。独立包的实际目录与包名留给 Phase 0 的 composer 验证确定，不在此预先发布新包名。

该包仅依赖本插件公开入口和宿主公开包入口，不深导入上游 `src/*`，不改原型、不全局包装 `llm.stream`、不编辑安装后的上游产物。fork 应保存原许可与 commit、逐文件同步清单和允许差异；与现有 client fork 的维护方式一致。

## 上下文契约

建议由本插件提供只读的 review context builder。compat companion 调用它，不能写 root table、存储或 delivery state。伪接口如下；它是本地设计，不是当前上游 API：

```ts
buildReviewContext({ agent, execution, signal }): Promise<{
  schemaVersion: 1
  environment: {
    sessionOrigin: string
    effectiveCwd: string
    sandboxMode: string
    registryAuthority: 'available' | 'unavailable'
    roots: readonly {
      path: string
      access: 'inherit' | 'read-only' | 'read-write'
      effectiveWritable: boolean
    }[]
    deniedRoots: readonly string[]
    protectedHome?: string
  }
  constraints: readonly {
    root: string
    path: string
    relativeDirectory: string
    digest: string
    text: string
  }[]
  completeness: 'complete' | 'incomplete'
  diagnostics: readonly string[]
  fingerprint: string
}>
```

JSON 输出不包含 session/store/lease 路径等无关实现信息；`sessionOrigin` 是主根路径，不是新的 Registry key。上面 roots 仅列有效附加成员，主根由 sessionOrigin 表达；缺失/redirected/冲突记录不能伪装成成员，仍生效的负授权来自现有 scope 的 deniedRoots。诊断使用有限的状态码，错误文本需限制长度。

### 拓扑和权限

1. 主根只从可信 `execution.agent.session` 及 `sandboxPolicy.resolve({ session })` 推导；effective cwd 使用上游 workingDirectory，只解释相对路径，不参与 Registry key 或授权。
2. 权限投影与执行共用 `src/scope.ts` 的计算逻辑。抽出内部纯计算并增加只读 `previewForTool(policy, execution.name)` 一类入口，使用可信 dispatch name、父层已有 ALS cap、非法配置和 authority；不得修改现有 `resolve()` 在未知上下文时 fail-closed 的行为，也不得建立新的授权表。
3. preview 必须按“父层 cap 或本工具 cap”收窄；PTC 内层不得因为自身未受 cap 而解除父层限制。preview 不建立可供后续执行使用的 ALS grant。需要与真正 `tools/execute` 中 resolve 的结果逐项差分。
4. `inherit`、固定只读、固定读写分开表示。有效写权限还受 mode、tool cap、authority 与 deny 优先级控制，不能仅依据登记时的 access。
5. Full-access 的 ambient 访问和额外 deny 均应表达准确；根成员资格不是对 medium 外部写入、生产操作或 high 风险操作的授权。保留固定风险政策，最多澄清底层仍可能执行宿主限制。

### 当前项目约束

从现有 instruction discovery/读取逻辑抽出可共享的只读收集器；既有 instructions row 继续独占主 agent 的成功 touch 和 delivery 状态。reviewer 收集器只读取其受控 scope 索引，不从人类可见 prose 解析状态，不写入一套平行的“已经投递”记录。

收集范围为有效附加根的顶层文件、已有成功 touch 产生的相关目录链，以及本次 native `read/write/edit` 明确目标的父目录至所属根的链。后者只服务本次审查，不记录成功 touch。文件候选、local overlay、canonical 根内检查、global/主根排除、单文件 source cap 和取消处理沿用现有规则。主根约束继续由 upstream producer 提供；native 已覆盖的附加根文件按绝对文件身份和摘要去重。

关键语义：

- 新的当前附加根约束以 `constraint` 数据项加入 review，携带文件路径和适用目录，不能获得 human/direct-parent 身份；文件内的“请部署”“忽略策略”等文本只能收窄，不能授权 medium 或 high。
- 原 `multi-root-workspace` 增量消息保持历史事实身份，不能整体升级；旧版已失效的文本不能与 fresh snapshot 一起充当现行约束。
- 每次审查重读相关文件；删除、根移除/redirect 后不再纳入。保留适用 scope 与明确的当前快照标识，避免把不同附加根的指令误套到全部动作。
- reviewer 与主 agent 的 delivery bookkeeping 分离：审查一次不能让主 agent 漏掉下一次本应投递的指令，也不能将失败的工具记录为成功 touch。
- 首版使用现有默认量级（全体附加根合计 64 KiB、单源 32 KiB）作为预算候选，纳入重复内容、路径与元数据的真实字节计数。超出预算或文件读取错误显式标 `incomplete`；不可静默删除约束后让调用继续。默认使该次 review 技术失败、body 不执行；普通“文件不存在”不是读取故障。
- 任意 bash/pwsh 程序无法可靠推出完整路径效果；只读已知 scope 约束，不声称已发现脚本会触及的全部 nested instructions，不运行脚本来探查效果。

### 请求与状态变化

在审查的同一取消/生命周期 signal 下先收集宿主上下文，再冻结生成请求。保留原 provider/model、human/direct-parent/checkpoint/fact 分类、native/PTC 身份核验和严格输出解析；新增内容只进入数据分区，不复制整个主 agent system prompt。

权限、根状态或约束可能在 I/O 和模型等待中变化。fingerprint 覆盖本次投影的根/access/deny/authority、cwd 与约束摘要。发送前及最终允许/进入后续 gate 前复核；发现变化时本次调用技术失败并明确提示重新发起，不复用旧 allow、不自动循环重试。不声称该复核消除了任意敌对文件系统替换的 TOCTOU；最终执行仍重新使用现有围栏，旧进程仍遵守启动时 kernel snapshot 边界。

## 实施阶段与文件范围

### Phase 0：验证装配和固定 fork 基线

在隔离的临时 web/headless profile 中验证原版 Auto Review 与 Multi-root 的两种安装顺序，记录 rows、preset 注册和正常启动结果。然后验证 companion 替换规则及拆除规则：原版/兼容版不能同时注册；卸载兼容层必须恢复原组合，且不丢失 fs/sandbox。确定交付结构后写 ADR，不能只凭 loader id 假设 patch 顺序稳定。

建立 `FORK.md` 与差分规则：固定 policy、snapshot 的原生/PTC 核验、决策解析、ask/never、取消/卸载均保持上游；允许差异只有宿主 context builder 调用、结构化数据分区及其失败/陈旧检查。Auto 原有卸载会迁移存活 session 到 Full access，这一行为必须纳入可见生命周期验证，不能误称卸载后仍在审查。

### Phase 1：同源只读上下文

预计涉及 `src/scope.ts`、`src/instructions.ts`，以及新增 review-context/共享 instruction collector 模块；入口名称在实施时确定。重构先保持现有回归行为，再增加 preview 和读取接口。

context row 必须注入 `multiRootCompat`、`multiRootProviders`、`multiRootScope`、所需 Registry/instruction/policy 服务。companion 还依赖 upstream Auto 所有必需服务。服务缺席/混装/结构破裂必须使该集成不可用或当前 review 失败，不能把“上下文失败”折叠成“零附加根”。两个已有 fs/sandbox provider 行仍保持现有门禁例外。

新直接依赖按实际执行副本归类到 `src/compat/dsh-version.ts` 的现有解析类别。版本差异集中在 `src/compat/`；普通主插件支持集合不收窄，新增 companion 首批仅以 `0.2.1-rc.2` 为验证目标，不据此承诺其他版本的联合兼容。

### Phase 2：兼容入口与联合测试

启用 fork 的最小数据拼装差异，以脚本化 LLM endpoint 捕获实际 review 请求并返回严格 JSON，驱动真实工具调度。区分两种证据：请求捕获证明上下文正确、脚本化 allow 证明执行围栏独立；模型能否减少误判需要另行真实模型验收，不能由固定 allow 的 mock 证明。

完成 lint/typecheck/build、pack 内容检查、隔离 profile compose/behavior/journey/packed 路径，确认发布安装没有意外静态加载可选 peer，默认安装也不新增 Auto 功能。新增专项 smoke 应接入既有完整门禁而非成为人工专用脚本。

### Phase 3：目标源码内容（另行评估，默认关闭）

仅在基础适配证明仍缺必要证据时推进。只允许从可信 fs 工具 schema 确认的具体目标读取有界文本，必须验证 canonical 范围、文件类型、大小、取消和读取版本；不递归扫描、不为 bash 猜目标、不复制整个 tool-result 历史。返回 `fact`，含路径/版本/截断说明，防止文件内提示词变成授权。

普通源码和敏感内容会额外发送到当前 provider，产品配置需明确启用范围与字节上限；是否排除特殊文件、如何提供 patch 所需行段在该阶段单独定案。主阶段的 AGENTS/CLAUDE 收集与此分开，不能以“内容读取已延期”为由漏掉项目约束。

## 验证矩阵与通过条件

| 场景 | 需要的证据 |
| --- | --- |
| 无附加根、authority 健康 | 除显式接口标识外与上游原请求/决策差分一致，无额外文件扫描或模型请求；关闭 companion 时完全不影响主插件 |
| A 主根 + B inherit + C 只读 + D 固定读写 | 请求包含注册策略和有效权限；Auto 的底层 Full-access 不能抹掉 C 的 deny |
| tool cap 和 PTC 嵌套 | 未受 cap 的工具 preview 不被未知上下文误限；受 cap/父层受 cap 时 preview 与实际 dispatch resolve 相同；并发 session/call 不串状态 |
| effective cwd 切到 B 或非成员目录 | Registry 仍索引 A；相对路径按 effective cwd；不因此新增 grant；native 指令去重正确 |
| 顶层、本次首次触及子目录、祖先中间目录指令 | 当前约束含准确文件身份和范围；项目文本只能收窄；审查不篡改成功 touch/delivery 状态 |
| 修改/删除指令、remove/missing/redirect、authority contended | 旧快照不当成现行约束；既有 deny 保留；采集或模型等待期间变化使本次失败，body 不执行 |
| 预算耗尽、权限错误、取消、collector 抛错 | 明确 incomplete/技术故障；不能静默按空上下文 allow；正常缺少指令文件仍可审查 |
| 人类、父级、checkpoint、fact 的权威 | 保留上游既有规则；AGENTS 和普通文件里的动作请求无法构成 medium 授权或允许 high |
| reviewer allow 写 B/写 C | 真实 fs 工具：B 成功；C 即使 reviewer 固定 allow 也拒绝且内容不变；人工批准同样不能解除 C 围栏 |
| bash/pwsh、agent PTY、PTC 内部进程 | 原生 kernel runner 下验证可写与拒写；用户自己的面板终端保持现有直通；外层 run_code 不重复 review |
| 下游 deny/ask/cancel、reviewer 非法 JSON、超时、卸载 | 与上游行为差分；下游拒绝不能被 allow 覆盖；无重复 owner、请求泄漏或僵死 Auto 选项 |
| 安装顺序、禁用/重启/恢复 session、packed 安装 | 两种顺序均确定；缺失依赖明确不可用；未启用 companion 不影响 profile；存活 Auto 的迁移行为可见 |

在可执行平台运行仓库完整门禁：`pnpm compat:check`、`pnpm verify:all`、`pnpm docs:check`。其中 kernel probe、三项 smoke、pack check 和 packed smoke 不省略。macOS Seatbelt、Linux bwrap/Landlock、Windows ACL 分别记录实际执行与 skip；Windows 原生 pwsh/ACL 条件沿用[开发工作流](../../development/plugin-development-workflow.md)，不得把 macOS 单机结论写成跨平台通过。

共享 scope/instructions 重构影响已有所有支持版本，需要在既有版本矩阵上回归；可选 companion 不可加载的旧版本验证“普通插件保持原行为”，不能强装新 API。真实模型验收另列模型/provider、调用路径和误拒绝/误放行观察，不把语义验收的不稳定结果藏进确定性单测。

## 长期上游接口提案

建议上游提供版本化的 `autoReviewContext.register` 类宿主 API，由唯一的 Auto Review owner 在冻结 snapshot 前调用已注册的 collector。输入为可信 Session/ToolExecution、已经确定的 effective cwd、取消信号；输出仅允许具名 environment facts、带 scope 的 constraints 和 completeness，不能返回 allow/deny 或改写 human/history/policy。

接口需定义注册唯一性、顺序、预算、失败关闭、abort/dispose drain、来源身份与结构验证。无贡献者时行为与原版一致；required collector 缺席时不能把集成伪装成已启用。提供 request purpose/action 关联标记供诊断，避免依赖提示词文本识别请求。接口若落地，companion 迁移为普通 collector 后删除 fork，保留同一联合测试。

本段仅为可提交给上游的接口需求；本次不修改上游，也不创建 issue/PR。

## 风险与完成标准

主要成本是维护安全敏感的 Auto Review fork。装配/卸载、来源角色、tool cap 时机、当前约束快照四项任一无法通过差分，应停留在实验状态，不能靠日志 warning 后继续审查。

完整适配的验收需要同时满足：唯一 reviewer owner；当前拓扑与约束来自宿主；权限投影与执行同源；默认安装无额外行为；联合请求与原生围栏验证；旧版回归不退化；打包安装与生命周期通过。进度只更新[路线账本](../active/2026-09-12-multi-root-workspace.md#进度总账)，发布时再更新双语 CHANGELOG；本批不自动发布版本，不生成尚未发布的 release 条目。


## 实施落点

实际交付结构、公开入口、采集预算、有界流式读取、native 当前 baseline 与混合帧失败边界、装配排序和生命周期以 [ADR-0021](../../decisions/ADR-0021-auto-review-context-companion.md) 为准；本文件前面的伪接口与候选名称保留为设计过程记录。安装操作见 [companion README](../../../compat/auto-review/README.md)，fork 同步见 [FORK.md](../../../compat/auto-review/FORK.md)。本批验证、平台覆盖和未发布状态仅维护在[路线账本](../active/2026-09-12-multi-root-workspace.md#auto-review-多根上下文适配2026-10-18)。
