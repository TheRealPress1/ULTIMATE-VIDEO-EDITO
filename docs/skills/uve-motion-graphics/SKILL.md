---
name: uve-motion-graphics
description: Create editable titles, overlays, and motion graphics in UVE using native JSX, deliberate timing, and deterministic animation.
metadata:
  version: "1.0.0"
---

# Motion graphics

Match the brief and stored style. Use motion to direct attention or connect ideas. A title, label, or graphic should support the footage; do not add decorative copy or a new visual system to a simple trim request.

UVE compositions use `@diffusionstudio/jsx` and Solid, not Remotion React components. Imported Remotion guidance may inform composition and timing, but its components, hooks, Studio commands, and rendering pipeline are not drop-in UVE APIs. Keep the edit in the user's existing renderer and project.

Read the relevant [JSX reference](../../reference/jsx/README.md), [HTML graphics reference](../../reference/jsx/html.md), and [easing guide](../../guides/motion/easings.md). Prefer native text and shapes for simple elements. Use `<html>` for complex layout, with a paused anime.js timeline driven by `useTicker()` for deterministic animation. The ticker uses seconds; anime.js `seek` takes milliseconds.

Give sourceless elements explicit `start`/`end` values when their lifetime matters. Keep entrance, readable hold, and exit distinct. Keyframes use the holding node's source-local clock; see [keyframes](../../reference/jsx/keyframes.md). Avoid wall-clock timers, unseeded randomness, or `Date.now()` in anything that determines the rendered tree or animation state.

Expose meaningful copy, color, size, and padding choices as top-level `@inspect` constants where supported. Keep footage as native video/audio elements outside HTML paint hosts. Check the HTML reference's rasterization limits before choosing wrapper scaling, clipping, or nested opacity.

Capture the entrance midpoint, hold, exit midpoint, and an overlap with footage. Check text at delivery size, including the longest actual copy. Preserve live editability and the project's established style; do not start a separate Remotion project to accomplish a UVE overlay.
