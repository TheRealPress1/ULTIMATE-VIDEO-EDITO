# Cutroom

A local desktop video editor with a Compound-style workflow: import footage, describe the edit, review the result on a real timeline, and export it. Built on [Diffusion Studio](https://github.com/diffusionstudio/editor).

## Run locally

Requires Node.js 22.12+ and npm. macOS is the primary development target.

```sh
npm install
npm run dev
```

This starts Vite and the Electron desktop app. No `.env`, Diffusion Studio account, or API key is required for editing. The optional Instagram analytics connection needs separate Meta authorization. `npm run dev:web` runs a UI preview only; local project access, MCP, agent chat, and rendering require the desktop app.

## Connect your agents

Install and sign in to [Claude Code](https://code.claude.com/docs/en/setup) and/or [Codex](https://developers.openai.com/codex/cli) using their own clients. Cutroom discovers the installed clients, reads their connection status, and offers their available models in the composer. Authentication stays with the provider; Cutroom does not collect subscription credentials.

Choose an agent/model in the composer. The editor's MCP tools are attached to each in-app agent session automatically; changes appear in the canvas and timeline.

Automatic project commands require Claude Code 2.1.310 or later. Cutroom keeps the native sandbox enabled; an older client must be updated before starting a Claude editing session.

The **MCP & agents** settings also let you explicitly connect external coding tools. These toggles update those tools' configuration files. They are optional for in-app chat and are never enabled automatically.

- Local MCP endpoint: `http://127.0.0.1:43127/mcp`
- MCP server name: `cutroom`
- macOS app data: `~/Library/Application Support/Cutroom`
- In-app chats never show permission prompts. Project edits, Cutroom tools, web search/fetch, and sandboxed commands run automatically; Claude chats' commands can also download from public hosts. Commands can write within the project and temporary directories, and neither agent can replace files outside the project. Claude chats use Claude's native command sandbox, which also refuses deleting files or running system commands from the shell, reaching local network addresses, and reading credential stores, with guidance the agent can act on. Codex chats use Codex's workspace sandbox without network access, because that sandbox can't hide credential stores; Cutroom declines its requests for wider access without a prompt, and Codex agents get web and platform media through Cutroom's own download tools instead. Agents still ask you questions when a brief is ambiguous. These session settings do not change your global agent configuration.

An optional CLI can be linked from settings. Without linking it globally:

```sh
npm run build --workspace=@diffusionstudio/cli
node apps/cli/dist/index.js open /absolute/path/to/project
node apps/cli/dist/index.js context
node apps/cli/dist/index.js screenshot -o /tmp/cutroom-screenshots
```

## Edit a video

1. **Import footage.** Drop video, audio, or images onto Home, or use **Add footage or reference files**. Choose **Import and open editor** to inspect the media before sending a prompt. A new project gets an editable **First cut** scene: visual clips play in import order and audio starts at the beginning.
2. **Describe the edit.** Choose Claude Code or Codex and request a concrete result, such as “Make a 20-second cut, open with the third shot, add a title, and lower the music.” Sending from Home imports attached media before the agent starts. The agent receives library paths and measured metadata; it can inspect frames to understand the footage.
3. **Review and refine.** Play the timeline, scrub through the result, and use **Review agent edit → View changes** to inspect source changes. **Undo edit** restores the composition from before the latest agent edit; **Redo edit** reapplies that edit. You can also trim, split, and adjust clips manually.
4. **Export.** Click **Export**, review resolution, duration, format, frame rate, and audio, then choose a location in the native Save dialog. The chosen settings are remembered for that scene and used by subsequent MCP exports. Progress and cancellation appear during rendering; the completion dialog shows the saved path and **Show in Finder**.

Imported media stays linked to its original files, so keep those files available. Import progress and per-file errors appear before the agent starts.

Agent edit review keeps one latest source checkpoint per project across restarts. The separate **Versions** feature retains named and automatic project versions; see below. Agent review covers JS/TS, CSS, JSON/YAML, and subtitle source; footage, the asset library, exports, hidden files, and build folders are excluded. Undo/redo refuses to overwrite newer composition changes and is unavailable while an agent is running. Agent checkpoints support up to 500 source files, 20 MB total, and 2 MB per file. Preview snippets can be shortened; restoration uses the complete source.

Prompts and agent undo/redo wait for pending project saves. Interrupted sessions recover their review on restart, and interrupted restores retain a durable recovery record. Provider-confirmed conversation IDs are saved during the first reply so your next instruction can resume the same conversation after restarting. Recovered edit reviews include the changes present at restart, so inspect them before undoing. See [project safety](docs/project-safety.md) for recovery behavior and limits.

## Working features

- Local projects, project search, recent conversations, and persistent chat history.
- Right-click or two-finger-click a sidebar chat for Open, Rename, Move to folder, and Delete. Named folders organize chats without changing their editing projects. Delete offers Undo; Recently deleted restores conversations across restarts. The more button and Shift+F10 open the same menu. Removing a folder keeps its chats.
- Claude Code and Codex model selection, streamed responses, cancellation, agent questions, and automatic allow/deny decisions without permission prompts.
- Editable JSX compositions, an initial scene from imported footage, canvas manipulation, multiple scenes, timeline trimming/splitting, playback, inspector controls, and export.
- Local speech transcription and automatic captions, editable words and timings, and seven caption presets with font and color controls. External caption JSON edits refresh the existing layer without reopening the project or resetting undo history.
- Latest agent edit review with conflict-protected undo/redo, and export settings, progress, cancellation, and saved-file discovery.
- MCP tools for project context, source editing, media inspection, frame capture, validation, and export.
- Shared UVE editing skills for both agents, saved editing preferences, edited-scene caption tools, and local audio peak inspection/normalization.
- Openly licensed web image, video, and audio search (Openverse and Wikimedia Commons, no API key) and downloads into the project's `assets/web/` folder, with license provenance and a project `CREDITS.md`.
- Music and platform media: agents search YouTube, YouTube Music, SoundCloud and other sites and download a song, an official instrumental, a sound or a video into the project's `assets/music/`, `assets/sfx/` or `assets/footage/` folder, credited in `CREDITS.md` (rights are not verified). On first use the app fetches and verifies its own copy of the downloader; nothing else needs installing, and no prompt appears. A curated music and sound-effect catalog, with your saved picks, and music and sound-effect skills cover choosing, timing and mixing.
- Audio intelligence, powered by [earshot](https://github.com/Leonxlnx/earshot) (MIT): agents hear music and sound effects with local models. They describe a sound, check that an instrumental has no vocals, rank candidates, measure loudness and beats, and check a draft export's sound against its cuts, and they render original, royalty-free effects from a bank of 252 sounds, timed to the cut. The add-on installs itself, with no prompt, the first time an agent needs it: about 2.4 GB, plus caches Cutroom keeps under 500 MB, on Macs with Apple silicon only. **Settings → Audio intelligence** shows its status, with **Install now** and **Remove**, which frees the space. Analysis runs on this Mac and nothing is uploaded.
- Original Cutroom branding, isolated application data, and no upstream telemetry or update service.
- Instagram analytics, comparisons between selected posts, browser authorization when its service is configured, and an explicitly approved publishing queue. Developer-token connections remain available.

The remaining roadmap now includes local visual search, transcript-based timeline editing, audio finishing, rendered review, Instagram connection/publishing infrastructure, and a signed release/update path. External activation is separate: Instagram browser sign-in needs a deployed authorization service and Meta setup; publishing needs permission and a public media URL; private releases use signed/notarized DMGs through GitHub login; automatic private updates need an authenticated service. Other social platforms, an embedded research browser, and hosted generation/billing are not configured; agents use the web and platform media tools for images, video, music and sound instead of hosted generation. See [the roadmap](docs/ROADMAP.md) for exact capabilities and limits.

## Editing skills and personal style

**Settings → Editing skills** shows the versioned library shared by Claude Code and Codex: the base editor and watch guides, story selection, dialogue pacing, caption finishing, social reframing, audio finishing, music, sound effects, personal style, motion graphics, web images and media, performance insights, and final review, plus two guides adapted from earshot for listening and for real-sound design, which use the audio add-on. Both agents receive the same app instructions and can load relevant guides with the `skills` tool. No global agent configuration is changed. Local transcript, waveform, frame and sound analysis are the default; the guides do not assume a hosted audio service is configured.

Save ongoing preferences in **Your editing style**, or explicitly ask the agent to remember a preference. Notes stay in the app's local `editing-style.json`, apply across projects, and yield to each project's brief. Concurrent changes are protected by revisions; failed reads do not erase existing preferences. The `editing_style` tool exposes the same record to both providers.

The `captions` tool transcribes the edited scene mix with local Whisper. **Audio** measures integrated LUFS, true peak and loudness range; optional finishing creates a separate scene with dialogue leveling, conservative noise reduction and editable music ducking. Select music tracks explicitly, list sound effects separately so they stay unprocessed and unducked, and review the resulting full-mix measurement: the dialogue target alone does not guarantee the final mix target. Original media remains unchanged. See the [caption](docs/reference/tools/captions.md) and [audio finishing](docs/reference/tools/audio-finish.md) references.

Optional official OpenAI transcription and speech skills are bundled with their licenses and [pinned provenance](docs/skills/imports/provenance.json). Their UVE launcher defaults to a dry-run; live calls require Python 3.9+, the OpenAI Python SDK, an API key, and your explicit request to use that separate paid service. They are not supplied by a Claude Code or Codex subscription. Remotion guidance is linked as reference material; UVE keeps its own editable JSX renderer. Skill instructions improve the workflow but do not themselves add automatic subject tracking or guarantee editorial quality.

## Automatic social formats

Choose a scene and click **Edit tools → Reframe** to make vertical (1080×1920), square (1080×1080), and landscape (1920×1080) versions. **Follow the speaker** uses a bundled local audio/video model and editable position/scale keyframes, holding briefly or widening the view when uncertain. **Follow faces** samples the original clips locally with macOS Vision and adds editable position keyframes; **Center crop** makes a steady crop without analysis. No media upload or model download is required. Each version remains a normal editable scene, preserving audio, trims, playback speeds, and caption timing. The original scene remains available, and one Undo removes all variants created together.

Captions move into conservative inset margins; static overlays are fitted and flagged for review. Face following favors a prominent nearby face, not an identified speaker. No-face clips use a center crop with a warning. Multiple faces, fast cuts, and long/custom caption text need visual review. Existing custom crops, spatial animations, nested media layouts, and audio sync links require manual preparation. Speaker and face modes support up to two source hours per clip and 100 clips, with saved analysis sections for cancellation/restart. Speaker mode can replace supported full-frame crop tracks in the new copy; it does not assign names or identify off-camera voices. Both agents can use the same workflow through [`reframe`](docs/reference/tools/reframe.md).

## Project version history

**Versions → Save version** records a named point in the project with a preview of the active scene when available, or the canvas otherwise. Automatic checkpoints continue to protect saved edits. **Compare** shows saved and current previews, changed project files, and saved layers. Older checkpoints without an image still expose their saved layers; previews reflect their own view and playback position, not a synchronized video comparison.

Use **Restore layer** to recover a supported layer, including a missing caption, while retaining unrelated current edits. Changed caption dependencies are recovered separately when needed so other layers retain their current words. Dynamic or ambiguous source layers require whole-version restoration. Each restore creates a recovery checkpoint, checks that the project has not changed since comparison, and uses the existing interrupted-restore recovery journal. Original footage remains linked and is never included or rewritten. History retains up to 50 versions within 100 MB in the project folder; keep separate footage backups.

The remaining feature docket and approved build order are recorded in [the roadmap](docs/ROADMAP.md).

## Transcript editing, footage search and review

**Edit transcript** opens words and passages from the current scene. Select words to remove, reorder retained passages, preview conservative filler and measured quiet-pause suggestions, then apply. Video, audio and supported overlays are cut together and captions are remapped. The scene retains its identity, one Undo reverses the change, and a named before-edit version provides recovery. Refresh transcription if caption words no longer match the audio. Unsupported dynamic layouts and timing relationships are reported before changes. See [transcript editing](docs/reference/tools/transcript-edit.md).

In **Footage → Visual B-roll**, search sampled labels and on-screen text, or choose **Description similarity** to find frames from natural-language descriptions using local CLIP embeddings. Description mode requires an explicit one-time 156 MB model download, then **Index descriptions**. Queries and footage stay on this Mac. Results show verified source timestamps and a preview, including MP4 files whose video starts after container time zero; similarity ranks candidates and does not establish that an action happened. Review the source before inserting B-roll. Both indexes reject changed files and persist locally between restarts. See [visual search](docs/reference/tools/visual.md) for limits, cache upgrades, and model provenance.

**Review** samples rendered frames and the audio mix for dark frames, borders, caption/text layout risks, clipping, quiet spans and possible clicks at edit boundaries. Findings are clickable scene times, labeled by evidence. These checks are review prompts: they do not establish lip-sync, speaker identity or editorial quality, and sampling can miss brief issues. See [quality review](docs/reference/tools/quality-review.md).

## Local transcription and captions

The editor's **Footage** tab keeps a searchable speech library for imported videos and audio. Choose **Index footage** once, then search spoken phrases, preview the original moment, and add passages to an ordered selection. **Create cut** builds a new editable scene with gapless clips and captions timed to the new timeline. One Undo removes that composition change; the current camera and selection follow the editor's normal viewing behavior.

Transcripts are stored in the project's `.cutroom/footage-index.json` and reused after restarting the app. Full source fingerprints reject stale matches when recordings change. Indexing runs locally, supports each source up to two hours, and saves completed five-minute sections. **Resume** continues missing sections after cancellation or restart. This mode searches speech; the separate Visual B-roll mode searches visual evidence. Neither identifies speakers. Collect Project excludes the rebuildable index. Both agents use the same library through `footage_index`, `footage_search`, and `footage_cut`; see the [tool workflow](docs/reference/tools/footage.md).

For a development checkout on macOS, install Xcode Command Line Tools and CMake, then build the native speech engine once:

```sh
npm run setup:speech
```

Cutroom uses the multilingual Whisper base model locally. The first transcription downloads 147,951,465 bytes (about 148 MB) of model weights and caches them for later use. After that download, transcription can run offline. No audio or video is uploaded for transcription, and no speech-service account or API key is required. Each recording or scene can be up to two hours long. Source analysis uses five-minute audio sections; scene captions use two-minute sections. Imported local footage and scene captions preserve completed sections for resume. Transcription does not identify speakers; the separate **Follow the speaker** workflow uses audio/video evidence for visible-speaker framing.

1. Open a project with audible video or audio and select its scene, or clear the selection to use the active scene.
2. Run **Generate captions** from the command palette. Cutroom transcribes the scene's audible mix, including its trims and timing. A progress notification shows preparation, model download, and transcription, with a **Cancel** action.
3. Select the resulting caption layer. In **Caption text**, correct words, adjust start/end times in seconds, or remove unwanted words. Use **Apply changes** to save and update the preview; **Reset** discards unapplied edits. Applied changes preserve the previous transcript asset and can be undone.
4. In **Caption → Preset**, choose Classic, Cascade, Spotlight, Whisper, Paper, Guinea, or Stark. The preset's color slots and the text inspector's font controls customize the appearance.

Agents can use the [`transcribe`](docs/reference/tools/transcribe.md) MCP tool, or you can run `cutroom transcribe /absolute/path/to/clip.mp4 -o /absolute/path/to/transcript.json`, to obtain searchable text with word times. This transcribes the source file; **Generate captions** follows the edited scene's audible mix. Review recognized words and timings before exporting, especially with overlapping voices or background music.

## Instagram connection, analytics and publishing

The desktop app can read an authorized Creator or Business account using Meta's [Instagram API with Instagram Login](https://www.postman.com/meta/instagram/folder/6raa77c/instagram-api-with-instagram-login). Personal accounts are unsupported. Switching to Creator makes the account public; changing account type alone does not connect it to Cutroom.

1. Configure your own Meta app for Instagram Login and authorize the professional account. Request `instagram_business_basic` and `instagram_business_manage_insights`. App roles/access review must permit the account being used. This build uses Graph API `v24.0`.
2. In **Settings → Instagram**, use browser sign-in when the authorization service is configured. The optional developer connection accepts an Instagram user access token and stores it in the operating system’s encrypted storage. Never put credentials in chat or a project file. See [authorization and publishing setup](docs/instagram-publishing.md) for Meta permissions, the server deployment and activation requirements.
3. Open **Analytics** and use **Refresh** to fetch up to the latest 25 posts and their available metrics. Meta permissions, supported media types, and account eligibility determine which metrics are returned. Views, reach, likes, comments, saves, shares, and Reel average watch time are supported; unavailable values stay unavailable, and genuine zeroes stay zeroes.

The dashboard's post totals are latest lifetime values for the listed posts. Publication-date filters do not turn them into engagement earned during that period. Reach is shown per post, not summed into a misleading account reach. Follower and post-history charts contain actual local observations, with at most one observation per UTC day retained for 90 days; refreshes currently run on demand, not while the app is closed. Existing posts may lack historical insights, and metrics not returned by Instagram cannot be reconstructed.

Credentials are encrypted by Electron's operating-system credential storage, separate from the stats cache in the app data's `instagram` folder. The token is never returned to the UI after entry or exposed by MCP. Unsafe/unavailable credential storage prevents connecting. Refresh errors preserve the last good cached data and its timestamp. **Disconnect** deletes the local connection and cached stats; revoke the token in Meta separately if needed.

The read-only MCP tools `instagram_accounts`, `instagram_posts`, `instagram_post_analytics`, and `instagram_account_insights` let Claude Code and Codex inspect the same cached data without receiving credentials. They do not connect accounts, fetch fresh data, publish posts, or send messages. **Publishing queue** in Instagram settings lets the user review the exact account, hosted video URL, caption and scheduled time before approval. Scheduling runs while the app is open; uncertain publish results require review rather than automatic retries. **Compare posts** in Analytics compares actual available lifetime metrics and rates, not causal estimates of an editing change. Ask, for example, “Which of my synced Reels have the most saves?” Live account authorization and live Meta responses still require verification with your account; automated API fixtures are not a substitute for that check.

Instagram API and OAuth tests use isolated fixtures. They do not publish to your account or substitute for a live permission/deployment check. Existing credentials and cached account statistics are preserved during local feature verification.

## Development

```sh
npm run check
npm run test
npm run lint
npm run build
```

### Standalone macOS build

Build the speech engine once with `npm run setup:speech`, then run `SKIP_SIGN=1 npm run make`. On Apple Silicon this produces `apps/desktop/out/Cutroom-darwin-arm64/Cutroom.app`, `apps/desktop/out/make/Cutroom-arm64.dmg`, and a ZIP under `out/make/zip/darwin/arm64/`. Open the DMG and drag Cutroom to Applications. Launch it from Applications, Spotlight, or the Dock; no development server or separate Node installation is needed for editing, captions, or export.

The app bundles its compiler, media workers, CLI, documentation, and native speech engine. Projects remain ordinary folders outside the app. Claude Code and Codex still need their own installed, signed-in clients. Transcription downloads its model on first use and reuses the local cache afterward. The CLI can be installed from Settings, or invoked directly at `/Applications/Cutroom.app/Contents/Resources/cli/bin/dapi`.

Local `SKIP_SIGN=1` builds remain unsigned. Production releases fail closed on signing/notarization errors and independently notarize/staple both the app and installer. Private distribution uses GitHub-authenticated downloads from Settings; automatic private updates still need an authenticated service. Verification checks the actual app, ZIP and mounted DMG, and a separate profile supports isolated acceptance testing. See [release setup](docs/releasing.md). Native tools must match the target architecture, and macOS 13 or newer is required.

The root `extract-zip` dependency and its `yauzl@3.3.1` override work around [Forge's Node 24.16/26 extraction failure](https://github.com/electron/forge/issues/4277). The direct dependency is necessary for npm to apply that override through this workspace's dependency tree. Keep both until the packaging dependency is upgraded.

To regenerate the original desktop artwork: `uv run --with pillow scripts/generate-icons.py`.

The dependency audit still reports inherited build and packaging issues, including a critical `tar` advisory in Electron Forge 7's development dependency tree. Electron and Zod are updated to patched releases. The remaining build-tool upgrades stay on the release-maintenance docket; development-only findings are not described as shipped app vulnerabilities.

The import-to-export workflow was exercised with generated 30-second footage: Claude Code trimmed and reordered it into an 18-second montage with a title and music, Codex revised the title, and both edits were undone and redone with exact source restoration. Native Save and Show in Finder worked; the exported H.264/AAC file retained the requested 1280×720 resolution, 24 fps, shot order, music gain, and fade. Original media hashes were unchanged. That earlier acceptance run passed its automated and build checks. Current test totals are recorded in the latest implementation acceptance report; lint retains three existing warnings.

macOS AAC exports now use a lossless PCM intermediate and bundled native finalization with explicit encoder-delay metadata. A synthetic onset test preserved timing with zero measured sample offset while keeping video packets unchanged. Finalization is atomic and cancelable. The renderer remains an SDR canvas pipeline; HDR and wide-gamut mastering are not claimed. See [export timing and color](docs/releasing.md#export-timing-and-color).

The source packages retain their `@diffusionstudio/*` names and composition format for compatibility. The application identity, local storage, CLI command, and MCP connection are Cutroom-specific.

| Location | Purpose |
| --- | --- |
| `apps/web` | SolidJS interface and interactive editor |
| `apps/desktop` | Electron, local project access, MCP server |
| `apps/cli` | Cutroom CLI and stdio MCP proxy |
| `packages/agent-chat` | Local Claude Code/Codex sessions and chat protocol |
| `packages/runtime`, `reconciler`, `jsx` | Composition execution and editing |
| `packages/encoder` | Rendering and media encoding |
| `docs` | Composition and tool references |

## Source and license

Based on Diffusion Studio commit `af570c164a5d0ee961040feb1f8d1d40617c291d` (v0.216.0). Its source notices and [MPL-2.0 license](LICENSE) are preserved. The audio add-on (earshot, MIT, with PyTorch, its models and a separate GPL FFmpeg build) is not bundled: it is downloaded on first use into the app data and deleted by **Remove**; see [sound tools](docs/reference/tools/sound.md#provenance-and-licences). The excluded upstream desktop brand assets were replaced with original artwork. Compound was used as an interface/workflow reference; no Compound application code, private projects, or artwork is included.

### Reference editing and long recordings

**Edit tools → Reference style → Edit like this** analyzes an imported video and hands its measured style to your connected agent, starting a new editable scene. Analyze-only and local layout actions are also available. [Reference workflow](docs/reference/tools/reference-style.md).

Speech indexing, captions, face/speaker analysis, native visual indexing and rendered quality review now process recordings up to two hours in bounded sections, retaining completed sections across cancellation/restart. Long and high-resolution footage automatically gets smaller playback copies in the background. Original audio and full-quality export remain in use. [Playback behavior and cache limits](docs/playback-performance.md).
