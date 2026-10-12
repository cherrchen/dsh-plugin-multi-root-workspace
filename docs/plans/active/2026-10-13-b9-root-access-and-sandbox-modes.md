# B9：附加根三态权限与跨 SandboxMode 执行一致性

## Goal

为第二期增加 B9：附加根可选择「继承主目录权限」「只读」「读写」，文件操作与新启动的 shell / pwsh / PTY 按同一权限合同执行。显式只读不能被 DSH Full-access 绕过，显式读写在 DSH 只读模式下仍能授予该根写权限。

本文记录目标合同与实施计划，不表示这些行为已经实现。进度、执行证据与发布状态只维护在[路线账本](./2026-09-12-multi-root-workspace.md#b9附加根三态权限与跨-sandboxmode-执行一致性2026-10-13)。本轮文档工作不启动代码实现、运行时探测或发版。

## Background

用户要求补全第二期 P1 / P2 的根权限与沙箱策略，任务统一编号 B9。它延续 B4 的 per-root / per-tool 授权模型，并扩展 B1–B3 的进程消费面；不另建根数据源。

现行合同见 [ADR-0013](../../decisions/ADR-0013-per-root-and-per-tool-access.md)，进程与 cwd 边界见 [ADR-0011](../../decisions/ADR-0011-multi-root-workspace-consumers.md) 和 [ADR-0012](../../decisions/ADR-0012-session-origin-and-effective-cwd.md)。B9 将改变 ADR-0013 中「read-only 全拒、danger-full-access 全放行」的决定，不能把旧决定直接改写为已实施的新行为。

## Current State

按当前源码与本地安装的开发基线检查：

- [`RootAccess`](../../../src/roots.ts) 与[面板合同](../../../src/contract.ts)只有 `read-only / read-write`；注册表默认新根为 `read-write`。
- [注册表](../../../src/registry.ts)在 domain v1 用 `recordedPath / readOnlyRecordedPath` 区分授权，旧记录的可写性仍受会话模式支配。
- [scope](../../../src/scope.ts)目前按根 access 与工具 cap 计算 `writableRoots`，没有三态策略与会话模式组合出的有效权限。
- [fs fence](../../../src/fs.ts)在 `read-only` 下直接拒绝写，在 `danger-full-access` 下直接放行；只有 `workspace-write` 分支检查附加根。
- [sandbox provider](../../../src/sandbox.ts)只扩展 `workspace-write` profile。本地 DSH `0.2.1-alpha.2` 的 `dsh-bash-sandbox` 与 `dsh-terminal-bash` 在 Full-access 下跳过 `confine()`；其他支持版本与 pwsh 消费面须在实施前逐项核对。
- 模型拓扑和客户端文案仍陈述原来的模式规则，不能用于宣称 B9 限制已经生效。

## Scope

覆盖注册表及持久化、scope 权限解析、fs write/edit、进程入口与内核方言、Windows runner、命令与面板、模型拓扑、兼容及打包验证。读取、LSP、指令与 Files 路由继续使用成员资格投影，并验证权限变化不会破坏这些消费者。

## Non-goals

- 不修改上游任何包，不以提示词、命令字符串扫描或模型参数代替执行授权。
- 不增加第四档附加根策略，也不重新定义 DSH 的网络、进程可见性或宿主 OS 权限。
- 不改变 Session origin、Registry 主键、effective cwd 的来源或 root-overlap 校验。
- 不回收已运行进程的内核快照，不在本任务的规划阶段决定版本号、创建 tag 或发布。

## Design

### 目标权限矩阵

下表是 B9 规划阶段的权限合同唯一真源。DSH「读写」对应 `workspace-write`，Full-access 对应 `danger-full-access`；内部根策略拟采用 `inherit / read-only / read-write`。

| 附加根登记策略 | DSH 只读 | DSH 读写 | DSH Full-access |
| --- | --- | --- | --- |
| 继承（`inherit`） | 只读 | 读写 | Full-access |
| 只读（`read-only`） | 只读 | 只读 | 只读 |
| 读写（`read-write`） | 读写 | 读写 | 读写 |

登记策略是持久化事实；有效权限由本次会话模式与策略解析，工具 cap 再收窄附加根写权限。`toolAccess` 为只读的调用对三档策略都不得写附加根，包含继承到 Full-access 的根；嵌套、并发隔离、dispatch 外偏严与非法配置 fail closed 继续成立。

「只读」表示根内文件仍可读取，但不得修改；「读写」表示明确授予该 canonical 根内的读写权限，不把会话或整个子进程提升到 Full-access。主根及未登记区域仍按原会话模式判断：Full-access 下这些区域保留上游语义。因此不能把混合权限通过全局改为 `workspace-write` 来近似实现，也不能把固定读写理解成对整个进程的读取围限。

路径按实际 canonical 目标判断；根内 symlink 指向根外时不能借该根的读写 grant 授权，外部目标独立按会话及其他根策略判断。只读限制必须优先于覆盖同一路径的其他写授权，尤其是平台 temp 区域。零附加根时继续保持上游直通。

### 默认值与迁移（Phase 1 已定案，详见 [ADR-0017](../../decisions/ADR-0017-three-state-root-access-and-sandbox-modes.md)）

- 新增根默认 `inherit`，命令与面板提供三档显式选择；没有显式选择时不上传默认值，revive 保留原策略。
- 旧 `recordedPath` 解释为 `inherit`：升级时原来的 `read-write` 自动改为 `inherit`，保留原先随会话模式变化的行为。不得解释为固定读写，否则升级会在只读会话中静默新增写权限。
- 旧 `readOnlyRecordedPath` 保留只读策略；B9 下它将开始约束 Full-access，这是本次修复预期的行为变化。
- 固定读写的持久化编码定案为新 grant 键 **`readWriteRecordedPath`**：与 `readOnlyRecordedPath` 对偶，domain v1 单布局不变。固定读写条目绝不同时写 `recordedPath`，旧插件剥离未知键后只能判 `invalid`（fail closed）；未知或冲突授权编码照旧判 invalid，禁止按默认读写修复。
- 三档策略不是固定的全序：继承在只读模式下弱于固定读写，在 Full-access 下又可能强于它。升级确认与 withheld 根的权限变更校验须据此重做；不能只把 `read-only → read-write` 看成升级。
- 降级测试必须区分存储解释与实际执行。旧插件本来就会在 Full-access 下绕过 confinement，不能以「未知 grant 键被判 invalid」声称旧插件也能保证 B9 只读边界；须记录实际限制与可行的兼容处置。
- PTY 之外的模型向进程面 PTC（`run_code`）经用户确认纳入 B9，与 shell 共用同一接缝覆盖。

### 单一权限解析与进程入口

权限解析继续收敛在现有 scope；`setAdditionalRoots()` 保留唯一写端口。结构中须同时表达成员资格、当前可写集与显式限权边界。任何需要约束或扩大权限的新行均须保留 `multiRootCompat` 和相应 provider brand 门禁。

fs 检查目标根的有效权限后再应用全局模式，不能在判断根之前直接放行或拒绝。进程入口须在 Full-access 绕过点之前判断是否有附加根约束，覆盖 shell / pwsh、PTY 与 PTC（run_code），而非只修改 `sandbox.confine()`。仅允许使用公开、可卸载的接缝，保留调用上下文和属性描述符；版本形状适配只放 `src/compat/`，以结构探测判断。

Phase 1 核对的接缝定案（ADR-0017）：全部用 `method-wrapper.ts` 公开方法包装——`ctx.shell.execute`（`0.1.5/0.1.6` 结构探测补 `start`）、`ctx.ptcRuntime.execute` 注入 ALS deny 上下文，`ctx.subprocess.spawn` 按 ALS 决定 confine；`ctx.subprocess.spawnTerminal` 由 env `DSH_SESSION_ID`（`agent.id === session.id`）恢复会话与策略。`persistent-shell` 组 isolate `terminals`，组内 backend 不可达，但其 spawn 委托共享 subprocess 服务；不替换 `bash-sandbox` / `pwsh-sandbox` / `terminal-bash` / `ptc-runtime` 行。

各内核后端须证明能够同时满足「全局保持原模式」和「附加根局部权限」。现有 grant 扩展只表达增加允许路径，不足以证明 Full-access 下的局部拒写；Seatbelt、bwrap、Landlock、Windows ACL 必须分别验证，不能假定支持同一种补丁。

若后端无法表达合同，必须在子进程启动前明确拒绝相关执行，不得退回无约束启动。此拒绝是防止越权的失败处理，不计为对应权限组合已经实现；若仍有必需组合不可执行，B9 不能按完整矩阵验收，须将原因和替代方案写回计划。

## Implementation

### Phase 1：权限合同、迁移与接缝审查（已完成文档定案，2026-10-13）

1. 明确每种策略的登记值、有效权限、工具封顶、模式切换、显式升级与无可用 grant 时的行为。
2. 审查三档迁移、旧客户端请求、缺省 wire 值与 downgrade 路径，防止缺失字段被误当作新固定读写。
3. 核对全部支持版本的 bash / pwsh / PTY bypass 与公开入口，形成接缝清单；不更改支持 allowlist。
4. 定义 missing / redirected / registry-contended 与限权边界的关系：撤销 grant 不能重新授权目标；Full-access 下不得仅因成员投影过滤了一个仍登记的限权根而意外恢复写权限。明确移除登记、自动 withheld 和重新登记的区别。
5. 对进程后端做最小原生执行验证，优先验证 Full-access + 显式只读，以及只读会话 + 固定读写；同时验证 primary 与未登记区域保留原模式。专项能力验证不能只复用已有「runner 能启动」的探针结果。
6. 记录方言能力、失败方式与剩余问题，再创建新 ADR；按替代范围修订 ADR-0013，并检查 ADR-0001、ADR-0003、ADR-0011、ADR-0012 的相关假设。此阶段未通过前不宣称全平台方案成立。

完成记录：九格矩阵、三档编码（`recordedPath`→inherit、`readOnlyRecordedPath`→read-only、`readWriteRecordedPath`→固定读写）、接缝清单与生命周期边界已写入 [ADR-0017](../../decisions/ADR-0017-three-state-root-access-and-sandbox-modes.md)，ADR-0001/0003/0011/0012/0013 已按修订节同步。原生验证状态：本机外层沙箱拒绝 `sandbox_apply`，Seatbelt 原生执行证据待无嵌套限制的宿主或 CI 补齐；bwrap / Landlock / Windows 均为结构确认，Windows Full-access 局部限权与 Landlock 扩展拼写是两个待实现机制（表达不出则 spawn 前显式拒绝，不计为组合已实现）。

### Phase 2：注册表、scope 与 fs fence

1. 扩展 RootAccess、存储分类、mutation、publication 签名与 wire schema，按定案后的迁移规则加载旧记录。
2. 统一会话模式与策略计算，工具 cap 只收窄有效权限；权限变化保持根身份和 canonical grant，不通过重新解析静默续授。
3. 重构 fs write/edit 的早返回和拒绝说明；补齐九格矩阵、temp 覆盖、symlink 与 withheld 用例。
4. 所有 mutation 的读、分类、验证、持久化仍在原队列内，lease acquisition / teardown 顺序不变。

### Phase 3：进程消费面与后端执行

1. 在已验证的公开执行入口接入 scope，按需处理 Full-access bypass；保留取消、退出码、stdio、PTY 控制通道与错误分类。
2. 基于 Phase 1 证据实现各方言的混合权限，检查 backend enforcement 的真实程度；Windows 继续报告 partial，不将结构测试当原生证据。
3. 核对 Windows root-set SID、private temp、残留 ACE 与 token 快照，不把固定读写额外扩成主根写授权。
4. 未知形状、不可用 runner 或不支持的权限组合在 spawn 前拒绝；空根及无需额外处理的组合保留原有直通行为。

### Phase 4：命令、面板与模型上下文

1. 命令拟增加 `add --inherit`，`access` 子命令支持三档；保留未显式指定 access 的语义。
2. 面板提供三档选择，显示登记策略与当前有效权限；升级确认覆盖进入 Full-access 继承等扩权情形，不允许客户端字段代替宿主授权。
3. 同步中英文文案、模型拓扑及会话模式说明，避免同时出现「全局不受限」与「附加根不受限」的错误等同；工具 cap 和后端限制如实陈述。
4. 验证读取、LSP、指令与 Files 路由不因只读而失去成员资格，会话切换和过期响应隔离保持成立。

### Phase 5：全矩阵验收与文档同步

完成下列验收、同步当前行为文档，并把版本与原生平台执行证据写入路线账本。满足完成条件后按文档规则将专项计划迁往 completed；发布仍遵循独立 release workflow。

## Validation

| 验证面 | 必需证据 |
| --- | --- |
| 九格权限合同 | fs write/edit 与真实 shell / pwsh / PTY 行为一致；只读拒写、固定读写在只读会话可写、Full-access 不绕过附加根限制 |
| 混合根与全局模式 | 同一调用包含继承、只读、读写根；主根及未登记区域仍按会话模式，不能仅以拒写附加根证明全局语义正确 |
| 工具封顶 | 三档 × 三模式下 cap 均收窄；并发不污染、嵌套不放宽、dispatch 外与非法配置 fail closed |
| 持久化与接口 | 旧可写记录不在只读会话静默扩权、旧只读记录获得新限制；revive 保留策略、非法编码 withheld、旧客户端缺省行为及降级限制有实际测试 |
| 路径与生命周期 | temp 覆盖、canonical / symlink / junction、missing / redirected、撤销与重登记、模式切换、会话隔离；新调用与旧进程快照区分 |
| 原生后端与安装副本 | Seatbelt、bwrap、Landlock、Windows ACL 的允许与拒绝证据；缺少 runner 显式 skip，拒绝 unsupported 不能记成该组合通过；tarball 内实际执行 |

按[开发工作流](../../development/plugin-development-workflow.md)运行 `pnpm compat:check`、`pnpm lint`、`pnpm typecheck`、`pnpm build`、`pnpm kernel:probe`、`pnpm test`、三类 smoke（compose / behavior / journey）、`pnpm pack:check`、`pnpm smoke:packed` 与 `pnpm docs:check`。全部精确支持版本与启用 OS 纳入验收；本机跳过不能替代其他原生平台证据。

## Risks

- Full-access 的局部只读与现有「只增加 allow roots」架构不同，可能需要新的公开入口或后端机制；Landlock 与 Windows 的选择性限制能力尚未验证。
- 全局 Full-access 下不同词法路径、symlink 与 withheld 状态可能绕过局部限制；需按继承的 path-based threat model 说明实际边界，不宣称消除 TOCTOU。
- 原有 `read-write` 名称在 B9 中获得更强的独立授权含义，旧记录和缺省请求不得无提示升级。
- 旧插件 Full-access bypass 不是新 grant 编码能消除的问题；兼容声明须与执行证据一致。
- 新进程入口可能影响打包模块图和可选 peer 加载。carrier barrel 不能静态加载可选包，Windows 独立 runner 保留既有解析约束。
- 已运行进程保留启动时授权，权限收窄后的回收仍须结束旧进程再启动，不能在面板上承诺立即收回全部能力。

## Documentation Impact

- 本轮：新增本文；路线账本登记 B9；需求文档链接目标合同；Plans README 中英文同步导航。
- 实施时：将定案权限合同同步到需求与架构的唯一真源，本文改为链接；新增 ADR 保存混合权限与迁移决策，旧 ADR 按范围修订或标记被替代。
- 实施时：同步用户指南、仓库 README 双语、命令与模型能力说明；有长期价值的兼容事实再写入 Agent Note 双语，避免复制状态或证据。
- 发布时：按 release workflow 更新 CHANGELOG 双语，不在规划阶段写出未发布版本的既成内容。

## Completion Criteria

1. 九格矩阵的必需执行面获得相应原生证据；后端只会拒绝执行的组合仍列为未完成，不能作为完整支持交付。
2. 每次操作均从同一 scope 解析权限；Full-access bypass、工具 cap、temp 覆盖与路径身份检查不能绕过根策略。
3. 迁移不会静默扩大旧可写记录权限，策略变更与 revive 语义明确，降级的真实执行限制已测试并记载。
4. 零根直通、会话身份、lease、provider brand 与兼容门禁无回归，命令、面板和模型陈述与执行一致。
5. 全部必需检查通过，文档同步；剩余限制与执行证据在路线账本明确登记。
