---
name: uve-remotion-reference
description: Consult official Remotion references when evaluating a Remotion composition or translating a requested motion treatment into UVE.
metadata:
  version: "1.0.0"
---

# Remotion reference bridge

UVE edits Diffusion Studio JSX and uses its own renderer. Use [UVE's motion graphics skill](../../uve-motion-graphics/SKILL.md) for titles, overlays, transitions, and animation inside an existing UVE project. Remotion's React components and hooks are not valid replacements for UVE elements.

If a user supplies a Remotion example or explicitly requests Remotion work, consult the [official skills](https://github.com/remotion-dev/skills/tree/6c67adcd9cdbe6eb84d76342da89b225f9161cb2) and [Remotion documentation](https://www.remotion.dev/docs). The reference revision is recorded in [the import manifest](../provenance.json); no Remotion source files or runtime are redistributed here because that repository did not declare a license at the reviewed revision.

For reference matching, describe the observed timing, hierarchy, motion, and composition first; recreate the appropriate treatment with UVE's supported tags and animation API. Verify captured frames and transitions in UVE. Do not scaffold another editor, install Remotion, replace a project entry point, or render a separate video just because an upstream guide suggests it. A dedicated Remotion project is a separate workflow chosen by the user.
