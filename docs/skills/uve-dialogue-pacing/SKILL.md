---
name: uve-dialogue-pacing
description: Tighten spoken footage by choosing takes and adjusting pauses while preserving complete words, reactions, delivery, and meaning.
metadata:
  version: "1.2.0"
---

# Dialogue pacing

Read the current cut and the desired delivery: conversational, reflective, instructional, energetic, or another stated style. Treat pace as a property of the performance. Do not apply one pause duration to every sentence or remove all filler words by default.

Pacing comes in three profiles, chosen in [clean edit](../uve-clean-edit/SKILL.md) from the brief, then `editing_style`, then the format. `tight`, the default for short vertical talking heads, cuts to the audible edges of speech with no handles; follow clean edit for it. This guide is for the `natural` profile (long interviews, podcasts, explainers) and the `reflective` one (emotional or personal material), where breaths, handles and silences belong to the delivery. The handle advice below applies to those two profiles.

Use local word timestamps and a waveform to locate repeated takes, abandoned sentences, long waits, and possible cuts. A transcript gap can contain laughter, a breath, music, or a reaction; a low-amplitude waveform cannot establish that a moment is dispensable. Verify repeated takes for meaning, delivery, continuity, and picture instead of always selecting the last take.

For imported speech sources, `footage_index` and `footage_search` provide persistent source-time passages. When a new assembly or alternative cut is requested, order selected references with their current asset IDs and fingerprints and call `footage_cut`. It creates a new editable scene with captions; use normal timeline edits to refine an existing approved scene. Read the [footage workflow](../../reference/tools/footage.md).

Keep a short source-range edit list for structural changes. Retain the full consonant onset and word tail; in the natural and reflective profiles, allow context-dependent handles around them, such as a breath of up to about 0.25 s at a natural sentence end. Word timestamps are estimates, not frame-accurate cut decisions. Preserve hesitation when it carries meaning, and never remove a negation or qualification to improve rhythm.

Trim source ranges through `sourceIn`/`sourceOut`; place clips with `start`. For rate `r`, a retained source span lasts `(sourceOut - sourceIn) / r` on its parent timeline. See [timing](../../reference/jsx/timing.md), especially nested containers. A retained pause should contain the actual footage or intentional coverage, not an accidental blank gap.

Review changed joins with neighboring sentences. Use `grab` for source frames and `capture` for composed frames. These tools cannot verify sound; use available playback or audio review before claiming a join sounds clean. If auditory review is unavailable, state that limit; in the natural and reflective profiles, also keep conservative handles. A tight cut instead relies on frame-rounded removals, a waveform read at each join and the checks in clean edit.

Re-align captions, B-roll, and music after timing changes. Do not let a clean-looking waveform stand in for an editorial review. Finish with structural `check` and [final review](../uve-final-review/SKILL.md) scaled to the changes.
