import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compareVersions, selectRelease, startUpdateFeed } from './update-feed.mjs';

const release = { platform: 'darwin', arch: 'arm64', version: '1.2.0', url: 'https://releases.example.com/app.zip', notes: 'Changes', pub_date: '2026-10-25T00:00:00Z' };
const query = (overrides = {}) => new URLSearchParams({ version: '1.1.0', platform: 'darwin', arch: 'arm64', ...overrides });

test('numeric ordering is stable and rejects ambiguous or imprecise versions', () => {
  assert.equal(compareVersions('1.10.0', '1.9.0'), 1);
  assert.equal(compareVersions('2.0.0', '10.0.0'), -1);
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
  for (const version of ['latest', '01.2.3', '1.2.3-beta.1', '1.2.9007199254740993', undefined, 123]) {
    assert.throws(() => compareVersions(version, '2.0.0'));
  }
});

test('delivers only the latest newer release for the requested architecture', () => {
  const manifest = { releases: [release, { ...release, version: '1.10.0' }, { ...release, version: '2.0.0', arch: 'x64' }] };
  assert.equal(selectRelease(manifest, query()).name, '1.10.0');
  assert.equal(selectRelease(manifest, query({ arch: 'x64' })).name, '2.0.0');
  assert.equal(selectRelease(manifest, query({ version: '1.10.0' })), null);
  assert.equal(selectRelease(manifest, query({ version: '3.0.0' })), null);
  assert.equal(selectRelease({ releases: [] }, query()), null);
});

test('rejects missing, duplicate, unsupported, and unknown request fields', () => {
  for (const value of [
    'version=1.0.0&platform=darwin',
    `${query()}&arch=x64`, `${query()}&token=secret`,
    query({ platform: 'win32' }), query({ arch: 'ia32' }), query({ version: '' }),
  ]) assert.throws(() => selectRelease({ releases: [release] }, new URLSearchParams(value)));
});

test('validates all release metadata, including unselected releases', () => {
  for (const change of [
    { url: 'http://bad.test/app.zip' }, { url: 'https://user:secret@releases.example.com/app.zip' },
    { url: 'https://127.0.0.1/app.zip' }, { url: 'https://updates.internal/app.zip' },
    { url: 'https://releases.example.com/app.zip?token=secret' }, { url: 'https://releases.example.com/app.zip#secret' },
    { url: 'https://releases.example.com/app.dmg' }, { pub_date: 'n/a' }, { notes: null },
    { sha256: 'not-a-digest' }, { version: 'latest' }, { arch: 'invalid' },
  ]) assert.throws(() => selectRelease({ releases: [release, { ...release, version: '0.1.0', ...change }] }, query()));
  for (const manifest of [null, {}, { releases: [null] }, { releases: [release, release] }, { releases: Array(101).fill(release) }]) {
    assert.throws(() => selectRelease(manifest, query()));
  }
});

async function serverFixture(t, manifest = { releases: [release] }) {
  const directory = await mkdtemp(join(tmpdir(), 'uve-update-feed-'));
  const manifestPath = join(directory, 'releases.json');
  if (manifest !== null) await writeFile(manifestPath, JSON.stringify(manifest));
  const server = startUpdateFeed({ manifestPath, port: 0 });
  await once(server, 'listening');
  t.after(async () => {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { manifestPath, request: (path, options) => fetch(`${base}${path}`, options) };
}

test('HTTP protocol supplies updates, 204 for equal/newer or other architecture, and correct cache policy', async t => {
  const { request } = await serverFixture(t);
  const response = await request(`/updates?${query()}`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), {
    url: release.url, name: release.version, notes: release.notes, pub_date: '2026-10-25T00:00:00.000Z',
  });
  for (const fields of [{ version: '1.2.0' }, { version: '2.0.0' }, { arch: 'x64' }]) {
    const current = await request(`/updates?${query(fields)}`);
    assert.equal(current.status, 204);
    assert.equal(await current.text(), '');
  }
  assert.equal((await request('/unknown')).status, 404);
  const method = await request(`/updates?${query()}`, { method: 'POST' });
  assert.equal(method.status, 405);
  assert.equal(method.headers.get('allow'), 'GET');
});

test('HTTP malformed queries return 400 before trying to read unavailable server metadata', async t => {
  const { request } = await serverFixture(t, null);
  for (const value of ['', `${query()}&arch=x64`, 'version=bad&platform=darwin&arch=arm64']) {
    const response = await request(`/updates?${value}`);
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'Invalid update request.' });
  }
});

test('HTTP broken, missing, or oversized server manifests return retryable 503 without sensitive details', async t => {
  const { request, manifestPath } = await serverFixture(t, null);
  for (const text of [null, 'private malformed JSON', JSON.stringify({ releases: [null] }), ' '.repeat(1024 * 1024 + 1)]) {
    if (text !== null) await writeFile(manifestPath, text);
    const response = await request(`/updates?${query()}`);
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('retry-after'), '60');
    assert.deepEqual(await response.json(), { error: 'Update metadata is temporarily unavailable.' });
  }
});

test('rejects invalid server configuration before listening', () => {
  assert.throws(() => startUpdateFeed({ manifestPath: '' }));
  for (const port of [-1, 65536, NaN, 8788.5]) assert.throws(() => startUpdateFeed({ manifestPath: '/unused', port }));
});
