# Watching footage

Use this workflow to summarize footage, locate a moment, pull a quote, or check a claim without editing the source. Check only the parts of the material the question depends on, whether that is what is said, what is shown, the music, on-screen graphics or the mood. An analysis request does not authorize a new composition or export.

## Local analysis

Probe first to establish duration and whether the asset has video, audio, or both. Stop there for a format or duration question.

For a question about the whole video (what happens, a summary, where the strong moments are), run `analyze` on the file next. In one call it returns a timeline of sections with their speech, sampled frames, labels and on-screen text, and quiet spans, plus sound events once the audio add-on is ready; pass the question as its prompt so it ranks the sections that matter. Then `grab` the moments your answer depends on before stating what they show. See [analyze](../reference/tools/analyze.md).

Use `waveform` for loud/quiet structure and `filmstrip` for visual structure. A quiet span is not necessarily dispensable, and a filmstrip does not show every action or the exact cut frame.

For speech, use local `transcribe` or reuse an existing transcript. Search the passage and adjacent context; report its source-relative word times. Read the [transcription reference](../reference/tools/transcribe.md) for the two-hour input limit and recognition caveats. For longer inputs, process separate local excerpts within the limit and retain each excerpt's original source offset, including any resampling or speed changes. Deduplicate overlapping excerpts before summarizing.

Use `grab` at the relevant source timestamps to verify visual claims. `auto` can provide a broader visual scan, but sampling does not prove that no short event occurred between frames. Inspect more closely when a conclusion depends on a brief action.

`listen` provides local speech evidence for a window of up to two hours; `transcribe` handles longer source transcripts. Neither identifies or diarizes speakers, describes music or emotion, or verifies that a voice belongs to a named person; for what music and sound events sound like, `sound_analyze` (`describe`, `timeline`) gives local model readings to quote as evidence, not as hearing. The listen prompt is preserved as context, not answered by an audio-language model. State what the transcript and inspected frames establish. Do not describe unheard tone or sound events as observations, assign host/guest labels from an unverified prompt, or present prominent-face reframing as active-speaker tracking.

## Choosing the lightest pass

Start with the cheapest tool that can settle the question, and add another pass only when the first one leaves a gap.

| The question | Usually enough |
| --- | --- |
| Format, length, which tracks | `probe` |
| Pacing, the quiet or loud parts | `waveform`, with `filmstrip` for the picture's structure |
| What was said, a quote | `transcribe`, or `footage_search` in an indexed project, quoted with its word times |
| Where something is seen | `visual_index` and `visual_search` (keywords, or a description once the CLIP model is downloaded), then `grab` to confirm |
| What the music or a sound is like | `sound_analyze` |
| What happens, a summary | `analyze`, then `grab` at the moments it points to |

## Inputs and timing

Media tools take a local path or a direct media URL. A page URL is not a media file. Prefer the user's local source. For a YouTube, TikTok, Instagram, X, Vimeo, SoundCloud or similar link, `media_download` fetches it inside the app: pass `kind: "video"` when the picture matters (audio is the default). With a project open it lands in the library (`assets/footage/` or `assets/music/`); with none, give an absolute `folder` such as one in Downloads. Then inspect the returned file like any other. For a web image, video or audio file, or a page that declares its media, use `web_media_download` (saved in `assets/web/`). Both record the source. Private, live or region-blocked posts can still fail; report the tool's reason rather than working around it in the shell.

Keep original-source timestamps distinct from an excerpt's local times and from an edited scene's timeline. A range read from `waveform` is already absolute to its input file even when `start`/`end` were supplied. If an excerpt began at source time `B` and was not retimed, an excerpt-local timestamp `t` maps to `B + t` in the original. Do not add an offset twice.

## Answer from evidence

- Ground statements in a transcript passage, inspected frame, or actually reviewed audio; identify uncertainty.
- Give timestamp ranges with a short description so the user can find each moment.
- Preserve context, speaker uncertainty, negation, and qualifications when quoting or summarizing.
- Match the depth of the answer to the question, not the length of the source.
- Write summaries chronologically: split the material into a few parts and open each one with its start time.
- Use [story selection](./uve-story-selection/SKILL.md) for editorial selects and [editor](./editor.md) when the user asks to change footage.
