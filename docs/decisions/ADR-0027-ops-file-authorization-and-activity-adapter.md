# ADR-0027: OPS 文件写入兜底、统一授权桥与附属根文件活动适配

## Status

**Proposed — 未接受，待评审。此处“未实施”描述的是初始修订；其后首轮已按直接授权实施首期子集（见[专项计划实施状态](../plans/active/2026-11-01-ops-compatibility-adaptation.md#本轮实施状态)），接受状态不变，完整决策不视为采纳。**

本文的 Decision 均为拟议决策，不修改当前支持声明、配置默认值、兼容 allowlist 或已接受 ADR。维护者评审通过前，不将任何方案描述成已上线、已验证安全或已解决 OPS 兼容性问题。（初始修订当轮只补充隔离取证和文档；直接授权实施见专项计划。）

## Date

2026-10-31；2026-11-01 经独立架构审计A1–A13及ADR/计划联合复核R1–R4修订，状态仍为Proposed

## Context

### 1. 目标与证据基线

本提案按以下顺序处理：

1. Multi-Root 为 OPS 自行执行的 Native/Rust 文件写入提供可落实的拒写兜底。
2. 修复 OPS 活动没有触发附属根**子目录指令发现路径**的问题，包含 live、resume 与 Auto Review 的同源重建。
3. 修复可写附属根被 OPS 自有预检拒写的问题；不得以切换全局 Full-access 换取局部可写。
4. 重新界定 toolAccess、权威不可用、Bash/PTC 与异步生命周期风险，分别规定证据和修复责任。

基线、commit、平台、原始证据和测试限制统一在[兼容性审计](../reviews/dsh-ops-compatibility-audit.md)，本 ADR 不建立另一份版本支持矩阵。对象是 MR v0.1.13、OPS 当前本地 0.5.0-alpha3 快照及其 0.4.4 对照；统一动态宿主为 DSH 0.2.0-rc.2/macOS arm64。MR 开发 pin 的 DSH 0.2.2-alpha.2 超出当前 OPS peer 范围，不能据此承诺兼容。

审计已经确认：Full-access + 显式只读附属根下，原生 fs 写入被拒，实际发布的 ops_write_file 可修改该根文件。OPS 的 ctx.fs.resolve/stat 和 fs/observed 是观察用途，实际写入由裸 Rust Worker 完成，不经过 MR 的 writeText/editText 或 confine。

后续无副作用 dry-run 又确认了三个误拒预检：WW+inherit、WW+固定RW、RO+固定RW；MR writableRoots 含目标根，而 OPS 在 Worker 启动前拒绝。主根对照 dry-run 正常，所有目标文件哈希保持不变。这里确认的是**预检误拒**，不是宣称三种模式都完成了真实写入测试。见审计 §11。

### 2. 两个不同问题需要两个接缝

**安全兜底**需要使 OPS 实际执行进程承受 MR 的写边界。只在工具入口做一次字符串路径检查，无法覆盖 replace/batch 动态枚举、move 的两端、副作用、链接变化及执行中路径替换。

**误拒修复**需要 OPS 自有授权算法接受宿主授权。即使 MR 给 Worker 更宽的合法 kernel grant，OPS 在启动前已经拒绝的请求仍不会运行。当前 OPS public integration/options 没有替换 execution/files 授权算法的 hook；不能把一个拟议接口写成现有能力。

另有关键差别：OPS 当前 deny_roots 属于 credential read/traversal fence。将 MR **写入** deniedRoots 填入该字段，会让只读附属根连读取都失败，违反既有契约。

### 3. 约束

延续 [ADR-0017](./ADR-0017-three-state-root-access-and-sandbox-modes.md) 的三态权限、[ADR-0024](./ADR-0024-registry-operation-admission.md) 的操作准入、[ADR-0025](./ADR-0025-shared-registry-authority.md) 的 owner/follower 及 [ADR-0010](./ADR-0010-additional-root-instruction-scope.md) 的指令语义：

- Registry → multiRootScope 仍是唯一根授权来源；适配器不维护第二张根表。
- Session origin 决定 Registry key；effective cwd 仅用于相对路径解析。
- 工具 cap 来自可信 dispatch 的 exec.name；嵌套只能收窄，调度外未知身份按现有合同收窄。
- write-deny 优先于 writableRoots、主根和 temp 的更宽授权；只读不等于禁止读取。
- Full-access 健康权威下保留一般外部路径可写；有局部限制时保留 protectedHome。权威不可用时不继承共享 temp grant。须区分实际降级路径：fs 保留 primary-only；共享 Registry 卸载后 admissionProof 仍在，无活跃 frame 的原生 confined/store spawn 被拒，不能宣称所有原生进程仍可 primary-only 执行。legacy 或仍有 fallback admission 的路径另行验证。
- 已准入操作可按当次快照完成；撤权不等待所有旧进程退出。不将这一设计重新解释成每一步都必须重新取得最新 Registry epoch。
- 过期授权不能供独立新操作、缓存 argv 或已过期异步后代复用。已有进程保留启动时内核快照的边界必须如实披露。
- 无 OPS、健康空 scope 且无工具限制时保持既有直通语义；用户自己的终端不纳入 Agent 限制。
- 不修改 DSH 上游包，不深导入 OPS 私有文件，不修改全局 sandboxPolicy、不把用户模式偷偷改成 Full-access。

## Decision

### D1. 先交付“写入安全兜底”，再承诺“完整文件兼容”

拟将交付能力拆为两个独立状态，避免用“已经安全拒绝”冒充“合法操作全部可用”：

| 能力 | 当前 OPS 可走的路线 | 达标标准 |
| --- | --- | --- |
| 保护模式：封住 OPS 自行写入绕过 | MR 在已验证宿主的可信 dispatch 内建立写执行边界；无法建立时，在产生副作用前拒绝受影响调用 | 不再出现审计 F01；cap/权威不可用有真实副作用验证；可能仍存在误拒 |
| 完整文件兼容：保护且不误拒 | OPS 接入 D3 的逐操作授权桥；MR 与 OPS 共用同一有效边界 | 三态×三模式、primary/additional/outside、源/目标及故障降级全部满足合同 |

“保护模式”和“完整文件兼容”是本文的拟议验收分类，不是已经存在的设置名或 UI。

#### D1.1 兜底放在执行域，不只放在工具参数解析

优先复用 process-fence、Registry admission 与 sandbox provider 的现有能力，增加面向 OPS 固定文件执行的适配策略：

```text
可信工具分发（确定 Session、exec.name、调用所有者与生命周期）
  → 本次 owner admission / 保守降级
  → scope.resolve 得到本次写授权与拒绝边界
  → 在异步工具入口完成 runner/profile 准备
  → 有效期受控的执行上下文
  → OPS 的 ctx.subprocess.spawn
      → 对裸 Worker 应用本次边界后启动
      → 对已 confined 的调用核对本次 profile，避免盲目重复包裹
  → callback 结束使启动上下文失效
```

该段是目标调用链，**当前 process-fence 的 aroundTool 只提供 admission，没有自动为 OPS 建立 PreparedDeny**。实现需新增这一步，不能把现有包装存在当作已完成。

- Full-access：健康权威下有 deny/cap 时，**全部 OPS Worker 启动（包括读、page、spill）**都使用本次 restrictedExecution，保留 ambient-minus-deny 语义。不能按业务 mutation 分类豁免进程。authority unavailable 时，首期对这些可能写盘的 OPS 调用在正文前拒绝；若以后保留可证明无副作用的入口，须独立证明其准备和执行都不写盘，或在有效 admission 内建立 clamp，不能裸启动。
- workspace-write/read-only：**首期过渡选择“维持现状并披露”**，新增OPS保护策略和存活guard只针对Full-access，不给WW/RO固定文件新增profile或失权早拒。RO读调用保持read_only=true，不因本ADR新增的失权规则被拒；既有OPS预检和MR confined/profile检查仍可拒绝其他路径。WW/RO完整保护按D1.1d另决；此选择保留temp重叠、失权与F07等已披露缺口，不代表接受OPS写根信任路线或确认安全兼容。
- spawn 的同步返回形状不变；异步准备前移到可信 dispatch，不能将 ctx.subprocess.spawn 改为 Promise API。
- 不按 Worker 文件名或 argv 字符串猜权限，也不在 spawn 时临时从“最近一次 Session”补身份。
- 进程有 partial enforcement 时，按**本项文件写边界**的真实覆盖能力验收；不能仅凭字符串 full/partial 宣称正确。
- 同一进程派生的子进程继承其内核限制；新的 host RPC Worker 必须有自己的有效入口，不假定自动继承。

适配范围必须列明已验证的 OPS Native 文件能力、PTC 文件 dispatch 和独立 batch/result 路径。当前宿主可利用 tools/execute；宿主或工具没有可验证执行生命周期时，不通过猜测继续启动。

#### D1.1a 触发条件与分模式覆盖表

**先分模式再判断**：首期新增早拒/profile/存活guard仅作用于Full-access；WW/RO走第一行过渡规则。Full-access再按本次admission的authority和实际deny/allow判断。`FilesystemScope.authority`只有`available | unavailable`；`redirected`是RootStatus。下表不改变既有MR检查，也不以新适配覆盖已有拒绝。

| 条件 | OPS 执行及准备的处理（不限业务 mutation） | 边界 |
| --- | --- | --- |
| workspace-write/read-only（首期） | 维持原OPS与MR调用链，不执行下列新增FA早拒或profile策略 | RO读不因authority unavailable新增拒绝；WW/RO不计入首期写保护声明，完整路线由D1.1d另决 |
| 没有可信 Agent/Session、绕过已验证 dispatch、调用已过期 | 有可控制入口时提前拒绝；没有入口时必须列为未覆盖，不能声称已保护 | 不根据最近一次Session或argv补权威 |
| Full-access + authority !== available（包括Registry卸载后） | **进入OPS执行调用的invoke/prepare/resultStorage之前明确拒绝；不调用next，不启动Worker** | legacy竞争失败的第二Host失去全部纳入适配的OPS执行调用（含读/page及主根写），不限mutation；纯工具发现/发布不是Worker执行。WW/RO不适用此新增早拒 |
| 根状态redirected/missing，目标写入需要该根的旧grant | 不授予该写入；目标不清楚的动态操作不能拿旧grant先执行 | 保留recorded边界与既有deny，不把所有其他健康根一并当作失权 |
| available + Full-access + deniedRoots非空（包括cap生成的deny） | 建立本次restrictedExecution后执行；失败则早拒 | **writableRoots=[]也可能有大量deny，绝不据此放行** |
| available + Full-access + 无deny、无其他限制 | 按既有ambient语义执行 | 仅此情形可免除本项profile；不是按“是否有可写根”判断 |
| 原已confined的Bash/batch/result | 保留既有admission/profile归属检查；不盲目二次包裹 | WW/RO继续现状，包括F07拒绝；这不是首期新加的全模式guard |

以下 mutation 分类只描述业务动作、辅助早拒和结果识别，**不决定是否建立执行边界**。PTC `result page`对j-/r- store的非RO访问也会创建`.dsh-ops`/lock；Native result只接受ref://，不走此store分支。shared且满足A4链时该PTC调用先被内层证明拒绝；legacy无admission frame校验，不能借A4认定其受保护。非RO固定读工具还可写result cache；RO读保持read_only=true且不创建/写入cache。集合按实际能力及action枚举，不以任意模型自报名称决定权限：

- FILE_MUTATIONS：`replace / write_file / edit_file / copy / move / remove`，通过目录映射为实际ops_*；`dryRun:true`仍须经过这组授权预检，不是绕过授权的通行参数。
- `ops_batch` 的 `plan / run / resume`：plan虽不发布业务文件，仍可能写audit store，三者均纳入写准备/执行边界；未知action先按Schema拒绝。
- `ops_result`：Native仅发布 `page / release`；PTC发布 `put / page / release`。put/release纳入mutation，page的**业务动作**是读，不能因为整个result能力的mutates元数据为true就一刀切拒读。page仍须满足适用的process profile与准备/maintenance边界，不获得裸Worker或cache写入豁免。purge仅是可信清理入口，不向模型新增action。
- OPS shell执行均纳入可能写入的进程域，不解析command/script_path来声称“这条命令肯定不会写”。run_code外层与其OPS子调用按各自入口校验，不把SDK加载/发现工具等纯发布动作算作文件mutation。

动作参数只选择已验证能力的操作语义，不提供Session、根授权或tool cap；以上集合不是一张额外的根授权表。

按**执行桥**再区分：

| 执行桥 | workspace-write / read-only | Full-access |
| --- | --- | --- |
| execution/files：Native与PTC固定文件 | OPS当前不调用confine；首期维持现状，D1.1d两路线留待后续决定 | OPS裸Worker；有局部deny时全部读写Worker均由适配器补ambient-minus-deny，host准备另行检查 |
| shells/session-execution：OPS Bash | OPS已有confine调用，MR在provider侧扩展；避免重复confinement | OPS跳过confine；另行接入执行域后验证；当前Windows实测仍缺 |
| execution/jobs：batch/result | OPS已有confine，但存在host误拒及F07；当前monitored batch等待work，不能假设已脱离dispatch | OPS跳过confine；每次Worker启动均需有效上下文，包括page的store写入 |

这纠正了“WW/RO下OPS都已经confine”的概括：该说法只适用于Bash/jobs桥，不适用于本ADR优先修复的固定文件桥。

#### D1.1b N1：profile生成后的cache挂载不能绕过证明

OPS execution/jobs.ts 在confine后调用exposePosixCache；kernel/result-storage.ts:52–57仅在basename(argv[0])=bwrap、separator前有 `--tmpfs`/`--tmpfs=`、storage有效且不是Windows cache时，在 `--` 前追加 `--bind cache cache`。MR rememberOperationProfile记忆原argv；operationPermitsProfile按**原argv逐元素前缀**核验。插入挂载选项使原prefix不同，shared Registry的spawn归属检查因此可能拒绝本来合法的batch/result启动。

已由原函数与MR证明函数的无进程结构探针确认“改写前true、改写后false”，但真实Linux组合尚未运行，端到端误拒保持CODE_RISK。已核对上游0.2.0-rc.2：**选中bwrap的每次WW profile都带tmpfs**，因此共享模式下所有取得有效storage并到达该启动分支的WW batch/result均受影响，包括page；不是偶发mount组合。普通RO bwrap没有tmpfs、无storage或其他runner不触发该改写。POSIX cache选址不依赖confine结果，可先声明/审批再生成profile，没有循环依赖；Windows位置来自confine，但不走该bind分支。

**拟选合同**：最终挂载与profile必须在同一次有效admission内确定，OPS在confine之前向可信公开桥声明当前Session私有cache需求，由MR/宿主provider按D1.1c审批、生成**最终argv并记忆证明**；下游不得再改写其执行约束。当前OPS还没有该公开cache需求接缝，必要的上游改动与D3桥协同评审。旧版发生后置变更时保留安全拒绝，标为未完整兼容，不能无条件重新登记变更后的argv或忽略extra flags。

不采用“跳过新增--bind再比较”或笼统的结构等价匹配：追加的可写bind可能在更早的ro-bind覆盖范围下重新授予写权限；**当前严格拒绝正阻止这条未批准执行链**，不能将可能的deny覆盖风险写成已成功越权。若以后另提语义化比较，需独立评审每种flag、顺序、mount遮蔽和deny/temp重叠，并用真实内核证明只收窄；本ADR不据此放宽现有匹配。

#### D1.1c N2：显式盘点私有写区域，枚举不等于授予

为固定文件Worker加profile属于新行为，WW/RO可行性按D1.1d处理。涉及私有区域时必须盘点当前Session的 `dsh-ops-session-*` temp、对应 `dsh-ops-results-*` cache，以及batch operationRoot下audit store，记录canonical路径、归属/生命周期和tmpfs遮蔽。OPS当前没有公开全部精确路径，MR不能推算私有nonce；内核路线需要公开计划，或在无法证明时早拒，不仅依赖上游tmpdir grant。

这些需求仍与同一次MR授权、OPS每Session隔离和mode限制取交集：**显式deny（包括temp祖先deny）优先；RO不因缓存需求自动获得额外temp写权限**。cache与audit store不得获得特殊豁免；不可写/不可见且无法在已授权区域解决时，在启动前明确拒绝受影响操作或声明该功能不可用，不能退回裸进程、临时改mode或追加可写bind覆盖deny。

已经批准的有限私有目录在最终profile中按需授予，并在生成证明前解决可见性；不得为一个cache暴露整个共享temp、其他Session目录或DSH_HOME。host进程内mkdir、独立purge Worker等准备和维护仍受D1.4的独立覆盖义务约束，不能声称Worker profile自动保护了它们。

Full-access的kernel prefix保护不到**host内的resultStorage准备**。首期POSIX缓存准备按以下规则在invoke前检查，不以“tmpdir下面有登记根”作为拒绝条件：

1. 取`T = realpath(tmpdir())`；已核OPS仅在T直接创建`dsh-ops-results-<64位小写hex>`叶目录，key来自私有nonce，MR不推算key。候选cache族是T下这些目录及其后代，不是整个T。
2. 对本次deny的记录路径与可取得的规范路径分别做**路径分段**比较，统一tmpdir已知别名但保留记录边界：若deny包含T（祖先或相等），或deny位于T下且第一段匹配`^dsh-ops-results-[0-9a-f]{64}$`，判为可能重叠并提前拒绝。后一条件包含cache根本身及其子目录；不能只看deny的basename。未知key会使cache族内其他Session目录也保守命中，这是有界误拒，不是授权。
3. T下普通兄弟目录（例如`T/project`、`T/audit/additional`）不命中此cache准备检查，仍由Worker的实际deny profile保护；它们必须可进入受限Worker以完成V1/V2。记录路径即便失效也不得丢弃；T无法规范化、版本改变cache选址或相关身份无法确定时，拒绝受影响的准备调用，而非假设无冲突。
4. OPS的叶目录lstat拒绝符号链接、非目录、group/other权限及错误属主；创建使用0700。该检查约束cache形状，不证明并发祖先替换安全。按D3路径身份及V6继续验收；不能用它忽略记录deny。
5. 其他host写点分别按其实际目标判断。ensureSessionTemp当前只在WW mutation分支触发，首期维持现状；未来接管它时，用精确session-temp路径检查，不套cache族公式。Windows cache/ACL准备、purge及业务audit不在此POSIX公式的豁免范围，走各自待决入口。

V1/V2的普通tmp夹具应观察到受限argv；deny覆盖T、cache族根/后代的夹具应观察到正文前拒绝且无mkdir/Worker。两种测试分别验收，不能以早拒代替内核执行用例。

#### D1.1d WW/RO固定文件：两条待决路线

撤回统一补内核profile的MR单侧实现承诺。可评审的较小路线是**显式信任已核版本OPS的host预检和Rust write_roots/read_only执行**：WW业务写被主根与私有temp夹住，登记规则排除主根与附属根重叠；RO平拒业务mutation。MR仍需在正文前验证权威、准备/缓存/业务写域与deny的关系，按词法和canonical边界早拒。该路线不会修复可写附属根误拒。

“只有temp重叠和失权两个例外”不是已完成的覆盖证明：result cache不由文件write_roots统一授权，host准备也不经过Rust；根重新canonicalize、no-follow及实际每个副作用点仍需验证。该信任选择须由维护者明确接受并有实写测试，不能据此宣布整个WW/RO桥安全。另一条路线由OPS先公开temp/cache需求，MR生成可见且受限的最终profile，Linux/Windows分别验证。两条路线均未实施；未来选择保护路线后，无法证明时才按该路线提前拒绝。**首期明确选择维持WW/RO现状并披露，不执行此未来早拒规则**，不承诺该车道完整兼容。

#### D1.2 无法可靠执行时，拒绝先于副作用

不能构造对应方言、无法判断是否重复 confinement、无法保持调用身份、发现 profile 已失效或生命周期无法隔离时，对需要保护的 OPS 调用（含读Worker）在进入正文前返回明确拒绝/不可用。原生替代工具是否可用须依当前降级路径判断。prepare失败归入明确的不可用/拒绝结果，不作为未处理dispatch异常；不得先运行再把成功输出改成拒绝。

早拒必须位于OPS invokeTrusted、prepareWorkspace、resultStorage和其他工具正文hook副作用之前；hook优先级及两个加载顺序需证明。这里的“零副作用”仅指本次受阻OPS调用及其准备，不包括早已发生的宿主日志。启动后runner失败/中断由OPS保留EXECUTOR_UNAVAILABLE或RESULT_UNKNOWN及真实effectState，不伪造“没有发生写入”。FA保护行或Registry卸载后的受影响新调用早拒；进行中调用依ADR-0024完成或诚实报告未知，不改写历史结果。

这是保护模式的保守退路，允许误拒，**不作为完整兼容通过**。不要静默卸载 OPS、关闭整个 profile 或全局禁用原生读写能力。若连安全的拒绝入口也不可用，该组合不能被标为受支持。

#### D1.3 身份、激活和卸载

- 新增扩大/消费根授权的适配行必须受 multiRootCompat 与 multiRootProviders 门禁约束；保留 fs/sandbox 两个 provider 不硬注入兼容门禁的例外。
- **保护行不能硬依赖 multiRootRegistry 的存在而在 Registry 卸载时一起消失**。Registry 暂缺或 teardown 后仍应保护后续 OPS 调用；按 scope 的 unavailable 事实降级，不能依赖“服务没了，所以不运行保护”。
- 对 OPS 版本/形状的分支集中在 src/compat；只测试和声明两插件支持交集，不扩大本包 DSH allowlist。未接入的 OPS 版本不能默认为安全。
- 工具名可用于保守收窄路由，但不能成为授予写权限或豁免限制的可信证明。正式桥接的注册所有者/opaque definition 身份必须可验证；当前 OPS 内部 provider bookkeeping 未公开导出，不能深导入复用。
- 优先使用已有 Cordis 生命周期与公开工具 hook，保留 caller this、属性描述符、取消和恢复行为；不改写 shared tools registry。
- 兜底生效/失效与 OPS 动态发布、重装、MR 保护行卸载必须有顺序合同。无法安全卸载时，应明确阻止相应受影响操作或将组合标为退出支持，不能让保护消失后 OPS 悄悄恢复裸写。

**待评审关键点**：现有 hook 是否足以在 OPS 全部动态/Native/PTC 路径建立不重包、不泄漏的执行域；需要何种可靠的注册来源识别。必须做隔离原型并满足 D6；本 ADR 不预先把可行性认定为完成。

**保护存活合同（R3，拟新增能力）**：将只拒绝、不授予权限的guard归scope生命周期所有，process-fence只负责发布自己的执行保护就绪状态，不再把MR单侧卸载保护寄托于OPS停用入口。

1. scope经公开`tools.guard()`注册全局同步guard。已核0.2.0-rc.2该API在pre-execute waterfall后、dispatch前执行，返回字符串即单调拒绝；首期两个宿主均须验证这一语义。guard不依赖Registry或process-fence服务存活。通过scope的可选子注入绑定tools、policy及既有compat/provider门禁，不给scope或fs/sandbox新增硬兼容依赖；不支持/品牌冲突时不启用本适配，保持不变量7的未安装语义。
2. 使用可信exec.name匹配受适配的OPS执行能力，包括Native与PTC发布名；这是保守拒绝集合，不是授予权限的身份凭证，纯发现/发布入口不纳入。同名第三方只能被收窄。guard以可信Agent/Session解析policy，并通过`previewForTool(policy, exec.name)`查看父cap收窄后的限制；不能在准入前用缺frame的resolve()把正常shared调用都判失权。preview只用于拒绝，实际执行仍需新admission。
3. 在Full-access且preview显示deny非空或authority unavailable时，保护未ready即返回拒绝；失权还须按D1.1a早拒。mode/调用身份无法验证的受适配执行不予猜测放行。WW/RO按D1.1a过渡，健康FA无deny不因marker缺席拒绝。
4. marker为**绑定当前scope实例的私有owner token/代次**，仅可信process-fence生命周期设置。初始not-ready，所有wrapper与dispatch策略装好才ready；effect清理先撤销自己的token、使新调用被guard拒绝，再drain已进入的调用并恢复wrapper。旧实例清理不能清掉新实例token，旧ready不能传给重建的scope。marker只证明保护组件存在，不代替admission/profile/cap。
5. guard通过与实际dispatch之间有异步窗口：scope的现有aroundTool入口也复查ready，执行策略在prepare之后、next之前复查所持代次。已进入保护域的操作保留wrapper直到drain；尚未进入的排队调用在撤销后拒绝。测试须用屏障覆盖这些窗口，不以一个布尔值检查证明无竞态。
6. 单独卸载process-fence时scope guard继续存在；单独重载scope时新实例从not-ready开始，依赖者重新就绪，旧上下文drain，不继承旧marker。整个scope卸载使MR消费者随之退出，此后按插件未安装语义处理，不承诺OPS仍受MR保护；不能把这种整包卸载当成只卸载process-fence的通过证据。

**cap执行域合同（R4，拟新增scope方法）**：提供`withToolCap<T>(name, fn): T`，同步返回值与Promise均保持原形状。内部只复用现有capForTool逻辑：`effective = capsInvalid || parentALS.capped === true || configuredCap(name) === read-only`，再以`toolCapStore.run({ capped: effective }, fn)`执行。顶层不能拿capped()的“未知dispatch”回退代替此公式，否则配置任一工具就会误封顶全部工具。

scope原aroundTool改为调用该方法；process-fence用同一方法包住**admission取得、prepare/remember、store安装、next与调用期spawn**，而不是只算一次布尔值。两层对同一exec.name的重复进入幂等，监听器内外顺序不影响结果；内层工具通过父值OR只收窄，离开恢复父上下文，异常/取消同样恢复。rememberProfile与permitsProfile仍读同一ALS，不修改证明算法或在spawn重新取Registry epoch。内层PreparedDeny覆盖外层store且在内层admission重新记忆。scope重载按上述代次/drain规则验证，不能让在飞调用一半读旧cap、一半读新scope。

以上是拟议实现合同，当前源码只有capForTool和独立aroundTool，没有withToolCap或保护存活marker。不能把接口草图写成已存在能力。

#### D1.4 覆盖证明：逐个进程位点归属，不靠一次ALS演示概括

接受实施方案前必须有完整spawn清单，包含经ctx.subprocess与直接node:child_process的入口；每个位点必须证明属于活跃执行域、属于经评审的非Agent操作域，或能够在进入前拒绝。**没有可控制的ALS外入口时，“默认拒绝”是待实现能力，不是当前spawn包装已经做到了。**

当前源码静态清单如下（前七行路径相对OPS src，末行显式使用bin/scripts；具体commit与摘录见审计）。这不是全部安装形态/可选payload的动态覆盖证明：

| 位点/调用者 | 已核对的归属 | 实施证据义务 |
| --- | --- | --- |
| execution/transport.ts:14，execution/files调用 | Native/PTC固定文件在dispatch中await exchange | 逐个能力的活跃admission、实际prefix、失权早拒 |
| 同一transport位点，execution/jobs调用 | batch/result走独立桥；monitored.ts:28–48中jobs.start同步调用run并await work | 当前batch不按“返回后再spawn”处理；验证plan/run/resume及失败回退不重复启动，未来改变调度须重审 |
| shells/execution.ts:86 | OPS Bash执行；结果等待与后台/提升路径需分开核实 | command/script_path及job提升后的launch归属 |
| kernel/result-storage.ts:104 | purge由result-lifecycle.ts:66–97触发；dispatch外无frame时，shared WW的confined spawn被当前证明闸门拒绝，FA可能裸启动 | 记录cache残留/告警为现存CODE_RISK；需独立maintenance入口，不能豁免所有调度外Worker |
| workspace-preparation.ts:120 | Windows WW prepare直接node:child_process.spawn；可由tools/execute hook或jobs/shell准备触发，不经过MR subprocess包装 | 检查ACL与backup副作用；必须在其之前早拒或证明属于独立受控准备，Windows未验证前保留缺口 |
| settings/runtime-host.ts:18 | operator runtime action经host gateway；非普通文件工具 | 证明真实operator admission及模型不可调用；若可由Agent触发须重新纳入 |
| profile-install.ts:143–144、cli/provision-shells.ts:108/147/188、rust.ts:54/139、shells/pwsh-upgrade.ts:65/78、review/process.ts:9 | 安装/provision/build/upgrade/CLI review等直接child_process位点 | 逐个以调用图证明不属于所声称的Agent文件保护域，不能仅凭目录名排除 |
| bin/dsh-ops.mjs:153、bin/check-release.mjs:39、bin/build-bash-ipc.mjs:20/31；scripts/build.mjs:50、scripts/lib/build/util.js:136/261、scripts/verify-gate.mjs:109 | 发布/CLI staging、构建与gate启动位点；非普通文件dispatch | 若operator runtime action可达这些入口，沿调用链验证operator边界；测试、bench及可选Bash payload的进一步动态归属尚未完成 |

当前Rust固定Worker源码检索未发现Command::new/子进程spawn；这不是未来版本承诺。动态spawn清单须覆盖封装、公开入口与后续新增位点，并记录Session/call/parent、admission活跃性、policy、argv是否已confined及真实副作用。

业务Worker在dispatch外新启动且不能取得新准入时，必须从可控制的launch入口拒绝；发现没有拦截入口则收窄D1支持声明并交OPS提供公开接缝，不能继续声称“OPS写入全部保护”。持久job恢复不计为旧在飞操作。固定工具内核守护也不覆盖宿主进程直接fs写或直接child_process准备。

### D2. 文件活动同源正规化；live、resume与审查分阶段验收

拟将现有“一个工具对应一个 file_path”正规化为**一个成功调用对应零到多个成功文件目标**，由现有 compat/instruction-activity 单点输出，instructions 与 review-context 消费同一结构。

| 活动 | 候选目标规则 |
| --- | --- |
| 原生 read/write/edit | 保留 file_path 与实际 fs/observed 的原有支持 |
| ops_inspect_local_file | path；按成功receipt和host请求路径观察关联候选，观察不证明Worker实际对象 |
| ops_read_files | files[] 中逐项成功的路径；不因外层成功而把失败、pending、未返回项记为触达 |
| OPS write_file/edit_file/replace 等 | 只记录已证实成功的实际文件目标；拒绝、dry-run、unknown 不冒充成功写入；读取与写入成功的活动类型分开 |
| copy/move/remove | 区分源读取、目标发布、源删除的结果，不仅从to/path猜整个操作成功 |
| PTC 文件 API | 关联真实 subCallId/dispatch/result；Native 与 PTC 投影共用正规化语义，不能只认顶层run_code |

消除 fs/observed 中仅接受 read/write/edit 名称的过早过滤，同时保持 actor===本次可信exec、调用成功关联、根内canonical验证、计数与字节预算。观察事件只是候选，不能成为额外写授权。

#### D2.1 Phase A：先闭合live成功活动与审查目标

Phase A仅修live正规化、逐项目标与当前Review目标，不增加持久事件。成功判定使用**tools/result最终canonical结果**，而不是仅看toolResultFailed或tools/execute的next()返回值：OPS的POLICY_DENIED/rejected完全可能isError=false；宿主post-execute又能把正文返回成功改为失败或替换value。

1. 按固定兼容形状解码：Native使用result.value；PTC先验证Outcome包装，再读取其中data的原始receipt。不能把PTC的completed、Native的completed、batch的planned当成同一种成功事实。
2. 单文件读取须最终isError=false、receipt.status=completed、无error/unknown；路径与本次请求和host请求路径观察匹配。参数path只用于定位候选，不自行证明成功。
3. read_files外层只接受已定义的completed/partial形状；逐项须item.status=completed、无item.error/unknown，并核对items[i].path与原请求项/host请求路径观察。外层completed不能替代逐项判断，外层partial也不能抹掉已明确成功项。pending/未返回/失败项不进入集合。
4. fs/observed只作为**请求路径在host侧规范化及actor/token匹配**的佐证；读取观察在执行前resolve/stat、成功后发出，不能证明Worker实际操作对象或独立判成功。若必要路径、逐项状态或来源证据缺失，live发现跳过该项并诊断；Auto Review则按下述complete合同技术失败。不从自然语言工具正文解析成功。
5. mutation仅从明确已应用的逐项receipt记录作用；dry-run/planned/rejected/conflict/unknown或整体失败不算成功写入。存在partial effect时，首期只收录结构化证据充分的成功项，不从changed计数推断文件清单。
6. 若post-execute替换了用于建立候选的canonical value而无法再匹配调用期观察，丢弃候选；不得以被伪造/替换的成功receipt新增触达。

live结果通过callId/token/Session与调用期收集的观察关联；最终tools/result通常已不在tools/execute ALS内，必须使用有界调用索引，不向全局“当前调用”取身份。Phase A通过不表示resume已修复；无新持久证据的旧会话仍有已知重建缺口。

#### D2.2 Phase B：持久化API先决条件与候选提交点

当前durable tool/result和PTC tool/ptc-dispatch文本不保证保留逐项canonical结果。Phase B拟追加**本插件拥有的、有界的持久活动记录**，仅用于只读发现/来源，不是授权票据或第二张根表。

**撤回普通session.append自有type的方案。** DSH 0.2.0-rc.2的append不复制ignorable字段，真实validateStoredEvents会拒绝未知且未标记ignorable的事件，安装本插件也不能改变读取白名单。此前探针只证明内存事件顺序，不证明持久化/恢复可用；补充探针已复现读取校验拒绝。不得伪装已知事件类型、修改冻结事件或私写jsonl绕过此限制。

| 版本/接口 | Phase B决策状态 |
| --- | --- |
| 0.2.0-rc.2、0.2.1-alpha.1 | NOT_APPLICABLE：当前公开接口不支持本方案，等待DSH开放ignorable记录API；Phase A可单独实施 |
| 0.2.1-alpha.2起已抽验的appendPluginRecord | API存在且写plugin:记录/ignorable；标为experimental，上游文档仅允许其packages/experimental生产源码调用。导出存在不等于外部稳定支持，默认不启用；须先明确接受该耦合并核实外部使用合同，或等正式API |
| 其他精确版本及恢复、卸载后的读取 | NOT_TESTED；结构探测、单版本恢复证据和明确维护决策均不可省略 |

候选提交锚点仍是**同步tools/result最终结果观察器**：已核版本在post-execute/finalizeContent之后、AgentLoop普通tool/result之前触发。只有安全记录API与恢复合同获准并验证后，才在此提交活动；不得await后再假定相同顺序。不能在tools/execute的next()刚返回时提交，也不能在session/event内同步重入append。

通过上述门槛后，拟议顺序是 `本插件finalized-file-activity → 普通tool/result`。记录须自包含版本、Session/call/子调用身份、最终结果的有界指纹、成功目标路径及活动类别；回放按Schema恢复，不要求普通tool/result相邻。实际flush、崩溃、记录丢失与迁移保持性仍需验证；损坏/不完整记录不重放，绝不用于写授权。

- 只使用经评审可用的ignorable记录API；没有该接口时Phase B关闭，不存在普通append退路。必须测jsonl写入后重开、卸载MR后重开及迁移，确保旧读者安全跳过并保留记录。
- 用最终结果token保证每次调用至多一条批量活动记录；回放按持久身份去重，不依赖事件相邻。用户消息里相同文本不是活动证据。
- tools/result观察器异常由宿主记录且不改变已完成工具结果。append失败时不得声称持久记录成功；保留受界限的live证据、标明resume不完整并在下一步使用前处理诊断，不伪造业务失败以掩盖已发生I/O。
- 若某支持版本无最终canonical钩子或无法保证非重入提交，则Phase B在该版本不可用，只保留Phase A；不得退回自然语言解析或提前提交。Phase B进入支持范围前需自己的恢复/崩溃与异步顺序验证。
- 相对路径以调用实际采用的 effective cwd 解析并持久化其结果，不在恢复时使用当时的新 cwd；Session origin/Registry key 不随之改变。
- 恢复后重放同一成功目标集合，继续发现从文件父目录到附属根的每级 AGENTS.md/CLAUDE.md。
- 历史记录缺乏逐项成功证据时，采用可证明的保守回退；不从工具输出自然语言反解所有路径，不将整个 files[] 都标为成功。根级指令照常工作。
- 根移除、missing/redirected、文件消失后的显式撤销，以及全局共享指令预算不变。

Native与PTC共用上述正规化；PTC durable tool/ptc-dispatch(-start)仅补时序、身份与参数，不能提供缺失的逐项成功证明。PTC最终Outcome和调用期fs/observed是live证据来源；resume依Phase B记录，不从其模型可读文本反解成功。

Auto Review 当前调用尚未执行时，参数提供的是“**本次待审目标集合**”，不等于成功活动。Review 应将这些目标与已有成功活动分别标明并合并为待发现的目录链；不丢掉第二个以后的文件目标。严格遵守ADR-0021：**只返回complete快照，否则技术失败**。动态目标无法可靠识别、历史活动缺证或预算不足时失败关闭；本ADR不引入incomplete响应、不改Review schema，也不默默返回complete。当前F06在漏识别OPS目标时仍固定标complete，属于源码可见的合同缺口；实际审批结果尚未测。

### D3. 可写附属根的误拒由统一授权桥修复

三个误拒均已在 dry-run 预检复现。原因直接位于 OPS execution/files：read-only 对所有 mutation 一刀切；workspace-write 只接受 workspaceRoot 和 Session 私有 temp。将更多根交给 MR sandbox 不会改变这些分支。

#### D3.1 首选路线：OPS 暴露逐操作宿主写授权接缝

拟推动 OPS 在**固定文件执行桥与实际 Rust 写入点**接入一个公开、可选的 host write-authority provider。以下仅是合同草图，不是已存在的 API 或最终命名：

```text
OPS 固定文件调用
  → 可信 host adapter 接收 exec 与结构化操作计划
  → MR 取得本次 Registry operation，解析统一写边界
  → OPS host preflight 消费同一写边界
  → 在该 operation 的有效执行域内准备并启动 Worker
  → Rust 在每个实际副作用点消费本次有限的写约束
  → 返回原生 canonical result / partial-effect 事实
```

provider 不接收模型自报的 toolName/Session/scope 作为权威，不把无时效的根snapshot变成新操作许可。跨 Rust 边界传递的路径约束是本次已经准入操作的执行输入；operation 身份和有效期由可信 host 持有，不能把一个序列化 token 当作未来授权。

桥接至少表达：

| 授权维度 | 必须表达的事实 |
| --- | --- |
| 主根/普通外部写入 | 主根仍按Session mode；Full-access正常保留ambient范围；不可用时不得扩大fallback，D1首期仅FA的OPS执行调用失权早拒，不承诺其主根可写；WW/RO维持现状 |
| 附属根 | writableRoots由策略×mode×真实tool cap计算；只包含本次有效成员 |
| 局部拒写 | writeDenyRoots单独表达并优先；不复用OPS credential deny_roots |
| 读取 | 继续OPS credential策略；MR显式只读根可读，不能顺带成为read-deny |
| 临时区域 | 按D1.1c显式盘点当前Session temp、result cache与batch audit需求，在最终profile前审批；mode、deny与OPS私有隔离取交集，不依赖碰巧继承tmpdir grant，也不扩大到整个共享temp |
| 实际目标 | 固定单目标、copy源/目标、move两端、replace/batch逐文件发布，均消费同一admitted边界 |
| 生命周期 | 入队/延迟job在真正执行时取得对应准入；已过期回调/重试不能重用旧operation |

最终有效写权限是宿主授权与 OPS 独立限制的交集，但**当前只承认单主根的旧分支需要被新的宿主授权路径替代**；若仍机械与旧分支相交，合法附属根永远无法恢复可写。保留 credential、CAS、no-follow、源/目标规则及每Session temp隔离等真正独立约束。

Rust 当前 read_only 全拒写分支也要按桥接合同支持固定RW例外；write-deny需要独立写检查，不能把整个worker改成“read_only=false且随便写”。桥缺席时，OPS保持原有单根行为；桥报错/未知时拒绝相关操作，不退回较宽的旧Full-access分支。

#### D3.1a 字段级合同与全部授权闸门

拟议公开桥的host输入至少包括 `additionalWritableRoots` 与 `writeDenyRoots`（canonical绝对路径，来源为本次scope），以及真实policy/mode与独立temp规则。Rust Request新增独立 `additional_write_roots`、`write_deny_roots` 和显式桥协议版本；字段名属于本提案，**当前OPS尚未实现**。

`write_deny_roots`仅由authorize_write及对应的删除/发布写检查消费，优先于任何allow；读/遍历继续仅消费既有credential deny_roots/deny_credential_names。Rust不能仅靠序列化字段存在就信任模型；它们只能由可信host在本次准入后构造。上线前必须先确认实际选中的Worker支持并强制执行该协议；旧/自定义binary不能静默忽略未知写拒字段后获得宽授权，能力协商必须先于任何副作用。

**路径身份合同（A8）**：allow根传入的是本次获准的记录canonical路径；使用时必须满足 `canonicalize(root) == 传入记录值`，否则拒绝，不能把新解析结果当成新grant。write_deny_roots同时保护记录路径的词法范围和目标规范路径范围，拒写优先；缺失叶子、链接/祖先替换按no-follow与执行点检查处理。这不是重新读取Registry epoch。当前Rust write_roots会重新canonicalize根后starts_with，不能原样扩展为附属根授权。ops-batch现有authorize_tree是credential检查，逐写点的桥授权属于**新增**，不是已有write_roots机制的替换。官方Request的deny_unknown_fields使未知新字段拒绝，这是正面默认行为，仍不能替代自定义Worker的能力协商。

一次**按操作的有效写授权**替代以下所有flat-mode/单根闸门，而不是只向某个数组append根：

| 当前闸门（OPS目标commit） | 必须改写的语义 |
| --- | --- |
| execution/files.ts:155–166：read-only mutation平拒、WW单主根/私有temp判断 | 基于同一次write decision判断每个实际需要写的目标；RO下允许scope授予的固定RW，仍拒绝主根/其他路径 |
| execution/files.ts:147–151、198–201：requiredMode与准备后复查 | 复用同一次已准入授权并检测真实policy变化；**不重取Registry epoch、不重新准入**。仍保留本次路径身份/profile有效期检查；policy变化需停止/重试时结束旧操作，再走全新调用，不能悄悄换一份授权 |
| execution/jobs.ts:78–91、119–124：batch/result全局RO、operationRoot及requiredMode | 对action和实际副作用计划求授权；合法附属根不能被operationRoot单根判断误拒；page等读动作保持原语义 |
| execution/files.ts:179与execution/jobs.ts:111：envelope read_only/write_roots | 在桥版本下传递一致的有限/ambient写语义及局部deny；不能host放行后仍用read_only全拒 |
| native/crates/ops-files/src/file_single.rs:171–203、file_publication.rs:82–93，以及ops-search/ops-batch实际写点 | 有桥时消费有效授权与write_deny_roots，无桥保留旧协议；不以read_only=false放开一切；copy/move/remove/逐文件replace和batch同样覆盖 |

review中提到的effective.additional在当前execution/files.ts内没有对应字段，monitored.ts:18–24主要做文件/jobs路由，并不承担所述RO平拒；以上以实际文件与分支定位，避免按不匹配的行号漏改。WW+固定RW当前在host拒，不能描述为当前会被Rust read_only=true拒（WW envelope中它为false）；host只修一半后RO+固定RW才会出现下游平拒。

#### D3.2 本仓库能做的事与不能假装能做的事

MR可先为D1 Full-access全部Worker保护和D2 Phase A live做原型，也可实现授权provider一侧；WW/RO固定文件按D1.1d另决、Phase B按D2.2接口门槛另决。**当前已发布OPS不消费新接缝时，MR无法仅用现有public integration/options消除误拒**。这部分需要OPS上游配合，或经另行评审的明确维护分支。

以下均不作为本提案默认修复：修改sandboxPolicy.resolve返回值、将workspaceRoot临时换成附属根、把RO/WW改为Full-access、深导入OPS execution/files、改写Worker stdin来骗过私有协议、同名注册另一套ops_*写实现。原生write/edit可作为维护者知道限制后的临时操作路径，但不等同OPS已适配。

### D4. 重新分析此前概括的绕过风险

不再把风险混成“OPS所有权限均失效”。按具体阶段和证据分开：

| 路径/条件 | 重新判定 | 拟议处理 |
| --- | --- | --- |
| Native Full-access + 显式RO | 已有真实文件副作用确认；当前版本CONFIRMED | D1必须先封住，D3恢复统一语义 |
| Native Full-access + per-tool cap | 补充dry-run中，真实admission内scope已有deny，Worker仍裸启动；**缺少实际执行约束已确认**，cap越权实写未执行 | D1使用真实dispatch cap；只改tool白名单/Registry准入不够 |
| Native Full-access + Registry卸载 | 新调用hasAdmission=false、authority unavailable仍裸启动，dry-run完成；**新调用裸启动已确认**，不是旧操作沿用快照 | D1不能随Registry消失；OPS在invoke前早拒。原生fs仍primary-only；共享模式无frame的confined/store spawn则被拒 |
| 锁竞争/owner失联/接管 | shared facade已能获取admission；快照不足时有降级规则，不能只凭“有锁竞争”就说全部绕过 | 单独测新调用是否真正使用fallback；不要把Registry实现误判为没有准入 |
| Full-access OPS Bash | 内置Windows路径跳过confine并直接spawn，MR shell入口prepare不覆盖；本机只有无进程spy，Windows写入仍CODE_RISK | 单独的进程入口适配与Windows内核实测；D1固定文件保护不自动覆盖Bash |
| 受限 OPS Bash | 源码确实调用MR confine；不能一概称其绕过。是否partial、deny/temp优先需平台实测 | 保留现有confinement，验证wrapper幂等和不可用拒绝 |
| PTC文件SDK（shared、FA有deny、外层store沿pipe继承） | 内层dispatch新开admission，外层prefix不属于内层，源码链判定为安全拒绝；函数级冲突CONFIRMED，完整PTC+OPS组合NOT_TESTED | 撤回笼统“待定”；每个内层dispatch重新准备并覆盖store，保留父cap收窄，不能复用外层证明。此结论不泛化到legacy/无deny等其他组合 |
| PTC batch/result/jobs | 同样需处理内层frame；当前monitored batch同步启动run并await work，不存在所假设的返回后再次spawn链 | 测action、失败回退和inner准备；保留partial/unknown，不把一次准入变成永久许可 |
| 根在准入后被撤销 | 允许已准入工作按快照完成是ADR-0024既有合同，本身不是漏洞 | 用屏障验证撤销前后两次操作；拒绝后续新调用复用旧permit |
| symlink/rename/hardlink/TOCTOU | OPS已有no-follow/CAS，MR已有recordedPath检查；二者均不自动证明全组合竞态安全 | 最终作用对象测试；不承诺任意rename原子隔离，不通过缓存canonical结果重新授权 |
| move/remove的源侧删除 | 两者均为mutation；move在源只读根删除、remove直接删除属F01同族写面，不能只守to目标 | D1同一内核写边界覆盖源删除；D3分别授权源与目标；实删尚未测 |
| purge/私有缓存 | POSIX缓存目录由host fs创建；无admission的shared WW purge会被证明闸门拒绝，清理回调记录残留告警（CODE_RISK，完整生命周期未测） | 写入支持限制；需独立maintenance入口；无任意ALS外Worker豁免，FA裸purge另行保护 |
| OPS后台Bash | 微任务启动、工具可先返回，profile可能在frame过期后记忆/使用而拒绝；时序竞态CODE_RISK，不能说仅凭微任务就必然晚于返回 | 首期保护模式在正文前拒绝run_in_background；上游提供独立启动准入后再开放。当前默认仅Windows发布 |
| 第三方同名工具 | 按名字进入保守deny/profile只会更窄，不构成写授权绕过；可能兼容性误伤 | 测试确认只收窄、无grant/豁免；正式授权桥仍须可靠注册身份 |
| Auto Review来源缺失 | 漏掉OPS目标却标complete，与ADR-0021冲突（源码CODE_RISK）；没有证据证明审批必然放行 | D2同源修复，不能重建则技术失败；精确0.2.1-rc.2验证 |

另外，未知tool身份的fail-closed指的是既有cap合同，不是“凡是名字没见过都被禁止”。适配器既不能用模型参数扩大权限，也不能把任意第三方同名工具自动确认为OPS。

### D5. 版本与职责边界

| 工作项 | 主要归属 | 最小修改面（待评审） |
| --- | --- | --- |
| 旧OPS的FA全部Worker兜底 | Multi-Root原型 | 同一process-fence监听器内的admission/cap/profile、host准备早拒、保护存活；保留唯一scope |
| WW/RO固定文件兜底 | 维护者决定信任路线；内核路线需OPS协作 | D1.1d：OPS写根信任须单独验收；Linux temp/cache及Windows准备不是MR单侧已解决 |
| Linux bwrap+tmpfs+cache的受限batch/result完整兼容（F07） | OPS上游 + MR | 当前已有后置cache bind与证明冲突；等待公开cache需求接缝期间是“安全拒绝方向、尚未完整兼容”，不是“MR已实现待验证”；没有干净且已验证的MR单侧临时缓解 |
| Phase A子目录指令/Review目标正规化 | Multi-Root | live逐项活动；Review不完整时技术失败 |
| Phase B持久活动 | DSH API + MR；实验接口需明确决策 | 早期两版不适用；其余需API合同与真实恢复/卸载验证，禁止普通append退路 |
| 消除OPS预检误拒 | OPS上游 + Multi-Root桥接 | OPS固定文件host/Rust写授权路径；MR provider实现 |
| Bash/PTC/jobs | 双方分别承担执行入口；按路径验收 | 不与固定文件桥混为一个成功证明 |
| 既有根拓扑、Skills、read-dedup | 当前证据下无需重写 | 增加组合回归，保留作用域与原有消息可见性 |

适配代码不得因为OPS存在就污染barrel的可选依赖集合。OPS缺席时不加载OPS运行时代码；正式桥只经公开导出/宿主服务注册，接口变动经结构探测与精确版本证据管理。OPS 0.4.4与0.5候选的私有路径迁移不能成为本仓深导入理由。

### D6. 评审与验收门槛

**接受本 ADR 前需明确的决策**：

1. 是否同意先交付安全保护、将合法写入可用性作为独立状态，并接受保护无法构造时明确拒绝受影响的OPS调用。
2. 是否能用现有可信dispatch完成D1，如何绑定工具来源、避免双重confinement和遗漏PTC异步边界；若不能，选择公开上游接缝或明确拒绝，不能用猜测完成实现。
3. D3公开桥的所有者、注册唯一性、未知/失联处理与OPS独立限制的边界；确认不再拿credential deny_roots表达write-deny。
4. D2按Phase A live与Phase B持久化分别评审；Phase B最终结果钩子、先于普通result的提交顺序、Schema、失败诊断和恢复语义。
5. 保护行、Registry和OPS热卸载的顺序，以及哪些旧版本/平台只能安全拒绝、不能宣称完整兼容。
6. 确认首期WW/RO维持现状并披露，包括RO读不新增失权拒绝；后续是否接受D1.1d应用层信任路线另决，内核路线需公开temp/cache计划。不得把过渡行为留到实现时决定。

本次修订仅将**D1 Full-access全部Worker与D2 Phase A live**列为可开展最小原型的范围；PTC嵌套、Auto Review、WW/RO、Windows、Phase B及D3没有因此获得兼容声明。首期WW/RO过渡选择维持现状并披露，评审需明确确认，不能留到实现时再选。legacy竞争失权时FA下全部受适配OPS执行调用（含读）早拒，是需要接受并披露的可用性代价。

**实施后必须提交的证据**：

- 三态×三模式×主根/附属根/普通外部的真实写入矩阵；显式RO拒绝、固定RW在RO可写，不能只看dry-run或返回文案。所有用例记录文件前后哈希、创建/删除与partial effect。
- 各实际发布的write_file/edit_file/replace/copy/move/remove、PTC文件SDK/batch；源与目标、混合允许/拒绝目标、逐文件失败事实及非事务承诺。
- 原生fs、原生shell与OPS路径在同一fixture对照；Windows实际ops_bash command/script_path；Linux/macOS按实际发布范围运行，不能虚构本机内置Bash。
- toolAccess已知工具、无dispatch的未知身份、嵌套cap；authority unavailable、Registry卸载、锁竞争、owner失联与接管；新调用/在飞调用分开。
- 真实runner下的临时grant/deny优先、重定向、祖先改名、硬链接与TOCTOU；当前外层sandbox_apply失败不能算通过，也不为过测放宽真实用户环境。
- Native inspect/read_files及PTC读取的真实模型请求；根级+每级嵌套指令、逐项失败、相对cwd变化、恢复重放、显式撤销；Auto Review精确宿主的目标/来源完整性。
- 两个加载顺序、动态发现下一请求生效、OPS卸载/重装、保护行/Registry卸载、异步尾部spawn、缓存profile复用、读操作不被不必要地拒绝。
- 零根/无OPS/无optional peer、原生工具恢复、Skills内容/撤销、dedup与compaction/projection、caller this/属性描述符/取消信号。
- 在修改实现的版本/OS车道运行适用单测、compat:check、docs:check、kernel:probe、smokes、pack:check与smoke:packed。OPS升级后的兼容复核须重跑cache-profile结构探针；函数边界/语义变化先复核，不能跳过断言继续报通过。版本提升仍由维护者决定，不因适配测试通过自动扩大allowlist。

最低决定性原型用例（V1–V9均为后续实施义务，本轮没有适配器实现；函数接缝探针另行标注）：

| 用例 | 必须观察的通过条件 | 当前状态 |
| --- | --- | --- |
| V1：FA+显式RO，ops_write_file实写 | 真正受限argv/runner、诚实失败、目标哈希不变 | NOT_TESTED：仅有未适配基线越权证据 |
| V2：FA+cap；Registry卸载后的新OPS调用（含读/page） | cap受限且无写；失权在OPS正文前拒绝，**无Worker/preparation/cache准备启动** | NOT_TESTED：现有dry-run只证明缺口 |
| V3：后台Bash、purge和batch调度对照 | 后台入口在正文前拒绝或独立准入；purge记录残留/告警并验证maintenance边界；batch的run在本次dispatch内被await且不重复启动 | NOT_TESTED端到端；当前batch源码已核，不再假设其返回后再次spawn |
| V4：真实loop读取/partial与resume | Phase A只完成项的每级指令注入；Phase B先过ignorable API门槛，再测真实jsonl重开/卸载/恢复及提交中断 | Phase A适配NOT_TESTED；旧append方案已撤回，早期两版Phase B NOT_APPLICABLE |
| V5：WW+inherit/RW、RO+固定RW、batch附属operationRoot实写 | host与Rust均放行合法对象，同时不扩大主根/外部/只读根 | BLOCKED-BY-UPSTREAM；未实施D3 |
| V6：重定向、祖先改名、hardlink/TOCTOU、deny覆盖temp | 无不允许副作用；未知runner不裸启动；普通tmp兄弟根进入受限Worker，覆盖temp或cache族根/后代在准备前拒绝 | NOT_TESTED组合原型 |
| V7：Windows ops_bash的command/script_path | 如实观察是否受限并测副作用，不以spy算内核通过 | NOT_TESTED：当前无Windows |
| V8：Linux shared Registry + WW bwrap/tmpfs + batch/result | 先复现cache后置bind的旧版误拒；新桥使最终argv与本次证明匹配且只启动一次。page/release、PTC put分别按真实入口测；无tmpfs/无storage为对照 | 函数级匹配冲突已复现；Linux组合NOT_TESTED |
| V9：私有temp/cache/audit及deny-on-temp重叠 | 与V6共享固定的“deny根覆盖tmpdir祖先”夹具；已授权目录可用，deny下不能靠后置bind恢复写入；RO不凭空获得cache写权限。记录mkdir、业务文件与audit/cache副作用及失败语义 | NOT_TESTED原型/内核；含host maintenance独立边界 |


本文当前没有这些实现后验收结果；审计已有的PASS只保持其原证据范围。

A1–A13审计追加的最小实验X1–X7由[审计§14](../reviews/dsh-ops-compatibility-audit.md#14-独立架构审计a1a13复核)统一记录，不与V表重复维护。X1读取校验、X2内层证明已有函数级证据；完整jsonl/PTC、X3的page附带写、X4 Linux可见性、X5钩子重载、X6清理和X7适配实写仍待相应环境/原型。V1必须覆盖实际受限argv、原文件哈希和诚实失败，不能用探针代替。

## Alternatives Considered

| 方案 | 评估 |
| --- | --- |
| 只补ops_*工具名，忽略写入桥 | 能改善指令发现，不能封住已确认的裸Worker写入；不满足优先级 |
| 只在工具入口检查path | 单次检查不足以约束动态枚举及实际副作用对象；可用于保守早拒，不能替代最终执行边界 |
| 只给OPS Worker加kernel profile | FA执行兜底的候选；host准备仍未覆盖，WW bwrap有temp遮蔽；不能独自修复host预检误拒或声明全模式兼容 |
| 把MR deniedRoots传OPS deny_roots | 会禁止只读根读取/遍历；拒绝此复用 |
| 全局把policy改Full-access或临时换workspaceRoot | 改变主根/外部范围、Session origin与并发调用语义；拒绝 |
| 全部tools/execute无差别立即准备内核profile | 可能让纯读/无子进程工具因runner不可用而失效，增加大量准备开销；未经证据不采用 |
| 对任意subprocess按argv或env补推Session | 不能可靠确认Agent身份与授权；可能误伤用户终端并失去同步契约；拒绝 |
| MR同名接管整套OPS写工具或私有Worker协议 | 必须长期复制CAS、批处理、metadata与Outcome语义并跟随版本；不作为默认方案，若维护者选择需另行评审 |
| 只等待OPS上游、不做MR兜底 | 不能处理当前已安装版本的已确认缺口；不满足先保护的目标 |
| 永久禁用所有OPS写入 | 可作无法隔离时明确的保护退路，不能作为完整兼容最终方案 |

## Consequences

- 正面：实际文件副作用、合法可写性和上下文触发各有明确修复路径；不会以“提示词里写了只读”代替强制执行。
- 成本：旧OPS保护模式可能多一次profile准备并产生额外拒绝；完整可用性取决于OPS公开桥。必须测量，不预先声称性能无影响。
- 成本：多目标持久活动需Schema、提交顺序、恢复和预算维护；该数据仅作为指令发现证据，不能承担授权真源。
- 边界：kernel限制可能改变OPS sidecar/cache写入可用性；只给确实需要的当前Session私有区域授权，不能为兼容而扩大到共享temp或DSH_HOME。
- 边界：新增平台或OPS版本仍需实际验证；热卸载、partial enforcement、持久job与已有进程快照都有独立支持边界。
- 当前状态：**本 ADR 保持未接受；没有创建实现PR，也没有改变任何provider、Registry或OPS实现。**

## 独立评审处理记录

此前R1–R11、N1–N4与第三轮建议保留为评审历史；下列A1–A13复核纠正其中的可实施性结论。没有执行适配实现或接受ADR。当前合同以上述修订Decision为准，早期“建议接受”不替代本轮未决项。

| 评审项 | 本次处理 | 尚未闭合 |
| --- | --- | --- |
| R1覆盖证明 | D1.4枚举spawn与dispatch外purge/直接child_process位点 | V3及逐位点动态归属仍待原型 |
| R2触发/失权（早期评审） | D1.1a明确定义可用性与deny优先；A2扩展到可能写盘的读Worker早拒；本轮明确仅FA新增此规则 | V2；不采纳none/redirected为authority或零可写即放行 |
| R3/R4授权桥 | D3.1a分离Rust写拒字段，列出host/envelope/Rust/jobs全部闸门 | 上游接口与V5；纠正当前WW的read_only与不存在字段描述 |
| R5分模式 | 按固定文件、Bash、jobs三条桥分治 | 不采纳“WW文件Worker已经confine”的概括 |
| R6/R8成功与PTC | D2.1分别解码Native/PTC与逐项状态，观察不能代替成功 | live多目标适配待实施 |
| R7提交点 | 最终tools/result顺序成立；A1撤回普通append持久化方案 | 旧探针仅内存顺序PASS；Phase B须另过API/恢复门槛 |
| R9删除/缓存/同名 | D4及D1.4单列；cache残余未自动获准豁免 | deny与maintenance重叠/Windows准备仍待审 |
| R10证据 | 审计补充合成Agent与真实AgentRegistry的区别、cap/失权链的演示程度 | 不撤回基线结论 |
| R11平台 | V6/V7保留NOT_TESTED | 原生内核与各OS证据 |
| N1：第二轮cache/profile冲突 | D1.1b选择confine前声明需求、最终argv一次记忆；保留严格检查与安全拒绝；补V8 | 结构探针确认匹配冲突；真实Linux与上游cache接缝待验 |
| N2：私有写区域 | D1.1c显式盘点temp/cache/audit，deny优先，不能以保留机制为由扩大RO | V9及上游provider审批仍待实施 |
| N3：mutation集合 | D1.1a按文件写族、batch action、Native/PTC result action、shell列明 | page准备副作用与维护域需分别验证 |
| N4：准入后复查 | D3.1a明确不重新取epoch/准入，保留本次路径和profile有效性检查 | 撤权两侧、policy变化与异步后代回归 |
| 第三轮：建议接受但由维护者决定 | 维持Proposed；F07作为现存组合缺陷披露于双语README已知限制，D5明确Linux车道的上游依赖；探针重跑纳入OPS升级复核 | Linux端到端与V1–V9仍待实施；未形成接受或兼容声明 |
| A1/A7：持久化与Review完整性 | D2撤回普通append；早期两版Phase B不适用；Auto Review只返回complete否则技术失败 | 安全记录API、真实恢复及精确Review基线验证 |
| A2/A3：执行域及WW可实施性 | FA覆盖全部读写Worker及host准备；WW/RO撤回MR单侧profile承诺，新增D1.1d待决路线 | OPS写根信任选择与temp/cache公开接缝 |
| A4/A5：嵌套证明与加载顺序 | D1.3内层准备与单监听器；反向依赖不能靠删除负边界实现安全 | 原型验证cap、生命周期、依赖图和重载 |
| A6/A9/A10/A13：现存可用性边界 | 调整后台/purge/batch、F07范围及fs/进程降级差异，披露legacy失权代价 | Linux/Windows与生命周期实测 |
| A8/A11/A12：身份与披露 | D3补记录根相等、deny双路径、batch新增检查；双语README披露F01/F04/F05；观察语义和行号修正 | 最终对象/竞态与桥端到端仍待验 |


### ADR与计划联合复核（R1–R4）

本轮R编号属于计划复核，与上表早期审计R1–R11分开。仍仅修订文档，未执行计划。

| 项 | 拟议决定/规则 | 后续验收 |
| --- | --- | --- |
| R1默认模式 | 首期WW/RO维持现状并披露；新增FA guard/失权早拒不覆盖RO读 | 默认WW/RO行为对照、失权RO读、新旧拒绝来源分别记录 |
| R2准备重叠 | D1.1c定义T祖先与cache族（含后代）的精确谓词；普通tmp兄弟根不命中 | V1/V2必须到达受限Worker，另测cache准备早拒 |
| R3保护缺席 | scope拥有单调tools guard，process-fence拥有ready token；复查/代次/drain覆盖调度窗口 | X5：只卸载fence、guard后撤销、scope重载、旧token清理 |
| R4 cap一致 | 拟新增withToolCap包住admission至next/spawn，复用capForTool且幂等 | 监听器双顺序、内层cap、异常取消、scope重载 |

补充：Native result仅ref://，PTC store副作用的A4阻断限shared条件；Windows后台Bash独立车道；计划首期同时准备0.2.0-rc.2和Auto Review的0.2.1-rc.2。Native Phase A可在P0后与执行保护原型并行，PTC端到端依赖有效内层保护。


## Related Documents

- [OPS适配开发计划（Proposed；首期子集已实施）](../plans/active/2026-11-01-ops-compatibility-adaptation.md)
- [兼容性审计及补充取证](../reviews/dsh-ops-compatibility-audit.md)
- [ADR-0002：上游耦合策略](./ADR-0002-upstream-coupling-policy.md)
- [ADR-0009：DSH兼容性合同](./ADR-0009-dsh-compat-contract.md)
- [ADR-0010：附属根指令范围](./ADR-0010-additional-root-instruction-scope.md)
- [ADR-0012：Session origin与effective cwd](./ADR-0012-session-origin-and-effective-cwd.md)
- [ADR-0013：per-root/per-tool权限](./ADR-0013-per-root-and-per-tool-access.md)
- [ADR-0014：provider品牌门禁](./ADR-0014-root-limit-and-provider-conflict.md)
- [ADR-0017：三态权限与SandboxMode](./ADR-0017-three-state-root-access-and-sandbox-modes.md)
- [ADR-0020：Windows局部拒写](./ADR-0020-windows-normal-deny-groups.md)
- [ADR-0021：Auto Review上下文](./ADR-0021-auto-review-context-companion.md)
- [ADR-0024：操作准入](./ADR-0024-registry-operation-admission.md)
- [ADR-0025：共享Registry权威](./ADR-0025-shared-registry-authority.md)
