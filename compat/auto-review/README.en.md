# Multi-root Auto Review companion

中文：[README.md](./README.md)

This optional companion targets DSH `0.2.1-rc.2` with Multi-root Workspace `0.1.8`. Explicitly select the official Auto Review and Multi-root bundles first. Ordinary Multi-root installation does not enable Auto.

Stop the target profile before configuring it. Explicitly select official Auto Review and Multi-root, then install the companion tarball built from this repository. The root `pnpm build` builds both packages; run `pnpm pack` in the repository root and in this directory separately.

Use the installed bin from the profile directory, or invoke it directly:

```sh
node "<profile-directory>/node_modules/@dsh-electron/dsh-plugin-multi-root-auto-review/configure.mjs" enable "<profile-directory>"
```

Then restart or recompose the profile. The command orders the companion after the selected official bundle and refuses missing prerequisites. Keep that order when editing bundles. `disable` removes the companion from the selected bundles, restoring the official composition while preserving dependencies and other settings.

Unloading a live Auto owner follows upstream behavior: Auto Sessions migrate to Full access. Reloading does not select Auto again. Multi-root write fences remain active.

The reviewer receives current topology and instruction data; project text is only a constraint. Budget, I/O, cancellation, or stale snapshots fail the call. Freshness is proven by rebuilding the whole context and comparing fingerprints: one call rebuilds it at most five times (one build plus four checkpoints), each a bounded registry and instruction scan — the fixed cost of the freshness semantics, not an authorization check. Native frames containing only additional-root instructions become historical facts and are replaced by current files. A mixed native frame fails closed when its additional files cannot be proven current; refresh the native baseline before retrying. Shell review covers known directory chains and cannot infer every target of an arbitrary program. Automatic source-code reads are excluded.

See [FORK.md](./FORK.md) for the baseline and synchronization contract. The main repository documents the design and validation evidence.
