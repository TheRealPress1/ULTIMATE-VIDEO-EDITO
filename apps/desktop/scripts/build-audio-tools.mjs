/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile, copyFile, chmod, access } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'darwin') throw new Error('The bundled audio tools currently target macOS.');
const version = '8.1.3';
const sha256 = '7138d28c96d9d3e3af4ee3d8cad72741f8ffb40da90c1112235dea3ecd3178a3';
const sourceUrl = `https://ffmpeg.org/releases/ffmpeg-${version}.tar.xz`;
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(root, 'dist', 'audio-tools');
const cache = join(root, '..', '..', '.context', 'audio-build');
const archive = join(cache, `ffmpeg-${version}.tar.xz`);
const source = join(cache, `ffmpeg-${version}`);
const binary = join(output, 'ffmpeg');
const flags = [
  '--disable-everything', '--disable-autodetect', '--disable-network', '--disable-doc',
  '--disable-debug', '--disable-gpl', '--disable-nonfree', '--disable-shared', '--enable-static',
  '--enable-small', '--enable-ffmpeg', '--disable-ffplay', '--disable-ffprobe',
  '--enable-avfilter', '--enable-swresample', '--enable-protocol=file,pipe',
  '--enable-demuxer=wav,mov', '--enable-muxer=wav,null,mov,mp4',
  '--enable-decoder=pcm_f32le,pcm_f64le,pcm_s16le,pcm_s24le,pcm_s32le,pcm_s16be,pcm_s24be,pcm_s32be,aac',
  '--enable-encoder=pcm_f32le,pcm_s16le,aac', '--enable-parser=h264,hevc,av1,vp9,aac',
  '--enable-filter=abuffer,abuffersink,aformat,anull,anullsink,aresample,asetpts,atrim,apad,volume,loudnorm,ebur128,dynaudnorm,afftdn,astats',
  '--extra-cflags=-mmacosx-version-min=13.0', '--extra-ldflags=-mmacosx-version-min=13.0',
];
const configHash = createHash('sha256').update(JSON.stringify({ version, sha256, flags, arch: process.arch })).digest('hex');
await mkdir(output, { recursive: true }); await mkdir(cache, { recursive: true });
const existing = await readFile(join(output, 'runtime.json'), 'utf8').then(JSON.parse, () => null);
if (existing?.configHash === configHash && await access(binary).then(() => true, () => false)) {
  const digest = createHash('sha256').update(await readFile(binary)).digest('hex');
  if (digest === existing.binarySha256) { process.stdout.write('Bundled audio tools are current.\n'); process.exit(0); }
}
let bytes = await readFile(archive).catch(() => null);
if (!bytes || createHash('sha256').update(bytes).digest('hex') !== sha256) {
  const response = await fetch(sourceUrl);
  if (!response.ok) throw new Error(`FFmpeg source download failed: ${response.status}`);
  bytes = Buffer.from(await response.arrayBuffer());
  if (createHash('sha256').update(bytes).digest('hex') !== sha256) throw new Error('FFmpeg source checksum does not match the pinned official release.');
  await writeFile(archive, bytes);
}
execFileSync('tar', ['-xJf', archive, '-C', cache], { stdio: 'inherit' });
execFileSync('./configure', flags, { cwd: source, stdio: 'inherit' });
execFileSync('make', [`-j${Math.min(8, availableParallelism())}`, 'ffmpeg'], { cwd: source, stdio: 'inherit' });
await copyFile(join(source, 'ffmpeg'), binary); await chmod(binary, 0o755);
execFileSync('strip', ['-x', binary], { stdio: 'inherit' });
const links = execFileSync('otool', ['-L', binary], { encoding: 'utf8' });
if (links.split('\n').slice(1).some((line) => line.trim() && !/^\s*\/(?:usr\/lib|System\/Library)\//.test(line))) throw new Error('Bundled FFmpeg unexpectedly links a non-system library.');
const license = execFileSync(binary, ['-hide_banner', '-L'], { encoding: 'utf8' });
if (!/GNU\s+Lesser\s+General\s+Public\s+License/.test(license)) throw new Error('Audio tools must remain an LGPL-only build.');
// Corresponding unmodified source, licenses and exact recipe travel with the
// executable; rebuilding does not depend on Homebrew or a downloaded binary.
await copyFile(archive, join(output, `ffmpeg-${version}-source.tar.xz`));
await copyFile(join(source, 'COPYING.LGPLv2.1'), join(output, 'COPYING.LGPLv2.1'));
await copyFile(join(source, 'LICENSE.md'), join(output, 'FFmpeg-LICENSE.md'));
await copyFile(fileURLToPath(import.meta.url), join(output, 'build-audio-tools.mjs'));
await writeFile(join(output, 'NOTICE.txt'), `UVE uses FFmpeg ${version}, licensed under GNU LGPL version 2.1 or later.\nSource: ${sourceUrl}\nSource SHA-256: ${sha256}\nThe complete corresponding source archive, license and build script are included in this folder.\nNo GPL or nonfree components are enabled. FFmpeg runs as a separate process.\nConfigure arguments: ${JSON.stringify(flags)}\n`);
const binarySha256 = createHash('sha256').update(await readFile(binary)).digest('hex');
await writeFile(join(output, 'runtime.json'), JSON.stringify({ version, platform: process.platform, arch: process.arch, sourceUrl, sourceSha256: sha256, binarySha256, configHash, flags }, null, 2) + '\n');
process.stdout.write(`Built local audio tools: ${binary}\n`);
