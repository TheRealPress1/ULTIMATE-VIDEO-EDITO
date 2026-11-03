/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// What the bundled FFmpeg is built with, and what a build must be able to do.
// Shared by build-audio-tools.mjs (which asserts it after every build) and
// the desktop tests. Everything stays LGPL and offline: no GPL or nonfree
// parts, no network protocols. yt-dlp downloads on its own (--downloader
// native) and only hands FFmpeg local files to remux, so the additions over
// audio finishing are containers, parsers and bitstream filters:
//   - mpegts: HLS downloads (X, Vimeo, Twitch, some YouTube) arrive as MPEG-TS
//   - matroska/webm: VP9 and Opus streams, and merges into .webm/.mkv/.mka
//   - aac, mp3, ogg, flac: audio-only sources and their probes
//   - ipod: the .m4a writer yt-dlp uses for extracted AAC
//   - opus, ogg, mp3, flac: the writers for the other audio `-x` keeps as
//     it came; yt-dlp names the file after the codec (.opus, .ogg, .mp3,
//     .flac) and passes no `-f`, so FFmpeg picks the muxer by extension
//   - setts: yt-dlp's timestamp fixup, which looks for it by name
// and ffprobe, which yt-dlp prefers for probing codecs and durations.

import { execFileSync } from 'node:child_process';

export const REQUIRED = {
  demuxers: ['wav', 'mov', 'mpegts', 'matroska', 'aac', 'mp3', 'ogg', 'flac'],
  muxers: ['wav', 'null', 'mov', 'mp4', 'ipod', 'matroska', 'webm', 'opus', 'ogg', 'mp3', 'flac'],
  bsfs: ['aac_adtstoasc', 'vp9_superframe', 'setts'],
  decoders: ['aac', 'mp3float', 'mp3', 'opus', 'vorbis', 'flac', 'pcm_s16le', 'pcm_f32le'],
  parsers: ['h264', 'hevc', 'av1', 'vp9', 'aac', 'opus', 'vorbis', 'mpegaudio', 'flac'],
};

export const CONFIGURE_FLAGS = [
  '--disable-everything', '--disable-autodetect', '--disable-network', '--disable-doc',
  '--disable-debug', '--disable-gpl', '--disable-nonfree', '--disable-shared', '--enable-static',
  '--enable-small', '--enable-ffmpeg', '--disable-ffplay', '--enable-ffprobe',
  '--enable-avfilter', '--enable-swresample', '--enable-protocol=file,pipe',
  `--enable-demuxer=${REQUIRED.demuxers.join(',')}`,
  // matroska_audio is the .mka writer; `ffmpeg -muxers` lists it as a second "matroska".
  `--enable-muxer=${[...REQUIRED.muxers, 'matroska_audio'].join(',')}`,
  '--enable-decoder=pcm_f32le,pcm_f64le,pcm_s16le,pcm_s24le,pcm_s32le,pcm_s16be,pcm_s24be,pcm_s32be,aac,mp3float,mp3,opus,vorbis,flac',
  '--enable-encoder=pcm_f32le,pcm_s16le,aac',
  `--enable-parser=${REQUIRED.parsers.join(',')}`,
  `--enable-bsf=${REQUIRED.bsfs.join(',')}`,
  '--enable-filter=abuffer,abuffersink,aformat,anull,anullsink,aresample,asetpts,atrim,apad,volume,loudnorm,ebur128,dynaudnorm,afftdn,astats',
  '--extra-cflags=-mmacosx-version-min=13.0', '--extra-ldflags=-mmacosx-version-min=13.0',
];

/** Names in `ffmpeg -demuxers`/`-muxers` output; `mov,mp4,m4a` counts as each. */
export function parseFormats(output) {
  const names = new Set();
  let body = false;
  for (const line of output.split('\n')) {
    if (/^\s*-{2,}\s*$/.test(line)) { body = true; continue; }
    if (!body) continue;
    const [, name] = line.trim().split(/\s+/);
    if (name) for (const part of name.split(',')) names.add(part);
  }
  return names;
}

/** Names in a `-decoders`/`-encoders` listing (flags column, then the name). */
export const parseCodecs = parseFormats;

/** Names in `ffmpeg -bsfs` output. */
export function parseBsfs(output) {
  return new Set(output.split('\n').map((line) => line.trim()).filter((line) => line && !line.endsWith(':')));
}

/** What a build lacks, as `kind:name` entries; empty when it has everything. */
export function missingCapabilities(found) {
  const missing = [];
  for (const kind of ['demuxers', 'muxers', 'bsfs', 'decoders']) {
    for (const name of REQUIRED[kind]) if (!found[kind]?.has(name)) missing.push(`${kind.slice(0, -1)}:${name}`);
  }
  return missing;
}

/** Asks a built ffmpeg what it has. */
export function readCapabilities(binary, run = (file, args) => execFileSync(file, args, { encoding: 'utf8' })) {
  return {
    demuxers: parseFormats(run(binary, ['-hide_banner', '-demuxers'])),
    muxers: parseFormats(run(binary, ['-hide_banner', '-muxers'])),
    bsfs: parseBsfs(run(binary, ['-hide_banner', '-bsfs'])),
    decoders: parseCodecs(run(binary, ['-hide_banner', '-decoders'])),
  };
}

/** Throws when a build lacks something yt-dlp's remuxing or the audio tools need. */
export function assertCapabilities(binary, run) {
  const missing = missingCapabilities(readCapabilities(binary, run));
  if (missing.length) throw new Error(`Bundled FFmpeg is missing ${missing.join(', ')}.`);
}
