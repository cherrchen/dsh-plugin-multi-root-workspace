# OPS 兼容性适配开发计划

> **状态：Proposed — ADR 未接受；直接授权实施中，P0–P4 子集及 P5 本仓保守兜底已落地（见[本轮实施状态](#本轮实施状态)），P5 完整退出尚未满足。**
> 创建日期：2026-11-01。创建时仅含计划与文档导航（无实现或适配证据）；其后的实现按直接授权推进。放入 `active/` 表示尚未完成的计划，不表示已验收。
> 设计依据：[ADR-0027](../../decisions/ADR-0027-ops-file-authorization-and-activity-adapter.md)，同样保持 Proposed。实施与发布进度统一记入[进度总账](./2026-09-12-multi-root-workspace.md#进度总账)，本计划不指定发布版本或交付日期。

## Goal

按“先封住写入绕过，再修复活动识别，最后恢复合法可写性”的顺序推进OPS适配，并分别验收：

1. **写入保护**：Full-access有限制时，OPS读写Worker及其准备不得绕过MR边界；无法保护的路径明确早拒。
2. **实时上下文**：将成功调用正规化为零到多个成功目标，恢复附属子目录指令发现；Auto Review另按完整性合同验收。
3. **完整兼容**：在上游接缝和平台证据齐备后，再恢复可写附属根、受限执行、持久活动与维护操作的可用性。

安全拒绝、实时活动可用、恢复可用、合法写入可用是不同能力，不合并成一个“兼容通过”。

## Background 与 Current State

事实、风险等级和原始证据以[兼容性审计](../../reviews/dsh-ops-compatibility-audit.md)及其§14架构复核为准，设计合同以ADR为准。本计划只组织后续任务、依赖和退出条件，不重新定义授权规则或复制完整发现清单。

建计划时的审计基线为MR `4e45e25`（v0.1.13）与OPS `2c0b039`；旧版OPS对照及精确宿主见审计§2。已有真实F01写入绕过、F04预检误拒、F05实时指令缺口及函数级接缝证据；**当时没有适配实现或适配后通过证据**；当前实现与实测见总账。本仓DSH开发安装树超出当前OPS peer范围，不能直接用于证明组合兼容。

后续启动时重新核对实际HEAD、工作树、宿主依赖和源码形状；审计快照是对照基线，不是可以忽略代码变化的长期假设。

## Scope 与启动前决定

本节保留首期决定；其中 WW/RO 过渡及失权范围已由 [P5](#p5条件分支与上游协作) 收紧，当前行为以 ADR 的 P5 修订为准。

### 首期拟实施范围

- D1 Full-access全部OPS Worker执行域，包括业务读/page/spill；同时处理host准备、内层admission、cap及保护生命周期。
- D2 Phase A实时成功活动正规化与附属子目录指令；Auto Review完整性接入作为独立验收任务。
- 为这些能力建立明确的版本/平台/入口支持范围、失败语义和回归证据。

首期能力统一通过插件设置 `multi-root-ops-compatibility.enabled` 显式启用，默认关闭，并标注实验性与可能存在的限制。关闭时不启用本轮 OPS 专属执行保护、活动采集和 Review 完整性增强，恢复原有 OPS 行为（包括显式只读根可能被 OPS 绕过的已知缺口）；不关闭普通多根围栏，也不代替 Auto Review 自身开关。开关切换不得使已进入保护域的调用裸执行，旧代次结果不得提交为新代次活动。

### 首期WW/RO过渡决定（R1，历史；P5 已收紧）

首期与ADR D1.1a一致，**曾选择“维持现状并披露”**：首期新增OPS profile、失权早拒和保护存活guard仅用于Full-access。WW/RO固定文件继续现有OPS写根/read_only检查；RO读不因新guard或失权规则被拒，原有MR/OPS拒绝仍保留。WW/RO的temp重叠、权威不可用及F07等残余继续披露，不纳入首期保护通过结论。

该选择已经写明供维护者评审，启动前需确认；它不等于接受D1.1d应用层信任路线，也不等于改为全模式早拒。后续若改变选择，先同步ADR和计划，不能在实现中隐式扩展。

### 条件满足后才进入的范围

| 范围 | 进入条件 | 未满足时的处置 |
| --- | --- | --- |
| WW/RO固定文件Worker | 维护者明确选择ADR D1.1d的OPS应用层信任路线，或OPS提供私有区域声明后走内核路线 | 首期维持现状并披露；不新增profile或失权早拒，不宣称该车道已保护或完整兼容 |
| D3可写附属根 | OPS公开逐操作写授权桥，并覆盖host、envelope、Rust与batch实际写点 | 保留误拒披露，不伪造mode/workspaceRoot |
| Linux WW bwrap batch/result（F07） | OPS在confine之前声明cache需求，最终argv一次生成并登记证明 | 保持严格证明，不放宽前缀检查换取可用性 |
| Phase B持久活动 | 安全ignorable记录API的使用合同获准，并通过真实恢复/卸载/迁移测试 | 早期两版按ADR不适用；其他版本未验证前不启用，不使用普通append自有type |
| 后台Bash与purge | 有可控、独立有效的启动/maintenance准入，平台验证完成 | 后台入口按保护合同早拒，purge残留与告警如实披露 |

启动评审需确认首期WW/RO维持现状，以及首期精确版本/平台范围、可信工具来源识别、D1.3的scope guard/ready token卸载策略和是否启动上述条件范围。不能通过批准首期原型隐含接受实验性持久API或OPS写根信任。后续明确启动指令可以只授权已划定的原型范围；ADR状态仍由维护者单独决定。

## Non-goals

- 本计划编写阶段不运行原型或动态复现、不安装/构建隔离宿主、不修改插件实现、不提交PR或发布。
- 实施时不新增根授权真源、不深导入OPS私有实现、不改变全局sandboxPolicy、不将普通append事件作为持久化退路。
- 不自动扩大DSH allowlist、升级Auto Review固定宿主或改写已发布CHANGELOG。
- 不把未来上游接口当成既有能力；不把函数级证据当成Linux/Windows或完整PTC验收。

## Implementation（初始任务与退出条件）

阶段编号使用本计划局部的P0–P6，与历史里程碑和审计严重度无关。依赖为 `P0 → P1 → P2`；P3的Native live可在P0后与P1/P2并行，PTC端到端需P1/P2的内层执行保护通过。P4在对应P3目标正规化可用后接入，Native/PTC分别验收；P5各分支只有在对应进入条件满足并获准后启动，P6按实际完成范围验收。

### P0：基线与范围冻结

- [ ] 核对两仓HEAD/状态、OPS实际发布入口、宿主服务版本和兼容交集；保存可复现的依赖清单与源码哈希。
- [ ] 在分别隔离的目录建立首期两个必备宿主：0.2.0-rc.2用于原审计/执行链对照，0.2.1-rc.2用于P4 Auto Review精确基线；各自依赖树保持统一，其他精确版本按批准范围增加。保持原工作树依赖与真实用户profile不变。
- [ ] 复核ADR D1.4的启动清单、OPS动态发布、PTC子dispatch、host准备与maintenance入口；代码漂移先修正合同和证据。
- [ ] 将真实Agent/Session、共享Registry、业务根、只读根、temp/cache、runner和事件记录装入组合夹具；记录无法获得的原生平台能力。

**退出条件**：隔离基线自洽，版本门禁正常，目标入口与限制清单可审查。原生平台被阻断则记录NOT_TESTED，不放宽真实环境来制造通过。

### P1：先验证执行入口与保护生命周期

拟修改面：`src/process-fence.ts`、`src/scope.ts`和`src/compat/`；scope负责guard与cap上下文，fence负责执行profile与ready token。Registry/组合依赖仅在生命周期证明需要时调整。

- [ ] 按ADR D1.3在scope生命周期下注册公开tools.guard，独立于process-fence/Registry存活；用可信policy和previewForTool只作拒绝判断，不能在准入前靠resolve缺frame把所有shared调用拒绝。
- [ ] process-fence装好wrapper/策略才发布绑定当前scope的ready token；清理先撤销自身token，新调用由scope guard拒绝，drain后恢复wrapper。证明旧清理不撤销新token；compat/provider拒载维持未安装语义。
- [ ] scope新增withToolCap(name, fn)，原监听器与process-fence都调用它；包住admission取得、prepare/remember、store、next及调用期spawn。同名重复进入幂等，父cap只能收窄，不能以capped()的未知dispatch回退代替capForTool。
- [ ] 用真实PTC子dispatch验证外层store不能充当内层证明，内层准备正确覆盖store；防止双重包裹、过期prefix复用或清空store后裸启动。
- [ ] 验证调用来源与Session绑定，不以模型参数、最近一次Session或Worker文件名补授权；动态工具及第三方同名工具分别测试。
- [ ] 用屏障验证guard通过后撤销、prepare中卸载、两监听器内外顺序、scope重载及Registry卸载。scope aroundTool复查ready，执行策略prepare后/next前复查代次；旧上下文drain，新scope从not-ready启动。单独卸载fence必须留下scope拒绝；整个scope卸载按插件未安装边界单列。
- [ ] 保持同步spawn返回形状、caller this、属性描述符恢复、取消和可选依赖加载语义。

**退出条件**：X2/X5对应的真实入口证明成立；FA有限制时单独卸载fence，新OPS调用由仍存活的scope guard拒绝，正文/准备/Worker均未启动，WW/RO无新增误拒（首期条件，P5 改为有 deny 则安全早拒）。调度窗口与重载测试证明旧token不能复用；withToolCap双顺序、嵌套、异常/取消恢复一致。整个scope卸载不在持续保护承诺内。现有宿主接口足以实现此MR侧路径是待原型验证的选择；若guard语义不成立则回到维护者评审，不悄悄接受裸写残余。

### P2：Full-access读写Worker与准备副作用兜底

- [ ] 有deny/cap时，对全部OPS Worker采用本次ambient-minus-deny边界；业务mutation分类仅用于动作语义和结果判断。
- [x] P5 将失权早拒扩到**全部模式**：authority unavailable 时，于 invoke/prepare/resultStorage 前拒绝受适配 OPS 执行（含读/page 及主根写，纯发现/发布除外）；WW/RO 有 deny 时同样拒绝准备与正文。
- [ ] 按ADR D1.1c的POSIX精确谓词检查host cache：deny覆盖canonical tmpdir或落在其直接cache族及后代时早拒；普通tmp兄弟根不误拒，Worker仍受deny保护。检查记录/规范路径、tmpdir别名与cache族子目录；其他准备写点逐点处理，不扩大此公式。
- [ ] FA保护模式在可控入口早拒后台Bash；默认OPS Bash仅在Windows发布，macOS首期只做入口结构测试，Windows端到端单列V7，不能声称本机已验内核。purge不借普通dispatch证明启动。当前batch按同步run、await work测试，不假设其自动脱离dispatch。
- [ ] 实写验证write_file/edit_file/replace/copy/move/remove及读/page附带副作用；区分源删除、目标发布、audit/cache/lock、部分完成与未知结果。
- [ ] 保留健康无deny的Full-access外部写入语义；runner不可用或准备失败时不降级裸启动，错误如实表达是否可能已有副作用。

**退出条件**：V1/V2及X3/X7在声明范围通过；每次记录argv、准入/工具身份、文件前后哈希、创建/删除及缓存变化。dry-run、受限字符串或错误文案均不能替代真实副作用检查。V1/V2在普通tmp兄弟根夹具必须到达受限Worker；V6/V9另外共用deny覆盖tmpdir祖先、cache族根/后代的准备早拒夹具，不能用后者冒充V1/V2通过。X3的j-/r- page只走PTC，Native result仅ref://；shared A4可能先拒绝，legacy则需观察裸Worker对照。PTC、Windows未完成保持独立未验证状态。

### P3：Phase A实时多目标活动与子目录指令

拟修改面：现有 `src/compat/instruction-activity.ts`、`src/instructions.ts`及调用期有界索引；实际最小修改面由P0核对。

- [ ] 按ADR D2.1在最终tools/result解码Native canonical receipt与PTC Outcome；逐项识别read_files的completed/partial，不用外层成功覆盖子项失败。
- [ ] 关联callId/子调用/Session及请求路径观察；fs/observed仅作host规范化佐证，不宣称证明Worker实际对象。
- [ ] 仅将确证成功目标交给既有目录链发现；dry-run/planned/rejected/unknown、post-execute替换或整体失败按合同处理。
- [ ] 在真实AgentLoop检查从文件父目录到附属根每级指令、相对cwd、重复目标、预算、撤销和多Session隔离；Native与PTC分开取证。
- [ ] 验证有界索引在取消、失败、卸载及缺失最终结果时回收；保持根级指令、Skills、工具动态发现、dedup和官方工具恢复路径。

**退出条件**：V4的live部分通过，模型实际请求中只有合格目标引入对应指令。Phase A不增加持久事件，不声称修复resume；P2阻断的PTC路径不能以合成成功事件冒充端到端通过。

### P4：Auto Review完整性单独验收

拟修改面：`src/review-context.ts`与P3同源目标正规化；维持ADR-0021及Auto Review现有精确宿主边界。

- [ ] 区分本次待审目标与历史成功活动，覆盖多个文件及父目录链；不得把待审参数登记为成功touch。
- [ ] 无法可靠获取动态目标、历史活动缺证、预算不足或来源不明时技术失败；只返回complete快照，不新增incomplete schema或默默填空。
- [ ] 在Auto Review精确0.2.1-rc.2基线验证目标、来源、digest、权限重验证及无OPS对照。

**退出条件**：F06对应遗漏不再以complete返回，真实Review路径结果可审查；历史证据依赖尚未完成的Phase B时，必须验证失败关闭，不能伪称恢复完整。

### P5：条件分支与上游协作

2026-11-05 用户明确授权本仓部分：不修改 OPS，允许合法附加根操作被误拒，不允许只读附加根被写入；首次实施仅验证 macOS，其后按用户要求补齐 Windows 保守拒绝验证，证据统一见[总账](./2026-09-12-multi-root-workspace.md#ops-p5-本仓兜底验证2026-11-05)。按 [ADR 的 P5 修订](../../decisions/ADR-0027-ops-file-authorization-and-activity-adapter.md#p5-本仓保守兜底修订2026-11-05直接授权实施)收紧 WW/RO 与无来源进程启动，取代首期维持现状规则。下表恢复可用性所需的上游合同仍保留，不假装已接入。


| 分支 | 待完成工作 | 退出条件/对应证据 |
| --- | --- | --- |
| WW/RO固定文件 | 评审应用层信任路线的所有写点、host准备及路径身份；或接入OPS私有temp/cache计划后生成可见profile | V6/V9、X4；宿主可见temp、有效ref、deny优先且无额外共享temp授权；拒写与合法可写分别验收 |
| D3统一写授权 | MR公开provider一侧与OPS host/envelope/Rust/batch接入；能力协商、记录canonical根相等、deny词法/规范双边界 | V5三态×三模式实写；官方旧Worker和自定义Worker均不静默忽略字段；同次admission不重新取epoch |
| F07 cache前置声明 | POSIX cache需求在confine前审批，最终argv只生成/记忆一次；不改写已证明约束 | V8/X4：先记录旧版拒绝，再验证新桥启动一次、cache可见且deny不可穿透 |
| Phase B安全记录 | 明确安全API与experimental耦合决定；版本结构门禁、schema、预算、幂等及诊断 | X1、V4恢复部分：真实jsonl重开、卸载MR重开、崩溃/迁移/记录丢失；早期无API版本仍不启用 |
| 后台/maintenance/Windows | 独立launch准入、缓存清理及Windows直接ACL准备的可控入口；已有进程与新启动分开 | V3/V7、X6；失效证明不能启动，新调用不复用旧授权，残留/partial/unknown诚实上报 |

上游工作先形成可审查的接口需求与测试契约；本计划不授权自动修改上游、发送消息或提交上游PR。未解除依赖的分支保留限制，不能由MR侧私有补丁替代公开合同。

### P6：组合回归与交付范围评审

- [ ] 按“精确版本 × OS/runner × mode × Native/PTC/维护入口 × 能力”记录结果；分别写清保护、合法可写性、live、resume、Review是否可用。
- [ ] 对共享/legacy、cap嵌套、失权/卸载、新旧操作、零根/无OPS/无optional peer及原生工具执行回归。
- [ ] 完成适用的仓库与打包门禁；只对有真实证据的范围提出支持声明。
- [ ] 将尚未完成的条件分支明确留在active范围或另立后续计划；不能以首期通过把整个适配标完成。
- [ ] 维护者评审通过实际交付范围后再决定合入/发布；本计划不预设版本号、不自动提升支持矩阵。

## Validation 与证据管理

V1–V9的完整定义以[ADR D6](../../decisions/ADR-0027-ops-file-authorization-and-activity-adapter.md#d6-评审与验收门槛)为准；X1–X7以[审计§14.3](../../reviews/dsh-ops-compatibility-audit.md#143-追加验证义务与原型范围)为准。本计划只分配阶段，不维护第二套通过标准。

| 证据组 | 执行阶段 | 要求 |
| --- | --- | --- |
| V1/V2、X3/X7 | P2 | 真实受限执行与副作用，不能只测preflight |
| X2/X5 | P1及P2回归 | 真实子dispatch、withToolCap双顺序、scope guard存活、ready代次及guard后卸载窗口 |
| V4 live | P3 | 真实模型请求与逐项目标，不以手动事件注入代替 |
| Auto Review精确基线 | P4 | complete或技术失败，当前目标与历史来源分别验证 |
| V3/V7、X6 | P2早拒对照；P5完整入口 | 后台启动、维护残留、Windows准备与实际文件效果 |
| V5/V8、X4 | P5 | 上游桥与Linux原生runner |
| V6/V9 | P2及P5 | 区分普通tmp兄弟根内核用例与tmp/cache族准备早拒用例；另测重定向/链接/祖先变化 |
| X1、V4 resume | P5 | 安全记录API和真实持久化生命周期 |

本轮按用户要求，`docs/reviews/` 只提交审计 Markdown；证据目录保持本地、不提交，报告中的证据文件名是历史本地索引。可复跑的 P5 验证程序放在 `scripts/verify-ops-protection.mjs`，输出留在隔离宿主目录。

每份记录包含commit、依赖清单、OS/runner、模式/根权限/cap、调用入口、准入生命周期、argv、业务和准备副作用、最终结果及复跑命令。沿用CONFIRMED（标明函数级或端到端）、CODE_RISK、PASS、NOT_TESTED；不适用需说明实际API/发布条件。历史证据不作为仓库交付物；阶段进度及发布状态只更新总账。

实施后的仓库检查按[开发工作流](../../development/plugin-development-workflow.md)和ADR D6执行：相关单测及组合测试、`pnpm compat:check`、lint/typecheck/build、`pnpm docs:check`；在纳入声明的各OS运行 `kernel:probe`、三个smoke、`pack:check`、`smoke:packed`。涉及Auto Review还运行其fork校验及smoke。OPS升级时重跑已有cache-profile探针并复核提取边界，不能跳过断言。

**基线说明：建计划与首期实施时尚未运行的 kernel/smoke/pack 检查属于历史状态；P5 的 macOS 与 Windows 结果以[总账](./2026-09-12-multi-root-workspace.md#ops-p5-本仓兜底验证2026-11-05)为准，不推定 Linux 通过。**

## Risks 与停止条件

| 风险 | 停止/收窄条件 |
| --- | --- |
| profile保护不到host准备 | invoke之前无法证明或阻止写入时拒绝该调用；不能只凭Worker受限验收 |
| 重载或反向依赖撤掉保护 | 新OPS调用仍可裸写则阻止交付；删除deny不是解决方案 |
| WW temp/cache不可见或身份不可知 | 停在路线评审/上游依赖，不开放整个tmpdir |
| PTC内层frame、cap或工具来源不一致 | 拒绝启动，补真实链路证明；不能重登记任意外层argv |
| 会话恢复/Review完整性被高估 | Phase B关闭或Review技术失败；不写不安全事件、不伪报complete |
| 平台或版本不可测 | 标NOT_TESTED并排除相应兼容声明，不由另一平台推定 |
| 所有模式失权及 WW/RO 有 deny 时拒绝 OPS 执行（含读） | 按 P5 在启用/支持说明中明确误拒代价，与原生 fs/进程降级路径分开描述 |

## Documentation Impact

- ADR-0027保留设计决定与待决合同；只有维护者明确决定后才改变状态。
- 审计报告保留历史基线与新增证据等级，修复后的对照记录追加说明，不覆写原始结果。
- README双语已知限制只随已验证能力更新；不在原型通过时删掉尚未解除的限制。
- 本计划及双语计划索引负责任务导航；总账负责实际进度和发布状态。
- 仅实际发布时更新双语CHANGELOG，并遵守既有发布流程。

## ADR与计划联合复核记录（2026-11-01）

本轮仅写入R1–R4规则：WW/RO过渡固定为维持现状；缓存准备按精确路径族判定；scope guard负责fence缺席拒绝，ready token带实例/代次；withToolCap包住完整准入和执行域。P0增加Auto Review宿主，P3 Native可与P1并行，Windows后台早拒仅结构测试不冒充平台通过。合同详见ADR D1.1a/D1.1c/D1.3；所有开发复选框保持未执行，状态仍Proposed。

## Completion Criteria

计划当前已落地 P0–P4 子集及 P5 本仓保守兜底（见[本轮实施状态](#本轮实施状态)），尚无已验收阶段。后续完成需满足：获准的阶段具备退出证据；所有目标能力明确通过、拒绝支持或转入经维护者确认的后续范围；现存风险与能力边界在用户文档中一致披露；适用门禁通过，维护者完成交付评审。只有全计划范围已处置后才迁移至 `completed/`，不能因文档检查通过或首期原型完成提前归档。

## 本轮实施状态

ADR-0027 保持 Proposed，未经维护者正式接受；本轮按直接授权实施，ready 状态经 scope 只读字段（Cordis traced identity 安全）而非 WeakMap 传递，scope 重挂载走 notready/token/drain。

- P0 宿主与基线：两个隔离宿主 `host-dsh-0.2.0-rc.2` / `host-dsh-0.2.1-rc.2` 已建，证据 `docs/reviews/dsh-ops-audit-evidence/ops-adaptation-baseline.json`。
- P1 授权与隔离：`src/compat/ops-tools.ts`（exec/publish/unknown 分类、dispatch barrier、withToolCap、tools.guard、token 生命周期、revoke→drain→restore），`src/process-fence.ts`（OPS 进程 confinement + redirect），`src/scope.ts`（withToolCap + capForTool 父收窄）。测试 `tests/ops-compat.spec.ts`、`tests/process-fence.spec.ts`。
- P2 准备拒绝：FA authority-unavailable 预检、POSIX cache-overlap 早拒、ops_bash run_in_background 拒绝（仅结构断言，非平台实测）。
- P3 活动恢复：`src/compat/instruction-activity.ts`（stableOpsJson/opsActivityEvidenceKey/OPS receipt 规范化/重放），`src/instructions.ts`（有界 live index、fs/observed global:true、tools/result 指纹匹配、liveOpsEvidence、abort/throw/dispose 清理、观察者不更改业务结果）。测试 `tests/ops-activity.spec.ts`、`tests/ops-instruction-activity.spec.ts`、`tests/instruction-activity.spec.ts`。
- P4 Review 集成：`src/review-context.ts`（pendingInstructionTargets + pending 身份绑定指纹），snapshot 沿用 liveOpsEvidence 并前置完整证据校验；历史 OPS 缺证据、动态目标、冲突证据均 review-context 技术失败。Host B 测试 `tests/auto-review/ops-context.spec.ts`（含真实 resume）与 `context.spec.ts` 回归。
- 真实 AgentLoop 证据：`ops-adaptation-loop-host-a.json`（0.2.0-rc.2）与 `ops-adaptation-loop-host-b.json`（0.2.1-rc.2），`ops-adaptation-agent-loop.mjs` 未修改执行，三 checks 全部 pass（inspect 祖先链、partial read_files 2/3、真实 PTC run_code 双目录链）。
- 配置门禁：全部首期能力收进 Settings 行 `multi-root-ops-compatibility.enabled`（默认 `false`，实验性）；关闭时 OPS 恢复原行为、无新增兜底，显式只读根仍可能被 OPS 绕过。客户端配置卡与 Skills 开关共用 `plugins.bundle.config` 唯一注册（`BundleSettingsCard`，Skills 上 OPS 下），legacy `settings.plugin.item` 分 namespace 挂卡；证据 `tests/client-ops-settings.spec.tsx`、`tests/client-bundle.spec.ts` 构建物断言、`/tmp/ops-mode-ui.html` DOM 快照。回归覆盖真实 Settings 保存与重启、关闭路径、准备中切换、在途保护及跨代次结果，见 `tests/ops-settings.spec.ts`、`tests/ops-activity.spec.ts`、`tests/ops-compat.spec.ts` 与 `tests/auto-review/ops-context.spec.ts`。
- 首轮仓库验证（非 P5/P6 完整验收）：full suite / lint / typecheck / build / docs:check 一次通过（`final-*.log`）；Host B Review 规格 36/36 与精确 typecheck（`p4-hostb-rc2-*`）。当时 smoke/pack/kernel probe 未运行。本开关变更已补 `pack:check`，其余平台、kernel 与 smoke 验收仍未完成，不能据此宣称全计划验收完成。审计 §16 历史复验在开关加入前完成，代表启用路径；复跑须显式 `enabled: true`。


## P5 本仓交付范围

代码：全模式 OPS admission 复核、WW/RO 有 deny 时准备前早拒、scope 存活的无来源 spawn 拦截、同步启动交接及过期拒绝、叠加包装的退役恢复。回归在 `tests/ops-compat.spec.ts` 与 `tests/method-wrapper.spec.ts`；真实 macOS / Windows 组合程序是 [verify-ops-protection.mjs](../../../scripts/verify-ops-protection.mjs)。Windows Full-access 有 deny 时同样在 OPS Worker 准备前拒绝，不声明受限 Worker 准备或合法写入已恢复。

复跑需隔离的 DSH/OPS peer 兼容宿主：`<host>/package.json` 与 `node_modules` 统一版本，保留 npm `package-lock.json`，`<host>/ops-current` 为原样 OPS 检出副本，完成其公开 build/build-ptc 与 stage（或使用同版本官方包中校验过 provenance 的 Worker，显式设置 `DSH_OPS_WORKER_BIN`）；不更改本仓 pin、OPS 源码或用户 profile。运行 `node --experimental-transform-types scripts/verify-ops-protection.mjs <host>`；Windows 先运行本仓 `pnpm build`，夹具需真实 Windows 原生进程与 junction 权限，PATH 首位使用非打包 pwsh。程序复制当前 MR 源码及 Windows runner 构建分片，设置隔离 `DSH_HOME`，保留文件树、准备 profile、argv、版本/源码摘要和 `p5-results.json`。Windows 额外检查无 deny 的真实读写正对照、后台 Bash、失权与 temp 重叠早拒；不把未触达的 PTC 子 dispatch 或未注册的 purge 算作端到端通过。实际结果见总账。

Phase B 因 DSH 明文禁止外部调用其实验记录 API 而关闭；MR 侧不创建一个没人消费的 D3 授权 provider，也不改写 OPS 私有协议来假装接入。D3、F07、合法后台/maintenance 和 Windows 受保护的 Worker 准备仍待公开接缝；Windows 本次验收的是保守拒绝，Linux 尚未验证。以上依赖解除前全计划仍留在 active，P6/发布不在本次完成声明中。
