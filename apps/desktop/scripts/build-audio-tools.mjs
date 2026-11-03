/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile, copyFile, chmod, access } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIGURE_FLAGS, assertCapabilities } from './audio-tools-capabilities.mjs';

if (process.platform !== 'darwin') throw new Error('The bundled audio tools currently target macOS.');
const version = '8.1.3';
const sha256 = '7138d28c96d9d3e3af4ee3d8cad72741f8ffb40da90c1112235dea3ecd3178a3';
const sourceUrl = `https://ffmpeg.org/releases/ffmpeg-${version}.tar.xz`;
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(root, 'dist', 'audio-tools');
const cache = join(root, '..', '..', '.context', 'audio-build');
const archive = join(cache, `ffmpeg-${version}.tar.xz`);
const source = join(cache, `ffmpeg-${version}`);
// ffmpeg and ffprobe come from one configure, so they read the same formats.
const tools = ['ffmpeg', 'ffprobe'];
const binaries = Object.fromEntries(tools.map((tool) => [tool, join(output, tool)]));
const binary = binaries.ffmpeg;
// The flags (and what a build must be able to do) live beside this script,
// shared with the tests; see audio-tools-capabilities.mjs.
const flags = CONFIGURE_FLAGS;
const configHash = createHash('sha256').update(JSON.stringify({ version, sha256, flags, arch: process.arch })).digest('hex');
const digestOf = async (path) => createHash('sha256').update(await readFile(path)).digest('hex');
await mkdir(output, { recursive: true }); await mkdir(cache, { recursive: true });
const existing = await readFile(join(output, 'runtime.json'), 'utf8').then(JSON.parse, () => null);
if (existing?.configHash === configHash && await Promise.all(tools.map((tool) => access(binaries[tool]).then(() => true, () => false))).then((found) => found.every(Boolean))) {
  if (await digestOf(binary) === existing.binarySha256 && await digestOf(binaries.ffprobe) === existing.ffprobeSha256) { process.stdout.write('Bundled audio tools are current.\n'); process.exit(0); }
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
execFileSync('make', [`-j${Math.min(8, availableParallelism())}`, ...tools], { cwd: source, stdio: 'inherit' });
for (const tool of tools) {
  const path = binaries[tool];
  await copyFile(join(source, tool), path); await chmod(path, 0o755);
  execFileSync('strip', ['-x', path], { stdio: 'inherit' });
  const links = execFileSync('otool', ['-L', path], { encoding: 'utf8' });
  if (links.split('\n').slice(1).some((line) => line.trim() && !/^\s*\/(?:usr\/lib|System\/Library)\//.test(line))) throw new Error(`Bundled ${tool} unexpectedly links a non-system library.`);
  const license = execFileSync(path, ['-hide_banner', '-L'], { encoding: 'utf8' });
  if (!/GNU\s+Lesser\s+General\s+Public\s+License/.test(license)) throw new Error('Audio tools must remain an LGPL-only build.');
  const configuration = execFileSync(path, ['-hide_banner', '-buildconf'], { encoding: 'utf8' });
  if (/--enable-(?:gpl|nonfree|version3)\b/.test(configuration) || !/--disable-network\b/.test(configuration)) throw new Error(`Bundled ${tool} must stay LGPL-only and offline.`);
}
// Everything yt-dlp's remuxing relies on, checked on the binary itself.
assertCapabilities(binary);
// Corresponding unmodified source, licenses and exact recipe travel with the
// executable; rebuilding does not depend on Homebrew or a downloaded binary.
await copyFile(archive, join(output, `ffmpeg-${version}-source.tar.xz`));
await copyFile(join(source, 'COPYING.LGPLv2.1'), join(output, 'COPYING.LGPLv2.1'));
await copyFile(join(source, 'LICENSE.md'), join(output, 'FFmpeg-LICENSE.md'));
await copyFile(fileURLToPath(import.meta.url), join(output, 'build-audio-tools.mjs'));
await copyFile(fileURLToPath(new URL('./audio-tools-capabilities.mjs', import.meta.url)), join(output, 'audio-tools-capabilities.mjs'));
await writeFile(join(output, 'NOTICE.txt'), `UVE uses FFmpeg ${version} (the ffmpeg and ffprobe programs), licensed under GNU LGPL version 2.1 or later.\nSource: ${sourceUrl}\nSource SHA-256: ${sha256}\nThe complete corresponding source archive, license and build script are included in this folder.\nNo GPL or nonfree components are enabled, and network protocols are disabled. FFmpeg runs as a separate process.\nConfigure arguments: ${JSON.stringify(flags)}\n`);
const binarySha256 = await digestOf(binary);
const ffprobeSha256 = await digestOf(binaries.ffprobe);
await writeFile(join(output, 'runtime.json'), JSON.stringify({ version, platform: process.platform, arch: process.arch, sourceUrl, sourceSha256: sha256, binarySha256, ffprobeSha256, configHash, flags }, null, 2) + '\n');
process.stdout.write(`Built local audio tools: ${tools.map((tool) => binaries[tool]).join(', ')}\n`);
