# Access levels

中文: [access-levels.md](./access-levels.md)

Each additional root has its own access level. The level decides write access only; it never limits reading. New roots default to `inherit`.

## The three levels

| Access level | `workspace-write` session | `read-only` session | `danger-full-access` session |
| --- | --- | --- | --- |
| `inherit` | writable | refused | unrestricted |
| `read-only` | refused | refused | refused (including Full-access) |
| `read-write` | writable | writable | writable |

## Switching levels

- Command: `/workspace-folders access <n|path> inherit|read-only|read-write`.
- Dialog: open the access menu on a row in **Workspace folders** and choose a level. Widening asks for confirmation.
- Widening (to `inherit` or `read-write`) requires the root to be available; restore a `missing` or `redirected` root first.

## One-shot escalation

When you approve `danger-full-access` for a single tool call, that call may write an otherwise read-only additional root and is not limited by a per-tool cap. It applies to that call only; the `$DSH_HOME` protection and the unavailable-Registry downgrade still apply.

## Scope of a change

- An access change constrains only later calls and new processes. Running processes and persistent terminals keep the access they started with; restart the terminal to pick up a change.
- A primary root accepts at most 16 additional roots. The host's `maxAdditionalRoots` setting can raise the limit to 64; new additions beyond the limit are refused, while existing registrations stay.
- The host may permanently cap a tool for all additional roots with `toolAccess` on the `multi-root-scope` row. For example, `{ bash: 'read-only' }` keeps bash from writing any additional root while it can still write the primary root.
- Enabling Skills on a read-only root grants no write access; the Skills switch and the access level are independent.
