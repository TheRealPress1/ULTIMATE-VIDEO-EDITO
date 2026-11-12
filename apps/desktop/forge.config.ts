/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { MakerDMG } from '@electron-forge/maker-dmg';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { arch } from 'node:os';
import { dirname, join } from 'node:path';
import { assertBuiltReleaseConfig, resolveReleaseSettings } from './scripts/release-settings.mjs';
import { finalizeMacInstallers } from './scripts/finalize-macos-installers.mjs';

import type { ForgeConfig } from '@electron-forge/shared-types';
import type { MakerSquirrelConfig } from '@electron-forge/maker-squirrel';

const { version } = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8'));


const sign = windowsSign();
const release = resolveReleaseSettings();

const config: ForgeConfig = {
  packagerConfig: {
    name: 'Blackout',
    appBundleId: 'app.cutroom.editor',
    appCategoryType: 'public.app-category.video',
    appVersion: version,
    // The bundled Swift media helpers require macOS Ventura or newer.
    extendInfo: { LSMinimumSystemVersion: '13.0' },
    icon: './assets/icon',
    win32metadata: {
      CompanyName: 'Blackout',
      ProductName: 'Blackout',
      FileDescription: 'Blackout video editor',
      'application-manifest': join(__dirname, 'assets', 'app.manifest'),
    },
    protocols: [{ name: 'Blackout', schemes: ['cutroom'] }],
    prune: false,
    ignore: (path) =>
      path !== '' &&
      path !== '/package.json' &&
      path !== '/dist' &&
      !path.startsWith('/dist/') &&
      path !== '/web' &&
      !path.startsWith('/web/'),
    // Staged by scripts/stage-{cli,runtime,docs}.mjs; end up at
    // Contents/Resources/{cli,runtime,docs}.
    extraResource: ['./cli', './runtime', './docs', ...(process.platform === 'darwin' ? ['./speech'] : [])],
    osxSign: release.osxSign,
    osxNotarize: release.osxNotarize,
    windowsSign: sign,
  },
  makers: [
    new MakerZIP({}, ['darwin']),
    new MakerSquirrel({
      // The Windows install folder, kept from when the app was called Cutroom: the CLI shim lives in it too.
      name: 'Cutroom',
      authors: 'Blackout',
      description: 'The professional video editor built for agents',
      exe: 'Blackout.exe',
      setupExe: `Blackout-${process.arch}-Setup.exe`,
      setupIcon: './assets/icon.ico',
      noMsi: true,
      windowsSign: sign,
    }),
    new MakerDMG({
      name: `Blackout-${process.arch}`,
      icon: './assets/icon.icns',
      iconSize: 120,
      additionalDMGOptions: {
        'background-color': '#1c1c1c',
        window: { size: { width: 658, height: 498 } },
      },
      contents: (opts) => [
        { x: 188, y: 217, type: 'file', path: opts.appPath },
        { x: 470, y: 217, type: 'link', path: '/Applications' },
      ],
    }),
  ],
  // Release destinations must be configured for Cutroom before publishing.
  publishers: [],
  hooks: {
    prePackage: async (_config, platform, targetArch) => {
      const expected = resolveReleaseSettings(process.env, platform).releaseConfig;
      assertBuiltReleaseConfig(join(__dirname, 'dist', 'release-config.json'), expected);
      if (platform === 'darwin') {
        const speechDir = join(__dirname, 'speech');
        if (!existsSync(join(speechDir, 'whisper-cli')) || !existsSync(join(speechDir, 'runtime.json'))) {
          throw new Error('Run npm run setup:speech before packaging Blackout on macOS.');
        }
        const runtime = JSON.parse(readFileSync(join(speechDir, 'runtime.json'), 'utf8'));
        if (runtime.platform !== platform || runtime.arch !== targetArch) {
          throw new Error(`Speech runtime targets ${runtime.platform}/${runtime.arch}; rebuild it for ${platform}/${targetArch} before packaging.`);
        }
      }
      if (process.platform === 'win32' && !process.env.SKIP_SIGN && !sign) {
        throw new Error(
          'Windows signing needs WINDOWS_SIGNTOOL_PATH, WINDOWS_SIGN_DLIB and WINDOWS_SIGN_METADATA; set SKIP_SIGN=1 for an unsigned build.',
        );
      }
    },
    preMake: async () => ensure7zip(),
    postMake: async (_config, results) => {
      await finalizeMacInstallers(results.filter(result => result.platform === 'darwin').flatMap(result => result.artifacts));
      return results;
    },
  },
};



function windowsSign() {
  if (process.platform !== 'win32' || process.env.SKIP_SIGN) {
    return undefined;
  }

  const {
    WINDOWS_SIGNTOOL_PATH: signToolPath,
    WINDOWS_SIGN_DLIB: dlib,
    WINDOWS_SIGN_METADATA: metadata
  } = process.env;

  if (!signToolPath || !dlib || !metadata) {
    return undefined;
  }

  return {
    signToolPath,
    automaticallySelectCertificate: false,
    signWithParams: ['/dlib', dlib, '/dmdf', metadata],
    timestampServer: 'http://timestamp.acs.microsoft.com',
    hashes: ['sha256'],
  } as unknown as MakerSquirrelConfig;
}

function ensure7zip() {
  if (process.platform !== 'win32') return;
  const require = createRequire(__filename);
  const winstaller = require.resolve('electron-winstaller/package.json', {
    paths: [dirname(require.resolve('@electron-forge/maker-squirrel/package.json'))],
  });
  const vendor = join(dirname(winstaller), 'vendor');
  for (const ext of ['exe', 'dll']) {
    const target = join(vendor, `7z.${ext}`);
    if (!existsSync(target)) copyFileSync(join(vendor, `7z-${arch()}.${ext}`), target);
  }
}

export default config;
