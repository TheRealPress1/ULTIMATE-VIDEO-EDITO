# Markers

A `<marker>` is a flag on the ruler of the scene holding it: a note on the timeline where something happens, such as a beat, a cut to make or a line that needs fixing. It is **not a layer**. It takes no row, draws nothing in the frame, and changes neither what the scene lasts nor what is exported. It is there for the person editing, and for you, to find a moment by.

```tsx
<scene width={1080} height={1920} active>
  <video src="interview.mp4" start={0} end={60} />
  <marker time={12.5} name="Hook ends" color="red" />
  <marker time="1:05" name="Fix the lower third" />
</scene>
```

| Prop | Meaning |
| ---- | ------- |
| `time` (**required**) | Where on the scene's timeline the marker is, in any [time format](./timing.md#time-formats). |
| `name` | What it marks. The editor shows it beside the flag. |
| `color` | Any CSS color; the flag is drawn in it. Default yellow. |

- A marker is a direct child of `<scene>` and takes no children.
- `time` is scene time. Unlike a [keyframe](./keyframes.md)'s, it does not move when a clip is moved or trimmed.
- The editor keeps one marker to a frame (pressing **M** twice in the same spot adds one). The file may hold more.
- Editing by transcript moves each marker with the passage it sits in, and drops the ones in a stretch that is cut. Reframing and reference styling leave markers as they are.
- In the editor, **M** adds a marker at the playhead, **Shift+M** and **Shift+Cmd+M** jump to the next and the previous one, and **Option+M** clears them all. Markers are snap targets for dragging and trimming.
- Name a marker for what happens there ("Intro ends"), so the next person can find the moment from the flag alone.
