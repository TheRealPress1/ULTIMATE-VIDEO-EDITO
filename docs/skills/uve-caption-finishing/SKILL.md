---
name: uve-caption-finishing
description: Finish captions for an edited scene by correcting text, preserving synchronization, choosing readable grouping, and checking placement over the actual picture.
metadata:
  version: "1.0.0"
---

# Caption finishing

Establish whether the transcript describes a source recording or the edited scene's audible mix. They use different clocks. Read the [caption reference](../../reference/jsx/captions.md) before modifying timing. Preserve existing reviewed words unless the request or source evidence supports a correction.

For an edited mix, use `captions` with the scene `id`, or the editor's **Generate captions** command. The [captions tool](../../reference/tools/captions.md) transcribes the full scene and saves scene-aligned words. It can update an untrimmed direct caption layer while preserving its style; nested or timed caption layers need manual reconciliation first. Source `transcribe` alone does not account for cuts, overlaps, muted tracks, or changed speed. After a timing edit, regenerate or explicitly remap affected captions; a transcript is a snapshot of what was heard. Preserve manually corrected text when reconciliation is required.

Before regenerating reviewed captions, record their current transcript path and deliberate corrections (for example a name's spelling). Generation saves a new transcript and changes the layer's source; it preserves styling, not the old wording. Compare the old and new text in retained passages, then reapply supported spelling/punctuation corrections while keeping the new word times. Do not copy old timestamps across changed cuts or force words into a passage that was removed. If a correction changes word count or a match is ambiguous, review the source and that short interval before editing. The old transcript remains available for comparison and recovery.

For a single clip at timeline start `S`, source in `I`, and speed `r`, source word time `t` maps to `S + (t - I) / r`, before ancestor-container transforms. Keep only words in the retained source range. Do not use source timestamps as scene timestamps or add the source offset twice. Split caption nodes when the underlying edit skips source material.

Check names, numbers, punctuation, and uncertain recognition against supplied spellings and available evidence. Do not invent inaudible words. Keep spoken meaning intact; cosmetic case or punctuation changes should not rewrite testimony. Local Whisper has no reliable speaker labels.

Choose a supported preset from the [reference](../../reference/jsx/captions.md#presets), respecting the user's style. Use natural phrase grouping where the preset supports it. Do not invent unsupported caption props. Keep text legible at the delivery size and away from faces, essential graphics, and the chosen platform's interface area; safe placement depends on the actual format.

Capture representative lines, the longest line, a speaker change, and both sides of affected cuts. Check entry/exit timing against audio when available. Report unresolved spellings or unverified audio timing instead of declaring automatic recognition perfect.
