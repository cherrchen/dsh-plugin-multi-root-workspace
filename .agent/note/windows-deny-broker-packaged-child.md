# Windows deny broker：打包应用（MSIX 别名）子进程令牌不一致

B9 验证期间在实机发现的平台陷阱：`danger-full-access` + 显式 `read-only` 根时，子进程二进制若经 MSIX 执行别名解析（Store 版 `pwsh.exe`），broker 的 `AssignToChild` 身份校验 fail-closed，runner 退出 127。

## 症状

- `pnpm smoke:behavior` / `smoke:journey` / `smoke:packed` 在 `ambientBattery` 全部失败：
  `windows-acl-run: deny-token assignment refused: ERROR:UnauthorizedAccessException:Child identity does not match its caller`
- 同一进程里 v2（`requestDenyToken` 铸币）已通过、父系校验（`ParentId`/线程归属）也通过——只有 `NtCompareTokens(callerToken, childToken)` 返回不等。
- `pnpm kernel:probe` 与 `tests/windows-native.e2e.ts`（子进程 = `node.exe`）不受影响。

## 根本原因

主机上 `pwsh` 解析到 `%LOCALAPPDATA%\Microsoft\WindowsApps\pwsh.exe`——Microsoft Store 版 PowerShell 的 **app execution alias** 重解析点。`CreateProcessAsUserW` 对该别名创建进程时，Windows 走打包应用激活路径，给子进程令牌加上包身份安全属性（security attributes），产出的令牌与 caller 令牌**不再逐字段相等**。

`NtCompareTokens`（`scripts/windows-broker/service.cs` `AssignToChild`）按内核语义比较全部属性，打包属性足够令其返回不等 → broker 拒绝赋值 minted deny 令牌。**这是校验按设计 fail-closed，不是 broker 误判。**

实测证据（提权，runner 两种生成方式 × 子进程两种二进制）：

| runner 生成方式 | 子进程 | 结果 |
| --- | --- | --- |
| `spawn()`（e2e 路径） | `node.exe` | OK，`denied:EPERM` |
| `spawnCurrentTokenJobProcess`（LocalSubprocess 路径） | `node.exe` | OK |
| 任一 | `pwsh.exe`（别名） | 127，`Child identity does not match its caller` |

令牌逐项 dump（user/15 组/IL/AuthId/elevType/hasRestrictions/AppContainer#/mandatoryPolicy）表面完全一致但 compare=0——差异在打包激活写入的 security attributes 里。

## 涉及代码

- `src/windows-deny.ts`：`spawnWindowsDeniedChild` 的 activation 包装把 `createProcessAsUserW` 的令牌替换成 `sourceToken`（runner 自己的 `currentToken`），保证出生时令牌是 caller 的忠实副本，再由 broker 校验并换上 minted 令牌。
- `src/compat/windows-native.ts`：悬挂创建 + fd7 STARTUPINFO 适配。
- `scripts/windows-broker/service.cs` `AssignToChild`：`DuplicateHandle` → 父系校验 → `NtCompareTokens` → `MintDenyToken` → `NtSetInformationProcess(ProcessAccessToken)`。

## 定案（2026-10-16，用户批准）

- **候选 A 已证伪**：`C:\Program Files\WindowsApps\Microsoft.PowerShell_7.6.7.0_x64__8wekyb3d8bbwe\pwsh.exe` 真机实测仍走打包激活——子进程携带包身份，`NtCompareTokens` 不等，同样 `Child identity does not match its caller`（exit 127）。绕过别名直接执行包内 exe 不能去掉包身份。
- **采纳：fail-closed + 可操作诊断**。`src/windows-deny.ts` 的 `assign` 回调先用 kernel32 `GetPackageFullName` 探测子进程（`ERROR_INSUFFICIENT_BUFFER`=122 → 打包，读出包全名抛出诊断；`APPMODEL_ERROR_NO_PACKAGE`=15700 → 放行；其他码 → 抛错拒绝）。文案指引安装 MSI/ZIP 版 PowerShell 或把非打包可执行文件排在 WindowsApps 别名前；挂起子进程被终止，runner 退出 127，stderr 前缀 `windows-acl-run:`。
- **不可行维持**：放宽 broker 的 `NtCompareTokens` 比较仍被禁止（破坏 fail-closed 身份边界）。
- 关联面：`workspace-write`/`read-only` 走 upstream `AclSandbox` 直接以受限令牌创建，无 compare——打包子进程能跑，但其令牌携带的包能力 SID 是否拓宽 ambient 授权属上游语义，与本 broker 路径无关；deny-only 组的 deny ACE 仍然生效。

## 另一真机发现：UAC 过滤令牌（2026-10-16）

原 broker 以 `TokenHasRestrictions`（GetTokenInformation class 21）拒绝调用方，把**一切非提权 UAC 管理员 runner** 挡在 `Caller process must be an unrestricted installation identity`——CI 全程提权、无 UAC 过滤，从未踩到。已定案放行：broker 只拒绝 `IsTokenRestricted`（restricting SID / write-restricted，文案 `Caller process token carries restricting SIDs`）与 `TokenIsAppContainer`（class 29，文案 `AppContainer caller unsupported`），`MintDenyToken` 同步去掉 class 21 条件。minted token 逐位镜像调用方 groups（deny-only 保持 deny-only）/privileges/label/auth id/session，放行不扩权；兼容性损失是 minted token 不带 linked token 与虚拟化标志。详见 [ADR-0020 修订节](../../docs/decisions/ADR-0020-windows-normal-deny-groups.md)。**升级后必须用 `install.ps1` 重装 broker** 才会换上新的调用方规则。

## 本地验证要点（2026-10-16）

- **非打包 pwsh 放 PATH 最前**：zip 便携版 `%TEMP%\pwsh-portable\pwsh.exe` 实测可走通全链路（`denied:UnauthorizedAccessException`）；MSI 版 `C:\Program Files\PowerShell\7\pwsh.exe` 同理。
- **提权 vs 非提权**：提权运行会以 Administrators 属主创建目录，使 `tests/working-directory.e2e.ts` 与 journey 的「pwsh 看到另一仓库 diff」在 git `dubious ownership` 上失败——这两个用例要在**非提权** shell 跑。反过来 broker 安装与原生 e2e 需提权；`install.ps1` 安装后非提权 runner 也能正常走 broker（这正是本次放行的场景）。
- 复现旧症状：`lib/windows-runner.js --mode danger-full-access --deny-root <dir> -- %LOCALAPPDATA%\Microsoft\WindowsApps\pwsh.exe -NoProfile -Command "..."` → 127 + `packaged (MSIX/Microsoft Store)` 诊断；换 `node.exe` 或便携 pwsh 即通过。

## 残余发现（2026-10-16，未修改）

- **属主残余**：deny 遍历要求每个路径归调用方所有。提权会话创建的路径属主为 BUILTIN\Administrators，filtered token 仅以 deny-only 持有该组；此类路径作为只读根或位于 `$DSH_HOME` 内时，非提权受限 Full-access 启动 fail-closed 报 `deny ACL requires caller-owned path`，须 `icacls <path> /setowner <user> /T` 修正属主后才可用。
- **pnpm 硬链接残余**：`$DSH_HOME` profile 的 `node_modules` 文件是 pnpm 全局 store 的硬链接（与其他项目共享同一安全描述符），`$DSH_HOME` 的 deny 遍历会把 deny ACE 写到 store 文件及其全部链接上；store 文件由提权安装创建时遍历直接 fail-closed（非提权 `smoke:packed` 因此跳过一条 windows-acl 断言）。已用 `fsutil hardlink list` 证实跨项目共享。跳过硬链接不安全：文件内容写由文件自身 ACL 约束，跳过的链接会让受限子进程改动 `$DSH_HOME` 插件代码。留作开放决策。

## 复现要点

- 提权 `pwsh`（`Start-Process -Verb RunAs`）里跑 `lib/windows-runner.js --mode danger-full-access --deny-root <dir> -- pwsh.exe -NoProfile -Command "..."`：别名解析即失败；把 `pwsh.exe` 换成 `node.exe` 或 MSI 路径即通过。
- broker 需先经 `scripts/windows-broker/install.ps1` 提权安装，`verify-install.ps1` 走完整生命周期。
