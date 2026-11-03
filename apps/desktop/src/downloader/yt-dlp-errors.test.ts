/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from "vitest";
import { classifyYtDlpError, downloaderLine, sanitizeDetail } from "./yt-dlp-errors";

import type { YtDlpErrorCategory } from "./yt-dlp-errors";

// Hand-written in the shape yt-dlp prints its failures: `ERROR: [extractor] id: message`.
const COOKIES = " Use --cookies-from-browser or --cookies for the authentication. See  https://github.com/yt-dlp/yt-dlp/wiki/FAQ#how-do-i-pass-cookies-to-yt-dlp  for how to manually pass cookies";
const REPORT = "; please report this issue on  https://github.com/yt-dlp/yt-dlp/issues?q= , filling out the appropriate issue template. Confirm you are on the latest version using  yt-dlp -U";

type Case = [name: string, stderr: string, category: YtDlpErrorCategory, extra?: { site?: string; reason?: string; detail?: RegExp }];

const CASES: Case[] = [
  ["removed video", "ERROR: [youtube] dQw4w9WgXcQ: Video unavailable. This video has been removed by the uploader", "unavailable", { site: "YouTube", detail: /^Video unavailable/ }],
  ["terminated account", "ERROR: [youtube] abcdefghijk: Video unavailable. This video is no longer available because the YouTube account associated with this video has been terminated.", "unavailable"],
  ["private video", `ERROR: [youtube] abcdefghijk: Private video. Sign in if you've been granted access to this video.${COOKIES}`, "unavailable", { detail: /^Private video\. Sign in if you've been granted access to this video$/ }],
  ["geo block", "ERROR: [youtube] abcdefghijk: The uploader has not made this video available in your country", "unavailable", { reason: "geo" }],
  ["drm", "ERROR: [youtube] abcdefghijk: This video is DRM protected", "unavailable", { reason: "drm" }],
  ["unsupported url", "ERROR: Unsupported URL: https://example.com/page", "unavailable"],
  ["vimeo 404", "ERROR: [vimeo] 123456: Unable to download JSON metadata: HTTP Error 404: Not Found", "unavailable", { site: "Vimeo" }],
  ["tweet without video", "ERROR: [twitter] 1712345678901234567: No video could be found in this tweet", "unavailable", { site: "X" }],
  ["deleted tiktok", "ERROR: [TikTok] 7234567890123456789: Video not available, status code 10204: This post was deleted", "unavailable", { site: "TikTok" }],
  ["recording gone", "ERROR: [youtube] abcdefghijk: This live stream recording is not available.", "unavailable"],
  ["upcoming live", "ERROR: [youtube] abcdefghijk: This live event will begin in 3 hours.", "live"],
  ["premiere", "ERROR: [youtube] abcdefghijk: Premieres in 2 hours", "live"],
  ["age gate", `ERROR: [youtube] abcdefghijk: Sign in to confirm your age. This video may be inappropriate for some users.${COOKIES}`, "account", { detail: /^Sign in to confirm your age\. This video may be inappropriate for some users$/ }],
  ["bot check", `ERROR: [youtube] abcdefghijk: Sign in to confirm you’re not a bot.${COOKIES}`, "account", { reason: "bot-check", site: "YouTube" }],
  ["members only", "ERROR: [youtube] abcdefghijk: Join this channel to get access to members-only content like this video, and other exclusive perks.", "account"],
  ["instagram login", "ERROR: [instagram] C7aBcDeFgHi: Requested content is not available, rate-limit reached or login required. Use --cookies, --cookies-from-browser, --username and --password, --netrc-cmd, or --netrc (instagram) to provide account credentials", "account", { site: "Instagram" }],
  ["instagram private account", "ERROR: [instagram:user] someone: This account is private", "account", { site: "Instagram" }],
  ["x needs sign-in", "ERROR: [twitter] 1712345678901234567: NSFW tweet requires authentication. Use --cookies", "account", { site: "X" }],
  ["vimeo password", "ERROR: [vimeo] 123456: This video is protected by a password, use the --video-password option", "account", { site: "Vimeo" }],
  ["paid video", "ERROR: [youtube] abcdefghijk: This video requires payment to watch.", "account"],
  ["extractor broke", `ERROR: [youtube] abcdefghijk: Unable to extract uploader id${REPORT}`, "outdated", { detail: /^Unable to extract uploader id$/ }],
  ["signature", "ERROR: [youtube] abcdefghijk: Signature extraction failed: Some formats may be missing", "outdated"],
  ["media 403", "ERROR: unable to download video data: HTTP Error 403: Forbidden", "outdated"],
  ["client refused", "ERROR: [youtube] abcdefghijk: The following content is not available on this app.. Watch on the latest version of YouTube.", "outdated"],
  ["challenge failed, no format", [
    "WARNING: [youtube] abcdefghijk: n challenge solving failed: Some formats may be missing. Ensure you have a supported JavaScript runtime",
    "ERROR: [youtube] abcdefghijk: Requested format is not available. Use --list-formats for a list of available formats",
  ].join("\n"), "outdated"],
  ["throttled session", "ERROR: [youtube] abcdefghijk: This content isn't available, try again later.", "blocked", { reason: "rate-limited" }],
  ["http 429", "ERROR: [youtube] abcdefghijk: Unable to download API page: HTTP Error 429: Too Many Requests", "blocked", { reason: "rate-limited" }],
  ["tiktok ip block", "ERROR: [TikTok] 7234567890123456789: Your IP address is blocked from accessing this post", "blocked", { reason: "rate-limited" }],
  ["dns", "ERROR: [youtube] abcdefghijk: Unable to download webpage: <urlopen error [Errno 8] nodename nor servname provided, or not known> (caused by TransportError('<urlopen error [Errno 8] nodename nor servname provided, or not known>'))", "network"],
  ["read timeout", "ERROR: [download] Got error: The read operation timed out. Giving up after 3 retries", "network"],
  ["server error", "ERROR: [generic] Unable to download webpage: HTTP Error 503: Service Unavailable", "network"],
  ["tls", "ERROR: [vimeo] 123456: Unable to download webpage: [SSL: CERTIFICATE_VERIFY_FAILED] certificate verify failed", "network"],
  ["reset", "ERROR: [soundcloud] some-track: Unable to download JSON metadata: [Errno 54] Connection reset by peer", "network", { site: "SoundCloud" }],
  ["extractor crash", `ERROR: [youtube] abcdefghijk: An extractor error has occurred. (caused by KeyError('videoDetails'))${REPORT}`, "outdated"],
  ["refused by the gate, footer and all", `ERROR: [generic] tone: Unable to download webpage: ('Unable to connect to proxy', OSError('Tunnel connection failed: 403 Forbidden')) (caused by ProxyError("('Unable to connect to proxy', OSError('Tunnel connection failed: 403 Forbidden'))"))${REPORT}`, "network"],
  ["gate couldn't resolve", "ERROR: [youtube] abcdefghijk: Unable to download webpage: Tunnel connection failed: 502 Bad Gateway (caused by ProxyError('Unable to connect to proxy'))", "network"],
  ["format", "ERROR: [youtube] abcdefghijk: Requested format is not available. Use --list-formats for a list of available formats", "format"],
  ["no ffprobe", "ERROR: Postprocessing: ffprobe and ffmpeg not found. Please install or provide the path using --ffmpeg-location", "format"],
  ["conversion", "ERROR: Postprocessing: Conversion failed!", "format"],
  ["max filesize", "[download] File is larger than max-filesize (5368709120 bytes > 1073741824 bytes). Aborting.", "too-large", { reason: "max-filesize" }],
  ["disk full", "ERROR: unable to write data: [Errno 28] No space left on device", "too-large", { reason: "disk-full" }],
  ["interrupted", "ERROR: Interrupted by user", "canceled"],
  ["unknown", "ERROR: [youtube] abcdefghijk: Something nobody has seen before", "unknown", { detail: /^Something nobody has seen before$/ }],
];

describe("classifyYtDlpError", () => {
  it.each(CASES)("%s", (_name, stderr, category, extra) => {
    const result = classifyYtDlpError(`[youtube] Extracting URL\n${stderr}\n`, 1);
    expect(result.category).toBe(category);
    if (extra?.site) expect(result.site).toBe(extra.site);
    if (extra?.reason) expect(result.reason).toBe(extra.reason);
    if (extra?.detail) expect(result.detail).toMatch(extra.detail);
    expect(result.detail.length).toBeLessThanOrEqual(300);
    expect(result.detail).not.toMatch(/please report|yt-dlp -U|--cookies/);
  });

  it("reads the last error line and leaves the generic extractor unnamed", () => {
    const result = classifyYtDlpError("ERROR: [youtube] a: Video unavailable\nERROR: [generic] Unable to download webpage: HTTP Error 502: Bad Gateway", 1);
    expect(result.category).toBe("network");
    expect(result.site).toBeUndefined();
  });

  it("strips signed query strings from details", () => {
    const result = classifyYtDlpError("ERROR: unable to download video data: HTTP Error 403: Forbidden (https://rr3---sn-abc.googlevideo.com/videoplayback?expire=1&sig=SECRET&ip=1.2.3.4)", 1);
    expect(result.detail).toContain("https://rr3---sn-abc.googlevideo.com/videoplayback");
    expect(result.detail).not.toMatch(/SECRET|expire=/);
  });

  it("bounds a long detail", () => {
    expect(classifyYtDlpError(`ERROR: [youtube] a: ${"x".repeat(2000)}`, 1).detail.length).toBe(300);
  });

  it("prefers the downloader's own lines over yt-dlp's", () => {
    const stderr = ["ERROR: [youtube] abcdefghijk: Unable to download webpage: Tunnel connection failed: 403 Forbidden", downloaderLine("private-address", "Refused 10.0.0.2")].join("\n");
    expect(classifyYtDlpError(stderr, 1)).toMatchObject({ category: "unavailable", reason: "private-address", site: "YouTube", detail: "Refused 10.0.0.2" });
    expect(classifyYtDlpError(downloaderLine("canceled", "The download was canceled."), null, "SIGTERM").category).toBe("canceled");
    expect(classifyYtDlpError(downloaderLine("timeout", "Took too long."), null, "SIGTERM")).toMatchObject({ category: "too-large", reason: "timeout" });
    expect(classifyYtDlpError(downloaderLine("stalled", "Nothing arrived."), null, "SIGTERM")).toMatchObject({ category: "network", reason: "stalled" });
    expect(classifyYtDlpError(downloaderLine("byte-cap", "Over 1024 MB."), null, "SIGTERM")).toMatchObject({ category: "too-large", reason: "byte-cap" });
    expect(classifyYtDlpError(downloaderLine("spawn", "EACCES"), null)).toMatchObject({ category: "blocked", reason: "os-blocked" });
    expect(classifyYtDlpError(downloaderLine("port", "Refused media.example.com:8443"), 1)).toMatchObject({ category: "unavailable", reason: "blocked-port" });
  });

  it("reads failures without a final error line", () => {
    expect(classifyYtDlpError("", null, "SIGKILL")).toMatchObject({ category: "blocked", reason: "os-blocked" });
    expect(classifyYtDlpError("zsh: bad CPU type in executable", 126)).toMatchObject({ category: "blocked", reason: "os-blocked" });
    expect(classifyYtDlpError("", null, "SIGTERM").category).toBe("canceled");
    expect(classifyYtDlpError("Traceback (most recent call last):\nOSError: [Errno 28] No space left on device", 1)).toMatchObject({ category: "too-large", reason: "disk-full" });
    expect(classifyYtDlpError("urllib3.exceptions.ProtocolError: Connection reset by peer", 1).category).toBe("network");
    expect(classifyYtDlpError("", 2)).toMatchObject({ category: "unknown", detail: "yt-dlp exited with code 2" });
  });

  it("strips ANSI colors", () => {
    expect(classifyYtDlpError("\u001b[0;31mERROR:\u001b[0m [youtube] abcdefghijk: Video unavailable", 1).category).toBe("unavailable");
  });
});

describe("sanitizeDetail", () => {
  it("keeps one line without boilerplate", () => {
    expect(sanitizeDetail("Unable to extract x;  please report this issue on https://github.com/yt-dlp/yt-dlp/issues\nmore")).toBe("Unable to extract x");
    expect(sanitizeDetail("a\n  b\tc")).toBe("a b c");
  });
});
