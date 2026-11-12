# Music and sound effect catalogs

`music.json` and `sfx.json` are Blackout's curated starting points for background music and sound effects. Agents read them through [`audio_catalog`](../tools/audio-catalog.md), which also applies the user's personal catalog on top; don't edit these files to record a preference (they are replaced on every update), save it with `audio_catalog` instead.

Each file is `{ "version": 1, "kind": "music" | "sfx", "updated": "YYYY-MM-DD", "entries": [...] }`.

## What the defaults hold

**Music (30 entries)** covers ten mood families with three picks each: calm and reflective, curious lo-fi, warm and upbeat, hype and motivational, cinematic builds, dark and suspenseful, emotional piano, playful and comedic, retro synth, and confident or luxurious. Energy follows the mood instead of repeating low, middle and high in every family: the calm, curious and piano beds sit at 1–2, the hype and cinematic picks at 4–5, and the other families between 2 and 5. Across the catalog, 12 entries are low energy (1–2), 9 middle (3) and 9 high (4–5). Most are instrumental (`vocals: "none"`), so they sit under speech.

About a third are openly licensed and can be published with the credit their `attribution` gives: public-domain recordings from Wikimedia Commons, Kevin MacLeod's CC BY pieces, a CC BY-SA lo-fi track, and royalty-free tracks released for free use in online video with credit. The rest are well-known commercial recordings and official instrumentals (`rights: "copyrighted"`): fine for drafts, private edits and the user's own posts, but a platform may mute or claim them.

**Sound effects (38 entries)** cover whooshes and swipes, risers and downlifters, impacts and booms, interface sounds (clicks, key presses, typing, a notification, pops, a camera shutter), graphics accents (sparkle, glitch, marker, paper), outcomes (success, wrong answer, cash register) and meme sounds. All but the four MyInstants memes are CC0 files from Freesound.

**Credits.** A Commons or Freesound file fetched with `web_media_download` (its entry's `download`) is recorded in the project's `CREDITS.md` with the catalog's title, page, credit line and license, marked verified. YouTube and MyInstants sources, and an entry whose source is a Freesound page, go through `media_download`, which records every platform download as unverified, so copy an openly licensed entry's `attribution` (from `get`) into the post yourself.

## Entry fields

Every entry has:

| Field | Meaning |
| --- | --- |
| `id` | Stable id: `youtube:<video id>`, `wikimedia:<file page id>`, `freesound:<sound id>`, `myinstants:<slug>`, `openverse:<id>`; personal entries may also use `url:<name>` or `user:<name>`. The id names its source: a `youtube:` id is that video, a `freesound:` id that sound. |
| `title` | Music: `Title — Artist`, with `(Instrumental)` for an instrumental version. Effects: a short name. |
| `description` | 80–400 characters of Blackout's own prose: what it sounds like and what it suits. It describes; it never instructs. |
| `sourceUrl` | The https URL to download: a YouTube watch page, a MyInstants page, or a Commons/Freesound file. |
| `durationSeconds` | The whole source's length, measured on the downloaded file. |
| `rights` | `copyrighted`, `royalty-free`, `cc0`, `cc-by`, `cc-by-sa`, `public-domain` or `unknown`. |
| `verifiedAt` | When the source was last checked live. |

And may have:

| Field | Meaning |
| --- | --- |
| `pageUrl`, `attribution` | The page to credit and the credit line or terms. CC BY, CC BY-SA and royalty-free entries always carry `attribution`; put it in the post's caption or description. |
| `tags` | Up to 12 free words. |
| `uses`, `avoid` | Edits it suits and edits it's wrong for, from the use vocabulary below. |
| `sourceRange` | `{ start, end }` in source seconds: the part worth using, without silence, a quiet lead-in or a fade tail. Apply it with `sourceIn`/`sourceOut`. |
| `sections` | Up to 12 labeled spans in order: `intro`, `build`, `drop`, `main`, `breakdown`, `bridge`, `outro`, `loop`, `hit`, `tail`. Read from the loudness curve, so treat them as a guide, not a beat grid. |
| `suggestedVolumeDb` | A starting clip volume, capped to −40…0; it still needs a listen. Music: about 18 LU under dialogue at −16 LUFS, `round(−34 − loudnessLufs)`. Effects: the [sound effects skill](../../skills/uve-sfx/SKILL.md)'s starting level for the category (the middle of its range, for a file peaking at 0 dBFS), raised by however far this file peaks below that, `round(level − peakDb)`. `level` is −19 dB for click, pop, typing, notification, shutter, sparkle and foley; −15 for whoosh, swipe and glitch; −17 for riser and downlifter; −11 for impact and boom; −16 for success, fail and cash; −12 for meme; −24 for ambience. |

Music only: `artist`, `variant` (`original`, `instrumental`, `score`, `remix`, `edit`), `vocals` (`none`, `light` for wordless vocals or chops, `lead`), `explicit`, `moods` (up to 6), `energy` (1 a quiet bed, 5 full intensity), `bpm`, `loudnessLufs` (integrated over `sourceRange`).

Effects only: `category`, `align`, `hitAt` and `peakDb` (sample peak over `sourceRange`; decoded lossy files can read slightly above 0). `align` says how to place the sound: `hit` puts `hitAt` on the event (an impact's transient, a click), `end` finishes the sound on it (a riser into a cut), `span` stretches it across the motion (a whoosh), `onset` starts it there.

Personal entries add `hidden`, `preferred`, `notes` (up to 500 characters) and `addedAt`.

## Vocabularies

- **Mood**: calm, reflective, curious, playful, comedic, upbeat, warm, dreamy, nostalgic, romantic, emotional, triumphant, motivational, hype, confident, luxurious, tense, dark, eerie, mysterious, epic, cinematic, retro, aggressive.
- **Use**: talking-head, interview, explainer, tutorial, vlog, travel, food, fitness, sports, tech, business, product, montage, story, documentary, comedy, reveal, hook, intro, outro, transition, background-bed.
- **Effect category**: whoosh, swipe, riser, downlifter, impact, boom, click, pop, typing, notification, shutter, glitch, sparkle, success, fail, cash, meme, ambience, foley.

## The personal catalog

The user's layer lives at `~/Library/Application Support/Cutroom/audio-catalog/music.local.json` and `sfx.local.json` (an isolated launch profile keeps its own). Only the app writes it, through `audio_catalog` `save` and `reset`; agents can read it but have no write access to that folder. The file is `{ "version": 1, "revision": n, "updatedAt": ISO | null, "entries": [patch, ...] }`, where each patch has an `id` and the fields it sets. How it combines with the defaults:

- A field the patch leaves out comes from the default, including later updates to it. A field set to `null` is cleared. Arrays and objects (`moods`, `uses`, `tags`, `sections`, `sourceRange`) replace the default's whole.
- A patch that points an entry at a different `sourceUrl` without new timing drops the inherited duration, range, sections, hit, loudness and levels (they described the old recording) and marks the entry `needsVerification`.
- A patch whose id isn't in the defaults is a personal entry. It needs `title`, `description` and `sourceUrl`; one without them (or a patch left behind by a default that was later removed) is left out with a warning naming it.
- `hidden: true` leaves an entry out of lists unless `includeHidden` is set; `preferred: true` lists it first. After preferred entries come the defaults in file order, then personal entries by `addedAt`.
- A repeated id uses its last occurrence. Fields the app doesn't know are kept in the file but not shown.
- Every write is the next `revision`, written whole (private temp file, synced, renamed) with the previous version kept as `.bak`. A stale `expectedRevision` fails without writing. The file holds at most 500 entries and 512 KiB.
- A file that can't be read is never guessed at or overwritten: lists show the defaults with `personalError`, writes fail, and `reset` with `discardDamaged: true` renames it to `<kind>.local.corrupt-<time>.json` and starts empty.

## Curation and checks

Entries were chosen by hand and checked live on the date in `verifiedAt`: YouTube sources were picked from the artist's own channel, its label or its `- Topic` channel (never covers, remakes, loops, sped-up or slowed versions), and their metadata was read with yt-dlp; every source was downloaded, its length measured with ffprobe, its loudness curve measured with FFmpeg's EBU R128 meter to set `sourceRange`, `sections` and `loudnessLufs`, and each effect's peak and transient located to set `hitAt`.

Two checks keep the files honest:

- `src/audio-catalog-defaults.test.ts` (offline, in the desktop unit tests) parses both files, checks ids against their URLs, timing against durations, description rules, each `suggestedVolumeDb` against the formulas above, the mood, energy, vocals and rights balance, that every planned effect category is covered, and that no entry repeats the reference product's songs or meme sounds.
- `node apps/desktop/scripts/verify-audio-catalogs.mjs --yt-dlp <path>` re-checks every entry against the live source (still public, not live, the same length; MyInstants pages still play a sound; files still serve audio). `--download --ffprobe <path> [--ffmpeg <path>]` also downloads each source and compares its measured length and loudness. It only reports; a person listens and edits the JSON. Run it before each release.
