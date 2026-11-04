# transcribe

Transcribe speech in a video or audio file locally and write a JSON transcript with word-level start/end times in seconds. Returns the file's path and its segment and word counts. Useful for talking-head footage and interviews, where word times help locate a line or plan a cut. The current engine does not identify speakers. A transcript marks only speech; the gaps are not necessarily silent (music, score, applause).

| | |
| --- | --- |
| MCP tool | `transcribe` |
| CLI | `cutroom transcribe <path>` |

## Input

| Field | Type | CLI | Description |
| --- | --- | --- | --- |
| `path` | `string`, required | `<path>` | absolute file path or URL (works with or without an open project), or a library path like `b-roll/clip.mp4` (needs an open project) |
| `output` | `string` | `-o, --output <path>` | absolute path to write the transcript JSON to, or an existing folder to write a fresh one into (default: a fresh file under the system temp dir) |
| `start` | `Time` | `-s, --start <time>` | start of the window to transcribe (default: 0) |
| `end` | `Time` | `-e, --end <time>` | end of the window (default: the file's end); at most two hours after `start` |
| `language` | `string` | `-l, --language <code>` | ISO 639-1 code of the spoken language (`en`, `es`, `de`, …); default: detected |
| `quality` | `"fast" \| "accurate"` | `-q, --quality <quality>` | `fast` (Whisper base, the default) or `accurate` (Whisper large-v3-turbo; see below) |

Times are in **seconds** of source/content time, windowed or not: a word 4 s into a window that starts at 1:30 is reported at 94 s. An `output` naming an existing directory gets a fresh `dapi-transcript-*.json` inside it. An existing file at `output` is replaced (a link there is replaced, never written through) inside the project and temporary folders; elsewhere `output` must be a new file or an existing folder in Desktop, Documents, Downloads, Movies, Music or Pictures. Without a window the whole asset is transcribed, up to a limit of two hours per recording. This uses the source file's timing; to caption an edited scene's audible mix, use the [`captions`](./captions.md) tool or **Generate captions** in the editor.

Recognition runs on the Mac with the multilingual Whisper base model. No audio or video is uploaded for transcription. The first use downloads 147,951,465 bytes (about 148 MB) of model weights; the model stays cached for offline use. No speech-service sign-in or API key is required. Development checkouts require the native engine: with Xcode Command Line Tools and CMake installed, run `npm run setup:speech` from the repository root.

Recognition decodes bounded five-minute sections with two-second overlaps. Imported local footage in an open project persists completed sections and transcripts, keyed by full source contents, engine and timing settings. Retrying resumes missing sections after restart. Standalone paths and URLs without a project use bounded extraction but do not have persistent section resume. Changed media or cache eviction requires recognition again; the downloaded model remains cached.

## Windows, languages and the accurate model

- **A window** (`start`/`end`) transcribes only that stretch. For a file in the open project's library whose speech is already indexed (by an earlier whole-file `transcribe`, [`footage_index`](./footage.md) or the Footage panel), the window is cut from the saved transcript instead of being recognized again, with the same absolute times. Otherwise only the window's audio is decoded and recognized. A window that covers the whole file counts as the whole file.
- **`language`** forces the language Whisper listens for instead of detecting it, which helps short clips and accented speech. The footage index holds detected-language transcripts only, so a forced language always runs afresh and is not saved.
- **`quality: "accurate"`** uses Whisper large-v3-turbo: better on names, numbers, accents and noisy rooms, and several times slower than the base model. Its weights, about 1.6 GB, download once, the first time a call asks for this quality, and are never fetched otherwise; they are checked against the hash whisper.cpp publishes and kept for offline use beside the base model. The download shows as the transcription's progress. An accurate transcript runs afresh and is not saved to the footage index. When the download fails the error says so; retry, or use the default quality.

The result names the model (`model: "whisper-base"` or `"whisper-large-v3-turbo"`), the forced `language`, and the window's `start`/`end` when one was given.

## Output

One JSON object, where the transcript went and how large it is:

```ts
{
  path:      string;   // absolute path of the transcript JSON
  segments:  number;   // segments in the transcript
  words:     number;   // words across all segments
  model:     string;   // whisper-base or whisper-large-v3-turbo
  start?:    number;   // the window, when one was given (source seconds)
  end?:      number;
  language?: string;   // the forced language, when one was given
}
```

The file holds the transcript as indented JSON, so it searches line by line: a grep for a phrase lands on its segment's `text`, with the word times in the lines after it. Search it (grep, jq) or read the part you need rather than loading it whole — a long recording's word timings run to tens of thousands of tokens.

```ts
{
  segments: Array<{
    text:     string;   // spoken words only (no silence markers)
    speaker?: string;   // reserved for compatibility; not emitted by the local engine
    words: Array<{ text: string; start: number; end: number }>;  // seconds
  }>;
}
```

## Errors

Fails when the path cannot be resolved, the asset is not video/audio, `start`/`end` cross or the window starts past the end, its audio cannot be decoded, it (or the window) exceeds two hours, the language is not one Whisper knows, or no speech is detected (`No speech detected`, or `No speech detected in this window`). A missing native engine or a failed model download also prevents transcription. Install the engine or retry the download as indicated by the error. Review recognized text and word timing before using it for final captions or precise cuts.
