# Model context

中文: [model-context.md](./model-context.md)

The plugin adds no tools. It supplies the workspace topology and the additional roots' instruction files so the agent knows which directories it can use.

## Workspace topology

The available directories and how they can be used (primary root and additional roots) are injected into the system prompt and refreshed when grants change. The model does not need an extra introspection tool to know which directories it can read or write.

## Instruction files

An additional root's own `AGENTS.md` / `CLAUDE.md` also reach the model context:

- A top-level file is injected before the session's first step.
- A subdirectory's file is injected after this session has successfully run `read` / `write` / `edit` against that directory; failed operations do not count.
- Delivery state is kept in process memory, so a resumed session may be told again.
- The primary root's chain and the user-global file are handled by DSH itself; this plugin does not inject them a second time.

Instructions are user context, not system authority: they cannot give the agent write access it was not granted.
