# Checklist for Adding an SSH Remote Binding Capability

中文：[remote-binding-capability-checklist.md](./remote-binding-capability-checklist.md)

This note answers a recurring implementation question: **when adding a capability, permission, or deployment assertion to an SSH remote workspace binding, which layers must change together?**

It is not the design document for `directoryListing` itself. The security decision lives in [ADR-0052](../../docs/decisions/ADR-0052-provider-file-browsing.md), and the browsing architecture lives in [file-browsing-providers.md](../../docs/architecture/file-browsing-providers.md). This note is the cross-layer implementation map, written so future Agents do not update only one wizard, one schema, or one menu and end up with a capability that can be enabled in one place, silently dropped in another, and rejected by the Host.

## 0. Classify the capability first

Not every capability is an `action`. Decide which kind you are adding:

1. **Model-tool action authorization** — like `read` / `write` / `exec`, directly controlling what `remote_copy` / `remote_bash` may do. Only this kind belongs in `binding.actions`, `RemoteAction`, and the `remote.capability.*` action vocabulary.
2. **A transfer pairing** — like `transfers`: not an action, but a directed allowance between two roots.
3. **A deployment assertion or backend capability** — like `directoryListing: 'stable-path'`: it asserts a deployment property the protocol cannot fully prove at runtime. It may require an action (`read`), but it is not itself a model action.
4. **A connection-level capability** — like an environment's `exec` / `transfer` stanza. Those belong to the connection, not to one workspace binding; do not copy the model across the boundary in either direction.

If the classification is wrong, every layer below it will be wrong. Do not put a checkbox into `actions` merely because it looks like one in the UI.

## 1. Keep the whole data path in mind

In personal mode a binding capability travels through at least this chain:

```text
every client editing surface
  → SshBindingDraft (remote/personal-contract.ts)
  → the strict sshBindingSave request schema
  → the sshBindingSave CAS write in remote/personal-endpoints.ts
  → bindings persisted by remote/personal/config.ts
  → toDeploymentManifest(...)
  → the shared bindingSchema and semantic validation in remote/manifest.ts
  → bindingDigest / grant state / withheld detection
  → registration checks in SshEndpointVerifier
  → remoteCapabilitiesOf / remotesViewOf / tool admission / services such as remoteFiles
  → browser consumers such as RootSwitcher, providers, and the quick menu
```

Deployment mode has no personal UI or personal store, but it shares the second half: `remote/manifest.ts`, digests, verifier, registry, and runtime admission. Changing only the personal layer is incomplete; changing only the shared manifest is also incomplete because the strict wire schema rejects the client first.

## 2. Layer-by-layer checklist

Use this order where possible; it follows the dependency direction.

### 2.1 Semantics, security boundary, and default state

- Decide whether the new capability is an action, a pairing, a deployment assertion, or connection-level configuration.
- The default must fail safe: off by default, explicit opt-in, or at least no new power merely because an old config lacks the field.
- Write down cross-field invariants. For example, `directoryListing` requires `read`; the Host must enforce that authoritatively, while client disabling is only UX.
- Decide whether it changes authorization identity. The shared `bindingDigest` hashes the normalized binding as a whole, so a new persisted field normally changes the digest and moves existing grants to `withheld`. That is often correct and necessary, but it must be intentional.
- If the capability involves path, object, or transport identity, write down which authorization domains must not be conflated. The key `directoryListing` lesson: a Helper dev:ino object grant must never be reinterpreted as a path grant.

### 2.2 Shared manifest schema and semantic validation

Location: `src/remote/manifest.ts`

- Add the field to `bindingSchema`, or add a new action to the `actions` enum.
- Extend `parseDeploymentManifest` with cross-field validation, duplicate validation, budgets, and transport/backend constraints.
- If the field is valid only for personal bindings or only for deployment bindings, respect the existing `bindingId` / `options.personal` boundary instead of silently accepting a reserved shape on both sides.
- Deployment manifests are operator-authored input, and personal config reaches the same validation through `toDeploymentManifest`. Do not put the only validation in the personal endpoint.

### 2.3 Persistence and personal → deployment conversion

Location: `src/remote/personal/config.ts`

- The personal bindings store reuses the shared `bindingSchema`; confirm the new field round-trips through load and save.
- `toDeploymentManifest` normally passes `config.bindings` through directly, but environment/transport derivation can affect whether the field is legal.
- Check backwards compatibility: new fields should usually be optional with a safe default. Do not invalidate old configs unless a breaking migration is deliberate.
- If the field affects file protection, path budgets, or the primary-root relationship, update the relevant protection checks too.

### 2.4 Panel wire contract

Location: `src/remote/personal-contract.ts`

Three pieces must move together, or the client and Host disagree:

1. the strict binding schema inside `sshBindingSave`;
2. the `SshBindingView` / `SshBindingDraft` TypeScript types;
3. `bindingViewSchema` / `sshStateSchema` response decoding.

The schemas are `.strict()`: without the field, a client-built draft is rejected at the Host boundary. Without the view-side field, even a successful save is followed by a state response that the client cannot decode faithfully.

If the capability affects the remote endpoint projection, also update `src/remote/panel-contract.ts`: `RemoteAction`, `RemoteCapabilitiesView`, `RemoteEndpointView`, their zod schemas, and their comments.

### 2.5 Host save endpoint and CAS/no-op detection

Location: `sshBindingSave` in `src/remote/personal-endpoints.ts`

- Add request-level cross-field validation where appropriate, but do not let the endpoint replace manifest validation; the two layers have different jobs.
- **The no-op comparison must include the new field.** This is one of the easiest places to miss: if it is missing, editing only that field looks successful but the Host returns the unchanged config.
- Update rootId reuse, path matching, transfer legality, or deployment-style pairing logic when the field interacts with them.
- Preserve revision CAS semantics; never create a side-channel write for the new field.

### 2.6 Registration, authorization identity, and re-registration

Locations: `src/remote/ssh-verifier.ts`, `src/registry.ts`, `src/command.ts`, `src/remote/records.ts`, `src/remote/plane.ts`

- Decide whether registration needs an additional probe. Do not trust a declaration alone when the capability depends on a remote fact.
- Keep authorization domains separate: a path probe must not widen object authorization, and an object probe must not become path authorization.
- A digest change should naturally produce `withheld` and require re-registration; verify the UI copy and flow lead the user there.
- If a personal binding is recreated, the `bindingId` incarnation must prevent an old grant from being revived.
- If the capability changes `verifiedTarget`, the grant shape, or registration evidence, check the strict persisted schema and version/incarnation semantics in `records.ts`; `backup-and-skip` is the damaged-record fallback, not a migration design.
- `grantState` / `admit` in `plane.ts` decide withheld/revoked state and purpose admission. When adding a real model action, also check whether `RemotePurpose` in `contract.ts` must expand; a deployment assertion usually must not masquerade as an action.

### 2.7 Runtime admission, tools, and services

The exact files depend on the capability:

- `remoteCapabilitiesOf` / `remotesViewOf` in `src/command.ts`;
- purpose/pairing admission in `src/remote/plane.ts`;
- `src/remote/tools.ts`, `src/remote/tools-registration.ts`, `src/remote/transfer.ts`, `src/remote/exec*.ts`, `src/remote/tool-arguments.ts`;
- independent service contracts, admission, and tokens such as `src/remote/files-contract.ts` / `src/remote/files-service.ts` / `src/remote/files-authorization.ts`;
- channel-opening gates in `src/remote/ssh-environment.ts`;
- the model-visible topology projection in `src/remote/capabilities.ts`. A real model action belongs in `ACTION_ORDER`/`renderBinding`; a non-action deployment assertion such as `directoryListing` must not be projected to the model merely because the UI exposes it.

Rules:

- Every real I/O operation needs authoritative admission before and after the network operation where applicable; the client projection is not authorization.
- A separate channel must still verify host identity, manifest/environment digests, protocol version, and owned-channel lifetime.
- New stable error codes need the error vocabulary, locale `error.*` entries, tests, and docs. Never pass raw SSH text through to the UI.

### 2.8 Browser capability projection and consumers

Locations: `src/remote/panel-contract.ts`, `src/command.ts`, `src/client/ssh-client.ts`, `src/client/remotes-client.ts`, `src/client/remote-files-client.ts`, `src/client/files-tree/providers/resolver.ts`, `src/client/RootSwitcher.tsx`, and the relevant provider/client modules.

- If the browser calls a Host service directly, decide whether it needs an opaque token like `browseAuthorization`, and which digest/epoch/incarnation inputs that token must commit to.
- `remotesViewOf` may mint only while the live manifest and the grant snapshot agree; an asynchronous rebind must not leave a stale view authorized.
- RootSwitcher/providers consume the projection only. They must not infer a capability themselves when the projection is absent.

### 2.9 Every binding-editing surface

This is the easiest layer to incomplete. Check all current entry points:

| Surface | File | What to check |
| --- | --- | --- |
| `+ → Add remote working directory` | `src/client/wizard/add-remote.tsx` | `BindingForm` / `blankBinding` / action coupling / saved draft / confirmation summary / helper-less or transport gate |
| Add/edit connection wizard (boundary check; normally not a home for binding capabilities) | `src/client/wizard/add-connection.tsx`, `src/client/wizard/env-parts.tsx` | these forms own connection-level Helper/exec/transfer; unless the wizard actually creates a binding, do not stuff binding-level fields into the connection form |
| “Add binding” in the bindings dialog | `src/client/wizard/add-binding.tsx` | draft initialization, checkbox coupling, save, confirmation summary |
| Inline edit form for an existing binding | `src/client/ssh-panel.tsx` + `src/client/ssh-draft.ts` | `BindingDraft`, `bindingDraftOf`, existing-binding backfill, action coupling, disabled state and hints |
| “Edit capabilities” in the remote row's `…` menu | `src/client/remote-root-menu.tsx` + `src/client/WorkspaceFoldersAction.tsx` | `CapabilityDraft` backfill, menu item, cross-field clearing, `changed` calculation, save payload, parent refresh/re-registration wiring; **if the field is not exposed, it must still be preserved explicitly rather than dropped** |
| Binding list and confirmation displays | `src/client/ssh-panel.tsx`, both wizard summaries | whether the user can see before saving that the capability will be enabled |
| RootSwitcher / Files rows | `src/client/RootSwitcher.tsx`, providers | how an authorized capability appears and how the disabled reason is expressed |

If a compact menu deliberately does not expose a field, there are only two acceptable designs:

1. preserve the existing field verbatim when saving; or
2. refuse to edit affected bindings there and direct the user to the full editor.

**Silently dropping the field is not acceptable.** That was the original `directoryListing` trap; the quick menu now exposes the option and carries the deployment-assertion warning inside the selectable row itself.

### 2.10 Localization and accessibility

- Synchronize all eight locale files under `src/client/locales/`: `zh/en/ja/es/fr/de/ru/pt`.
- Check at least action names, option names, hints, summaries, error codes, and disabled explanations.
- Run `tests/locale-parity.spec.ts`; do not stop at zh/en.
- A safety precondition must not exist only as visual side text that assistive technology never reaches. The quick menu places the hint inside the selectable row so it becomes part of the menu item's accessible name.

### 2.11 Test matrix

Add tests per layer rather than only a UI snapshot:

- manifest/schema: `tests/remote-manifest.spec.ts`;
- personal store/endpoints: `tests/remote-personal*.spec.ts`;
- verifier: `tests/ssh-verifier.spec.ts`;
- runtime service: `tests/remote-files-service.spec.ts` or the corresponding tool specs;
- Host projection: `tests/command.spec.ts` / remotes-related specs;
- add-remote wizard: `tests/client-ssh-wizard.spec.tsx`;
- bindings dialog, inline editing, quick capability menu: `tests/client-ssh-panel.spec.tsx`;
- locale parity: `tests/locale-parity.spec.ts`;
- shared test doubles: `tests/support/fake-remote.ts`, `tests/support/remote-tools.ts` (otherwise the new field does not exist in large parts of the Host/service test suite);
- real SSH when applicable: `tests/remote-ssh.live.e2e.ts`;
- real browser GUI when applicable: `scripts/live-remote-gui.mjs`.

### 2.12 Documentation synchronization

Check at least:

- user guide: `docs/guide/user/ssh-remote-environments.md` and `.en.md`;
- technical reference: `docs/reference/ssh-remote-environments.md`;
- architecture source of truth: `docs/architecture/file-browsing-providers.md` when browsing/providers are involved;
- ADR: `docs/decisions/ADR-0052-provider-file-browsing.md` or a new ADR;
- the active implementation plan;
- this note only when the checklist itself becomes stale — do not turn it into feature documentation.

## 3. The `directoryListing` example

`directoryListing: 'stable-path'` is a binding-level deployment assertion, not an `action`. Its correct shape is:

- schema: an optional literal in `bindingSchema`, with Host-side enforcement that `read` is present;
- wire: recognized by the `sshBindingSave` request schema, `SshBindingView/Draft`, and the response view schema;
- save: included in the `sshBindingSave` no-op comparison;
- identity: included in the binding digest, so toggling it makes the binding `withheld` and requires re-registration;
- registration: a Helper binding passes the independent SFTP v3 path probe after its object probe;
- runtime: `RemoteFilesService` still probes the canonical path on the owned SFTP channel for every listing and compares authorization before and after I/O;
- projection: `remotesViewOf` mints `browseAuthorization` only for registered + read + opted-in + live-manifest/snapshot-consistent + service-supported endpoints;
- UI: the add-remote wizard, add-binding wizard, inline editor, and quick capability menu can all edit it explicitly; removing `read` clears it; the Host, not the client, is authoritative;
- model projection: it deliberately stays out of the action vocabulary in `src/remote/capabilities.ts`, because it is not a model-tool action;
- docs: the user guide, reference, architecture, ADR, and plan describe the same semantics.

## 4. Recurring traps

1. **Updating the manifest but not the strict wire schema** — the Host rejects the client save.
2. **Updating the request schema but not the view schema** — the post-save state response fails to decode or loses the field.
3. **Missing the no-op comparison** — editing only the new capability becomes a silent no-op.
4. **Updating only the full editor, not the quick menu** — one quick-menu save drops the new capability.
5. **Implementing cross-field cleanup only in the UI** — the Host must reject the invalid combination too.
6. **Defaulting the capability on** — an upgraded old config silently gains new power, which is usually unacceptable.
7. **Conflating object and path authorization** — a Helper dev:ino is an object identity, not evidence of path stability.
8. **Trusting the projection for I/O** — projections are UX; runtime admission is authorization.
9. **Running only client tests** — digest, revocation, and race bugs usually surface in Host/service tests or live e2e.
10. **Updating only one document** — the guide says the capability exists, the reference says it does not, and the ADR keeps the old restriction; the next implementation then copies the wrong contract.
11. **Adding an action only in the UI vocabulary** — `plane.ts`/`RemotePurpose` does not admit it, `capabilities.ts` does not project it, and the tool schema does not know it, leaving the model-facing and Host-facing contracts inconsistent.

## 5. Minimum verification commands

Choose according to scope, but a complete binding-capability change normally needs at least:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm docs:check
pnpm compat:check
pnpm pack:check
pnpm smoke
```

When real SSH or GUI behavior is involved, add:

```bash
PATH="$HOME/.dsh-ssh-test/bin:$PATH" \
  DSH_MULTI_ROOT_SSH_LIVE="$HOME/.dsh-ssh-test/live-ali.json" \
  pnpm exec vitest run tests/remote-ssh.live.e2e.ts

DSH_LIVE_GUI=1 node scripts/live-remote-gui.mjs
```

These live commands depend on local test-environment files. If that environment is unavailable, do not fabricate evidence; record the honest limitation in the plan.
