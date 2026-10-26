import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';

function publicHttpsUrl(value, label, originOnly = false) {
  let url;
  try { url = new URL(value); } catch { throw new Error(`${label} must be a public HTTPS URL.`); }
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.port ||
      !host.includes('.') || isIP(host.replace(/^\[|\]$/g, '')) ||
      /(^|\.)(localhost|local|internal)$/.test(host) || (originOnly && url.pathname !== '/')) {
    throw new Error(`${label} must be a public HTTPS ${originOnly ? 'origin' : 'URL'} without credentials, query parameters, or a custom port.`);
  }
  return originOnly ? url.origin : url.href;
}

function updateFeed(value) {
  const canonical = publicHttpsUrl(value, 'The update feed');
  const url = new URL(canonical);
  let path;
  try { path = decodeURI(url.pathname); } catch { throw new Error('The update feed has an invalid encoded path.'); }
  if (/[{}%]/.test(url.hostname) || /[{}]/.test(path.replace(/\{(?:platform|arch)\}/g, ''))) {
    throw new Error('The update feed only supports {platform} and {arch} path placeholders.');
  }
  return canonical;
}

function privateDownload(value) {
  const canonical = publicHttpsUrl(value, 'Private downloads');
  const url = new URL(canonical);
  const segments = url.pathname.replace(/\/$/, '').split('/').slice(1);
  if (url.hostname !== 'github.com' || segments.length < 3 || segments.length > 4 ||
      segments[2] !== 'releases' || (segments.length === 4 && segments[3] !== 'latest') ||
      segments.slice(0, 2).some(segment => !/^[A-Za-z0-9_.-]+$/.test(segment) || segment === '.' || segment === '..')) {
    throw new Error('Private downloads must point to a GitHub repository releases page or its releases/latest page.');
  }
  url.pathname = `/${segments.join('/')}`;
  return url.href;
}

// Shared by the build script and Forge: invoking Forge directly must not bypass
// release checks or package configuration left over from a different build.
export function resolveReleaseSettings(env = process.env, platform = process.platform) {
  const signedRelease = env.CUTROOM_RELEASE === '1';
  const identity = env.CUTROOM_SIGN_IDENTITY?.trim();
  const teamId = env.APPLE_TEAM_ID?.trim();
  const profile = env.CUTROOM_NOTARY_PROFILE?.trim();
  const updateFeedType = env.CUTROOM_UPDATE_FEED_TYPE || 'default';
  if (updateFeedType !== 'default' && updateFeedType !== 'json') {
    throw new Error('CUTROOM_UPDATE_FEED_TYPE must be default or json.');
  }
  if (signedRelease) {
    if (platform !== 'darwin') throw new Error('Signed macOS releases must be built on macOS.');
    if (env.SKIP_SIGN || !identity || !teamId || (!profile && !(env.APPLE_ID && env.APPLE_PASSWORD))) {
      throw new Error('Release builds require Developer ID signing and notarization credentials. Use a local build without CUTROOM_RELEASE for development.');
    }
    if (!/^[A-Z0-9]{10}$/.test(teamId)) throw new Error('APPLE_TEAM_ID must be a 10-character Apple Developer Team ID.');
    // osx-sign also accepts a certificate SHA-1; the finished app's Team ID is
    // independently checked by release verification in that case.
    if (!/^[a-f\d]{40}$/i.test(identity)) {
      const certificateTeam = /^Developer ID Application: .+ \(([A-Z0-9]{10})\)$/.exec(identity)?.[1];
      if (!certificateTeam) throw new Error('CUTROOM_SIGN_IDENTITY must identify a Developer ID Application certificate.');
      if (certificateTeam !== teamId) throw new Error('CUTROOM_SIGN_IDENTITY and APPLE_TEAM_ID belong to different Apple Developer teams.');
    }
  }

  const releaseConfig = {
    signedRelease,
    updateFeedUrl: signedRelease && env.CUTROOM_UPDATE_FEED_URL
      ? updateFeed(env.CUTROOM_UPDATE_FEED_URL) : null,
    updateFeedType,
    privateDownloadUrl: env.CUTROOM_PRIVATE_DOWNLOAD_URL ? privateDownload(env.CUTROOM_PRIVATE_DOWNLOAD_URL) : null,
    teamId: signedRelease ? teamId : null,
    instagramAuthUrl: env.UVE_INSTAGRAM_AUTH_URL
      ? publicHttpsUrl(env.UVE_INSTAGRAM_AUTH_URL, 'Instagram auth configuration', true) : null,
  };
  const osxSign = env.SKIP_SIGN ? undefined : {
    identity,
    keychain: env.CUTROOM_SIGN_KEYCHAIN || undefined,
    // Packager otherwise defaults to warning and continuing after signing fails.
    continueOnError: false,
    strictVerify: true,
  };
  const osxNotarize = env.SKIP_SIGN ? undefined : profile ? {
    keychainProfile: profile,
    keychain: env.CUTROOM_NOTARY_KEYCHAIN || undefined,
  } : env.APPLE_ID && env.APPLE_PASSWORD && teamId ? {
    appleId: env.APPLE_ID,
    appleIdPassword: env.APPLE_PASSWORD,
    teamId,
  } : undefined;
  return { releaseConfig, osxSign, osxNotarize };
}

export function assertBuiltReleaseConfig(path, expected) {
  let actual;
  try { actual = JSON.parse(readFileSync(path, 'utf8')); } catch {
    throw new Error('Missing or invalid release configuration. Rebuild the desktop app before packaging.');
  }
  if (!actual || typeof actual !== 'object' || Array.isArray(actual) ||
      Object.keys(actual).length !== Object.keys(expected).length ||
      Object.entries(expected).some(([key, value]) => actual[key] !== value)) {
    throw new Error('Built release configuration does not match the packaging environment. Rebuild the desktop app with the same release settings.');
  }
}
