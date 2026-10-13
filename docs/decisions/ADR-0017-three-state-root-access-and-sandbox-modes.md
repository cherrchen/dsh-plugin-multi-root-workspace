# ADR-0017: 附加根三态权限与跨 SandboxMode 执行一致性（B9）

## Status

Accepted（Phase 1 定案，2026-10-13；Phase 2–4 实现已落地，2026-10-14；原生平台执行证据待补，未完成前不得宣称全平台成立）

## Date

2026-10-13

## Context

ADR-0013 的两档 `access`（`read-write` / `read-only`）把全局模式的边界原样继承到附加根：`read-only` 会话全拒写，`danger-full-access` 全放行。B9 要求把登记策略变成三档并让显式策略覆盖会话模式的默认边界：显式只读不得被 Full-access 绕过，显式读写在全局只读会话下仍授予该根写权限。

Phase 1 对全部 11 个支持版本（`0.1.5-rc.2` … `0.2.1-alpha.2`）的执行面做了逐项源码核对，得到三条决定性事实：

1. **Full-access 在每个进程消费面都绕过 `ctx.sandbox.confine()`**。`SandboxBashExecutor.execute` / `SandboxPwshExecutor.execute`（`0.1.5/0.1.6` 还有 `start`）在 `mode === 'danger-full-access'` 时直接调本地执行器；`dsh-terminal-bash` 的 `spawnArgv` 是模块私有函数，同条件返回裸 argv；`dsh-ptc-runtime-node`（run_code）同样 `mode === 'danger-full-access' ? void 0 : await ctx.sandbox.confine(...)`。因此 B9 不可能只在 `ctx.sandbox` 内实现。
2. **`subprocess` spec 不携带 `sandboxPolicy`**，但 PTY spawn env 携带 `DSH_SESSION_ID = spec.owner.id`，而 `Agent.enter` 强制 `agent.id === agent.session.id`——共享的 `ctx.subprocess.spawnTerminal` 是可用的公开接缝（`persistent-shell` 组 `isolate: terminals`，组内 backend 不可达，但它委托共享 subprocess 服务）。PTC 子进程 env 被构造为全空加显式注入，没有任何会话标记。
3. **方言能力不对称**：现有「观测克隆追加 allow」架构只表达加根，表达不了 Full-access 下的局部拒写。SBPL last-match-wins 使 `(allow default)` 后追加 `(deny file-write* (subpath R))` 成立；bwrap `--bind` 之上再 `--ro-bind` 成立；Landlock 上游启动器仅 `--ro`/`--rw` 单层 allowlist；Windows runner 的单一 root-set SID 只有 allow 维度。

Phase 1 时本机外层沙箱拒绝 `sandbox_apply`，原生证据留待补齐；Phase 2–4 落地后已于 macOS 直接验证 Seatbelt 两种构造（见下表）。bwrap / Landlock / Windows ACL 原生执行证据仍待对应平台或 CI 补齐。

## Decision

### 权限矩阵与有效权限

| 附加根登记策略 | DSH 只读 | DSH 读写（`workspace-write`） | DSH Full-access |
| --- | --- | --- | --- |
| `inherit` | 只读 | 读写 | Full-access |
| `read-only` | 只读 | 只读 | 只读 |
| `read-write` | 读写 | 读写 | 读写 |

有效权限 = `resolve(policy)` 按「登记策略 × 会话模式」逐调用解析，工具 cap（`toolAccess`）对三档都只收窄：被封顶的调用对任何附加根不得写，包括继承到 Full-access 与固定读写的根。三档不是全序——`inherit` 在只读模式下弱于固定读写、在 Full-access 下强于它——`setAccess` 的「升级须 `available`」门槛与确认文案按方向分别判断：`inherit → read-write` 在 Full-access 会话是收窄、在只读会话是扩权；`read-write → inherit` 相反；`read-only → 任意` 维持「仅 `available` 可离开只读」。主根与未登记区域永远按会话模式判定，不得借「改写全局模式」近似实现。

### 持久化编码（domain version 保持 1）

单根条目仍是「恰好一个 grant 键」：

| 键 | 策略 | 说明 |
| --- | --- | --- |
| `recordedPath` | `inherit` | 旧编码；旧 `read-write` 记录升级后语义 = 继承，保留原先随会话模式变化的行为，**不得**解释为固定读写（否则升级在只读会话静默扩权） |
| `readOnlyRecordedPath` | `read-only` | 原编码不变；B9 下开始约束 Full-access，是预期的行为变化 |
| `readWriteRecordedPath` | `read-write` | B9 新增键，表达固定读写 |
| 零键 / 多键并存 | `invalid` | 沿用旧规则，禁止默认修复 |

选 `readWriteRecordedPath` 的理由：与 `readOnlyRecordedPath` 完全对偶；不 reinterpret `recordedPath`；domain v1 单布局不引入 `access` 枚举字段（同 ADR-0013 的否决理由：枚举字段在旧代码剥离后会按 `recordedPath` 重建 grant）。**固定读写条目绝不同时写 `recordedPath`**——旧插件剥离未知键后只能看到 `recordedPath` 才算安全；只含新键的条目在旧代码下判 `invalid`（可见但不可用，fail closed）。降级验收按「不静默扩权」而非「守住 B9 只读边界」：旧插件在 Full-access 本就没有 confinement。

`access` 的 wire / 命令值扩展为 `inherit | read-only | read-write`。`add` 不带 `--access` 保持 revive 语义（重登记恢复原策略）；全新登记的缺省策略为 `inherit`。宿主与客户端同包升级，`RootsView.access` 携带真值，不做有损映射。

### 进程与 fs 接缝

全部接缝用 `method-wrapper.ts` 的公开方法包装（描述符保留、可卸载、不传模型参数），版本形状差异归 `src/compat/` 结构探测。每条接缝都以 `multiRootCompat` 为前置。

| 接缝 | 判定 | 动作 |
| --- | --- | --- |
| `ctx.shell.execute`（`0.1.5/0.1.6` 结构探测补 `start`） | `spec.sandboxPolicy.mode` ≠ Full-access → 直通；Full-access 且当前 scope 无显式只读根 → 直通 | Full-access + 有显式只读根 → ALS 注入 deny 上下文后委托原方法；`ctx.shell` 在 win32 是 pwsh executor，逻辑与方言无关 |
| `ctx.ptcRuntime.execute`（`run` 内部委托 `execute`，同包装覆盖） | 同上，policy 来自参数 | 同上 |
| `ctx.subprocess.spawn` | ALS 无 deny 上下文 → 直通 | 有 → 调 `ctx.sandbox` 受限 confine 重写 `spec.argv` 后委托原方法；其余 spec 字段与 signal 原样穿透 |
| `ctx.subprocess.spawnTerminal` | env 无 `DSH_SESSION_ID` → 非终端 spawn，直通 | `sessions.get(env.DSH_SESSION_ID)` → `sandboxPolicy.resolve({session})` → scope；无显式只读根 → 直通；有 → 受限 confine 重写 argv；会话不可解析且任何 primary 下存在显式只读根 → fail closed 拒 spawn（不明示放行，也不误伤无受限根的部署） |
| `ctx.fs` write/edit fence | Full-access：目标在显式只读根内 → `FS_SANDBOX_DENIED`；read-only：目标在固定读写根内且工具未封顶 → 放行 | 其余沿用 workspace-write 判定；零受限根保持快速路径，不引入额外 realpath IO |

`ctx.sandbox`（已替换行）增加受限 confine 内部路径，供 `spawn` / `spawnTerminal` 包装调用：`ConfinedSandboxMode` 之外的 mode 由 compat 层一次受控 cast。三种构造：

| 会话模式 | 构造 |
| --- | --- |
| `workspace-write` | 上游 `confine` 结果照旧 `widenProfileArgs` 拼接有效可写根（`inherit` + `read-write`，cap 已过滤） |
| `read-only` | 上游 read-only profile 之上 append 固定读写根：Seatbelt 追加 `(allow file-write* (subpath W))`、bwrap 追加 `--bind W W`、Landlock 追加 `--rw W`、Windows ACL 把该根并入 `--write-sid` root 集 |
| `danger-full-access` | 自建 restrict profile：Seatbelt `(allow default)` + 每受限根 `(deny file-write* (subpath R))`（last-match-wins）；bwrap `--bind / / --dev /dev --die-with-parent` + 每受限根 `--ro-bind R R`；Landlock 与 Windows ACL 表达不出（见下表），受限 confine 抛 `SandboxUnavailableError` → spawn 前拒绝 |

**显式只读优先于覆盖同一路径的其他写授权**（尤其平台 temp 与 `/tmp`）：构造 allow 集时先做 canonical 前缀剔除。deny 集与 allow 集只取 `available` 成员；`withheld` / `missing` / `redirected` 根不进入任何集合（撤销不重新授权，成员投影也不因 withheld 而把限权根漏出 deny 集——它本来就被 withheld，不授权也不拒绝）。

受限 confine 下，包装在 `result` 层按返回的 `denialSignatures` / `runnerFailureRules` 补 stamp `result.sandbox.{mode, denied, enforcement}`；`proc.sandbox` 事实戳记依赖上游私有 `processFacts`，不可复现，作为如实差异记录（jobs/持久化侧的「曾被拒」标记在该组合下缺席）。

### 后端能力与失败方式（Phase 1 结论）

| 后端 | Full-access + 局部只读 | read-only + 固定读写 | 状态 |
| --- | --- | --- | --- |
| Seatbelt | 可表达（allow-default + subpath deny） | 可表达（RO profile + subpath allow） | **macOS 原生验证通过**（2026-10-14，`sandbox-exec` CLI：deny subpath 内写 EPERM、ambient 写放行；graft allow 内写放行、其余写 EPERM——deny 必须拼 canonical 路径，`/tmp` 词法拼写不匹配 `/private/tmp` 实际） |
| bwrap | 可表达（bind `/` + ro-bind 受限根）；`runnerCommand` 自定义 runner 按上游契约同形 | 可表达 | 结构确认 |
| Landlock | **已按定案显式拒绝**：「尝试扩展启动器拼写」的结论为不可行——上游启动器仅 `--ro`/`--rw` allowlist union，Landlock ABI 本身无可移植的子树减法；`restrictProfileArgs` 抛 `SandboxUnavailableError`，spawn 前拒绝，不计为该组合已实现 | 可表达（`--ro` 默认 + `--rw` 固定读写根，已实现） | 结构确认 |
| Windows ACL | **已按定案延后并显式拒绝**：上游 runner 只导出 grant 模型（`AclSandbox`/`AclWriteGrant`/`workspaceWriteSid`），无 deny ACE 或受限 token 原语；新机制（deny ACE / 受限 token 变体）超出本轮范围。`restrictProfileArgs` 抛 `SandboxUnavailableError`，spawn 前拒绝 | 可表达（独立 runner `--mode read-only` + `--additional-root`，已实现：workspace-write 令牌仅授权固定根集，主根不可写） | 结构确认 |
| PTC（run_code） | 纳入 B9：与 shell 同一 ALS 接缝覆盖 | 纳入 | 由 `ctx.subprocess.spawn` 包装统一约束 |

未知形状、不可用 runner、表达不出的权限组合一律在 spawn 前显式拒绝，绝不无约束启动；该拒绝是防越权失败处理，不算对应组合已实现。

### 生命周期与边界

- `writableRoots` / deny 集只含 `available` 成员；撤销、missing、redirected、withheld 不重新授权目标。
- `registry-contended` 维持空 scope + 拒一切 mutation（含固定读写），不缓存「上次已知」。
- 模式与根变更只影响后续 fs 调用与新启动进程；已运行进程保留启动时内核快照（同 ADR-0012）。PTY 侧上游已有「打开终端时禁止切模式」fence，语义一致。
- 零附加根时全部接缝直通，逐字节保持上游行为。
- `setAdditionalRoots()` 仍是唯一写端口；mutation 读-分类-验证-持久化仍在原序列化队列与 lease/teardown 顺序内。

## Alternatives Considered

| 方案 | 否决理由 |
| --- | --- |
| 替换 `bash-sandbox` / `pwsh-sandbox` 行挂载 executor 子类 | `executeArgv` 是 protected、`processFacts` 是私有，子类无法复现事实戳记只能整段重实现；行替换还要镜像平台 disabled 与 config 漂移。method-wrapper 与 ADR-0011 的公共接缝先例一致 |
| 包装 `ctx.terminals` 或其 backend | `persistent-shell` 组 `isolate: terminals`，组外拿不到组内服务实例；backend 委托的共享 `ctx.subprocess.spawnTerminal` 才是可达接缝 |
| `subprocess.spawn` 按 argv 形状识别受限调用 | 无法区分「已 confine 的 argv」与裸 argv，二次嵌套 confinement 可能直接失败（本环境实测 `sandbox_apply` 嵌套拒绝）；必须靠 ALS 精确传递授权意图 |
| PTC 子进程按 env 标记识别 | PTC 把 `process.env` 全键置 `undefined` 后仅显式注入 `DSH_PTC_RUNTIME_NODE`，没有会话标记；且 `execute(spec, policy, …)` 的 policy 本就是显式参数，ALS 更精确 |
| 把 Full-access + 局部只读近似为 `workspace-write` + 扩展根 | 改变全局模式语义（主根与未登记区域失去 Full-access），计划明确禁止 |
| 固定读写复用 `recordedPath` 或新增 `access` 枚举字段 | 前者升级静默扩权；后者旧代码剥离后按 `recordedPath` 重建 grant（同 ADR-0013 否决） |
| 面板 wire 把 `inherit` 映射回 `read-write` 兼容旧客户端 | 宿主与客户端同包发布、版本一致；有损映射只会让显示与执行不符 |
| `ctx.shell` 包装改调 `executeArgv` 注入受限 argv | `executeArgv` 是 TS `protected`、argv 构造（bash `['bash','-c',command]` / pwsh `this.argv(spec)`）属 executor 内部形状；ALS + `subprocess.spawn` 只接触公开面 |

## Consequences

- 权限解析仍是 `resolve(policy)` 单点，新增「有效权限」投影与 deny 集投影；成员资格投影不受影响（显式只读根仍是完整 workspace 成员：可读、可路由、可注入指令）。
- 新增一个 additive 行（进程消费面包装）与 `ctx.sandbox` 的受限 confine 路径；不替换新上游行，但 `multi-root-providers` 门禁语义扩展到「`ctx.shell` / `ctx.ptcRuntime` 存在时其方法形状符合支持合同」。
- `danger-full-access` 与 `read-only` 不再逐字节保持上游语义——这是 B9 的合同变化：仅在「存在显式只读根」或「存在固定读写根」时行为不同，其余逐字节一致。
- enforcement 元数据差异如实记录：受限 confine 下 `result.sandbox` 由包装层补 stamp；`proc.sandbox`（jobs 事实）缺席该组合。
- Windows enforcement 维持上游 `partial`；Full-access + 局部只读组合在新机制落地前为显式拒绝 + 文档标注。
- ADR-0013 的两档模型、持久化编码与决策表按修订节更新；ADR-0001 的「confinement 全部委托 `ctx.sandbox`」假设、ADR-0003 的门控条款、ADR-0011 的 Windows 单 SID 模型、ADR-0012 的 read-only 授权行同步修订。

## 修订：Windows Full-access 局部只读重新纳入 B9（2026-10-13，Amendment）

用户撤回本 ADR 中 Windows 新机制的延后范围。本节取代上表 Windows 行的「延后并显式拒绝」决定，历史 Phase 1 结论保留。

Full-access 的 Windows profile 改为选择插件独立 runner 的 `--mode danger-full-access --deny-root`；令牌、deny ACE、owner / parent / token 防绕过与生命周期按 [ADR-0019](./ADR-0019-windows-token-attributes-and-conditional-acls.md)。权限仍从同一 scope 的 `deniedRoots` 读取，Windows enforcement 仍为 `partial`，缺失能力或路径不满足原生前置条件时拒绝启动。Landlock 的决定不变。原生证据与验收状态只维护于路线账本。

## 失效登记的负授权修订（2026-10-13）

本节取代前文「deny 集只含 available」的决定。Registry 经同一 `setAdditionalRoots()` 写端口发布 available、missing 与 redirected 的有效登记，后两者带 `withheld`，不授予成员资格或写权限。`deniedRoots` 独立按登记策略、工具 cap 与 **recorded canonical 路径**生成；目录消失、刷新或重启不能解除仍登记的只读边界。仅显式移除登记或经校验修改策略才撤回对应负授权。Invalid 记录仍不发布；重新解析不把拒写边界或写授权转移到 redirect 的新目标。fs 直接检查负授权路径，不依赖成员投影。

缺失路径的内核启动若不能表达该负授权必须失败关闭，不能因无法挂载路径而裸启动。既有进程仍保留启动快照。

## 面板与模型说明修订（2026-10-13）

面板响应的 `mode` / `effectiveAccess` 由活会话在宿主派生，只作展示，客户端不能上传授权事实；兼容旧响应缺字段时不猜测有效权限。每根并列显示登记策略与当前有效权限，工具 cap 单列说明。继承与固定读写之间两向切换都在某个模式下扩权，因此均要求确认。模型拓扑在三个模式下均列出配置的工具 cap。

## 进程诊断与 Linux 后端修订（2026-10-13）

Full-access 包装保留受限 prefix 对应的 `enforcement`、`denialSignatures` 与 `runnerFailureRules`，在 shell execution 的公开 `result()` / PTC 返回结果上补事实；execution 身份、调用上下文、缓存和同步/异步形状不变。runner 初始化失败优先于 kernel denial，不把信号退出或成功恢复的命令标为拒绝。`proc.sandbox` 的私有 jobs 事实仍是上游限制，不伪造未观测的进程事实。

PTC 接缝改为公开 `ctx.ptcRuntime.run()`，不包装实现类的私有 `execute`。旧版 shell 的公开 `run` / `start` 同样包装（前台 run 不经过 start/execute），普通 shell、PTY 与 PTC 仍从同一 scope 取策略；真实组合冒烟及安装副本同时验证 Full-access 主根/ambient/固定读写允许、只读拒写和结果事实。

Landlock 的 allowlist 无法实现 Full-access 子树减法，该组合不再直接判 unsupported，而是选 bubblewrap mount 后端：主机根原样读写、只读根单独 ro-bind。不带 workspace-write 的 PID、proc、device 或 tmpfs 替换，保持其他区域的原模式。该路径需要宿主安装且可执行 bubblewrap；不可用按 runnerFailure 报告，绝不裸启动。选择新后端时结果诊断同时切为 bubblewrap 的实际方言，不能保留 Landlock EACCES 拼写。bwrap 的 workspace-write temp mask 下注册的只读树也以 ro-bind 显式恢复读取。

## Related Documents

- [B9 专项计划](../plans/completed/2026-10-13-b9-root-access-and-sandbox-modes.md)
- [路线账本 · B9 条目](../plans/active/2026-09-12-multi-root-workspace.md#b9附加根三态权限与跨-sandboxmode-执行一致性2026-10-13)
- [ADR-0013：Per-Root 访问级别与 Per-Tool 封顶](./ADR-0013-per-root-and-per-tool-access.md)（本 ADR 修订其权限模型与编码）
- [ADR-0001：Provider 替换范围](./ADR-0001-provider-replacement-scope.md)
- [ADR-0003：方言 grant 拼接](./ADR-0003-dialect-grant-widening.md)
- [ADR-0011：多根消费方](./ADR-0011-multi-root-workspace-consumers.md)
- [ADR-0012：Session origin 与进程快照](./ADR-0012-session-origin-and-effective-cwd.md)
- [ADR-0009：DSH 兼容合同](./ADR-0009-dsh-compat-contract.md)
