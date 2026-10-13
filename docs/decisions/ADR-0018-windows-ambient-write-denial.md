# ADR-0018：Windows Full-access 的局部写拒绝（B9）

## Status

Rejected（原生回归证伪，2026-10-13；后续方案见 [ADR-0019](./ADR-0019-windows-token-attributes-and-conditional-acls.md)）

## Date

2026-10-13

## Context

用户要求把 B9 原先延后的 Windows Full-access + 局部只读重新纳入开发。既有上游 `AclSandbox` 的 capability SID 只表达 allowlist，不能用 workspace-write 近似该组合，否则主根和未登记区域会失去 Full-access 文件写权限。独立 runner 仍不能深导入任何上游实现。

## 原生回归结论与替代

本文保留 B9 Windows 首轮方案的历史。真实回归证明：restricting SID 可以经 CreateRestrictedToken 被取交集删除；仅设置 token DACL 不足以传递到派生对象；禁止 token duplicate 又使 PowerShell 的 .NET 初始化失败；保留 duplicate、限制副本激活也未守住实际 impersonation 写入边界。因此本文的 token-DACL 防派生方案**不能作为当前执行保证**，已由 ADR-0019 的 mandatory local token attribute + conditional deny ACE 替代。下文 Decision 是被替代的方案，不是当前实现。

## Decision（被替代）

### 入口与令牌

`restrictedArgvPrefix()` 识别上游 Windows profile 后改选插件自己的 `windows-runner.js --mode danger-full-access --deny-root R`。该模式只接受非空 deny 集，不接受 `--additional-root` 或 write capability SIDs。scope 仍是唯一权限解析点；shell、PTC 与 PTY 沿用 ADR-0017 的公开方法包装，不改变会话策略。

runner 从上游 ACL 安装位置解析公开的 `dsh-win32-process` 和 Koffi，结构检查集中于 `src/compat/windows-native.ts`。只使用其公开 inherited-stdio / Job / fd 7 / wait 接口；独立 runner 的静态模块图仍只有 `node:` 内置。未知导出、路径失效或原生失败都退出 127，不启动裸进程。

使用 `CreateRestrictedToken(DISABLE_MAX_PRIVILEGE)`，restricting list 包含原 token 的 user、enabled 且非 deny-only 的 groups，以及每个拒写根的独立 deny SID。ambient 的正常 DACL 与完整 restricting 检查均可匹配原身份；根上的显式 deny ACE 则在第二次检查拒绝写。不使用 WRITE_RESTRICTED 快捷方式：第一轮 Windows 原生回归证明该快捷方式可放过目录重命名的 parent-access 路径；read 仍匹配原身份，不额外加读取围限。保持原 integrity，不创建 private temp、不改 TMP / TEMP，不把目录 grant 扩成全局提升。可绕过 DACL 的 backup / restore / take-owner 等特权被移除。

### 防绕过与 ACL 生命周期

- deny SID 由 canonical 根派生，使用独立 hash 域与 SID 后缀，永不等同 write capability；新进程只携带本次 scope 的 deny SIDs。
- 为根及现有后代逐一设置显式 deny（写数据、append、metadata、DELETE、FILE_DELETE_CHILD、WRITE_DAC、WRITE_OWNER）。不能只依靠根的继承 ACE：显式 allow 与 protected DACL 会削弱继承 deny。目录 ACE 同时可继承到未来对象。
- 用 `CreateFileW(OPEN_REPARSE_POINT | BACKUP_SEMANTICS)` + handle security API 编辑对象自身；不跟随 symlink / junction 修改外部目标。根身份在准备前和 spawn 前复查。该路径仍继承项目的 path-based / TOCTOU 边界，不宣称任意敌对目录替换下原子授权。
- OWNER RIGHTS 的 READ_CONTROL ACE 关闭 owner-implicit WRITE_DAC；真实 owner 获得显式 WRITE_DAC，宿主保留 ACL 管理能力，但 deny token 会被 deny SID 拒绝。只接受 caller-owned（user 或 enabled owner group）对象和非 null DACL，不能保守表达时 fail closed。
- 直接父目录的 FILE_DELETE_CHILD 也可授权删除只读根，因此对父目录添加同一 deny SID 的非继承 FILE_DELETE_CHILD / WRITE_DAC / WRITE_OWNER guard。同样应用 owner 权利处理，防止子进程重写 parent guard。
- 每个对象的 read → merge → set 使用与上游 ACL writer 一致的 `GetTempPathW()/dsh-acl-locks/<path-hash>.lock` + `LockFileEx` 协议串行，锁文件不可删除；这是本地 Win32 重实现，不深导入私有 helper，避免并发 allow grant 擦除 deny。进程退出由内核释放，不使用 PID/TTL 锁。保留无关 ACE、owner、SACL 与原继承状态。
- `CreateRestrictedToken` 可把 restricting list 取交集，故自定义 deny SID 不能独自成为可信边界。同时设置源 token 对象 DACL 与 TokenDefaultDacl：进程创建会派生新 primary-token 对象，其 DACL 来自 default DACL，只有源对象限权不足。DACL 拒绝 assign / impersonate / adjust / WRITE_DAC / WRITE_OWNER，并用 OWNER RIGHTS 去除隐式 WRITE_DAC。query / duplicate 保留：Windows PowerShell 的 .NET 身份查询必须复制 token，禁止 duplicate 会使 InitialSessionState 初始化失败。安全边界是弱化后的副本不能被激活为进程或线程身份，而非不能产生副本；原生回归实际去掉 deny SID 后尝试 ImpersonateLoggedOnUser 和 DuplicateTokenEx + SetThreadToken，再验证文件仍不可写。runner 的已打开 handle 继续负责 spawn。
- deny ACE 为 standing ACE，退出时不撤销，保留运行中进程的权限快照及并发安全。移除根 / 改为可写后，新 token 不携带其 deny SID，standing deny 不匹配，宿主和后续 ambient 进程仍可写。token / process / Job / lock 句柄按生命周期关闭；runner 镜像子进程退出码，Job 保证 runner 死亡时结束其子进程。

### 能力边界

Windows 仍按上游报告 **partial**，不是通用的 Windows 安全隔离边界。新机制保证上述本地文件路径的变更合同，不增加网络或进程可见性隔离；利用其他宿主进程代执行、已有开放写句柄、外部主体主动修改 ACL / 移入对象等仍超出既有威胁模型。拒写根和其父目录必须可由调用者维护 ACL；无法证明时拒绝整个受限启动。

父目录 guard 会额外拒绝该 token 在父目录上的 ACL / owner 修改，以及仅凭父目录 FILE_DELETE_CHILD 的删除方式；普通 sibling 对象自有 DELETE 权限及文件写入继续按 ambient DACL。此限制是 Windows 删除检查所需，必须如实披露，不能宣称 Windows 的所有 Full-access 特权都与裸 token 一致。standing owner 权利与 deny ACE 留在磁盘上，不在活跃进程下撤销。

原 read-only / workspace-write runner 继续沿用现有 root-set write capability 与 Low label。workspace-write 下只读根与 temp grant 重叠仍按 ADR-0017 拒绝；本修订不将该失败处理伪装成实现完成。Landlock 的 ambient 局部拒写仍显式拒绝。

## Validation

Windows CI 原生验证九格混合根矩阵、主根和 ambient 写允许、只读根读允许 / 写拒绝、Node / pwsh / Node 后代、overwrite / delete / rename / ACL reset、protected DACL、弱化 token 激活拒绝、ConPTY 和 fd 7。行为及 packed 冒烟经真实 pwsh bypass 路径执行允许与拒绝；全部精确支持版本跑现有 OS 矩阵。POSIX 的结构或跳过结果不能作为 Windows 执行证据；执行状态只记路线账本。

## Alternatives Considered

- 改全局模式为 workspace-write：破坏主根与 ambient 文件写权限，拒绝。
- 给宿主 user SID 添加 deny：同样约束宿主和其他会话，拒绝。
- 只有自定义 restricting deny SID：可通过再次派生 token 删除该 SID，拒绝。
- 只有根继承 deny：protected DACL / 显式 allow、owner WRITE_DAC 与父目录删除都有旁路，拒绝。
- 深导入上游 `token.ts` / `acl.ts`：违背 out-of-tree 和稳定公开接缝约定，拒绝。

## Related Documents

- [ADR-0017：B9 三态权限](./ADR-0017-three-state-root-access-and-sandbox-modes.md)
- [ADR-0011：Windows 消费方与 partial 边界](./ADR-0011-multi-root-workspace-consumers.md)
- [B9 专项计划](../plans/active/2026-10-13-b9-root-access-and-sandbox-modes.md)
- [路线账本](../plans/active/2026-09-12-multi-root-workspace.md#b9附加根三态权限与跨-sandboxmode-执行一致性2026-10-13)
- [Microsoft：CreateRestrictedToken](https://learn.microsoft.com/en-us/windows/win32/api/securitybaseapi/nf-securitybaseapi-createrestrictedtoken)
- [Microsoft：OWNER RIGHTS SID](https://learn.microsoft.com/en-us/windows/win32/secauthz/well-known-sids)
