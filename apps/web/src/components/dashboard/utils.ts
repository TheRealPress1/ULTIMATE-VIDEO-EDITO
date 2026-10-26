/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

export function parseTimestamp(value: string): number {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

export function formatEditedAt(modifiedAt: string): string {
  const timestamp = parseTimestamp(modifiedAt);
  if (!timestamp) return "Edited just now";

  const elapsedMs = Date.now() - timestamp;
  if (elapsedMs < 60_000) return "Edited just now";

  const minutes = Math.floor(elapsedMs / 60_000);
  if (minutes < 60) return `Edited ${minutes} minute${minutes === 1 ? "" : "s"} ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Edited ${hours} hour${hours === 1 ? "" : "s"} ago`;

  const days = Math.floor(hours / 24);
  if (days < 30) return `Edited ${days} day${days === 1 ? "" : "s"} ago`;

  const months = Math.floor(days / 30);
  if (months < 12) return `Edited ${months} month${months === 1 ? "" : "s"} ago`;

  const years = Math.floor(days / 365);
  return `Edited ${years} year${years === 1 ? "" : "s"} ago`;
}

const AVATAR_MAX_SIZE = 256;

export async function cropAndResizeAvatar(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const size = Math.min(bitmap.width, bitmap.height, AVATAR_MAX_SIZE);

  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext("2d")!;

  // Center-crop to square
  const sx = (bitmap.width - Math.min(bitmap.width, bitmap.height)) / 2;
  const sy = (bitmap.height - Math.min(bitmap.width, bitmap.height)) / 2;
  const sSize = Math.min(bitmap.width, bitmap.height);

  ctx.drawImage(bitmap, sx, sy, sSize, sSize, 0, 0, size, size);
  bitmap.close();

  return await canvas.convertToBlob({ type: "image/webp", quality: 0.8 });
}
