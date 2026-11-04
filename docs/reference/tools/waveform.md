# waveform

Render the audio track of a video or audio file as a waveform PNG (local render, no credits) with a timestamp ruler: loudness over time, with silent stretches highlighted in red. A fast, token-efficient audio track preview; the silent spans are also returned as second ranges.

| | |
| --- | --- |
| MCP tool | `waveform` |
| CLI | `cutroom waveform <path> [options]` |
| CLI aliases | `cutroom wave` |

## Input

| Field | Type | CLI | Description |
| --- | --- | --- | --- |
| `path` | `string`, required | `<path>` | absolute file path or URL (works with or without an open project), or a library path like `b-roll/clip.mp4` (needs an open project) |
| `start` | `Time` | `-s, --start <time>` | start of the window — seconds ("1.5"), frames ("45f"), or "MM:SS" (default: 0) |
| `end` | `Time` | `-e, --end <time>` | end of the window — seconds ("1.5"), frames ("45f"), or "MM:SS" (default: asset duration) |
| `output` | `string` | `-o, --output <path>` | absolute path to write the PNG to (default: a fresh file under the system temp dir) |
| `scale` | `number` | `-x, --scale <factor>` | scale factor for the thumbnails; smaller fits more rows and columns, larger fits fewer (default: 1) |
| `silence.thresholdDb` | `number` | `--silence-db <db>` | peak level in dBFS, −70 to −20, at or below which audio counts as silent (default: about −53) |
| `silence.minSeconds` | `number` | `--silence-min <seconds>` | shortest silent stretch reported, 0.05–5 s (default: 0.4) |

Loudness over time is drawn from decoded audio peaks. An `end` past the asset's duration is clamped to it; a `start` at or past the end is an error, since the window would be empty. Tick labels use `HH:MM:SS:FF` timecode (hours, minutes, seconds, frame within the second) at every zoom level, so labels stay comparable regardless of the window's span. For a video, frames count against the video's frame rate; for a standalone audio asset, the ruler counts against a nominal 30 fps.

The overall canvas size stays fixed, so a smaller `scale` (clamped to `0.25`–`4`) fits **more rows and columns** — a denser time axis — and a larger one fits fewer but taller rows. Without `output` the PNG lands in a fresh file under the system temp directory; an `output` naming an existing directory gets that fresh file inside it. An existing file at `output` is replaced (a link there is replaced, never written through) inside the project and temporary folders; elsewhere `output` must be a new file or an existing folder in Desktop, Documents, Downloads, Movies, Music or Pictures.

## Silent stretches

A stretch is silent when every decoded peak in it stays at or below the threshold for at least the minimum length. The defaults suit an overview: about −53 dBFS peak for 0.4 s. Around a join in a tight talking-head cut, narrow the window to a second or two either side and pass `silence: { "minSeconds": 0.12 }` to see the short gaps the default skips. In a noisy room, room tone can sit above the default level and hide every pause; raise `thresholdDb` toward −40 until the pauses show while the words stay white. The threshold is a peak level, so it reads a few dB higher than an RMS threshold such as `transcript_edit_inspect`'s for the same room. An empty `silences` list is not proof there is nothing to tighten: check the picture of the waveform too.

## Output

One JSON object: the absolute path to the written PNG plus the silent stretches (the red spans on the waveform) as `[start, end]` second ranges, in absolute seconds (offset by `start` when a window is used). Over MCP the image also arrives inline when it is under a megabyte.

```ts
{
  path: string,   // e.g. "/tmp/dapi-waveform-3f2c1a8e-….png", or the `output` path
  silences: Array<{ start: number, end: number }>,
  silenceThresholdDb: number,  // the peak level used, in dBFS
  silenceMinSeconds: number,   // the minimum length used, in seconds
}
```

## Errors

Fails when the path can't be resolved, the asset has no decodable audio track, the window is empty (`start` at or past the asset's end) or crosses (`start` >= `end`), `scale` isn't a positive number, or the PNG can't be written.
