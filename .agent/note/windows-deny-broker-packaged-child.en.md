# Windows deny broker: packaged-app (MSIX alias) child token mismatch

Platform trap found during B9 real-machine verification: under `danger-full-access` with explicit `read-only` roots, a child binary resolved through an MSIX execution alias (Store `pwsh.exe`) trips the broker's `AssignToChild` identity check, which fails closed and the runner exits 127.

## Symptoms

- `pnpm smoke:behavior` / `smoke:journey` / `smoke:packed` all fail inside `ambientBattery` with:
  `windows-acl-run: deny-token assignment refused: ERROR:UnauthorizedAccessException:Child identity does not match its caller`
- In the same process the v2 mint (`requestDenyToken`) already succeeded, and the parentage checks (`ParentId`, thread ownership) pass too — only `NtCompareTokens(callerToken, childToken)` reports inequality.
- `pnpm kernel:probe` and `tests/windows-native.e2e.ts` (child = `node.exe`) are unaffected.

## Root cause

On this host `pwsh` resolves to `%LOCALAPPDATA%\Microsoft\WindowsApps\pwsh.exe` — the **app execution alias** reparse point of the Microsoft Store PowerShell package. When `CreateProcessAsUserW` targets that alias, Windows activates the process as a packaged app and stamps package-identity security attributes into the child token, so it no longer equals the caller token field-for-field.

`NtCompareTokens` (in `AssignToChild`, `scripts/windows-broker/service.cs`) compares the full kernel-visible identity; the packaged attributes are enough to make it return unequal, and the broker refuses to assign the minted deny token. **This is the check failing closed by design, not a broker false positive.**

Measured evidence (elevated; runner spawned both ways × two child binaries):

| runner spawn | child | result |
| --- | --- | --- |
| `spawn()` (e2e path) | `node.exe` | OK, `denied:EPERM` |
| `spawnCurrentTokenJobProcess` (LocalSubprocess path) | `node.exe` | OK |
| either | `pwsh.exe` (alias) | 127, `Child identity does not match its caller` |

Per-field token dump (user / 15 groups / IL / AuthId / elevation type / hasRestrictions / AppContainer count / mandatory policy) looks identical, yet compare reports 0 — the difference lives in the security attributes written by packaged activation.

## Code involved

- `src/windows-deny.ts`: the `spawnWindowsDeniedChild` activation wrapper swaps `createProcessAsUserW`'s token for `sourceToken` (the runner's own `currentToken`), so the child is born with a faithful copy of the caller token before the broker validates it and installs the minted token.
- `src/compat/windows-native.ts`: suspended-create plus the fd-7 STARTUPINFO adaptation.
- `scripts/windows-broker/service.cs` `AssignToChild`: `DuplicateHandle` → parentage checks → `NtCompareTokens` → `MintDenyToken` → `NtSetInformationProcess(ProcessAccessToken)`.

## Fix directions (undecided)

- Candidate A: in the runner, when `argv[0]` resolves to an app-exec-alias reparse point, resolve the real exe inside the package (`C:\Program Files\WindowsApps\<PackageFullName>\<exe>`) and pass it as `applicationName` — the child is then created unpackaged and the token compares equal. The real exe is confirmed present (`Test-Path` = true); **not yet verified**: whether a normal/restricted token can execute from inside `WindowsApps`, and whether bypassing alias activation has side effects.
- Candidate B: fix only the verification environment — use the MSI `pwsh` (`C:\Program Files\PowerShell\7\pwsh.exe`) on CI/verification hosts. Unblocks the current failure, but real users with Store pwsh hit the same wall.
- Not viable: loosening the broker comparison — it would break the fail-closed identity boundary and is explicitly disallowed just to make smoke pass.
- Related surface: `workspace-write` / `read-only` go through upstream `AclSandbox`, which creates the child directly with the restricted token and does no compare — packaged children run there, and whether their capability SIDs widen ambient grants is upstream semantics, separate from this broker path; the deny-only group ACEs still deny.

## Reproduction notes

- In elevated `pwsh` (`Start-Process -Verb RunAs`) run `lib/windows-runner.js --mode danger-full-access --deny-root <dir> -- pwsh.exe -NoProfile -Command "..."`: fails through the alias; swapping `pwsh.exe` for `node.exe` or the MSI path passes.
- The broker must first be installed elevated via `scripts/windows-broker/install.ps1`; `verify-install.ps1` covers the full lifecycle.
