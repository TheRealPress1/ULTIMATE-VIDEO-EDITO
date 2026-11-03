/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Hand-written answers for the media tools' tests: yt-dlp's `-J` JSON for
// searches, creator listings and single uploads (only the fields the tools
// read, with the shapes yt-dlp gives them, missing keys included), ffprobe
// and ffmpeg reports, and MyInstants pages. None of it was captured from a
// site; the ids and names are made up.

/** `ytsearch3:<query> --flat-playlist -J`: two videos, a channel to drop and a Short without a duration. */
export const YOUTUBE_SEARCH = {
  _type: "playlist",
  id: "lofi rain instrumental",
  title: "lofi rain instrumental",
  extractor_key: "YoutubeSearch",
  webpage_url: "ytsearch3:lofi rain instrumental",
  entries: [
    {
      _type: "url",
      ie_key: "Youtube",
      id: "AbCdEfGhIj0",
      url: "https://www.youtube.com/watch?v=AbCdEfGhIj0",
      title: "Rain on the Window (Instrumental)",
      duration: 187.0,
      channel: "Quiet Rooms",
      channel_id: "UCabcdefghijklmnopqrstuv",
      channel_url: "https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv",
      uploader: "Quiet Rooms",
      thumbnails: [
        { url: "https://i.ytimg.com/vi/AbCdEfGhIj0/hqdefault.jpg?sqp=small", width: 168, height: 94 },
        { url: "https://i.ytimg.com/vi/AbCdEfGhIj0/hq720.jpg?sqp=big", width: 720, height: 404 },
        { url: "https://i.ytimg.com/vi/AbCdEfGhIj0/maxresdefault.jpg", width: 1280, height: 720 },
      ],
      timestamp: 1704067200,
      view_count: 120345,
      live_status: null,
    },
    {
      _type: "url",
      ie_key: "YoutubeTab",
      id: "UCzyxwvutsrqponmlkjihgfe",
      url: "https://www.youtube.com/channel/UCzyxwvutsrqponmlkjihgfe",
      title: "Lofi Rain Channel",
    },
    {
      _type: "url",
      ie_key: "Youtube",
      id: "ShOrT_123-x",
      url: "https://www.youtube.com/shorts/ShOrT_123-x",
      title: "rain loop #shorts",
      duration: null,
      uploader: "Drizzle",
      view_count: 99,
    },
    {
      _type: "url",
      ie_key: "Youtube",
      id: "LiVe0000001",
      url: "https://www.youtube.com/watch?v=LiVe0000001",
      title: "24/7 rain radio",
      channel: "Quiet Rooms",
      live_status: "is_live",
      upload_date: "20240301",
    },
  ],
};

/** `https://www.youtube.com/@quietrooms/videos --flat-playlist -J`: the channel's profile on the list, entries without their own channel. */
export const YOUTUBE_CHANNEL = {
  _type: "playlist",
  id: "UCabcdefghijklmnopqrstuv",
  title: "Quiet Rooms - Videos",
  channel: "Quiet Rooms",
  channel_id: "UCabcdefghijklmnopqrstuv",
  channel_url: "https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv",
  channel_follower_count: 48200,
  channel_is_verified: true,
  uploader: "Quiet Rooms",
  uploader_id: "@quietrooms",
  uploader_url: "https://www.youtube.com/@quietrooms",
  description: "Rain, rooms and slow piano.",
  extractor_key: "YoutubeTab",
  webpage_url: "https://www.youtube.com/@quietrooms/videos",
  entries: [
    { _type: "url", ie_key: "Youtube", id: "NeWeSt00001", url: "https://www.youtube.com/watch?v=NeWeSt00001", title: "Newest upload", duration: 61, view_count: 10, timestamp: 1761955200 },
    { _type: "url", ie_key: "Youtube", id: "OlDeR000002", url: "https://www.youtube.com/watch?v=OlDeR000002", title: "Older upload", duration: 3600, view_count: 2000 },
  ],
};

/** `https://music.youtube.com/search?q=…#songs --flat-playlist -J`: songs with music.youtube.com links and nothing but a title. */
export const YOUTUBE_MUSIC_SEARCH = {
  _type: "playlist",
  id: "slow piano",
  title: "slow piano",
  extractor_key: "YoutubeMusicSearchURL",
  entries: [
    { _type: "url", ie_key: "Youtube", id: "MuSiC000001", url: "https://music.youtube.com/watch?v=MuSiC000001", title: "Slow Piano (Instrumental)" },
    { _type: "url", ie_key: "Youtube", id: "MuSiC000002", url: "https://music.youtube.com/watch?v=MuSiC000002", title: "Slow Piano" },
  ],
};

/** The same search read in full (no `--flat-playlist`): each entry is the song's own info, with its artist, length and date. */
export const YOUTUBE_MUSIC_SEARCH_FULL = {
  _type: "playlist",
  id: "slow piano",
  title: "slow piano",
  extractor_key: "YoutubeMusicSearchURL",
  entries: [
    {
      id: "MuSiC000001", title: "Slow Piano (Instrumental)", channel: "Some Artist", channel_url: "https://www.youtube.com/channel/UCsomeartistsomeartist00", artist: "Some Artist",
      duration: 214, upload_date: "20230512", timestamp: 1683849600, view_count: 81234, like_count: 950, webpage_url: "https://www.youtube.com/watch?v=MuSiC000001", extractor_key: "Youtube",
      thumbnail: "https://i.ytimg.com/vi/MuSiC000001/maxresdefault.jpg",
    },
    {
      id: "MuSiC000002", title: "Slow Piano", channel: "Some Artist", artist: "Some Artist", duration: 230, upload_date: "20230512",
      webpage_url: "https://www.youtube.com/watch?v=MuSiC000002", extractor_key: "Youtube",
    },
  ],
};

/** `scsearch2:<query> --flat-playlist -J` as it can come back: API links, no titles. */
export const SOUNDCLOUD_SEARCH_FLAT = {
  _type: "playlist",
  id: "night drive",
  title: "night drive",
  extractor_key: "SoundcloudSearch",
  entries: [
    { _type: "url", ie_key: "Soundcloud", id: "1001", url: "https://api.soundcloud.com/tracks/1001" },
    { _type: "url", ie_key: "Soundcloud", id: "1002", url: "https://api.soundcloud.com/tracks/1002" },
  ],
};

/** The same search read in full: each entry is the track's own info. */
export const SOUNDCLOUD_SEARCH_FULL = {
  _type: "playlist",
  id: "night drive",
  title: "night drive",
  extractor_key: "SoundcloudSearch",
  entries: [
    {
      id: "1001", title: "Night Drive", uploader: "Neon Coast", uploader_url: "https://soundcloud.com/neon-coast", duration: 201.4,
      webpage_url: "https://soundcloud.com/neon-coast/night-drive", url: "https://cf-media.sndcdn.com/abc.mp3?Policy=x", timestamp: 1690000000,
      view_count: 5000, like_count: 300, comment_count: 12, extractor_key: "Soundcloud", formats: [{ format_id: "http_mp3_128", acodec: "mp3" }],
    },
    {
      id: "1002", title: "Night Drive (Slowed)", uploader: "Neon Coast", duration: 260, webpage_url: "https://soundcloud.com/neon-coast/night-drive-slowed",
      extractor_key: "Soundcloud", formats: [{ format_id: "hls_opus_64", acodec: "opus" }],
    },
  ],
};

/** `https://www.tiktok.com/@dancer.one -J --playlist-end 2` (read in full): videos with counts, the account's name on each. */
export const TIKTOK_USER = {
  _type: "playlist",
  id: "6800000000000000001",
  title: "dancer.one",
  uploader: "dancer.one",
  extractor_key: "TikTokUser",
  entries: [
    {
      id: "7300000000000000001", title: "new routine", description: "new routine #dance", uploader: "dancer.one", channel: "Dancer One",
      uploader_url: "https://www.tiktok.com/@dancer.one", webpage_url: "https://www.tiktok.com/@dancer.one/video/7300000000000000001",
      duration: 15, timestamp: 1730000000, view_count: 120000, like_count: 9000, comment_count: 210, extractor_key: "TikTok",
      thumbnails: [{ url: "https://p16-sign.tiktokcdn.com/cover.jpeg", width: 720 }],
    },
    {
      id: "7300000000000000002", title: "", description: "", uploader: "dancer.one", webpage_url: "https://www.tiktok.com/@dancer.one/video/7300000000000000002",
      duration: 9, extractor_key: "TikTok",
    },
  ],
};

/** `https://vimeo.com/studio/videos --flat-playlist -J`. */
export const VIMEO_USER = {
  _type: "playlist",
  id: "studio",
  title: "Studio Films",
  extractor_key: "VimeoUser",
  entries: [
    { _type: "url", ie_key: "Vimeo", id: "123456789", url: "https://vimeo.com/123456789", title: "Harbour at dusk" },
  ],
};

/** `-J --skip-download -f <audio>` for one YouTube video: an AAC audio-only format chosen. */
export const YOUTUBE_VIDEO_INFO = {
  id: "AbCdEfGhIj0",
  title: "Rain on the Window (Instrumental)",
  channel: "Quiet Rooms",
  channel_url: "https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv",
  uploader: "Quiet Rooms",
  upload_date: "20240101",
  duration: 187,
  live_status: "not_live",
  extractor: "youtube",
  extractor_key: "Youtube",
  webpage_url: "https://www.youtube.com/watch?v=AbCdEfGhIj0",
  format_id: "140",
  ext: "m4a",
  acodec: "mp4a.40.2",
  filesize: 3_000_000,
  formats: [{ format_id: "140", ext: "m4a", acodec: "mp4a.40.2", vcodec: "none", filesize: 3_000_000 }],
};

/** The same video with a picture asked for: H.264 and AAC merged. */
export const YOUTUBE_VIDEO_INFO_VIDEO = {
  ...YOUTUBE_VIDEO_INFO,
  format_id: "137+140",
  ext: "mp4",
  requested_formats: [
    { format_id: "137", vcodec: "avc1.640028", acodec: "none", filesize: 40_000_000, height: 1080 },
    { format_id: "140", vcodec: "none", acodec: "mp4a.40.2", filesize: 3_000_000 },
  ],
};

/** A SoundCloud track whose only sound is MP3. */
export const SOUNDCLOUD_TRACK_INFO = {
  id: "1001",
  title: "Night Drive",
  uploader: "Neon Coast",
  uploader_url: "https://soundcloud.com/neon-coast",
  duration: 201.4,
  extractor_key: "Soundcloud",
  webpage_url: "https://soundcloud.com/neon-coast/night-drive",
  format_id: "http_mp3_128",
  ext: "mp3",
  acodec: "mp3",
  formats: [{ format_id: "http_mp3_128", ext: "mp3", acodec: "mp3" }],
};

/** An Instagram post holding three videos, as a list. */
export const INSTAGRAM_CAROUSEL = {
  _type: "playlist",
  id: "CaRoUsEl123",
  title: "Post by someone",
  uploader: "someone",
  extractor_key: "Instagram",
  webpage_url: "https://www.instagram.com/p/CaRoUsEl123/",
  entries: [1, 2, 3].map((n) => ({
    id: `310000000000000000${n}`,
    title: `Video ${n} by someone`,
    duration: 12,
    extractor_key: "Instagram",
    formats: [{ format_id: "dash-1", vcodec: "avc1", acodec: "mp4a.40.2" }],
  })),
};

export const LIVE_INFO = { ...YOUTUBE_VIDEO_INFO, id: "LiVe0000001", live_status: "is_live", duration: null };
export const UPCOMING_INFO = { ...YOUTUBE_VIDEO_INFO, id: "SoOn0000001", live_status: "is_upcoming" };
/** Seven hours: over both caps. */
export const LONG_INFO = { ...YOUTUBE_VIDEO_INFO, id: "LoNg0000001", duration: 7 * 3600 };
export const HUGE_INFO = { ...YOUTUBE_VIDEO_INFO_VIDEO, id: "HuGe0000001", requested_formats: [{ format_id: "137", filesize: 5 * 1024 ** 3 }, { format_id: "140", filesize_approx: 1000 }] };

/** `ffprobe -show_format -show_streams -of json` for an AAC `.m4a`. */
export const FFPROBE_AAC = JSON.stringify({
  streams: [{ index: 0, codec_name: "aac", codec_type: "audio", sample_rate: "44100", channels: 2, duration: "187.012" }],
  format: { filename: "x.m4a", format_name: "mov,mp4,m4a,3gp,3g2,mj2", duration: "187.012000" },
});

/** The same for an H.264 + AAC `.mp4` with cover art. */
export const FFPROBE_H264 = JSON.stringify({
  streams: [
    { index: 0, codec_name: "mjpeg", codec_type: "video", width: 320, height: 180, disposition: { attached_pic: 1 } },
    { index: 1, codec_name: "h264", codec_type: "video", width: 1920, height: 1080, duration: "187.000" },
    { index: 2, codec_name: "aac", codec_type: "audio" },
  ],
  format: { duration: "187.020000" },
});

/** `ffmpeg -i` for a VP9 + Opus file (what a build without ffprobe reads). */
export const FFMPEG_INFO = `Input #0, matroska,webm, from 'x.webm':
  Metadata:
    encoder         : google/video-file
  Duration: 00:03:07.02, start: -0.007000, bitrate: 2101 kb/s
  Stream #0:0(eng): Video: vp9 (Profile 0), yuv420p(tv, bt709), 1920x1080, SAR 1:1 DAR 16:9, 25 fps, 25 tbr, 1k tbn (default)
  Stream #0:1(eng): Audio: opus, 48000 Hz, stereo, fltp (default)
At least one output file must be specified
`;

/** A MyInstants sound page. */
export const MYINSTANTS_PAGE = `<!DOCTYPE html>
<html lang="en"><head><title>Boing Spring - Instant Sound Button | Myinstants</title></head>
<body>
<h1 id="instant-page-title">Boing &amp; Spring</h1>
<div class="instant">
  <button class="small-button" onclick="play('/media/sounds/boing-spring.mp3', 'loader-1', 'boing-spring-123')" title="Play Boing Spring sound"></button>
</div>
<a class="instant-page-extra-button" href="/media/sounds/boing-spring.mp3" download>Download MP3</a>
<a href="https://evil.example/media/sounds/other.mp3">elsewhere</a>
</body></html>`;

/** A page whose play button points off the site: never followed. */
export const MYINSTANTS_PAGE_OFFSITE = `<html><body><h1 id="instant-page-title">Trap</h1>
<button onclick="play('https://evil.example/media/sounds/x.mp3', 'l', 'x')"></button>
<a href="/static/sounds/not-a-sound.mp3">nope</a></body></html>`;

/** A MyInstants search page: three instants (one listed twice) and a link that isn't one. */
export const MYINSTANTS_SEARCH = `<!DOCTYPE html><html><body>
<div class="instants result-page">
  <div class="instant"><button class="small-button" onclick="play('/media/sounds/boing.mp3', 'loader-1', 'boing-123')"></button>
    <a href="/en/instant/boing-123/" class="instant-link link-secondary">Boing</a></div>
  <div class="instant"><a href="/en/instant/vine-boom-456/" class="instant-link link-secondary">Vine &quot;Boom&quot;</a></div>
  <div class="instant"><a href="/en/instant/boing-123/" class="instant-link link-secondary">Boing again</a></div>
  <div class="instant"><a href="/en/instant/sad-trombone-789/" class="instant-link link-secondary"><span>Sad</span> Trombone</a></div>
  <a href="/en/categories/memes/">Memes</a>
</div></body></html>`;

/** What a bot screen answers with 200. */
export const BOT_SCREEN = `<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><div id="challenge-platform"></div></body></html>`;
