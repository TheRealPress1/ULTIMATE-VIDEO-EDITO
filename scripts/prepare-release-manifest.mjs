import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { atomicJson, withVerifiedZip } from './lib/release-artifacts.mjs';
import { compareVersions, validateReleaseManifest } from './update-feed.mjs';

export function mergeRelease(manifest, release) {
  validateReleaseManifest({ releases: [release] });
  validateReleaseManifest(manifest);
  const prior = manifest.releases.find(row => row.platform === release.platform && row.arch === release.arch && row.version === release.version);
  if (prior) {
    assert(prior.sha256 === release.sha256 && prior.url === release.url, 'This version already points to a different artifact. Bump the version instead of replacing a release.');
    return manifest;
  }
  const sameArch = manifest.releases.filter(row => row.platform === release.platform && row.arch === release.arch);
  assert(sameArch.every(row => compareVersions(release.version, row.version) > 0), 'Refusing to add an older release to the update feed.');
  const merged = { releases: [...manifest.releases, release] };
  validateReleaseManifest(merged);
  return merged;
}

export function staticManifest(manifest, arch) {
  validateReleaseManifest(manifest);
  const releases = manifest.releases.filter(row => row.platform === 'darwin' && row.arch === arch)
    .sort((a, b) => compareVersions(b.version, a.version));
  assert(releases.length, `No releases for ${arch}.`);
  return {
    currentRelease: releases[0].version,
    releases: releases.map(row => ({ version: row.version, updateTo: {
      version: row.version, name: row.version, notes: row.notes, pub_date: row.pub_date, url: row.url,
    } })),
  };
}

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { team: { type: 'string' }, 'static-dir': { type: 'string' } } });
  const [zip, base, output, expectedArch] = positionals;
  assert(zip && base && output && positionals.length <= 4, 'Usage: node scripts/prepare-release-manifest.mjs signed-app.zip https://release-host/path/ manifest.json [arm64|x64] --team TEAMID [--static-dir output-directory]');
  const baseURL = new URL(base);
  assert(baseURL.protocol === 'https:' && !baseURL.username && !baseURL.password && !baseURL.search && !baseURL.hash, 'Supply an HTTPS release directory without credentials or query parameters.');
  const verified = await withVerifiedZip(resolve(zip), values.team ?? process.env.APPLE_TEAM_ID);
  if (expectedArch) assert.equal(verified.arch, expectedArch, 'Supplied architecture disagrees with the signed archive.');
  const release = {
    platform: verified.platform, arch: verified.arch, version: verified.version,
    url: new URL(encodeURIComponent(basename(zip)), baseURL.href.replace(/\/?$/, '/')).href,
    notes: process.env.CUTROOM_RELEASE_NOTES ?? `UVE ${verified.version}`,
    pub_date: new Date().toISOString(), sha256: verified.sha256,
  };
  let previous = { releases: [] };
  try { previous = JSON.parse(await readFile(output, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const merged = mergeRelease(previous, release);
  await atomicJson(output, merged);
  if (values['static-dir']) for (const arch of new Set(merged.releases.map(row => row.arch))) {
    await atomicJson(join(values['static-dir'], 'darwin', arch, 'RELEASES.json'), staticManifest(merged, arch));
  }
  console.log(`Verified ${verified.version} (${verified.arch}); retained ${merged.releases.length} release entries. Metadata written to ${resolve(output)}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
