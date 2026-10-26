---
name: uve-audio-finishing
description: Balance dialogue, music, and transitions in a UVE edit using measured levels when available and editable gain envelopes.
metadata:
  version: "1.2.0"
---

# Audio finishing

Identify the audible tracks, intended focus, and requested delivery target. Preserve the source recordings. Work through editable volume, mute, fades, and keyframes first; write processed media to new files if additional processing is required.

Read [audio](../../reference/jsx/audio.md) and [keyframes](../../reference/jsx/keyframes.md). `volume` is decibels: `0` is unity, negative values reduce gain. Keyframes use the node's source clock, so a fade at clip-relative time `t` belongs at `sourceIn + t * playbackRate`. Do not author gain as a linear 0–1 amplitude.

Use `audio_finish` with `action: "measure"` and `sceneId` to measure the actual edited mix: integrated LUFS, true peak, loudness range, sample levels and quiet spans. Use `path` to measure one source. Read the [tool reference](../../reference/tools/audio-finish.md). An individual source measurement does not establish the level of overlapping timeline audio. The legacy `inspect` action remains sample-peak/RMS only.

When peak normalization is appropriate, `audio_finish` with `action: "normalize"`, `path`, and optional `targetPeakDb` writes a uniquely named WAV derivative. It leaves source media and the timeline unchanged. Inspect the returned measurements, then use the derivative in the edit only where intended, preserving source timing and sync. Peak normalization can amplify background noise; do not represent it as dialogue isolation or loudness-standard compliance.

For a finishing pass, use `audio_finish` with `action: "finish"`, the `sceneId`, and explicit `musicIds` for top-level background audio clips. It creates a separate editable scene, preserves original media and timing, processes the remaining dialogue mix into a derivative, and adds music ducking as a parent group volume track. Existing music fades and keyframes remain intact. Optional `levelDialogue` evens out dialogue dynamics; optional `denoise` applies conservative spectral filtering. Ducking follows audio activity, not recognized speakers; review its boundaries and adjust keyframes. A `path` finishing call creates only a derivative.

Keep speech intelligible; lower competing music with an editable `volume` envelope around speech rather than impose abrupt steps. Let ramps follow the phrase and restore music during a meaningful gap when appropriate. Avoid double audio from camera and separate microphone tracks; use [audio synchronization](../../reference/jsx/audio-sync.md) when required.

Use a stated loudness target when supplied. Otherwise explain any selected target as an editorial delivery choice, not a universal platform requirement. Normalization is not denoising. The finished dialogue target does not guarantee the complete mix meets that target after music is added. Inspect returned `mixLoudness`, reduce background or master gain if needed, and measure again. Only claim cleanup, automatic ducking, or loudness compliance after a supported operation and relevant verification.

Review joins, fades, dialogue under music, and the ending with available audio playback. `capture` and a transcript cannot confirm what a mix sounds like. If audio review or measurement is unavailable, report the exact limit. Keep any processing reversible, recheck affected captions if timing changed, and export only when requested.
