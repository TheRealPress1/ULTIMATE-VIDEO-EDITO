// Deploy behind HTTPS. This process serves metadata only; ZIPs live on your release host.
import { createServer } from 'node:http';
import { realpathSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { isIP } from 'node:net';
import { fileURLToPath } from 'node:url';

const MAX_MANIFEST_BYTES = 1024 * 1024;

function versionParts(version) {
  if (typeof version !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
    throw new Error('A stable semantic version is required.');
  }
  const parts = version.split('.').map(Number);
  if (parts.some(part => !Number.isSafeInteger(part))) throw new Error('Invalid version.');
  return parts;
}

export function compareVersions(a, b) {
  const left = versionParts(a), right = versionParts(b);
  for (let index = 0; index < 3; index++) {
    if (left[index] !== right[index]) return left[index] > right[index] ? 1 : -1;
  }
  return 0;
}

export function parseUpdateQuery(query) {
  const keys = ['version', 'platform', 'arch'];
  if ([...query.keys()].some(key => !keys.includes(key)) || keys.some(key => query.getAll(key).length !== 1)) {
    throw new Error('Exactly one version, platform and architecture are required.');
  }
  const version = query.get('version'), platform = query.get('platform'), arch = query.get('arch');
  versionParts(version);
  if (platform !== 'darwin' || !['arm64', 'x64'].includes(arch)) throw new Error('Unsupported platform.');
  return { version, platform, arch };
}

function releaseURL(value) {
  if (typeof value !== 'string') throw new Error('Release ZIP URL is required.');
  const url = new URL(value), hostname = url.hostname.replace(/\.$/, '');
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search || url.port
    || isIP(hostname.replace(/^\[|\]$/g, '')) || !hostname.includes('.')
    || /(?:^|\.)(?:localhost|local|internal)$/.test(hostname) || !url.pathname.endsWith('.zip')) {
    throw new Error('Release ZIP must use public HTTPS.');
  }
  return url.href;
}

export function validateReleaseManifest(manifest) {
  if (!manifest || !Array.isArray(manifest.releases) || manifest.releases.length > 100) {
    throw new Error('Invalid release metadata.');
  }
  const identities = new Set();
  return manifest.releases.map(release => {
    if (!release || release.platform !== 'darwin' || !['arm64', 'x64'].includes(release.arch)) {
      throw new Error('Invalid release platform.');
    }
    versionParts(release.version);
    const identity = `${release.platform}/${release.arch}/${release.version}`;
    if (identities.has(identity)) throw new Error('Duplicate release metadata.');
    identities.add(identity);
    const url = releaseURL(release.url);
    if (typeof release.notes !== 'string' || release.notes.length > 10000
      || typeof release.pub_date !== 'string' || !Number.isFinite(Date.parse(release.pub_date))
      || (release.sha256 !== undefined && (typeof release.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(release.sha256)))) {
      throw new Error('Invalid release details.');
    }
    return { ...release, url, pub_date: new Date(release.pub_date).toISOString() };
  });
}

function matchingRelease(releases, { version, platform, arch }) {
  const latest = releases
    .filter(release => release.platform === platform && release.arch === arch && compareVersions(release.version, version) > 0)
    .sort((a, b) => compareVersions(b.version, a.version))[0];
  return latest ? { url: latest.url, name: latest.version, notes: latest.notes, pub_date: latest.pub_date } : null;
}

export function selectRelease(manifest, query) {
  const request = parseUpdateQuery(query);
  return matchingRelease(validateReleaseManifest(manifest), request);
}

async function readManifest(manifestPath) {
  const file = await open(manifestPath, 'r');
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > MAX_MANIFEST_BYTES) throw new Error('Invalid manifest file.');
    // Bound the read as well as the initial stat, in case a publisher replaces the file mid-request.
    const buffer = Buffer.alloc(MAX_MANIFEST_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > MAX_MANIFEST_BYTES) throw new Error('Manifest too large.');
    return validateReleaseManifest(JSON.parse(buffer.toString('utf8', 0, length)));
  } finally { await file.close(); }
}

export function startUpdateFeed({ manifestPath, port = 8788, host = '127.0.0.1' }) {
  if (typeof manifestPath !== 'string' || !manifestPath) throw new Error('A release manifest path is required.');
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid update server port.');
  return createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      res.writeHead(405).end();
      return;
    }
    let request;
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname !== '/updates') { res.writeHead(404).end(); return; }
      request = parseUpdateQuery(url.searchParams);
    } catch {
      res.writeHead(400).end(JSON.stringify({ error: 'Invalid update request.' }));
      return;
    }
    try {
      const release = matchingRelease(await readManifest(manifestPath), request);
      if (!release) res.writeHead(204).end();
      else res.end(JSON.stringify(release));
    } catch {
      // A broken deployment is not a client error, and must never look like "already up to date".
      res.setHeader('Retry-After', '60');
      res.writeHead(503).end(JSON.stringify({ error: 'Update metadata is temporarily unavailable.' }));
    }
  }).listen(port, host);
}

/** Whether node was started with this file. Both paths are resolved through symlinks, since node keeps `argv[1]` as typed. */
function startedDirectly() {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (startedDirectly()) {
  if (!process.env.CUTROOM_RELEASE_MANIFEST) throw new Error('Set CUTROOM_RELEASE_MANIFEST to the approved release metadata file.');
  startUpdateFeed({ manifestPath: process.env.CUTROOM_RELEASE_MANIFEST, port: Number(process.env.PORT ?? 8788) });
}
