---
name: uve-final-review
description: Review a completed or substantially changed UVE edit against the brief, checking structure, cut points, captions, framing, sound on a draft export, and stated verification limits.
metadata:
  version: "1.5.0"
---

# Final review

Scale review to what changed. A small text correction needs a focused check; a new sequence or reframing pass needs review of the affected timeline. Review the current saved composition, not an earlier source listing or an imagined final result.

Run `check` on each affected scene and resolve relevant errors. A `short-visible-stretch` warning is a shot on screen for under 0.4 s between two others, which reads as a flash; fix it as its message says, or say why it stays (see [visible stretches](../../reference/tools/check.md#visible-stretches)). Structural checks cannot assess story, sound quality, every caption, or all visual frames. Read the brief and compare the actual opening, sequence, ending, duration, and format with the requested result. Verify that omitted context has not changed the meaning of a statement.

Use `quality_review` to inspect rendered samples and audio observations. Treat its dark-frame, border, caption-layout, clipping, quiet-pause and join findings as prompts to inspect. Its times are scene-relative; its report states sample coverage and limitations. It does not verify lip-sync or editorial quality. See [rendered review](../../reference/tools/quality-review.md).

Choose captures deliberately: both sides of changed cuts, first and last visible frames, title entrances/holds/exits, longest caption lines, overlaps, and motion extremes. Batch nearby positions. `capture` times are relative to the workarea's first frame; convert a scene time by subtracting the workarea start. A frame outside that workarea may capture successfully but is not part of its export. See [capture](../../reference/tools/capture.md).

For a motion-graphics or social piece, also work through the [review list in motion craft](../uve-motion-graphics/references/craft.md#review). Inspect the images, rather than treating a successful capture call as visual approval. Check crop, legibility, missing media, unintended gaps, layers, and consistency with the reference. Contact sheets are useful for coverage; request fewer frames per sheet for fine text or alignment decisions.

Review the sound on a rendered draft, not on frames. `audio_finish` with `action: "measure"` and the `sceneId` gives the lossless mix's integrated LUFS, true peak and loudness range. Then export a temporary review draft, with an explicit `path` such as `/tmp/<project>-review-v1.mp4` (a draft needs no request; the delivery file does), and run `sound_analyze` on that file:

- `action: "timeline"` with `cues`, the times of the cuts and events you gave sounds to in export time (scene time minus the workarea start): each cue's `offset_ms` is sound minus picture, read against what chance would score, with the loudness curve and the sections;
- `action: "critique"` (`fast: true` takes seconds instead of minutes) scores a launch-style film against professional ranges; a quiet documentary or an interview may rightly fall outside them;
- `action: "measure"` reads the encoded file's loudness and true peak, which the AAC encode can push above the mix's; above the delivery ceiling (usually -1 dBTP), lower the music or scene `volume` and export a new draft.

`listen` on the draft shows whether speech still comes through over music, and its word times can be compared with the captions. Quote the numbers ([how to read them](../imports/earshot-listening/SKILL.md#reading-the-numbers)): they are evidence, not proof, and taste stays the user's call. If a sound tool answers `busy` while its add-on installs, finish the visual review and call it again; where it cannot run, say the sound was not analyzed. Do not claim an audio pass from still images or transcripts. Record exactly what could not be checked.

Fix the largest viewer-facing issue first and recheck the neighboring moments it affects. Do not broaden a review into a redesign or re-render every unchanged frame. Export a delivery file only when the user requested one; review drafts go to a temporary folder, and frame capture remains the visual review path.

Report what was changed, what was checked, and any material unresolved issue. Distinguish structural, visual, auditory, and export verification. Do not claim that an unrendered file was exported or that a sampled review proves every frame is flawless.
