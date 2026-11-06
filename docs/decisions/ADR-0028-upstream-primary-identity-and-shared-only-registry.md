# ADR-0028: 主根身份以上游拼写为准，Registry 只保留共享模式

## Status

Accepted（2026-11-05 维护者决定，落实[根授权安全修复计划](../plans/completed/2026-11-05-root-authorization-security-fixes.md)的 F3 / MRW-01）。修订 [ADR-0004](./ADR-0004-root-registry-persistence-and-validation.md)“键 = canonical 主根”的约定，取代 [ADR-0007](./ADR-0007-registry-authority-lease.md) 的单进程模式，并使 [ADR-0027](./ADR-0027-revive-target-and-protected-paths.md) 第 4 条（legacy 介质推定）失效。原文保留作为历史。

## Date

2026-11-05

## Context

- **MRW-01**：插件在 Registry key、scope 查找、面板与 admission 中都对 `workspaceRoot` 重新 `canonicalPath`。主根目录被改名、原路径换成 symlink 后，插件算出新 key，查到空表，Full-access 下的只读拒写与 `protectedHome` 随之消失。
- 上游合同：`dsh-sandbox-policy` 的 `resolveWorkspaceRoot` 把 `session.header.cwd` 原样作为 `workspaceRoot`，只校验绝对路径，明确不在本机 canonicalize；只有执行侧 provider（`dsh-sandbox-local` 的 `confine`）在每次调用时 canonicalize。也就是说，上游给出的主根身份本身不随文件系统变化。
- 单进程模式（无 `sharedStorageRoot`）经上游 `storageDomain` 打开存储，上游公开接口不暴露其物理目录，保护集合只能推定。默认 bundle 自 `v0.1.12` 起已使用共享模式。

## Decision

1. **主根身份 = 上游拼写。** Registry 与 scope 的一切查找 key（存储表、缓存、发布、admission、共享 IPC 快照）都由 `primaryKey()` 从上游 `workspaceRoot` / `session.header.cwd` 生成：只做词法规范化（`path.resolve`，Windows 下小写），不访问文件系统。插件不自建 origin 绑定表，也不按当前解析结果选择记录。
2. **canonical 只用于几何。** 与主根的重叠判断、`FilesystemScope.primaryRoot`、fs fence 和内核方言仍使用当时的 `canonicalPath`。主根写授权是否跟随 symlink 是上游执行侧的行为，本插件不改变。
3. **拒写优先于主根。** recorded grant 与当前 canonical 主根相等或重叠的记录，判为 `invalid` / `primary-overlap`，作为可信边界继续 deny-only 发布；scope 不再豁免“与主根相同”的拒写边界。主根被换成指向只读根或其上级的 symlink 时，只读边界不会消失。
4. **消费方传上游拼写。** 面板 `resolvePanelPrimaryRoot` 返回 `session.header.cwd` 原值，命令、路由、Files、Skills、LSP、指令、review context 一律把上游拼写交给 Registry/scope，不先 canonicalize。
5. **升级迁移。** `v0.1.14` 及之前的存储按 canonical 主根作 key。owner 在上游拼写 key 下找不到记录时，读取其 canonical key 下的记录，并在第一次串行访问时把它复制到新 key（旧 key 保留）。这是唯一一处按当前解析结果选记录的地方，只对尚未迁移的存储生效。
6. **只保留共享模式。** Registry 必须配置 `sharedStorageRoot`，缺失即 `config-invalid` fail closed：不取 lease、不开存储、不授予任何附加根。物理介质总由 `storeIdentity()` 证明。Registry 行不再 inject `storageDomain`（改为 inject `storage`），存储只经 `openAuthorityStorage()` 打开。

## 修订：清空后保留迁移标记（2026-11-05，PR #39 评审）

第 5 条迁移后，删除最后一个附加根也必须在上游拼写 key 下保存 `{ roots: [] }`，不能删除整个 key。空记录表示“此主根已有自己的登记表，且已明确清空”，永久阻止该 key 再次回退读取保留的 legacy canonical 记录。所有清空写入都保留空记录，继续使用原 schema 和同一串行持久化路径，不增加第二份迁移状态。刷新、操作准入、重启以及后续路径重新解析均不能恢复已删除的附加根；保留的 canonical 记录仍可服务于它自己的主根身份。

## Alternatives Considered

| 方案 | 不采用的原因 |
| --- | --- |
| 插件自建“词法 origin → 首次 canonical key”绑定表 | 与上游身份重复，形成第二份真源；维护者要求以上游信息为准 |
| 继续用 canonical key，仅在 `scope.project()` 修补 | 面板、命令、admission、IPC 都会继续漂移，只修一处不够 |
| 保留单进程模式并推定介质位置 | 物理落点无法证明；共享模式已是默认 |

## Consequences

- 同一真实目录经不同拼写打开（例如经 symlink 与直接路径）是两个不同的主根，各自有独立的登记表。
- 升级后、首次串行访问前，未迁移的 symlink 主根仍按当前解析选记录；这一窗口在第一次 refresh/mutation 后关闭。
- 自定义组合若未配置 `sharedStorageRoot`，升级后 Registry 不再工作，需要按 bundle 默认值补齐 `sharedStorageRoot` 与 `leasePath`。
- 主根拼写与 recorded grant 重叠时拒写优先：若配置了 `toolAccess`，被封顶的工具在这种（只会由主根置换或手改存储产生的）情况下也不能写主根。
- 未经 admission 包装的上游服务在操作外自行 confine 子进程时只得到主根写权限；这是 ADR-0024/0025 的既有设计，此前被测试使用的单进程组合掩盖。
- 本 ADR 不处理 BYP-01：按维护者决定，可信人工确认（F1）暂不实施。

## Related Documents

- [根授权安全修复计划](../plans/completed/2026-11-05-root-authorization-security-fixes.md)
- [ADR-0012 Session origin 与 effective cwd](./ADR-0012-session-origin-and-effective-cwd.md)
- [ADR-0025 共享权威服务](./ADR-0025-shared-registry-authority.md)
- [ADR-0027 revive 目标与受保护目录](./ADR-0027-revive-target-and-protected-paths.md)
