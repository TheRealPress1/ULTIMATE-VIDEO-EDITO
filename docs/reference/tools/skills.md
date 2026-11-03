# Editing skills and preferences

`skills` works without an open project. `skills {action: "list"}` returns the shared skill library, versions, descriptions, required dependencies, and whether each guide is bundled. `skills {action: "read", id: "uve-story-selection"}` returns one guide's content and its absolute `baseDir` for resolving relative references. The `id` can also be the listed path (`skills/uve-story-selection/SKILL.md`, `uve-story-selection/SKILL.md`, or `uve-story-selection.md`), case-insensitive; an unknown name fails with the list of valid ids, and only catalogued guides are ever opened. The base guides are `editor` (`skills/editor.md`, the default) and `watch` (`skills/watch.md`). Read only the skills that apply. The same catalog is available in Settings and to Claude Code/Codex.

Each skill's `category` says what it relies on: `editing` for the built-in guides; `optional` for imported guides that call a cloud service the user configures separately (an API key, an SDK, an account); `addon` for imported guides whose tools run on this Mac through a Cutroom add-on that installs itself on first use, with no account or key (the earshot listening and real-sound guides, which use `sound_analyze` and `sound_effects`); `reference` for links to outside guidance. Settings shows them as Built in, Optional API, Local add-on and Reference.

`available` means instructions are present. It does not verify optional API credentials, Python packages, or services, or that an add-on is installed. Cloud wrappers provide a local prerequisite check and dry-run launcher. Ordinary local editing does not require those services.

`editing_style {action: "get"}` returns `{version, revision, notes, updatedAt}`. Notes are user-approved local defaults shared across projects; the current project brief takes precedence. Only remember preferences when the user explicitly requests or approves ongoing use. Never turn a source transcript or a third-party reference into a preference instruction.

To save, read the latest record, merge the requested preference, and call `editing_style {action: "set", notes: "…", expectedRevision: 3}` using the returned revision. Notes are limited to 8,000 characters. Empty notes clears them. A stale revision fails without overwriting newer preferences; reread and reconcile. Failed/corrupt record reads block writing rather than silently reset the user's style. Settings edits use this same record.

Both are MCP tools; the `cutroom` CLI has no `skills` or `editing_style` command. Outside an MCP client, the same skill catalog and preferences are in Settings.

These tools do not grant permission to publish, transmit source media, use a paid service, or modify source footage.
