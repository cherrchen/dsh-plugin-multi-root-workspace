# ADR-0013: Per-Root 访问级别与 Per-Tool 写权限封顶

## Status

Accepted

## Date

2026-10-11

## Context

附加根自 M2 起与主根同权：任何被授予的根对 fs 写、受限进程与 Windows ACL 都是可写的。第二期评审（需求 §4 P2）要求两类收窄：根自己的访问级别（read-write / read-only），以及按工具收窄的写权限（某工具永远不得写任何附加根）。两个约束都必须落在真实执行面上（fs fence、内核方言、Windows runner），不能只写在提示词或 UI 里。持久化必须同时满足两个方向：旧记录在新代码下语义不变，新记录被旧代码读到时绝不升级为更高权限。

## Decision

### 决策表

`access` ∈ {`read-write`, `read-only`} 是根记录自己的属性；`toolAccess` 是 `multi-root-scope` 行的宿主配置（`Record<string, 'read-only'>`）。有效可写集 = 「access 为 read-write 的可用成员」∩「本次调用的工具未被封顶」。

| SandboxMode × 根 access × 工具封顶 | fs write/edit | 新启动的受限进程 | 已在运行的进程 |
|---|---|---|---|
| `read-only` 模式 | 全拒（上游语义） | 上游 read-only confinement | 不受影响 |
| `danger-full-access` | 放行（上游语义，不经 confine） | 上游语义（不 confine） | 不受影响 |
| `workspace-write` + 根 `read-write` + 工具未封顶 | 允许 | `--additional-root` / 方言 grant 包含该根 | 保留启动时快照 |
| `workspace-write` + 根 `read-only` | `FS_SANDBOX_DENIED`，denial 指明 `… is a read-only additional root` | 该根不进入任何写 grant；成员资格不变（仍可读、可路由、可注入指令） | 保留启动时快照 |
| `workspace-write` + 根 `read-write` + 工具被 `toolAccess` 封顶 | `FS_SANDBOX_DENIED`（该工具内） | 该工具内 confine 不含任何附加根 grant | 保留启动时快照 |

### 持久化编码（domain version 保持 1）

持久化记录不存 `access` 字段：access 由**哪个 grant 键在场**表达——`recordedPath` 在场 = `read-write`，`readOnlyRecordedPath` 在场 = `read-only`，两者都在 = `invalid`（ambiguous access），都不在 = `invalid`（旧规则）。原因：

- JSON backend 以严格相等校验 unit version，`version: 2` 会使升级与降级两个方向都打不开，因此必须单布局；可选字段是 v1 内唯一兼容通道。
- 旧版本插件用剥离未知键的 schema 读一条 read-only 记录：看不到 `recordedPath` ⇒ 判 `invalid` ⇒ 不授予。**降级永远不会把 read-only 提升为 read-write**，这是选键名编码而非 `access` 枚举的决定性原因：后者在旧代码下会被剥离后按 read-write 语义重建 grant。
- 无 grant 键的旧记录仍是 `invalid` 且可逐条移除，不静默修复。

`setAccess(primary, ref, access)`：序列化队列内先 reclassify；降级到 `read-only` 永远允许（包括 withheld 根）；升级到 `read-write` 仅当 fresh 状态为 `available`，否则 `root-unavailable`，且不重新记录路径——re-resolving 不是 re-authorizing。alias/move 永不改 access；publish 签名含 access（access 变化是 grant 变化，元数据变化不是）。

### Windows root-set SID

Windows runner 的 capability SID 只对「主根 + 可写附加根」这一个集合计算：`workspaceScopeSid([primary, ...writable])`。token 只携带一个集合的 SID，因此旧集合残留的 ACE 只匹配按那同一个集合铸出的 token；private temp 不变；已运行进程保留自己的 token（启动时快照）。

### read-only 是"写授权缺省"，不是"读 confinement"

`read-only` 根仍是完整 workspace 成员：LSP、workspace-files、指令注入、路由、文件浏览、读操作全部照旧。它只从 writable 集缺席。模型侧文案把成员资格与可写性分开陈述，绝不把 read-only 根说成可写。

### per-tool 封顶的 AsyncLocalStorage 设计

`MultiRootScopeService` 在公开的 `tools/execute` around-dispatch waterfall（`src/compat/tool-context.ts` 的 `aroundTool`）里把 `{ capped }` 放进模块级 `AsyncLocalStorage`：工具名在 dispatch 入口读一次（绝不读模型参数），`capped = parent?.capped || toolAccess[exec.name] === 'read-only'`——嵌套只会收窄。`resolve()` 在 dispatch 内读 ALS store；**dispatch 之外**（用户 PTY、面板、未知 async 边界）无法证明工具身份，按最严格解释处理：`toolAccess` 非空即封顶。空 `toolAccess`（含未配置）行为与实现前逐字节一致。`toolAccess` 配置非法（非对象、数组、或任何值不是 `'read-only'`）时 fail closed：一切调用按封顶处理并 log error，不抛错。封顶只收窄，任何值都不能放宽到根自身 access 之上。

`toolCaps()` 返回排序后的被封顶工具名，供拓扑文案（ADR-0013 与 B8 的提示词修订一起落地）列出。

## Alternatives Considered

- 持久化加 `access: 'read-only'` 枚举字段：旧代码剥离后按 `recordedPath` 重建 ⇒ 降级升级为可写，拒绝。
- domain version 升 2：后端严格相等校验会使新旧互斥打开，拒绝。
- 在工具层逐个包 tool 实现做封顶：每工具一份复制，且新工具默认不受控；选 dispatch 边界单点。
- 用全局 flag 而非 ALS：并发 dispatch 互相污染，拒绝。
- `toolAccess` 允许任意值（如 `read-write`）：封顶只应收窄，允许 `read-write` 值会让配置语义含混，故只收 `'read-only'`，其余按非法配置 fail closed。

## Consequences

- 每个可用根的授权事实收敛为 `ScopeRoot.access` + 调用侧 cap；`resolve()` 是唯一执行缝，`writableRoots` 是唯一写授权投影，成员资格投影（`additionalRoots` / `roots`）永远不受影响。
- 已在运行的进程保留启动快照（ADR-0012 同一约定）；caps 只约束之后的 fs 调用与新进程。
- `danger-full-access` 与 `read-only` 模式逐字节保持上游语义。
- 已知限制：由未封顶工具启动的长寿命进程（常驻 dev server）在 cap 生效前拿到的快照不回收；回收方式仍是结束旧进程再启动。dispatch 之外的操作在配置非空时一律按封顶处理，这是刻意的偏严。

## Related Documents

- [B4–B8 开发计划](../plans/active/2026-10-11-b4-b8-p2.md)
- [ADR-0004 注册表持久化与校验](./ADR-0004-root-registry-persistence-and-validation.md)（单布局编码的同一套兼容策略）
- [ADR-0012 session origin 与进程快照](./ADR-0012-session-origin-and-effective-cwd.md)
- [架构文档 §4/§5](../architecture/multi-root-workspace.md)
