# analyze

Build one timestamped evidence pack for a whole video or audio file, or a window of it, on this Mac. It is the first call for a whole-video question (what happens, how is it structured, where is something said or shown); the calling agent reads the pack and draws the conclusions, then confirms the moments it acts on with [`grab`](./grab.md) or [`listen`](./listen.md).

| | |
| --- | --- |
| MCP tool | `analyze` |
| CLI | none (MCP only) |

Nothing is uploaded and no account is needed. The pack is assembled from what the single-pass tools measure:

- **Speech**: the project's footage index transcript when the file is indexed ([`footage_index`](./footage.md)), sliced to the window; otherwise local Whisper over the window, as [`transcribe`](./transcribe.md) runs it.
- **Silences**: the quiet spans [`waveform`](./waveform.md) finds.
- **Frames**: picked where the footage settles into a new look (the same scene scan as `grab` with `auto`, which needs WebGPU), then spread so every section has one, within a budget per `depth`. They arrive as up to four timecoded contact sheets, inline over MCP.
- **Labels, on-screen text, people counts**: from the [visual index](./visual.md) when the file has been indexed. Without it, read the contact sheets.
- **Sound events**: from the audio add-on's listening timeline ([`sound_analyze`](./sound.md) `timeline`, low detail), only when that add-on is already installed. When it is not, `analyze` starts its install in the background (about 2.4 GB, no prompt) and finishes the pack without events; a later call includes them.

This is sampled evidence, not watching. Brief events between frames can be missing, and actions, identities, emotions and music are not recognized. The answer always lists its `limitations`.

## Input

| Field | Type | Description |
| --- | --- | --- |
| `action` | `"start" \| "status" \| "cancel"` | `start` (default) analyzes `path`; `status` follows a job; `cancel` stops one |
| `jobId` | `string` | the job to follow or stop, as `start` returned it; required for `status` and `cancel` |
| `path` | `string` | the local video or audio file: an absolute path, or a library path like `footage/talk.mp4` (needs an open project); required for `start`. URLs are refused: download first with [`media_download`](./media.md) or [`web_media_download`](./web-media.md) |
| `prompt` | `string` | what you want to find out, up to 2,000 characters. Its words only rank sections and add frames where they are spoken or seen; it is never run or answered |
| `start` | `Time` | window start, source seconds (default: 0) |
| `end` | `Time` | window end (default: the file's end); at most two hours after `start` |
| `depth` | `"quick" \| "standard" \| "thorough"` | 12 frames on one sheet, 24 on two (the default), or 48 on four; sections at most 12, 24 or 48 |
| `focus` | `Array<"speech" \| "visual" \| "text" \| "audio">` | which evidence to gather (default: all). `visual` and `text` need frames; `audio` is silences and sound events |

```json
{ "path": "footage/interview.mp4", "prompt": "where does she talk about the first bakery", "depth": "standard" }
{ "path": "/Users/me/Movies/launch.mov", "start": "2:00", "end": "4:30", "focus": ["visual", "text"] }
```

## Long files run as jobs

A window up to 10 minutes is answered in the call. A longer one becomes a job: `start` waits about 15 seconds and answers `state: "running"` with a `jobId` and `progress`, unless it already finished (a cached analysis usually has). Follow it with `status`, which waits up to 20 seconds per call, until `state` is `done`, `failed` or `canceled`:

```json
{ "action": "status", "jobId": "analyze-…" }
{ "action": "cancel", "jobId": "analyze-…" }
```

Jobs run one at a time and live in the app until it reloads. A `start` with the same file, window, depth, focus and prompt words while one is running joins it. Running jobs appear in [`context`](./context.md)'s `jobs`.

Each costly step (speech, silences, scene scan, sound events) is saved as it completes in the open project's analysis cache, keyed by the file's full contents and the window. A repeat call, or a `start` after the app restarted, reuses what was done and says `cached: true`. Changing the file starts over. A file outside any open project is not cached.

## Output

While a job runs: `{ state, jobId, method: "local-evidence", progress: { phase, fraction } }`. Once done:

```ts
{
  state: "done";
  jobId?: string;
  method: "local-evidence";
  source: { path; duration; start; end; video: boolean; audio: boolean; width?; height?; frameRate? };
  depth; focus;
  promptKeywords?: string[];       // the prompt's words used for ranking, nothing more
  speech: { origin: "footage-index" | "transcribed" | "none" | "skipped" | "failed"; words: number; note? };
  visual: { origin: "visual-index" | "frames-only" | "none" | "skipped"; samples: number; sampleInterval?; frameSelection: "scene-change" | "even" | "none" };
  audio?: {
    silences: Array<{ start; end }>;   // up to 100
    events: { state: "included" | "installing" | "unavailable" | "skipped" | "failed"; note?; summary?; items?: Array<{ start; end?; labels: string[]; level? }> };
  };
  sections: Array<{
    index; start; end;               // absolute source seconds
    speech?: string;                 // what was said, up to 300 characters
    words: number;
    visual?: { labels: string[]; text: string[]; people: number };   // with a visual index
    silent: boolean | null;          // null when the audio was not measured
    audio?: string[];                // sound events heard in it
    keyframe?: { time; sheet; cell };
    match?: { score; terms: string[] };   // where the prompt's words matched
  }>;
  frames: Array<{ time; timecode; sheet; cell; reason: "scene-change" | "coverage" | "prompt" }>;
  sheets: Array<{ index; timecode; start; end; cells; path }>;   // JPEGs in a fresh temp folder
  suggestedChecks: Array<{ tool; args; reason }>;
  limitations: string[];
  cached: boolean;
}
```

Every time is in **absolute source seconds**, windowed or not: a section that starts 12 s into a window beginning at 2:00 starts at 132. Each sheet cell is labelled with the frame's timecode, and `frames` maps every cell (`sheet`, `cell`, counted from 0) back to its time.

Sections are cut where the footage settles into a new look, or in blocks of up to 30 s where it does not (longer blocks on long windows, so the limit holds); the boundaries are close to cuts, not exact cut points. A section is `silent` when silence covers most of it.

`suggestedChecks` are ready-to-send calls that verify or deepen the pack: `grab` over the sections the prompt matched, or over busy stretches where brief shots may hide between frames; `listen` for exact words; `waveform` for a long quiet stretch; `visual_index` for a library file without labels; `analyze` again with `focus: ["audio"]` once the audio add-on has installed.

## How to use it

- Ask for the whole file first (the default window), read the sections in order, and answer with section start times. Then `grab` the moments a decision rests on.
- For "where is X said", pass X as the `prompt`: matched sections carry `match`, and a prompt frame is added there. For word-exact timing, use [`transcribe`](./transcribe.md) or [`footage_search`](./footage.md).
- For "where is X shown", index the file with [`visual_index`](./visual.md) first; the pack then carries labels and on-screen text per section, and with a description index the prompt also ranks frames by local CLIP similarity.
- For sound ("where is the applause"), sound events need the audio add-on; until it has installed, use [`sound_analyze`](./sound.md) `find`.

## Errors

`invalid-input` for a start without `path`, `status` or `cancel` without `jobId`, a remote file, an empty or inverted window, or a window over two hours; `wrong-kind` for a file with neither video nor audio; `not-found` for an unknown or forgotten `jobId` (start again: completed steps come from the cache). A failed step does not fail the pack: speech that could not be transcribed is reported as `speech.origin: "failed"` with its reason in `limitations`, and missing frames are noted the same way.
