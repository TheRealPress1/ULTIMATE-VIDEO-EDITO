---
name: uve-personal-style
description: Apply and maintain the creator's approved editing preferences and reference examples without treating one-off instructions as permanent defaults.
metadata:
  version: "1.0.0"
---

# Personal editing style

Read the current brief, existing project style preferences, and any supplied references before choosing a house style. The current explicit request takes precedence over stored preferences. Treat a reference as evidence about selected qualities, not permission to copy every detail or override the brief.

Record preferences as concrete editable choices: caption preset and placement, fonts, colors, pacing, typical formats, B-roll approach, motion restraint, music treatment, and examples the user approved. Separate an explicit preference from your inference. Do not infer a permanent taste from a single accepted edit, a high-view post, or a default template.

Use `editing_style` with `action: "get"` to read the app's local shared notes and revision. To save, use `action: "set"`, `notes` (at most 8000 characters), and `expectedRevision` from that read. Merge the requested preference with existing notes; a revision conflict requires rereading and reconciling, not a blind overwrite. Save only preferences the user explicitly asked to remember or approved as ongoing defaults. These notes apply across projects, so keep project-specific exceptions in the project brief instead. Do not write global Claude/Codex configuration or store tokens, private account details, or source transcripts in style notes.

When interpreting an example, describe observable choices with timestamps: how a title enters, how long a pause holds, the crop, the density of captions, or how music changes. Distinguish those observations from an inferred mood. Translate the relevant choices into UVE-supported JSX, captions, and animation; do not switch renderers simply because a reference uses another tool.

Apply a small representative section before spreading a new inferred style across a long project. Existing approved edits and source media remain intact. Report significant style changes and any uncertain preference so the user can steer the next iteration.

For exact supported properties, use the [JSX reference](../../reference/jsx/README.md); for animated treatment, use [motion graphics](../uve-motion-graphics/SKILL.md).
