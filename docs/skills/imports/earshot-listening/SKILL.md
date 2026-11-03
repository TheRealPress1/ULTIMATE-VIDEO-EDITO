---
name: earshot-listening
description: Listen with Cutroom's local audio models whenever you must judge, choose, trim, verify or compare sound you cannot hear. Pick a sound effect, music or ambience from candidates, find the cleanest moment in a recording, check whether a track has vocals or reads as a real recording, review an edit's soundtrack (what happens when, sync to picture, loudness), A/B a mix change, or give an edit code-made effects from earshot's bank timed to its cues. Use it before telling anyone how audio sounds.
license: MIT (adapted from earshot, Copyright (c) 2026 Leon Lin; see LICENSE)
metadata:
  version: "1.0.0"
  upstream: "https://github.com/Leonxlnx/earshot/tree/591fa3e028032e6dce56620a20e932e35667e8d8/skills/earshot"
---

# Listening with earshot

You cannot hear. Never say how audio sounds, or that a sound "fits", without a `sound_analyze` reading behind it, and quote the number when you report ("strong match, z +3.9; p_real 0.96; -14.2 LUFS"). `sound_analyze` runs earshot's CLAP and AudioSet models on this Mac's CPU, so audio never leaves it. It hears what sounds, music and sound effects sound like, not the words spoken: use `transcribe` or `listen` for speech. `sound_effects` renders earshot's bank of code-made effects into the project without any model. Fields, limits and install details are in the [sound tools reference](../../../reference/tools/sound.md).

## Setup: none

Both tools are Cutroom MCP tools; there is nothing to install or configure, and earshot is never run from a shell. The first call installs Cutroom's audio add-on by itself (Python, PyTorch for CPU, earshot, FFmpeg and about 1.1 GB of models). When it isn't ready within about 90 seconds the call fails with `busy`, naming the step and progress: carry on with other work (picture, captions, placing clips you already have) and call the tool again a few minutes later. `busy` also comes back when an analysis runs past its time limit (60 minutes for `timeline`, `sheet` and `critique`) and is stopped; that message names a smaller call to make (a shorter `start`/`end` window, `detail: "low"`, `fast: true` for `critique`, fewer files for `rank`), so make that one instead of repeating the same call, which would hold the other sound calls up for as long again. A failed install says why in one line and retries on the next call. Do not install packages, models or FFmpeg yourself. The add-on needs a Mac with Apple silicon: on an Intel Mac both tools fail at once, so tell the user the sound was not analyzed rather than guessing how it sounds.

The add-on keeps one earshot process warm. The first model call after it starts loads CLAP and AST (about 10 s on an M2 Pro, longer on a slower Mac); later calls take seconds, and a long file can take minutes. Calls run one at a time, so batch: rank a folder in one call rather than describing ten files. Canceling a call (or its timeout) returns at once, but earshot cannot interrupt an analysis it has started, so Cutroom ends its process and the next call loads the models again; window a long file with `start` / `end` rather than canceling it. Embeddings and results are cached, so re-ranking the same files with a new query is fast. The cache also keeps a decoded copy of every analyzed file and draft (about 23 MB per stereo minute); Cutroom holds the caches under 500 MB by dropping the least recently used, so analyze the files you are considering, not everything in reach, or the ones you still need get decoded again.

Paths are library paths (`sfx/whoosh.wav`, `music/bed.m4a`), project-relative or absolute local files; never URLs (download first with `web_media_download` or `media_download`). Any file FFmpeg reads works, including the audio of an MP4 or MOV (a video with no audio track says so). `start`, `end` and every trim are source seconds of that file. A result is earshot's plain summary followed by its JSON, compacted (`full: true` returns all of it); times are seconds.

To hear the edit itself rather than one source file, `export` the scene to a temporary path such as `/tmp/<project>-sound-v1.mp4` and analyze that file. Its time 0 is the workarea's first frame, as for `capture`: subtract the workarea start from scene times. These drafts are checks, not deliveries, so they need no request from the user ([review drafts](../../../reference/tools/export.md#review-drafts)); only the delivery file waits for one. Export drafts only to a temporary folder, never into `exports/` or over a delivered file.

## Loop 1: choose an asset

1. `sound_analyze` with `action: "rank"`, `paths` (the candidates' files, or a folder), `query: "a soft felt mallet hit on a wooden block"` and `top: 5` shortlists the candidates.
2. `action: "find"` on the winner with `query: "a single clean mallet hit"` and `top: 3` returns the best moments as trims (`start` / `end` in source seconds). Each segment has a kind: `stroke` (one onset until it decays) and `event` (strokes that belong together, such as a key's down and up) start 5 ms before the attack and end after the decay; `window` is a stretch whose edges were snapped onto the sound for one-shot queries (a plain stretch, to be crossfaded, for beds). `head` / `tail` are how loud the first 5 ms and last 10 ms are against the trim's peak (-30 dB or lower is clean); a trim marked "head cut" or "tail cut" starts or ends inside a sound, so do not use it as it is. `kind: "event"` returns onset-based trims only (hits, clicks, steps), `kind: "texture"` plain windows only (beds); the default reads the query.
3. `action: "describe"` with the trim's `start` and `end` says what it actually sounds like: check that the top tags fit the need and that the shape (attack, decay) fits the picture. AudioSet labels are weak on one-shots under about 0.5 s: "tagger unsure" or a near class (Zipper for a swish, Finger snapping for a click) is neutral; only an outright different class (Speech, Music, Engine, Vehicle) is a red flag.
4. `action: "realness"` on the same trim (or on a folder, one row per file) judges the part you will use: a multi-take file's `p_real` is a mean over every take and the silence between them. When the user wants real or professionally produced sound, do not use a "likely code-synthesized" trim, and read the evidence of an "uncertain" one before using it (say why you kept it). When synthesized sound is the point (UI tones, earshot bank renders), realness is information, not a gate. The thresholds depend on length and each summary names them: up to 6 s the clip thresholds (lo 0.17 / hi 0.77), longer files the mean of their 4 s windows with weakly calibrated file thresholds (lo 0.40 / hi 0.77), so compare verdicts, not raw `p_real`, across files of different lengths. Real recordings and professionally produced music and sound design usually read real, but realness hears how a sound sounds, not where it came from: clean professionally synthesized tones (UI sounds, chimes, synth stabs) also read as code-synthesized. If realness is unavailable, say plainly that real versus synthetic was not checked; describe's AudioSet classes (Sine wave, Beep, Synthesizer) are weaker evidence. Exact digital zeros alone prove nothing: edit and fade padding is common in real recordings.
5. To choose between two candidates, `action: "ab"` with `a`, `b` and `query: "a crisp fast air whoosh"`, plus `a_start` / `a_end` / `b_start` / `b_end` for trims from find (A and B may be the same multi-take file). To test one claim, `action: "match"` with `query: "a deep thocky key press"` and `alts: ["a clicky blue switch", "a typewriter key"]`; to check a sound fits the palette, `action: "compare"` with `refs` (approved files or a folder) and the trim's `start` / `end`.

Place the chosen trim as an `<audio>` clip with the trim as its source range. A `stroke` or `event` trim starts 5 ms before its attack, so at `playbackRate` 1 the attack lands on a cue at `start = cueTime - 0.005`:

```tsx
<audio id="sfx-mallet" src="sfx/felt-mallet-3f2a9c1d.wav" start={4.995} sourceIn={1.12} sourceOut={1.48} volume={-14} />
```

Is a track an instrumental? Run `action: "match"` on a chorus window (`start` / `end`) with `query: "an instrumental without vocals"` and `alts: ["a song with singing", "a rap verse"]`, or `describe` it and read the Singing, Speech and vocal-music labels. Check two or three windows (intro, chorus, bridge) and pair it with `listen` on the same window, where recognized words mean vocals. A strong instrumental reading with no singing tags is evidence, not proof: say which windows you checked.

## Loop 2: review an edit's sound

1. Export the scene to a temporary file, then `action: "timeline"` with that `path` and `cues` (the seconds of the picture events you gave sounds to, read from the composition, in export time; or the path of a cues JSON file) is the listening transcript: events with time, level and tags, sections, the loudness curve, picture cuts, and sync per cut and cue. `detail: "low"` is fast; `"high"` tags up to 96 events (most important first; the summary says how many were tagged, so an untagged event is not a missing sound). Read the sync stats: `offset_ms` is sound minus picture (negative = early), and the chance fraction says what random edit points would score; only better-than-chance sync means anything. A cut listed with no hit can still carry a soft whoosh: check it on the sheet before adding a sound.
2. `action: "sheet"` on the same file (and `cues`; `start` / `end` zoom, `detail: "low"` is faster) returns an annotated picture inline: frames, sections, labelled events, spectrogram, loudness, beats, and cue markers coloured by sync (green = within a frame, amber = within 100 ms, red = no sound). Look at it: gaps, pile-ups, masking and late hits are obvious at a glance.
3. `action: "critique"` (`fast: true` skips the AudioSet and realness passes) scores the soundtrack against the measured range of seven professional launch films: each metric ok / low / high with its weight and timed actions, and a verdict (launch-grade / close / needs work / not launch-grade). Fix critical rows first, export again and re-run 1-3. Its "onset on visual events" share counts new attacks within ±100 ms only (the references' definition); its fixes name the cuts with no sound at all, by the same matcher as timeline. The ranges describe one style (modern product launch films); a quiet documentary or a piano piece breaks rules that don't apply to it.
4. Exact meters at any time: `audio_finish` with `action: "measure"` and the `sceneId` measures the edited mix itself without an export (integrated LUFS, true peak, loudness range, quiet spans); `sound_analyze` `action: "measure"` reads one file or window (LUFS, true peak dBTP, LRA, noise floor, attack and decay, brightness, bands; `music: true` adds tempo, beats and key).

Fix in the composition: `start` for sync, `sourceIn` / `sourceOut` for trims, `volume` (decibels) for level, `gain` animations for edges, a `volume` keyframe track for rides, and `audio_finish` `action: "finish"` with `musicIds` and `effectIds` for dialogue leveling and music ducking ([audio finishing](../../uve-audio-finishing/SKILL.md)); an effect left out of `effectIds` is mixed into the dialogue derivative, leveled and ducking the music. `capture` checks the picture at a cue, never the sound.

## Loop 3: A/B a change

Export before and after to two temporary files, then `action: "ab"` with `a` (before), `b` (after) and a `query` or `refs`: it says which is closer and how B differs from A in measured words (louder, brighter, longer decay). For sounds inside longer files pass the trims (`a_start: 1.217, a_end: 1.615, b_start: 7.881, b_end: 8.285`): a whole-file A/B of multi-take files compares every take plus the silence between them. Then run `timeline` on the new file and compare its event lines and sync stats with the old run. Change one thing at a time.

## Loop 4: effects from the bank (`sound_effects`)

Use this when an edit with designed motion (titles, a UI demo, a product animation, a code-made film) needs effects and the brief does not ask for recorded sound: render them from earshot's bank instead of searching. No models load; a render takes about a second.

1. `sound_effects` with `action: "list"` and a `kind` (`whoosh`, `hit`, `key`, `bell`, `pop`, `click`, ...) or a `category` (`whoosh_fast`, `ui_pop`, `pro_impact`, ...) shows the candidates with their lengths, peak times, cue kinds and knobs (`dur`; `apex` for the whoosh family; `pitch` for tonal sounds, with the native note).
2. `action: "render"` with the `id` and the knobs the cue needs: `dur` (exact length in seconds), `apex` (seconds from the start to the loudest moment, whoosh family), `pitch` (`"E5"`, `"Eb6"` or `"440"`, through the recipe's own pitch parameter, never resampled; noise sounds refuse it), `seed` (a new take of the same sound; the default is the delivered final) and an optional `name` for the file. The file lands in `assets/sfx/` and is imported; the same id, knobs and seed reuse the earlier file, under the name it got first. The result carries `src`, `durationSeconds`, `onsetSeconds`, `peakSeconds`, `endSeconds` and the `audit`.
3. Place each take on its cue frame at `sourceIn` 0 and `playbackRate` 1:
   - hits, taps, knocks, clicks, keys, pops and bells: the onset on the frame, `start = cueTime - onsetSeconds`;
   - whooshes and swishes on a move's velocity peak, and swells or 0.4 risers (which peak and then fall) on their hit: the peak on the frame, `start = cueTime - peakSeconds`; render a move's whoosh with both knobs, such as `dur: 0.8, apex: 0.32`;
   - risers that stop on their loudest moment: the end on the hit (or 30-250 ms before it), `start = cueTime - endSeconds`.
   Typing takes 12 or more seeds of one key, rotated, with the space and return members for those keys; other repeated actions take 2-4 seeds.
4. Read the `audit`. Every warning names a reason (clicks, a cut tail, comb ring, silence, a pitch that climbs more than 4 semitones, a hit with two attacks or a build before it, `pitch_off`: a note the knob did not land); swap the sound or the knob rather than keep a warned take. Notes are information (a sounded riser, a composite sting). `action: "check"` runs the same audit on any file, such as a downloaded effect.
5. Listen through the edit with Loop 2 (`timeline` with `cues`, `sheet`) and check that each cue landed.

The 0.4 families, for the soft, short, mid-register sound of music-led launch films: `ui_pop` (rounded mid pops for chips, bubbles and rows arriving: the most used effect in those films), `knock` (mid-band wood and plastic), `cut_hit` (short sub hits with a kick, a punchy cut hit), `mallet` (gated glockenspiel, celesta and marimba notes, a soft pluck, chime runs; `pitch` tunes them), `drip` (water drops whose pitch rises: the audit allows a bubble its climb), `shutter` (snap zooms, whip-cuts), `reverse_swell` (peaks just after a cut, one per film), plus the whoosh_big thumps, riser dark / build / snatch, swish bright / flick, whoosh_fast whip, glitch burst / mid / chirp and notify mid_tine / mid_wood. Prefer them over the bright 5 ms blips and long cinematic tails of the older categories when the edit is cut to music.

Levels against the music, not fixed. In edits cut to music, effects ride 3-10 dB over the music and read by timing and spectrum: a fixed level is either buried in loud passages or sticks out in quiet ones. For each cue, measure both sides with the same meter: `sound_analyze` `action: "measure"` with `light: true`, reading `rms_dbfs` on both. Measure the take's file over the 50 ms around its loudest moment (from `max(0, peakSeconds - 0.025)` to 0.05 s later), and the music file over the source second before the cue (from `sourceIn + (cueTime - 1 - start) × playbackRate` to `sourceIn + (cueTime - start) × playbackRate`, with the music clip's `sourceIn`, `start` and `playbackRate`). Never set one side's `rms_dbfs` against the other's `lufs`: files and windows under 0.4 s (most pops, clicks, keys and knocks) get no `lufs`, a whole-file RMS includes the tail, and the two meters differ by several dB. Set the take's `volume` so its `rms_dbfs` plus `volume` sits 3-10 dB over the bed's `rms_dbfs` plus the music clip's `volume`. This meter is unweighted, while loudness (LUFS) weights the highs up and the deep lows down, so against a bass-heavy bed keep bright effects (clicks, ticks, pops) near the low end of the range. Bank renders peak at -1 dBFS, so keep their `volume` at or below 0. Pull the music down 6-12 dB for 0.3-0.5 s before a hit, a drop, a big whoosh or a swell and bring it back on the hit, with a `volume` keyframe track on the music clip (keyframe times are source seconds); do not duck the music under every effect. Without a music bed, or where the music is silent before a cue, use the fixed starting levels of the [sound effects](../../uve-sfx/SKILL.md) workflow. When finishing with `audio_finish`, list every effect clip in `effectIds` so it keeps the level you set. Report the levels you set and the bed levels you measured.

Say plainly what the bank is: sounds made in code by earshot's forge (the 0.4 members tuned toward the measured style of a private set of licensed reference clips and checked to stay originals: CLAP similarity 0.84 at most against any of them), and 15 sounds fitted as code from CC0 recordings (`fit/<role>/<name>`), all chosen and checked by measurement, none by a listening test. They are original, MIT-licensed renders, credited in the project. They are not recordings: when the brief asks for recorded sound, use [real sound](../earshot-real-sound/SKILL.md) instead.

Not part of Cutroom: earshot forge (writing synthesis recipes and searching them by listening), its fitting tools, and its optional cloud critique. Offer the user a listening check instead.

## Goodhart, say it plainly

- The models can be satisfied without the sound being better. Code-made sounds can out-score real recordings on them; that means the critic is satisfied, not that the sound is better.
- `p_real` is easy to fool: modal resonators plus a room and a microphone noise floor read "real". Typicality rewards being an average of the references.
- Judge by measured closeness: tonal balance, bands outside every reference, tails, lengths (`measure`, `compare`, the `sheet` spectrogram). Before calling a sound "as good as real", ask the user for a blind listening test (random order, loudness-matched, hidden key).

## Reading the numbers

| number | what it is | trust |
|---|---|---|
| LUFS, dBTP, LRA, dBFS, ms, Hz | measurements (BS.1770 meter, spectrum, envelope) | exact; use them for levels |
| z (match / rank / find / describe tags) | how far a description stands out among the few hundred vocabulary descriptions scored on the same sound | verdicts: z >= 3 strong, 2.5-3 plausible, 2-2.5 weak, < 2 no match |
| p_vs_alts | uncalibrated, sharp forced choice between your query and your alternatives | only says which wording fits best; judge by z |
| cosine | raw CLAP similarity | never a probability; compare only for the same sound and query |
| AudioSet labels (0..1) | independent per-class probabilities from the AST tagger | good for broad classes; hears only up to 8 kHz |
| p_real / verdict | real or professionally produced versus code-synthesized, from a small fitted model | strong evidence, not proof; read its evidence list; thresholds differ for clips (<= 6 s) and long files |
| digital_silence_frac | share of exact-zero samples | weak alone: edit and fade padding is common in real recordings |
| typicality z (compare) | distance to the reference set against the references' own spread | >= -1 fits the set, < -2 outlier |
| sync offset_ms, chance | sound minus picture per cut or cue; what random edits would score | trust when well above chance |
| critique status | value against the range of 7 professional launch films (true peak <= -1 dBTP for a master, <= 0 dBTP for decoded AAC or MP3, which already holds the codec overshoot) | a range, not a target: ok = inside what professionals do |

Prefer measurements, then verdicts, z and probabilities; never present cosine as confidence.

## Writing queries

Describe the sound, not its use: source, material, action and character ("a heavy wooden door slamming in a small room", not "a sound for the logo"). Give alternatives that are realistic confusions (thock versus click versus typewriter). When a z is borderline, try two or three phrasings and trust a reading that holds up under all of them.

## Limits (say these plainly when they matter)

- Taste is not measured: earshot says what a sound is and how it measures, not whether it is beautiful or right for the story. The user decides on taste; give them the evidence and the shortlist.
- No speech recognition (it can tell there is speech, not what is said) and no lyric or language judgement.
- CLAP hears 50 Hz-14 kHz and AST up to 8 kHz: check air and low-pass problems with `measure` (bandwidth, bands).
- Very short sounds are padded to a 10 s window; isolated hits read best with `find` or `describe` on a trimmed segment.
- Attack and decay times come from smoothed envelopes (5 ms / 10 ms RMS): an instant attack reads about 4 ms, and very short clicks cannot read below about 10-20 ms of decay.
- Picture cuts come from a frame-difference detector: hard cuts and whips are reliable, slow crossfades are missed or found late, and motion inside a shot is not an event, so pass cue times for animation.
- Mixed, dense material blurs tags: describe a source or a segment rather than the whole mix. A code-made layer hidden under a louder real mix is usually missed.
- Licence, provenance and attribution are not audio questions: earshot cannot check them.

## Provenance

Adapted for Cutroom from `skills/earshot/SKILL.md` in [earshot](https://github.com/Leonxlnx/earshot) v0.4.0 (commit `591fa3e028032e6dce56620a20e932e35667e8d8`). Copyright (c) 2026 Leon Lin, released under the MIT License; the full notice is in [LICENSE](LICENSE) and the import is recorded in [the import manifest](../provenance.json). Command-line and MCP setup, forge, fitting and the cloud critique were removed; film kits and their bed leveling became bank renders leveled with `measure` readings and clip `volume`; commands were rewritten to Cutroom's `sound_analyze`, `sound_effects`, `export`, `audio_finish` and composition clips.
