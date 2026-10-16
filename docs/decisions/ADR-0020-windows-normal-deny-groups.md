# ADR-0020：Windows 普通 deny-only 组与局部拒写

## Status

Accepted（2026-10-13；Windows 原生及完整门禁证据只见路线账本）

## Date

2026-10-13

## Context

[ADR-0019](./ADR-0019-windows-token-attributes-and-conditional-acls.md) 的 broker 成功设置并读回 TokenSecurityAttributes，但实际 local 条件 ACE 不匹配；改用 SetTokenInformation(TokenUserClaimAttributes) 在 restricted 与普通副本上均返回 Win32 87。旧诊断还存在独立缺陷：PowerShell 的非终止错误让 `Exists @User...` 的非法 SDDL 未装入，却返回退出码 0；回读文本未被断言，不能把该探针当作条件求值证据。

[ADR-0018](./ADR-0018-windows-ambient-write-denial.md) 证伪的是 **restricting SID list** 的取交集删除，并非普通 TokenGroups 内的 deny-only SID。Microsoft 的 CreateRestrictedToken 合同区分二者：对普通组的 disable 操作只转换为 deny-only，不删除组；已有 deny-only 组不能贡献 allow 权限。可以通过特权 broker 创建带额外普通 deny-only 组的 token，再用普通 deny ACE，避开 local 属性 / claim 条件求值。

## Decision

- 保留既有安装入口、用户 SID 隔离、scope、公开进程接缝、根 SID 派生、逐对象 ACL writer、owner / parent guard、standing ACL 与 partial 边界。
- broker 使用独立虚拟服务账户 `NT SERVICE\DshMultiRootBroker-<installation-hash>`。LocalSystem 在实际 CI 上缺少 SeCreateTokenPrivilege（启用返回 Win32 1300），所以管理员安装器通过 LsaAddAccountRights 只向该服务 SID 授予 SeServiceLogonRight、SeCreateTokenPrivilege、SeAssignPrimaryTokenPrivilege、SeTcbPrivilege、SeDebugPrivilege 和 SeImpersonatePrivilege；分别用于服务登录、token 创建与暂停子进程赋值 / session 镜像、打开已认证 caller 进程及管道认证。服务启动启用所需特权，不修改宿主用户、LocalSystem 或 ALL SERVICES 的权限，不依赖重启系统或其他系统进程。协议 v2 仅接受源 process-token handle 与最多 64 个固定格式 root deny SID。源身份来自内核管道 PID，管道身份、process token SID 和安装 SID 必须一致；token 对象的 QUERY / QUERY_SOURCE handle 在短暂模拟已认证管道调用方期间打开（SeDebugPrivilege 只覆盖 process，不越过 token DACL）；随后恢复服务身份再进行创建。NtCompareTokens 验证传入 handle 等同该 process token。不接受任意身份、命令、路径、权限或属性名。
- broker 拒绝已 restricted、AppContainer 或携带 user/device claims、device groups、可继承 local security attributes 的调用方 process token，避免重新铸造时丢掉现有限制。NtCreateTokenEx 镜像源 user、普通 groups（含 logon SID / integrity）、privileges、owner、primary group、default DACL、authentication ID、expiration、token source、mandatory policy 和 session ID；只在服务内的中间 token 增加每根的普通组，随即用 CreateRestrictedToken 将这些组转为 deny-only 并移除除 SeChangeNotifyPrivilege 外的特权；中间 token 的句柄不出服务，回传 token 不增加 enabled / owner / allow 身份。
- broker 返回同一调用方进程内的有限权限 handle；读写 socket 失败则尽力关闭已回传 handle。runner 再用 CreateRestrictedToken 验证普通 deny-only groups，但由 broker 创建的 token 不是 runner 自身的直接派生，实际 CreateProcessAsUserW 返回 Win32 1314，不能直接用于启动。公开 helper 必须以原 runner token 创建暂停的子进程（检查 CREATE_SUSPENDED），经下面的 assignment 操作后才能由 helper 加 Job / ResumeThread。
- runner 在 ACL 编辑 / spawn 前读回真正派生 token 的 TokenGroups，逐根验证普通组的 deny-only 标志及禁用 enabled 标志。任何安装、认证、创建、回读失败都禁止裸启动。
- 每根使用 **普通 deny ACE**，trustee 为该 root deny SID。去掉 restricting list 或把全部普通 groups disable 后，该 trustee 仍在普通 deny-only groups 中匹配。宿主从未携带这些 groups，因此保留同一树的写与 ACL 管理权限。
- 协议 v3 只携带子进程 / 主线程 handle 与 root deny IDs，不携带命令、路径、cwd、环境或任意 token。broker 从 pipe 身份认证原 runner，拒绝 IsTokenRestricted 与 AppContainer 调用方；UAC 过滤令牌（TokenHasRestrictions，无 restricting SID）按 2026-10-16 修订放行；验证子进程内核 parent PID 等于 caller PID、线程属于该子进程，且原子进程 token 与 caller process token 经 NtCompareTokens 相等。随后创建新的同身份 deny-only token，保护其对象 DACL，设置该子进程的 ProcessAccessToken。失败或子进程已开始执行时拒绝赋值；不提供任意运行中进程的身份切换。
- 客户端只在 public create binding 的暂停窗口中调用 v3，限定 IPC 时间与长度，并读回实际子进程 token 的完整 deny-only 组集合；ACK 不能作为放行依据。任何 assignment / 回读错误都终止并关闭暂停子进程，不得调用 ResumeThread。fd 7 与 ConPTY 沿用同一公开 helper，未知创建 flag 形状在创建前 fail closed。
- broker 赋值 token 的对象 DACL 拒绝 group / privilege / default 调整及 descriptor 编辑；query、duplicate 与实际 impersonation 保留。TokenDefaultDacl 保留 caller 原值，避免把 token-specific 权限位写进 ambient 新对象的默认 ACL；普通 deny-only groups 自身不能通过 token narrowing 删除或恢复为 enabled。既有 owner / parent / protected-descendant、ConPTY / fd 7 合同不变。

本方案的 Windows 原生执行已验证；后续修改仍必须运行真实 token 赋值与拒写回归，结构检查和 macOS 跳过不能替代 Windows 证据。只修改该专用虚拟服务账户的固定权限集合，记录安装新增的 rights，升级 / 卸载及启动失败时仅撤销这次安装新增项，保留预存 account policy；不从其他系统进程获取 token；服务自身不能启用所需特权时 fail closed。

## Validation

现有九格矩阵、Node / pwsh / 后代、overwrite / delete / rename / ACL reset、protected DACL、ConPTY / fd 7、宿主写入与根权限变更回归全部保留。弱化 token 用例除 restricting-list 取交集外，再 disable 全部普通组，激活两种弱化 token 后真实写入；不以 API 失败或 broker ACK 代替写拒绝证据。安装生命周期用真实 LSA policy 回读验证安装、升级、卸载，保留预存服务权限及其他账户权限。安装生命周期用真实 LSA policy 回读验证安装、升级、卸载，保留预存服务权限及其他账户权限。全版本全平台执行只记录在[路线账本](../plans/active/2026-09-12-multi-root-workspace.md#b9附加根三态权限与跨-sandboxmode-执行一致性2026-10-13)。

## Alternatives Considered

- 继续调整 local attribute flags：已有多种 flag 读回正确但不匹配条件的证据，不能继续据此保证拒写。
- 铸造 UserClaims 再用条件 ACE：仍依赖条件求值与属性缺失时的 UNKNOWN 规则，增加不必要的 ABI 与防删除合同；普通 deny-only groups 已能表达每根拒绝。
- restricting SID、禁止 duplicate、改变全局模式：既有原生证伪或破坏需求，不恢复。

## Related Documents

- [ADR-0017：三态根权限](./ADR-0017-three-state-root-access-and-sandbox-modes.md)
- [B9 专项计划](../plans/completed/2026-10-13-b9-root-access-and-sandbox-modes.md)
- [Microsoft：CreateRestrictedToken](https://learn.microsoft.com/en-us/windows/win32/api/securitybaseapi/nf-securitybaseapi-createrestrictedtoken)
- [System Informer：NtCreateTokenEx ABI](https://github.com/winsiderss/phnt/blob/master/ntseapi.h)

## 安装与卸载

安装入口保持 `scripts/windows-broker/install.ps1 -UserSid <插件宿主用户SID>`，必须使用管理员 PowerShell；省略 UserSid 时使用当前用户，卸载加 `-Uninstall`。每用户稳定命名的服务账户与 pipe，安装目录和 executable 由管理员持有，宿主用户与虚拟服务账户仅获读取/执行。安装器的 `rights.cs` 随 tarball 提供，并作为打包必须项检查；broker 不提供修改 LSA policy 的请求。旧 LocalSystem 安装由同一入口停止并替换，协议 v1 客户端被新版拒绝，不能静默恢复裸进程。

## 已知边界（PR #12 评审记录）

- **deny 根的 delete→recreate 竞态**：deny ACE 写在文件系统对象上而非路径上，受拒根被删除并原地重建后，新目录不携带 deny ACE，deny-only 组 token 不再拒其写入。runner 在 ACL 整树写入前后各做一次 canonical 校验收窄窗口，但窗口不能归零。该窗口不在威胁模型内：受限子进程无法删除受拒根（父目录 `FILE_DELETE_CHILD` + 根自身 `DELETE`/`WRITE_DAC`/`WRITE_OWNER` deny），能删根的只有 ambient 权限进程——而 ambient 进程本就在本机制的防护范围之外。
- **broker 服务的可观测性**：pipe 监听失败时服务按有界节奏静默重试，诊断依赖 Windows 事件日志 / 服务状态；客户端侧只看到连接拒绝，错误文案已指向 broker 安装状态（`Windows read-only roots require the installed privileged broker`）。

## 协议容量与安装回滚修订（2026-10-15）

broker 的 v2/v3 拒写身份预算由 64 提升为 **256**，与注册表新增上限解耦；请求帧上限同步为 32768 个 ASCII 字节。客户端、服务、prefix 构造与 runner 启动共用同一容量合同，测试核对 C# 常量与最坏格式请求的帧长。合法的 64 个只读根加独立 home 共 65 项可完整传输；原生回归还覆盖 80 个历史存量根加 home，验证第一根、最后一根与 home 均拒写。

历史超限记录不删除、不截断，scope / fs 仍保留其授权语义；**Windows Full-access 新进程若需要超过 256 个拒写边界（包含 home），在构造 prefix 或 runner 改 ACL 前明确拒绝整次启动**，文案给出实际数量并要求减少登记限制。此限制是有界 IPC / 原生令牌构造的运行容量，不是新的注册表上限，也不是以缺失 deny 换取启动成功。原生系统的其他 token/ACL 前置条件仍可能拒绝启动，enforcement 维持 partial。

安装的 service create → 新增 LSA rights → staging JSON 写入 → 完整记录发布 → 启动/等待 Running 纳入同一回滚路径。staging 写入或发布失败也撤销这次新增的 rights，保留安装前的 rights；清理 staging / committed 记录与失败的服务。记录先完整写入 `.pending` 再移动到正式路径，避免半截 JSON 阻断未来卸载。原生 `verify-install.ps1` 分别注入记录写入、发布和服务启动失败，实际回读 LSA policy 与 SCM，随后重装、升级、卸载，继续检查预存权限和其他账户 policy。

## 过滤令牌放行与打包子进程诊断（2026-10-16，Windows 真机验证）

真机发现：原「拒绝 TokenHasRestrictions」规则把所有**非提权** UAC 管理员 runner 挡在门外——UAC 管理员的普通（filtered）token 本身 TokenHasRestrictions=1，每条非提权命令都被 `Caller process must be an unrestricted installation identity` 拒绝。CI 全程提权、无 UAC 过滤，从未触发该路径。

**新调用方验收规则**（经用户定案）：拒绝 `IsTokenRestricted`（restricting SID / write-restricted）与 `TokenIsAppContainer`（class 29），接受 `TokenHasRestrictions`（class 21）——三类拒绝各自报独立文案。`MintDenyToken` 同步去掉 class 21 条件、保留 class 29。

**为何放行不扩权**：minted token 逐字段镜像调用方——groups 按原属性逐位复制（deny-only 的 Administrators 仍是 deny-only）、privileges、mandatory label、auth id 与 session 全部照搬；从 filtered caller 铸出的 token 不拥有调用方之外的任何权力。remint 同样镜像既有 deny-only groups：受限子进程请求再铸币时新 token 仍携带原 deny 边界（原生回归已断言 deny-only 组保留且模拟写仍被拒）。

**残余风险（已接受）**：SYSTEM 服务现在对安装用户的 medium-IL 进程可达——但标准用户本就可达该服务，UAC 也不是安全边界；输入仍有界且经正则校验。

**兼容性损失（已接受）**：minted token 不携带 filtered 源的 linked token 与虚拟化标志，子进程失去「以提权副本自居」的语义——这正是本机制想要的。

**打包子进程**：MSIX 激活给子进程 token 写入包身份 security attributes，`NtCompareTokens` 必然返回不等（minted token 不镜像这些 claims）。真机确认 `%LOCALAPPDATA%\Microsoft\WindowsApps\pwsh.exe` 别名**与** `C:\Program Files\WindowsApps\<包全名>\pwsh.exe` 真实 exe 同样走打包激活（候选 A「直接执行包内 exe」被证伪）。赋值仍 fail-closed，但 runner 在 `assign` 回调起始处用 kernel32 `GetPackageFullName` 结构探测（122=已打包、15700=非打包、其他错误码同样拒绝），对打包子进程给出可操作诊断：安装 MSI/ZIP 版 PowerShell 并把非打包可执行文件排在 WindowsApps 别名之前。本地验证用 `%TEMP%\pwsh-portable\pwsh.exe`（zip 解压版）可通过全链路。

**残余（真机发现，未修改）**：

- 属主残余：deny 遍历要求每个路径归调用方所有；提权会话创建的路径属主为 BUILTIN\Administrators（filtered token 仅 deny-only 持有），此类路径作为只读根或位于 `$DSH_HOME` 内时，非提权受限 Full-access 启动 fail-closed 报 `deny ACL requires caller-owned path`，须先 `icacls <path> /setowner <user> /T` 修正属主。
- pnpm 硬链接残余：`$DSH_HOME` profile `node_modules` 是全局 store 的硬链接，共享同一安全描述符，deny ACE 会写到 store 文件及其全部链接；store 文件由提权安装创建时遍历直接 fail-closed。跳过硬链接不安全（文件内容写由文件自身 ACL 约束）。该开放决策已由下方「全根硬链接预检」（C1，fail-closed 预检）与「Profile 硬链接隔离命令」（C2，copy 迁移工具）两节落地结案。

## 祖先路径钉住与 Job 排空（2026-10-16，Phase B 实机验证）

deny ACE 写在文件对象上、随目录改名迁移，但登记的规范拼写不会跟着走：受限子进程把任一祖先目录改名后，受保护子树整体落到一个**新路径**——内核仍凭迁移过去的 ACE 拒绝受限 token 的写，但宿主 fs fence 按 recorded deny 集的路径拼写匹配，新路径下的对象不再被其覆盖，宿主 fs 工具即可对原只读树写入（shell→宿主新路径缺口，R1 的实际形态）。单靠对象 ACL 无法表达「路径不可搬走」，因此 ambient deny runner 为每个 deny 根钉住从卷根到根本身的完整祖先链（`src/compat/windows-path-guard.ts`、`src/windows-deny.ts`）。

- 机制：每个祖先目录持有一个 GENERIC_READ + 读/写共享（不含 delete sharing）的常驻句柄。实机探测确认 FILE_READ_ATTRIBUTES 的属性级句柄不参与删除共享门——既不阻塞改名、也不被冲突句柄阻塞——钉住必须使用验证过的数据读访问。共享读写下普通读取、写入与兄弟文件创建不受影响；整条祖先链（含 `C:\`、用户目录）不写入任何持久 ACL，句柄释放即还原。
- 同句柄校验：必须为目录、非重解析点、`HANDLE_FLAG_INHERIT` 清零（受限子进程不能用继承到的句柄 `CloseHandle` 解除钉住），`GetFinalPathNameByHandleW` 的内核规范 DOS 名必须等于预期拼写（拒绝 UNC / 设备落点）。任一步失败按逆序关闭全部已持有句柄并拒绝启动；启动前已存在不兼容共享句柄（如 DELETE 独占）的祖先同样使获取失败，先于任何 token 请求与子进程启动。
- 生命周期：钉住在 token 请求与 ACL 编辑之前建立；`waitForProcessExit` 只覆盖直接子进程，其退出后 runner 先 `TerminateJobObject(job, 127)` 再轮询 `QueryInformationJobObject(JobObjectBasicAccountingInformation)` 的 `ActiveProcesses` 至零（不设超时），随后才关闭 Job 句柄、token，最后释放钉住——退出子进程拉起的后代不会带着受限 token 活到钉住窗口之外。
- 残余边界：`TerminateJobObject` / `QueryInformationJobObject` API 失败与 runner 进程被强制终止同属异常清理路径——钉住句柄随清理或进程消亡，后代由 Job 的 kill-on-close 兜底，不再承诺钉住顺序保护。deny 根本身的 delete→recreate 竞态不变（见「已知边界」）。
- 证据：`windows-native.e2e.ts`「ancestor guard」组（真实受限子进程 rename 父/祖父目录被拒、宿主 fs 对原拼写仍拒写、排空后代不可写逃逸标记、ConPTY 终止后释放、预占 DELETE 句柄使发布版 runner 在 spawn 前拒绝）与 adapter 的 mocked Job 排空时序；第二固定驱动器用例因本机无第二盘跳过，未在本地验证。证据数字见[路线账本](../plans/active/2026-09-12-multi-root-workspace.md#分支安全审查修复2026-10-16进行中)「分支安全审查修复」节。

## 全根硬链接预检与身份复核（2026-10-16，Phase C1 实机验证）

**威胁模型（R4）**：deny ACE 写在文件对象上——硬链接文件的全部名字共享同一对象，对其中一条名字 `SetSecurityInfo` 会同时改写树内外每一条链接的访问判定。pnpm 全局 store 与 `$DSH_HOME` profile 的 `node_modules` 正是跨项目硬链接：此前按字典序 `lstat` 边走边写，发现硬链接之前已把 deny 写进 store 对象，属于先污染后检测。此外 profile 目录可能包含 OWNER RIGHTS / owner 合并 ACE，副作用不限于 deny 组。

**决定**：`src/compat/windows-deny-preflight.ts` 在 runner 钉住祖先之后、任何 token 请求 / ACL 编辑 / 锁工作之前，对**全部** deny 根递归做只读预检（FILE_READ_ATTRIBUTES + 全共享打开，读 BY_HANDLE_FILE_INFORMATION 后即在下行前关闭检查句柄）。任一节点打开 / 类型 / 身份 / 目录列出失败——含扫描句柄自身关闭失败——都使整个启动在零副作用点拒绝；失败信息同时携带根与路径。任一普通文件 `links > 1` 立即拒绝并报出根、路径、link 计数、种类（protected DSH home 或登记根）与修复指引（home 指向挂起的 `/workspace-folders isolate-profiles` 隔离命令；用户根要求建立独立副本）。nlink>1 一律拒绝是刻意的保守——快照无法证明全部链接都在树内，也不试图证明；不跳过 `node_modules`，不做全局 ACL 重置。

**身份复核**：ACL 遍历改为消费预检快照（按深度优先插入序），目录 / 重解析位由快照决定而不信即时 `lstat` 迁移；写目录继承 ACE 之前先比对即时 `readdir` 名单与快照名单（新增 / 缺失都失败）。`protect` 在同一把即将修改 ACL 的活句柄上复核 `verifyHandle`——属性位、卷序列、文件索引、普通文件 link 计数任一变化即拒。根父目录守卫位于被拒绝树之外、无快照：仅此调用豁免 `verifyContent`，且不启用 OICI 继承。重解析点记录快照并只对重解析对象本身写 deny，绝不下降到外部目标。

**限制与竞态**：这不是事务——预检（及逐句柄复核）之后、写之前的恶意并发外部修改仍可能竞过；零副作用保证只覆盖「预检失败」情形，不承诺所有竞态都只影响树外 ACL。快照把替换攻击窗口从「扫描到写之间任意时刻」收窄到「复核到写之间」；更强保证需另案验证。

**残留边界不变**：`$DSH_HOME` 的 profile 硬链接 remediation 待 C2 隔离命令落地；预检失败的启动 127 不接触任何 ACL，成功路径照旧保留持久 deny 组 ACE。

**证据**：`windows-native.e2e.ts`「hardlink preflight」组（深层硬链接 / 末根硬链接首根零变化 / 同树双名 / protected home 标签 / 不可读文件 / junction 目标未触碰 / 独立副本成功且外部原件不变，全部以 SDDL 快照比对）；adapter mocked 接缝覆盖身份变化、link 计数变化、打开 / 读 / 列出失败与清理错误聚合；数字见路线账本「分支安全审查修复」节。

## Profile 硬链接隔离命令（2026-10-16，Phase C2 落地）

**决定**：`/workspace-folders isolate-profiles` 作为宿主侧维护命令落地（`src/profile-isolation.ts` + `src/command.ts`），面板不加端点——它是配置迁移工具，不是根管理面。默认**只读检查**，`--apply` 才迁移配置；多链接文件若在受保护 home 仍残留，检查输出直接给出退出宿主、删 `node_modules`、按 lockfile 重装的步骤。

- **profile 判定保守**：只认 `profiles/` 下真实目录、`package.json` 可解析为对象且 `dsh.profile` 为对象的条目；重解析点与普通文件只枚举、不落笔，对重解析点绝不下降。
- **YAML 是严格子集扫描器而非解析器**（运行期依赖预算不含 yaml 包）：拒绝缩进 tab、`%` / `---` / `...` 指令、重复顶层键与所有非 `key:` 形式的顶层行；`&` `*` `!` `|` `>` `{` `[` 起始的值记为 complex。标量按原始 span 原地替换，注释、引号风格与 CRLF/LF 行尾保留；缺失文件用上游 `initProfile` 同款模板加 `packageImportMethod: copy` 补齐。复杂值 / 冲突 / 不可读一律 refused，不猜写。
- **写入一律原子**：先写 `pnpm-workspace.yaml.mrw-<pid>.tmp` 再 rename 就位，失败保留原文件；目标文件本身是重解析点或非普通文件时拒绝写穿。
- **整 home 扫描而非只看 `profiles/*/node_modules`**：`nlink > 1` 是文件对象属性，pnpm 硬链接可能出现在 profile 之外（store、共享缓存），局部扫描必然漏报；任一子树不可读时结论为 incomplete，不报干净。
- **残留边界照旧显式声明**：设置 copy 不隔离既有依赖——硬链接在重装前仍是硬链接；copy 不修复 Administrators 属主路径，也不撤销此前可能已写到 store / 其他项目的 deny ACE（没有自动 reset，属人工评审项）；命令之后新建的 profile 需要同一配置或重新检查。
- **冒烟**：`scripts/lib/dsh-runtime.mjs` 的 `ensureProfileCopyImport` 在首个 `dsh plugin add` 之前给冒烟 profile 写 copy（journey / compose / behavior 正向）；`smoke-behavior` 另建一个保持默认硬链接的 scratch profile，以真实 runner 断言退出 127 + 硬链接拒绝文案 + 子进程未运行（负向，真实预检拒绝而非断言跳过）。预检拒绝发生在 pin / token 请求 / ACL 编辑之前，无需 broker 或提权即可回归；CI 非提权 lane 未新增（GitHub Windows runner 全程提权，另起非提权进程需要第二账户，记入路线账本 defer）。
