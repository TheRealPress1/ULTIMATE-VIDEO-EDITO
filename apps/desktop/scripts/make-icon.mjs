#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Renders assets/icon.svg into the desktop icon set:
//
//   icon.png, icon-dev.png    macOS artwork, 1024 px: the opaque square as drawn. macOS 26 masks and
//                             lights it itself; an icon with transparent corners or a tile of its own
//                             is put on a gray plate instead
//   icon.icns                 from icon.png, through make-icns.sh
//   icon.ico                  Windows: the square cut to a squircle, 16 to 256 px
//   tray/idleTemplate         the menu bar marks, black on transparent, 18 px and @2x;
//   tray/busyTemplate         busy adds a solid core inside the ring
//   tray/win                  the Windows tray icon: the Windows artwork at 18 px and @2x
//
//   npm run make:icon
//
// Needs sharp, which npm installs with the web app's @huggingface/transformers.
// The tray menu glyphs (tray/menu) are drawn by scripts/generate-icons.py.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const here = dirname(fileURLToPath(import.meta.url));
const assets = join(here, '..', 'assets');
const source = readFileSync(join(assets, 'icon.svg'), 'utf8');

/** A continuous-corner rounded square (superellipse, n = 5) filling the 1024 canvas, as an SVG path. */
function squircle(steps = 400) {
  const point = (t) => {
    const [c, s] = [Math.cos(t), Math.sin(t)];
    return `${(512 + 512 * Math.sign(c) * Math.abs(c) ** 0.4).toFixed(2)},${(512 + 512 * Math.sign(s) * Math.abs(s) ** 0.4).toFixed(2)}`;
  };
  return `M${Array.from({ length: steps }, (_, i) => point((i / steps) * 2 * Math.PI)).join('L')}Z`;
}

// The macOS artwork is the SVG as drawn. Windows and the tray want the rounded shape, so cut it.
const mac = await sharp(Buffer.from(source)).resize(1024, 1024, { kernel: 'lanczos3' }).png().toBuffer();
const windows = await sharp(mac)
  .composite([{ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024"><path d="${squircle()}"/></svg>`), blend: 'dest-in' }])
  .png()
  .toBuffer();

writeFileSync(join(assets, 'icon.png'), mac);
writeFileSync(join(assets, 'icon-dev.png'), mac);
execFileSync('sh', ['scripts/make-icns.sh'], { cwd: join(here, '..'), stdio: 'inherit' });

/** An .ico of PNG frames, which Windows reads at every size. */
function ico(frames) {
  const head = Buffer.alloc(6 + 16 * frames.length);
  head.writeUInt16LE(1, 2); // image type: icon
  head.writeUInt16LE(frames.length, 4);
  let offset = head.length;
  frames.forEach(({ size, png }, i) => {
    const at = 6 + 16 * i;
    head.writeUInt8(size === 256 ? 0 : size, at); // 0 means 256
    head.writeUInt8(size === 256 ? 0 : size, at + 1);
    head.writeUInt16LE(1, at + 4); // colour planes
    head.writeUInt16LE(32, at + 6); // bits per pixel
    head.writeUInt32LE(png.length, at + 8);
    head.writeUInt32LE(offset, at + 12);
    offset += png.length;
  });
  return Buffer.concat([head, ...frames.map(({ png }) => png)]);
}

const sizes = [16, 24, 32, 48, 64, 128, 256];
const frames = await Promise.all(sizes.map(async (size) => ({ size, png: await sharp(windows).resize(size, size, { kernel: 'lanczos3' }).png().toBuffer() })));
writeFileSync(join(assets, 'icon.ico'), ico(frames));
console.log('wrote assets/icon.ico');

// The same mark as the in-app one (apps/web): a corona ring broken by a four-point flare. Menu
// bar marks are one colour, so the busy state adds a solid core inside the ring.
const ring = '<path d="M17.23 4.83A9.2 9.2 0 1 0 21.78 10.25" fill="none" stroke="#000" stroke-width="2.2"/>';
const flare = '<path d="M20.05 2.79 20.9 6.24 24.35 7.09 20.9 7.94 20.05 11.39 19.2 7.94 15.75 7.09 19.2 6.24Z"/>';
const trayMark = (busy, size) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 26 26" fill="#000">`
  + `${ring}${busy ? '<circle cx="13" cy="13" r="3.4"/>' : ''}${flare}</svg>`;

for (const [suffix, size] of [['', 18], ['@2x', 36]]) {
  for (const [name, busy] of [['idleTemplate', false], ['busyTemplate', true]]) {
    writeFileSync(join(assets, 'tray', `${name}${suffix}.png`), await sharp(Buffer.from(trayMark(busy, size))).png().toBuffer());
  }
  writeFileSync(join(assets, 'tray', `win${suffix}.png`), await sharp(windows).resize(size, size, { kernel: 'lanczos3' }).png().toBuffer());
}
console.log('wrote assets/tray/{idleTemplate,busyTemplate,win}{,@2x}.png');
