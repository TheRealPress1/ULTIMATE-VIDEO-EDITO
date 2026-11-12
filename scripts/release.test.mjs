import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextVersion } from './release.mjs';
import { mergeRelease, staticManifest } from './prepare-release-manifest.mjs';
import { validateArchiveEntries } from './lib/release-artifacts.mjs';

const release = (version, arch = 'arm64') => ({ platform: 'darwin', arch, version, url: `https://downloads.example.com/Blackout-${arch}-${version}.zip`, notes: 'Release notes', pub_date: '2026-10-25T12:00:00.000Z', sha256: 'a'.repeat(64) });

test('version preparation increases stable versions and rejects ambiguous or unsafe inputs', () => {
  assert.equal(nextVersion('0.216.0', 'patch'), '0.216.1');
  assert.equal(nextVersion('0.216.0', 'minor'), '0.217.0');
  assert.equal(nextVersion('0.216.0', 'major'), '1.0.0');
  assert.equal(nextVersion('0.216.0', '1.2.3'), '1.2.3');
  for (const value of ['0.215.9', '0.216.0', '01.2.3', '1.2.3-beta', '9007199254740992.0.0', 'latest']) assert.throws(() => nextVersion('0.216.0', value));
});

test('release merge preserves architecture history and is idempotent for the same artifact', () => {
  const prior = { releases: [release('0.215.0'), release('0.216.0', 'x64')] };
  const merged = mergeRelease(prior, release('0.216.0'));
  assert.equal(merged.releases.length, 3);
  assert.equal(prior.releases.length, 2);
  assert.deepEqual(mergeRelease(merged, { ...release('0.216.0'), pub_date: '2026-10-26T12:00:00.000Z' }), merged);
  assert.throws(() => mergeRelease(merged, { ...release('0.216.0'), sha256: 'b'.repeat(64) }), /different artifact/);
  assert.throws(() => mergeRelease(merged, release('0.214.0')), /older release/);
  assert.throws(() => mergeRelease({ releases: [release('0.216.0'), release('0.216.0')] }, release('0.217.0')), /Duplicate/);
});

test('static Squirrel metadata picks only the latest matching architecture', () => {
  const manifest = { releases: [release('0.215.0'), release('0.217.0', 'x64'), release('0.216.0')] };
  const arm = staticManifest(manifest, 'arm64');
  assert.equal(arm.currentRelease, '0.216.0');
  assert.deepEqual(arm.releases.map(row => row.version), ['0.216.0', '0.215.0']);
  assert.equal(arm.releases[0].updateTo.url, release('0.216.0').url);
  assert.equal(staticManifest(manifest, 'x64').currentRelease, '0.217.0');
  assert.throws(() => staticManifest(manifest, 'universal'), /No releases/);
});

test('ZIP verification accepts framework symlinks and rejects path escapes or writes through them', () => {
  const entries = [
    { name: 'Blackout.app/', size: 0 },
    { name: 'Blackout.app/Contents/Framework.framework/Versions/A/', size: 0 },
    { name: 'Blackout.app/Contents/Framework.framework/Versions/A/bin', size: 10 },
    { name: 'Blackout.app/Contents/Framework.framework/Versions/Current', size: 1, link: 'A' },
  ];
  validateArchiveEntries(entries);
  for (const name of ['/etc/file', '../file', 'Blackout.app/../file', 'Blackout.app/./file', 'Blackout.app//file', 'other.app/file', 'Blackout.app\\file']) {
    assert.throws(() => validateArchiveEntries([{ name, size: 1 }]));
  }
  assert.throws(() => validateArchiveEntries([...entries, { name: entries[1].name, size: 10 }]), /Duplicate/);
  assert.throws(() => validateArchiveEntries([...entries, { name: 'Blackout.app/contents/framework.framework/versions/CURRENT/bin', size: 1 }]), /through a symlink/);
  assert.throws(() => validateArchiveEntries([{name:'Blackout.app/Contents/nested/alias',link:'../',size:2},{name:'Blackout.app/link',link:'Contents/nested/alias/../../outside',size:32}]), /symlink/);
  assert.throws(() => validateArchiveEntries([{name:'Blackout.app/link',link:'link',size:4}]), /cyclic/);
  assert.throws(() => validateArchiveEntries([...entries, { name: 'Blackout.app/Contents/Framework.framework/Versions/Current/bin', size: 1 }]), /through a symlink/);
  assert.throws(() => validateArchiveEntries([{ name: 'Blackout.app/link', size: 5, link: '../../outside' }]), /escapes/);
  assert.throws(() => validateArchiveEntries([{ name: 'Blackout.app/link', size: 5, link: '/outside' }]), /Unsafe/);
  assert.throws(() => validateArchiveEntries([{ name: 'Blackout.app/large', size: 9 * 1024 ** 3 }]), /size limit/);
});
