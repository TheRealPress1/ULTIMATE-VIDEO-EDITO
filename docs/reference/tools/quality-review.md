# Rendered quality review

Select a scene and choose **Edit tools → Review**, or call `quality_review` with its `id` and optional `audio: false` (or an `audio` object with pause thresholds, below). Review never changes the composition. It compiles a fresh isolated render and rejects results if project source, captions, settings or local media change during the pass.

The report returns its source fingerprint, scene ID, review time, sample count, audio coverage, limitations and findings. Each finding has scene-relative seconds, an optional ending time and source node, and evidence labeled `pixels`, `layout` or `audio`. Click a finding in the app to seek to that moment. If the edit changed, run review again before navigating by its findings.

The visual pass samples up to 120 frames per two-minute section of the export workarea, including both sides of clip boundaries. It reports nearly black samples, dark borders, text or caption layout outside its box/picture, and captions near conservative platform margins. These are observations to review: dark scenes, letterboxing, fades and deliberately cropped text may be intentional. Sampling cannot rule out a brief problem between frames.

Optional audio review renders the workarea mix in bounded overlapping windows of lossless 48 kHz PCM and checks sample clipping, spans below −60 dBFS RMS lasting at least a second, and discontinuities at clip boundaries. Use `audio_finish` for integrated loudness and true-peak measurements. Neither workflow claims automatic lip-sync detection, speaker identity or editorial judgment.

Agents can tighten the pause check to list residual gaps after a tight cut. `audio` takes an object instead of `true`:

```json
{ "id": "index.tsx:reel", "audio": { "pauseThresholdDb": -45, "minPauseSeconds": 0.25 } }
```

`pauseThresholdDb` (−70 to −20, default −60) is the RMS level per 50 ms block below which audio counts as quiet, and `minPauseSeconds` (0.1 to 5, default 1) the shortest quiet span reported as `audio-silence`. Set the threshold between the room tone and the speech; a level close to the speech flags quiet syllables. Sections saved with other thresholds are not reused for this pass, while the defaults keep reusing earlier sections.

Every quiet span is its own `audio-silence` finding with its own start, end and measured length, however close the next one is; only the two pieces of a span that crosses a section boundary are joined. Other findings that repeat within the sampling interval (two seconds or more) are grouped into one span.

The level is read from the unfiltered mix. `transcript_edit_inspect` reports `pauseDetection.noiseFloorDb` from 10 ms windows after an 80 Hz high-pass, so with low rumble in the room (air conditioning, traffic, a fridge) the same pause reads louder here than that floor suggests. Start about 8 dB above `noiseFloorDb`; if pauses the inspection found don't come back, raise the threshold 5 dB at a time while it stays well under `speechDb`.

Visual and audio review support scenes up to two hours and 2,000 drawable layers. Completed two-minute sections persist locally and resume for unchanged composition, media and settings; canceling does not discard completed sections. Each audio window is at most 122 seconds. Audio finishing has its own shorter limits. Original media must be available locally and match the asset library. The report is held in the review dialog or returned to the agent; it does not create a new project version or export a video.
