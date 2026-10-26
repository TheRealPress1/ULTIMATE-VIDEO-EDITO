# Watching footage

Use this workflow to summarize footage, locate a moment, pull a quote, or check a claim without editing the source. Inspect only the modalities the question turns on: speech, action, music, graphics, or atmosphere. An analysis request does not authorize a new composition or export.

## Local analysis

Probe first to establish duration and whether the asset has video, audio, or both. Stop there for a format or duration question.

Use `waveform` for loud/quiet structure and `filmstrip` for visual structure. A quiet span is not necessarily dispensable, and a filmstrip does not show every action or the exact cut frame.

For speech, use local `transcribe` or reuse an existing transcript. Search the passage and adjacent context; report its source-relative word times. Read the [transcription reference](../reference/tools/transcribe.md) for the two-hour input limit and recognition caveats. For longer inputs, process separate local excerpts within the limit and retain each excerpt's original source offset, including any resampling or speed changes. Deduplicate overlapping excerpts before summarizing.

Use `grab` at the relevant source timestamps to verify visual claims. `auto` can provide a broader visual scan, but sampling does not prove that no short event occurred between frames. Inspect more closely when a conclusion depends on a brief action.

`listen` provides local speech evidence for a window of up to two hours; `transcribe` handles longer source transcripts. Neither identifies or diarizes speakers, describes music or emotion, or verifies that a voice belongs to a named person. The listen prompt is preserved as context, not answered by an audio-language model. State what the transcript and inspected frames establish. Do not describe unheard tone or sound events as observations, assign host/guest labels from an unverified prompt, or present prominent-face reframing as active-speaker tracking.

## Inputs and timing

Media tools take a local path or a direct media URL. A page URL is not a media file. Prefer the user's local source; use an available downloader only when the requested workflow calls for it and access is authorized. Do not assume `yt-dlp` is installed or a service permits every download.

Keep original-source timestamps distinct from an excerpt's local times and from an edited scene's timeline. A range read from `waveform` is already absolute to its input file even when `start`/`end` were supplied. If an excerpt began at source time `B` and was not retimed, an excerpt-local timestamp `t` maps to `B + t` in the original. Do not add an offset twice.

## Answer from evidence

- Ground statements in a transcript passage, inspected frame, or actually reviewed audio; identify uncertainty.
- Give timestamp ranges with a short description so the user can find each moment.
- Preserve context, speaker uncertainty, negation, and qualifications when quoting or summarizing.
- Match the depth of the answer to the question, not the length of the source.
- Use [story selection](./uve-story-selection/SKILL.md) for editorial selects and [editor](./editor.md) when the user asks to change footage.
