import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertBuiltReleaseConfig, resolveReleaseSettings } from '../scripts/release-settings.mjs';
import { finalizeMacInstallers } from '../scripts/finalize-macos-installers.mjs';

const releaseEnv = {
  CUTROOM_RELEASE: '1',
  CUTROOM_SIGN_IDENTITY: 'Developer ID Application: Example Publisher (ABCD123456)',
  APPLE_TEAM_ID: 'ABCD123456',
  CUTROOM_NOTARY_PROFILE: 'release-notary',
};
const temporaryDirectories: string[] = [];
afterEach(() => { for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true }); });

describe('macOS release build settings', () => {
  it('keeps a signed installer identifiable without an update feed', () => {
    const settings = resolveReleaseSettings(releaseEnv, 'darwin');
    expect(settings.releaseConfig).toEqual({ signedRelease: true, teamId: 'ABCD123456', updateFeedUrl: null, updateFeedType: 'default', privateDownloadUrl: null, instagramAuthUrl: null });
    expect(settings.osxSign).toMatchObject({ identity: releaseEnv.CUTROOM_SIGN_IDENTITY, continueOnError: false, strictVerify: true });
    expect(settings.osxNotarize).toEqual({ keychainProfile: 'release-notary', keychain: undefined });
  });

  it('passes explicit keychains only to signing and notarization, never the public config', () => {
    const settings = resolveReleaseSettings({ ...releaseEnv, CUTROOM_SIGN_KEYCHAIN: '/private/signing.keychain-db', CUTROOM_NOTARY_KEYCHAIN: '/private/notary.keychain-db', APPLE_PASSWORD: 'secret' }, 'darwin');
    expect(settings.osxSign?.keychain).toBe('/private/signing.keychain-db');
    expect(settings.osxNotarize).toMatchObject({ keychainProfile: 'release-notary', keychain: '/private/notary.keychain-db' });
    expect(JSON.stringify(settings.releaseConfig)).not.toMatch(/secret|\/private\/|release-notary|Example Publisher/);
  });

  it('accepts app-specific credentials and certificate SHA-1 selectors', () => {
    const settings = resolveReleaseSettings({ ...releaseEnv, CUTROOM_NOTARY_PROFILE: '', CUTROOM_SIGN_IDENTITY: 'A'.repeat(40), APPLE_ID: 'publisher@example.com', APPLE_PASSWORD: 'app-specific-password' }, 'darwin');
    expect(settings.osxNotarize).toEqual({ appleId: 'publisher@example.com', appleIdPassword: 'app-specific-password', teamId: 'ABCD123456' });
    expect(JSON.stringify(settings.releaseConfig)).not.toContain('app-specific-password');
  });

  it.each([
    { SKIP_SIGN: '1' }, { CUTROOM_SIGN_IDENTITY: '' }, { APPLE_TEAM_ID: '' },
    { APPLE_TEAM_ID: 'invalid' }, { CUTROOM_NOTARY_PROFILE: '' },
    { CUTROOM_SIGN_IDENTITY: 'Apple Development: Example Publisher (ABCD123456)' },
    { CUTROOM_SIGN_IDENTITY: 'Developer ID Application: Different Publisher (ZYXW987654)' },
  ])('rejects incomplete or contradictory release signing settings: %j', (overrides) => {
    expect(() => resolveReleaseSettings({ ...releaseEnv, ...overrides }, 'darwin')).toThrow();
  });

  it('rejects macOS release mode on a non-macOS host', () => {
    expect(() => resolveReleaseSettings(releaseEnv, 'linux')).toThrow('macOS');
  });

  it('preserves unsigned development builds without signing credentials', () => {
    const settings = resolveReleaseSettings({ SKIP_SIGN: '1', CUTROOM_UPDATE_FEED_URL: 'https://updates.example.com/feed' }, 'darwin');
    expect(settings.releaseConfig).toMatchObject({ signedRelease: false, teamId: null, updateFeedUrl: null });
    expect(settings.osxSign).toBeUndefined();
    expect(settings.osxNotarize).toBeUndefined();
  });

  it('builds a static feed configuration and accepts an Instagram HTTPS origin', () => {
    const settings = resolveReleaseSettings({ ...releaseEnv, CUTROOM_UPDATE_FEED_TYPE: 'json', CUTROOM_UPDATE_FEED_URL: 'https://updates.example.com/{platform}/{arch}/RELEASES.json', UVE_INSTAGRAM_AUTH_URL: 'https://instagram.example.com' }, 'darwin');
    expect(settings.releaseConfig).toMatchObject({ updateFeedType: 'json', updateFeedUrl: 'https://updates.example.com/%7Bplatform%7D/%7Barch%7D/RELEASES.json', instagramAuthUrl: 'https://instagram.example.com' });
    expect(() => resolveReleaseSettings({ ...releaseEnv, CUTROOM_UPDATE_FEED_TYPE: 'xml' }, 'darwin')).toThrow('CUTROOM_UPDATE_FEED_TYPE');
  });

  it.each(['http://updates.example.com', 'https://localhost/feed', 'https://updates.local/feed', 'https://updates.localhost/feed', 'https://updates.internal/feed', 'https://10.0.0.1/feed', 'https://127.0.0.1/feed', 'https://[::1]/feed', 'https://updates/feed', 'https://user:secret@updates.example.com/feed', 'https://updates.example.com:8443/feed', 'https://updates.example.com/feed?token=secret', 'https://updates.example.com/feed#fragment', 'malformed'])('rejects an unsafe update feed without echoing credentials: %s', (feed) => {
    expect(() => resolveReleaseSettings({ ...releaseEnv, CUTROOM_UPDATE_FEED_URL: feed }, 'darwin')).toThrow(/public HTTPS/);
    try { resolveReleaseSettings({ ...releaseEnv, CUTROOM_UPDATE_FEED_URL: feed }, 'darwin'); } catch (error) { expect(String(error)).not.toContain('secret'); }
  });

  it('rejects an Instagram callback path in place of an origin', () => {
    expect(() => resolveReleaseSettings({ UVE_INSTAGRAM_AUTH_URL: 'https://instagram.example.com/callback' }, 'darwin')).toThrow('origin');
  });

  it('rejects unsupported update template placeholders and malformed URL escapes before packaging', () => {
    for (const path of ['{unknown}/RELEASES.json', '%7BARCH%7D/RELEASES.json', '%AA/RELEASES.json']) {
      expect(() => resolveReleaseSettings({ ...releaseEnv, CUTROOM_UPDATE_FEED_URL: `https://updates.example.com/${path}` }, 'darwin')).toThrow();
    }
  });

  it('bakes the GitHub releases link into signed and development configurations', () => {
    for (const env of [{}, releaseEnv]) {
      expect(resolveReleaseSettings({ ...env, CUTROOM_PRIVATE_DOWNLOAD_URL: 'https://github.com/TheRealPress1/ULTIMATE-VIDEO-EDITO/releases/latest/' }, 'darwin').releaseConfig.privateDownloadUrl)
        .toBe('https://github.com/TheRealPress1/ULTIMATE-VIDEO-EDITO/releases/latest');
    }
    expect(resolveReleaseSettings({ CUTROOM_PRIVATE_DOWNLOAD_URL: 'https://github.com/owner/repo/releases' }, 'darwin').releaseConfig.privateDownloadUrl)
      .toBe('https://github.com/owner/repo/releases');
  });

  it.each(['https://downloads.example.com/owner/repo/releases', 'https://github.com/owner/repo', 'https://github.com/owner/repo/releases/download/file.dmg', 'https://github.com/owner/repo/releases/latest?token=secret', 'https://user:secret@github.com/owner/repo/releases', 'https://github.com/owner/repo/releases#fragment', 'https://github.com/owner/%2e%2e/releases', 'https://github.com/owner/repo/releases/other'])('rejects an invalid releases page: %s', (url) => {
    expect(() => resolveReleaseSettings({ CUTROOM_PRIVATE_DOWNLOAD_URL: url }, 'darwin')).toThrow();
  });

  it('blocks missing, stale, or secret-bearing packaged configuration', () => {
    const dir = mkdtempSync(join(tmpdir(), 'uve-release-config-'));
    temporaryDirectories.push(dir);
    const path = join(dir, 'release-config.json');
    const expected = resolveReleaseSettings(releaseEnv, 'darwin').releaseConfig;
    expect(() => assertBuiltReleaseConfig(path, expected)).toThrow('Rebuild');
    writeFileSync(path, JSON.stringify({ ...expected, updateFeedUrl: 'https://old.example.com/releases' }));
    expect(() => assertBuiltReleaseConfig(path, expected)).toThrow('does not match');
    writeFileSync(path, JSON.stringify({ ...expected, APPLE_PASSWORD: 'secret' }));
    expect(() => assertBuiltReleaseConfig(path, expected)).toThrow('does not match');
    writeFileSync(path, JSON.stringify(expected));
    expect(() => assertBuiltReleaseConfig(path, expected)).not.toThrow();
  });
});

describe('release installer notarization', () => {
  it('signs and verifies each DMG, then notarizes and validates its ticket before Gatekeeper assessment', async () => {
    const operations: string[] = [];
    const run = vi.fn(async (command: string, args: string[]) => { operations.push(`${command} ${args[0]}`); });
    const notarize = vi.fn(async () => { operations.push('notarize'); });
    await finalizeMacInstallers(['/tmp/Cutroom.zip', '/tmp/Cutroom.dmg'], { ...releaseEnv, CUTROOM_SIGN_KEYCHAIN: '/private/signing.keychain-db' }, { run, notarize });
    expect(operations).toEqual(['codesign --force', 'codesign --verify', 'notarize', 'xcrun stapler', 'spctl --assess']);
    expect(run.mock.calls[0]).toEqual(['codesign', ['--force', '--timestamp', '--sign', releaseEnv.CUTROOM_SIGN_IDENTITY, '--keychain', '/private/signing.keychain-db', '/tmp/Cutroom.dmg']]);
    expect(notarize).toHaveBeenCalledWith({ appPath: '/tmp/Cutroom.dmg', keychainProfile: 'release-notary', keychain: undefined });
  });

  it('fails immediately when signing fails and never attempts notarization', async () => {
    const run = vi.fn().mockRejectedValue(new Error('Signing failed'));
    const notarize = vi.fn();
    await expect(finalizeMacInstallers(['/tmp/Cutroom.dmg'], releaseEnv, { run, notarize })).rejects.toThrow('Signing failed');
    expect(run).toHaveBeenCalledOnce();
    expect(notarize).not.toHaveBeenCalled();
  });

  it('does not mark an installer ready after rejected notarization', async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    const notarize = vi.fn().mockRejectedValue(new Error('Notarization rejected'));
    await expect(finalizeMacInstallers(['/tmp/Cutroom.dmg'], releaseEnv, { run, notarize })).rejects.toThrow('Notarization rejected');
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('does not sign or submit development installers', async () => {
    const run = vi.fn();
    const notarize = vi.fn();
    await finalizeMacInstallers(['/tmp/Cutroom.dmg'], { SKIP_SIGN: '1' }, { run, notarize });
    expect(run).not.toHaveBeenCalled();
    expect(notarize).not.toHaveBeenCalled();
  });
});
