# Tool reference

Cutroom exposes one set of tools, reachable two ways:

- **MCP.** The running app serves an MCP server at `http://127.0.0.1:43127/mcp` (Streamable HTTP). A connected agent gets every tool in `tools/list`, with the descriptions on these pages and its input and output as JSON Schema 2020-12, and instructions that give the path of these docs in the installed app. A client that can only spawn a stdio server can bridge to the URL with a generic proxy such as `mcp-remote`.
- **CLI.** `cutroom`, the command-line client shipped with the app, wraps every tool as a command for shells, scripts and CI. `cutroom <command> --help` prints the same description and the same field help.

Both validate against the same schemas and return the same result, so each tool is documented once, on its own page. The catalog behind all three (server, CLI, these pages) lives in `packages/dapi`.

The JSX code syntax specified in [jsx/](../jsx/README.md) is **pseudo-SVG**, mirroring SVG's shape-and-paint model with the editor's own tags and props rather than the SVG spec. A project is a folder of that JSX, and **the source is the document**: the app compiles the entry file and renders every element into an editable node, and edits made on the canvas are written back to the element that authored them. So the loop is [`open`](./open.md) once, then edit the files — there is no tool that pushes content into the app. What the tools do is read the running app ([`context`](./context.md), [`capture`](./capture.md), [`logs`](./logs.md)), inspect media, and list what a declaration may name.

## Names

A tool is named as MCP lists it, and the CLI spelling follows from the name:

- The tool name is the command: `grab` is `cutroom grab`.
- A tool's first field is the positional argument: `capture`'s `id` is `cutroom capture <id>`.
- Every other field is an option in kebab-case: `perSheet` is `--per-sheet`, `separate` is `--separate`. Short forms are listed on each page.
- Times are written the same way everywhere: seconds (`1.5`), frames at the project's rate (`45f`), or a clock string (`1:30`, `00:01:30`). Times in **results** are plain seconds.

## Results

Every tool returns one JSON object, its *structured content*. Over MCP that is the result's `structuredContent`, repeated as a text block for clients that ignore structured content; the CLI prints it to stdout, unchanged. Tools that render images (`capture`, `grab`, `filmstrip`, `waveform`, `screenshot`) write PNGs to disk and return their paths; over MCP a result of at most four images, none over a megabyte, also carries them inline as image content, so a contact sheet arrives in context without opening anything.

## Errors

A failure is a sentence written to be read, e.g. `No project open — run open first`. Over MCP it arrives as a tool result with `isError: true`, not as a protocol error; the CLI prints it to stderr and exits `1`. Each page's Errors section lists what the tool fails on; only the delivery differs by surface.

Every tool runs inside the app, so the app has to be running. Over MCP that is a given — the connection is to the app. From a shell, `cutroom open` launches it (macOS and Windows) or surfaces the running instance; every other command prints a launch instruction and exits `1` while the app is down.

## The tools

| Tool | CLI | Does |
| --- | --- | --- |
| [`open`](./open.md) | `cutroom open` | Open project |
| [`context`](./context.md) | `cutroom context` | App context |
| [`capture`](./capture.md) | `cutroom capture` | Capture frames |
| [`check`](./check.md) | `cutroom check` | Check structure |
| [`quality_review`](./quality-review.md) | `cutroom quality_review` | Inspect rendered frame and audio observations |
| [`visual_index`, `visual_search`, `visual_status`](./visual.md) | `cutroom visual_search` | Index and search visual B-roll evidence |
| [`transcript_edit_inspect`, `transcript_edit_apply`](./transcript-edit.md) | `cutroom transcript_edit_inspect` | Review and apply text-based timeline edits |
| [`export`](./export.md) | `cutroom export` | Export scene |
| [`probe`](./probe.md) | `cutroom probe` | Probe media |
| [`grab`](./grab.md) | `cutroom grab` | Grab frames |
| [`transcribe`](./transcribe.md) | `cutroom transcribe` | Transcribe speech |
| [`captions`](./captions.md) | `cutroom captions` | Caption the edited scene locally |
| [`skills`](./skills.md) | `cutroom skills` | List and read shared editing workflows |
| [`editing_style`](./skills.md) | `cutroom editing_style` | Read or save approved style preferences |
| [`audio_finish`](./audio-finish.md) | `cutroom audio_finish` | Measure loudness and true peak; finish dialogue and duck music |
| [`filmstrip`](./filmstrip.md) | `cutroom filmstrip` | Filmstrip preview |
| [`waveform`](./waveform.md) | `cutroom waveform` | Waveform preview |
| [`listen`](./listen.md) | `cutroom listen` | Inspect local speech evidence |
| [`generate`](./generate.md) | `cutroom generate` | Generate media |
| [`job`](./job.md) | `cutroom job` | Generation job |
| [`logs`](./logs.md) | `cutroom logs` | App logs |
| [`screenshot`](./screenshot.md) | `cutroom screenshot` | Window screenshot |
| [`window`](./window.md) | `cutroom window` | App window |
| [`fonts`](./fonts.md) | `cutroom fonts` | Fonts |
| [`report`](./report.md) | `cutroom report` | Report a bug |
| [`instagram_accounts`](./instagram.md) | `cutroom instagram_accounts` | Instagram connection and sync status |
| [`instagram_posts`](./instagram.md) | `cutroom instagram_posts` | Rank cached Instagram posts |
| [`instagram_post_analytics`](./instagram.md) | `cutroom instagram_post_analytics` | Post metrics and observed history |
| [`instagram_account_insights`](./instagram.md) | `cutroom instagram_account_insights` | Follower count and observed history |

How the surface is divided:

- **The project loop.** [`open`](./open.md) a folder, edit its JSX, [`context`](./context.md) for what the source cannot say, [`capture`](./capture.md) and [`check`](./check.md) to verify, [`export`](./export.md) when asked.
- **Media inspection** ([`probe`](./probe.md), [`grab`](./grab.md), [`transcribe`](./transcribe.md), [`filmstrip`](./filmstrip.md), [`waveform`](./waveform.md), [`listen`](./listen.md)): a file by path, without adding it to the project. Absolute paths work with or without an open project; library paths (`b-roll/clip.mp4`) need one. `listen` accepts local media only; other inspection tools may also accept URLs.
- **Generation.** [`generate`](./generate.md) runs a model of the Cutroom API (images, video, music, speech, and tools such as upscaling) on the account's credits, or a model on this machine for free (with `estimate`, it only prices the request) — [`sam-2.1`](./segment.md) segments and tracks an object in footage, making the mask file a `<mask src>` names; poll [`job`](./job.md) until it has ended, and its files are saved into the library or a directory. The models and their fields are in [models.md](../models.md).
- **What a declaration may name.** [`fonts`](./fonts.md).
- **The app and the machine.** [`logs`](./logs.md), [`screenshot`](./screenshot.md), [`window`](./window.md), [`report`](./report.md).
- **Instagram analytics.** [Four read-only tools](./instagram.md) inspect saved account and post metrics without an open project. Connect an account in **Settings → Instagram** and sync in the app first.

## Downloading footage

There is no download tool, and none is needed: run **[yt-dlp](https://github.com/yt-dlp/yt-dlp)** from a shell. It handles YouTube, TikTok, Instagram, Vimeo, X, direct media links and most other sites, and a download that lands under the project's `assets/` folder is a library asset (see [jsx/media.md](../jsx/media.md)).

## Shared types

```ts
Asset = { id: string; path: string; type: string }  // asset ids are content hashes; `path` is the library path
Time  = number | `${number}f` | "MM:SS"              // seconds, frames at the project's rate ("45f"), or a clock string; see jsx/timing.md
NodeId = string                                     // an element's `id` in the project's JSX; `file:id` (`intro.tsx:hero`, the file name with its extension) when two files collide
```

Time inputs take the `Time` format unless noted otherwise.
