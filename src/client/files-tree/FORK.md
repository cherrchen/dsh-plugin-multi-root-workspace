# files-tree fork — provenance and sync

This directory is a **verbatim fork** of upstream's
`@deepseek-ai/dsh-client-ui-sidebar-files` tree (the body half of its Files
tab), taken to let the Files-tab root switcher browse an *additional*
workspace root with exactly the native tree's appearance and behavior —
because the upstream component derives its root from the session's `cwd`,
which is always the primary root and cannot be re-pointed.

- **Source**: `deepseek-harness/packages/client/ui-sidebar-files/src/client/`
- **Revision**: `d743267388` (release `0.2.1-alpha.2`, 2026-10-09) — matches
  this package's dev pin and the `@deepseek-ai/dsh-api-workspace-files`
  devDependency, which is the machine-readable record of the fork base.

## Verbatim files (copy-diff must stay empty)

| File | Delta vs upstream |
| --- | --- |
| `directory-node.ts` | none — byte-identical |
| `face.ts` | none — byte-identical |
| `store.ts` | none — byte-identical |
| `FilesBody.module.css` | none — kept verbatim as the diffable source; its rules are copied into `src/client/styles.ts` renamed to `mrfw-ft*` |

`FilesTree.tsx` is **not** verbatim: it is upstream's `FilesBody.tsx` with
only the exported shell function rewritten (see *Intentional deltas*). The
`Entry`/`Level`/`TreeContext`/`orderEntries`/`failureLine` definitions above
the shell are byte-identical — sync re-copies the whole file and re-applies
the shell rewrite, never hand-edits inside those definitions.

## Shim files (ours — replace what cannot resolve or must not duplicate)

| File | Stands in for | Why |
| --- | --- | --- |
| `FilesBody.module.css.ts` | the css-module virtual module | exports the same `css.<name>` map → `mrfw-ft*` classes; rules live in styles.ts; header-only keys are unmapped because the fork draws no header |
| `locales.ts` | upstream `locales.ts` | only `NS` + the `SidebarFilesKey` union + the `LocaleNamespaceMap` augmentation; dictionaries are NOT re-registered — `ctx.locale.bind('sidebarFiles')` consumes upstream's live namespace so strings track upstream automatically |
| `primitives.ts` | the named primitives imports upstream spells | runtime-probes `IconFolderCloseRegular`/`IconFolderOpenRegular` (with `*16` pixel-era fallbacks), `FileTypeIcon`, and `classifyFileType` through `compat/client-icons`'s `maybeIcon`/`maybeComponent`; the adapter's gate turns a missing export into no tree at all — upstream's own absence shape |
| `adapter.tsx` | upstream `apply`'s store/inject wiring | our wiring: `lazyFilesRemote` (`remote` and `remote.workspaceFiles` resolved per call through `ctx.get` — the inject-free store lookup, required because `remote.workspaceFiles` is a nested service whose context-proxy path throws "without inject" on undeclared fibers and this cordis treats every inject entry as required; every lookup failure — absent service, absent namespace, synchronous throw, or a rejected call — is folded into a settled `gateway/internal` RemoteResult/stream failure, because the verbatim `load` awaits `list` through `.then` with no `.catch` and an escaped rejection would die inside `DirectoryNode.task` pinning the level at `loading` forever), `createFilesTreeSeats` (the `store`/`inject` registration declarations: verbatim `filesFace` + session-bound `openFile` through `sidebarRight.openResourceIn`), and `createFilesTreeSurface` (the prop-share assembly + the primitives gate) |
| `FORK.md` | — | this file |

## Intentional deltas (upstream `FilesBody.tsx` → `FilesTree.tsx`)

The exported shell is the one function this fork had to rewrite; each seam
upstream binds inside it arrives as a prop instead:

- **Root source**: upstream reads `useSessions(...).byId[sessionId].cwd`; the
  fork takes `root` (the selected additional root's absolute path) as a prop.
- **Tab identity**: upstream reads `useTabInfo().id`; the fork takes `tabId`
  from the dockkit `data-dockkit-content` ancestor (or a generated
  fallback), so the store bucket, expansion state, and scroll memory are
  keyed exactly like a real Files tab.
- **Lifetime**: upstream rides the tab record's `signal`; the fork takes the
  takeover's `AbortController` — deselecting, switching roots, or unmounting
  aborts it, which forgets the bucket and closes every watch, mirroring
  upstream's tab-close path.
- **Open route**: upstream calls `tab.actions.openResource`; the fork calls
  the injected `openFile`, bound to `sidebarRight.openResourceIn`, and
  computes the address as `fileAddressFor(sessionId, undefined, path)` —
  `cwd` is deliberately `undefined` so the absolute row path reaches the
  host untouched (a session-relative address would resolve against the
  *primary* root).
- **Header**: upstream draws `data-files-root`, `data-files-path`,
  `data-files-reload`, the auto-refresh control, and the
  `sidebar.right.tab.files.actions` slot; the fork draws none of them — the
  switcher owns the header. The forked body therefore carries no
  `data-files-root`/`data-files-body` hooks (the plugin's own hide rules
  target those on the *native* pane), while row-level
  `data-files-entry`/`data-files-path` stay verbatim.
- **Omitted**: `bindCommands`/`refreshShortcut` (the upstream Files
  shortcut), the hidden auto-refresh button, and `setAutoRefresh` wiring.
  `autoRefresh` stays at the store's `true` default — the same behavior a
  native tree shows before anyone opens its auto-refresh toggle.
- **CSS specifier**: `FilesTree.tsx` imports `./FilesBody.module.css.ts`
  instead of `./FilesBody.module.css` because this toolchain resolves real
  files, not CSS-module virtual modules (same one-line delta as the
  open-in-app fork).

## What upstream keeps owning

- `definition.tsx`, `FilesTitle.tsx`, `index.ts` — the tab type, title,
  shortcut registration, and public entry all stay upstream's; nothing here
  re-registers a tab.
- The `sidebarFiles` dictionaries — the fork binds, never registers.
- The session-scope `data-files-*` DOM contract — the fork reads those hooks
  (`closest('[data-files-root]')`, `closest('[data-dockkit-content]')`) but
  never writes `data-files-root`/`data-files-body`.

## Sync procedure (when the dev pin moves)

1. `cp` `directory-node.ts`, `face.ts`, `store.ts`, `FilesBody.module.css`,
   and `FilesBody.tsx` from the upstream checkout at the new pin.
2. Rewrite the copied `FilesBody.tsx` shell into `FilesTree.tsx` exactly per
   *Intentional deltas* — the `Entry`/`Level`/`TreeContext`/`orderEntries`/
   `failureLine` definitions must remain byte-identical to the new upstream
   file, so diff `FilesTree.tsx` against upstream and confirm the only
   differences are the shell, the css specifier, and the prop-driven seams.
3. `diff` the four verbatim files — zero accepted differences. Anything
   else means upstream moved: port the change instead of resolving the diff
   by hand.
4. Diff `FilesBody.module.css` — copy changed rules into `styles.ts`'s
   `mrfw-ft*` block keeping the rename (header-only rules stay unmapped).
5. Diff upstream `locales.ts`'s `zh` key set — extend `SidebarFilesKey` for
   new keys (strings themselves are consumed live from upstream's
   namespace).
6. Re-check `face.ts`'s `FilesInjected` members against `adapter.tsx` and
   `FilesTree.tsx`'s `Pick<FilesInjected, 'start' | 'toggle'>`, and the
   `workspaceFiles` remote slice against `lazyFilesRemote`.
7. Re-probe the glyph names: if upstream's named imports change, update
   `primitives.ts`'s candidate lists (and the gate) rather than the
   component.
