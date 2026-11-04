# Tool reference

Cutroom exposes one set of tools, reachable two ways:

- **MCP.** The running app serves an MCP server at `http://127.0.0.1:43127/mcp` (Streamable HTTP). A connected agent gets every tool in `tools/list`, with the descriptions on these pages and its input and output as JSON Schema 2020-12, and instructions that give the path of these docs in the installed app. A client that can only spawn a stdio server can bridge to the URL with a generic proxy such as `mcp-remote`.
- **CLI.** `cutroom`, the command-line client shipped with the app, wraps many tools as commands for shells, scripts and CI. The others are MCP-only, with — in the CLI column below: `skills`, `skill_write`, `editing_style` and `memory`, the script tools (`script_lint`, `script_read_compare`), the scene and footage tools (`analyze`, `segment`, `quality_review`, `visual_*`, `transcript_edit_*`, `footage_*`, `reference_*`, `reframe`, `captions` and `audio_finish`) the sound tools (`sound_analyze`, `sound_effects`) and `ask_gemini`. `cutroom <command> --help` prints the same description and the same field help.

Both validate against the same schemas and return the same result, so each tool is documented once, on its own page. The same write rules hold for every client — in-app chats, other MCP clients and the CLI alike: tools write anywhere in the open project and temporary folders, elsewhere only new files in Desktop, Documents, Downloads, Movies, Music or Pictures, and `open` makes a folder the project only where that is allowed (see [`open`](./open.md)). The catalog behind all three (server, CLI, these pages) lives in `packages/dapi`.

The JSX code syntax specified in [jsx/](../jsx/README.md) is **pseudo-SVG**, mirroring SVG's shape-and-paint model with the editor's own tags and props rather than the SVG spec. A project is a folder of that JSX, and **the source is the document**: the app compiles the entry file and renders every element into an editable node, and edits made on the canvas are written back to the element that authored them. So the loop is [`open`](./open.md) once, then edit the files — there is no tool that pushes content into the app. What the tools do is read the running app ([`context`](./context.md), [`capture`](./capture.md), [`logs`](./logs.md)), inspect media, and list what a declaration may name.

## Names

A tool is named as MCP lists it, and the CLI spelling follows from the name:

- The tool name is the command: `grab` is `cutroom grab`.
- A tool's first field is the positional argument: `capture`'s `id` is `cutroom capture <id>`.
- Every other field is an option in kebab-case: `perSheet` is `--per-sheet`, `separate` is `--separate`. Short forms are listed on each page.
- Times are written the same way everywhere: seconds (`1.5`), frames at the project's rate (`45f`), or a clock string (`1:30`, `00:01:30`). Times in **results** are plain seconds.

## Results

Every tool returns one JSON object, its *structured content*. Over MCP that is the result's `structuredContent`, repeated as a text block for clients that ignore structured content; the CLI prints it to stdout, unchanged. Tools that render images (`capture`, `grab`, `filmstrip`, `waveform`, `screenshot`) write PNGs to disk and return their paths; over MCP a result of at most four images, none over a megabyte, also carries them inline as image content, so a contact sheet arrives in context without opening anything. [`sound_analyze`](./sound.md)'s `sheet` inlines its annotated picture of a soundtrack the same way. [`web_media_search`](./web-media.md) and [`media_search`](./media.md) inline their leading results' thumbnails the same way, in their own format (JPEG, PNG, WebP or GIF), and name each local copy in the result's `previewPath`.

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
| [`analyze`](./analyze.md) | — | One timestamped evidence pack for a whole video: speech, sampled frames, on-screen text, silences, sound events |
| [`quality_review`](./quality-review.md) | — | Inspect rendered frame and audio observations |
| [`visual_index`, `visual_search`, `visual_status`](./visual.md) | — | Index and search visual B-roll evidence |
| [`transcript_edit_inspect`, `transcript_edit_apply`](./transcript-edit.md) | — | Review and apply text-based timeline edits |
| [`footage_index`, `footage_search`, `footage_cut`](./footage.md) | — | Index the project's speech, search it, and build a cut from passages |
| [`reference_analyze`, `reference_apply`](./reference-style.md) | — | Analyze a reference video and apply its layout to a new scene |
| [`reframe`](./reframe.md) | — | Create vertical, square and landscape versions of a scene |
| [`export`](./export.md) | `cutroom export` | Export scene |
| [`probe`](./probe.md) | `cutroom probe` | Probe media |
| [`grab`](./grab.md) | `cutroom grab` | Grab frames |
| [`transcribe`](./transcribe.md) | `cutroom transcribe` | Transcribe speech |
| [`captions`](./captions.md) | — | Caption the edited scene locally |
| [`skills`](./skills.md) | — | List and read shared editing workflows |
| [`skill_write`](./skills.md) | — | Save, change or archive the user's own skills |
| [`editing_style`](./skills.md) | — | Read or save approved style preferences |
| [`memory`](./memory.md) | — | What agents remember about the user and their setup, across chats and projects |
| [`script_lint`](./script.md) | — | Check a script's spoken length, opener and lines against the brief |
| [`script_read_compare`](./script.md) | — | Line a recorded read or a multi-take shoot up against the script |
| [`audio_catalog`](./audio-catalog.md) | `cutroom audio_catalog` | List curated music and sound effects; save the user's picks |
| [`audio_finish`](./audio-finish.md) | — | Measure loudness and true peak; finish dialogue and duck music |
| [`sound_analyze`](./sound.md) | — | Hear music and sound effects with local models: describe, match, rank, find, measure, and check sync to picture |
| [`sound_effects`](./sound.md) | — | Render original, royalty-free effects from earshot's bank into the project, with onset and peak times |
| [`filmstrip`](./filmstrip.md) | `cutroom filmstrip` | Filmstrip preview |
| [`waveform`](./waveform.md) | `cutroom waveform` | Waveform preview |
| [`listen`](./listen.md) | `cutroom listen` | Inspect local speech evidence |
| [`ask_gemini`](./ask-gemini.md) | — | Ask Gemini about a video, a sound or a YouTube link with the user's own key; the one tool that uploads media |
| [`generate`](./generate.md) | `cutroom generate` | Generate media |
| [`job`](./job.md) | `cutroom job` | Generation job |
| [`segment`](./segment.md) | — | Mask and track an object in footage with local SAM 2.1 |
| [`web_media_search`](./web-media.md) | `cutroom web_media_search` | Search openly licensed web images, video and audio |
| [`web_media_download`](./web-media.md) | `cutroom web_media_download` | Download web media into the project, with credits |
| [`media_search`](./media.md) | `cutroom media_search` | Search YouTube, YouTube Music, SoundCloud and other platforms |
| [`media_download`](./media.md) | `cutroom media_download` | Download platform audio or video into the project, with credits |
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

- **The project loop.** [`open`](./open.md) a folder, edit its JSX, [`context`](./context.md) for what the source cannot say, [`capture`](./capture.md) and [`check`](./check.md) to verify, [`export`](./export.md) a delivery file when asked (a review draft to a temporary folder needs no request).
- **Understanding a whole video.** [`analyze`](./analyze.md) gathers speech, frames picked at visual changes, on-screen text, silences and (once the audio add-on is ready) sound events into one timeline of timestamped sections, for an agent to interpret; long files run as a job. Confirm what a decision rests on with [`grab`](./grab.md) or [`listen`](./listen.md).
- **Asking Gemini.** [`ask_gemini`](./ask-gemini.md) puts a video or audio file (or a public YouTube link) in front of Google's Gemini under the user's own key from Settings, for what sampled evidence can't settle: motion, expression, tone, music, how a take feels. It is the only tool that uploads media, and refuses until a key is saved; `send: "audio"` uploads only the sound. Long files run as a job.
- **Media inspection** ([`probe`](./probe.md), [`grab`](./grab.md), [`transcribe`](./transcribe.md), [`filmstrip`](./filmstrip.md), [`waveform`](./waveform.md), [`listen`](./listen.md)): a file by path, without adding it to the project. Absolute paths work with or without an open project; library paths (`b-roll/clip.mp4`) need one. `listen` accepts local media only; other inspection tools may also accept URLs.
- **Generation.** [`generate`](./generate.md) runs a model on this machine for free — [`sam-2.1`](./segment.md) segments and tracks an object in footage, making the mask file a `<mask src>` names, and [`segment`](./segment.md) is the direct way to call it — or, only where hosted generation is configured, a model of the Cutroom API (images, video, music, speech, and tools such as upscaling) on the account's credits; without that service hosted models fail at once. With `estimate`, it only prices the request. Poll [`job`](./job.md) until it has ended, and its files are saved into the library or a directory. The models and their fields are in [models.md](../models.md).
- **Web media.** [`web_media_search`](./web-media.md) finds openly licensed images, video and audio on Openverse and Wikimedia Commons, with license terms and thumbnails; [`web_media_download`](./web-media.md) saves a result or a user's link into the project's `assets/web/` (or `music`/`sfx`), imports it, and credits it in `CREDITS.md`. This is how to get licensed photos, B-roll, music and sound.
- **Platform media.** [`media_search`](./media.md) searches YouTube, YouTube Music, SoundCloud and MyInstants, and lists a creator's latest uploads on other platforms; [`media_download`](./media.md) saves a video's audio (the default) or picture and sound from those sites into the library (`assets/music/`, `assets/footage/` or a chosen folder) and credits its source. Rights are not verified. The app runs its own managed downloader, so nothing needs installing and agents never run one in the shell.
- **Music and sound effects.** [`audio_catalog`](./audio-catalog.md) lists a curated, tagged catalog of music and effects merged with the user's saved picks; each entry names the download call that fetches it. [`sound_effects`](./sound.md) renders effects from a bank of 252 original, code-made sounds into `assets/sfx/`. The [music](../../skills/uve-music/SKILL.md) and [sound effects](../../skills/uve-sfx/SKILL.md) skills cover choosing, timing and mixing.
- **Hearing sound.** [`sound_analyze`](./sound.md) runs earshot's CLAP and AudioSet models on this Mac: what a file sounds like, whether it matches a description or has vocals, its best moments, exact loudness, and a draft export's sync to its cuts and cues. It hears sounds and music, not words (that is [`listen`](./listen.md)). Both sound tools run through an add-on that installs itself on the first call, with no prompt (about 2.4 GB, Apple silicon only); **Settings → Audio intelligence** shows it and **Remove** frees the space.
- **Scripts.** [`script_lint`](./script.md) runs fixed checks on a script in the project's [`brief.md`](../brief.md) or inline text; [`script_read_compare`](./script.md) aligns a recording to it line by line. The [scripting skill](../../skills/uve-scripting/SKILL.md) uses both.
- **Memory and the user's skills.** [`memory`](./memory.md) holds short notes on who the user is and their setup; [`skill_write`](./skills.md) keeps procedures they want repeated, which [`skills`](./skills.md) lists with category `user`. Both are stored in the app's data, change only through these tools, and refuse credentials and instructions aimed at agents. Settings shows both.
- **What a declaration may name.** [`fonts`](./fonts.md).
- **The app and the machine.** [`logs`](./logs.md), [`screenshot`](./screenshot.md), [`window`](./window.md), [`report`](./report.md).
- **Instagram analytics.** [Four read-only tools](./instagram.md) inspect saved account and post metrics without an open project. Connect an account in **Settings → Instagram** and sync in the app first.

## Downloading media

Two tools download, and which one follows from the link. The app does the downloading in both cases (the agent's sandbox needs no network), checks the file is real media, imports it as a library asset, and records its source in the project's `CREDITS.md`.

- [`web_media_download`](./web-media.md) takes a [`web_media_search`](./web-media.md) result, a direct file link, or a web page that shares an image or video, and keeps its license terms. Files land in `assets/web/` unless `folder` says `music` or `sfx`.
- [`media_download`](./media.md) takes a YouTube, YouTube Music, SoundCloud, TikTok, Instagram, X or Vimeo link (or another site its downloader supports) and saves its audio by default, or picture and sound with `kind: "video"`; with no project open it can save to an absolute `folder` instead. The rights are not verified. Given one of those links, `web_media_download` fails with a pointer here.

Never fetch media with `curl`, `yt-dlp` or a script: nothing records where it came from or adds it to the library. Any file placed under the project's `assets/` folder is still a library asset (see [jsx/media.md](../jsx/media.md)).

## Shared types

```ts
Asset = { id: string; path: string; type: string }  // asset ids are content hashes; `path` is the library path
Time  = number | `${number}f` | "MM:SS"              // seconds, frames at the project's rate ("45f"), or a clock string; see jsx/timing.md
NodeId = string                                     // an element's `id` in the project's JSX; `file:id` (`intro.tsx:hero`, the file name with its extension) when two files collide
```

Time inputs take the `Time` format unless noted otherwise.
