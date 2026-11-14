# files-tree fork — provenance and sync

This directory is a **baseline fork** of upstream's
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
  host's context-menu integration is consumed through the root-provided
  `useContextMenu` prop rather than forked (ADR-0042). From `0.2.2-rc.2` the
  fork also carries its own workspace search surface for additional roots
  (ADR-0041): a toggle in the switcher header plus a bar/results/settings view
  that draws results with the same tree code. The alpha.3 preview-side
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
  byte-identical to the previous baseline, except for the documented
  `face.ts` hold/release lifecycle delta.

## Forked files (baseline copy + documented deltas)

| File | Delta vs upstream |
| --- | --- |
| `directory-node.ts` | none — byte-identical |
| `face.ts` | the hold/record lifecycle delta — `hold`/`release` keep the store bucket while a body is hidden, `start`/record-abort reseed/forget it (see *Intentional deltas*) |
| `store.ts` | none — byte-identical |
| `FilesBody.module.css` | none — kept verbatim as the diffable source; its rules are copied into `src/client/styles.ts` renamed to `mrfw-ft*` |
| `tree-view.tsx` | upstream's row definitions (`Entry`/`Level`/`TreeContext`/`orderEntries`/`failureLine`) moved out of `FilesTree.tsx` so the listed tree and the search results draw with the same code; the documented deltas add `highlight` marks, `hiddenOnly`/`unmatched` lines, and the row context-menu spread (see *Intentional deltas*) |
| `hidden.ts` | plugin-owned: upstream's draw-time hidden-entry filtering (`workspaceEntries`/`workspaceDirectories` with `showHidden`, hidden-directory subtree rule, "only hidden entries" state) applied to the fork's absolute-path store; no upstream file to copy from, but its semantics are pinned to `ui-sidebar-files` `workspace-tree.ts` at the same pin |
| `pane.tsx` + `search-rules.ts`/`search-tree.ts`/`search-preferences.ts`/`search-state.ts`/`search-client.ts`/`context-menu.ts` | plugin-owned search and menu surface; the first three are semantic copies of upstream's `0.2.2-rc.2` modules (see *Search surface: sync obligations*), the rest are this plugin's own |

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
| `client-remote.d.ts` | `@deepseek-ai/dsh-api-remotes/client`'s exported `ClientRemote` | `tsconfig.client.json` `paths` maps the specifier here so `face.ts`/`adapter.tsx`/`store.ts`/`FilesTree.tsx` (the only importers) compile against the dev-pin's `workspaceFiles` signatures on every supported manifest; on releases older than `0.2.0-rc.2` the real `changes` has two parameters (session-wide watch) and would fail the baseline 3-argument call — safe because the `files.actions` slot does not exist there so the fork never mounts |
| `primitives.ts` | the named primitives imports upstream spells | runtime-probes `IconFolderCloseRegular`/`IconFolderOpenRegular` (with `*16` pixel-era fallbacks), `FileTypeIcon`, and `classifyFileType` through `compat/client-icons`'s `maybeIcon`/`maybeComponent`; the adapter's gate turns a missing export into no tree at all — upstream's own absence shape |
| `adapter.tsx` | upstream `apply`'s store/inject wiring | our wiring: `lazyFilesRemote` (`remote` and `remote.workspaceFiles` resolved per call through `ctx.get` — the inject-free store lookup, required because `remote.workspaceFiles` is a nested service whose context-proxy path throws "without inject" on undeclared fibers and this cordis treats every inject entry as required; every lookup failure — absent service, absent namespace, synchronous throw, or a rejected call — is folded into a settled `gateway/internal` RemoteResult/stream failure, because the `load` awaits `list` through `.then` with no `.catch` and an escaped rejection would die inside `DirectoryNode.task` pinning the level at `loading` forever), `createFilesTreeSeats` (the `store`/`inject` registration declarations: `filesFace` with the hold/release delta + session-bound `openFile`/`openFileIn` through `sidebarRight.openResourceIn` — the latter spelling the preview navigator's `replaceTab` route — plus the session-scoped `treeSelection` snapshot — exposed through the `hooks` compartment as `useTreeSelection` — and the takeover map that gives a body remount the native tree's occurrence-length lifetime plus the per-owner `(expanded, scrollTop, revealed)` memory — the fork's spelling of upstream's pane record — written CONTINUOUSLY by the owner (bucket mirror, live scroll, settle reports), while ONE shared document observer — armed per owner key and outliving every `end` — drops the record when the owner's survival predicate finally fails (a dockkit pane has no stable element, so the preview navigator's predicate asks whether any connected element still carries its id, `data-dockkit-pane` or `data-dockkit-float`), and `save` refuses writes once hold and watch are both gone so a racing cleanup can never resurrect a dropped record), and `createFilesTreeSurface` (the prop-share assembly + the primitives gate) |
| `locate.ts` | upstream navigator's `windowsRoot`/`underRoot`/`locateFile` + the `relativeFileOf` path math | path/level helpers the retargeted navigator reveal needs; `relativeUnderRoot`/`rootForPath` are ours — the containment check that picks the longest available additional root containing a previewed absolute path, skipping the primary root so primary files keep the native navigator |
| `navigator.tsx` | upstream `FileNavigator`'s pane/body half | the preview-side retarget: a `sidebar.right.tab.document.actions` occupant finds the native `aside[data-files-navigator]` inside the preview's `data-dockkit-content` ancestor, marks it `data-mrfw-navigator` (styles.ts hides its `[data-files-body]` only), and portals the forked `FilesTree` in — rooted at the containing additional root, opening rows through `openFileIn` (`replaceTab`), and revealing the previewed file. Store bucket, takeover, and the saved `(expanded, scrollTop, revealed)` memory are all keyed by the dockkit PANE id (`data-files-navigator` on the aside), never by the preview tab — upstream's navigator records live in `store.byPane`, and the pane survives what a `replaceTab` open destroys. The pane id is itself observed: an attributes MutationObserver on the aside re-keys everything when `data-files-navigator` is rewritten in place (a drag to another pane), each pane keeping the record it saved under its own id. The saved `revealed` sits one level finer than upstream — per (pane, root) instead of per pane — so each additional root remembers its own last-completed walk rather than sharing one address |
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
- **Lifetime / hold**: upstream rides the tab record's `signal` and splits
  its navigator into a `hold(paneId, cwd)` whose cleanup closes only the
  `DirectoryNode`, leaving the store's tree in place. The fork mirrors that
  split with the inject product's takeover map, keyed by (tab, root): the
  map's signal is the RECORD lifetime (the Files page's tab, the preview
  navigator's dockkit pane), while a mounted `FilesTree` is one hold. On
  mount it calls `hold`, which reseeds a fresh root or resumes the same
  root's kept bucket and reopens its expanded directories; on unmount it
  calls `release`, which closes the node and every watch but keeps the
  bucket, levels, expansion, and scroll. A ready level makes `loading` a
  no-op, so the kept rows stay drawn while the resumed node re-lists them
  in the background — no loading row replaces rows the reader already had.
  Deselecting or switching roots and the record's real death abort the
  signal, which closes the node and forgets the bucket, mirroring upstream's
  tab-close path. The inject product's death watch — a `MutationObserver`
  armed on the survival check each `signal()` call hands it (an element to
  keep connected for the Files page, a pane-carrier query for the preview
  navigator) — lives outside the hold itself, so the record's real end still
  drops the saved memory even though the body's cleanup always wins the
  unmount race.
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
  address`. The seed is re-read whenever the `(root, path)` identity
  changes: the body outlives a root switch (the preview retarget re-roots
  the same portal), so a mount-time seed would replay the first root's
  walk on every return. A path that is not under the body's root is never
  stepped or settled — a root switch keeps the old root mounted until the
  refreshed registry list answers, and settling there would record the new
  root's address under the old root's `revealed`. `TreeContext` gained
  `current`/`currentRef` so the file row in
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
  while the owner was closed — recorded continuously (bucket mirror,
  live scroll, settle reports), never at cleanup, so observer/cleanup
  ordering cannot resurrect or lose it. Re-expanding goes through the
  verbatim `toggle` — its `root.setExpanded(next)` is upstream's own
  restore-preference channel — called once per remembered directory in
  saved order (parents always precede their children), so nested
  expansions land each level as it lists rather than only root-level
  ones. The saved `scrollTop` is deferred until the reseeded body
  overflows (a fresh bucket's `state.scrollTop` is 0 and would clamp the
  write away), and a reader's own scroll before that moment cancels the
  pending restore; an in-flight walk owns the view meanwhile — the same
  ordering upstream's restore-then-reveal produces, with the walk verdict
  read for the identity the render names so a previous root's unsettled
  walk cannot cancel the offset the new (suppressed) one restores.
  `revealed` seeds the reveal's suppression, and it is kept per (pane,
  root) — finer than upstream's single pane-level address, so moving
  between roots never smears one root's walk memory into another's. The
  retarget passes the snapshot for the LIVE hold's root (not the freshly
  matched one) and only hands the reveal to a body whose root is that
  matched root, so a switch can never pair one root's memory with the
  other root's tree.
- **Scroll mirror**: the forked body's scroll is tracked by a NATIVE
  `scroll` listener on the body element and reported through the optional
  `onScrollOffset` prop (every scroll plus the final offset at unmount —
  except after the takeover signal aborted, where a dead owner reports
  nothing) — upstream's `scrolled` writing `pane.scrollTop` live. React's
  `onScroll` cannot serve here: the navigator portals the body outside its
  React root's container, where delegated events never arrive.
- **Body chrome**: the forked body carries upstream's `tabIndex={-1}`
  reachability, and when the takeover hid a focused native body the
  forked one takes the pane's focus — checked against the hidden
  `[data-files-body]` specifically, since the fork's parent can be a whole
  page whose header controls must never lose focus (the handoff the
  native `bodyDrawn` performs).
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
- **Row context menus** (`0.2.2-alpha.3+`): `TreeView` forwards the pane's
  `menu` seat into the Factory input's `rowTriggerProps` (and spreads the same
  handlers on the legacy rows). The target is `{ kind, value: { sessionId,
  path: <absolute path> } }`: a workspace-relative path would resolve against
  the primary root in every host contribution (ADR-0042).
- **Viewer verdicts** (`0.2.2-alpha.3+`): the Factory input's `canOpen` is
  supplied from `ctx.sidebarRightTabs.candidates`, re-read whenever the
  registry notifies; `TreeView` forwards it, the legacy rows keep every file
  openable (the pre-Factory behavior).
- **Search marks** (`0.2.2-rc.2+`): `Name` wraps the occurrences of the search
  text in `<mark class="mrfw-ftMatch">`; `nativeTreeInput` also forwards the
  Factory's own `highlight`. Names are otherwise upstream's.
- **Selection lines** (`0.2.2-rc.2+`): a directory whose entries are a search
  selection draws nothing instead of "empty" (`omitted: 'unmatched'`); a listed
  directory whose entries were all filtered as hidden draws the "only hidden
  entries" line (`omitted: 'hidden'`, from `hidden.ts`). Both use upstream's
  own strings through the live locale namespace.

## What upstream keeps owning

- `definition.tsx`, `FilesTitle.tsx`, `index.ts` — the tab type, title,
  shortcut registration, and public entry all stay upstream's; nothing here
  re-registers a tab.
- `FileNavigator` itself — the preview's `aside[data-files-navigator]`,
  its open/close toggle, width, modes, and resize handle stay upstream's.
  The retarget only hides the aside's `[data-files-body]` while it hosts
  the forked tree, so a root that leaves the additional set (or a host
  whose navigator never mounts) falls straight back to the native body.
  Since `0.2.2-rc.2` the native navigator also draws a workspace search bar
  and status line above that body, and the Files page header a
  `[data-files-search-toggle]` button. Their search root is the Session cwd,
  so while a takeover shows another root they are hidden together with the
  native body (`src/client/styles.ts`); primary-root browsing keeps them
  untouched. The additional root's own search lives in `pane.tsx` behind
  `[data-mrfw-files-search-toggle]`/`[data-mrfw-files-search]` (deliberately
  NOT the `data-files-search*` hooks, which the hide rules target), and the
  preview navigator keeps no search at all — its search state is driven by
  upstream's own `FileNavigator` face, which the retarget does not join.
  Re-check those selectors whenever the upstream navigator gains a new
  `data-files-search*` hook.
- The `sidebarFiles` dictionaries — the fork binds, never registers.
- The session-scope `data-files-*` DOM contract — the fork reads those hooks
  (`closest('[data-files-root]')`, `closest('[data-dockkit-content]')`) but
  never writes `data-files-root`/`data-files-body`.

## Search surface: sync obligations

The additional-root search is plugin-owned UI over upstream semantics, not a
verbatim copy. Three modules are **semantic** copies of upstream's
`0.2.2-rc.3` `ui-sidebar-files` sources and must be diffed whenever the pin
moves (upstream may change rule validation, ignore handling, or the
relative-path/tree construction):

| Module | Upstream source | Copy delta |
| --- | --- | --- |
| `search-rules.ts` | `search-rules.ts` | logic verbatim; JSDoc condensed |
| `search-tree.ts` | `search-tree.ts` | `buildSearchTree` returns this fork's `FilesTabState` and imports `childPath` from `face.ts` |
| `search-preferences.ts` | `search-preferences.ts` | plugin-owned Storage seam (same localStorage key and stored format) instead of `@deepseek-ai/dsh-client-store` persist; no upstream runtime import |

Everything else is ours: `search-state.ts` (per-(tab, root) records),
`search-client.ts` (the channel call's request/answer), `pane.tsx` (bar,
status, results, notes, settings popover, keyboard) and `context-menu.ts`
(the structural `useContextMenu` adapter). Their visual rules are copied from
upstream's `FilesBody.module.css` search block into `styles.ts` as
`mrfw-fs*` (and `.match`/`.hidden`/`.inactive` as `mrfw-ft*`), keeping only
`var(--dsw-*)` tokens. Behavior that must be re-checked against upstream:
per-keystroke search with abort, blank query ends the search, `pending` keeps
the last result except a failed one, a new result starts expanded at its top,
preference changes re-run the query, and the eye toggle filters the listed tree
as well as the search.

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
3. `diff` the baseline files — `directory-node.ts`, `store.ts`, and
   `FilesBody.module.css` must be byte-identical. `face.ts` carries the
   deliberate hold/release delta; after copying the new upstream version,
   re-apply that delta (the `FilesInjected` additions and the
   `closeNode`/`forget`/`bindRecord`/`open` block) instead of resolving the
   diff by hand. Anything else means upstream moved.
4. Diff `FilesBody.module.css` — copy changed rules into `styles.ts`'s
   `mrfw-ft*` block keeping the rename (header-only rules stay unmapped).
5. Diff upstream `locales.ts`'s `zh` key set — extend `SidebarFilesKey` for
   new keys (strings themselves are consumed live from upstream's
   namespace).
6. Re-check `face.ts`'s `FilesInjected` members against `adapter.tsx` and
   `FilesTree.tsx`'s `Pick<FilesInjected, 'hold' | 'release' | 'toggle'>`, and the
   `workspaceFiles` remote slice against `lazyFilesRemote` and
   `client-remote.d.ts` — the shim must keep spelling the new baseline's
   signatures, or the verbatim call sites drift.
7. Re-probe the glyph names: if upstream's named imports change, update
   `primitives.ts`'s candidate lists (and the gate) rather than the
   component.
8. Diff upstream `FileTree.tsx` against `tree-view.tsx`: the row bodies,
   `Name`/`<mark>`, the `omitted` handling, and the input names
   (`rowTriggerProps`/`canOpen`/`highlight`) must match the new pin; re-copy
   the row definitions and re-apply the documented deltas, never hand-edit
   inside them.
9. Diff upstream `FileNavigator.tsx`'s search half against `pane.tsx`
   (bar/status/results/notes/keyboard/settings) and upstream
   `SearchSettings.tsx` against the settings view; update `styles.ts`'s
   `mrfw-fs*` block from the same pin's `FilesBody.module.css`.
10. Diff upstream `search-rules.ts`/`search-tree.ts`/`search-preferences.ts`
    against the local copies; a semantic change means the copies move too.
    Re-check the `data-mrfw-files-search*` DOM contract against the hide rules
    in `styles.ts` — the takeover must keep the native bar and status hidden
    while drawing its own.
