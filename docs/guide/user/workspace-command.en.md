# Command: managing additional roots

中文: [workspace-command.md](./workspace-command.md)

`/workspace-folders` is the text entry point for additional roots and works in Web, Desktop, and headless runs. With no arguments it behaves like `list`. `/add-dirs` is a shortcut for `add`.

## Command reference

```text
/workspace-folders [list]                                                   # list the primary root and the additional roots (access and state included)
/workspace-folders add <absolute path> [--inherit|--read-only|--read-write] # no path opens the directory picker; new roots default to inherit
/add-dirs [absolute path] [--inherit|--read-only|--read-write]              # shortcut for /workspace-folders add
/workspace-folders remove <n|path>                                          # n is the number list prints
/workspace-folders access <n|path> inherit|read-only|read-write             # switch access
/workspace-folders alias <n|path> [name]                                    # omitting the name clears the alias
/workspace-folders alias-id <n|path> <kebab-case>                           # edit the stable Skills namespace
/workspace-folders skills <n|path> on|off                                   # toggle this root's Skills
/workspace-folders reveal <n|path>                                          # show it in the file manager
/workspace-folders isolate-profiles [--apply]                               # inspect (--apply writes) profile import methods
/workspace-folders help                                                     # show the command help
```

## Adding a root

- Without a path, `add` opens the system directory picker (when the host provides one). You can also pass only the access flag, for example `/workspace-folders add --read-only`, and pick the directory afterwards.
- Paths may be quoted and `~` expands to your home directory. The path is canonicalized before registration: a duplicate, a path nested inside an existing root, the workspace root itself, and protected paths such as `$DSH_HOME` or the Registry storage directory are rejected.
- A new root defaults to `inherit`, which follows the session's sandbox mode.

## Checking state

`list` shows the primary root and every additional root with its path, display alias, access level, and state, plus the number registered and how many are writable under the current mode.

When a directory is temporarily missing (`missing`) or has been replaced by a link pointing elsewhere (`redirected`), the registration stays but access is withheld. Restore the directory or link, then run `list` again or refresh the **Workspace folders** dialog; it recovers without a restart.

## Referring to a root

`remove`, `access`, `alias`, `alias-id`, `skills`, and `reveal` accept `n|path`: the number `list` prints, or the path (quoted if needed).

- `alias` changes the display name only; omitting the name clears it.
- `alias-id` changes the prefix used for Skills. It must be unique, kebab-case, and at most 48 characters.
- `skills` only controls whether the root offers Skills; it does not change write access.
- `access` switches the level; widening (to `inherit` or `read-write`) requires the root to be available right now.

## Troubleshooting

- `Root registry unavailable`: another DSH process holds the registry store. Close that process, then run the command again or choose **Retry**.
- A root shows `missing` / `redirected`: restore the directory or link and run `list` again; the registration is not deleted automatically.
- Command output is always English, because the host-side command handler has no interface language; dialog copy follows the interface language.

## isolate-profiles (Windows restricted Full-access)

`/workspace-folders isolate-profiles` is a read-only check by default: it lists each profile's `packageImportMethod` under `$DSH_HOME` and scans how profile dependencies are linked. With `--apply` it writes `packageImportMethod: copy` into every profile's `pnpm-workspace.yaml` that can be fixed.

The command changes configuration only. It never deletes `node_modules` and never reinstalls dependencies; existing hard links become copies only after you follow the reported reinstall steps. Use it to locate and repair the profiles behind a refused restricted Full-access preflight.
