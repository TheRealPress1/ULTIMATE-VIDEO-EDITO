# Editing with UVE / Cutroom

The open project is the document: its JSX becomes editable video, audio, captions, and graphics. Use `context` to confirm the project and scene before changing files. Continue the current project unless the user requests a new one. Preserve source media, approved edits, unrelated changes, and stable scene/node IDs.

## Choose the relevant workflow

Use `skills` with `action: "list"` to see the bundled skill library, and `action: "read", id: "uve-story-selection"` (or the relevant ID) to read one. The same library is available to Claude Code and Codex. Load only the workflows needed for the request:

- [Story selection](./uve-story-selection/SKILL.md): choose moments and assemble a coherent narrative.
- [Dialogue pacing](./uve-dialogue-pacing/SKILL.md): choose takes and tighten pauses without damaging delivery.
- [Caption finishing](./uve-caption-finishing/SKILL.md): correct text, timing, grouping, and placement.
- [Social reframing](./uve-social-reframing/SKILL.md): create intentional aspect-ratio variants.
- [Audio finishing](./uve-audio-finishing/SKILL.md): balance tracks and review transitions.
- [Personal style](./uve-personal-style/SKILL.md): apply the creator's approved preferences.
- [Motion graphics](./uve-motion-graphics/SKILL.md): create editable titles, overlays, and deterministic animation.
- [Performance insights](./uve-performance-insights/SKILL.md): turn available Instagram observations into testable edit variants.
- [Final review](./uve-final-review/SKILL.md): inspect a substantial edit against the brief.

Read `editing_style` with `action: "get"` when making style decisions. The current brief overrides stored defaults. Store new preferences only when the user explicitly wants them remembered; use the [personal-style workflow](./uve-personal-style/SKILL.md).

## Understand the available media

- `probe` establishes tracks, duration, and dimensions before choosing media operations.
- Local `transcribe` produces source-relative word timestamps. It does not identify speakers or interpret emotion. Reuse existing transcripts when suitable and search the relevant passages instead of loading an entire long transcript.
- `waveform` and `filmstrip` give coarse structure; they do not establish exact cut quality or whether a pause is expendable.
- `grab` samples source frames. Use transcript timestamps or visual changes to choose positions, then inspect the images. A filmstrip alone cannot verify fine framing or caption readability.
- `captions` transcribes an edited scene's audible mix and creates or updates its caption layer. Read the [tool reference](../reference/tools/captions.md) for replacement limits; source transcription alone does not follow timeline edits.
- `audio_finish` inspects decoded samples or creates a peak-normalized WAV derivative. Its measurements are sample peak/RMS, not LUFS or true peak. See [audio finishing](../reference/tools/audio-finish.md).

`listen` returns local speech evidence for windows up to two hours, including relative and source word times. It does not answer semantic audio questions, diarize speakers, infer host/guest identities, identify music or track the active speaker. A prompt naming a person is not evidence that a voice belongs to them. Use transcript timing and inspected frames for editorial decisions. For visible-speaker framing use `reframe` with `mode: "speakers"`; its separate audio/video model holds briefly or widens when uncertain. Plain face-follow mode follows a prominent face without active-speaker evidence. Hosted generation and speech services may be unavailable and are not unlocked by Claude Code/Codex subscriptions. Local SAM segmentation is a separate on-device operation. Check the catalog before choosing optional operations.

## Build the edit

For a substantial edit, keep a brief or edit plan in the project with the intended story, duration, format, and source ranges. For a small correction, the user's request is sufficient. Lay out the A-roll first; then add supporting footage, sound, captions, and graphics where they serve the brief.

The [timing reference](../reference/jsx/timing.md) separates parent-timeline `start`/`end` from `sourceIn`/`sourceOut`. Give clips explicit starts inside named sequences; a sequence does not arrange its children automatically. Preserve meaningful pauses as actual footage or intentional coverage. Keep captions and audio synchronized after structural edits.

Use the project's asset library and existing naming conventions. Link or copy media into `assets/` as appropriate for portability; do not move, overwrite, or delete original recordings. Check that files are locally readable. If a cloud placeholder is unavailable, request a local download rather than move the user's project or silently replace media.

Use native media and caption tags. For graphics, read [HTML graphics](../reference/jsx/html.md) and [easings](../guides/motion/easings.md). Choose animation for its purpose; linear easing can be correct for constant-speed motion. Hoist meaningful style controls into supported `@inspect` constants. Follow the user's branding and approved style; the [house style](../brand/README.md) is only a fallback.

## Verify the result

Run `check` on affected scenes. Use `capture` to inspect actual composed frames at changed cuts and important visual moments; its times are relative to the workarea start. A clean save or structural check does not prove a good-looking or good-sounding edit. Still frames cannot verify audio joins. State material limits when audio review is unavailable.

Scale verification to the change. Repair the largest viewer-facing issue and recheck nearby moments. Use `logs` and `screenshot` for app problems. `capture` is the visual confirmation path; export only when the user requests an output file.

Use the installed [JSX reference](../reference/jsx/README.md), [tool reference](../reference/tools/README.md), and [examples](../examples/README.md) instead of guessing APIs. Worked examples: [talking head](../guides/walkthroughs/talking-head.md) and [podcast clip](../guides/walkthroughs/podcast-clip.md).
