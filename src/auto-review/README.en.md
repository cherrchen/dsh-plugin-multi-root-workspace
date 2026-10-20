# Optional Auto Review

中文：[README.md](./README.md)

Auto Review is included at `@dsh-electron/dsh-plugin-multi-root-workspace/auto-review` and supports only DSH `0.2.1-rc.2`. After installing the main package, expand Multi-root Workspace's row list in the Plugin Manager and enable `multi-root-auto-review`. This row ships disabled: while off, it mounts neither the reviewer nor review context and does not register the Auto preset. Profiles without hot reload require a restart, as reported by the manager.

The one switch mounts both current multi-root context and the reviewer, taking over the sibling official `@deepseek-ai/dsh-experimental-auto-review` row at runtime. Either bundle order works, and subsequent reloads retain one owner. Takeover does not change the official row's saved configuration. After disabling, reload/restart restores the official owner only if its bundle is still selected and its original configuration allows it to run; an unselected official bundle is not installed or enabled automatically. When the official bundle is not selected, the row still provides the same reviewer standalone (it registers the Auto preset itself); there is simply no official owner to take over.

Alternatively, set this in the profile's `cordis.patch.yml`:

```yaml
- id: multi-root-auto-review
  disabled: false
```

Unloading a live Auto owner preserves official behavior: Auto sessions move to Full access, and a replacement owner does not automatically switch them back. Select Auto again in the session when needed. Multi-root write fences remain enforced.

To migrate from the former companion, stop the profile, remove its bundle selection and `@dsh-electron/dsh-plugin-multi-root-auto-review` dependency, then install/update the main package and enable the row above. The existing `dsh plugin --profile <name> remove @dsh-electron/dsh-plugin-multi-root-auto-review` command can remove the old package; preserve the official bundle's existing selection. The old configure command is retired. Coexistence with a selected legacy companion produces an explicit startup diagnostic and never silently rewrites the user's manifest.

Constraint roles, budgets, mixed native frames, and freshness retain the existing fork semantics: current topology and instructions enter the reviewer's data sections; project text only constrains actions. Budget, I/O, cancellation, or snapshot changes fail that call. bash/pwsh collection covers known directory chains and cannot infer every target of an arbitrary script. Automatic source-file reading remains outside scope.

See [FORK.md](./FORK.md) for the baseline, permitted differences, and synchronization procedure.
