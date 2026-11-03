# `audio_finish` — local dialogue and music finishing

`measure` reports integrated loudness (LUFS), true peak (dBTP), loudness range (LU), sample peak/RMS and quiet spans. A scene measurement renders the complete edited mix as lossless 48 kHz PCM, including trims, speed changes, volume automation and overlapping tracks. It ignores the export workarea.

```json
{ "sceneId": "index.tsx:interview", "action": "measure" }
```

```json
{ "path": "dialogue.wav", "action": "finish", "targetLufs": -16, "truePeakDb": -1, "levelDialogue": true, "denoise": true }
```

```json
{ "sceneId": "index.tsx:interview", "action": "finish", "musicIds": ["index.tsx:music"], "effectIds": ["index.tsx:whoosh", "index.tsx:pop"], "targetLufs": -16, "truePeakDb": -1, "levelDialogue": true, "denoise": false, "duckingDb": 12 }
```

Supply exactly one `path` or `sceneId`. `path` may be a local library path or an absolute local file path. `musicIds` and `effectIds` apply only to `finish` on a scene and identify audio clips directly inside that scene; a clip can be in one list, not both. List the scene first and identify background tracks and sound effects deliberately: unselected audio becomes the dialogue mix, which is leveled, denoised and normalized, and which decides when the music ducks.

## Scene workflow

**Audio finish** in the editor header opens the same workflow. **Measure scene** analyzes the current complete mix. Select any separate background/music clips, choose dialogue settings, and use **Create finished version**.

Scene finishing creates a new editable scene next to the original. Original video, captions, timeline timing and source media are preserved. The new scene mutes its copied dialogue sources and adds the processed dialogue WAV. Selected background clips remain separate, with their original source offsets, playback speeds, fades and volume tracks. A parent **Music ducking** group adds adjustable volume keyframes without replacing that automation. One Undo removes the scene; its derivative remains in the asset library for reuse.

Clips named in `effectIds` (whooshes, hits, clicks, meme sounds) stay in the new scene exactly as they were: their own timing, volume and fades, unmuted, outside the ducking group. They are left out of the dialogue render, so they are not leveled, denoised or normalized with speech, and their transients don't count as dialogue activity that would duck the music. `mixLoudness` still measures them as part of the finished mix, and `effectCount` reports how many were kept. Like music, effect clips must sit directly in the scene; move a nested one up first.

Ducking uses RMS audio activity in the isolated dialogue mix, not recognized words or speakers. The default activity threshold is −42 dBFS, with brief-gap merging, anticipation and a gentle release. Adjust `activityThresholdDb` or the resulting group keyframes for noisy recordings. `duckingDb` accepts 0–30 dB and defaults to 12 dB.

The target applies to the processed **dialogue**, not a promise that added music meets the same target. A scene measurement is of the lossless mix; to check the encoded file a viewer gets, export a temporary draft and read it with [`sound_analyze`](./sound.md) `action: "measure"`, since the AAC encode can raise the true peak. The complete finished mix is measured separately after saving; `mixLoudness` reports that result. If background music causes the combined true peak to exceed the ceiling, lower the music or scene gain. A canceled/failed final measurement reports that the new scene is already saved rather than silently creating it twice.

## Processing and measurement

The app bundles a pinned, locally built FFmpeg 8.1.3 (the `ffmpeg` and `ffprobe` programs, from one configuration). It performs two-pass `loudnorm` processing, optionally preceded by linked-channel dynamic leveling (`dynaudnorm`) and conservative spectral noise reduction (`afftdn`). The denoiser's window delay is compensated, with tail padding to preserve the final speech. The actual output is measured again; sample count, channel count and sample rate must match the source. If final resampling exposes additional true peaks, a conservative gain correction is measured again before accepting the derivative. These filters and their options are documented in the [official FFmpeg filter reference](https://ffmpeg.org/ffmpeg-filters.html).

- `targetLufs`: −36 to −9 LUFS; default −16. This default is an editorial choice, not a universal platform requirement.
- `truePeakDb`: −9 to −0.1 dBTP; default −1.
- `levelDialogue`: default false for tool calls; the dialog enables it initially. Apply it to isolated dialogue rather than a finished music mix.
- `denoise`: default false. Noise reduction can change ambience or consonants and cannot reconstruct clipped detail. Listen before export.
- `inputLoudness` and `outputLoudness` describe the actual analyzed source/dialogue; `mixLoudness` describes a finished scene's complete mix, music and effects included. Very short clips provide limited loudness-range evidence. Digital silence has null loudness/peak values.

`finish` on a source path saves a uniquely named float WAV asset and leaves timeline clips unchanged. `outputPath` identifies the derivative. Use it deliberately when replacing source audio; mute the original to avoid doubling it.

## Legacy sample-peak operations

`inspect` remains the default action for existing callers. `inspect` and `normalize` require `path` and report sample peak, unweighted RMS and samples reaching full scale. They do not measure LUFS or true peak. `normalize` applies a fixed gain capped at +24 dB and writes a separate float WAV; `targetPeakDb` defaults to −1 dBFS and accepts −24 to −0.1.

```json
{ "path": "dialogue.wav", "action": "normalize", "targetPeakDb": -1 }
```

## Bounds, source safety and packaging

- Local mono/stereo media only; no upload or separate service/API payment. Source files are limited to 512 MiB, processing to ten minutes and 256 MiB decoded PCM (legacy sample-peak operations retain their 128 MiB bound).
- Silent sources can be measured but cannot be loudness-normalized. Invalid samples, missing codecs, unavailable bundled tools, stale source files and save failures produce explicit errors.
- Scene finishing requires static copyable content and a normal-speed, untrimmed master scene timeline. Clip trims and speeds remain supported. Audio `syncTo` links need baked start times before creating an independent copy. Background tracks and sound effects must be directly inside the scene; nested tracks should be moved there first.
- Cancellation terminates the native process and removes private temporary files. Project/source checks precede composition insertion. A derivative already committed to the original project's library can remain after a later cancellation or save failure; original files are never overwritten.
- The bundled executables, unmodified corresponding source archive, exact build script/configuration, checksums and LGPL license travel together under `dist/audio-tools`. The audio add-on behind [`sound_analyze`](./sound.md) downloads its own, separate FFmpeg build on first use; `audio_finish` never uses it. Build with `node apps/desktop/scripts/build-audio-tools.mjs`. The shipped feature does not depend on Homebrew or a separately installed FFmpeg.
