# Sound analysis and sound effects

`sound_analyze` tells an agent what sounds, music and sound effects sound like (not the words spoken: use [`transcribe`](./transcribe.md) or [`listen`](./listen.md) for speech), how they measure, whether a recording reads as real, and whether an edit's sounds land on its picture. `sound_effects` lists, renders and audits a bank of 252 code-made sound effects, rendering them into the open project with the timing points needed to place them on a cue. Both are powered by [earshot](https://github.com/Leonxlnx/earshot) 0.4.0 (MIT), which Blackout installs as a local add-on the first time an agent needs it. Both are Blackout MCP tools: they run without a shell, without a permission prompt, and without sending audio anywhere.

| Tool | Needs a project | Does |
| --- | --- | --- |
| `sound_analyze` | only for library and project-relative paths | Describe, match, rank, find, compare, A/B, realness, measure, timeline, sheet and critique on local audio or video files |
| `sound_effects` | for `render` | List the bank, render one sound into `assets/sfx/` with its onset, peak and end, and audit any effect file |

The [earshot listening](../../skills/imports/earshot-listening/SKILL.md) and [real sound](../../skills/imports/earshot-real-sound/SKILL.md) skills are the workflows built on them.

## sound_analyze

Every call takes an `action` and that action's fields, which mirror earshot's own names and limits.

| `action` | Required | Optional | Answers |
| --- | --- | --- | --- |
| `describe` | `path` | `start`, `end`, `top` (tags per category, 1-30, default 8) | What does it sound like: calibrated tags per category (source, material, action, character), AudioSet top labels, key measurements and a one-paragraph summary. Use it first on any unknown file, or to check that a download is what its title claims. |
| `match` | `path`, `query` | `alts` (1-5 alternative descriptions), `start`, `end` | How well one sound matches a description: `z`, `verdict` (z >= 3 strong, 2.5-3 plausible, 2-2.5 weak, below 2 no match), percentile, `p_vs_alts` (an uncalibrated forced choice among your wordings), raw cosine, and the closest vocabulary descriptions. |
| `rank` | `paths`, `query` | `top` (default 20) | Many candidates sorted by how well they match the description. |
| `find` | `path`, `query` | `top` (1-50, default 5), `kind` (`auto`, `event`, `texture`), `win`, `hop` (texture window and hop, seconds), `start`, `end` | The best moments inside one long recording as trims: `start`, `end`, `z`, `verdict`, `kind` (`stroke`, `event`, `window`), head and tail levels, and `cut` ("head cut" / "tail cut" when the trim starts or ends inside a sound). |
| `compare` | `path`, `refs` | `k` (nearest references, 1-50, default 5), `start`, `end` | Similarity to a set of reference recordings: the nearest ones, typicality (z >= -1 fits the set, below -2 is an outlier) and which measurements differ, in words. |
| `ab` | `a`, `b` | `query`, `refs`, `a_start`, `a_end`, `b_start`, `b_end` | Which of two sounds is closer to a description or a reference set, and how B differs from A in measured terms (louder, brighter, longer decay). A and B may be the same file with different trims. |
| `realness` | `path` (a file, or a folder or glob for one row per file) | `start`, `end`, `ast` (add AudioSet evidence, slower) | Real recording or professionally produced audio versus simple code-synthesized sound: `p_real`, a verdict and the evidence in words; files over 6 s also get per-window verdicts. |
| `measure` | `path` | `start`, `end`, `music` (tempo, beats, key), `light` (levels and spectrum only) | Exact meters, no models: duration, integrated LUFS, true peak dBTP, loudness range, noise floor, clipped samples, exact digital zeros, attack and decay, brightness, bandwidth, band energy, onsets. |
| `timeline` | `path` | `video`, `cues`, `start`, `end`, `detail` (`low`, `normal`, `high`) | The listening transcript of a soundtrack or film: events with time, level and tags, sections, loudness curve, picture cuts and sync to cuts and cues. |
| `sheet` | `path` | `video`, `cues`, `start`, `end`, `detail` | An annotated picture on one time axis (video frames, sections, labelled events, spectrogram, waveform with loudness, beats, cue markers coloured by sync: green within a frame, amber within 100 ms, red none), returned inline. |
| `critique` | `path` | `video`, `profile` (a reference profile JSON made by earshot's `profile` command; default: the bundled launch films), `fast` (skip the AudioSet and realness passes) | A scorecard against the measured range of seven professional launch films: each metric ok / low / high with its weight, timed actions, and a verdict (launch-grade, close, needs work, not launch-grade). |

Every action also takes `full: true` to return earshot's complete JSON instead of the compact one.

| Field | Type | Description |
| --- | --- | --- |
| `path`, `a`, `b` | `string` | a library path (`sfx/whoosh.wav`) or a project-relative path (both need an open project), or an absolute local path to an audio or video file (WAV, FLAC, Ogg, MP3, M4A, or the audio track of MP4, MOV or WebM) |
| `paths`, `refs` | `string` or `string[]` | files, folders (searched recursively) or globs (`sfx/*.wav`, `**` for any depth); earshot gets the audio and video files in them by their real paths, so results name those |
| `query`, `alts` | `string`, `string[]` | plain descriptions of the sound itself, not its use: "a deep thocky mechanical keyboard key press", not "a sound for the logo" |
| `start`, `end`, `a_start`, `a_end`, `b_start`, `b_end` | `number` | source seconds of the file: analyze only that segment (a trim from `find`, a chorus window) |
| `video` | `string` | the film whose picture cuts and frames go with an audio file; a video `path` is its own picture |
| `profile` | `string` | critique: a reference profile JSON file, read like the other paths |
| `cues` | `number[]` or `string` | picture event times in seconds of the analyzed file (a list, `"1.2,3.4"`, or JSON text), or the path of a cues JSON file (`{ fps, events: [{ f or t, kind }] }`), resolved and checked like the other paths (`./cues.json` and `2026-cues.json` are files) |

Paths are checked like other agent file reads: URLs are refused (download first with [`web_media_download`](./web-media.md) or `media_download`), and so are locations that hold credentials or private app data. A folder or glob is checked file by file, links followed, so one file in it that leads to such a location refuses the call. A video without an audio track says so.

Each call returns earshot's plain-language summary first (for `timeline` with the listening transcript, for a folder `realness` with one row per file), then its JSON, compacted to stay small, and the `version` of earshot that answered. `sheet` writes its PNG into a fresh temporary folder and returns the image inline with its path.

### Hearing an edit

The tools read files, not scenes. To check an edited scene, [`export`](./export.md) it to a temporary path (for example `/tmp/promo-sound-v1.mp4`) and pass that file to `timeline`, `sheet`, `critique`, `realness` or `ab`. Such a draft is a check, not a delivery, so it needs no request from the user ([review drafts](./export.md#review-drafts)); drafts go only to a temporary folder, never into `exports/` or over a delivered file, and the delivery file still waits for the user to ask. The export starts at the workarea's first frame, so give `cues` in export time: scene time minus the workarea start, as for [`capture`](./capture.md). To A/B a change, export before and after to two files. [`audio_finish`](./audio-finish.md) `measure` on the scene gives the mix's exact loudness without an export.

```json
{ "action": "timeline", "path": "/tmp/promo-sound-v1.mp4", "cues": [1.0, 4.0, 8.0], "detail": "normal" }
```

Is a track an instrumental? `match` a chorus window against `"an instrumental without vocals"` with `alts: ["a song with singing"]`, or `describe` it and read the singing and speech labels; check more than one window, and pair it with `listen`, where recognized words mean vocals.

```json
{ "action": "match", "path": "music/a1B2c3D4e5F.m4a", "start": 62, "end": 72, "query": "an instrumental without vocals", "alts": ["a song with singing", "a rap verse"] }
```

## sound_effects

| `action` | Fields | Does |
| --- | --- | --- |
| `list` | `category` (`whoosh_fast`, `ui_pop`, `pro_impact`, `typing_key`, …), `kind` (a cue kind: `whoosh`, `hit`, `key`, `bell`, `pop`, `click`, …) | Without a filter, the bank's categories, each with its ids (`<category>/<member>`, `pluck/<name>`, `fit/<role>/<name>`), the cue kinds it serves and its use. With a `category` or `kind`, also every matching sound with its length, onset and peak time, its cue kinds and its knobs: `dur`; `apex` for the whoosh family; `pitch` for tonal sounds, with the native note. No project needed. |
| `render` | `id` (required), `dur`, `apex`, `pitch`, `seed`, `name` | Renders one take into the open project's `assets/sfx/`, imports it, and returns where it is and when it sounds. |
| `check` | `path`; optional `category` and `role` (`hit`, `land`, …) for context | Runs the same model-free audit on any effect file, such as a download. A hit role turns two attacks or a build before the hit into warnings. |

Render knobs edit the recipe's own parameters; nothing is resampled or time-stretched:

- `dur`: the file length in seconds, exact. Whooshes and swipes scale rise, hold and fall together; risers, drops, shimmers, zips, glitches, typing runs and UI sounds scale their own length; impacts, toggles, keys, logo stings and plucks keep their sound and are faded or padded to the length.
- `apex`: seconds from the start to the loudest moment, whoosh family only (`dur: 0.8, apex: 0.32` is a 0.8 s pass peaking 0.32 s in), landed within a few milliseconds.
- `pitch`: a note (`"E5"`, `"Eb6"`, `"F#4"`) or hertz (`"440"`) through the recipe's pitch parameter. Noise sounds (whooshes, swishes, swipes, glitches, typing) refuse it, as do targets outside a sound's range.
- `seed`: a new take of the same sound (its noise, jitter and micro-timing change, the character stays); omitted, the delivered final.
- `name`: a readable base for the file name of a new take.

The file is `assets/sfx/<slug>-<key>.wav` (24-bit, 48 kHz, peak -1 dBFS): the key comes from the id, the knobs and the seed, so the same render again reuses the existing file instead of writing a copy, also when it is asked for under another `name` (the file keeps the name it got first). earshot renders into a temporary folder outside the project; the take lands in `assets/sfx/` only once it is complete. Saving or moving the project while a take renders stops the render: render it again in the project where it is now. The result:

| Field | Description |
| --- | --- |
| `src` | the library path to use in JSX, such as `sfx/whoosh-fast-crisp-….wav` |
| `path` | the file's absolute path |
| `durationSeconds` | the file length |
| `onsetSeconds`, `peakSeconds`, `endSeconds` | where the sound starts (first point within 30 dB of its maximum), is loudest (loudest 5 ms) and ends (last 5 ms within 50 dB of the loudest), in seconds from the file's start |
| `audit` | `ok`, `summary`, `warnings` and `notes` (each `{ code, msg }`) |

Place a take on its cue at `sourceIn` 0 and `playbackRate` 1 by its cue kind: the onset on the frame for hits, taps, knocks, clicks, keys, pops and bells (`start = cueTime - onsetSeconds`); the peak for whooshes on a move's velocity peak and for swells and peak-aligned risers on their hit (`start = cueTime - peakSeconds`); the end for a riser that stops on its loudest moment (`start = cueTime - endSeconds`).

```tsx
<audio id="sfx-whoosh-1" src="sfx/whoosh-fast-crisp-3f2a9c1d.wav" start={3.68} volume={-16} />
```

Here the take peaks 0.32 s in, so its apex lands on the move's velocity peak at 4.0 s. List effect clips in `effectIds` when finishing the scene with [`audio_finish`](./audio-finish.md), so they keep the timing and level you set; an effect left out of it is mixed into the dialogue derivative, leveled, denoised and ducking the music.

| Audit code | Meaning |
| --- | --- |
| `silent` | nothing to hear: a peak under -60 dBFS, or under 5 ms within 40 dB of its peak |
| `clicks`, `edge` | isolated discontinuities inside the sound; a first or last sample off zero (it clicks when played) |
| `clipping`, `dc` | flat tops or samples over full scale; a DC offset |
| `ring` | a metallic comb in the tail |
| `truncated` | a tail cut while still decaying (a note when the stop is the design, as for risers) |
| `silence`, `tail` | digital silence inside the sound; a tail that rises again (a second event) |
| `rising_glide` | a tonal pitch climbing more than 4 semitones: the cheap "synth whip" tell (water drops are allowed their climb) |
| `stacked`, `pre_swell` | a hit with two separate attacks, or more than 100 ms of build before it |
| `pitch_off` | a note the pitch knob did not land |

Warnings make `ok` false: swap the sound or the knob rather than keep a warned take. Notes are information.

### The bank

252 sounds, all pure DSP with no recorded audio inside: 183 sounds made by earshot's forge (34 categories, 4-6 members each), 51 members made in 0.4 for the soft, short, mid-register sound of music-led launch films (`ui_pop`, `knock`, `cut_hit`, `mallet`, `drip`, `shutter`, `reverse_swell` and new members of older categories), 3 tuned kalimba voices (`pluck`), and 15 sounds fitted as code from CC0 recordings (`fit/<role>/<name>`: clicks, a tick, pops, light touches, keys, a space bar, a snap, a bell, a whoosh, a knock). Categories cover clicks and ticks, taps, toggles, pops, notification bells, shimmers, whooshes, swishes and swipes, risers and downlifters, zips, impacts, sub drops, logo stings, glitches and typing; `list` has every member. There is no music and no ambience in the bank.

The renders are original, MIT-licensed code output, and each is credited in the project's `CREDITS.md`, beside downloaded web media, as an earshot bank render (`earshot bank <id>, v0.4.0, MIT`). They were chosen and checked by measurement, not by a listening test, and they are not recordings: when a brief asks for recorded sound, search real recordings instead. Far `dur` or `pitch` settings change a sound's character, and only the audit checks the edit.

## The audio add-on

### Installing

Nothing to set up. The first `sound_analyze` or `sound_effects` call installs the add-on; **Install now** in **Settings → Audio intelligence** does the same ahead of time. A call waits up to about 90 seconds for the install, then fails with `busy`: "Audio intelligence is installing (step N/5, X of Y MB). Continue with other work and call this tool again in a few minutes." The install keeps going in the background, and calling again later picks it up. There is no prompt and no click.

| Step | What | From | Verified by |
| --- | --- | --- | --- |
| 1 | uv 0.13.7, the Python installer, for Apple silicon | github.com | a SHA-256 pinned in the app |
| 2 | CPython 3.12 and a private virtual environment | uv's managed Python builds | uv's own checksums |
| 3 | PyTorch 2.11.0's CPU wheel for Python 3.12 on Apple silicon, then earshot 0.4.0 from the source archive of commit `591fa3e` with its dependencies, resolved as of earshot's release date (2026-10-22) so a later release on PyPI never changes what is installed; the resolved versions are recorded | download.pytorch.org, github.com, PyPI | the torch wheel's and the archive's SHA-256 pinned in the app, the wheel installed from that checked copy; every other wheel against the SHA-256 PyPI publishes, checked by uv (those are pinned by version and date, not by a hash list in the app) |
| 4 | FFmpeg 9.0.2 and ffprobe, the static macOS builds by Martin Riedl ([ffmpeg.martin-riedl.de](https://ffmpeg.martin-riedl.de), signed with a Developer ID), for Apple silicon | ffmpeg.martin-riedl.de | a SHA-256 per file pinned in the app |
| 5 | the models earshot pins: CLAP `laion/larger_clap_general` at revision `16c8cc3` (Apache-2.0) and the AudioSet tagger `MIT/ast-finetuned-audioset-10-10-0.4593` at `f826b80` (BSD-3-Clause), about 1.1 GB, fetched by earshot itself | Hugging Face | pinned revisions, safetensors weights |

The models are about 1.1 GB; with Python, PyTorch, earshot's packages and FFmpeg a fresh install takes about 2.4 GB, shown in Settings with what its caches hold (up to 500 MB more: see [Storage](#storage)). Blackout's bundled FFmpeg is a minimal LGPL build for audio: it decodes AAC, MP3, Opus, Vorbis, FLAC and PCM in a few containers, and no video at all. earshot also reads picture cuts and frames, which take H.264 and the other video decoders, and whatever codec or container a user's media comes in, so the add-on downloads its own full build; that GPL build is downloaded on this Mac, never shipped inside Blackout.

Both tools need a Mac with Apple silicon, the model-free `sound_effects` included: PyTorch is one of earshot's core dependencies, earshot needs PyTorch 2.6 or later, and PyTorch has published no Intel macOS build since 2.2.2. On an Intel Mac the install stops before downloading anything, and every `sound_analyze` and `sound_effects` call fails at once with that reason.

Everything lives in the add-on folder in Blackout's app data (`addons/earshot/`; development and isolated profiles have their own): `bin/` (uv), `python/`, `venv/`, `home/` (models and caches), `ffmpeg/` and `state.json` (versions, step, sizes, error). Steps are resumable: an interrupted or repeated install skips what is already verified and removes partial downloads. One install runs at a time. A network failure leaves the state `failed` with a one-line reason; the next tool call or **Install now** retries.

Settings shows the add-on as not installed, partly installed (an install that was stopped, by quitting for example, or that a Blackout update has to finish, with what it holds on disk so far), installing (with step and progress), ready (with size and versions), failed (with the reason and what it left on disk) or removing; it follows an install an agent started while Settings is open. On an Intel Mac it says the add-on can't run there and offers no install. **Remove** stops earshot and deletes the add-on folder with its models and caches, freeing the space, whenever there is something to free; the next sound call installs it again.

### Storage

The add-on folder grows with use. earshot decodes every file it analyzes once and keeps the decoded copy in `home/decoded/` (float32 samples at 48 kHz: about 23 MB per minute of stereo, plus a separate mono copy when an action needs one), with its embeddings and results in `home/emb/`. A trimmed `start` / `end` still caches the whole file, and every draft export (a new file each time) adds its own copy. earshot never removes these itself, so Blackout keeps them under 500 MB: a sweep when earshot starts and every two minutes while it runs removes the least recently used entries until they hold less than 400 MB. A removed entry is worked out again the next time its file is analyzed; the models are never touched. The same sweep clears temporary folders a quit or a crash left behind (a sheet's picture, a take on its way into a project). Settings shows the install's size plus what the caches hold now. **Remove** deletes everything.

### Running

Blackout starts one earshot process and keeps it warm, so models load once (about 10 s after a start on an M2 Pro, longer on a slower Mac) and later calls take seconds. Calls run one at a time, in the order they come, and a long file can take minutes: analyze a `start` / `end` window of it when that is enough. Each call's time limit counts from when earshot starts on it. Canceling a call, or its timeout, returns at once; earshot cannot interrupt an analysis it has started, so Blackout ends the process, and the next call starts a fresh one and loads the models again. A call canceled while it waits for its turn never reaches earshot. earshot uses at most four CPU threads (half the cores, at least one). A crashed process is restarted (at most twice in ten minutes; **Remove** starts that count over); an idle one stops after 15 minutes to free its memory and starts again on the next call, and quitting Blackout ends it at once. Bank renders need no models: well under a second each on an M2 Pro, also on a freshly started process (the very first render after installing can take longer).

## Offline and privacy

All analysis and rendering runs on this Mac: no audio, video, query or file name is uploaded, and no account, API key or credits are involved. The network is used only to install the add-on (the hosts in the table above). After that earshot runs fully offline (`EARSHOT_OFFLINE`, `HF_HUB_OFFLINE` and `TRANSFORMERS_OFFLINE` are set): it never downloads, and a model missing from its cache is an error rather than a silent download. Remove and install again to repair it. earshot's optional cloud critique (an upload to Google Gemini) is not available through Blackout. Decoded audio, embeddings and results are cached in the add-on's `home/` folder, keyed by path, size, modification time and sampled blocks of each file; they stay on this Mac, are kept under 500 MB (see [Storage](#storage)) and Remove deletes them.

## Limits

The verdicts come from models (CLAP for text-audio similarity, AST for AudioSet labels, a small fitted realness model): they are evidence, not proof, and taste is not measured. Report the numbers and let the user decide on taste.

- **Trustworthy:** the measurements (loudness, true peak, LRA, timing to the millisecond, levels, spectrum, clipping, silence, tempo of steady music); "is this the kind of sound I asked for" on single, exposed sounds, where a strong match is very reliable; picking among candidates and finding the clean moment; obvious code-synthesized sources when the verdict is firm; offsets of hard hits to cuts and cues.
- **Hints only:** tags of events inside a busy mix (times and levels are right, the label is a guess); music genre and mood; "uncertain" realness on designed library sounds and real electronic music (read it as "sounds designed", not "fake"); the launch scorecard ranges, which describe one style of film; the "cuts without a hit" list (soft whooshes can be missed: look at the sheet); AudioSet labels on one-shots under about 0.5 s. Realness thresholds depend on length (clips up to 6 s against longer files), so compare verdicts, not raw `p_real`.
- **Cannot judge:** taste and emotion; a code-made layer hidden under a louder real mix (judge sources, not only the mix); provenance and licences (realness hears synthesis, not where a file came from); anything above 14 kHz from the models (CLAP stops there, AST at 8 kHz: use `measure` for air and codec cut-offs); the words spoken.
- **Goodhart:** sounds optimized against these models can out-score real recordings on them; that means the models are satisfied, not that the sound is better. `p_real` is easy to fool (modal resonators plus a room and a microphone noise floor read "real"), and typicality rewards being an average. Judge made sounds by measured closeness (tonal balance, bands, tails, lengths), and ask for a blind, loudness-matched listening test before calling one as good as a recording.
- **Engineering:** very short sounds are padded to a 10 s window (trim with `start` / `end`); attack and decay come from smoothed envelopes (an instant attack reads about 4 ms); picture cuts come from a frame-difference detector (hard cuts and whips are reliable, slow crossfades are missed, motion inside a shot is not an event, so pass `cues`); caches can miss a re-rendered file that kept its size, timestamp and sampled blocks (export to a new name). The models were evaluated on one sound library, seven launch films and three synthesis code bases.

## Errors

Fails with `busy` while the add-on installs (see above), or when a call ran out of time (with what to try instead), and with the install's one-line reason after a failed step (the next call retries). Fails at once on an Intel Mac, which the add-on does not support. Also fails when a path doesn't exist, is a folder where a file is expected, is a URL, or is a protected location; when a file has no decodable audio; when a library path is given or `render` is called without an open project, or the project is saved or moved while a take renders; for an unknown bank id, a knob a sound can't take (a pitch on a noise sound, a target outside its range, a `dur` or `apex` that isn't positive), or a `find` `kind` other than `auto`, `event` or `texture`; when the realness model is missing (say that real versus synthetic was not checked); and when the call is canceled.

## Provenance and licences

earshot is MIT-licensed (Copyright (c) 2026 Leon Lin), installed from its v0.4.0 commit `591fa3e028032e6dce56620a20e932e35667e8d8`. The CLAP model is Apache-2.0, the AudioSet tagger BSD-3-Clause, PyTorch BSD-3-Clause, uv MIT or Apache-2.0 and CPython under the PSF license; the add-on's FFmpeg build is GPL-3.0-or-later. None of them is bundled in the app: they are downloaded into the add-on folder on first use and removed with it. The adapted earshot skills are recorded in the [skill import manifest](../../skills/imports/provenance.json).
