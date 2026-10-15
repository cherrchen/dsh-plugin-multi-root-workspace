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

## 修复方向（未定）

- 候选 A：runner 在 `argv[0]` 解析到 app-exec-alias 重解析点时，解析出包内真实 exe（`C:\Program Files\WindowsApps\<PackageFullName>\<exe>`）并以其为 `applicationName` 创建——子进程非打包激活，令牌忠实。已确认真实 exe 存在（`Test-Path` = true）；**尚未验证**：普通/受限令牌能否从 WindowsApps 内执行、以及跳过别名激活是否有副作用。
- 候选 B：仅修验证环境——CI/验证机用 MSI 版 `pwsh`（`C:\Program Files\PowerShell\7\pwsh.exe`）。能解当前阻塞，但 Store 版 pwsh 用户的真实配置仍会撞同一墙。
- 不可行：放宽 broker 的比较（会破坏 fail-closed 身份边界，且 summary 明确禁止为跑通冒烟而削弱校验）。
- 关联面：`workspace-write`/`read-only` 走 upstream `AclSandbox` 直接以受限令牌创建，无 compare——打包子进程能跑，但其令牌携带的包能力 SID 是否拓宽 ambient 授权属上游语义，与本 broker 路径无关；deny-only 组的 deny ACE 仍然生效。

## 复现要点

- 提权 `pwsh`（`Start-Process -Verb RunAs`）里跑 `lib/windows-runner.js --mode danger-full-access --deny-root <dir> -- pwsh.exe -NoProfile -Command "..."`：别名解析即失败；把 `pwsh.exe` 换成 `node.exe` 或 MSI 路径即通过。
- broker 需先经 `scripts/windows-broker/install.ps1` 提权安装，`verify-install.ps1` 走完整生命周期。
