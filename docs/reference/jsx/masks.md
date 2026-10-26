# `<clipPath>` and `<mask>`

Two ways to cut an element, both as SVG has them: a **clip path** shows the element only inside a set of outlines, hard-edged; a **mask** keeps only what a picture covers, by its alpha, so it can be soft, fade, or be text. Either one is a child of the element it cuts — any node: `<rect>`, `<text>`, `<video>`, `<image>`, `<group>`, `<scene>` — and holds the elements that cut it.

```tsx
<group>
  <clipPath>
    <ellipse x={560} y={140} width={800} height={800} />
  </clipPath>
  <mask type="alpha">
    <text fontSize={180} color="#FFFFFF">HELLO</text>
  </mask>
  <video src="footage/beach.mp4" width={1920} height={1080} />
</group>
```

The elements under a clip path or mask sit in the **space and time of the element they cut**, as its children do: the same coordinates, its transform applied on top of their own, and its timeline. Each keeps its own transform, timing and keyframes, so a cut that moves, grows or comes in late is keyframes or timing on those elements. They are never drawn on their own and never picked up on the canvas.

Both cut after the element's own [effects](./styles.md#effect): a blur on a clipped element stops at the clip's edge. To blur the edge of the cut instead, put the clip path or mask on an inner `<group>` and the effect on an outer one.

Several clip paths and masks on one element **intersect**: it shows only where every one of them lets it.

## `<clipPath>`

Clips the element holding it to the outlines of the shapes under it: `<rect>`, `<ellipse>`, `<polygon>` and `<path>`. Their outlines **add up** — the element shows inside any of them — united by the nonzero rule, so two outlines drawn opposite ways round cut a hole where they overlap; a lone `<path>` keeps its own `fillRule`.

```tsx
<text fontSize={120} color="#FFFFFF" textAlign="center" textBaseline="middle">
  Hello World
  <clipPath>
    <rect height={300}>
      <keyframeTrack property="width">
        <keyframe time={0} value={0} />
        <keyframe time={1} value={1920} easing="easeOut" />
      </keyframeTrack>
    </rect>
  </clipPath>
</text>
```

| Prop | Type | Default | Meaning |
| ---- | ---- | ------- | ------- |
| `hidden` | `boolean` | absent | Switches the clip path off without removing it. |

- Only the outline of a shape counts, so its `fill`, `opacity`, `blendMode` and paint / stroke / shadow / effect children have no effect. Text, media and groups under a clip path are ignored: a cut shaped like text is a `<mask>`.
- A shape outside its own time window drops out of the clip path, and a clip path none of whose shapes is in its time clips nothing: a shape keyframed across a text is a wipe, one that ends early lets go, one that starts late is a reveal.

## `<mask>`

Keeps only what its **picture** covers, by the picture's alpha: opaque keeps, transparent cuts. The picture is the elements under it — shapes, text, media, groups, drawn the way they would be on the canvas and taken together — or a mask file named by `src`.

| Prop | Type | Default | Meaning |
| ---- | ---- | ------- | ------- |
| `type` | `"alpha"` | `"alpha"` | Which channel of the picture cuts. Only `"alpha"` for now, its opacity; unlike SVG, whose masks default to luminance. |
| `inverted` | `boolean` | `false` | Covers what the picture does not instead. |
| `blur` | `number` | `0` | Feather: radius in px the edge falls off over. |
| `opacity` | `number` | `1` | How strongly the mask cuts, `0`–`1`. `1` leaves nothing outside it; lower lets that much through outside; `0` is no mask. |
| `src` | `string` | none | A mask file: the frames of an object tracked through footage, see below. |
| `sourceIn` | `Time` | `0` | The holder's source time the first frame of `src` belongs to, so the mask stays on the footage it was made from whatever the trim. |
| `frameRate` | `number` | `30` | Frames per second the frames of `src` were written at (the composition's). |
| `smoothing` | `number` | `0.25` | How much a mask file's edge is smoothed, `0`–`1`. At `0` it is exactly where the model put it; the more, the rounder, and the more of what is thin or small melts away. Sharp at any size either way. |
| `hidden` | `boolean` | absent | Switches the mask off without removing it. |

`blur` and `opacity` take a [`<keyframeTrack>`](./keyframes.md). A mask with neither elements in their time nor a `src` does nothing.

```tsx
<image src="stills/sky.jpg" width={1920} height={1080}>
  <mask blur={40}>
    <ellipse x={460} y={40} width={1000} height={1000} fill="#FFFFFF" />
  </mask>
</image>
```

### Mask files

A mask file is what the editor's object mask tool makes — pick an object in a video clip, track it, and the frames it found are written to the library — and what [`generate`](../tools/generate.md)'s [`sam-2.1`](../tools/segment.md) makes from a tool call. `src` names it, and its picture is fitted into the holder's box the way the holder fits its footage, so it stays on the object.

```tsx
<video src="footage/skater.mp4" width={1920} height={1080}>
  <effect type="opacity" value={1}>
    <mask src="masks/skater.mask" sourceIn={2} blur={6} />
  </effect>
</video>
```

### Under an `<effect>`

A mask under an [`<effect>`](./styles.md#effect) limits where the effect applies instead of cutting the element, held to the element's box. Under an `"opacity"` effect that is the cut-out: the clip shows inside the mask and goes transparent outside, as a mask on Premiere's Opacity does. Under any other effect the effect shows through inside the mask and the picture is untouched outside: an inverted mask on a `"blur"` blurs the background behind a person. It takes the same props and the same picture, elements or a file.
