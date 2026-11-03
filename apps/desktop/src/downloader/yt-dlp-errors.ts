/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// What went wrong in a yt-dlp run, from its exit and the tail of its stderr.
// yt-dlp reports a failure as a final `ERROR: [extractor] id: message` line;
// the patterns below match the wording of those messages loosely, since it
// drifts between releases, and anything unrecognized stays `unknown` with the
// message as its detail. Retrying is the callers' decision (see index.ts).
//
// Lines the downloader itself adds (canceled, timed out, over its byte cap,
// a refused address, a binary that would not start) carry a
// `[cutroom:<kind>]` tag instead of an extractor name and are read first.

export type YtDlpErrorCategory =
  | "unavailable"
  | "live"
  | "account"
  | "outdated"
  | "network"
  | "blocked"
  | "format"
  | "too-large"
  | "canceled"
  | "unknown";

/**
 * A finer reason inside a category, for messages: `bot-check` and
 * `rate-limited` (the site pushed back), `os-blocked` (macOS would not run the
 * binary), `private-address` and `blocked-port` (the egress gate refused a
 * host, or a port other than 80 and 443), `disk-full`, `timeout`, `stalled`,
 * `byte-cap`, `max-filesize`, `drm`, `geo`.
 */
export type YtDlpErrorReason =
  | "bot-check"
  | "rate-limited"
  | "os-blocked"
  | "private-address"
  | "blocked-port"
  | "disk-full"
  | "timeout"
  | "stalled"
  | "byte-cap"
  | "max-filesize"
  | "drm"
  | "geo";

export type YtDlpError = { category: YtDlpErrorCategory; detail: string; site?: string; reason?: YtDlpErrorReason };

/** The tags of the lines the downloader adds to stderr. */
export type DownloaderLineKind = "canceled" | "timeout" | "stalled" | "byte-cap" | "private-address" | "port" | "spawn";

/** A stderr line the downloader adds; `classifyYtDlpError` reads it before yt-dlp's own. */
export function downloaderLine(kind: DownloaderLineKind, message: string): string {
  return `ERROR: [cutroom:${kind}] ${message}`;
}

const DETAIL_MAX = 300;

/** Display names for yt-dlp extractor keys (lowercase, before any `:`). */
const SITES: Record<string, string> = {
  youtube: "YouTube",
  ytsearch: "YouTube",
  instagram: "Instagram",
  tiktok: "TikTok",
  twitter: "X",
  x: "X",
  vimeo: "Vimeo",
  soundcloud: "SoundCloud",
  facebook: "Facebook",
  twitch: "Twitch",
  reddit: "Reddit",
  dailymotion: "Dailymotion",
  bandcamp: "Bandcamp",
  bilibili: "Bilibili",
};

// Ordered: the first rule that matches the final error message wins.
type Rule = { category: YtDlpErrorCategory; pattern: RegExp; reason?: YtDlpErrorReason };
const RULES: Rule[] = [
  { category: "canceled", pattern: /interrupted by user|\bKeyboardInterrupt\b/i },
  // YouTube's answer to a client it no longer accepts reads like a removal too.
  { category: "outdated", pattern: /not available on this app|watch on the latest version of youtube/i },
  // YouTube's answer to a session it is throttling reads like a removal.
  { category: "blocked", reason: "rate-limited", pattern: /content isn.?t available,? try again later|ip address is blocked|blocked from accessing/i },
  { category: "account", reason: "bot-check", pattern: /not a bot|bot[- ]check|captcha/i },
  { category: "live", pattern: /live event will begin|premieres? in \d|premiere will begin|is an upcoming|scheduled (?:live )?stream|waiting for (?:the )?(?:scheduled )?(?:live )?stream|stream (?:has not|hasn.?t) started/i },
  { category: "unavailable", reason: "drm", pattern: /\bDRM\b/ },
  // Before the sign-in rule: yt-dlp offers cookies for private videos too.
  { category: "unavailable", pattern: /private video|video is private/i },
  { category: "account", pattern: /confirm your age|protected by a password|--video-password|requires payment|purchase (?:this|the) video|age[- ]?restricted|inappropriate for some users|members[- ]only|join this channel|(?:login|log in|sign[- ]in) (?:is )?required|requires? (?:a )?(?:login|log in|sign[- ]in|authentication|an account)|registered users|--cookies(?:-from-browser)?\b|account is private|private account|logged[- ]in users|need to log in|subscribers? only|premium members|HTTP Error 401/i },
  { category: "unavailable", pattern: /this video is unavailable|video unavailable|has been removed|no longer available|been terminated|was deleted|does not exist|HTTP Error 404|HTTP Error 410|unsupported url|is not a valid url|no video (?:could be found|in this)|there is no video|post (?:is|was) unavailable|content is not available|recording is not available|copyright (?:claim|grounds)/i },
  { category: "unavailable", reason: "geo", pattern: /in your country|geo[- ]?restrict|from your location|not available in your (?:region|area)/i },
  { category: "blocked", reason: "rate-limited", pattern: /HTTP Error 429|too many requests|rate[- ]?limit/i },
  { category: "too-large", reason: "disk-full", pattern: /no space left|ENOSPC|\[Errno 28\]|disk (?:is )?full/i },
  { category: "too-large", reason: "max-filesize", pattern: /larger than max-filesize/i },
  { category: "format", pattern: /requested format (?:is )?not available|no (?:video )?formats? found|only images are available|no suitable format|ffmpeg (?:is )?not (?:installed|found)|ffprobe (?:and ffmpeg )?not found|postprocessing:|conversion failed|merging of multiple formats/i },
  { category: "outdated", pattern: /unable to extract|nsig extraction failed|signature extraction failed|(?:\bn|sig) challenge|unable to (?:decrypt|solve)|out of date|update yt-dlp|HTTP Error 403|some formats may be missing|failed to (?:parse|decode) json|extractor error has occurred|caused by (?:KeyError|TypeError|IndexError|AttributeError|ValueError)\b/i },
  { category: "network", pattern: /getaddrinfo|nodename nor servname|name or service not known|temporary failure in name resolution|name resolution|timed? ?out|connection (?:reset|refused|aborted|closed)|remote end closed|broken pipe|network is (?:unreachable|down)|no route to host|\bSSL\b|\bTLS\b|certificate|HTTP Error 5\d\d|tunnel connection failed|connect tunnel failed|unable to connect to proxy|proxy ?error|curl: \(\d+\)|\[Errno (?:-[235]|8|32|5[0-4]|6[015])\]|incomplete ?read|bytes read|giving up after \d+ (?:fragment )?retries|unable to download (?:webpage|json|video data|api page)|urlopen error|transport ?error/i },
];

/** Warnings yt-dlp prints when YouTube's JavaScript challenge or signature could not be solved. */
const CHALLENGE_FAILED = /(?:\bn|sig|nsig|signature) (?:challenge solving|extraction) failed|challenge solving failed|some formats may be missing|only images are available/i;

const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;
const ERROR_LINE = /^ERROR: (?:\[([^\]]+)\] )?(.*)$/;

/** yt-dlp's bug-report footer, which it adds to many errors whatever their cause. */
function withoutFooter(text: string): string {
  return text
    .replace(/[;.]?\s*please report this issue on\b[\s\S]*$/i, "")
    .replace(/[;.]?\s*confirm you are on the latest version\b[\s\S]*$/i, "");
}

/** A message safe to show and log: no query strings (signed media URLs carry tokens), no yt-dlp boilerplate, one line, bounded. */
export function sanitizeDetail(text: string): string {
  let detail = text
    .replace(ANSI, "")
    .replace(/\b(https?:\/\/[^\s?#'"<>)]+)[?#][^\s'"<>)]*/gi, "$1")
    .replace(/\s+/g, " ")
    .replace(/[;.]?\s*please report this issue on\b.*$/i, "")
    .replace(/[;.]?\s*confirm you are on the latest version\b.*$/i, "")
    .replace(/[;.]?\s*use --cookies(?:-from-browser)?\b.*$/i, "")
    .replace(/[;.]?\s*(?:see|refer to)\s+https:\/\/github\.com\/yt-dlp\/\S+.*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
  if (detail.length > DETAIL_MAX) detail = `${detail.slice(0, DETAIL_MAX - 1).trimEnd()}…`;
  return detail;
}

function siteOf(extractor: string | undefined): string | undefined {
  if (!extractor) return undefined;
  const key = extractor.toLowerCase().split(":")[0]!;
  if (!key || key === "generic" || key.startsWith("cutroom")) return undefined;
  return SITES[key] ?? extractor.split(":")[0];
}

const OWN_KINDS: Record<DownloaderLineKind, { category: YtDlpErrorCategory; reason?: YtDlpErrorReason }> = {
  canceled: { category: "canceled" },
  timeout: { category: "too-large", reason: "timeout" },
  stalled: { category: "network", reason: "stalled" },
  "byte-cap": { category: "too-large", reason: "byte-cap" },
  "private-address": { category: "unavailable", reason: "private-address" },
  port: { category: "unavailable", reason: "blocked-port" },
  spawn: { category: "blocked", reason: "os-blocked" },
};

/**
 * Sorts a failed yt-dlp run into the category its callers act on, with a
 * one-line `detail` (yt-dlp's own message, sanitized) and the `site` named by
 * the extractor when there is one.
 */
export function classifyYtDlpError(stderr: string, code: number | null, signal?: NodeJS.Signals | null): YtDlpError {
  const lines = stderr.replace(ANSI, "").split(/\r\n|\n|\r/).map((line) => line.trim()).filter(Boolean);
  const errors = lines.map((line) => ERROR_LINE.exec(line)).filter((match): match is RegExpExecArray => match !== null);

  const own = [...errors].reverse().find((match) => match[1]?.startsWith("cutroom:"));
  if (own) {
    const kind = own[1]!.slice("cutroom:".length) as DownloaderLineKind;
    const mapped = OWN_KINDS[kind] ?? { category: "unknown" as const };
    const site = siteOf([...errors].reverse().find((match) => match[1] && !match[1].startsWith("cutroom"))?.[1]);
    return { ...mapped, detail: sanitizeDetail(own[2]!), ...(site ? { site } : {}) };
  }

  const last = errors.at(-1);
  const site = siteOf(last?.[1]);
  // After an extractor name, yt-dlp names the item (`dQw4w9WgXcQ: …`).
  const message = last ? (last[1] ? last[2]!.replace(/^[\w-]{1,64}: /, "") : last[2]!) : "";
  const detail = sanitizeDetail(message || lines.at(-1) || (code !== null ? `yt-dlp exited with code ${code}` : `yt-dlp was stopped (${signal ?? "no exit code"})`));
  const result = (category: YtDlpErrorCategory, reason?: YtDlpErrorReason): YtDlpError =>
    ({ category, detail, ...(site ? { site } : {}), ...(reason ? { reason } : {}) });

  if (message) {
    // Matched without the footer: it would read every failure as an outdated yt-dlp.
    const meaning = withoutFooter(message);
    const rule = RULES.find((candidate) => candidate.pattern.test(meaning));
    // No usable format after YouTube's challenge failed (the warnings before
    // the error say so): a newer yt-dlp is the fix, not another format.
    if (rule?.category === "format" && CHALLENGE_FAILED.test(lines.filter((line) => line.startsWith("WARNING:")).join("\n"))) return result("outdated");
    if (rule) return result(rule.category, rule.reason);
  }
  // Failures that never reach a final ERROR line: a size cap is a notice, a
  // full disk can surface as a traceback.
  const text = lines.join("\n");
  if (/larger than max-filesize/i.test(text)) return result("too-large", "max-filesize");
  if (/no space left on device|\[Errno 28\]/i.test(text)) return result("too-large", "disk-full");
  if (/bad cpu type|invalid code signature|killed: 9/i.test(text)) return result("blocked", "os-blocked");
  if (!message) {
    if (signal === "SIGKILL" && !lines.length) return result("blocked", "os-blocked");
    if (signal === "SIGTERM" || signal === "SIGINT" || signal === "SIGHUP") return result("canceled");
    const fallback = lines.at(-1);
    if (fallback) for (const rule of RULES) if (rule.category === "network" && rule.pattern.test(fallback)) return result("network");
  }
  return result("unknown");
}
