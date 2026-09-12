# ADR-0004: Root 注册表的持久化形态与校验语义

## Status

Accepted（2026-09-12 依据外部审查补充第 9–14 条决策；原 1–8 条不变）

## Date

2026-09-12

## Context

M3 要把"哪些目录是附加根"从测试注入变成用户可管理的持久数据。实施前实测确定了四条约束：

1. **可以提供的数据源只有 `ctx.storageDomain`**（`dsh-storage-domain` 的 domain KV），它要求表 schema 是 **zod**，`layout` 默认 `single`（整个 domain 一个文档）、可切 `per-record`；写入**不做** schema 校验，只有 `open` 时才校验已存记录；`single` layout 下键是任意字符串，而 `per-record` layout 的键必须匹配 `/^[a-zA-Z0-9_-]+$/`（路径不能当键）。
2. **数据源不能建在 `workspaceRegistry` 上**：上游 `@deepseek-ai/dsh-workspace` 只在 `web-app` 组合里挂载（headless 没有），而 provider 侧解析 scope 的唯一输入是 `policy.workspaceRoot`（`src/scope.ts`）。以 `WorkspaceId` 为键会让 headless 上的注册表完全失效。
3. **domain 名是进程级独占的**：base 组合已经打开 `session_projcache`，web-app 组合还打开 `workspace`；重名 `open` 会抛 `already-open`。
4. **上游对"读不出来的存储"有两种态度**：schema 不符的记录在 `single` layout 下没有可备份的独立文档，`invalidRecords: 'backup-and-skip'` 实际退化为"整次 open 拒绝"；domain 版本不符也一律拒绝 open。

同时有一个产品判断悬而未决：嵌套的附加根（候选在主根或某个附加根之下、或候选包含某个附加根）是接受还是拒绝。路线图把它留给 M3 拍板。

## Decision

1. **存储键 = canonical 主根（字符串）**，不用 `WorkspaceId`，也不新增"工作区实体"概念。domain 名为 `multi_root_workspace`，version 1，`single` layout，单表 `roots`，记录形态 `{ roots: [{ id, path, alias?, addedAt }] }`。键选 canonical 主根是因为它正是 `policy.workspaceRoot` 的 canonical 形式，provider、命令、面板三处解析出的键因此必然一致。
2. **`layout` 固定 `single`**：一个主根的登记表是一个整体（顺序即显示顺序），没有大记录或稀疏记录；同时 `single` 是"路径可以当键"的前提。**触发条件**：若将来必须切 `per-record`（例如记录数量或体积失控），键方案必须同时改为 id 或哈希，不能沿用路径——这条写在这里以免后人踩坑。
3. **根 id 用生成的 uuid，brand 是本地类型**（`AdditionalRootId`，只有编译期意义）。路径会随 canonical 化变化、别名会改，引用锚点必须稳定；不为此引入 `@deepseek-ai/dsh-brand` 依赖。
4. **校验顺序固定，首个失败即抛**：非绝对路径 → 不存在 → 不是目录 → canonical 化 → 等于主根 → 与已登记根重复 → 嵌套（双向）。前导 `~` 会被展开（`~` 与 `~/…`），其他相对路径一律拒绝，不猜测 base。
5. **嵌套一律拒绝**（双向，错误里点名冲突的根）。理由：联合语义下嵌套项不会带来任何新的可写范围，却会让"面板列出的 N 项"与"实际授予的根集合"不再一一对应；拒绝让列表与权限保持 1:1，也让重复登记成为可见错误而不是静默冗余。
6. **只有"可用"的根进入 scope**：登记存在但目录当前不在的项标记为 `missing`，保留在存储里（目录回来即可恢复）但**不授予**——把不存在的根交给 bwrap/Landlock 只会让受限命令失败，而不是"少授予一点"。启动与每次变更都用同一套规则重算。
7. **不可读的存储降级而不是阻断启动**：存储里存在违反规则的记录时，该记录标记为 `invalid`（保留、不授予、由用户显式删除）；整个 domain 打不开（损坏 JSON、版本不符）时，注册表记录原因、`list()` 返回空、**所有写操作抛 `storage-unavailable`**，并把原因写进 logger 与面板/命令输出。理由：授予为空是安全方向，而一个坏掉的旁路存储不应该让整个 harness 起不来；需求 §8 的"失败要响亮"针对的是用户误配置，不是介质损坏——这里仍然响亮，只是不致命。
8. **写入先落盘再改内存**：每次变更先 `put`/`delete`，成功后才重播种 scope 并通知监听者；写失败即抛出，运行中的 scope 不会授予存储里没有的根。

### 2026-09-12 返工补充（外部审查发现）

9. **记录"授予目录"（`recordedPath`）**：每条记录除 `path` 外，另存登记当时观察到的 canonical 目录。授权条件为 `canonicalPath(path) === recordedPath`。理由是 `canonicalPath` 就是 `realpath`：登记目录被替换为符号链接（或链接链中某段被改）后，重新解析会指向**另一个**目录，而"重新解析"绝不能被当成"重新授权"。`recordedPath` 缺失的记录（旧数据或手写数据）报 `invalid`，不猜测、不静默补写，由操作者显式删除或重新登记。
10. **状态词汇扩为四态**：`available` / `missing` / `redirected`（登记目录现在解析到别处）/ `invalid`。`missing` 与 `redirected` 都保留登记、都不授予，且都能在目录恢复后由重新校验自动复原；`invalid` 只能由操作者删除。裁决顺序固定：身份与唯一性 → `recordedPath` 是否变化 → 与主根的关系 → 与其他记录的关系 → 存在性。`redirected` **先于**重叠判定，避免用攻击者可控的新目标参与包含运算。
11. **主根纳入重叠校验（双向）**：候选在主根之下、或包含主根，一律拒绝，错误码 `primary-overlap`（与"恰好等于主根"的 `equals-primary` 区分）。存储读取侧同样适用。此前主根只在 `existing` 列表为空时才"偶然"挡住一部分情况（见原 §5 的意图与实际实现的差距）。
12. **重复 id 的处置**：读取时若同一 id 出现在多条记录中，**这些记录全部**报 `invalid`、全部不授予。"按 id 取第一条"正是让存储无法解读的歧义来源。清理由 `removeAt`（按位置/路径/首次匹配删除**一条**）完成，面板与命令都走它——按 id 过滤的删除会一次删掉多条，与"一次操作只影响一条记录"的预期不符。
13. **读取也重新校验，但不写存储**：`refresh(primaryRoot)` = 重新 `stat` 每个登记目录 + 重新解析 + 重新裁决 + 重播种 scope + 通知监听者，**不落盘**；命令 `list` 与面板 `list` 端点都走它。理由：没有重新校验的"刷新"会让面板列出的范围与实际授予的范围长期不一致（目录删掉后仍显示 `available`），而只读刷新若落盘又会把"看一眼列表"变成一次写入。`recheck` 保留为"refresh + 落盘一次"，仅供需要持久化重判结果的调用方使用。
14. **写操作按主根整体串行**：每次变更的"读快照 → 校验 → 落盘"整段进入该主根的 Promise 队列。存储域只串行化单个 `put()`/`delete()`，不足以覆盖读—改—写：并发 `add(A)`/`add(B)` 会双双成功却只留一条，`remove` 与 `add` 并发会把已删除的记录写回去。这是对本文档原「风险与处置」里"domain 层串行化写入链即足够"这一判断的更正。
15. **`publish` 幂等**：仅当"实际授予集合 + 不可用集合"发生变化时才重播种 scope 并通知监听者。重新校验因此可以随时执行而不产生抖动，也不会在每次列目录时重复告警。

## Alternatives Considered

| 方案 | 否决理由 |
| --- | --- |
| 以 `WorkspaceId` 为键、加入 workspaceRegistry | headless 组合没有 `workspaceRegistry`；且 provider 侧拿不到 workspaceId |
| `per-record` layout（一记录一文件） | 键必须是 `/^[a-zA-Z0-9_-]+$/`，路径不能当键，必须再造一套 id→路径索引；当前数据量也不值得 |
| 用 session 事件承载 scope | 未装插件的 dsh 会拒绝打开含未知事件类型的日志（session-format required-on-read），M1 已排除 |
| 嵌套根"允许并记录" | 列表与授予集合不再一一对应；用户看到两项却只有一份权限，且删掉外层会静默改变内层是否冗余 |
| 嵌套时自动取并集（丢弃被覆盖项） | 用户在面板上看不到自己刚添加的项，比报错更难理解 |
| 存储损坏时让插件行激活失败（fail loud） | 一个旁路存储的损坏会让整个 harness 无法启动；且授予为空本身不是安全降级 |
| 把不可读记录直接从存储删除 | 未经用户确认就销毁数据；`invalid` 标记 + 显式删除把决定权留给用户 |
| 只授予 `available` 根之外的"尽力而为"（把 missing 也塞进 grant） | bwrap/Landlock 会因此让受限命令整体失败（M2 风险 #6 的实际原因） |
| 发现解析结果变化时直接沿用新目标（即返工前的行为） | 本地替换一个目录即可把写权限转移到从未登记过的目录；登记表与实际授权随即脱节 |
| 发现解析结果变化时把记录标为 `invalid` 并永久失效 | 目录被误替换后无法通过"恢复目录"回到可用状态，操作者必须重新登记；`redirected` 保留了可恢复路径 |
| 只串行化存储层的 `put()` | 覆盖不到读—改—写；并发 `add` 丢记录、并发 `add`/`remove` 复活已删记录（返工实测复现） |
| 只读刷新也写回存储 | "看一眼列表"变成一次写入，且会把重新分类的结果当成新的用户意图持久化 |
| 重复 id 时"第一条生效、其余忽略" | 删除与改别名仍会同时作用在多条记录上；面板也无法把两条区分开 |

## Consequences

- 注册表成为 M2 provider 的唯一数据源，`MultiRootScopeService.setAdditionalRoots()` 仍是 scope 的公开写口，但**登记的每一项都必须带 `recordedPath`**，否则 scope 侧会拒绝授予（scope 不信任"当前解析结果"）。
- 用户可见的四种状态（`available` / `missing` / `redirected` / `invalid`）成为面板与命令的共同词汇，也被 `renderRootsReport` 直接渲染。
- 存储 schema 的版本号仍为 1：新增字段是**追加**，读取侧对缺失字段按 `invalid` 处理，因此不需要"版本不符则拒绝打开"这条更重的路径；代价是旧记录在用户显式处置前都会显示为 `invalid`（这是刻意的：不猜测、不静默改写）。
- `zod` 因此成为插件的运行时依赖（与 `dsh-storage-domain` 同源），同一份 `zod` 也被内联进浏览器制品用于**面板通道两端**的运行时校验；宿主侧不再新增其他依赖。
- 已知限制（明确记录，不在本期解决）：裁决与内核调用之间仍存在 TOCTOU 窗口，真正的原子性需要内核侧 fd 语义；主根自身被解析到别处属于上游 `policy.workspaceRoot` 的行为，不在本插件的重新授权范围内。

## Related Documents

- [M3 开发计划](../plans/completed/2026-09-12-m3-root-registry-command-and-ui.md)
- [架构文档 §7](../architecture/multi-root-workspace.md)
- [需求文档 §5/§15](../requirements/multi-root-workspace.md)
- [ADR-0002 上游耦合策略](./ADR-0002-upstream-coupling-policy.md)
