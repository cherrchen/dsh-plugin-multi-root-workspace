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

## Naming Convention

Use lowercase kebab-case, for example:

```text
<symptom-or-topic>.md
```
