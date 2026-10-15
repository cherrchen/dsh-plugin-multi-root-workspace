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

## Decision (2026-10-16, approved)

- **Candidate A refuted**: the real exe `C:\Program Files\WindowsApps\Microsoft.PowerShell_7.6.7.0_x64__8wekyb3d8bbwe\pwsh.exe` still activates packaged on the real machine — the child carries a package identity, `NtCompareTokens` reports unequal, same `Child identity does not match its caller` (exit 127). Bypassing the alias to run the in-package exe does not strip the package identity.
- **Adopted: fail-closed with an actionable diagnostic.** The `assign` callback in `src/windows-deny.ts` probes the child with kernel32 `GetPackageFullName` first (`ERROR_INSUFFICIENT_BUFFER` = 122 → packaged: read the package full name and throw the diagnostic; `APPMODEL_ERROR_NO_PACKAGE` = 15700 → proceed; any other code → refuse). The message tells the user to install the MSI/ZIP build of PowerShell, or to put a non-packaged executable ahead of the WindowsApps alias on PATH; the suspended child is terminated and the runner exits 127 with a `windows-acl-run:` stderr prefix.
- **Still not viable**: loosening the broker's `NtCompareTokens` check (it would break the fail-closed identity boundary).
- Related surface: `workspace-write` / `read-only` go through upstream `AclSandbox`, which creates the child directly with the restricted token and does no compare — packaged children run there, and whether their capability SIDs widen ambient grants is upstream semantics, separate from this broker path; the deny-only group ACEs still deny.

## Second real-machine finding: UAC filtered tokens (2026-10-16)

The broker originally rejected callers with `TokenHasRestrictions` (GetTokenInformation class 21), which locked out **every non-elevated UAC admin runner** behind `Caller process must be an unrestricted installation identity` — CI runs elevated with no UAC filtering, so it never saw this. The approved rule: refuse `IsTokenRestricted` (restricting SIDs / write-restricted; message `Caller process token carries restricting SIDs`) and `TokenIsAppContainer` (class 29; `AppContainer caller unsupported`); `MintDenyToken` drops the class-21 condition likewise. The minted token copies the caller's groups verbatim (deny-only stays deny-only), privileges, label, auth id and session — no authority is gained. Accepted compatibility loss: the minted token carries no linked token and no virtualization flag. See the [ADR-0020 revision](../../docs/decisions/ADR-0020-windows-normal-deny-groups.md). **After upgrading, the broker must be reinstalled with `install.ps1`** to pick up the new caller rule.

## Local verification notes (2026-10-16)

- **Put a non-packaged pwsh first on PATH**: the zip build `%TEMP%\pwsh-portable\pwsh.exe` passes the full path (`denied:UnauthorizedAccessException`); the MSI build `C:\Program Files\PowerShell\7\pwsh.exe` works the same.
- **Elevated vs non-elevated**: elevated runs create Administrators-owned directories, which makes `tests/working-directory.e2e.ts` and the journey "pwsh saw the other repository's diff" fail on git `dubious ownership` — run those **non-elevated**. The broker install and the native e2e need elevation; after `install.ps1`, a non-elevated runner works through the broker (that is exactly the scenario this change unblocks).
- Reproducing the old symptom: `lib/windows-runner.js --mode danger-full-access --deny-root <dir> -- %LOCALAPPDATA%\Microsoft\WindowsApps\pwsh.exe -NoProfile -Command "..."` → 127 plus the `packaged (MSIX/Microsoft Store)` diagnostic; `node.exe` or portable pwsh passes.

## Residual findings (2026-10-16, unchanged)

- **Ownership residual**: the deny walk requires every path to be caller-owned. Paths created by an elevated session are owned by BUILTIN\Administrators, which a filtered token holds deny-only; when such a path is a read-only root or lies inside `$DSH_HOME`, a non-elevated restricted Full-access launch fails closed with `deny ACL requires caller-owned path` and stays unusable until the owner is fixed (`icacls <path> /setowner <user> /T`).
- **pnpm hardlink residual**: the `node_modules` files under a `$DSH_HOME` profile are hardlinks into pnpm's global store, sharing one security descriptor with other projects, so the `$DSH_HOME` deny walk writes its standing deny ACE onto the store file and every link of it; when the store file was created by an elevated install the walk fails closed (this is why non-elevated `smoke:packed` skips one windows-acl assertion). Verified with `fsutil hardlink list` across projects. Skipping hardlinks is not safe: file-content writes are governed by the file's own ACL, so a skipped link would let a confined child modify plugin code in `$DSH_HOME`. Left as an open decision.

## Reproduction notes

- In elevated `pwsh` (`Start-Process -Verb RunAs`) run `lib/windows-runner.js --mode danger-full-access --deny-root <dir> -- pwsh.exe -NoProfile -Command "..."`: fails through the alias; swapping `pwsh.exe` for `node.exe` or the MSI path passes.
- The broker must first be installed elevated via `scripts/windows-broker/install.ps1`; `verify-install.ps1` covers the full lifecycle.
