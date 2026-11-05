# ADR-0027: revive 不改变授权目标与受保护目录登记边界

## Status

Accepted（P1 合同）。本 ADR 落实[根授权安全修复计划](../plans/active/2026-11-05-root-authorization-security-fixes.md)中 F2 与 F4 的“候选/存量校验”部分，计划本身已于 2026-11-05 经维护者接受。它修订 [ADR-0014](./ADR-0014-root-limit-and-provider-conflict.md) 与 [ADR-0017](./ADR-0017-three-state-root-access-and-sandbox-modes.md) 中关于 revive 的描述，保留原文作为历史；F1 管理授权、F3 origin 绑定、F4 执行侧 deny 与 F5 默认 authority 不在本 ADR 范围内，仍以计划为准。legacy 组合的介质推定（第 4 条）是待评审项，见计划 P0 记录第 3 项。

## Date

2026-11-05

## Context

外部报告核查确认两处“路径重新解析变成重新授权”的缺口：

- **BYP-02**：`registry.add()` 用当前解析目标匹配 withheld 记录，再以 `grantFields(..., canonical)` 重写 grant。登记目录被换成 symlink 后，重新添加原路径（面板“重新登记”单击即可）会把旧 access 迁移到新目标，与 ADR-0004 第 9 条“重新解析不是重新授权”相矛盾。ADR-0014 的修订还明确要求这种情况“revive 同一条记录而非新建第二条”。
- **`$DSH_HOME` 边界缺失**：候选校验只看主根与已有根，没有 home 禁区。workspace-write 下可以登记 home 本身、祖先或后代并获得写权限；home 外的共享介质与 lease 目录同理。`protectedHome` 只在受限 Full-access 的执行侧生效，管不到登记。

## Decision

1. **revive 只能回到原授权目标。** withheld 记录被 `add` 匹配到时，只有当它恰有一个 grant 字段，且当前 canonical 目标与该字段相等（三种编码 `recordedPath` / `readOnlyRecordedPath` / `readWriteRecordedPath` 一视同仁）时才就地恢复，并仍要通过完整候选校验。否则以 `revive-target-changed` 拒绝，不写盘。结构损坏、没有唯一 grant 的记录同样拒绝，不按当前目标修复。要换目标只能先移除旧登记再显式新增；本 ADR 不提供原子替换。
2. **面板只为 `missing` 行提供“重新登记”。** `redirected` 行改为显示“目标已改变：请移除后再显式添加”的说明，`invalid` 行不再提供该按钮（冲突靠移除另一方解决，结构损坏只能删除）。hover tooltip 不算确认。
3. **受保护目录集合。** Registry 从可信 Host 配置得到保护集合：scope 行的 `dshHome`（kind `dsh-home`）、共享模式下 `storeIdentity()` 解析出的物理介质（kind `registry-medium`）、lease 所在目录（kind `registry-lease`）。每项同时包含配置拼写、当前 canonical 与**首次成功解析时钉住的 canonical**，home 或介质后来被改名/换成 symlink 时，钉住的旧边界不会丢。不信任面板、shell env 或 follower 之外任何客户端自报的路径。
4. **legacy 组合的介质推定。** 无 `sharedStorageRoot` 时，上游公开接口不暴露 storage-json 的 `root`。P1 依据 ADR-0007 的配置合同（lease 与 JSON 文档同目录），把 lease 目录当作介质目录保护。若评审要求严格执行“无法证明物理落点即拒绝”，legacy 组合应改为拒绝全部新增登记。
5. **候选拒绝。** 所有模式、所有 access 的新增与 revive，只要 canonical 候选与任一保护目录相等、位于其内或包含它（含 symlink 别名，因为比较的是 canonical 值），都以 `protected-path` 拒绝，且不提供远程豁免。home 已配置但当前不是目录，或 `dshHome` 配置非法时，保护集合无法证明，新增与 revive 以 `protected-boundary-unknown` 拒绝。
6. **存量记录 withheld，负边界保留。** recorded grant 与保护集合重叠的存量记录判为 `invalid`，内部原因 `protected-path`，不删除、不自动重授。它和 `membership-conflict` 一样属于“边界可信、成员资格 withheld”：继续以 deny-only 形式发布，并在 `reservedRootBoundary` 中占位，原 read-only/cap 的拒绝信息不丢。保护集合部分未知时，存量分类使用已知部分（至少包含钉住值）；“未知”只阻止新授权，不削弱存量分类。
7. **共享 follower 只做收窄。** owner 用自己的集合做最终校验；follower 在把 `add` 发给 owner 之前，先用自己的集合做本地拒绝，并在应用 owner 快照时把落入自己集合的行标为 `protected-path` withheld，因此 owner 与 follower 的 home 不同时也不会漏保护。IPC 快照的 `invalidReason` 枚举随之扩展；协议版本不变，旧 follower 解析新原因会失败并断线，按 fail-closed 处理。

## Alternatives Considered

| 方案 | 不采用的原因 |
| --- | --- |
| redirected 匹配时新建一条记录指向新目标 | 用户输入的是旧登记的路径，静默改成“新增”仍是单击把新目标纳入；而且旧记录还在，界面更难理解 |
| 存量危险记录降为通用 `invalid` | 结构性 `invalid` 不发布投影，会丢掉可信的 read-only 负边界 |
| 只拦 `candidate === home` | 祖先目录同样覆盖 home，后代目录同样落在 home 内 |
| legacy 组合直接拒绝全部新增 | 安全上更严格，但会让所有自定义 legacy 组合无法管理根；留给 P0 评审决定 |

## Consequences

- revive 不再是 redirected 行的修复途径。操作者需要先移除、再显式新增；新增的管理授权由计划 P2 负责，在此之前它仍是一次普通的 `add`。
- 根数量上限的“revive 不占额度”只适用于原目标恢复；redirected 行不能再通过重新登记绕过上限来修复。
- 新增稳定错误码 `protected-path`、`protected-boundary-unknown`、`revive-target-changed`，命令与面板双语文案同步。
- 本 ADR 不建立 home 读取 ACL，不处理执行侧的 home 写入 deny（主根/temp 覆盖 home 的情况属于 P3），也不宣称堵住 cookie 伪造链。

## Related Documents

- [根授权安全修复计划](../plans/active/2026-11-05-root-authorization-security-fixes.md)
- [ADR-0004 登记与校验](./ADR-0004-root-registry-persistence-and-validation.md)
- [ADR-0007 Registry 租约](./ADR-0007-registry-authority-lease.md)
- [ADR-0014 根上限与 provider 冲突](./ADR-0014-root-limit-and-provider-conflict.md)
- [ADR-0017 三态访问与沙箱模式](./ADR-0017-three-state-root-access-and-sandbox-modes.md)
- [ADR-0025 共享权威服务](./ADR-0025-shared-registry-authority.md)
