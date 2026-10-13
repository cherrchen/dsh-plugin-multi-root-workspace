# ADR-0020：Windows 普通 deny-only 组与局部拒写

## Status

Proposed（2026-10-13；候选已实现，Windows 原生验收状态只见路线账本）

## Date

2026-10-13

## Context

[ADR-0019](./ADR-0019-windows-token-attributes-and-conditional-acls.md) 的 broker 成功设置并读回 TokenSecurityAttributes，但实际 local 条件 ACE 不匹配；改用 SetTokenInformation(TokenUserClaimAttributes) 在 restricted 与普通副本上均返回 Win32 87。旧诊断还存在独立缺陷：PowerShell 的非终止错误让 `Exists @User...` 的非法 SDDL 未装入，却返回退出码 0；回读文本未被断言，不能把该探针当作条件求值证据。

[ADR-0018](./ADR-0018-windows-ambient-write-denial.md) 证伪的是 **restricting SID list** 的取交集删除，并非普通 TokenGroups 内的 deny-only SID。Microsoft 的 CreateRestrictedToken 合同区分二者：对普通组的 disable 操作只转换为 deny-only，不删除组；已有 deny-only 组不能贡献 allow 权限。可以通过特权 broker 创建带额外普通 deny-only 组的 token，再用普通 deny ACE，避开 local 属性 / claim 条件求值。

## Decision（候选）

- 保留既有安装入口、用户 SID 隔离、scope、公开进程接缝、根 SID 派生、逐对象 ACL writer、owner / parent guard、standing ACL 与 partial 边界。
- broker 使用独立虚拟服务账户 `NT SERVICE\DshMultiRootBroker-<installation-hash>`。LocalSystem 在实际 CI 上缺少 SeCreateTokenPrivilege（启用返回 Win32 1300），所以管理员安装器通过 LsaAddAccountRights 只向该服务 SID 授予 SeServiceLogonRight、SeCreateTokenPrivilege、SeTcbPrivilege、SeDebugPrivilege 和 SeImpersonatePrivilege；分别用于服务登录、token 创建 / session 镜像、打开已认证 caller 进程及管道认证。服务启动启用所需特权，不修改宿主用户、LocalSystem 或 ALL SERVICES 的权限，不依赖重启系统或其他系统进程。协议 v2 仅接受源 process-token handle 与最多 64 个固定格式 root deny SID。源身份来自内核管道 PID，管道身份、process token SID 和安装 SID 必须一致；token 对象的 QUERY / QUERY_SOURCE handle 在短暂模拟已认证管道调用方期间打开（SeDebugPrivilege 只覆盖 process，不越过 token DACL）；随后恢复服务身份再进行创建。NtCompareTokens 验证传入 handle 等同该 process token。不接受任意身份、命令、路径、权限或属性名。
- broker 拒绝已 restricted、AppContainer 或携带 user/device claims、device groups、可继承 local security attributes 的调用方 process token，避免重新铸造时丢掉现有限制。NtCreateTokenEx 镜像源 user、普通 groups（含 logon SID / integrity）、privileges、owner、primary group、default DACL、authentication ID、expiration、token source、mandatory policy 和 session ID；只增加每根的 `MANDATORY | USE_FOR_DENY_ONLY` 普通组，不增加 enabled / owner / allow 身份。
- broker 返回同一调用方进程内的有限权限 handle；读写 socket 失败则尽力关闭已回传 handle。runner 再用 CreateRestrictedToken 删除特权并镜像 ambient restricting identities，以公开 CreateProcessAsUser 接缝启动。
- runner 在 ACL 编辑 / spawn 前读回真正派生 token 的 TokenGroups，逐根验证普通组的 mandatory / deny-only 标志及禁用 enabled 标志。任何安装、认证、创建、回读失败都禁止裸启动。
- 每根使用 **普通 deny ACE**，trustee 为该 root deny SID。去掉 restricting list 或把全部普通 groups disable 后，该 trustee 仍在普通 deny-only groups 中匹配。宿主从未携带这些 groups，因此保留同一树的写与 ACL 管理权限。
- token 对象与 TokenDefaultDacl 拒绝 group / privilege / default 调整以及 descriptor 编辑；query、duplicate 与实际 impersonation 保留。既有 owner / parent / protected-descendant、ConPTY / fd 7 合同不变。

本方案仍需 Windows 原生结果验证；结构检查和 macOS 跳过不能确认 NtCreateTokenEx、CreateProcessAsUser 或真实拒写成立。只修改该专用虚拟服务账户的固定权限集合，记录安装新增的 rights，升级 / 卸载及启动失败时仅撤销这次安装新增项，保留预存 account policy；不从其他系统进程获取 token；服务自身不能启用所需特权时 fail closed。

## Validation

现有九格矩阵、Node / pwsh / 后代、overwrite / delete / rename / ACL reset、protected DACL、ConPTY / fd 7、宿主写入与根权限变更回归全部保留。弱化 token 用例除 restricting-list 取交集外，再 disable 全部普通组，激活两种弱化 token 后真实写入；不以 API 失败或 broker ACK 代替写拒绝证据。全版本全平台执行只记录在[路线账本](../plans/active/2026-09-12-multi-root-workspace.md#b9附加根三态权限与跨-sandboxmode-执行一致性2026-10-13)。

## Alternatives Considered

- 继续调整 local attribute flags：已有多种 flag 读回正确但不匹配条件的证据，不能继续据此保证拒写。
- 铸造 UserClaims 再用条件 ACE：仍依赖条件求值与属性缺失时的 UNKNOWN 规则，增加不必要的 ABI 与防删除合同；普通 deny-only groups 已能表达每根拒绝。
- restricting SID、禁止 duplicate、改变全局模式：既有原生证伪或破坏需求，不恢复。

## Related Documents

- [ADR-0017：三态根权限](./ADR-0017-three-state-root-access-and-sandbox-modes.md)
- [B9 专项计划](../plans/active/2026-10-13-b9-root-access-and-sandbox-modes.md)
- [Microsoft：CreateRestrictedToken](https://learn.microsoft.com/en-us/windows/win32/api/securitybaseapi/nf-securitybaseapi-createrestrictedtoken)
- [System Informer：NtCreateTokenEx ABI](https://github.com/winsiderss/phnt/blob/master/ntseapi.h)

## 安装与卸载

安装入口保持 `scripts/windows-broker/install.ps1 -UserSid <插件宿主用户SID>`，必须使用管理员 PowerShell；省略 UserSid 时使用当前用户，卸载加 `-Uninstall`。每用户稳定命名的服务账户与 pipe，安装目录和 executable 由管理员持有，宿主用户与虚拟服务账户仅获读取/执行。安装器的 `rights.cs` 随 tarball 提供，并作为打包必须项检查；broker 不提供修改 LSA policy 的请求。旧 LocalSystem 安装由同一入口停止并替换，协议 v1 客户端被新版拒绝，不能静默恢复裸进程。
