# `captions` — caption the edited scene

Generate locally from the scene's complete audible mix, after cuts, speed changes, volume automation and mixing. The resulting word times are scene-relative. Unlike `transcribe`, this tool also attaches the transcript to the scene and waits for the project save to finish.

```json
{ "id": "reel" }
```

`captions` is an MCP tool; the `cutroom` CLI has no command for it.

Returns `{ id, path, segments, words, replacedExisting }`. `path` is a library path under the project's `assets/`, suitable for `<captions src>`. A direct scene caption without authored timing is updated in place, preserving its styling. Otherwise a scene caption is inserted. Existing transcript files and source media are preserved.

The whole scene is used; an export workarea does not trim the transcript. Finish the structural edit before captioning. Then check spelling, names, phrase grouping and readability with `capture`; local transcription is not a guarantee of exact recognition or timing.

Local Whisper supports scenes up to two hours. It renders the edited mix in two-minute sections with overlapping boundaries and saves completed sections against the composition and full media fingerprints. Retrying resumes unchanged sections; captions are attached only after the complete pass succeeds. First use downloads the speech model; subsequent runs use the cached model without uploading media. No speaker identification is performed.

## Errors and cancellation

- No open project, scene ID does not identify a scene, missing audio, or no recognizable speech.
- Timed, nested, or additional caption layers: the tool refuses to stack a new transcript over them. Reconcile those existing layers explicitly before retrying; it does not delete them for you.
- Another scene operation is running, or the project/scene changes during transcription.
- A project save fails. Do not report the captions saved until the save error is resolved.
- Caller cancellation stops encoding/transcription and prevents attaching a late result. If cancellation arrives after a new transcript asset has been written, that asset can remain in the original project, but no source media is overwritten.

For a source-file transcript without changing the scene, use [`transcribe`](./transcribe.md).
