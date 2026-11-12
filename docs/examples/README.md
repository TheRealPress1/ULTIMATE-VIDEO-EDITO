# Examples

Self-contained compositions demonstrating the JSX API (see [reference/jsx](../reference/jsx/README.md)).
Each one is a whole project entry file: it default-exports a component rendering a
`<stage>` with one `<scene>` in it. To run one, make it the entry of a project. Either
copy it into a folder of its own somewhere such as `~/Movies` and open that folder from
the app's dashboard, which makes it a project, or let [`open`](../reference/tools/open.md)
make a new project and put the example in as its entry — from a shell:

```sh
cutroom open ~/Movies/basics
cp examples/01-basics.tsx ~/Movies/basics/index.tsx
```

`open` creates the folder with an empty `index.tsx`, and the app picks up the copied
entry as soon as it lands. Over `open` (from a shell or an agent), a folder must be new
or empty unless it already is a Blackout project, so copy the example in after opening,
not before.

| Example | Shows |
| --- | --- |
| [01-basics.tsx](01-basics.tsx) | `<stage>` / `<scene>`, `<sequence>` with a dissolve, `<video>`, `<audio>`, `<image>`, `<text>` titles from data via `<For>`, `<animation>` children |
| [03-ticker.tsx](03-ticker.tsx) | declarative animation: `useTicker` + `createMemo` derived values driving props |
| [04-html-in-canvas.tsx](04-html-in-canvas.tsx) | `<htmlPaint>`: an AI prompt box as real DOM, typed out from the playhead |
| [05-anime-timeline.tsx](05-anime-timeline.tsx) | anime.js timeline seeked from `useTicker`, driving an ECS node and `<html>` content in lockstep |
| [06-three.tsx](06-three.tsx) | three.js WebGL renderer owning a `<surface>`, glTF model loaded over the network |
| [07-webgpu.tsx](07-webgpu.tsx) | raw WebGPU on a `<surface>`: a triangle whose colors cycle with composition time |
| [08-shader-paint.tsx](08-shader-paint.tsx) | `<shaderPaint>` post-processing a `<video>`: WGSL chromatic aberration + vignette, uniforms patchable live |
| [09-inspect-variables.tsx](09-inspect-variables.tsx) | `@inspect` variables: annotated top-level consts becoming sidebar controls, values written back into the source |
| [10-typegpu.tsx](10-typegpu.tsx) | TypeGPU on a `<surface>`: shaders written in TypeScript (`'use gpu'`), compiled through the project's own [babel config](../reference/jsx/module.md#compile-time-plugins-babel-config) |
| [11-redraw.tsx](11-redraw.tsx) | [Redraw](https://redraw.dev) on a `<surface>`: the docs' Hello World write-on stroke, a vendored-tarball package driven by composition time; the surface spans one animation cycle, `@inspect` variables tune it, and `useResolution` keeps it sharp at any export size |

Requirements: `01-basics.tsx`, `06-three.tsx`, and `08-shader-paint.tsx` fetch remote media.
`10-typegpu.tsx` and `11-redraw.tsx` need packages installed in the project folder
and a babel config next to the entry — the commands are in their header comments.
`11-redraw.tsx` additionally needs the `redraw` tarball vendored into the project
([Redraw is in technical preview](https://redraw.dev/docs/installation)).

Typecheck with `tsc -p examples --noEmit` (part of `npm run check`). `06-three.tsx`
needs `three` installed to typecheck, `10-typegpu.tsx` needs `typegpu` and
`@typegpu/noise`, and `11-redraw.tsx` needs `redraw` and `typegpu`; none of these
are dependencies of this repo.
