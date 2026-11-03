#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Re-checks the bundled music and sound-effect catalogs against the live
// sources: every YouTube entry with yt-dlp's metadata (still public, not
// live, the same length), every MyInstants page and file, every Commons and
// Freesound file. With --download it also fetches each source and measures
// its exact length with ffprobe (and its loudness with ffmpeg, given
// --ffmpeg), as the curation did. It only reports: a person reviews any
// drift, listens, and edits the JSON by hand. The offline checks of the same
// files run in the unit tests (src/audio-catalog-defaults.test.ts).
//
//   node apps/desktop/scripts/verify-audio-catalogs.mjs --yt-dlp <path> [--kind music|sfx] [--ids a,b] [--download] [--ffprobe <path>] [--ffmpeg <path>] [--json]

import { execFile } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_DOCS = resolve(here, '..', '..', '..', 'docs');
/** yt-dlp reports whole seconds; a decoded file differs from that by up to a second and a half. */
export const METADATA_SLACK = 1.5;
/** A measured file against the catalog's own measurement of it. */
export const PROBE_SLACK = 0.25;
/** Loudness drift that suggests a different master or upload. */
export const LOUDNESS_SLACK = 1.5;
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';

export function parseArgs(argv) {
  const options = { kinds: ['music', 'sfx'], ids: null, ytDlp: process.env.YT_DLP || 'yt-dlp', ffprobe: process.env.FFPROBE || 'ffprobe', ffmpeg: process.env.FFMPEG || null, download: false, json: false, docsDir: DEFAULT_DOCS };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const value = () => {
      const next = argv[++index];
      if (next === undefined) throw new Error(`${arg} needs a value.`);
      return next;
    };
    if (arg === '--kind') options.kinds = [value()];
    else if (arg === '--ids') options.ids = new Set(value().split(',').map((id) => id.trim()).filter(Boolean));
    else if (arg === '--yt-dlp') options.ytDlp = value();
    else if (arg === '--ffprobe') options.ffprobe = value();
    else if (arg === '--ffmpeg') options.ffmpeg = value();
    else if (arg === '--docs') options.docsDir = resolve(value());
    else if (arg === '--download') options.download = true;
    else if (arg === '--json') options.json = true;
    else throw new Error(`Unknown option ${arg}.`);
  }
  for (const kind of options.kinds) if (kind !== 'music' && kind !== 'sfx') throw new Error(`--kind is music or sfx, not ${kind}.`);
  return options;
}

const round = (value, places = 2) => Math.round(value * 10 ** places) / 10 ** places;

/** Where an entry's timing must fit: the problems with a source this long. */
export function timingAgainst(entry, duration) {
  const problems = [];
  if (entry.sourceRange && entry.sourceRange.end > duration + PROBE_SLACK) problems.push(`sourceRange ends at ${entry.sourceRange.end} s, past the source's ${round(duration)} s`);
  for (const section of entry.sections ?? []) if (section.end > duration + PROBE_SLACK) problems.push(`the ${section.label} section ends past the source`);
  if (entry.hitAt !== undefined && entry.hitAt > duration) problems.push(`hitAt ${entry.hitAt} s is past the source`);
  return problems;
}

/** What yt-dlp's metadata says about a YouTube entry: failures (gone, live, a different length) and notes (who uploaded it). */
export function checkMetadata(entry, info) {
  const fail = [];
  const notes = [`"${info.title ?? '?'}" by ${info.channel ?? info.uploader ?? '?'}`];
  if (info.availability && !['public', 'unlisted'].includes(info.availability)) fail.push(`it is ${info.availability} now`);
  if (info.live_status && !['not_live', 'was_live', 'post_live'].includes(info.live_status)) fail.push(`it is a live stream (${info.live_status})`);
  if (typeof info.duration !== 'number') fail.push('yt-dlp reports no duration');
  else {
    const drift = info.duration - entry.durationSeconds;
    if (Math.abs(drift) > METADATA_SLACK) fail.push(`its length is ${info.duration} s, not ${entry.durationSeconds} s (${drift > 0 ? '+' : ''}${round(drift)} s)`);
    fail.push(...timingAgainst(entry, info.duration));
  }
  return { fail, notes };
}

/** A downloaded file against the catalog's measurements of it. */
export function checkMeasured(entry, measured) {
  const fail = [];
  if (Math.abs(measured.duration - entry.durationSeconds) > PROBE_SLACK) fail.push(`the file runs ${round(measured.duration, 3)} s, not ${entry.durationSeconds} s`);
  fail.push(...timingAgainst(entry, measured.duration));
  if (measured.loudnessLufs !== undefined && entry.loudnessLufs !== undefined && Math.abs(measured.loudnessLufs - entry.loudnessLufs) > LOUDNESS_SLACK) {
    fail.push(`its range measures ${measured.loudnessLufs} LUFS, not ${entry.loudnessLufs} LUFS`);
  }
  return fail;
}

function run(file, args, timeout = 180_000) {
  return new Promise((done) => {
    execFile(file, args, { timeout, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => done({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout, stderr: String(stderr || (error ? error.message : '')) }));
  });
}

async function probeDuration(ffprobe, path) {
  const result = await run(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', path]);
  const duration = Number(result.stdout.trim());
  if (result.code !== 0 || !Number.isFinite(duration)) throw new Error(`ffprobe couldn't read ${path}: ${result.stderr.trim().slice(-200)}`);
  return duration;
}

async function measureLoudness(ffmpeg, path, range) {
  const args = ['-nostats', '-hide_banner', ...(range ? ['-ss', String(range.start), '-to', String(range.end)] : []), '-i', path, '-af', 'ebur128', '-f', 'null', '-'];
  const result = await run(ffmpeg, args);
  const summary = result.stderr.slice(result.stderr.lastIndexOf('Summary:'));
  const match = /I:\s*(-?[\d.]+) LUFS/.exec(summary);
  return match ? Number(match[1]) : undefined;
}

/** The source a catalog's file URL or MyInstants page serves: its HTTP status, type and, for a page, the sound it plays. */
async function fetchSource(fetchImpl, entry) {
  const headers = { 'user-agent': BROWSER_UA, accept: '*/*' };
  if (entry.id.startsWith('myinstants:')) {
    const page = await fetchImpl(entry.sourceUrl, { headers });
    if (!page.ok) return { fail: [`its page answers ${page.status}`] };
    const html = await page.text();
    const audio = /property="og:audio" content="([^"]+)"/.exec(html)?.[1] ?? /play\('([^']+\.mp3)'/.exec(html)?.[1];
    if (!audio) return { fail: ["its page doesn't name a sound any more"] };
    return { file: new URL(audio, entry.sourceUrl).href, notes: [`plays ${new URL(audio, entry.sourceUrl).pathname}`] };
  }
  return { file: entry.sourceUrl, notes: [] };
}

/** Checks one entry. `deps` carries the yt-dlp runner, fetch and the measuring tools, so tests can stand them in. */
export async function verifyEntry(entry, kind, deps) {
  const result = { id: entry.id, kind, title: entry.title, status: 'ok', problems: [], notes: [] };
  const finish = (fail = [], notes = []) => {
    result.problems.push(...fail);
    result.notes.push(...notes);
    result.status = result.problems.length ? 'fail' : 'ok';
    return result;
  };
  try {
    if (entry.id.startsWith('youtube:')) {
      const meta = await deps.ytDlp(['--ignore-config', '--no-warnings', '-J', '--skip-download', '--no-playlist', entry.sourceUrl]);
      if (meta.code !== 0) return finish([`yt-dlp failed: ${meta.stderr.trim().split('\n').at(-1) || `exit ${meta.code}`}`]);
      const checked = checkMetadata(entry, JSON.parse(meta.stdout));
      if (checked.fail.length || !deps.download) return finish(checked.fail, checked.notes);
      const dir = await mkdtemp(join(tmpdir(), 'verify-audio-'));
      try {
        const got = await deps.ytDlp(['--ignore-config', '--no-warnings', '-q', '-f', 'bestaudio[ext=m4a]/bestaudio', '-o', join(dir, '%(id)s.%(ext)s'), entry.sourceUrl]);
        if (got.code !== 0) return finish([`the download failed: ${got.stderr.trim().split('\n').at(-1)}`], checked.notes);
        const [name] = await readdir(dir);
        return finish(checkMeasured(entry, await deps.measure(join(dir, name), entry)), checked.notes);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
    const source = await fetchSource(deps.fetch, entry);
    if (source.fail) return finish(source.fail);
    const response = await deps.fetch(source.file, { headers: { 'user-agent': BROWSER_UA, accept: 'audio/*,*/*' } });
    if (!response.ok) return finish([`its file answers ${response.status}`], source.notes);
    const type = response.headers.get('content-type') ?? '';
    if (!/^(audio\/|application\/ogg|application\/octet-stream)/.test(type)) return finish([`its file is ${type || 'of no declared type'}, not audio`], source.notes);
    if (!deps.download) {
      await response.body?.cancel().catch(() => {});
      return finish([], source.notes);
    }
    const dir = await mkdtemp(join(tmpdir(), 'verify-audio-'));
    try {
      const path = join(dir, 'source');
      await writeFile(path, Buffer.from(await response.arrayBuffer()));
      return finish(checkMeasured(entry, await deps.measure(path, entry)), source.notes);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  } catch (error) {
    return finish([error instanceof Error ? error.message : String(error)]);
  }
}

/** Checks every entry of the asked kinds, a few at a time. */
export async function verifyCatalogs(options, deps) {
  const results = [];
  for (const kind of options.kinds) {
    const catalog = JSON.parse(await readFile(join(options.docsDir, 'reference', 'catalogs', `${kind}.json`), 'utf8'));
    const entries = catalog.entries.filter((entry) => !options.ids || options.ids.has(entry.id));
    for (let start = 0; start < entries.length; start += 3) {
      results.push(...(await Promise.all(entries.slice(start, start + 3).map((entry) => verifyEntry(entry, kind, deps)))));
    }
  }
  return results;
}

/** A plain-text report: one line per entry, problems indented under it, a summary last. */
export function formatReport(results) {
  const lines = [];
  for (const result of results) {
    lines.push(`${result.status === 'ok' ? 'ok  ' : 'FAIL'} ${result.kind.padEnd(5)} ${result.id}  ${result.title}${result.notes.length ? `  (${result.notes.join('; ')})` : ''}`);
    for (const problem of result.problems) lines.push(`       - ${problem}`);
  }
  const failed = results.filter((result) => result.status !== 'ok').length;
  lines.push('', `${results.length - failed} of ${results.length} entries verified${failed ? `; ${failed} need a look (edit the catalog by hand after listening)` : ''}.`);
  return lines.join('\n');
}

export function defaultDeps(options) {
  return {
    ytDlp: (args) => run(options.ytDlp, args, 600_000),
    fetch: (url, init) => fetch(url, { ...init, redirect: 'follow', signal: AbortSignal.timeout(60_000) }),
    download: options.download,
    measure: async (path, entry) => {
      const duration = await probeDuration(options.ffprobe, path);
      const loudnessLufs = options.ffmpeg && entry.loudnessLufs !== undefined ? await measureLoudness(options.ffmpeg, path, entry.sourceRange) : undefined;
      return { duration, ...(loudnessLufs !== undefined ? { loudnessLufs } : {}) };
    },
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const results = await verifyCatalogs(options, defaultDeps(options));
  process.stdout.write((options.json ? JSON.stringify(results, null, 2) : formatReport(results)) + '\n');
  process.exitCode = results.some((result) => result.status !== 'ok') ? 1 : 0;
}

/** Whether node was started with this file. Both paths are resolved through symlinks, since node keeps `argv[1]` as typed. */
function startedDirectly() {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (startedDirectly()) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  });
}
