/**
 * The picture that goes with a report: the app window as it is, as a JPEG data URL, small enough to send.
 * It is taken when the person asks for the dialog, before the dialog is on screen, so the dialog is not in it.
 */

import type { BrowserWindow } from 'electron';

const MAX_WIDTH = 1600;
const QUALITY = 80;

export async function captureWindowJpeg(window: BrowserWindow | null): Promise<string | null> {
  if (!window || window.isDestroyed()) return null;

  try {
    const image = await window.webContents.capturePage(undefined, { stayHidden: true });
    if (image.isEmpty()) return null;

    const { width } = image.getSize();
    const scaled = width > MAX_WIDTH ? image.resize({ width: MAX_WIDTH, quality: 'good' }) : image;
    const jpeg = scaled.toJPEG(QUALITY);
    return jpeg.length ? `data:image/jpeg;base64,${jpeg.toString('base64')}` : null;
  } catch {
    // No picture is better than no report.
    return null;
  }
}
