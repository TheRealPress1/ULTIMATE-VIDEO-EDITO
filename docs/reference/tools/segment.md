# segment (SAM 2.1)

Mask an object in a video with SAM 2.1 and track it through the footage, making the mask file (`.mask`) a [`<mask src>`](../jsx/masks.md#mask-files) names: text behind a person, a grade on one subject, an object cut out. It is the same file the editor's object mask tool makes. It runs in the app, on this machine's GPU: no account, no credits.

| | |
| --- | --- |
| MCP tool | `segment` (the direct way) |
| Also | `sam-2.1` through [`generate`](./generate.md): `cutroom generate sam-2.1 '<fields>' [-o <path>]` |
| CLI | `segment` itself is MCP-only; the CLI reaches the model through `generate` |

Both routes run the same [local model](../models.md#local) job with the same checks; `job` polls and cancels either one, and the job lasts only as long as the app. Prefer `segment`: it can wait for the track and answers with one flat object instead of a job to dig through.

## Input

| Field | Type | Description |
| --- | --- | --- |
| `path` | `string`, required | the video: an absolute path, or a library path like `footage/skater.mp4` (needs an open project) |
| `time` | `Time`, required | the frame the prompts are placed on, in source time: seconds (`"1.5"`), frames (`"45f"`), or `"MM:SS"` |
| `points` | `{ x, y }[]` | points on the object, each in 0..1 of the frame |
| `exclude` | `{ x, y }[]` | points on what is not the object, to take it out of the mask |
| `box` | `[x0, y0, x1, y1]` | a box around the object, in 0..1 of the frame |
| `preview` | `boolean` | segment only the frame at `time` and make no mask: for checking a prompt before tracking |
| `start` | `Time` | start of the span to track (default: 0) |
| `end` | `Time` | end of the span to track (default: the file's end) |
| `size` | `string` | the model's size, from the table below (default: `tiny`) |
| `output` | `string` | the mask file: a library path like `masks/skater.mask` (needs an open project) or an absolute path (default: see [Tracking](#tracking)) |
| `wait` | `boolean` | hold the call until the track has ended (default: `false` for a library mask, `true` for an absolute `output`) |
| `timeoutSeconds` | `integer` | with `wait`, answer after this long with the job still tracking (default 600, at most 3600) |

Through `generate`, the request is `model: "sam-2.1"` with `video: { path }` in place of `path`, the same other fields, and `output` as [`generate`](./generate.md#where-the-files-go)'s; `wait` and `timeoutSeconds` are `segment`'s own.

| Size | | Download | Per tracked frame |
| --- | --- | --- | --- |
| `tiny` | fastest; the default | 83 MB | about 0.25 s |
| `small` | | 112 MB | about 2 s |
| `base-plus` | | 183 MB | about 2.6 s |
| `large` | finest edges, best on small objects | 475 MB | about 4.5 s |

## Prompting

A prompt needs at least one point on the object or a box around it; `exclude` points only take things away. Coordinates are fractions of the frame as it displays (rotation applied, x right, y down), the same space [`grab`](./grab.md) frames are drawn in. A box is usually the most reliable first prompt: draw it around the object as seen in a grabbed frame. When the mask spills onto something next to the object, add an `exclude` point on that thing; when it misses part of the object, add a point on the missing part.

With `preview: true`, the frame alone is segmented and the answer comes at once with `state: "previewed"`: no file, and as `image` the frame with everything outside the mask washed magenta, its edge outlined, the prompts drawn (`+n` on the object, `−n` off it, the box dashed) and a 0.1 grid to read coordinates off; over MCP the picture also arrives inline. Its `bbox`, `area`, `score` and `iou` say what was found. The first preview of a frame encodes it, which takes a moment; further previews on the same frame, file and size return at once. A preview makes no mask, so it takes neither a span, an `output` nor `wait`.

```json
{ "path": "footage/skater.mp4", "time": 2.4, "box": [0.38, 0.18, 0.66, 0.96], "preview": true }
{ "path": "footage/skater.mp4", "time": 2.4, "box": [0.38, 0.18, 0.66, 0.96], "exclude": [{ "x": 0.52, "y": 0.92 }], "preview": true }
{ "path": "footage/skater.mp4", "time": 2.4, "box": [0.38, 0.18, 0.66, 0.96], "exclude": [{ "x": 0.52, "y": 0.92 }], "start": 2, "end": 9, "output": "masks/skater.mask" }
```

The same through the CLI:

```bash
cutroom generate sam-2.1 '{"video":{"path":"footage/skater.mp4"},"time":2.4,"box":[0.38,0.18,0.66,0.96],"preview":true}'
cutroom generate sam-2.1 '{"video":{"path":"footage/skater.mp4"},"time":2.4,"box":[0.38,0.18,0.66,0.96],"start":2,"end":9}' -o masks/skater.mask
```

## Tracking

Without `preview`, the object is segmented on the prompted frame and followed forward and backward through every frame from `start` to `end`, one mask frame per frame at the project's frame rate (the file's own with no project open), so pass the span the clip actually plays. `time` must lie in the span. The job runs silently (the app shows nothing) and shares the model with the editor's object mask tool: it is `queued` while the tool or an earlier job has the model, then tracking, its `phase` `downloading` on a first use of a size and `tracking` after, with `etaRemainingSeconds` measured from the frames done so far. Closing the project a mask is bound for cancels its job.

A library mask answers at once with `state: "tracking"` and a `jobId`: poll [`job`](./job.md) with it, or watch the job's row in [`context`](./context.md)'s `jobs`. With `wait: true` the call itself waits, polling every half second, and answers once the mask is saved, or after `timeoutSeconds` with the job still tracking (it keeps running; poll it with `job`). A mask bound for an absolute path is written when a poll sees the job done, so such a call waits by default. A caller that gives up while waiting leaves the job running.

Left without an `output`, the mask goes into the open project's library as `masks/<video>/Tracking <n>.mask`, as the object mask tool files its own, or, with no project open, into a directory of the job's own under the system temp dir. The mask carries its recipe (footage, prompt, span, model), so the editor can make it again if its file goes missing. Name it on the clip it was made from, with the answer's `start` as its `sourceIn`, so it stays on the footage whatever the trim:

```tsx
<video src="footage/skater.mp4" sourceIn={2} width={1920} height={1080}>
  <effect type="opacity" value={1}>
    <mask src="masks/skater.mask" sourceIn={2} />
  </effect>
</video>
```

## Output

`segment` answers flat:

```ts
{
  state: "previewed" | "tracking" | "done" | "failed" | "canceled";
  jobId: string;       // for job (poll, cancel)
  model: string;       // sam-2.1-<size>
  path?: string;       // the mask file, once done
  src?: string;        // its library path, for <mask src>, when it went into the library
  image?: string;      // PNG: the preview, or a contact sheet of up to 6 tracked frames once done
  frameRate?: number;  // frames per second the mask holds
  start?: number;      // source time of the first masked frame: the <mask>'s sourceIn
  end?: number;        // source time just past the last masked frame
  frames?: number;     // frames masked (1 on a preview)
  bbox?: [x0, y0, x1, y1] | null;  // on the prompted frame, the object's bounds in 0..1
  area?: number;       // on the prompted frame, the share of the frame the object covers
  score?: number;      // on the prompted frame, the object score: at or below 0 the model sees no object
  iou?: number;        // on the prompted frame, the model's estimate of the mask's quality, 0..1
  lost?: [number, number][];  // [start, end) spans, seconds, where no object was found
  weak?: [number, number][];  // [start, end) spans, seconds, where the mask rated below 0.5
  phase?: string; progress?: number | null; etaRemainingSeconds?: number | null;  // while tracking
  error?: string;      // why it failed or was canceled
}
```

Through `generate` and `job`, the same values sit in the job's `details`, its files in `assets`, and `job.status` is `succeeded` where `segment` says `done` or `previewed`. The picture arrives inline once, with the first answer that carries it.

`lost` covers occlusion and the object leaving the frame as well as a track that slipped; look at those moments with [`grab`](./grab.md) before trusting or re-prompting them.

## Errors

The request is refused (`invalid-input`) when no point or box prompts the object, a box's bounds are out of order or outside 0..1, `time` lies outside `start`–`end`, a preview is given a span, an `output` or `wait`, or `timeoutSeconds` is out of range; and when `time` or `start` is past the video's end, the path can't be resolved, or it is not a video. A library `output` needs an open project. A job fails when the model cannot load (no WebGPU, or the download failed).
