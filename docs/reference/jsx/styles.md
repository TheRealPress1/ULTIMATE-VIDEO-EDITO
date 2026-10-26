# Strokes, shadows and effects

Three sub-entity children a node takes alongside its [paints](./paints.md): an outline of its shape, a shadow beneath it, and a filter over what it drew. Each stacks in document order, several of a kind are allowed, and each carries an `id` of its own — the editor writes a changed value back to the element that spelled it, and it is copied with its node.

```tsx
<text fontSize={140} fontWeight="bold" color="#FFFFFF" width={1920} textAlign="center">
  Headline
  <stroke color="#000000" width={6} join="round" />
  <shadow color="#000000" blur={24} offsetY={8} opacity={0.6} />
</text>
```

## `<stroke>`

An outline of the parent's shape (its box, or the curve of an `<ellipse>`, the corners of a `<polygon>`, the outline of a `<path>`) — or of its glyphs, on a `<text>` or a `<textRange>`. `color` is its paint, the rest its line style.

| Prop | Type | Default | Meaning |
| ---- | ---- | ------- | ------- |
| `color` | `string` | none | Any CSS color; alpha is ignored (use `opacity`). Without it the stroke is drawn by its paint children alone. |
| `width` | `number` | `1` | Line width, px. A `width` [keyframe track](./keyframes.md) under a stroke drives this, not a box. |
| `join` | `"miter" \| "round" \| "bevel"` | `"miter"` | How the stroke turns corners. |
| `cap` | `"butt" \| "round" \| "square"` | `"butt"` | How the stroke ends open paths (text glyphs, open subpaths of a [`<path>`](./path.md)) and each of its dashes. |
| `miterLimit` | `number` | `10` | Miter length limit, as a ratio of the width. |
| `dash` | `number` | `0` | Dash length, px: the line is drawn `dash` on, `dashGap` off, repeated. Solid while both are `0`. |
| `dashGap` | `number` | `dash` | Gap between dashes, px. `0` is a solid line. Unset, it is `dash` as written: a `dash` track does not move it. |
| `dashOffset` | `number` | `0` | How far into the dash pattern the line starts, px (SVG's `stroke-dashoffset`). |
| `opacity` | `number` | `1` | `0`–`1`, over `color` and every paint child. |
| `blendMode` | `BlendMode` | `"sourceOver"` | How the stroke composites. |
| `hidden` | `boolean` | absent | Excludes the stroke without removing it. |

`color` is shorthand for a solid paint, as `fill` is on a node. To draw the line with a gradient, put the [paint](./paints.md) inside the stroke instead: `<solidPaint>`, `<linearGradientPaint>`, `<radialGradientPaint>` and `<angularGradientPaint>` are allowed, and any other paint is an error. Paint children stack over `color` in document order, each through the same line, and take their own `opacity` and `blendMode`. A gradient is placed in the box of the stroke's parent, the same box its fills use, so a fill and a stroke with the same gradient line up. The line is centered on the box's edge, so its outer half reaches past `rx={0.5}`.

```tsx
<rect width={640} height={360} cornerRadius={24} fill="#111111">
  <stroke width={8} join="round">
    <angularGradientPaint rotation={-90}>
      <colorStop offset={0} color="#FF0055" />
      <colorStop offset={1} color="#0055FF" />
    </angularGradientPaint>
  </stroke>
</rect>
```

### Dashes

`dash` and `dashGap` cut the line into dashes, measured along it in the same px as `width`; `<stroke dash={12} />` draws 12px dashes with 12px gaps. A `"round"` or `"square"` `cap` reaches half the width past both ends of every dash, into the gaps, so `dash={0}` with `cap="round"` draws dots. The pattern starts where each outline starts (a `<path>`'s after its trim), and `dashOffset` slides it: a growing `dashOffset` walks the dashes back toward the start, so a keyframe track on it makes marching ants. `dash`, `dashGap` and `dashOffset` are all [animatable](./keyframes.md) under a stroke, and a stroke is dashed only while one of them is written on it: a track alone leaves the line solid. The stroke is hit along its whole outline, gaps included.

```tsx
<rect width={640} height={360} cornerRadius={24}>
  <stroke color="#FFFFFF" width={4} cap="round" dash={16} dashGap={10}>
    <keyframeTrack property="dashOffset">
      <keyframe time={0} value={0} />
      <keyframe time={1} value={-52} />
    </keyframeTrack>
  </stroke>
</rect>
```

## `<shadow>`

A drop shadow beneath the parent's silhouette: a blurred, offset copy of it in `color`.

| Prop | Type | Default | Meaning |
| ---- | ---- | ------- | ------- |
| `color` | `string` | **required** | Any CSS color. |
| `blur` | `number` | `0` | Blur radius, px. |
| `offsetX`, `offsetY` | `number` | `0` | Where the shadow sits relative to the silhouette, px. |
| `opacity` | `number` | `1` | `0`–`1`. |
| `hidden` | `boolean` | absent | Excludes the shadow without removing it. |

## `<effect>`

A filter over the parent's **rendered pixels** — its fills, strokes and children together. On a [`<group>`](./group.md) that is the group as a whole; on a [`<video>`](./video.md) it is the frame after the media is drawn. A [`<mask>`](./masks.md#under-an-effect) child limits where the effect applies.

| Prop | Type | Default | Meaning |
| ---- | ---- | ------- | ------- |
| `type` | `EffectType` | **required** | Which filter to apply, see below. |
| `value` | `number` | **required** | The amount. |
| `hidden` | `boolean` | absent | Excludes the effect without removing it. |

| `type` | `value` means |
| ------ | ------------- |
| `"blur"` | Radius in px. |
| `"hueRotate"` | Degrees. |
| `"brightness"`, `"contrast"`, `"grayscale"`, `"invert"`, `"saturate"`, `"sepia"` | Amount, `0`–`1`. |
| `"opacity"` | The node's opacity as an effect, `0`–`1`. With a `<mask>` under it, what is outside the mask goes transparent: the cut-out. |

```tsx
<image src="stills/photo.jpg" width={1920} height={1080}>
  <effect type="blur" value={0}>
    <keyframeTrack property="value">
      <keyframe time={0} value={40} easing="easeOut" />
      <keyframe time={1.5} value={0} />
    </keyframeTrack>
  </effect>
</image>
```


## `<mask>`

A `<mask>` under an effect limits where the effect applies; under an `"opacity"` effect it is the cut-out. See [masks.md](./masks.md#under-an-effect).

## Animating them

All three take [`<keyframeTrack>`](./keyframes.md) children, and the track's `property` is read against its holder: `width` under a `<stroke>` is the line width, `blur` / `offsetX` / `offsetY` under a `<shadow>` are the shadow's, `value` under an `<effect>` is its amount, and `color` / `opacity` are whatever the holder's are.
