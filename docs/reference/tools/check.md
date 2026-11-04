# check

Check a node's subtree for obvious structural mistakes, without rendering (local analysis, no credits): spans where no visual is scheduled (likely black frames), children that never become visible, zero-duration or fully transparent nodes, assets that failed to load, and full-frame shots on screen too briefly between two others — plus subtree stats (node count by kind, nesting depth, played duration). Times in issue ranges are seconds relative to the node's start — for a scene whose workarea starts at 0, the same clock capture uses. Structural only: a scheduled clip can still render black (dark footage, content smaller than the canvas), so confirm suspicious spans visually with capture.

| | |
| --- | --- |
| MCP tool | `check` |
| CLI | `cutroom check <id>` |

## Input

| Field | Type | CLI | Description |
| --- | --- | --- | --- |
| `id` | `string`, required | `<id>` | node id from the project's JSX, or `file:id` when two files use the same id |
| `minVisibleSeconds` | `number` | `--min-visible-seconds <seconds>` | shortest time a full-frame shot may stay on screen between two others, 0–2 s (default `0.4`; `0` turns the rule off) |

## What it can and cannot see

The analysis is structural, from the resolved timeline alone, so it is instant and costs no credits — and it can only say *nothing is scheduled*, not *the frame is black*. A scheduled clip can still render black (dark footage, content smaller than the canvas, a transparent asset); confirm suspicious spans visually with [`capture`](./capture.md) at a time inside the range. Alongside the issues it reports subtree stats — node count by kind, nesting depth, and played duration — so it doubles as a quick structural summary of a scene. The `id` resolves by the same rules as [`capture`](./capture.md)'s.

## What counts as visual coverage

Video, image, HTML, shape, text, and caption nodes draw pixels; their scheduled spans cover the timeline. Groups and scenes are covered only where their descendants draw — a scene's background alone is exactly what a black frame looks like, so it never counts. Audio nodes, the shapes of clip paths and the elements of masks, and adjustment layers add no pixels; neither does anything hidden, fully transparent, or scheduled outside the window its ancestors play. When a scene has a workarea, coverage is judged against the workarea instead of the full span.

## Visible stretches

Read top-down, a cut is a series of stretches, each owned by whatever fills the picture: the topmost video, image or filled rectangle that covers at least 90% of the scene canvas at an opacity of at least 0.95 (its ancestors' opacity included). Captions, text and smaller graphics never own a stretch; they sit over it. Two pieces of the same recording are two stretches, so a talking-head piece that shows for a few frames between a cut and a B-roll edge counts on its own.

An owned stretch shorter than `minVisibleSeconds` with another stretch on each side is a `short-visible-stretch` warning: it reads as a flash. The usual cause is a B-roll edge that lands just after a talking-head cut; move the edge onto the cut, or at least the minimum away from it. A tight cut with no inserts can leave one too: a short word kept between two removed pauses is a piece of one recording between two cuts in it. The message says so when the media on both sides is the same as the piece's; keep the pause on one side so the piece joins its neighbour, drop it, or cover both cuts with one insert. A stretch that touches the start or end of the checked window is exempt, and a span no full-frame layer covers separates its neighbours without being flagged itself (`black-frames` reports it when nothing at all is scheduled).

The pass reads the resolved timeline, not pixels, and only what it can judge statically. Layers that are masked or clipped, keyframed or animated, blended in a mode other than normal, rotated or skewed, or letterboxed inside their box (`objectFit="contain"`), or that sit under an ancestor that is, never own a stretch; `stats.visibility.skipped` lists them with the reason, so capture those spans to judge them by eye. The sweep visits clip edges only, so long scenes cost no more than their clip count. At most 50 short stretches are reported as issues; `shortStretches` gives the full count.

## Output

One JSON object:

```ts
{
  stats: {
    nodes: number;                    // nodes in the subtree, the checked node included
    byKind: Record<string, number>;   // "scene" | "sequence" | "group" | "video" | "image" | "html" | "shape" | "text" | "caption" | "audio" | "clip-path" | "mask" | "adjustment-layer"
    depth: number;                    // deepest nesting level below the checked node (0 = no children)
    duration: number;                 // seconds the checked node plays (its workarea, when one is set)
    visibility?: {                    // the visible-stretch pass; absent when it is off or the node has no scene canvas
      minVisibleSeconds: number;
      stretches: number;              // full-frame stretches, in order of play
      shortStretches: number;
      evaluatedLayers: number;        // videos, images and filled rectangles judged for coverage
      skippedLayers: number;          // layers the pass could not judge statically
      skipped: Array<{ node?: string; reason: "masked" | "animated" | "blended" | "rotated" | "fitted" | "unmeasured" }>;  // up to 20
    };
  };
  issues: Array<{
    code: "black-frames" | "no-visuals" | "never-visible" | "zero-duration" | "transparent" | "source-error" | "short-visible-stretch";
    severity: "error" | "warning";
    message: string;
    node?: string;                    // source stamp of the offending node; absent for subtree-wide issues
    ranges?: Array<{ start: number; end: number }>;  // seconds relative to the node's start — for a scene whose workarea starts at 0, the clock `capture` positions use
  }>;
}
```

## Issues

| Code | Severity | Meaning |
|---|---|---|
| `black-frames` | error | Spans of a frame or more where nothing visual is scheduled; `ranges` lists them |
| `no-visuals` | error* | Nothing in the subtree draws at all (*warning when the subtree holds audio nodes — an audio-only group is legitimate) |
| `never-visible` | warning | A node scheduled entirely outside the window its ancestors play |
| `zero-duration` | warning | A node that spans no frames |
| `transparent` | warning | A node with static opacity 0 (nodes with keyframes are given the benefit of the doubt) |
| `source-error` | error | An asset that failed to load, with the failure message |
| `short-visible-stretch` | warning | A full-frame shot on screen for less than `minVisibleSeconds` between two others; `node` is the shot, `ranges` its span (see [Visible stretches](#visible-stretches)) |

## Severity and the shell

Finding issues is not a failure: the result is the same object either way, and the caller reads `issues`. From a shell, `cutroom check` additionally exits `1` when an error-severity issue is found (warnings alone stay `0`), so it can gate a script.

## Errors

Fails when the check itself can't run: no project is open, or the id is unknown or ambiguous.
