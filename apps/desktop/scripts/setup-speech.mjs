// Build a pinned, self-contained whisper.cpp CLI for the current Mac.
// Model weights are downloaded separately by the app on first transcription.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmod, copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'darwin') {
  console.log('Local speech runtime is currently built for macOS only.');
  process.exit(0);
}

const version = '1.9.5';
const sha256 = 'ff1a9053feb509ff9d7729703355541ae9690073a6b1c40eb692c962e0dc1720';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const cache = join(root, '.speech-build');
const destination = join(root, 'speech');
const metadata = { version, sha256, platform: process.platform, arch: process.arch };
await mkdir(cache, { recursive: true });
await mkdir(destination, { recursive: true });

try {
  const previous = JSON.parse(await readFile(join(destination, 'runtime.json'), 'utf8'));
  if (JSON.stringify(previous) === JSON.stringify(metadata)) {
    execFileSync(join(destination, 'whisper-cli'), ['--help'], { stdio: 'ignore' });
    console.log(`Local speech runtime v${version} (${process.arch}) is ready.`);
    process.exit(0);
  }
} catch { /* Build missing or outdated runtime. */ }

for (const command of ['cmake', 'clang']) {
  try { execFileSync(command, ['--version'], { stdio: 'ignore' }); }
  catch { throw new Error(`Building local speech requires ${command}. Install Xcode Command Line Tools and CMake, then run npm run setup:speech again.`); }
}

const archive = join(cache, `whisper-v${version}.tar.gz`);
let source;
try { source = await readFile(archive); } catch { /* Download below. */ }
if (!source || createHash('sha256').update(source).digest('hex') !== sha256) {
  console.log(`Downloading verified whisper.cpp v${version} source…`);
  const response = await fetch(`https://github.com/ggml-org/whisper.cpp/archive/refs/tags/v${version}.tar.gz`, {
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) throw new Error(`Speech source download failed (${response.status}).`);
  source = Buffer.from(await response.arrayBuffer());
  if (createHash('sha256').update(source).digest('hex') !== sha256) throw new Error('Speech source checksum mismatch.');
  await writeFile(archive, source);
}
const sourceDir = join(cache, `whisper.cpp-${version}`);
await rm(sourceDir, { recursive: true, force: true });
execFileSync('tar', ['-xzf', archive, '-C', cache], { stdio: 'inherit' });
const buildDir = join(sourceDir, 'build');
execFileSync('cmake', [
  '-S', sourceDir, '-B', buildDir,
  '-DCMAKE_BUILD_TYPE=Release', '-DBUILD_SHARED_LIBS=OFF', '-DGGML_NATIVE=OFF',
  '-DGGML_METAL_EMBED_LIBRARY=ON', '-DWHISPER_SDL2=OFF',
  '-DWHISPER_BUILD_TESTS=OFF', '-DWHISPER_BUILD_EXAMPLES=ON',
  '-DWHISPER_CURL=OFF', '-DCMAKE_OSX_DEPLOYMENT_TARGET=13.0',
  `-DCMAKE_OSX_ARCHITECTURES=${process.arch === 'arm64' ? 'arm64' : 'x86_64'}`,
], { stdio: 'inherit' });
execFileSync('cmake', ['--build', buildDir, '--config', 'Release', '--target', 'whisper-cli', '-j', String(Math.min(8, availableParallelism()))], { stdio: 'inherit' });
const executable = join(buildDir, 'bin', 'whisper-cli');
const dependencies = execFileSync('otool', ['-L', executable], { encoding: 'utf8' });
if (dependencies.split('\n').slice(1).some((line) => line.trim() && !/^\s*\/(usr\/lib|System\/Library)\//.test(line))) {
  throw new Error(`Speech runtime has non-system dependencies:\n${dependencies}`);
}
await copyFile(executable, join(destination, 'whisper-cli'));
await chmod(join(destination, 'whisper-cli'), 0o755);
await copyFile(join(sourceDir, 'LICENSE'), join(destination, 'LICENSE'));
await writeFile(join(destination, 'runtime.json'), `${JSON.stringify(metadata, null, 2)}\n`);
console.log(`Local speech runtime v${version} (${process.arch}) is ready.`);
