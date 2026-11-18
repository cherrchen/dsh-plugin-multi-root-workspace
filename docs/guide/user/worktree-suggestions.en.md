# Worktree root suggestions

中文: [worktree-suggestions.md](./worktree-suggestions.md)

When the primary root is itself a Git worktree root, the plugin discovers the repository's other worktrees and offers them as candidates; after you confirm, they are registered as additional roots. If the session is itself a linked worktree under `workspace-write`, the repository's main checkout is a candidate too, in the same card.

Discovery reads Git metadata only (the `.git` pointer, the admin directory, the common config/HEAD/index, and the ancestor chain). It starts no Git subprocess and **never adds or removes a root on its own**.

## Enabling it

Sidebar **Plugins** → Multi-root Workspace detail page → settings card → **Enable worktree root suggestions**. It is off by default. Turning it off stops discovery, prompts, and dedicated cleanup; roots already registered stay under ordinary root management.

## Prompts and confirmation

- When candidates exist, a persistent card appears with **View** and **Remind me later** (until a new worktree appears / in 7 days / in 30 days).
- The card's close button dismisses only this notice; it returns after a restart. Choosing **Never remind me again** in the confirmation dialog ignores it for good.
- After the notice closes, reopen it from **Worktree suggestions** beside **Retry** in the **Workspace folders** dialog.
- The confirmation dialog lists each candidate's path, detected branch, and access. Access defaults to `inherit` and can be changed per row to read-only or read-write; when several candidates exist you can check multiple rows.
- The main checkout row additionally states its scope: the main checkout's source tree, shared config/hooks/refs/objects, and every worktree's admin data, which may affect other checkouts of the same repository.
- A registration is workspace-wide: other read-write sessions in the same workspace also gain the chosen access.
- Confirmation re-validates every row inside the serialized queue; any change while the dialog is open invalidates that row, and the remaining rows continue.

A `danger-full-access` session gets no prompt; a `read-only` session sees ordinary worktree candidates only, never the main checkout.

## Removal and cleanup

- When a worktree is deleted or moved, the dialog shows a badge, but **nothing is cleaned up automatically**.
- Cleanup is offered only when the registered path is confirmed missing and the registration identity is unchanged: the batch entry sits on the **Secondary working directories** title row, and a per-row entry sits at the end of each eligible row.
- Cleanup requires confirmation in a dialog layered over the workspace dialog. Before cleanup, a new directory at the same path can inherit the old grant; the confirmation dialog discloses that risk.
- Use the ordinary **Remove** to revoke a registration you no longer want; the dedicated cleanup only covers tracked worktree roots.
