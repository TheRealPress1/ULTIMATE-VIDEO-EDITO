# Licences: what may go into a film, how to verify it, how to credit it

A launch video is commercial use, it is edited (trimmed, layered, synced to picture: legally a derivative), and it is published on platforms that scan audio. Every recording in the film needs a licence that allows all three, read on the item's own page, noted in your manifest and credited. When in doubt, leave it out: there is always another recording. This is practice, not legal advice. Adapted from earshot's `skills/real-sound/references/licences.md` (MIT, Copyright (c) 2026 Leon Lin; see [LICENSE](../LICENSE)).

## Allowed and forbidden

| licence | status | why | credit |
|---|---|---|---|
| CC0 1.0, Public Domain Mark | allowed | no conditions | courtesy only |
| CC BY 4.0 / 3.0 / 2.5 / 2.0 | allowed | commercial use and edits allowed with attribution | REQUIRED (title, author, source link, licence link, "edited") |
| Mixkit Sound Effects Free License / Stock Music Free License | allowed | free for commercial video, no attribution; read the current text at https://mixkit.co/license/ | courtesy only; never redistribute the raw files, never register the film with Content ID |
| Pixabay Content License | allowed | free for commercial use, no attribution (Pixabay blocks scripted downloads: the user downloads by hand) | courtesy only |
| CC BY-NC (any version) | forbidden | NonCommercial: a launch video is commercial | |
| CC BY-ND | forbidden | NoDerivatives: trimming and syncing to picture are derivatives | |
| CC BY-SA | forbidden | ShareAlike: the whole film would have to be released under CC BY-SA | |
| Sampling+, Sampling | forbidden | retired, restrictive | |
| "personal use", "editorial", "custom", "free with credit on social media", all rights reserved | forbidden | not a standard licence anyone can check | |
| two sources disagree ("disputed") | forbidden | the strictest reading wins: reject it | |
| "royalty free" with no licence text, platform rips, anything behind a login or paywall you would bypass, AI-generated or code-synthesized audio | not used | unknown terms, or not a real recording | |

In Cutroom terms: a `web_media_search` result carries a verified `license` from the provider. Keep `code` `cc0`, `pdm`, `public-domain` and `by`; reject `by-sa`, `by-nd`, `by-nc`, `by-nc-sa`, `by-nc-nd`, `sampling+`, `nc-sampling+` and the copyleft `gfdl` and `fal`, and anything with `shareAlike: true`, `commercialUse: false` or `modificationsAllowed: false`; read the terms of any other code on the work's page. `license: "commercial"` on the search already leaves out NonCommercial and NoDerivatives works; it keeps ShareAlike ones, so filter those yourself.

## Verify on the item's own page (never from a search snippet, an aggregator or memory)

**Freesound** (most foley, ambiences, whooshes; Openverse indexes it):
- The page is `https://freesound.org/people/<user>/sounds/<id>/`; the licence is in the sidebar of that page ("Creative Commons 0", "Attribution 4.0", "Attribution NonCommercial 4.0" ...). Licences are per sound, not per user.
- Prefer the Openverse result for a Freesound sound: `web_media_download` with its `url` keeps the verified licence and credit. A direct preview link (`https://cdn.freesound.org/previews/<id // 1000>/<id>_<user_id>-hq.ogg`, Ogg Vorbis at about 192 kbps) downloads as unverified: record the licence text from the page, its author, its title and the date you read it.
- Read the description: some authors ask for a specific credit form (for example "<title> by <name> (www.site) of Freesound.org"), or forbid putting raw files online. Use the requested form in the credit and note any restriction for the user.

**Mixkit** (lossless WAV effects, some music):
- No per-item page exists for sound effects: note the category page that lists the item and its title there.
- WAV download: `https://assets.mixkit.co/active_storage/sfx/<id>/<id>.wav` with `web_media_download` (it comes back unverified). Read the licence text itself (https://mixkit.co/license/) once per session and quote what it allows.
- Do not publish the raw files; do not register the film's audio with Content ID or a rights-management service.

**Music sites** (one licensed track carries the film):
- Composer libraries that release CC BY music: the licence line is on the track's page; many ask for a specific credit line: use it verbatim.
- Aggregators are not authoritative: confirm on the artist's own page. A real case: an aggregator listed a track as CC BY 3.0 while the artist's page said "free with credit on social media" (copyrighted): rejected as disputed.
- Free Music Archive, Internet Archive, SoundCloud: the licence is per track and often NC or ND: read it every time.
- YouTube Audio Library and other platform libraries: terms tied to one platform: ask the user before using.

**Pixabay**: scripted downloads are blocked. If a Pixabay item is the best choice, give the user the page link and ask them to download the file and import it; then check it like any other file.

## Attribution (CC BY)

A complete credit names the title, the author, the source (a link to the item page), the licence (name and link) and says it was modified:

```
"Rain on Windows, Interior, A.wav" by InspectorJ (www.jshaw.co.uk) of Freesound.org
(https://freesound.org/people/InspectorJ/sounds/346642/), licensed under CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/), edited
```

Cutroom writes `CREDITS.md` at the project root from its download ledger: every `web_media_download` and `media_download` file with its credit line, licence and source page. Offer the CC BY lines for the video description; credits never need to be on screen. For an unverified download, add what you read on its page to your report so the user can complete the credit.

## Content ID and CC BY music

Some composers register their CC BY tracks with YouTube Content ID through a distributor. A video using the track correctly can still get an automatic claim. The licence still allows the use: put the credit in the description, and if a claim arrives, dispute it citing the licence and the credit (many composers also clear claims on request). Choose a track whose composer explains this on their site, and tell the user before publishing. Mixkit and Pixabay forbid the reverse: never register a film that contains their items with Content ID.

## The check before delivery

1. Every audible recording has an allowed licence, read on its own page in this session (a verified search result counts as read; re-read when the user asks for certainty).
2. Every CC BY item has a complete credit line, and every author's requested form is used.
3. Nothing unverified, disputed or forbidden is audible in the film: mute or replace it and say so.
