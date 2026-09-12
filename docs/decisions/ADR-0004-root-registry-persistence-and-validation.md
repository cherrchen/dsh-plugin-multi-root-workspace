# ADR-0004: Root 注册表的持久化形态与校验语义

## Status

Accepted

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

## Consequences

- 注册表成为 M2 provider 的唯一数据源，`MultiRootScopeService.setAdditionalRoots()` 仍是 scope 的公开写口（测试与冒烟继续可用），但生产调用者只有注册表。
- 用户可见的三种状态（`available` / `missing` / `invalid`）成为面板与命令的共同词汇，也被 `renderRootsReport` 直接渲染。
- 存储 schema 的版本号是 1；任何不兼容的形态变化必须提升版本并接受"旧存储拒绝打开 → 用户看到明确原因"的行为。
- `zod` 因此成为插件的运行时依赖（与 `dsh-storage-domain` 同源），宿主侧不再新增其他依赖。

## Related Documents

- [M3 开发计划](../plans/completed/2026-09-12-m3-root-registry-command-and-ui.md)
- [架构文档 §7](../architecture/multi-root-workspace.md)
- [需求文档 §5/§15](../requirements/multi-root-workspace.md)
- [ADR-0002 上游耦合策略](./ADR-0002-upstream-coupling-policy.md)
