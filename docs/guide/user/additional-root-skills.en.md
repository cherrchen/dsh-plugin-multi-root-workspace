# Additional-root Skills

中文: [additional-root-skills.md](./additional-root-skills.md)

The plugin discovers Skills inside each additional root and namespaces them so they cannot collide with the primary root or with another additional root.

## Where to put them

Place a Skill in either of these directories under an additional root:

- `.dsh/skills`
- `.agents/skills`

A Skill's name and description are visible from the first model step; the body loads only when the Skill is invoked, so it does not occupy context up front.

## How to invoke them

- Primary-root Skill: `/skill-name`
- Additional-root Skill: `/alias-id:skill-name`, for example `/payments:deploy`
- Slash completion is available, and you can also type the reference manually.
- The model calls Skills through the native `skill` tool. Internal IDs can appear in tool logs; human menus show the namespaced reference.

## Switches

- New `inherit` / `read-write` roots enable Skills by default; `read-only` roots disable them.
- In the **Workspace folders** dialog, the skills button at the end of each row toggles that root independently; the state updates only after the host confirms the save.
- The global switch is on the sidebar **Plugins** → Multi-root Workspace detail page → settings card → **Enable additional-root Skills**. It defaults to on. Turning it off stops new discovery and invocation while keeping each root's own choice; turning it back on restores those choices.
- Primary-root Skills, instructions, LSP, file browsing, and sandbox permissions are unaffected by this switch.

## Aliases and namespaces

- The display Alias is for the list only; renaming it does not change `aliasId`.
- `aliasId` is the stable invocation prefix. Change it with `/workspace-folders alias-id <n|path> <kebab-case>`; it must be unique and at most 48 characters.
- A read-only root still gets no write access from enabling Skills.
