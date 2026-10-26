# Web images and media

`web_media_search` finds openly licensed images, video and audio on [Openverse](https://openverse.org) and [Wikimedia Commons](https://commons.wikimedia.org). `web_media_download` saves a chosen result, or a link the user supplies, into the open project's library with its license recorded. The app does the network work itself, so both run without a shell, without the agent sandbox's network, and without a permission prompt. Use them instead of `curl` or scripts: a shell download gets no license record, no credit and no library entry.

| Tool | CLI | Needs a project | Does |
| --- | --- | --- | --- |
| `web_media_search` | `cutroom web_media_search <query>` | no | Search both providers and return results with normalized licenses, attribution lines and inline thumbnails |
| `web_media_download` | `cutroom web_media_download <url>` | yes | Download a file (or the media a web page shares) into `assets/web/`, import it, and credit it in `CREDITS.md` |

## web_media_search

| Field | Type | CLI | Description |
| --- | --- | --- | --- |
| `query` | `string`, 1–200 characters, required | `<query>` | what to look for. Name the subject, place, era and shot type ("1969 Saturn V launch pad at dawn"); abstract words return weak stock |
| `kind` | `image` \| `video` \| `audio` | `-k, --kind` | default `image`. Openverse has no video, so a video search uses Commons alone and says so in `warnings` |
| `orientation` | `any` \| `landscape` \| `portrait` \| `square` | `--orientation` | images only; default `any` |
| `license` | `editable` \| `commercial` \| `any` | `--license` | `editable` (default) leaves out no-derivatives (ND) works; `commercial` keeps works that allow commercial use **and** modification; `any` returns every openly licensed work |
| `sources` | array of `openverse`, `wikimedia` | `-s, --sources <source...>` | default both |
| `limit` | integer 1–30 | `-l, --limit <n>` | default 12 |
| `preview` | integer 0–4 | `-p, --preview <n>` | leading results whose thumbnails are inlined as images; default 4 |

The result is `{ results, warnings }`. Results alternate between providers, without the same file twice (a Commons file Openverse also lists counts once, whichever rendition or tracking parameters its URLs carry, and comes as Commons' own result, in the place of whichever provider listed it first: Openverse links the original, which may be a TIFF or wider than 3840 px), numbered from 1 by `index`; inline images arrive in that order. Each result has:

| Field | Description |
| --- | --- |
| `id`, `provider`, `source` | `openverse:<id>` or `wikimedia:<page id>`; `source` is where Openverse found the work (`flickr`, `wikimedia`, …) |
| `kind`, `title`, `creator` | plain text; HTML in Commons' fields is stripped |
| `url` | the file to download. Commons images point at a JPEG/PNG rendition when the original is TIFF, another format the editor can't decode, or wider than 3840 px: at the widest width Commons renders (120, 250, 330, 500, 960, 1280, 1920 or 3840 px) that is no wider than the original, since Commons refuses any other width |
| `thumbnailUrl`, `previewPath` | the thumbnail, and the local copy of it when it was inlined |
| `pageUrl` | the work's page, for attribution |
| `width`, `height`, `durationSeconds`, `mimeType` | what the provider reports |
| `license` | `{ code, name, version?, url?, attributionRequired, shareAlike, commercialUse, modificationsAllowed, verified }`. `code` is one of `cc0`, `pdm`, `public-domain`, `by`, `by-sa`, `by-nd`, `by-nc`, `by-nc-sa`, `by-nc-nd`, `sampling+`, `nc-sampling+`, `gfdl`, `fal`, `ogl`, `attribution`. Search results are always `verified: true`; works without a recognizable free license are left out |
| `attribution` | a ready-to-paste credit: title, creator, page and license |

A provider that fails, times out (15 s) or is rate limited becomes a line in `warnings`, and the other still answers; the call fails only when every provider does. A provider that timed out sits out the next five minutes of searches that have another provider to ask, so a slow service doesn't hold up every search; naming it alone in `sources` still tries it. Thumbnails that fail to load (they are not retried), are not JPEG/PNG/WebP/GIF, or exceed 1 MiB are left out silently. The app remembers the last 500 results' file, page and thumbnail URLs for the session, compared without their fragment and `utm_*` tracking parameters, which is how a download finds its provenance.

## web_media_download

| Field | Type | CLI | Description |
| --- | --- | --- | --- |
| `url` | `string`, http or https, required | `<url>` | a result's `url` (or `pageUrl`), or a link from the user: a media file or a web page |
| `name` | `string`, 1–80 characters | `-n, --name <name>` | short descriptive base name for the file (default: the result's title, the page's title, or the URL's file name) |
| `prefer` | `image` \| `video` | `--prefer <kind>` | which of a web page's shared media to take when it declares both; default `image` |

What happens:

1. **The link is checked.** Only `http` and `https`, without a user name or password. `localhost`, `*.local`, `*.localhost`, `*.internal`, names without a dot, and private, loopback, link-local, carrier-grade NAT, multicast and reserved addresses (IPv4 and IPv6, including IPv4-mapped and NAT64 forms) are refused, and so is a host when any address it resolves to is one of them. `198.18.0.0/15` is allowed: proxy tools in fake-IP mode (Surge, Clash, Stash) answer every name with it. Redirects (at most 5) are followed one hop at a time, each checked again, and the connection itself only goes to the checked addresses. Cutroom connects directly and doesn't go through a configured HTTP proxy; when a host can't be reached or doesn't answer in time and a proxy is set up (`HTTPS_PROXY`/`HTTP_PROXY`/`ALL_PROXY`, or an HTTPS, HTTP, SOCKS or automatic proxy in macOS's network settings), the error says so.
2. **A search result downloads its own file.** A result's `url`, `pageUrl` or `thumbnailUrl` downloads the result's file and keeps its title, creator, provider and verified license. When that file's address now answers with a web page instead (the file moved or was taken down), the call fails with "This search result's file now answers with a web page instead (it may have moved or been taken down). Pick another result." rather than take whatever that page shares under the result's credit.
3. **A web page resolves to the media it shares**: its `og:image` (or `og:video` with `prefer: "video"`, falling back to the image when the video is only a player), Twitter card image or `<link rel="image_src">`, relative to the page (or its first `<base href>`); the first three that are http(s) links are tried in that order. A page sharing nothing downloadable fails with: "This page doesn't expose a downloadable image or video. Video platforms (YouTube, Instagram, TikTok…) stream through their players — ask the user to export or import their own copy." A page whose shared media exists but won't download says why instead, for example "The page shares media at cdn.example, but downloading it failed: cdn.example refused the download (403); …" for a host that blocks hotlinking.
4. **The bytes decide what the file is**, whatever the server claims. Accepted: JPEG, PNG, GIF, WebP, AVIF, BMP and SVG images; MP4, MOV, M4V, WebM, MKV, Ogg (Theora) and MPEG-TS video; MP3, WAV, FLAC, AAC, M4A and Ogg audio. TIFF and HEIC are refused with "Choose a JPEG/PNG/WebP rendition of this image." Anything else is "not an image, video or audio file".
5. **Size and time are capped**: 60 MB for an image, 500 MB for audio, 2 GB for video, checked against the declared length and counted while streaming; 30 s for a server to answer, 60 s without data, 20 minutes in all. At most two downloads run against one host at a time; the rest wait their turn, and that wait doesn't count toward the 20 minutes. When Wikimedia or Openverse answers 429 or 503, the download asks again after the `Retry-After` the host names (or 2 s, then 4 s), at most twice and 30 s in all; a longer wait fails the call with how long to wait. Canceling the call stops the download and removes the partial file, and so do saving or moving the project mid-download (the call fails, saying so; the save waits until the partial file is gone) and quitting the app. Duplicating the project mid-download doesn't wait for the download, and the copy doesn't get its partial file; the file still lands in the original. A project folder that disappears mid-download some other way (moved in Finder, deleted) fails the call with "The project moved or closed during the download."
6. **The file lands at `assets/web/<name>-<sha8>.<ext>`**, written to a temporary file and renamed when complete. When the project already holds the same bytes from an earlier download, that file is reused (`deduplicated: true`) and nothing new is written; the earlier file must still match by size and hash, so one edited since (cropped, converted) is left alone and the download lands next to it.
7. **The file is imported into the library** in its `web` folder, with where it came from noted on its record. A file the library can't open is taken back out of the project and the call fails.
8. **The download is credited**: recorded in `.cutroom/web-media.json` and in `CREDITS.md` at the project root.

The result:

| Field | Description |
| --- | --- |
| `src` | the library path to use in JSX, e.g. `web/apollo-launch-3f2a9c1d.jpg` |
| `assetId`, `path` | the library asset and the file's absolute path |
| `kind`, `mimeType`, `bytes` | what the file is, as the library probed it |
| `width`, `height`, `durationSeconds` | from the library's probe |
| `title`, `creator`, `provider`, `pageUrl` | provenance, when known |
| `fileUrl` | where the bytes came from, after redirects and page resolution |
| `license`, `attribution` | as for search results. A link that was not a search result has `code: "unknown"` and `verified: false`: nothing is known about its rights, so leave that decision to the user |
| `creditsFile` | absolute path of `CREDITS.md` |
| `deduplicated` | the same bytes were already in the project, and that file is the one returned |

```tsx
<image src="web/apollo-launch-3f2a9c1d.jpg" width={1080} height={1920} objectFit="cover" start={0} end={4} />
```

## Licenses and credits

Each download is listed in `CREDITS.md` with its library path, credit line, license and source page, in a section the app rewrites after every download (between `<!-- cutroom:web-media:start -->` and `<!-- cutroom:web-media:end -->`). Anything else in the file is left alone, and files that have since been deleted drop out of the list. The section travels with the project (Collect Project copies it); the ledger in `.cutroom/` does not.

Prefer CC0, public-domain and CC BY works. `attributionRequired` means the credit line belongs in the post's caption or description; `shareAlike` means an adaptation must carry the same license; `commercialUse: false` rules out monetized or brand use; `modificationsAllowed: false` (ND) rules out cropping, overlays and edits. The license is the provider's statement about the work, not legal advice.

## CLI

```sh
cutroom web_media_search "saturn v launch pad" --orientation portrait --limit 8
cutroom web_media_search "rocket countdown" --kind audio --license commercial --preview 0
cutroom web_media_download "https://upload.wikimedia.org/wikipedia/commons/2/25/Apollo_11_Launch_-_GPN-2000-000630.jpg" --name "apollo launch"
cutroom web_media_download "https://example.com/article" --prefer video
```

The CLI prints the same JSON as the MCP tools; inline thumbnails are not printed, so read each result's `previewPath`.

## Errors

- `No project open — open one first` — `web_media_download` needs an open project; search does not.
- `Local and private network addresses can't be downloaded from. Use a public http or https link.`
- `<host> says this file doesn't exist (404)`, `<host> refused the download (403)`, `<host> refused the request (400)`, `<host> is rate limiting requests (429). Wait <n> seconds or pick another result.`
- `thumb.wikimedia.org doesn't render this image at that width (400): Wikimedia Commons only serves 120, 250, 330, 500, 960, 1280, 1920, 3840 px wide renditions. …` — a Commons rendition link at another width; asking again won't help.
- `Couldn't reach <host> (ECONNREFUSED). This Mac is set up to use a proxy (HTTPS_PROXY is set), which Cutroom's downloader doesn't go through: …` — the network may only allow traffic through that proxy. The same sentence follows `<host> didn't answer within 30 seconds.` and a search provider's `didn't answer within 15 seconds.` when a proxy is set up, since a network that drops direct connections times out rather than refusing them; the proxy is named as `HTTPS_PROXY is set` or, for example, `HTTPS proxy proxy.corp:3128 in System Settings`.
- `This page doesn't expose a downloadable image or video. …` — see step 3.
- `This is a TIFF image, which the editor can't decode. Choose a JPEG/PNG/WebP rendition of this image.`
- `This image is larger than 60 MB, the most web_media_download takes for an image. Pick a smaller rendition.`
- `<host> didn't answer within 30 seconds`, `<host> stopped sending data for 60 seconds`, `The download took longer than 20 minutes and was stopped.`
- `Web media search failed. Openverse: … Wikimedia Commons: …` — every provider failed; the reasons follow.
