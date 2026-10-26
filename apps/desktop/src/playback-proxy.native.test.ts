import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

// Optional native acceptance test: UVE_NATIVE_PROXY_TESTS=1 npx vitest run
// src/playback-proxy.native.test.ts. FFmpeg is only a test fixture generator and
// independent verifier; the shipped worker has no external runtime dependency.
const runNative = process.platform === 'darwin' && process.env.UVE_NATIVE_PROXY_TESTS === '1';
const ffmpeg = process.env.UVE_TEST_FFMPEG ?? 'ffmpeg';
const ffprobe = process.env.UVE_TEST_FFPROBE ?? 'ffprobe';
const run = (file: string, args: string[]) => execFileSync(file, args, { maxBuffer: 16 * 1024 * 1024, timeout: 60_000 });
type Probe = { streams: { codec_type: string; width: number; height: number; duration: string; start_time: string; side_data_list?: unknown[] }[]; packets: { pts_time: string }[] };
function probe(path: string): Probe {
  return JSON.parse(run(ffprobe, ['-v', 'error', '-show_streams', '-show_packets', '-of', 'json', path]).toString()) as Probe;
}
function videoPTS(path: string): number[] {
  const result = JSON.parse(run(ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts_time', '-of', 'json', path]).toString()) as Probe;
  return result.packets.map(packet => Number(packet.pts_time)).sort((a, b) => a - b);
}

describe.skipIf(!runNative)('real native playback derivatives', () => {
  let folder: string, worker: string, source: string, derivative: string;
  beforeAll(() => {
    folder = mkdtempSync(join(tmpdir(), 'uve-native-proxy-'));
    worker = join(folder, 'playback-proxy');
    run('swiftc', ['-parse-as-library', '-O', resolve('src/native/playback-proxy.swift'), '-o', worker,
      '-framework', 'Foundation', '-framework', 'AVFoundation', '-framework', 'CoreImage', '-framework', 'CoreVideo', '-framework', 'CoreMedia', '-framework', 'VideoToolbox']);
    const landscape = join(folder, 'landscape.mp4');
    source = join(folder, 'rotated-offset-vfr-audio.mp4'); derivative = join(folder, 'proxy.mp4');
    run(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=3840x2160:r=30:d=1.2', '-f', 'lavfi', '-i', 'sine=frequency=500:duration=1.2',
      '-vf', "select='not(mod(n,3))'+'not(mod(n,7))'", '-fps_mode', 'vfr', '-c:v', 'h264_videotoolbox', '-b:v', '6M',
      '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-c:a', 'aac', '-video_track_timescale', '60000', landscape]);
    run(ffmpeg, ['-v', 'error', '-display_rotation', '90', '-i', landscape, '-map', '0', '-c', 'copy', '-output_ts_offset', '2', source]);
  }, 60_000);
  afterAll(() => { if (folder) rmSync(folder, { recursive: true, force: true }); });

  it('preserves every VFR timestamp after a leading edit, removes proxy audio and leaves the original intact', () => {
    const before = createHash('sha256').update(readFileSync(source)).digest('hex');
    const original = probe(source), firstPTS = Math.min(...videoPTS(source));
    expect(firstPTS).toBe(2);
    expect(original.streams.some(stream => stream.codec_type === 'audio')).toBe(true);
    const lines = run(worker, [source, derivative, '2', '1.2']).toString().trim().split('\n');
    const result = JSON.parse(lines.at(-1)!);
    expect(result).toMatchObject({ type: 'done', sourceStart: 2, proxyStart: 0, width: 720, height: 1280, frames: 16 });
    expect(result.duration).toBeCloseTo(1.2, 4);
    const output = probe(derivative);
    expect(output.streams.map(stream => stream.codec_type)).toEqual(['video']);
    expect(output.streams[0]).toMatchObject({ width: 720, height: 1280 });
    const originalPTS = videoPTS(source), proxyPTS = videoPTS(derivative);
    expect(proxyPTS).toHaveLength(originalPTS.length);
    expect(new Set(originalPTS.slice(1).map((pts, index) => (pts - originalPTS[index]!).toFixed(4))).size).toBeGreaterThan(1);
    originalPTS.forEach((pts, index) => expect(proxyPTS[index]).toBeCloseTo(pts - firstPTS, 5));
    expect(Number(output.streams[0]!.duration)).toBeCloseTo(1.2, 3);
    expect(createHash('sha256').update(readFileSync(source)).digest('hex')).toBe(before);
  }, 30_000);

  it('bakes the actual portrait orientation into pixels, not just swapped dimensions', () => {
    const pixels = (path: string, scale: boolean) => run(ffmpeg, ['-v', 'error', '-i', path, ...(scale ? ['-vf', 'scale=720:1280'] : []), '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1']);
    const original = pixels(source, true), proxy = pixels(derivative, false);
    expect(proxy.length).toBe(720 * 1280 * 3);
    let normal = 0, upsideDown = 0, count = 0;
    for (let y = 0; y < 1280; y += 5) for (let x = 0; x < 720; x += 5) for (let color = 0; color < 3; color++) {
      const index = (y * 720 + x) * 3 + color;
      normal += Math.abs(original[index]! - proxy[index]!);
      upsideDown += Math.abs(original[index]! - proxy[((1279 - y) * 720 + 719 - x) * 3 + color]!); count++;
    }
    expect(normal / count).toBeLessThan(10);
    expect(upsideDown / count).toBeGreaterThan(100);
  }, 30_000);
});
