# Captions

`<captions src>` inside a scene mounts a transcript as a caption node: a styled, timed transcript.

```tsx
<scene name="Talk" width={1920} height={1080}>
  <video src="a-roll/take-3.mp4" width={1920} height={1080} />
  <captions src="transcripts/take-3.srt" preset="whisper" />
</scene>
```

`src` is **required**: a transcript file — `.srt`, `.vtt`, or a transcript `.json` — or an audio or video asset that carries a transcript. It resolves like any other [`src`](./media.md) (library path, asset id, path, URL) and is mounted as it is; `<captions>` does not transcribe its scene — make the transcript first (see [Captioning a scene](#captioning-a-scene)). Loading is **asynchronous and non-blocking**: the caption node is on the canvas from the moment the project mounts and its transcript attaches once loaded. A source that fails to load leaves the node carrying the reason (see [errors.md](./errors.md#failed-sources)).

## Captioning a scene

To caption a scene's audible mix, select the scene in Blackout and run **Generate captions** from the command palette. With nothing selected, the command uses the active scene. It prepares the audio, transcribes it locally, saves a transcript asset, and adds or updates the scene's caption layer. Progress and cancellation appear in a notification. Select the caption layer to edit words and times in **Caption text**, apply changes, or choose a preset.

Recognition uses multilingual Whisper base on this Mac. The first use downloads about 148 MB of model weights, then keeps them cached for offline use; no audio or video is uploaded for transcription. Scenes can be up to two hours long, analyzed in resumable two-minute sections. See [local transcription setup](../../../README.md#local-transcription-and-captions) for development requirements.

The scene's audible mix is rendered from its start to its end (the workarea is ignored), so a newly mounted caption layer uses scene-relative transcript times without `start` or `sourceIn`. Generate captions again after a cut, moved clip, or muted track changes what is heard or when: the transcript is a snapshot of the mix.

For a single source recording, agents and the CLI can use [`transcribe`](../tools/transcribe.md), then mount the resulting file. This tool accepts an audio/video path, not a scene id:

```bash
cutroom transcribe a-roll/take-3.mp4 -o /absolute/path/to/take-3.json
```

```tsx
<scene id="talk" name="Talk" width={1920} height={1080}>
  <video src="a-roll/take-3.mp4" width={1920} height={1080} />
  <captions src="/absolute/path/to/take-3.json" preset="whisper" />
</scene>
```

The example aligns because both the video and its source transcript start at zero without trims. A source-file transcript does not incorporate timeline edits: match the caption node's timing to its clip when it is moved or trimmed (see [Trimming](#trimming)). For a scene with multiple cuts or overlapping tracks, the editor's **Generate captions** command produces the corresponding mix transcript.

## Props

| Prop | Type | Default | Meaning |
| ---- | ---- | ------- | ------- |
| `src` | `string` | **required** | The transcript to mount: a transcript file, or an audio or video asset that carries one. |
| `preset` | see below | `"classic"` | Caption style preset. |
| `colors` | `string[]` | preset defaults | Fills the preset's color slots in order; any CSS color, alpha ignored. Ignored by presets without slots. |
| `verticalAlign` | `"top" \| "center" \| "bottom"` | preset default | Vertical placement of the caption block: anchored to the top or bottom safe margin, or centered. Horizontal placement stays with the preset. |
| `offsetX`, `offsetY` | `number` | `0` | Render-time nudge in px on top of the preset placement; subpixel values are kept. A slide animation drives the same channel and wins while it plays. |
| `start`, `end`, `sourceIn`, `sourceOut` | `Time` | full transcript | Trim which stretch of the transcript is captioned, using the same [timing](./timing.md) semantics as media nodes. See [Trimming](#trimming). |
| `id`, `name` | `string` | see [elements.md](./elements.md#common-props) | Address and label. |

`<animation>` children are valid; the text-only types (`"appearWord"`, `"appearChar"`, `"scramble"`) apply.

The preset positions the caption block; `verticalAlign` overrides only its vertical anchor (`whisper` and `cascade` default to `bottom`, all other presets to `center`), and `offsetX`/`offsetY` nudge the drawn result from there.

## Trimming

Captions carry the same [timing](./timing.md) props as media nodes. Their source clock must stay aligned to the corresponding audio. To hide the first 15 seconds of an otherwise unchanged scene-aligned transcript, advance both `sourceIn` and `start` to 15. To move a clip and its captions together on the timeline, move both nodes' `start` while preserving their source ranges. For a clip at timeline start `S`, source in `I`, and speed `r`, a source word at `t` appears at `S + (t - I) / r`, before ancestor transforms. One node cannot skip a source gap; use separate nodes for separate retained ranges. To blank captions under an overlay without changing the audio:

```tsx
<captions src="transcripts/take-3.srt" start={0} end={15} sourceIn={0} sourceOut={15} />   {/* before the overlay */}
<captions src="transcripts/take-3.srt" start={20} sourceIn={20} />                         {/* after the overlay */}
```

## Presets

`preset` selects the caption style: the same presets as the editor's caption inspector. Some presets expose **color slots**, filled in order by the `colors` prop; a missing or omitted entry falls back to the slot's default.

| Preset | Style | Color slots (defaults) |
| ------ | ----- | ---------------------- |
| `"classic"` (default) | Simple one word captions, first choice for vertical content | none |
| `"whisper"` | Small, wide, understated line shown in ~2 s phrases, first choice for landscape content | none |
| `"cascade"` | Light text in the lower left; words appear progressively as they are spoken | none |
| `"spotlight"` | Bold italic centered line; the spoken word lights up in the highlight color | 1: highlight (`#24D5FF`) |
| `"paper"` | Centered two-line block; the line being spoken is emphasized with a heavier weight. | none |
| `"guinea"` | Uppercase display text; the spoken word enlarges and cycles through the three colors. | 3: `#F55353`, `#FEB139`, `#F6F54D` |
| `"stark"` | Heavy uppercase text blended into the footage with a difference blend. | none |
