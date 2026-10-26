import { isIP } from 'node:net';
import type { ReleaseConfig, UpdateStatus } from './update-types';

type Updater = {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  setFeedURL(options: { url: string; serverType?: 'default' | 'json' }): void;
  checkForUpdates(): void;
  quitAndInstall(): void;
};
type UpdateOptions = {
  updater: Updater;
  version: string;
  platform: string;
  arch: string;
  config: ReleaseConfig;
  verifySignature: () => Promise<boolean>;
};

function parsePrivateDownloadUrl(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new Error('Invalid private downloads configuration.');
  const url = new URL(value);
  const path = url.pathname.replace(/\/$/, '');
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.username || url.password
    || url.port || url.search || url.hash || !/^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/releases(?:\/latest)?$/.test(path)) {
    throw new Error('Private downloads must use a GitHub releases page without credentials or query parameters.');
  }
  url.pathname = path;
  return url.href;
}

export function parseReleaseConfig(value: unknown): ReleaseConfig {
  const row = value as Partial<ReleaseConfig> | null;
  const privateDownloadUrl = parsePrivateDownloadUrl(row?.privateDownloadUrl);
  if (!row || row.signedRelease !== true) {
    return { updateFeedUrl: null, privateDownloadUrl, teamId: null, signedRelease: false };
  }
  if (typeof row.teamId !== 'string' || !/^[A-Z0-9]{10}$/.test(row.teamId)
    || (row.updateFeedType !== undefined && !['default', 'json'].includes(row.updateFeedType))) {
    throw new Error('Invalid release update configuration.');
  }
  const updateFeedType = row.updateFeedType ?? 'default';
  if (row.updateFeedUrl === null) {
    return { updateFeedUrl: null, updateFeedType, privateDownloadUrl, teamId: row.teamId, signedRelease: true };
  }
  if (typeof row.updateFeedUrl !== 'string') throw new Error('Invalid release update configuration.');
  const url = new URL(row.updateFeedUrl);
  const hostname = url.hostname.replace(/\.$/, '');
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search || url.port
    || isIP(hostname.replace(/^\[|\]$/g, '')) || !hostname.includes('.')
    || /(?:^|\.)(?:localhost|local|internal)$/.test(hostname)) {
    throw new Error('Updates require a public HTTPS feed.');
  }
  // Placeholders are allowed only in the path, never in the host or credentials.
  const path = decodeURI(url.pathname).replace(/\{(?:platform|arch)\}/g, '');
  if (/[{}]/.test(path) || /[%{}]/.test(hostname)) throw new Error('Invalid update feed placeholders.');
  return { updateFeedUrl: url.href, updateFeedType, privateDownloadUrl, teamId: row.teamId, signedRelease: true };
}

/** Checks are explicit. Downloads never interrupt an export or restart without a durable save. */
export class ReleaseUpdates {
  private state: UpdateStatus;
  private configured = false;
  private installing = false;
  private initialization: Promise<void> | undefined;
  private readonly options: UpdateOptions;
  private readonly privateDownloadUrl: string | undefined;

  constructor(options: UpdateOptions) {
    this.options = options;
    this.privateDownloadUrl = parsePrivateDownloadUrl(options.config.privateDownloadUrl) ?? undefined;
    this.state = {
      state: 'unavailable', currentVersion: options.version,
      message: this.privateDownloadUrl ? 'This installation uses manual updates.' : 'Updates are available in a signed UVE release.',
      privateDownloadUrl: this.privateDownloadUrl,
    };
    options.updater.on('checking-for-update', () => {
      if (this.canReceiveDownload()) this.update('checking', 'Checking for an update…');
    });
    options.updater.on('update-available', () => {
      if (this.canReceiveDownload()) this.update('downloading', 'Downloading the signed update…');
    });
    options.updater.on('update-not-available', () => {
      if (this.canReceiveDownload()) this.update('idle', 'You have the latest available version.');
    });
    options.updater.on('error', () => {
      // An unrelated late callback must not discard a successfully downloaded update.
      if (this.configured && this.state.state !== 'ready') {
        this.installing = false;
        this.update('error', 'The update could not be checked or installed. Your current app is unchanged. Try again later.');
      }
    });
    options.updater.on('update-downloaded', (_event, _notes, name) => {
      if (!this.canReceiveDownload()) return;
      this.state = {
        state: 'ready', currentVersion: options.version,
        message: 'Update downloaded. Save and restart to install it.',
        releaseName: typeof name === 'string' ? name.slice(0, 100) : undefined,
        privateDownloadUrl: this.privateDownloadUrl,
      };
    });
  }

  private update(state: UpdateStatus['state'], message: string): void {
    this.state = { state, currentVersion: this.options.version, message, privateDownloadUrl: this.privateDownloadUrl };
  }

  private canReceiveDownload(): boolean {
    return this.configured && (this.state.state === 'checking' || this.state.state === 'downloading');
  }

  snapshot(): UpdateStatus { return { ...this.state }; }

  initialize(): Promise<void> {
    return this.initialization ??= this.configure();
  }

  private async configure(): Promise<void> {
    const { config, platform, arch, version } = this.options;
    if (platform !== 'darwin' || !['arm64', 'x64'].includes(arch)) {
      this.update('unavailable', 'Automatic updates are available for the macOS release.');
      return;
    }
    if (!config.signedRelease) return;
    if (!config.updateFeedUrl) {
      this.update('unavailable', this.privateDownloadUrl
        ? 'This installation uses manual updates.' : 'This signed release does not have an update feed configured.');
      return;
    }
    try {
      if (!await this.options.verifySignature()) {
        this.update('unavailable', 'Updates are unavailable because this installation could not be verified.');
        return;
      }
      const parsed = parseReleaseConfig(config);
      const feed = parsed.updateFeedUrl!.replace(/\{(platform|arch)\}|%7B(platform|arch)%7D/gi,
        (_match, literal: string | undefined, encoded: string | undefined) =>
          (literal ?? encoded)?.toLowerCase() === 'platform' ? platform : arch);
      const url = new URL(feed);
      if (parsed.updateFeedType === 'json') {
        this.options.updater.setFeedURL({ url: url.href, serverType: 'json' });
      } else {
        url.searchParams.set('version', version);
        url.searchParams.set('platform', platform);
        url.searchParams.set('arch', arch);
        this.options.updater.setFeedURL({ url: url.href });
      }
      this.configured = true;
      this.update('idle', 'Check for a new signed UVE release. Available updates download after checking.');
    } catch {
      this.update('unavailable', 'Updates could not be initialized. Reopen UVE to try again.');
    }
  }

  check(): UpdateStatus {
    if (!this.configured) throw new Error(this.state.message);
    if (this.installing || ['checking', 'downloading', 'ready', 'installing'].includes(this.state.state)) return this.snapshot();
    this.update('checking', 'Checking for an update…');
    try { this.options.updater.checkForUpdates(); }
    catch { this.update('error', 'The update check could not start. Try again later.'); }
    return this.snapshot();
  }

  async install(prepare: () => Promise<void>): Promise<void> {
    if (!this.configured || this.state.state !== 'ready' || this.installing) {
      throw new Error('No downloaded update is ready to install.');
    }
    const ready = this.snapshot();
    this.installing = true;
    this.state = { ...ready, state: 'installing', message: 'Saving your work and restarting to install the update…' };
    try { await prepare(); }
    catch (error) {
      this.installing = false;
      if (this.state.state === 'installing') this.state = ready;
      throw error;
    }
    if (this.snapshot().state !== 'installing') {
      this.installing = false;
      throw new Error('The update could not be installed. Check for the update again.');
    }
    try { this.options.updater.quitAndInstall(); }
    catch {
      this.installing = false;
      this.state = ready;
      throw new Error('The update could not restart UVE. Your work is saved; try again.');
    }
    // Keep installation locked after success: Electron closes windows asynchronously.
    if (this.snapshot().state === 'error') {
      this.installing = false;
      throw new Error('The update could not be installed. Check for the update again.');
    }
  }
}
