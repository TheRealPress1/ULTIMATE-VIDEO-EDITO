# listen

Inspect speech in a local audio/video window with the bundled Whisper engine. No media is uploaded, and no upstream audio account is needed. This tool returns transcription evidence; it does not perform full semantic audio analysis. For tone, music and how a voice sounds, the user's opt-in [`ask_gemini`](./ask-gemini.md) asks Gemini about the sound, at the price of uploading it to Google; this tool never does.

| | |
| --- | --- |
| MCP tool | `listen` |
| CLI | `cutroom listen <path> [options]` |

## Input

| Field | Type | CLI | Description |
| --- | --- | --- | --- |
| `path` | `string`, required | `<path>` | Absolute local media path or an imported library path. Remote URLs are not supported. |
| `prompt` | `string` | `-p, --prompt <str>` | Editing question preserved as context for the calling agent. It does not enable semantic listening or identity inference. |
| `start` | `Time` | `-s, --start <time>` | Source window start; defaults to zero. |
| `end` | `Time` | `-e, --end <time>` | Source window end; defaults to media duration, capped at the source end. Choose a window of at most 7200 seconds. |

The local speech engine recognizes words and approximate timing. It cannot diarize voices, recognize a speaker, assign host/guest roles, identify music, identify the active speaker, describe non-speech sounds, or infer emotion. A prompt asking who is speaking receives speech evidence and these limitations, never invented speaker labels. Use `transcribe` for longer source transcripts.

For “follow whoever is speaking,” use `reframe` with `mode: "speakers"`. That separate local audio/video model follows a supported visible speaker and holds briefly or widens when uncertain. It does not assign real identities or diarize off-camera voices. Review the resulting framing and coverage. Source transcription uses bounded five-minute sections; a full imported local source in an open project can reuse saved sections across restarts. Arbitrary windows do not persist checkpoints. Prefer `transcribe` for a long transcript so the result stays in a searchable file.

## Output

```ts
{
  result: string,
  method: "local-speech-transcription",
  start: number,
  end: number,
  timestampOrigin: "window",
  requestedPrompt?: string,
  segments: Array<{
    text: string,
    start: number,
    end: number,
    sourceStart: number,
    sourceEnd: number,
    words: Array<{
      text: string,
      start: number,
      end: number,
      sourceStart: number,
      sourceEnd: number
    }>
  }>,
  limitations: string[]
}
```

Top-level `start`/`end` always identify the analyzed source window. Segment and word `start`/`end` count from the window start; `sourceStart`/`sourceEnd` count from the source's time zero. For a window starting at 10 seconds, a word at relative 0.5 seconds has `sourceStart: 10.5`. Words crossing the requested end are clipped to the window.

An empty `segments` array means no recognizable speech was returned. It does not prove silence; music or other sound can still be present. Review recognized words and timings against the original before precise edits.

## Errors

Fails for remote media, unsupported asset types, missing audio, invalid or empty windows, windows longer than two hours, cancellation, a changed open project, or an unavailable local speech runtime. Local processing never falls back to an uploaded paid model.
