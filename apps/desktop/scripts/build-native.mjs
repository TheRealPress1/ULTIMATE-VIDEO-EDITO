/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Compiles the macOS corner-radius addon (src/native/corner_radius.m) into
// dist/corner_radius.node. Node-API is ABI-stable, so a plain clang build
// works across Electron versions; node_api symbols resolve from the Electron
// binary at load time via -undefined dynamic_lookup.

import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'darwin') process.exit(0);

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
execFileSync(process.execPath,[join(root,'scripts','build-audio-tools.mjs')],{stdio:'inherit'});
execFileSync(process.execPath,[join(root,'scripts','build-speaker-model.mjs')],{stdio:'inherit'});
mkdirSync(join(root, 'dist'), { recursive: true });

execFileSync(
  'clang',
  [
    join(root, 'src', 'native', 'corner_radius.m'),
    '-o', join(root, 'dist', 'corner_radius.node'),
    '-dynamiclib',
    '-undefined', 'dynamic_lookup',
    '-fobjc-arc',
    '-framework', 'AppKit',
    '-framework', 'QuartzCore',
    '-arch', 'arm64',
    '-arch', 'x86_64',
    '-mmacosx-version-min=11.0',
    '-DNAPI_VERSION=8',
    '-Wall',
    '-Werror',
  ],
  { stdio: 'inherit' },
);

// Apple Vision supplies an offline face detector; AVFoundation decodes and
// orients source frames without a separately installed ffmpeg or model.
execFileSync(
  'swiftc',
  [
    '-parse-as-library', '-O',
    '-target', `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macosx13.0`,
    join(root, 'src', 'native', 'reframe_vision.swift'),
    '-o', join(root, 'dist', 'reframe-vision'),
    '-framework', 'Foundation', '-framework', 'AVFoundation', '-framework', 'Vision', '-framework', 'CoreGraphics',
  ],
  { stdio: 'inherit' },
);

execFileSync('swiftc',[
  '-parse-as-library','-O','-target',`${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macosx13.0`,
  join(root,'src','native','visual_vision.swift'),'-o',join(root,'dist','visual-vision'),
  '-framework','Foundation','-framework','AVFoundation','-framework','Vision','-framework','CoreGraphics',
],{stdio:'inherit'});

for (const [source, binary, frameworks] of [
  ['speaker_analysis.swift', 'speaker-analysis', ['Foundation', 'AVFoundation', 'Vision', 'CoreGraphics', 'CoreImage', 'CoreML', 'Accelerate']],
  ['reference_style.swift', 'reference-style', ['Foundation', 'AVFoundation', 'Vision', 'CoreGraphics']],
  ['playback-proxy.swift', 'playback-proxy', ['Foundation', 'AVFoundation', 'CoreImage', 'CoreVideo', 'CoreMedia', 'VideoToolbox']],
]) {
  execFileSync('swiftc', [
    '-parse-as-library', '-O', '-target', `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macosx13.0`,
    join(root, 'src', 'native', source), '-o', join(root, 'dist', binary),
    ...frameworks.flatMap((name) => ['-framework', name]),
  ], { stdio: 'inherit' });
}
