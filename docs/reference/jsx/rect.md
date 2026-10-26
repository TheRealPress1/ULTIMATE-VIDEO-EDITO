# `<rect>`

A rectangle. Takes [paint children](./paints.md), plus [`<stroke>`, `<shadow>`, `<effect>`](./styles.md), [`<clipPath>`, `<mask>`](./masks.md), [`<animation>`](./animations.md) and [`<keyframeTrack>`](./keyframes.md); use `cornerRadius` for rounded corners.

```tsx
<rect x={40} y={40} width={640} height={360} cornerRadius={24} fill="#FF0055" />
```

## Props

All [common props](./elements.md#common-props), plus:

| Prop | Type | Default | Meaning |
| ---- | ---- | ------- | ------- |
| `fill` | `string` | none | Any CSS color; alpha is ignored (use `opacity`). Shorthand for a solid paint child, drawn beneath any paint children. |

A rect with neither `fill` nor a paint child draws nothing; it is still a box: it carries children, its clip paths and masks still cut them, and it takes up its place in the timeline. Without `width`/`height` a rect is 100×100.

## Clip paths and masks

A rect can be cut by a [`<clipPath>` or `<mask>`](./masks.md) child, and a rect under one is what that clip path or mask cuts by.
