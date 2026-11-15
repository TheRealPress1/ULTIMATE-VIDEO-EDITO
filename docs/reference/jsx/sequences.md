# Sequences

`<sequence>` is a track-like container for back-to-back clips. It carries no transform and no timing of its own, and **does not position its children at mount** — give each child an explicit `start` (see [timing.md](./timing.md)). What it adds is clip-to-clip [transitions](./transitions.md) on direct children, and, in the editor, a non-overlapping invariant: dragging or regrouping clips trims or removes whatever they land on.

```tsx
<sequence name="A-roll">
  {/* timeline 0–12 */}
  <video src="b-roll/intro.mp4" width={1920} height={1080} start={0} end={12} />
  {/* timeline 12–2:30, source from 5 s */}
  <video src="b-roll/main.mp4" width={1920} height={1080} start={12} end="02:30" sourceIn={5} />
  {/* from 2:30, plays to its natural end */}
  <video src="b-roll/outro.mp4" width={1920} height={1080} start="02:30" />
</sequence>
```

The next clip's `start` must match the previous clip's on-timeline end — its `end`, or from the source side `start + (sourceOut - sourceIn)`. Here `main` ends at `02:30`, so `outro` starts there. Giving `main` an `end` places the next cut at a round timeline mark without computing source lengths.

## Props

| Prop | Type | Meaning |
| ---- | ---- | ------- |
| `id`, `name` | `string` | Address and label. |
| `hidden` | `boolean` | The track's eye: a hidden track shows nothing and is not heard, and every clip on it stays where it is. |
| `muted` | `boolean` | The track's mute: nothing on it is heard. Independent of `volume` and of a clip's own `muted`. |
| `locked` | `boolean` | The track's padlock: the editor makes no hand edit to the track or to any clip on it until it is unlocked. It still plays and exports, and a change to the file is not stopped by it. |

Purely structural, apart from those three switches; nothing else. A sequence is a [group](./group.md) with its spatial identity taken away — `x`, `y`, `rotation` and `scale` on one are ignored, and its children are positioned against whatever contains the sequence. Like a group it **spans its children in time**, so it needs no timing of its own.

Direct children of a sequence may declare a [`transition`](./transitions.md) into the following clip. An [`<adjustmentLayer>`](./adjustment-layer.md) inside a sequence acts on what sits below the *sequence*, not on the clip before it inside one.

## Tracks

A track is a sequence. Lay a project out as an editor does, one sequence per track with the clips of that track in it, and name the tracks as an editor would (`V1 A-roll`, `V2 B-roll`, `A1 Music`). The editor's timeline shows each as one row with its own eye, mute, solo and padlock, and a sequence is the only row that holds several clips. A track listed later draws above one listed earlier, so list the lowest track first.

- **`hidden`, `muted`** are written to the project like any prop, and undone like one.
- **`locked`** is the person's way of saying *do not touch this track*. The editor refuses every hand edit to it, and nothing in the file can stop an edit to the file: leave a locked sequence, and everything in it, as it is unless you are asked to change it.
- **Solo** is monitoring, not composition: it is never written to the project and an export ignores it. It plays the soloed tracks (a soloed track is every clip on it) together, in the editor's preview only.
