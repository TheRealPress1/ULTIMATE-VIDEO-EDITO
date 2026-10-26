import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { parseReleaseConfig, ReleaseUpdates } from './updates';

const config = { signedRelease: true, teamId: 'ABCD123456', updateFeedUrl: 'https://updates.example.com/releases' };
function fixture(overrides: Partial<ConstructorParameters<typeof ReleaseUpdates>[0]> = {}) {
  const updater = Object.assign(new EventEmitter(), {
    setFeedURL: vi.fn(), checkForUpdates: vi.fn(), quitAndInstall: vi.fn(),
  });
  const verifySignature = vi.fn(async () => true);
  const service = new ReleaseUpdates({
    updater, version: '1.2.3', arch: 'arm64', platform: 'darwin', config, verifySignature, ...overrides,
  });
  return { updater, service, verifySignature };
}
async function downloaded() {
  const result = fixture();
  await result.service.initialize();
  result.service.check();
  result.updater.emit('update-available');
  result.updater.emit('update-downloaded', {}, 'notes', '1.3.0');
  return result;
}

describe('signed release updates', () => {
  it('does not configure unsigned, unverified, unsupported, or offline releases', async () => {
    for (const overrides of [
      { config: { signedRelease: false, teamId: null, updateFeedUrl: null } },
      { verifySignature: async () => false },
      { platform: 'win32' },
      { arch: 'ia32' },
      { config: { ...config, updateFeedUrl: null } },
    ]) {
      const { service, updater } = fixture(overrides);
      await service.initialize();
      updater.emit('update-available');
      updater.emit('update-downloaded', {}, 'notes', '1.3.0');
      expect(updater.setFeedURL).not.toHaveBeenCalled();
      expect(service.snapshot().state).toBe('unavailable');
      expect(() => service.check()).toThrow();
    }
  });

  it('initializes once and checks only on request, without duplicate downloads', async () => {
    const { service, updater, verifySignature } = fixture();
    await Promise.all([service.initialize(), service.initialize()]);
    await service.initialize();
    expect(verifySignature).toHaveBeenCalledOnce();
    expect(updater.setFeedURL).toHaveBeenCalledExactlyOnceWith({
      url: 'https://updates.example.com/releases?version=1.2.3&platform=darwin&arch=arm64',
    });
    expect(updater.checkForUpdates).not.toHaveBeenCalled();
    service.check();
    service.check();
    updater.emit('update-available');
    service.check();
    expect(service.snapshot().state).toBe('downloading');
    expect(updater.checkForUpdates).toHaveBeenCalledOnce();
  });

  it('uses static feeds with architecture placeholders and no dynamic query', async () => {
    for (const arch of ['arm64', 'x64']) {
      const { service, updater } = fixture({
        arch, config: { ...config, updateFeedType: 'json', updateFeedUrl: 'https://updates.example.com/{platform}/%7Barch%7D/RELEASES.json' },
      });
      await service.initialize();
      expect(updater.setFeedURL).toHaveBeenCalledExactlyOnceWith({
        url: `https://updates.example.com/darwin/${arch}/RELEASES.json`, serverType: 'json',
      });
    }
  });

  it('keeps status readable when signature verification or feed setup throws', async () => {
    for (const step of ['signature', 'feed']) {
      const { service, updater } = fixture(step === 'signature'
        ? { verifySignature: async () => { throw new Error('sensitive signature output'); } } : {});
      if (step === 'feed') updater.setFeedURL.mockImplementation(() => { throw new Error('sensitive feed output'); });
      await expect(service.initialize()).resolves.toBeUndefined();
      expect(service.snapshot().state).toBe('unavailable');
      expect(service.snapshot().message).not.toContain('sensitive');
    }
  });

  it('keeps failed checks retryable without echoing remote errors', async () => {
    const { service, updater } = fixture();
    await service.initialize();
    updater.checkForUpdates.mockImplementationOnce(() => { throw new Error('secret'); });
    expect(service.check().state).toBe('error');
    expect(service.snapshot().message).not.toContain('secret');
    service.check();
    updater.emit('error', new Error('remote secret'));
    expect(service.snapshot().message).not.toContain('secret');
    service.check();
    updater.emit('update-not-available');
    expect(service.snapshot().state).toBe('idle');
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(3);
  });

  it('retains downloaded updates despite late events and does not download twice', async () => {
    const { service, updater } = await downloaded();
    updater.emit('checking-for-update');
    updater.emit('update-not-available');
    updater.emit('error', new Error('late error'));
    service.check();
    expect(service.snapshot()).toMatchObject({ state: 'ready', releaseName: '1.3.0' });
    expect(updater.checkForUpdates).toHaveBeenCalledOnce();
  });

  it('waits for durable saves and allows retry after a save/export guard fails', async () => {
    const { service, updater } = await downloaded();
    const prepare = vi.fn().mockRejectedValue(new Error('Finish or cancel the active export before installing the update.'));
    await expect(service.install(prepare)).rejects.toThrow('active export');
    expect(service.snapshot().state).toBe('ready');
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
    await service.install(async () => {});
    expect(updater.quitAndInstall).toHaveBeenCalledOnce();
    expect(service.snapshot().state).toBe('installing');
  });

  it('prevents concurrent and repeated restart requests, including while saving', async () => {
    const { service, updater } = await downloaded();
    let finishSave!: () => void;
    const saving = new Promise<void>(resolve => { finishSave = resolve; });
    const first = service.install(() => saving);
    expect(service.snapshot().state).toBe('installing');
    await expect(service.install(async () => {})).rejects.toThrow('No downloaded update');
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
    service.check();
    finishSave();
    await first;
    await expect(service.install(async () => {})).rejects.toThrow('No downloaded update');
    expect(updater.quitAndInstall).toHaveBeenCalledOnce();
    expect(updater.checkForUpdates).toHaveBeenCalledOnce();
  });

  it('does not restart if the updater fails during a durable save', async () => {
    const { service, updater } = await downloaded();
    await expect(service.install(async () => {
      updater.emit('error', new Error('installer error'));
    })).rejects.toThrow('could not be installed');
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
    expect(service.snapshot().state).toBe('error');
  });

  it('allows retry when Electron cannot start the restart', async () => {
    const { service, updater } = await downloaded();
    updater.quitAndInstall.mockImplementationOnce(() => { throw new Error('private output'); });
    await expect(service.install(async () => {})).rejects.toThrow('Your work is saved');
    expect(service.snapshot().state).toBe('ready');
    await service.install(async () => {});
    expect(updater.quitAndInstall).toHaveBeenCalledTimes(2);
  });

  it('unlocks checks if Electron reports an asynchronous installation failure', async () => {
    const { service, updater } = await downloaded();
    await service.install(async () => {});
    updater.emit('error', new Error('private installer output'));
    expect(service.snapshot().state).toBe('error');
    expect(service.snapshot().message).not.toContain('private');
    expect(service.check().state).toBe('checking');
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(2);
  });

  it('rejects unsafe feeds and malformed settings, with compatible defaults', () => {
    expect(parseReleaseConfig({})).toMatchObject({ signedRelease: false });
    for (const updateFeedUrl of [
      'http://example.com', 'https://u:p@example.com', 'https://localhost/', 'https://updates.localhost/',
      'https://updates.local/', 'https://updates.internal/', 'https://127.0.0.1/', 'https://172.16.1.2/',
      'https://[::1]/', 'https://example.com/?token=secret', 'https://example.com/#fragment',
      'https://example.com:8443/', 'https://example.com/{unknown}/updates',
    ]) expect(() => parseReleaseConfig({ ...config, updateFeedUrl })).toThrow();
    expect(() => parseReleaseConfig({ ...config, updateFeedType: 'invalid' })).toThrow();
    expect(() => parseReleaseConfig({ ...config, teamId: null })).toThrow();
    expect(parseReleaseConfig(config)).toEqual({ ...config, updateFeedType: 'default', privateDownloadUrl: null });
    expect(parseReleaseConfig({ ...config, updateFeedUrl: null })).toEqual({ ...config, updateFeedType: 'default', privateDownloadUrl: null, updateFeedUrl: null });
  });

  it('shows private manual downloads with the installed version without activating automatic updates', async () => {
    const privateDownloadUrl = 'https://github.com/TheRealPress1/ULTIMATE-VIDEO-EDITO/releases/latest';
    for (const signedRelease of [false, true]) {
      const parsed = parseReleaseConfig({ ...config, signedRelease, privateDownloadUrl, updateFeedUrl: null });
      const { service, updater, verifySignature } = fixture({ config: parsed });
      await service.initialize();
      expect(service.snapshot()).toMatchObject({
        state: 'unavailable', currentVersion: '1.2.3', privateDownloadUrl,
        message: 'This installation uses manual updates.',
      });
      expect(verifySignature).not.toHaveBeenCalled();
      expect(updater.setFeedURL).not.toHaveBeenCalled();
      expect(updater.checkForUpdates).not.toHaveBeenCalled();
    }
  });

  it('allows only credential-free GitHub releases pages for private downloads', () => {
    for (const privateDownloadUrl of [
      'http://github.com/owner/repo/releases', 'https://github.com.evil.test/owner/repo/releases',
      'https://user:secret@github.com/owner/repo/releases', 'https://github.com/owner/repo/releases?token=secret',
      'https://github.com/owner/repo/releases#secret', 'https://github.com/owner/repo',
      'https://api.github.com/repos/owner/repo/releases', 'https://github.com:8443/owner/repo/releases',
      'https://github.com/owner/repo/releases/download/file.dmg', 'file:///private/secret', '', 123,
    ]) expect(() => parseReleaseConfig({ ...config, privateDownloadUrl })).toThrow();
    expect(parseReleaseConfig({ privateDownloadUrl: 'https://github.com/owner/repo/releases/' }).privateDownloadUrl)
      .toBe('https://github.com/owner/repo/releases');
    expect(parseReleaseConfig({}).privateDownloadUrl).toBeNull();
  });

  it('retains the manual download fallback through automatic updater state changes', async () => {
    const privateDownloadUrl = 'https://github.com/owner/repo/releases/latest';
    const { service, updater } = fixture({ config: { ...config, privateDownloadUrl } });
    await service.initialize();
    service.check();
    updater.emit('update-downloaded', {}, 'notes', '1.3.0');
    expect(service.snapshot()).toMatchObject({ state: 'ready', privateDownloadUrl });
    await service.install(async () => {});
    expect(service.snapshot()).toMatchObject({ state: 'installing', privateDownloadUrl });
  });
});
