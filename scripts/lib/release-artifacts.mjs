import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, posix, resolve } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
// Use the pinned extractor's ZIP reader, including the root yauzl security override.
const require = createRequire(import.meta.url);
const yauzl = createRequire(require.resolve('extract-zip'))('yauzl');

export function stableVersion(value) {
  assert(typeof value === 'string' && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)
    && value.split('.').every(part => Number.isSafeInteger(Number(part))), 'A stable semantic version is required.');
  return value;
}

export async function hashFile(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return { sha256: hash.digest('hex'), size: (await stat(path)).size };
}

export async function atomicJson(path, value) {
  await mkdir(dirname(resolve(path)), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}

export function validateArchiveEntries(entries) {
  assert(entries.length > 0 && entries.length <= 100_000, 'Invalid release archive entry count.');
  const seen = new Set();
  const links = new Map();
  const canonical = path => path.normalize('NFD').toLowerCase();
  let expandedBytes = 0;
  for (const entry of entries) {
    const name = entry.name.replace(/\/$/, '');
    // Our release payload uses ASCII paths. Reject Unicode aliases rather than
    // guessing APFS's case/normalization rules during security preflight.
    assert(name && !name.includes('\\') && !/[^\x20-\x7e]/.test(name)
      && !name.startsWith('/') && !name.split('/').some(part => part === '..' || part === '.' || part === ''), 'Unsafe release archive path.');
    assert(name === 'Cutroom.app' || name.startsWith('Cutroom.app/') || name === '__MACOSX' || name.startsWith('__MACOSX/'), 'Unexpected file outside Cutroom.app.');
    const key = canonical(name);
    assert(!seen.has(key), 'Duplicate release archive path.');
    seen.add(key);
    expandedBytes += entry.size;
    assert(Number.isSafeInteger(entry.size) && entry.size >= 0 && expandedBytes <= 8 * 1024 ** 3, 'Release archive expands beyond its size limit.');
    if (entry.link !== undefined) {
      assert(typeof entry.link === 'string' && entry.link.length > 0 && !entry.link.includes('\\')
        && !/[^\x20-\x7e]/.test(entry.link) && !posix.isAbsolute(entry.link), 'Unsafe release archive symlink.');
      const target = posix.normalize(posix.join(posix.dirname(name), entry.link));
      assert(target.startsWith('Cutroom.app/'), 'Release archive symlink escapes the app.');
      links.set(key, canonical(entry.link));
    }
  }
  for (const name of seen) {
    let parent = posix.dirname(name);
    while (parent !== '.') {
      assert(!links.has(parent), 'Release archive writes through a symlink.');
      parent = posix.dirname(parent);
    }
  }
  // Resolve chained links using filesystem order (expand a link before '..'),
  // not lexical normalization, on macOS's case/Unicode-insensitive namespace.
  for (const name of links.keys()) {
    const pending = name.split('/');
    const resolved = [];
    let hops = 0;
    while (pending.length) {
      const part = pending.shift();
      if (!part || part === '.') continue;
      if (part === '..') {
        assert(resolved.length > 1, 'Release archive symlink escapes the app.');
        resolved.pop();
      } else {
        resolved.push(part);
        assert(resolved[0] === 'cutroom.app', 'Release archive symlink escapes the app.');
        const target = links.get(resolved.join('/'));
        if (target !== undefined) {
          assert(++hops <= 40, 'Release archive has a cyclic or excessively chained symlink.');
          resolved.pop();
          pending.unshift(...target.split('/'));
        }
      }
    }
    assert(seen.has(resolved.join('/')), 'Release archive has a broken symlink.');
  }
}

async function inspectArchivePaths(path) {
  const archive = await promisify(yauzl.open)(path, { lazyEntries: true, strictFileNames: true });
  const entries = [];
  await new Promise((resolvePromise, reject) => {
    const fail = error => { archive.close(); reject(error); };
    archive.on('error', fail);
    archive.on('end', resolvePromise);
    archive.on('entry', async entry => {
      try {
        assert(entries.length < 100_000, 'Release archive has too many entries.');
        const row = { name: entry.fileName, size: entry.uncompressedSize };
        if ((((entry.externalFileAttributes >>> 16) & 0xf000) === 0xa000)) {
          assert(entry.uncompressedSize <= 4096, 'Release archive symlink is too long.');
          const stream = await promisify(archive.openReadStream.bind(archive))(entry);
          const chunks = [];
          for await (const chunk of stream) chunks.push(chunk);
          row.link = Buffer.concat(chunks).toString('utf8');
        }
        entries.push(row);
        archive.readEntry();
      } catch (error) { fail(error); }
    });
    archive.readEntry();
  });
  validateArchiveEntries(entries);
}

async function command(program, args) {
  const { stdout, stderr } = await run(program, args, { timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
  return `${stdout}\n${stderr}`.trim();
}

export async function verifyMacApp(path, team) {
  assert(process.platform === 'darwin', 'Release verification requires macOS.');
  assert(/^[A-Z0-9]{10}$/.test(team), 'Supply the expected Apple Developer team.');
  const bundle = resolve(path);
  const plist = async key => (await command('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, join(bundle, 'Contents/Info.plist')])).trim();
  const version = stableVersion(await plist('CFBundleShortVersionString'));
  assert.equal(await plist('CFBundleVersion'), version, 'Bundle version fields disagree.');
  assert.equal(await plist('CFBundleIdentifier'), 'app.cutroom.editor');
  assert.equal(await plist('CFBundleExecutable'), 'Cutroom');
  const pkg = JSON.parse(await readFile(join(bundle, 'Contents/Resources/app/package.json'), 'utf8'));
  assert.equal(pkg.version, version, 'Packaged JavaScript version disagrees with bundle version.');
  const config = JSON.parse(await readFile(join(bundle, 'Contents/Resources/app/dist/release-config.json'), 'utf8'));
  assert.equal(config.signedRelease, true, 'App is not configured as a signed release.');
  assert.equal(config.teamId, team, 'Baked release team does not match expected team.');
  await command('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle]);
  const signature = await command('/usr/bin/codesign', ['--display', '--verbose=4', bundle]);
  assert(signature.includes(`TeamIdentifier=${team}`) && /^Authority=Developer ID Application:/m.test(signature), 'Unexpected signing authority.');
  assert(/flags=.*\bruntime\b/.test(signature), 'Hardened runtime is required.');
  const cdhash = /^CDHash=([a-f\d]+)$/m.exec(signature)?.[1];
  assert(cdhash, 'Missing code-signature hash.');
  await command('/usr/bin/xcrun', ['stapler', 'validate', bundle]);
  await command('/usr/sbin/spctl', ['--assess', '--type', 'execute', bundle]);
  const arches = (await command('/usr/bin/lipo', ['-archs', join(bundle, 'Contents/MacOS/Cutroom')])).split(/\s+/);
  assert(arches.length === 1 && ['arm64', 'x86_64'].includes(arches[0]), 'Expected a single supported release architecture.');
  return { version, platform: 'darwin', arch: arches[0] === 'x86_64' ? 'x64' : 'arm64', teamId: team, cdhash, notarized: true, updateFeedUrl: config.updateFeedUrl, updateFeedType: config.updateFeedType ?? 'default' };
}

export async function withVerifiedZip(zip, team, callback = async value => value) {
  assert(zip.endsWith('.zip') && (await stat(zip)).isFile(), 'Supply a release ZIP.');
  const directory = await mkdtemp(join(tmpdir(), 'uve-release-check-'));
  try {
    const snapshot = join(directory, 'release.zip');
    await copyFile(zip, snapshot);
    await inspectArchivePaths(snapshot);
    const extracted = join(directory, 'extracted');
    await mkdir(extracted);
    // ditto preserves Apple's resource forks and stapled-ticket metadata.
    await command('/usr/bin/ditto', ['-x', '-k', snapshot, extracted]);
    const appPath = join(extracted, 'Cutroom.app');
    const verified = await verifyMacApp(appPath, team);
    const digest = await hashFile(snapshot);
    assert.deepEqual(await hashFile(zip), digest, 'Release ZIP changed during verification.');
    return await callback({ ...verified, ...digest }, appPath);
  } finally { await rm(directory, { recursive: true, force: true }); }
}

export async function verifyMacDmg(path, team, expectedApp) {
  assert(path.endsWith('.dmg') && (await stat(path)).isFile(), 'Supply a release DMG.');
  const directory = await mkdtemp(join(tmpdir(), 'uve-installer-check-'));
  const mount = join(directory, 'mounted');
  let mounted = false;
  try {
    const snapshot = join(directory, 'installer.dmg');
    await copyFile(path, snapshot);
    await command('/usr/bin/codesign', ['--verify', '--strict', snapshot]);
    const signature = await command('/usr/bin/codesign', ['--display', '--verbose=4', snapshot]);
    assert(signature.includes(`TeamIdentifier=${team}`) && /^Authority=Developer ID Application:/m.test(signature), 'Unexpected installer signing authority.');
    await command('/usr/bin/xcrun', ['stapler', 'validate', snapshot]);
    await command('/usr/sbin/spctl', ['--assess', '--type', 'open', '--context', 'context:primary-signature', snapshot]);
    await mkdir(mount);
    await command('/usr/bin/hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mount, snapshot]);
    mounted = true;
    const appPath = join(mount, 'Cutroom.app');
    assert((await lstat(appPath)).isDirectory() && (await realpath(appPath)).startsWith((await realpath(mount)) + '/'), 'Installer must contain a real app inside its mounted volume.');
    const app = await verifyMacApp(appPath, team);
    if (expectedApp) for (const key of ['version', 'arch', 'teamId', 'cdhash']) assert.equal(app[key], expectedApp[key], `DMG app disagrees: ${key}`);
    const digest = await hashFile(snapshot);
    assert.deepEqual(await hashFile(path), digest, 'Release DMG changed during verification.');
    return digest;
  } finally {
    if (mounted) await command('/usr/bin/hdiutil', ['detach', mount]);
    await rm(directory, { recursive: true, force: true });
  }
}
