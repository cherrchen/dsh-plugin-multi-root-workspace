# files-tree fork — provenance and sync

This directory is a **verbatim fork** of upstream's
`@deepseek-ai/dsh-client-ui-sidebar-files` tree (the body half of its Files
tab), taken to let the Files-tab root switcher browse an *additional*
workspace root with exactly the native tree's appearance and behavior —
because the upstream component derives its root from the session's `cwd`,
which is always the primary root and cannot be re-pointed.

- **Source**: `deepseek-harness/packages/client/ui-sidebar-files/src/client/`
- **Legacy revision**: `f3803c9697` (release `0.2.2-alpha.2`). The legacy
  listing store and row renderer are retained for older supported hosts.
  The `0.2.2-alpha.3` host split the Files page into a pane navigator and a
  controlled `sidebar.files.tree` Factory. On its `data-files-page` layout,
  this plugin adapts its listing state to that public Factory, so the host owns
  the row rendering and accessories; the legacy rows are its fallback. The
  host's context-menu integration is not forked. The alpha.3 preview-side
  navigator (`sidebar.files.navigator` inside the document preview) keeps a
  tree rooted at the session `cwd` only; `navigator.tsx` retargets its body
  when the previewed file sits under an additional root, reusing this fork —
  the native aside chrome, toggle, and ownership stay upstream's.
  Between `0.2.1-rc.3` (`1f81c047fc`) and `0.2.2-alpha.2` the upstream
  `src/client/` tree changed only in `FilesBody.module.css` (hover rules
  wrapped in `@media (hover: hover)` — copied below and ported into
  `src/client/styles.ts`), `index.ts` (more locale registrations — not
  forked), and `locales.ts` (new language dictionaries — the `zh` key set,
  and with it `SidebarFilesKey`, is unchanged). The component sources are
  byte-identical to the previous baseline.

## Verbatim files (copy-diff must stay empty)

| File | Delta vs upstream |
| --- | --- |
| `directory-node.ts` | none — byte-identical |
| `face.ts` | none — byte-identical |
| `store.ts` | none — byte-identical |
| `FilesBody.module.css` | none — kept verbatim as the diffable source; its rules are copied into `src/client/styles.ts` renamed to `mrfw-ft*` |

`FilesTree.tsx` is **not** verbatim: it is upstream's `FilesBody.tsx` with
the exported shell function rewritten and the file row's reveal marks
(`ref`/`data-files-current`/`aria-current` on `Entry`'s file button, plus
`TreeContext`'s `current`/`currentRef`) added inside the shared row
definitions (see *Intentional deltas*). `Level`/`orderEntries`/
`failureLine` are byte-identical — sync re-copies the whole file and
re-applies the deltas, never hand-edits inside the verbatim definitions.

## Shim files (ours — replace what cannot resolve or must not duplicate)

| File | Stands in for | Why |
| --- | --- | --- |
| `FilesBody.module.css.ts` | the css-module virtual module | exports the same `css.<name>` map → `mrfw-ft*` classes; rules live in styles.ts; header-only keys are unmapped because the fork draws no header |
| `locales.ts` | upstream `locales.ts` | only `NS` + the `SidebarFilesKey` union + the `LocaleNamespaceMap` augmentation; dictionaries are NOT re-registered — `ctx.locale.bind('sidebarFiles')` consumes upstream's live namespace so strings track upstream automatically |
| `client-remote.d.ts` | `@deepseek-ai/dsh-api-remotes/client`'s exported `ClientRemote` | `tsconfig.client.json` `paths` maps the specifier here so `face.ts`/`adapter.tsx`/`store.ts`/`FilesTree.tsx` (the only importers) compile against the dev-pin's `workspaceFiles` signatures on every supported manifest; on releases older than `0.2.0-rc.2` the real `changes` has two parameters (session-wide watch) and would fail the verbatim 3-argument call — safe because the `files.actions` slot does not exist there so the fork never mounts |
| `primitives.ts` | the named primitives imports upstream spells | runtime-probes `IconFolderCloseRegular`/`IconFolderOpenRegular` (with `*16` pixel-era fallbacks), `FileTypeIcon`, and `classifyFileType` through `compat/client-icons`'s `maybeIcon`/`maybeComponent`; the adapter's gate turns a missing export into no tree at all — upstream's own absence shape |
| `adapter.tsx` | upstream `apply`'s store/inject wiring | our wiring: `lazyFilesRemote` (`remote` and `remote.workspaceFiles` resolved per call through `ctx.get` — the inject-free store lookup, required because `remote.workspaceFiles` is a nested service whose context-proxy path throws "without inject" on undeclared fibers and this cordis treats every inject entry as required; every lookup failure — absent service, absent namespace, synchronous throw, or a rejected call — is folded into a settled `gateway/internal` RemoteResult/stream failure, because the verbatim `load` awaits `list` through `.then` with no `.catch` and an escaped rejection would die inside `DirectoryNode.task` pinning the level at `loading` forever), `createFilesTreeSeats` (the `store`/`inject` registration declarations: verbatim `filesFace` + session-bound `openFile`/`openFileIn` through `sidebarRight.openResourceIn` — the latter spelling the preview navigator's `replaceTab` route — plus the session-scoped `treeSelection` snapshot — exposed through the `hooks` compartment as `useTreeSelection` — and the takeover map that gives a body remount the native tree's occurrence-length lifetime plus the per-owner `(expanded, scrollTop, revealed)` memory — the fork's spelling of upstream's pane record — kept while the hold closes but the owner's section lives), and `createFilesTreeSurface` (the prop-share assembly + the primitives gate) |
| `locate.ts` | upstream navigator's `windowsRoot`/`underRoot`/`locateFile` + the `relativeFileOf` path math | path/level helpers the retargeted navigator reveal needs; `relativeUnderRoot`/`rootForPath` are ours — the containment check that picks the longest available additional root containing a previewed absolute path, skipping the primary root so primary files keep the native navigator |
| `navigator.tsx` | upstream `FileNavigator`'s pane/body half | the preview-side retarget: a `sidebar.right.tab.document.actions` occupant finds the native `aside[data-files-navigator]` inside the preview's `data-dockkit-content` ancestor, marks it `data-mrfw-navigator` (styles.ts hides its `[data-files-body]` only), and portals the forked `FilesTree` in — rooted at the containing additional root, opening rows through `openFileIn` (`replaceTab`), and revealing the previewed file. Store bucket, takeover, and the saved `(expanded, scrollTop, revealed)` memory are all keyed by the dockkit PANE id (`data-files-navigator` on the aside), never by the preview tab — upstream's navigator records live in `store.byPane`, and the pane survives what a `replaceTab` open destroys |
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
- **Lifetime**: upstream rides the tab record's `signal`; the fork takes a
  controller from the inject product's takeover map, keyed by (tab, root).
  Deselecting or switching roots ends it at once; a body unmount does not —
  opening a file deactivates the tab without ending its record. The inject
  product keeps a `MutationObserver` on the tabHost section each `signal()`
  call hands it, so the entry ends whenever that section leaves the document
  — the record's real end — even long after the body itself is gone. The
  abort forgets the bucket and closes every watch, mirroring upstream's
  tab-close path while matching its hidden-tab survival.
- **Open route**: upstream calls `tab.actions.openResource`; the fork calls
  the injected `openFile`, bound to `sidebarRight.openResourceIn`, and
  computes the address as `fileAddressFor(sessionId, undefined, path)` —
  `cwd` is deliberately `undefined` so the absolute row path reaches the
  host untouched (a session-relative address would resolve against the
  *primary* root). The preview navigator's `replaceTab` variant arrives as
  the injected `openFileIn` and is passed through `onOpen` unchanged, so
  the same `onOpen` prop serves both owners.
- **Reveal**: upstream's navigator seeds `pane.revealing` with the drawn
  file's address — unless `pane.revealed` already names it — and steps the
  walk open (ancestors expanded one listing at a time, then the file's row
  marked current and scrolled into view). The fork replays that contract
  outside upstream's `FileNavigator`: the optional `reveal` prop names the
  previewed absolute path plus the owner's remembered `revealed`; a shell
  effect keeps the upstream walk state (`revealing` = in-flight target,
  `revealed` = completed target, canceled on a mid-walk manual collapse —
  upstream's `manual && collapsing → revealed = revealing`), steps the
  first unexpanded ancestor per store update, and reports each settle
  through `onSettled` so the owner can record `revealed`. A completed walk
  suppresses re-stepping on reopen — the reader's collapse survives —
  exactly upstream's `revealing = revealed === address ? undefined :
  address`. `TreeContext` gained `current`/`currentRef` so the file row in
  `Entry` carries `data-files-current`/`aria-current` (the `mrfw-ft*` rule
  in styles.ts paints the same active highlight upstream's `.current`
  does) plus a callback ref that `scrollIntoView({block:'nearest',
  inline:'nearest'})`s once when the row lands — upstream's
  `scrollToCurrent` flag replayed as `wantScroll`. Those marks are the
  in-row deltas mentioned above; when the host `sidebar.files.tree`
  Factory renders, `nativeTreeInput` hands it the same
  `current`/`currentRef` pair so the native row shows its own highlight.
- **Saved view state**: the optional `saved` prop hands back the
  `(expanded, scrollTop, revealed)` snapshot the takeover map recorded
  while the owner was closed. Re-expanding goes through the verbatim
  `toggle` — its `root.setExpanded(next)` is upstream's own
  restore-preference channel — called once per remembered directory in
  saved order (parents always precede their children), so nested
  expansions land each level as it lists rather than only root-level
  ones. The saved `scrollTop` is deferred until the reseeded body
  overflows (a fresh bucket's `state.scrollTop` is 0 and would clamp the
  write away); an in-flight walk owns the view meanwhile — the same
  ordering upstream's restore-then-reveal produces. `revealed` seeds the
  reveal's suppression.
- **Scroll mirror**: the forked body's scroll is tracked by a NATIVE
  `scroll` listener on the body element and reported through the optional
  `onScrollOffset` prop (every scroll plus the final offset at unmount) —
  upstream's `scrolled` writing `pane.scrollTop` live. React's `onScroll`
  cannot serve here: the navigator portals the body outside its React
  root's container, where delegated events never arrive.
- **Body chrome**: the forked body carries upstream's `tabIndex={-1}`
  reachability, and when the takeover hid a focused native body the
  forked one takes the pane's focus (the body sits in the same aside as
  its own parent — the handoff the native `bodyDrawn` performs).
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
- `FileNavigator` itself — the preview's `aside[data-files-navigator]`,
  its open/close toggle, width, modes, and resize handle stay upstream's.
  The retarget only hides the aside's `[data-files-body]` while it hosts
  the forked tree, so a root that leaves the additional set (or a host
  whose navigator never mounts) falls straight back to the native body.
- The `sidebarFiles` dictionaries — the fork binds, never registers.
- The session-scope `data-files-*` DOM contract — the fork reads those hooks
  (`closest('[data-files-root]')`, `closest('[data-dockkit-content]')`) but
  never writes `data-files-root`/`data-files-body`.

## Sync procedure (when the dev pin moves)

The legacy files remain pinned to `0.2.2-alpha.2`, since replacing their
store/face with the later pane-based API would drop older supported hosts.
For newer releases compare their `FileTree` Factory input, `FilesBody` page
hooks, locales and remote signatures against `src/compat/files-tree.ts` and
the page selectors before changing this baseline. Re-copy the legacy files
only when intentionally changing the legacy baseline; then perform the steps
below. The Factory fallback must keep older or incomplete compositions usable.

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
   `workspaceFiles` remote slice against `lazyFilesRemote` and
   `client-remote.d.ts` — the shim must keep spelling the new baseline's
   signatures, or the verbatim call sites drift.
7. Re-probe the glyph names: if upstream's named imports change, update
   `primitives.ts`'s candidate lists (and the gate) rather than the
   component.
