# ADR-0019：Windows token 安全属性与条件 deny ACL（B9）

## Status

Proposed（2026-10-13；ADR-0018 的原生证伪保留；本方案需要特权 broker 的范围决定，原生执行状态只见路线账本）

## Date

2026-10-13

## Context

ADR-0018 的原生回归暴露可执行旁路：CreateRestrictedToken 取交集能移除 restricting deny SID；限制副本激活也不能守住实际 impersonation 写入。禁止 duplicate 虽能阻断这条操作，却破坏 PowerShell 的 .NET 身份查询。本决策使 deny 的判断独立于可删除的 restricting SID list。

## 原生前置条件（2026-10-13）

普通 Windows 插件进程设置 TokenSecurityAttributes 时实际返回 Win32 1314（缺少所需特权）。该信息类需要 SeTcbPrivilege，不能以一般管理员组或 TOKEN_ADJUST_DEFAULT 代替。当前 prototype 在这一步 fail closed，未启动子进程、也未开始树 ACL 修改；后续条件 ACE 的实际执行尚未获证据。不得宣称该设计已经可交付。

完整实现需要独立、经管理员安装的 SYSTEM broker，仅为受限 token 添加不可随派生移除的只读属性。是否允许增加此特权组件及部署前置条件，待用户范围决定；本 ADR 继续 Proposed，不把需求缺口重新延后为已完成。

## Decision（目标）

- 保留 `--mode danger-full-access --deny-root`、同一 scope、公开 shell / PTC / PTY 接缝和原生 process helper。只删除可绕过 DACL 的特权，完整 restricting check 镜像原 enabled identities，保留 ambient 文件访问与 integrity。
- 给派生 token 设置 mandatory、可继承的 **local security attribute** `DshMultiRootDeniedRoots`，字符串数组为 canonical 拒写根的稳定 hash 标识（沿用 `rootDenySid` 格式，仅作属性值，不把它加入 SID list）。使用 TokenSecurityAttributes 的 v1 / UNICODE_STRING ABI 与 ADD 操作；未知能力或失败均拒绝启动。
- 根及现有后代的显式条件 deny ACE 用 `Everyone` 为 trustee，条件为 `Exists DshMultiRootDeniedRoots && DshMultiRootDeniedRoots Contains "<root-id>"`。这是 normal token 的检查，去掉 restricting SID 后仍携带 mandatory 属性，无法因此绕过 deny。宿主没有该属性，Exists 为 false，不被匹配；不能只用缺失属性的比较，因为 conditional deny 对 UNKNOWN 也拒绝。
- deny 包括文件数据、append、metadata、delete、FILE_DELETE_CHILD、WRITE_DAC 和 WRITE_OWNER。OWNER RIGHTS 关闭 owner-implicit WRITE_DAC，真实 owner 获得显式 WRITE_DAC；父目录有同条件、非继承的 FILE_DELETE_CHILD / WRITE_DAC / WRITE_OWNER guard。普通宿主仍可编辑，不在宿主 user SID 上直接添加无条件 deny。
- token 对象及 TokenDefaultDacl 只拒绝 TOKEN_ADJUST_DEFAULT / WRITE_DAC / WRITE_OWNER，避免修改或撤销安全属性及 descriptor；身份 query、duplicate 和正常 impersonation 保留。副本可激活，但仍匹配同一条件 deny；回归实际执行两种激活路径后尝试写入，而非只验证某个 API 返回失败。
- ACL 按 handle 编辑（OPEN_REPARSE_POINT），不跟随 link 修改外部目标；逐对象显式 deny 覆盖 protected DACL / 显式 allow。使用与上游相同的 LockFileEx 路径锁，read-merge-set 保留无关 ACE、owner、SACL 和保护状态。相同 conditional ACE 去重后始终置于 explicit allow 之前，不随启动次数无限重复。
- standing 条件 ACE 不在 teardown 下撤销，运行中的 token 保留启动属性快照；新进程只携带新 scope 的拒写根。移除或改为可写后，新进程不匹配旧条件 ACE。根在准备前和 spawn 前复查，仍继承项目的 path-based / TOCTOU 边界。

Windows 继续报告 **partial**。只接受 ACL 可维护的 caller-owned 本地树与父目录；null DACL、网络/设备路径与原生能力缺失 fail closed。父目录 guard 对该 token 的父目录 ACL / owner 编辑和仅凭 FILE_DELETE_CHILD 的删除方式有所收窄；不新增网络、其他进程、已打开写句柄或外部主体改 ACL 的隔离保证。read-only / workspace-write 的原 grant runner 保持既有语义，temp 重叠的拒绝与 Landlock 的拒绝不计为完整实现。

## Validation

Windows 原生测试验证混合根九格、Node / pwsh / 后代、ConPTY / fd 7、protected DACL、overwrite / delete / rename / ACL reset、宿主写入与移除后恢复；生成只保留 user SID 的新 restricting token，分别经 ImpersonateLoggedOnUser 与 DuplicateTokenEx + SetThreadToken 激活，确认同一只读文件仍不可写。全版本 / 平台及 packed smoke 的实际证据只记路线账本。

## Alternatives Considered

- ADR-0018 的自定义 restricting deny SID 与副本激活限制：原生证据证伪，已被替代。
- 禁止 token duplicate：PowerShell InitialSessionState 初始化失败，不可交付。
- 属性缺失时的纯比较 conditional deny：UNKNOWN 会拒绝宿主写入，必须显式 Exists 保护。
- 修改全局会话模式、给宿主身份无条件 deny、只加根继承 ACE：分别破坏 ambient 权限、影响其他会话或留下 protected DACL 旁路，拒绝。

## Related Documents

- [ADR-0017：B9 合同](./ADR-0017-three-state-root-access-and-sandbox-modes.md)
- [ADR-0018：被替代方案与原生失败事实](./ADR-0018-windows-ambient-write-denial.md)
- [路线账本](../plans/active/2026-09-12-multi-root-workspace.md#b9附加根三态权限与跨-sandboxmode-执行一致性2026-10-13)
- [Microsoft：Conditional ACE SDDL](https://learn.microsoft.com/en-us/windows/win32/secauthz/security-descriptor-definition-language-for-conditional-aces-)
- [Chromium：AccessToken 安全属性实现与 ABI](https://chromium.googlesource.com/chromium/src/+/refs/tags/145.0.7632.1/base/win/access_token.cc)
