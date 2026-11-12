# Platform video and audio

`media_search` finds uploads on YouTube, YouTube Music, SoundCloud and MyInstants, or lists a creator's latest uploads on YouTube, SoundCloud, Vimeo, TikTok and Instagram. `media_download` saves the sound or the video behind a platform link (those sites, X, and most other video or audio sites; Vimeo only at best, see below) into the open project's library and credits it in `CREDITS.md`. Both run inside Blackout with its managed downloader (yt-dlp, installed into the app's own data folder on first use and kept current), so they need no shell, no network in the agent's sandbox and no permission prompt. Never run `yt-dlp`, `pip`, `brew` or `curl` in the shell for this: a shell download gets no provenance record, no credit, no library entry and no playability check.

**Rights are not verified.** A platform upload may be copyrighted, so every download is listed in `CREDITS.md` as unverified and the publishing decision stays with the user. For openly licensed stock, and for the images a web page shares, use [`web_media_search` and `web_media_download`](web-media.md), which record a verified license.

| Tool | CLI | Needs a project | Does |
| --- | --- | --- | --- |
| `media_search` | `cutroom media_search [query]` | no | Search a platform or list a creator; returns links, titles, channels, durations, dates and counts, with inline thumbnails |
| `media_download` | `cutroom media_download <url>` | yes, or an absolute `folder` | Download one upload into `assets/<folder>/<id>.<ext>`, check that it plays, import it and credit it |

## media_search

| Field | Type | CLI | Description |
| --- | --- | --- | --- |
| `platform` | `youtube` \| `youtube_music` \| `soundcloud` \| `vimeo` \| `tiktok` \| `instagram` \| `x` \| `myinstants` | `-P, --platform` | default `youtube` |
| `query` | `string`, 1–200 characters | `[query]` | words to search for. Give this **or** `creator`, never both |
| `creator` | `string`, 1–200 characters | `-c, --creator` | an account whose latest uploads to list, newest first: a handle (`@name`), a YouTube channel id (`UC…`) or a profile link |
| `limit` | integer 1–20 | `-l, --limit <n>` | default 5 |
| `sort` | `relevance` \| `date` | `-s, --sort` | YouTube keyword search only; default `relevance`. YouTube's search no longer orders by date, so `date` reads a larger pool of the most relevant results (20 to 50) and puts the newest of them first, with a warning saying so |
| `tab` | `videos` \| `shorts` \| `streams` | `-t, --tab` | YouTube creator listings only; default `videos` |
| `preview` | integer 0–4 | `-p, --preview <n>` | leading results whose thumbnails are inlined as images; default 4 |

What each platform supports:

| Platform | `query` | `creator` | Notes |
| --- | --- | --- | --- |
| `youtube` | yes | yes | dates in listings are YouTube's rough age ("3 weeks ago") turned into a day, so `publishedAtApproximate` is true |
| `youtube_music` | yes (songs) | as YouTube | best for a song's official audio or instrumental; links come back as `youtube.com/watch?v=…`. Its listing gives titles only, so each song's page is read for its artist, length and date when `limit` is 10 or less (a few seconds a song); above that, or when a song can't be read, results carry titles only and a warning says so |
| `soundcloud` | yes | yes (`/tracks`) | downloads are AAC (`.m4a`), kept as served (a track offered without AAC keeps its MP3 or Opus file). Some tracks are DRM-protected: they still appear in a search, but `media_download` refuses them with a DRM error, so pick another result |
| `vimeo` | no | yes (`/videos`) | best effort: Vimeo lets the downloader fetch most videos only when signed in, public ones included, and Blackout doesn't sign in, so `media_download` usually refuses its links (asking for the user's own copy). A listing says so in a warning |
| `tiktok` | no | best effort | each video's page is read for dates and counts when `limit` is 10 or less; TikTok often blocks listings |
| `instagram` | no | best effort | Instagram often requires a sign-in, which Blackout doesn't do |
| `x` | no | no | |
| `myinstants` | yes | no | short meme sounds; read from MyInstants' own search page |

A keyword search where the table says no fails at once with `unsupported` and a substitute: ask the user for links, or find them with the agent's own web search (`site:tiktok.com <words>`, `site:instagram.com/reel <words>`, `site:x.com <words> video`), then pass each link to `media_download`.

The result is `{ platform, profile, results, warnings }`:

| Field | Description |
| --- | --- |
| `profile` | with `creator`: `{ handle, name, bio, url, followers, following, posts, verified }`, each null when the site doesn't say (YouTube gives followers and verification; the others mostly a name). Null for a query |
| `results[].index` | 1-based position; inline images arrive in this order |
| `results[].id`, `platform` | the upload's id on its site, which `media_download` names the file after |
| `results[].url` | the page to pass to `media_download`: a YouTube watch page (Shorts and YouTube Music links normalized to it), the track or video page elsewhere, never an API address |
| `results[].title`, `channel`, `channelUrl` | as the site lists them; an untitled upload is named by its id |
| `results[].durationSeconds` | null when the listing leaves it out |
| `results[].publishedAt`, `publishedAtApproximate` | an ISO date-time, or a `YYYY-MM-DD` day when the site gave only a day or an age |
| `results[].views`, `likes`, `comments` | null when the site doesn't say (flat YouTube listings carry views only) |
| `results[].live` | `none`, `live`, `upcoming` or `was_live`; live and upcoming streams can't be downloaded until they end |
| `results[].thumbnailUrl`, `previewPath` | the largest thumbnail up to 720 px wide, and the local copy of it when it was inlined |
| `warnings` | best-effort platforms, an empty result, and an update of the downloader the call needed; the results still stand |

A result is a candidate, not proof that it downloads or that it is the right recording: choose by title, channel and duration, not by rank. The same arguments within ten minutes return the same answer without asking the site again. Thumbnails that fail, aren't JPEG, PNG, WebP or GIF, or are larger than 1 MiB are left out silently; each is fetched from a public address only. A listing has 45 seconds (90 when every page is read), not counting the downloader's first install; a MyInstants page has 20.

## media_download

| Field | Type | CLI | Description |
| --- | --- | --- | --- |
| `url` | `string`, http or https, up to 4096 characters, required | `<url>` | a `media_search` result's `url`, or a link from the user |
| `kind` | `audio` \| `video` | `-k, --kind` | default `audio`: the sound only. Pass `video` for picture and sound |
| `folder` | `string` | `-f, --folder` | a library folder under `assets/` (up to four names of letters, digits, spaces, `_` and `-`, e.g. `music`, `sfx`, `b-roll/city`); default `music` for audio, `footage` for video, `sfx` for MyInstants. With no project open, an absolute folder instead. In the CLI, a path starting with `/` or `.` is a folder on disk |
| `maxHeight` | `360` \| `480` \| `720` \| `1080` | `--max-height <px>` | video only: the cap on the picture's shorter side, so `1080` takes a landscape 1920x1080 and a vertical 1080x1920 alike; default 1080. A source with nothing that small gives its smallest picture, with a warning |
| `item` | integer 1–100 | `--item <n>` | which upload of a post or list holding several (an Instagram carousel, an X post with two videos), 1-based |

What happens:

1. **The link is checked.** Only `http` and `https` links, as for `web_media_download`: local names and private addresses are refused before anything runs. An image link, or a `web_media_search` result, is sent back to `web_media_download`, which keeps its license; a MyInstants link that isn't a sound page is refused with a pointer to `media_search`.
2. **An upload saved before is found without the network**, offline included, by the id the link names (YouTube watch, `youtu.be`, Shorts, live, embed and YouTube Music links; TikTok, X, Instagram, Vimeo and MyInstants links; the user's own Instagram posts by the post's id), when the project's record of it still matches the file by size and hash. It is reused from whichever folder it is in. A video saved with a lower `maxHeight` than the one asked for doesn't count, so the larger one is downloaded next to it (`<id>-2.mp4`); one saved larger than asked for is reused, with a warning. A file that came larger than its cap (nothing smaller was offered) counts for every cap up to its own size.
3. **Then the network.** The link's host must resolve to public addresses (a known site that doesn't resolve fails as a connection problem, not a bad link), and the downloader's own traffic goes through Blackout's egress gate, which refuses private addresses too. A known platform's link is read only by that platform's extractor.
4. **The metadata is read first.** A list holding several uploads fails with how many it holds (pass `item`); it is counted only up to 101, so a channel or a long playlist isn't read to its end. Live and upcoming streams fail; a source longer than the cap (audio 6 h, video 3 h), or expected to be larger (audio 1 GB, video 4 GB), fails before a byte of media moves. A file already in the folder under the upload's id that the project has no record of (copied in by hand) is adopted once it probes as the kind asked for.
5. **The media is downloaded** into a work folder in the project's `.cutroom/`, out of the agents' reach and on the same disk, so the finished file is renamed into place. Audio takes the site's own sound without re-encoding: AAC as `.m4a` where the site has it, otherwise its MP3 or Opus file (`reencoded: false`). Video takes the largest picture whose shorter side is within `maxHeight`, or the smallest there is when nothing is that small (with a warning), in a codec the editor plays where offered; at the same size H.264 comes first, then HEVC, and AAC sound (whether the site calls it `mp4a` or `aac`) comes first. Picture and sound are merged into MP4. A download has 60 minutes, and stops after 2 minutes without data. A file that turns out larger than the cap only once it is fetched (the site didn't say its size) is skipped by the downloader, and the call fails saying so. At most two run at once; asking for an upload that is already downloading waits for it and reuses its file.
6. **The file is checked to play.** It must have a length, the picture (H.264, HEVC, AV1 or VP9) or the sound asked for, and stay within the caps. A video without sound is kept with a warning.
7. **The file lands at `assets/<folder>/<id>.<ext>`**, the id made file-safe (YouTube ids are kept as they are, so `music/<id>.m4a` matches a catalog entry's `youtube:<id>`). The same bytes already in the project are reused. A different file under that name moves this one to `<id>-<site>` when the other came from another site, otherwise to `-2`, `-3` and so on.
8. **The file is imported** into the library's folder of the same name, with where it came from noted on its record; a file the library can't open is taken back out. Then it is **credited** in `.cutroom/web-media.json` and `CREDITS.md`.

Saving or moving the project mid-download stops the download and removes its work folder first (the call fails, saying so), and so does quitting the app. Canceling the call does the same. Duplicating the project doesn't stop anything: the copy leaves out downloads still under way, and the file lands in the original.

Two sources skip the downloader:

- **MyInstants** sound pages (`https://www.myinstants.com/<lang>/instant/<name>/`) are read by the app itself: the page within 20 seconds, then its own MP3, at most 20 MB, fetched within 30 seconds, no longer than 10 minutes, saved as `sfx/<name>.mp3`. Only MyInstants' own hosts are asked, redirects elsewhere are refused, and a bot screen fails with a pointer to the audio catalog and `web_media_search`. Any other MyInstants link fails with `invalid-input`: the site's own MP3 link (`/media/sounds/<name>.mp3`) with a pointer to `web_media_download`, which takes it, and anything else with a pointer to `media_search`.
- **The user's own Instagram posts**: pass a post's `mediaUrl` from `instagram_posts`, or its permalink once `instagram_posts` has synced it. The file is fetched straight from Instagram's file servers, which needs no sign-in, named after the post's id (`footage/<id>.mp4`, or its sound copied out as `music/<id>.m4a` for `kind: "audio"`), and credited to the permalink, never to the expiring file link. An expired link fails with a request to call `instagram_posts` again. A carousel's file link is only its first file, so a carousel's permalink goes through the downloader instead, with `item` choosing the file (best effort: Instagram often asks for a sign-in); a file link is one file, so `item` is ignored there, with a warning.

The result:

| Field | Description |
| --- | --- |
| `src`, `libraryPath` | the same library path, e.g. `music/XajaJYraODs.m4a`, to use as `src` in JSX; null for a file saved to an absolute folder |
| `assetId`, `path` | the library asset (null outside a project) and the file's absolute path |
| `id`, `site` | the upload's id and `youtube`, `soundcloud`, `tiktok`, `instagram`, `x`, `vimeo`, `myinstants`, or the downloader's own name for another site |
| `kind`, `title`, `channel`, `channelUrl`, `uploadDate` | what the site says; `uploadDate` is `YYYY-MM-DD` |
| `durationSeconds`, `width`, `height`, `videoCodec`, `audioCodec`, `hasAudio` | from probing the file |
| `mimeType`, `bytes` | the file |
| `sourceUrl` | the page the media came from |
| `reused` | the file was already there and nothing new was saved |
| `reencoded` | the picture or sound was converted rather than kept as served |
| `rights` | always `unverified` |
| `downloader` | what fetched it, e.g. `yt-dlp 2026.10.26` |
| `creditsFile` | absolute path of `CREDITS.md`; null outside a project |
| `warnings` | a silent video, a picture larger than `maxHeight` because nothing smaller was offered, a sound saved from a MyInstants link asked for as video, an update of the downloader the call needed |

The whole source is kept. Place a section with `sourceIn`/`sourceOut` rather than downloading again:

```tsx
<audio id="bed" src="music/XajaJYraODs.m4a" start={0} sourceIn={42} sourceOut={72} volume={-18} />
```

The title and channel say what an upload claims to be, not what it sounds like. Check a downloaded file with [`sound_analyze`](./sound.md) before placing it: `describe` for what it is, `match` on a few windows for an instrumental with no vocals (the [music skill](../../skills/uve-music/SKILL.md) gives the check), and [`sound_effects`](./sound.md) `check` for clicks, clipping or a cut tail in a sound effect.

## Recovery inside the call

The downloader is installed on the first call that needs it, from yt-dlp's GitHub releases, and checked for updates in the background. A release is used only when its files match its `SHA2-256SUMS` and that file carries yt-dlp's signature, checked against the release key built into Blackout; an unsigned release is refused, and the installed one keeps working. Within one call, a page the extractor can no longer read updates the downloader once and tries again (a download that fails this way has the link's metadata read again by the new version first, since the saved formats came from the old one); a dropped connection is tried once more after two seconds. Nothing else is retried, so an error that reaches the agent is final: follow its message rather than calling again with the same link, and never swap in a different song or video without telling the user. Settings > Downloads shows the downloader's version and state.

## Credits

Platform downloads join web media in the `CREDITS.md` section Blackout rewrites after each download, with the credit line `"<title>" by <channel> on <Site> (<page>)`, the license marked as not verified, and the source page. See [web media](web-media.md#licenses-and-credits) for how that section is kept.

## CLI

```sh
cutroom media_search "blinding lights instrumental" --limit 5
cutroom media_search --platform youtube_music "slow piano instrumental" --preview 0
cutroom media_search --creator @somechannel --tab shorts
cutroom media_search --platform myinstants "vine boom"
cutroom media_download "https://www.youtube.com/watch?v=XajaJYraODs"
cutroom media_download "https://www.tiktok.com/@someone/video/7300000000000000001" --kind video --max-height 720 --folder b-roll
cutroom media_download "https://www.instagram.com/p/<code>/" --kind video --item 2
cutroom media_download "https://www.myinstants.com/en/instant/<name>/"
cutroom audio_catalog music --vocals none --moods calm
```

The CLI prints the same JSON as the MCP tools; inline thumbnails are not printed, so read each result's `previewPath`.

## Errors

- `Give exactly one of query (words to search for) or creator (an account whose latest uploads to list).`
- `Blackout can't search TikTok by keyword. …` (and the same for Instagram, X and Vimeo) — with the substitute to use.
- `That isn't a creator Blackout can list on YouTube: give a handle like @name, a channel id (UC…) or a channel link.`
- `No project is open. Open one first, or pass an absolute folder to save the file there without a project.`
- `That folder isn't one media_download can use: …` and `With a project open, folder is a library folder under assets/ …`
- `This is an image or a web_media_search result, whose license web_media_download keeps. …`
- `This link holds 3 uploads. Pass item (1-3) to choose one, or pass the upload's own link.` (past 100: `This link holds more than 100 uploads. …`)
- `This is a live stream. Download it once the stream has ended, or choose another source.`
- `This video runs 3 h 20 min, longer than the 3 h 00 min media_download takes for video. …` and `This video would be about 5.1 GB, more than the 4.0 GB …`
- `The downloader skipped this video: it is larger than the 4.0 GB media_download takes for video. …` — the site didn't say the size up front.
- `This media can't be downloaded (Video unavailable). Choose a different source; this link won't work on retry.`
- `SoundCloud protects this with DRM (…), so it can't be downloaded. Choose another source or ask the user for their own copy.` — the same for any site's DRM-protected media.
- `YouTube only shows this to signed-in viewers (…). Blackout doesn't sign in to sites: choose another source, or ask the user for their own copy of the file.`
- `Vimeo lets the downloader read its videos only when signed in, public ones included (The web client only works when logged-in), and Blackout doesn't sign in to sites. …` — about Vimeo, not the video: ask the user for their own copy.
- `YouTube asked for a bot check (…), which happens on VPNs and shared networks. …`
- `<Site> is limiting requests from this network (HTTP Error 429 …). Wait several minutes …`
- `The downloader is up to date (yt-dlp <version>) and still can't read this page (…). The site may be blocking downloads right now; tell the user rather than retrying.`
- `Couldn't reach YouTube (…). Check the internet connection, then try once more.` — also when a known site's name doesn't resolve (offline).
- `No picture the editor can play came with this video (mpeg4 with aac); choose another source.`
- `Blackout couldn't set up its downloader (yt-dlp): … Settings > Downloads shows its state.`
- `MyInstants refused the request (it may be showing a bot check). …` and `MyInstants took longer than 20 seconds to answer …`
- `Instagram's link to this file has expired (403). Call instagram_posts again for a fresh mediaUrl, or pass the post's permalink.`
- `The project was saved or moved during the download. Download again in the project where it is now.`
