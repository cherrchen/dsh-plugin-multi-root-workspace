# Security Policy

中文：[SECURITY.md](./SECURITY.md)

## Supported versions

The plugin ships against the [exact DSH support matrix](./README.en.md#requirements). Security fixes go to the latest release only; upgrade before reporting an issue on an older release. Pre-release versions do not carry a separate security-support promise, so reproduce on the latest stable release. Release state is recorded in the [CHANGELOG](./CHANGELOG.en.md).

## Reporting a vulnerability

Use GitHub's private vulnerability reporting:

https://github.com/cherrchen/dsh-plugin-multi-root-workspace/security/advisories/new

Do not disclose an unfixed vulnerability through a public issue, pull request, discussion, or social media. If the private-report entry point is unavailable, contact the maintainer privately through the contact details on their GitHub profile, and do not send exploit details until you receive confirmation.

Please include, as far as possible:

- the affected plugin version and installation source (npm / tarball / GitHub / source);
- the exact DSH release, operating system, and sandbox mode;
- the number of additional roots and their access levels (inherit / read-only / read-write);
- the impact and the attack prerequisites (local user, malicious workspace, malicious plugin, and so on);
- minimal reproduction steps or a proof of concept;
- relevant logs, with credentials, tokens, and private paths removed;
- whether the issue is already public, your preferred disclosure date, and how you want to be credited.

## Process

- We aim to acknowledge a report within 7 days. This is a target, not a service-level agreement.
- After triage we provide an impact assessment and a fix plan or mitigation; the fix timeline depends on severity and complexity.
- We coordinate disclosure after a fix ships, or 90 days after the report, whichever comes first. Earlier or later disclosure can be negotiated.
- We credit reporters in the security advisory unless anonymity is requested.
- This repository does not offer a bug bounty.

## Scope

### In scope

- **Additional-root boundary bypass**: native fs, bash / PTY, LSP, workspaceFiles, Skills, or document preview reading or writing outside an additional root without authorization.
- **Root registration and authorization**: symlinks, renames, path canonicalization, protected directories, cross-primary contamination, Registry store tampering, cross-host lease or IPC impersonation, and panel session-derived authority bypass.
- **Process-fence and unadmitted-spawn bypass**.
- **Instruction or Skill injection across a root boundary**, or user context becoming system authority.
- **Composition or patch defects** that widen authorization with zero additional roots or under a foreign provider.
- **Credential or secret exposure** through plugin logs, the panel, or transport.
- **Write-fence or authorization bypass** after Auto Review or OPS compatibility mode is enabled.

### Out of scope

- Vulnerabilities in upstream `deepseek-harness`; report them upstream. Tell us as well if this plugin amplifies the impact.
- Vulnerabilities in dependencies (`zod`, `clsx`, `koffi`, DSH packages, and so on); report them to their maintainers and tell us the affected versions.
- Issues that require an attacker to already control the local user account, `$DSH_HOME`, the profile, or installed plugin code.
- The broad write access expected under `danger-full-access`. A read-only additional root is a write restriction, not read confinement (see [ADR-0017](./docs/decisions/ADR-0017-three-state-root-access-and-sandbox-modes.md)).
- Documented limitations and accepted risks (below).
- Vulnerabilities in third-party plugins or bundles.
- Local-only denial of service through resource exhaustion, unless it can be triggered remotely or crosses an authorization boundary.
- Social engineering, physical access, or supply-chain attacks, unless this repository's build or release pipeline can be exploited.

### Known and accepted risks

- **Root management has no trusted human confirmation independent of the owner cookie (BYP-01)**: upstream provides no such confirmation channel, so a same-user process that forges the owner cookie may still register roots. This risk remains; see the [root-authorization security plan](./docs/plans/completed/2026-11-05-root-authorization-security-fixes.md).
- **Full access is broadly writable by design**: only explicit deny boundaries remain under `danger-full-access`; do not use it with an untrusted workspace.
- **A read-only root is not read isolation**: `--read-only` refuses writes and does not restrict reads.
- **Third-party processes are outside the fence guarantee**: the plugin constrains its own tools and the launch paths it wraps, not processes started directly by other plugins.
- **Auto Review and OPS compatibility mode are experimental and off by default**: their protections exist only when enabled, and disabling the OPS adaptation restores the old behavior, which may allow OPS to write to an explicitly read-only additional root.
- **Multi-host sharing is limited to the same machine, user, and lock namespace**; it makes no isolation promise across users or machines.

## Security research

- Test only in environments you own or are explicitly authorized to test.
- Do not access, modify, delete, or exfiltrate other people's data; do not conduct denial-of-service, social-engineering, or physical attacks.
- Give the maintainer reasonable time to fix the issue before disclosing details.
- Good-faith research will not be pursued; follow applicable law.

## Related documents

- [Architecture](./docs/architecture/README.en.md)
- [Decision records (ADRs)](./docs/decisions/README.md)
- [Known limitations](./README.en.md#known-limitations)
- [Root-authorization security plan](./docs/plans/completed/2026-11-05-root-authorization-security-fixes.md)
