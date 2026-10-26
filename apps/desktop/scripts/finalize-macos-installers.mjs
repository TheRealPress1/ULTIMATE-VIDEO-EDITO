import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { resolveReleaseSettings } from './release-settings.mjs';

const exec = promisify(execFile);
const defaultServices = {
  run: async (command, args) => { await exec(command, args, { timeout: 120_000, maxBuffer: 1024 * 1024 }); },
  notarize: async (options) => { const { notarize } = await import('@electron/notarize'); await notarize(options); },
};

// App notarization runs before the makers. A DMG needs its own signature and
// ticket after creation, so a downloaded installer also works while offline.
export async function finalizeMacInstallers(artifacts, env = process.env, services = defaultServices) {
  if (env.CUTROOM_RELEASE !== '1') return;
  const settings = resolveReleaseSettings(env, 'darwin');
  const images = artifacts.filter(path => path.endsWith('.dmg'));
  for (const image of images) {
    const path = resolve(image);
    const args = ['--force', '--timestamp', '--sign', settings.osxSign.identity];
    if (settings.osxSign.keychain) args.push('--keychain', settings.osxSign.keychain);
    await services.run('codesign', [...args, path]);
    await services.run('codesign', ['--verify', '--strict', path]);
    await services.notarize({ appPath: path, ...settings.osxNotarize });
    await services.run('xcrun', ['stapler', 'validate', path]);
    await services.run('spctl', ['--assess', '--type', 'open', '--context', 'context:primary-signature', path]);
  }
}
