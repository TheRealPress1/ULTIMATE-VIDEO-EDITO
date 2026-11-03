/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CONFIGURE_FLAGS, REQUIRED, missingCapabilities, parseBsfs, parseFormats, readCapabilities } from '../scripts/audio-tools-capabilities.mjs';
import { resolveAudioToolsDir, resolveFfprobePath } from './audio-tools';

const tools = resolve('dist/audio-tools');
const ffmpeg = join(tools, 'ffmpeg');
const ffprobe = join(tools, 'ffprobe');
// Builds from before the downloader have no ffprobe; these checks wait for the rebuild.
const rebuilt = process.platform === 'darwin' && existsSync(ffmpeg) && existsSync(ffprobe);

describe('the bundled FFmpeg recipe', () => {
  it('stays LGPL and offline', () => {
    expect(CONFIGURE_FLAGS).toEqual(expect.arrayContaining(['--disable-network', '--disable-gpl', '--disable-nonfree', '--disable-autodetect', '--enable-ffprobe', '--enable-protocol=file,pipe']));
    expect(CONFIGURE_FLAGS.some((flag) => /^--enable-(?:gpl|nonfree|version3|network|libx26[45])/.test(flag))).toBe(false);
    expect(CONFIGURE_FLAGS.filter((flag) => flag.startsWith('--enable-protocol'))).toEqual(['--enable-protocol=file,pipe']);
  });

  it('enables everything yt-dlp remuxes with', () => {
    const enabled = (kind: string) => CONFIGURE_FLAGS.find((flag) => flag.startsWith(`--enable-${kind}=`))?.split('=')[1]?.split(',') ?? [];
    expect(enabled('demuxer')).toEqual(expect.arrayContaining(['mpegts', 'matroska', 'mp3', 'ogg', 'mov', 'aac']));
    expect(enabled('muxer')).toEqual(expect.arrayContaining(['ipod', 'mp4', 'mov', 'webm']));
    // `-x` keeps non-AAC sound as it came, in a file named for its codec, and lets FFmpeg pick the muxer from that name.
    expect(enabled('muxer')).toEqual(expect.arrayContaining(['opus', 'ogg', 'mp3', 'flac']));
    expect(REQUIRED.muxers).toEqual(expect.arrayContaining(['opus', 'ogg', 'mp3', 'flac']));
    for (const name of REQUIRED.muxers) expect(enabled('muxer')).toContain(name);
    expect(enabled('bsf')).toEqual(expect.arrayContaining(['setts', 'aac_adtstoasc', 'vp9_superframe']));
    for (const name of REQUIRED.decoders) expect(enabled('decoder')).toContain(name);
    for (const name of REQUIRED.parsers) expect(enabled('parser')).toContain(name);
  });

  it('reads what a build lists', () => {
    const demuxers = parseFormats('Formats:\n D.. = Demuxing supported\n .E. = Muxing supported\n ---\n D   mov,mp4,m4a,3gp,3g2,mj2  \n D   wav              \n');
    expect([...demuxers]).toEqual(['mov', 'mp4', 'm4a', '3gp', '3g2', 'mj2', 'wav']);
    expect([...parseBsfs('Bitstream filters:\naac_adtstoasc\nvp9_superframe\n\n')]).toEqual(['aac_adtstoasc', 'vp9_superframe']);
    const decoders = parseFormats('Decoders:\n A..... = Audio\n ------\n A....D aac                  \n A....D opus\n');
    expect([...decoders]).toEqual(['aac', 'opus']);
    expect(missingCapabilities({ demuxers, muxers: new Set(), bsfs: new Set(['setts']), decoders })).toEqual(expect.arrayContaining(['demuxer:mpegts', 'muxer:ipod', 'bsf:aac_adtstoasc', 'decoder:mp3']));
  });

  it('puts ffprobe beside ffmpeg', () => {
    expect(resolveFfprobePath('/app')).toBe(join(resolveAudioToolsDir('/app'), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe'));
  });
});

/** A minimal MPEG-TS stream carrying ADTS AAC frames, the shape HLS segments arrive in. */
function mpegTs(adts: Buffer, sampleRate: number): Buffer {
  const crc32 = (bytes: number[]) => {
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc ^= byte << 24;
      for (let bit = 0; bit < 8; bit++) crc = crc & 0x80000000 ? ((crc << 1) ^ 0x04c11db7) >>> 0 : (crc << 1) >>> 0;
    }
    return [crc >>> 24, (crc >>> 16) & 255, (crc >>> 8) & 255, crc & 255];
  };
  const counters = new Map<number, number>();
  const packets: Buffer[] = [];
  const emit = (pid: number, payload: Buffer, start: boolean) => {
    for (let offset = 0, first = true; offset < payload.length || first; first = false) {
      const counter = counters.get(pid) ?? 0;
      counters.set(pid, (counter + 1) & 15);
      const chunk = payload.subarray(offset, offset + 184);
      offset += chunk.length;
      const head = [0x47, ((start && first ? 0x40 : 0) | (pid >> 8)) & 0x5f, pid & 255];
      if (chunk.length === 184) packets.push(Buffer.from([...head, 0x10 | counter, ...chunk]));
      else {
        const fill = 183 - chunk.length;
        const adaptation = fill === 0 ? [0] : [fill, 0x00, ...Array<number>(fill - 1).fill(0xff)];
        packets.push(Buffer.from([...head, 0x30 | counter, ...adaptation, ...chunk]));
      }
    }
  };
  const section = (body: number[]) => {
    const withCrc = [...body, ...crc32(body)];
    return Buffer.from([0, ...withCrc]);
  };
  const pat = [0x00, 0xb0, 13, 0x00, 0x01, 0xc1, 0, 0, 0x00, 0x01, 0xf0, 0x00];
  const pmt = [0x02, 0xb0, 18, 0x00, 0x01, 0xc1, 0, 0, 0xff, 0xff, 0xf0, 0x00, 0x0f, 0xe1, 0x00, 0xf0, 0x00];
  emit(0, section(pat), true);
  emit(0x1000, section(pmt), true);
  let pts = 90_000;
  for (let offset = 0; offset + 7 <= adts.length;) {
    const length = ((adts[offset + 3]! & 3) << 11) | (adts[offset + 4]! << 3) | (adts[offset + 5]! >> 5);
    if (adts[offset] !== 0xff || length < 7) break;
    const frame = adts.subarray(offset, offset + length);
    offset += length;
    const stamp = [0x21 | ((pts >>> 29) & 0x0e), (pts >>> 22) & 255, ((pts >>> 14) & 0xfe) | 1, (pts >>> 7) & 255, ((pts << 1) & 0xfe) | 1];
    const header = [0, 0, 1, 0xc0, ((frame.length + 8) >> 8) & 255, (frame.length + 8) & 255, 0x80, 0x80, 5, ...stamp];
    emit(0x100, Buffer.concat([Buffer.from(header), frame]), true);
    pts += Math.round((1024 * 90_000) / sampleRate);
  }
  return Buffer.concat(packets);
}

/** The 44-byte header of a mono 16-bit PCM WAV. */
function wavHeader(length: number, sampleRate: number): Buffer {
  const wav = Buffer.alloc(44);
  wav.write('RIFF'); wav.writeUInt32LE(36 + length, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24); wav.writeUInt32LE(sampleRate * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(length, 40);
  return wav;
}

/** A minimal Matroska file holding 16-bit PCM, standing in for a WebM download. */
function matroska(pcm: Buffer, sampleRate: number): Buffer {
  const size = (length: number) => { const out = Buffer.alloc(8); out[0] = 1; out.writeUIntBE(length, 2, 6); return out; };
  const element = (id: number, body: Buffer) => { const tag = Buffer.from(id.toString(16).padStart(2, '0').replace(/^(.(..)*)$/, '0$1'), 'hex'); return Buffer.concat([tag, size(body.length), body]); };
  const uint = (id: number, value: number) => element(id, Buffer.from([value]));
  const text = (id: number, value: string) => element(id, Buffer.from(value));
  const float = (id: number, value: number) => { const bytes = Buffer.alloc(8); bytes.writeDoubleBE(value); return element(id, bytes); };
  const header = element(0x1a45dfa3, Buffer.concat([uint(0x4286, 1), uint(0x42f7, 1), uint(0x42f2, 4), uint(0x42f3, 8), text(0x4282, 'matroska'), uint(0x4287, 4), uint(0x4285, 2)]));
  const info = element(0x1549a966, Buffer.concat([element(0x2ad7b1, Buffer.from([0x0f, 0x42, 0x40])), text(0x4d80, 'test'), text(0x5741, 'test')]));
  const track = element(0xae, Buffer.concat([uint(0xd7, 1), uint(0x73c5, 1), uint(0x83, 2), text(0x86, 'A_PCM/INT/LIT'), element(0xe1, Buffer.concat([float(0xb5, sampleRate), uint(0x9f, 1), uint(0x6264, 16)]))]));
  const block = element(0xa3, Buffer.concat([Buffer.from([0x81, 0, 0, 0x80]), pcm]));
  const cluster = element(0x1f43b675, Buffer.concat([uint(0xe7, 0), block]));
  return Buffer.concat([header, element(0x18538067, Buffer.concat([info, element(0x1654ae6b, track), cluster]))]);
}

describe.skipIf(!rebuilt)('the rebuilt FFmpeg', () => {
  let dir: string;
  const rate = 44_100;
  const pcm = Buffer.alloc(rate);
  for (let index = 0; index < pcm.length / 2; index++) pcm.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * 440 * index) / rate)), index * 2);
  const probe = (path: string) => JSON.parse(execFileSync(ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', path], { encoding: 'utf8' })) as { streams: Array<{ codec_name: string }>; format: { format_name: string; duration?: string } };
  beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), 'uve-ffmpeg-caps-')); });
  afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

  it('has every demuxer, muxer, bitstream filter and decoder yt-dlp needs', () => {
    expect(missingCapabilities(readCapabilities(ffmpeg))).toEqual([]);
    expect(execFileSync(ffprobe, ['-hide_banner', '-L'], { encoding: 'utf8' })).toMatch(/GNU\s+Lesser\s+General\s+Public\s+License/);
  });

  it('remuxes an HLS-style MPEG-TS to .m4a without re-encoding, then shifts its timestamps', async () => {
    await writeFile(join(dir, 'tone.wav'), Buffer.concat([wavHeader(pcm.length, rate), pcm]));
    // macOS's own encoder writes the ADTS stream an HLS segment carries.
    execFileSync('/usr/bin/afconvert', ['-f', 'adts', '-d', 'aac', join(dir, 'tone.wav'), join(dir, 'tone.aac')]);
    await writeFile(join(dir, 'segment.ts'), mpegTs(await readFile(join(dir, 'tone.aac')), rate));
    expect(probe(join(dir, 'segment.ts')).format.format_name).toBe('mpegts');
    execFileSync(ffmpeg, ['-v', 'error', '-i', join(dir, 'segment.ts'), '-map', '0', '-c', 'copy', '-f', 'ipod', join(dir, 'audio.m4a')]);
    const audio = probe(join(dir, 'audio.m4a'));
    expect(audio.streams.map((stream) => stream.codec_name)).toEqual(['aac']);
    expect(Number(audio.format.duration)).toBeGreaterThan(0.3);
    execFileSync(ffmpeg, ['-v', 'error', '-i', join(dir, 'audio.m4a'), '-c', 'copy', '-bsf:a', 'setts=ts=PTS-STARTPTS', '-f', 'mp4', join(dir, 'fixed.m4a')]);
    expect(probe(join(dir, 'fixed.m4a')).streams[0]?.codec_name).toBe('aac');
  });

  it('copies sound out of Matroska into a file named for its codec, the way `-x` does', async () => {
    // Opus, Vorbis and MP3 need encoders this build lacks to make a sample; FLAC shows the same path.
    await writeFile(join(dir, 'source.wav'), Buffer.concat([wavHeader(pcm.length, rate), pcm]));
    execFileSync('/usr/bin/afconvert', ['-f', 'flac', '-d', 'flac', join(dir, 'source.wav'), join(dir, 'source.flac')]);
    execFileSync(ffmpeg, ['-v', 'error', '-i', join(dir, 'source.flac'), '-c', 'copy', join(dir, 'source.mka')]);
    for (const [name, format] of [['tone.flac', 'flac'], ['tone.ogg', 'ogg']] as const) {
      // No `-f`: the extension chooses the muxer.
      execFileSync(ffmpeg, ['-v', 'error', '-i', join(dir, 'source.mka'), '-vn', '-acodec', 'copy', join(dir, name)]);
      const extracted = probe(join(dir, name));
      expect(extracted.format.format_name).toBe(format);
      expect(extracted.streams.map((stream) => stream.codec_name)).toEqual(['flac']);
    }
  });

  it('reads Matroska', async () => {
    await writeFile(join(dir, 'tone.mka'), matroska(pcm, rate));
    expect(probe(join(dir, 'tone.mka')).format.format_name).toBe('matroska,webm');
    execFileSync(ffmpeg, ['-v', 'error', '-i', join(dir, 'tone.mka'), '-c', 'copy', '-f', 'wav', join(dir, 'from-mka.wav')]);
    expect(probe(join(dir, 'from-mka.wav')).streams[0]?.codec_name).toBe('pcm_s16le');
  });
});
