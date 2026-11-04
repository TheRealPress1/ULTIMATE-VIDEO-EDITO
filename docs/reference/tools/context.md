# context

Report the current app context: the folder new projects are created in (always reported), the folder of the project the app has open (null when none is), where its playhead sits in seconds, the registered font families, and the background jobs the app holds.

| | |
| --- | --- |
| MCP tool | `context` |
| CLI | `cutroom context` |
| CLI aliases | `cutroom ctx` |

## Input

None.

## What it does not say

The composition itself — its scenes, what is selected, which scene is active, the work area — is all in the JSX, and a caller that wants any of it reads the file. This report is only what the source cannot say.

## Output

One JSON object:

```ts
{
  rootDir:      string | null;   // absolute folder the last project was saved to; null until one has been saved
  projectDir:   string | null;   // absolute open project folder — where the JSX being edited lives; null when none is open
  currentTime:  number | null;   // playhead in the active scene, in seconds; null if no scene is active
  fontFamilies: string[];        // families registered in the running world, valid as `fontFamily`
  jobs: Array<{                  // background jobs, running ones first (at most 20)
    id:        string;           // poll with job (segment) or analyze action status (analyze)
    kind:      "segment" | "analyze";
    model?:    string;           // sam-2.1-<size>, or local-evidence
    state:     "queued" | "running" | "done" | "failed" | "canceled";
    phase?:    string | null;    // while it runs: downloading, tracking, speech, frames…
    progress:  number | null;    // 0..1, null when unknown
    path?:     string;           // the footage it works on
    src?:      string;           // a finished mask's library path
    error?:    string;
  }>;
}
```

With no project open (the app sits at the dashboard) the report is just `{ rootDir, projectDir: null }` and the jobs: there is no playhead, no world, and no fonts to speak of. Open one with [`open`](./open.md).

`jobs` lists the work running in the background: mask tracks started with [`segment`](./segment.md) (or `generate`'s `sam-2.1`) and long [`analyze`](./analyze.md) runs, plus those that ended in the last ten minutes. They live in the app until it reloads. A row says where a job stands; the job's own tool says what it made.

`rootDir` is reported whether or not a project is open — it is where a caller with nothing open goes to find one. It is not where the app creates projects: a new project starts as a draft in the app's own folder, and moves when the user saves it (⌘S), which also makes its parent the new `rootDir`.

`currentTime` is local to the active scene, the same origin a clip's `start` and `end` are placed against, and in the same unit.

`projectDir` is the folder the app is editing, which is not necessarily the one a command was run from: check it before writing to source files.

`fontFamilies` is what text can be drawn with right now — loaded into the world, not merely named in the source — and always includes the editor default. For every family a text can name, see [`fonts`](./fonts.md).
