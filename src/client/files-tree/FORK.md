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
  the row rendering and accessories; the legacy rows are its fallback. From
  ADR-0052 (P4/P5) the same fork also browses *remote* roots: the switcher
  mounts a provider whose `listDirectory` is the `remoteFiles.list` RPC and
  which declares no watch/search/preview/menu/openInApp ports plus
  `retainHiddenLevels: false` — the tree code is shared, the remote plane
  adds no renderer and no SSH import to the client bundle. The
  host's context-menu integration is consumed through the root-provided
  `useContextMenu` prop rather than forked (ADR-0042). From `0.2.2-rc.2` the
  fork also carries its own workspace search surface for additional roots
  (ADR-0041): a toggle in the switcher header plus a bar/results/settings view
  that draws results with the same tree code. The alpha.3 preview-side
  navigator (`sidebar.files.navigator` inside the document preview) keeps a
  tree rooted at the session `cwd` only; `navigator.tsx` retargets its body
  when the previewed file sits under an additional root, reusing this fork —
  the native aside chrome, toggle, and ownership stay upstream's. From
  `0.2.2-rc.2` on, that retarget mounts the search surface (`FilesPane`'s
  preview mode) instead of the bare tree whenever the host exposes workspace
  search (ADR-0043), so a preview beside an additional root carries the same
  bar, results, settings and hidden-entry behavior as the native preview.
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
| `directory-node.ts` | the optional-watch delta: the constructor's `watch` may be `undefined` (a provider without `watchDirectory` gets an explicit initial `refresh()` in `open()` instead of a stream), the `joinChild` parameter customizes the child-key join (default `childPath`), and the automatic-refresh policy moved onto watch-event scheduling — a reader's manual refresh always runs, a watch event only reschedules while `automatic` is on |
| `face.ts` | the hold/record lifecycle delta — `hold`/`release` keep the store bucket while a body is hidden, `start`/record-abort reseed/forget it (see *Intentional deltas*) — plus the provider delta: `filesFace(actions)` closes over no remote, `hold`/`start` receive the `WorkspaceFilesProvider`, the bucket is seeded at `provider.treeRoot`, every level key is mapped through `provider.resource(...)` before a port sees it, pending requests carry unique `Symbol()` tokens, and the watch is optional. `createList`/`createWatch` moved to `providers/local.ts`; `childPath` is re-exported from `resource-path.ts` |
| `store.ts` | none — byte-identical |
| `provider.ts` | plugin-owned contract (P1, ADR-0052): `WorkspaceRootRef`/`WorkspaceResourceRef`/`FilesProviderIdentity`, the optional-port `WorkspaceFilesProvider` (`retainHiddenLevels` declares whether a provider keeps its levels while its owner is hidden — the remote provider sets `false` so no cached row can repaint before authorization is revalidated), `rootKey`/`providerKey`/`treeBucketId`/`validRelativePath`/`belongsTo`, and `rowActions` — the path-keyed `open`/`canOpen`/`menu` gestures every renderer dispatches through |
| `resource-path.ts` | plugin-owned: the shared `childPath`/`JoinTreeChild` both the fork's path math and the provider's child-key seam use — kept outside `face.ts` so the provider module has no fork cycle; `face.ts` re-exports `childPath` for the callers that still spell it |
| `providers/resolver.ts` | plugin-owned composition slot: `FilesRootSelection` — the discriminated `LocalRootSelection \| RemoteRootSelection` union (top-level `kind`, ref + incarnation identity, path/view display metadata) — `localRootSelection`, `remoteRootSelection` (issues a record only when the endpoint is registered, read-granted and carries a valid `browseAuthorization` token), and `resolveWorkspaceFilesProvider` — the single switch selecting the local factory or the optional `ssh` factory (absent → `undefined`, no remote provider) |
| `providers/ssh.ts` | plugin-owned remote adapter (P4, ADR-0052): `createSshWorkspaceProvider` over the injected `RemoteFilesClient` — `treeRoot='/mrfw'`, `belongsTo` + `validRemoteRelativePath` admission, `{sessionId, environmentId, rootId, relativePath, authorization}` list calls, symlink rows drawn as `other`, no watch/search/preview/menu/openInApp ports; the host's fixed codes map `directory-not-found`/`not-directory`/`path-escapes-root` onto upstream `workspace-file/*` codes and only the seven authorization-class codes reach `invalidated` — per-directory and transport failures keep the tree's normal error state |
| `providers/local.ts` | plugin-owned local adapter: `createList`/`createWatch`/`createLocalWorkspaceProvider` — the local geometry (absolute `treeRoot`, mixed-separator tail, Windows case/separator normalization), the admission fence (`belongsTo` + valid tail + no `\` under a Windows root), and the ONLY `fileAddressFor`/`sessionId` site left in the tree — preview canOpen/open, the search port's root-id binding and answer-root check, the menu path, and `openInApp` all convert the resource back to the local spelling here |
| `FilesBody.module.css` | none — kept verbatim as the diffable source; its rules are copied into `src/client/styles.ts` renamed to `mrfw-ft*` |
| `tree-view.tsx` | upstream's row definitions (`Entry`/`Level`/`TreeContext`/`orderEntries`/`failureLine`) moved out of `FilesTree.tsx` so the listed tree and the search results draw with the same code; the documented deltas add `highlight` marks, `hiddenOnly`/`unmatched` lines, and the row context-menu spread (see *Intentional deltas*). The provider delta removed `fileAddressFor`/`sessionId` entirely: `onToggle`/`onOpen`/`canOpen`/`menu` are tree-key-keyed gestures supplied by `rowActions`, `joinChild` picks the provider's child-key spelling, and a file row without an `open` port draws `disabled`/`aria-disabled` and cannot activate by mouse or key |
| `hidden.ts` | plugin-owned: upstream's draw-time hidden-entry filtering (`workspaceEntries`/`workspaceDirectories` with `showHidden`, hidden-directory subtree rule, "only hidden entries" state) applied to the fork's absolute-path store; no upstream file to copy from, but its semantics are pinned to `ui-sidebar-files` `workspace-tree.ts` at the same pin. `drawnTree` takes the provider's `joinChild` (default `childPath`) so hidden-directory prefixes join in the provider's geometry |
| `pane.tsx` + `search-rules.ts`/`search-tree.ts`/`search-preferences.ts`/`search-state.ts`/`search-client.ts`/`context-menu.ts`/`describe-failure.ts` | plugin-owned search and menu surface; the first three are semantic copies of upstream's `0.2.2-rc.5` modules (their source has not changed since rc.2; see *Search surface: sync obligations*), the rest are this plugin's own. `pane.tsx`'s `preview` mode is the document navigator's form of the same component: the bar is always drawn without touching `barOpen`, mount never takes the keyboard, the previewed file is marked current among the results, and closing settings refocuses the magnifier. `describe-failure.ts` is the one describer both owners use for panel failure codes, so their wording cannot drift |

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
| `adapter.tsx` | upstream `apply`'s store/inject wiring | our wiring: `lazyFilesRemote` (`remote` and `remote.workspaceFiles` resolved per call through `ctx.get` — the inject-free store lookup, required because `remote.workspaceFiles` is a nested service whose context-proxy path throws "without inject" on undeclared fibers and this cordis treats every inject entry as required; every lookup failure — absent service, absent namespace, synchronous throw, or a rejected call — is folded into a settled `gateway/internal` RemoteResult/stream failure, because the `load` awaits `list` through `.then` with no `.catch` and an escaped rejection would die inside `DirectoryNode.task` pinning the level at `loading` forever), `createFilesTreeSeats` (the `store`/`inject` registration declarations: `filesFace` with the hold/release delta + session-bound `openFile`/`openFileIn` through `sidebarRight.openResourceIn` — the latter spelling the preview navigator's `replaceTab` route — plus the session-scoped `treeSelection` snapshot — exposed through the `hooks` compartment as `useTreeSelection`, now storing `FilesRootSelection` (ref + incarnation identity beside the display metadata) instead of a bare `RootView` — and the takeover map that gives a body remount the native tree's occurrence-length lifetime plus the per-(owner, providerKey) `(expanded, scrollTop, revealed)` memory — the fork's spelling of upstream's pane record — written CONTINUOUSLY by the owner (bucket mirror, live scroll, settle reports), while ONE shared document observer — armed per owner key and outliving every `end` — drops the record when the owner's survival predicate finally fails (a dockkit pane has no stable element, so the preview navigator's predicate asks whether any connected element still carries its id, `data-dockkit-pane` or `data-dockkit-float`), and `save` refuses writes once hold and watch are both gone so a racing cleanup can never resurrect a dropped record; `signal(owner, providerKey, carrier)` re-keys a hold only when the provider key actually changed, so a new provider never pairs with an old record; `takeover.invalidate(owner, providerKey)` aborts + forgets a bucket/record pair on invalidation, and the shared death observer also drops the dead owner's persisted `treeSelection` entry so a recycled owner id inherits nothing), and `createFilesTreeSurface` (the prop-share assembly + the primitives gate + `resolveProvider(root, onInvalidated?)` — the single composition slot `RootSwitcher` and the preview navigator resolve their provider through, returning `undefined` when the selection is remote and no `ssh` factory was seated — plus `observeAuthority`, the bound authorization-lease port `RootSwitcher` loops for remote records: one `remoteFiles.wait` per call, no filesystem watch). `createFilesTreeSeats` also forwards `remoteFiles` (the injected `RemoteFilesClient`) and the plugin's own `multiRootWorkspace` localize for remote failure groups — `sidebarFiles` stays upstream-owned |
| `locate.ts` | upstream navigator's `windowsRoot`/`underRoot`/`locateFile` + the `relativeFileOf` path math | path/level helpers the retargeted navigator reveal needs; `relativeUnderRoot`/`rootForPath` are ours — the containment check that picks the longest available additional root containing a previewed absolute path, skipping the primary root so primary files keep the native navigator. `locateFile` takes the provider's `joinChild` so an ancestor walk joins keys in the provider's geometry |
| `navigator.tsx` | upstream `FileNavigator`'s pane/body half | the preview-side retarget: a `sidebar.right.tab.document.actions` occupant finds the native `aside[data-files-navigator]` inside the preview's `data-dockkit-content` ancestor, marks it `data-mrfw-navigator` (styles.ts hides its `[data-files-body]` only), and portals the forked tree in — rooted at the containing additional root, opening rows through `openFileIn` (`replaceTab`), and revealing the previewed file. When the search seat exists the portal hosts `FilesPane mode="preview"` instead of `FilesTree` (same `(pane, root)` record key), and the takeover record carries `rootId` beside `root` in one state commit so no transition frame can pair one root's query with another root's id (ADR-0043 D2). Without the seat the portal is the bare `FilesTree`, exactly the pre-rc.2 shape. Store bucket, takeover, and the saved `(expanded, scrollTop, revealed)` memory are all keyed by the dockkit PANE id (`data-files-navigator` on the aside) PLUS the provider key (`treeBucketId(owner, identity)` / `providerKey(identity)`), never by the preview tab and never by a path — upstream's navigator records live in `store.byPane`, the pane survives what a `replaceTab` open destroys, and a re-granted root's new incarnation forces a fresh bucket. The pane id is itself observed: an attributes MutationObserver on the aside re-keys everything when `data-files-navigator` is rewritten in place (a drag to another pane), each pane keeping the record it saved under its own id. The saved `revealed` sits one level finer than upstream — per (pane, root) instead of per pane — so each additional root remembers its own last-completed walk rather than sharing one address |
| `FORK.md` | — | this file |

## Intentional deltas (upstream `FilesBody.tsx` → `FilesTree.tsx`)

The exported shell is the one function this fork had to rewrite; each seam
upstream binds inside it arrives as a prop instead:

- **Root source**: upstream reads `useSessions(...).byId[sessionId].cwd`; the
  fork takes `provider` — the `WorkspaceFilesProvider` the owner resolved —
  and derives its root from `provider.treeRoot`.
- **Tab identity**: upstream reads `useTabInfo().id`; the fork takes `tabId`
  as `treeBucketId(owner, provider.identity)` — the dockkit
  `data-dockkit-content` ancestor (or a generated fallback) plus the provider
  key — so the store bucket, expansion state, and scroll memory are keyed
  like a real Files tab AND a re-granted root never resumes an old grant's
  bucket.
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
- **Open route**: upstream calls `tab.actions.openResource`; the fork's
  renderers dispatch `rowActions(provider, signal, replaceTab)` —
  path-keyed gestures that resolve `provider.resource(path)` at call time
  and only ever hand the provider's `preview` port a `WorkspaceResourceRef`.
  The local provider's preview converts the resource back to
  `fileAddressFor(sessionId, undefined, absolutePath)` — `cwd` deliberately
  `undefined` so the absolute row path reaches the host untouched (a
  session-relative address would resolve against the *primary* root) — and
  calls the injected `openFile`/`openFileIn`, the latter spelling the
  preview navigator's `replaceTab` route. A provider without a `preview`
  port yields `open: undefined` and `canOpen: false`: legacy rows draw
  `disabled`/`aria-disabled` and cannot activate, the Factory's open is a
  no-op.
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
  the provider-bound `rows.canOpen` — a tree-key predicate that resolves
  the resource and asks the preview port, whose local implementation
  consults `ctx.sidebarRightTabs.candidates`, re-read whenever the registry
  notifies. With no registry the local port defaults to openable — the
  pre-Factory behavior — so `canOpen` reaches the Factory on every local
  render while `rowTriggerProps` still gates on the menu seat.
- **Search marks** (`0.2.2-rc.2+`): `Name` wraps the occurrences of the search
  text in `<mark class="mrfw-ftMatch">`; `nativeTreeInput` also forwards the
  Factory's own `highlight`. Names are otherwise upstream's.
- **Selection lines** (`0.2.2-rc.2+`): a directory whose entries are a search
  selection draws nothing instead of "empty" (`omitted: 'unmatched'`); a listed
  directory whose entries were all filtered as hidden draws the "only hidden
  entries" line (`omitted: 'hidden'`, from `hidden.ts`). Both use upstream's
  own strings through the live locale namespace.
- **Preview mode (ADR-0043)**: `FilesPane`'s `mode='preview'` is the document
  navigator's form of the same surface, not a second state machine — the
  records, requests, results, settings and notes are the Files-page code. The
  differences are explicit: the bar is drawn unconditionally (the mode, never
  `barOpen`, decides visibility, so the record's flag stays false and the
  Files-page toggle semantics are untouched); mounting never focuses the
  field; the caller supplies the open route (the navigator passes
  `openFileIn`, i.e. `replaceTab`); and `previewPath` marks the previewed file
  in the result tree via `relativeUnderRoot` + `locateFile`. That mark is
  draw-only: `TreeView.current.ref` became optional so a result current row
  passes `current` without a scroll target, and `nativeTreeInput` forwards
  `currentRef` only when a ref exists (the Factory's own field was already
  optional). Three shared corrections also apply on the Files page: closing
  the settings popover refocuses the bar's magnifier (upstream's
  `closeSettings`, previously the field), `moveAlongRows`'s stops cover the
  listed tree rows as well as the result rows (`li[data-files-entry] > button`
  and `> div > button`, both render paths), and the settings draft is cleared
  when `stateKey` changes so one root's draft never lands in another root's
  preferences. The pane root carries `data-mrfw-files-pane`; the focus handoff
  finds the hidden native body through
  `body.closest('[data-files-page], aside[data-files-navigator]') ??
  body.parentElement`, which covers the pane-wrapped preview, the direct
  preview mount, and the Files page's newer page wrapper alike.
- **Known preview deltas** (accepted, ADR-0043 D3/D4): a non-blank query
  replaces the listed tree with the result body, so the tree unmounts and its
  hold ends (`release`); clearing the query holds again and re-lists watched
  directories, but keeps the listed rows and reuses the searched answer (the
  search request identity is unchanged). The settings draft is component
  state: switching roots discards it and closing Folder loses it — upstream's
  `SearchSettings` only returns `null` and keeps its draft. The result current
  row is marked but never scrolled: the reveal's viewport belongs to the
  listed tree, whose in-flight state the result view discards.

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
  so while a takeover shows another root the native bar, status line and a
  leftover native settings popover are hidden with the native body by
  DIRECT-CHILD rules in `src/client/styles.ts`; the bar selector additionally
  carries `:not([data-mrfw-files-pane])`, a defensive guard so a future
  upstream selector change cannot hide the plugin's replacement (which is
  itself a direct child of the same aside). Primary-root browsing keeps the
  native controls untouched. The additional root's search lives in
  `pane.tsx`: the input keeps plugin-only hooks
  (`[data-mrfw-files-search]`) and the pane root carries
  `data-mrfw-files-pane`, while the status line, settings popover and its
  toggle reuse upstream's same-named `data-files-search-status` /
  `data-files-search-settings` / `data-files-search-settings-toggle` /
  `data-files-show-hidden` / `data-files-search-clear` hooks — they sit behind
  the pane, so only the native direct-child instances are hidden. Since
  `0.2.2-rc.2` the preview aside hosts the same pane in preview mode, so the
  additional-root preview carries workspace search too (ADR-0043); the native
  preview's own search state is still upstream's `FileNavigator` face and is
  not joined. Re-check those selectors whenever the upstream navigator gains
  a new `data-files-search*` hook.
- The `sidebarFiles` dictionaries — the fork binds, never registers.
- The session-scope `data-files-*` DOM contract — the fork reads those hooks
  (`closest('[data-files-root]')`, `closest('[data-dockkit-content]')`) but
  never writes `data-files-root`/`data-files-body`.

## Search surface: sync obligations

The additional-root search is plugin-owned UI over upstream semantics, not a
verbatim copy. Three modules are **semantic** copies of upstream's
`0.2.2-rc.5` `ui-sidebar-files` sources and must be diffed whenever the pin
moves (upstream may change rule validation, ignore handling, or the
relative-path/tree construction); `0.2.2-rc.4` and `0.2.2-rc.5` changed no file under that
upstream `src/client/` tree, so the copies stay as reviewed at `0.2.2-rc.3`:

| Module | Upstream source | Copy delta |
| --- | --- | --- |
| `search-rules.ts` | `search-rules.ts` | logic verbatim; JSDoc condensed |
| `search-tree.ts` | `search-tree.ts` | `buildSearchTree` returns this fork's `FilesTabState` and imports `childPath` from `resource-path.ts` |
| `search-preferences.ts` | `search-preferences.ts` | plugin-owned Storage seam (same localStorage key and stored format) instead of `@deepseek-ai/dsh-client-store` persist; no upstream runtime import |

Everything else is ours: `search-state.ts` (per-(tab, root) records, plus the
request identity that lets a body remount reuse a settled answer and
`forgetTab` for owner death), `search-client.ts` (the channel call's
request/answer), `pane.tsx` (bar, status, results, notes, settings popover,
keyboard, and the `preview` mode's always-drawn bar / current-row mark) and
`context-menu.ts` (the structural `useContextMenu` adapter). The preview mode
is the document navigator's form of the same surface, so when the pin moves
diff upstream `FileNavigator.tsx`'s `page: false` branch against `pane.tsx`
and `navigator.tsx`'s portal branch: always-open bar, no mount focus, the
`locateFile`-driven result current row, `replaceTab` opens, and the settings
refocus target.
One store belongs to one session's inject product — records are not shared
across sessions — and the adapter's owner-death cleanup calls `forgetTab`
when a tab really closes; a body-only unmount keeps the record (that is what
restores expansion and scroll after a file view). Their visual rules are copied from
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
3. `diff` the baseline files — `store.ts` and `FilesBody.module.css` must
   be byte-identical. `face.ts` carries the deliberate hold/release AND
   provider deltas; `directory-node.ts` carries the optional-watch /
   `joinChild` / refresh-coalescing delta — after copying the new upstream
   versions, re-apply those deltas (the `FilesInjected` additions, the
   `closeNode`/`forget`/`bindRecord`/`open` block, the optional `watch`
   constructor member and its `open()`/`follow()` branches, and the
   `joinChild` parameter) instead of resolving the diff by hand. Anything
   else means upstream moved.
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
   (bar/status/results/notes/keyboard/settings), its `page: false` preview
   branch against `pane.tsx`'s `mode="preview"` (always-drawn bar, no mount
   focus, current-row mark, magnifier refocus, Escape order), and upstream
   `SearchSettings.tsx` against the settings view; update `styles.ts`'s
   `mrfw-fs*` block from the same pin's `FilesBody.module.css`.
10. Diff upstream `search-rules.ts`/`search-tree.ts`/`search-preferences.ts`
    against the local copies; a semantic change means the copies move too.
    Re-check the `data-mrfw-files-search*` DOM contract and the
    `data-files-search*` reuse against the hide rules in `styles.ts` — the
    takeover must keep the native direct-child bar, status line and leftover
    settings hidden while drawing its own pane, and the
    `:not([data-mrfw-files-pane])` guard must still exclude the plugin pane.
    Also re-check the focus handoff container lookup against the current
    `data-files-page` / aside wrappers.
