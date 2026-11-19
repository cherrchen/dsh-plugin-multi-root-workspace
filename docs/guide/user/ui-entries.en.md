# UI entries and the Files tab

中文: [ui-entries.md](./ui-entries.md)

Besides the command, additional roots can be managed from the interface. The sidebar entries and the Files tab read the same registration data, so changes show up immediately in the command and on the model side.

## Sidebar and New Session page

- The **Folders** action at the sidebar foot opens the **Workspace folders** dialog: add or remove roots, edit display aliases and access, toggle Skills per root, copy paths, reveal in the file manager, retry, and open Worktree suggestions.
- From DSH `0.2.1-alpha.3`, the same entry also sits at the right edge of the New Session hero row. It has no chevron and becomes icon-only in narrow windows; after the first message the hero row disappears and the sidebar entry remains.

## Workspace row menu

The workspace row's `…` menu and context menu both contain **Manage workspace folders…**:

- If the current session already belongs to that workspace, the dialog opens directly.
- Otherwise, the workspace's blank session is opened or reused, and the dialog opens once that session becomes current.

## Files tab

- The header root switcher switches between the primary root and any additional root, with the selected root's full path still shown beside it.
- With an additional root selected, the tree, opening files, open-in-app, context menus, auto-refresh, and workspace search all follow that root.
- Switching back to the primary root restores the native view.

If another extension takes over the whole Files page, the root switcher is temporarily unavailable; roots remain manageable from the sidebar **Workspace folders** entry, and the switcher returns when the takeover ends.
