---
name: uve-final-review
description: Review a completed or substantially changed UVE edit against the brief, checking structure, cut points, captions, framing, and stated verification limits.
metadata:
  version: "1.3.0"
---

# Final review

Scale review to what changed. A small text correction needs a focused check; a new sequence or reframing pass needs review of the affected timeline. Review the current saved composition, not an earlier source listing or an imagined final result.

Run `check` on each affected scene and resolve relevant errors. Structural checks cannot assess story, sound quality, every caption, or all visual frames. Read the brief and compare the actual opening, sequence, ending, duration, and format with the requested result. Verify that omitted context has not changed the meaning of a statement.

Use `quality_review` to inspect rendered samples and audio observations. Treat its dark-frame, border, caption-layout, clipping, quiet-pause and join findings as prompts to inspect. Its times are scene-relative; its report states sample coverage and limitations. It does not verify lip-sync or editorial quality. See [rendered review](../../reference/tools/quality-review.md).

Choose captures deliberately: both sides of changed cuts, first and last visible frames, title entrances/holds/exits, longest caption lines, overlaps, and motion extremes. Batch nearby positions. `capture` times are relative to the workarea's first frame; convert a scene time by subtracting the workarea start. A frame outside that workarea may capture successfully but is not part of its export. See [capture](../../reference/tools/capture.md).

Inspect the images, rather than treating a successful capture call as visual approval. Check crop, legibility, missing media, unintended gaps, layers, and consistency with the reference. Contact sheets are useful for coverage; request fewer frames per sheet for fine text or alignment decisions.

Review changed audio joins, music balance, and caption synchronization through available audio playback or supported analysis. Do not claim an audio pass from still images or transcripts. Record exactly what could not be checked.

Fix the largest viewer-facing issue first and recheck the neighboring moments it affects. Do not broaden a review into a redesign or re-render every unchanged frame. Export only when the user requested an output file; frame capture is the visual review path.

Report what was changed, what was checked, and any material unresolved issue. Distinguish structural, visual, auditory, and export verification. Do not claim that an unrendered file was exported or that a sampled review proves every frame is flawless.
