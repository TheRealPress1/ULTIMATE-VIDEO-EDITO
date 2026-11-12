# Sound design rules: launch videos and designed films

The rules the placement, critique and fix steps work from. Numbers marked *(norm)* are measured norms of top-tier launch films (from the Cinetic skill's measurements, as reported upstream); the rest is practice that held up on shipped films. earshot's `critique` scores a soundtrack against its bundled profile of 7 professional launch films; this file stands alone for the craft. Adapted from earshot's `skills/real-sound/references/sound-design.md` (MIT, Copyright (c) 2026 Leon Lin; see [LICENSE](../LICENSE)).

## 1. The bar

- **Every sound has a visible cause**, at a loudness that matches the cause: a caret blink whispers, the hero reveal hits. Not every picture event gets a sound; once a class of action is sounded, every instance is, at one level.
- **Real and close.** Professional recordings: close-miked, dry, clean (floor under -55 dBFS between events), full bandwidth (95 % rolloff above 12 kHz), no clipping, no room of their own, no background events.
- **One palette.** One material family per film (felt and wood, glass and soft plastic, metal and air), one click voice, one keyboard, one music track. A different material for every sound is the fastest way to sound cheap.
- **The music carries the film.** Effects punctuate; the music's own events (drop, stop, re-entry) carry the big moments and most cuts.
- **Restraint.** About 5 designed effects per 10 s *(norm; 0-28)*, clustered where the music is sparse (cold open, typing, logo build) and thinning out after the drop. Good sound design mostly disappears.

## 2. Launch-video grammar (picture event to sound)

| picture | sound (real source) | where it sits | level and notes |
|---|---|---|---|
| cursor moves, hovers, scrolls, progress bars, streaming text, rolling counters | nothing | | the music carries continuous motion |
| cursor click / tap / press | one real click voice for the whole film: mouse, trackpad, phone tap on glass; press and release 60-110 ms later (about 85, release 0-3 dB quieter) *(norm)* | the press frame (clicks land 10-30 ms before the visible press in pro films) | about 3 dB under the music's short-term level, 12-20 dB over it above 3 kHz *(norm)*; bright but short (-20 dB within 6-10 ms); the same level every time |
| typing | a real keyboard sliced into takes (mechanical or laptop, one board per film); space and return deeper and longer | each sounded key on its character frame; at most about 12 keys/s; above about 25 characters/s one key per word or silence *(norm)* | music dips 6-10 dB under the run; vary the take and its level (sigma about 2 dB, no jump over 6 dB), not random pitch; most on-screen typing in pro films is silent *(norm: about 75 %)* |
| a card / chip / toast / badge appears | a soft real pop or tick: cork, mouth pop, plastic click, wood block, pitched up for size | 50 % of its travel | a run climbs (+1 to +3 semitones across it); +2 to +9 dB over the music for word-like pops *(norm)* |
| toggle, switch, lock-in, snap into place | a real latch, switch, magnet clack, plastic brick click | the contact frame | short; in sync within a frame |
| a counter or metric locks on its value | one crisp tick on the final value only | the lock frame | about 8 dB under the music *(norm)* |
| a camera-scale move, whip, zoom into the product, logo zoom | a real swish (bamboo, stick, cloth, cape, air past the mic) | peak on the move's velocity peak, onset 100-450 ms ahead *(norm)* | about 2 per film, never on every cut |
| hard cuts | nothing | | about 85 % of cuts in pro films have no sound of their own *(norm)* |
| tension into the reveal | a real riser: cymbal roll (yarn mallets), orchestral swell, the music's own build | ends 30-250 ms before the hit (a beat of air), or stops on it | in about 40 % of films *(norm)*; never a crash cymbal on the hit |
| the hero reveal / the turn | the music's DROP lands on it (edit the track so its downbeat is on the frame); optionally one real impact: drum, taiko, kick, felt sub hit, with a short top transient | the contact or cut frame | the loudest moment of the film, at 30-60 % of the runtime, +2 to +7 LU over integrated *(norm)* |
| the logo / lockup | the music stops on a bar line or fades down, 0.2-0.7 s of near-silence, then ONE soft resolved element: a bell, celesta or piano note in the track's key, a soft swell | the frame the wordmark becomes readable (its settle), never later | 8-20 dB under the film's peak *(norm)*; a 0.5-2.5 s tail to below -60 dBFS, then silence |
| product objects (a phone, a card, a box) | real foley of the object's material | contacts | dry |

## 3. Music

- **One licensed track** at 110-130 BPM (or half-time 55-65) whose structure fits the film: soft intro, groove, a breakdown or stop at 40-80 % of the runtime, a drop for the hero reveal, a resolve. Steady tempo, 4/4, professionally mastered, full bandwidth, instrumental.
- **Avoid:** vocals, corporate ukulele and whistling, EDM brostep, lo-fi hiss, trailer braams on a product film, dark or tense moods for a friendly product, famous overused stock tracks.
- **Match the brand's personality:** calm or literary: soft piano, felt, strings, no booms; fast or exact: tight drums, plucks, a drop on true silence; bright or friendly: marimba, claps, pops, major key; precise or expensive: sparse piano, low strings, air; raw or mechanical: ticks, latches, metallic hits; warm or kind: plucked strings, soft pads.
- **Edit at bar lines:** the picture is cut on the grid (120 BPM = 2 s bars at 4/4), the music is cut on its downbeats (`sourceIn` / `sourceOut` of consecutive clips), splices continue the harmony (V to I, or the same chord), and the drop's downbeat lands on the hero frame. Blackout's `playbackRate` resamples, so retiming music also changes its pitch: keep music at rate 1 and fit the picture to the grid.
- **Shape with rides, not with new music:** dip under typing, lift into the drop, settle under the logo, with a `volume` keyframe track on the music clip or `audio_finish` ducking under dialogue.

## 4. Levels, arc and mix

- -14 LUFS integrated for web and social; true peak at most -1 dBTP after the AAC encode. -15 or -16 only for a stated reason (a dynamic orchestral track that would otherwise need heavy limiting).
- LRA 5-9 LU for a film with an arc *(norm: 1-2 sound crushed)*; the intro 5-12 LU under the body for its first 2-3 s, entering with intent on frame 0 (no fade over the first bar, no click on sample 0).
- The loudest momentary moment sits on the drop or hero reveal, not on the logo, not in the last 15 %.
- Effects are dry. Blackout has no per-clip pan, so keep effects as recorded: mono or narrow recordings for UI and foley, wider ones only for whooshes, risers, ambiences and the music.
- Every effect at least 3 dB over the bed in its own best band (6 is clear); a layer that adds nothing measurable is a wasted placement. Check on the `sheet` and with `ab` of the moment with and without the layer.
- Nothing in the 2-6 kHz band much louder than the music's own loudest presence peaks: that band hurts first on phones and laptops. Effect brightness (centroid) at or below 6.5 kHz *(norm)*; pings at 9-14 kHz fatigue. Without an EQ, choose a darker take or lower the `volume`.

## 5. Sync

- Impacts, clicks, keys, pops: the attack on the contact, press or 50 % frame. Whooshes: the peak on the velocity peak. Risers: the end on (or 30-250 ms before) the hit. Beds and crowds: their start.
- A sound that leads its picture by more than about 45 ms reads as "sound first"; one that peaks more than about 75 ms late reads as late *(norm: accents land -45 to +75 ms, median +8)*. Move the picture to the beat, not the sound off its cause.
- Check slow-attack recordings: a sound aligned on its first transient whose peak comes 80 ms later lands late. Read the peak on the trim's `waveform` and align on it when it carries the event.
- Cue times are read from the composition; times typed in from a viewing land 8-11 frames off *(in practice)*.

## 6. Variation without randomness

- A repeated action draws from 4 or more takes, never the same take twice in a row, with ±1-2 dB of `volume` jitter and at most ±0.3-0.5 semitones of pitch (`playbackRate` 0.97-1.03); real keyboards do not change pitch per key: vary the take, not the pitch.
- The UI click is the exception: one voice, one level, every time.
- A progression climbs: a pitch ramp across a run of pops or stacking blocks, a gain ramp into a build.
- Machine-gun (one take, no variation, a regular rhythm) is the second-fastest cheap tell.

## 7. Tuning

- Tuned elements (chimes, bells, celesta, a motif) play in the track's key (`sound_analyze` `measure` with `music: true` estimates it); tune a recording by resampling (`playbackRate = 2^(semitones / 12)`) within ±2 semitones, and choose a recording near the right note rather than shifting far. Resampling also changes the length: recompute `start` from the attack.
- Booms and subs on the track's root, or at least neutral (unpitched); an untuned boom under a resolving chord sounds cheap even to people who cannot say why.

## 8. Film foley (character pieces, miniatures, worlds)

- **Scale through pitch and closeness:** a 1 cm character's steps are fingertip taps pitched +2 to +6 semitones, close and dry; a giant's are slowed (-3 to -6 semitones) heavy foley with a longer tail.
- **Layer by role:** body (the weight, 100-400 Hz), transient (the crisp contact, 2-6 kHz, short) and detail (material: rattle, creak, rustle). Each layer is its own clip on the same cue, 5-20 ms apart; check that each adds something.
- **Ambience zones:** one bed per location, from clean windows of real field recordings (`find` with `kind: "texture"`; no voices, traffic, planes or dogs unless the story wants them), cut with the picture's cuts and dipped under key actions.
- **Materials stay consistent:** the same key always sounds like the same key; the same surface like the same surface.

## 9. Choosing a recording (agents cannot listen: measure)

- `sound_analyze` `measure` (floor, bandwidth, clipping, onsets; tempo and key for music) and the file's `sheet` for its spectrogram; `describe` and `match` (does it sound like the description? use the verdict words: strong z >= 3, plausible 2.5-3, weak 2-2.5, no match below 2); `rank` (sort candidates); `find` (the best take inside a long recording: ready-made trims); `compare` with `refs` or `ab` (closer to approved references?); `realness` (a real recording, not code-synthesized: require "real or pro-produced" on the trim you use; an "uncertain" needs its evidence read and written down).
- Prefer lossless files or HQ previews, 44.1/48 kHz or higher, many takes of the same object (variation for free), a clean floor between takes.
- Reject clipped files, low bitrates (a cliff above 16 kHz), roomy foley, anything with voices or bumps inside the window you need, anything whose licence you cannot read on its own page.

## 10. The cheap tells (what makes a soundtrack sound like random stock effects)

Code-synthesized beeps, sine pings and noise sweeps; one take machine-gunned; a whoosh on every cut; a boom on every logo; sparkle or shimmer sweeps standing in for "magic"; reverb on tiny sounds; random pitch on typing; partial coverage (some presses heard, others silent); clicks at cuts; music chopped mid-note at a splice; an audible ambience loop; a different room on every sound; the logo louder than the drop; an ending that stops mid-note instead of a tail into silence.
