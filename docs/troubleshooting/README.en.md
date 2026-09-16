# Troubleshooting

中文：[README.md](./README.md)

## What Belongs Here

Verified problem-solving experience with recurring value. Each entry typically includes:

- Symptoms;
- Root cause;
- Diagnostics;
- Verified solution.

## What Does Not Belong Here

Do not log every one-off error.

Only issues that are expected to recur and are costly to diagnose are worth recording.

## Current State

- [Client bundle missing from the web boot graph: bundle patch mounts only subpath rows](./client-bundle-not-in-boot-graph.md) (Chinese) — root cause and fix for the silently absent footer slot registration.
- [Panel reports "cannot connect to the dsh main process" (HTTP 405)](./panel-channel-http-405.md) (Chinese) — root cause and fix for the channel registration silently swallowed by cordis service resolution.
- [Root registry owned by another DSH process](./registry-owned-by-another-process.md) (Chinese) — fail-closed lease when two processes share `$DSH_HOME`, and how the waiter takes over.
- [The installed DSH release is not on the support matrix](./unsupported-dsh-release.md) (Chinese) — the `unsupported` / `mixed` / `incomplete` verdicts, why the providers then never start, and the manual process for promoting a new release.
- [The install stops at build approval](./install-stops-at-build-approval.md) (Chinese) — why the first `dsh plugin add` fails on `koffi`'s build script, and how to answer the one `allowBuilds` decision it leaves behind.

## Naming Convention

Use lowercase kebab-case, for example:

```text
<symptom-or-topic>.md
```
