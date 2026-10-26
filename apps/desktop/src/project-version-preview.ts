/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
import { inflateSync } from "node:zlib";

const PREFIX = "data:image/png;base64,";
export const PROJECT_VERSION_PREVIEW_LIMIT = 1_000_000;
const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Only a small, complete, non-interlaced PNG can become a version thumbnail. */
export function validateVersionPreview(value: unknown): string {
  const fail = (): never => { throw new Error("Version preview must be a complete PNG below 1 MB and at most 2048 × 2048 pixels."); };
  if (typeof value !== "string" || value.length > PROJECT_VERSION_PREVIEW_LIMIT || !value.startsWith(PREFIX)) return fail();
  const encoded = value.slice(PREFIX.length);
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) return fail();
  const png = Buffer.from(encoded, "base64");
  if (!png.subarray(0, 8).equals(signature)) return fail();
  let offset = 8;
  let width = 0;
  let height = 0;
  let channels = 0;
  let depth = 0;
  let ended = false;
  const image: Buffer[] = [];
  while (offset < png.length) {
    if (offset + 12 > png.length || ended) return fail();
    const length = png.readUInt32BE(offset);
    if (offset + length + 12 > png.length) return fail();
    const type = png.toString("ascii", offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + length);
    if (crc32(png.subarray(offset + 4, offset + 8 + length)) !== png.readUInt32BE(offset + 8 + length)) return fail();
    if (offset === 8 && type !== "IHDR") return fail();
    if (type === "IHDR") {
      if (width || length !== 13) return fail();
      width = data.readUInt32BE(0); height = data.readUInt32BE(4); depth = data[8];
      channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as { [key: number]: number })[data[9]] ?? 0;
      if (!width || !height || width > 2048 || height > 2048 || width * height > 2_073_600 || !channels || ![1, 2, 4, 8, 16].includes(depth) || data[10] || data[11] || data[12]) return fail();
      if ([2, 4, 6].includes(data[9]) && depth < 8) return fail();
      if (data[9] === 3 && depth > 8) return fail();
    } else if (type === "IDAT") image.push(data);
    else if (type === "IEND") { if (length) return fail(); ended = true; }
    else if (type === "acTL" || type === "fcTL" || type === "fdAT") return fail();
    offset += length + 12;
  }
  if (!ended || !image.length) return fail();
  const expected = (Math.ceil(width * channels * depth / 8) + 1) * height;
  try {
    const pixels = inflateSync(Buffer.concat(image), { maxOutputLength: expected });
    if (pixels.length !== expected) return fail();
    const stride = expected / height;
    for (let row = 0; row < height; row++) if (pixels[row * stride] > 4) return fail();
  } catch { return fail(); }
  return value;
}
