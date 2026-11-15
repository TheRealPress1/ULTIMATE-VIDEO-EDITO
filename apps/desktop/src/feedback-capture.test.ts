import { describe, expect, it, vi } from 'vitest';

import { captureWindowJpeg } from './feedback-capture';

import type { BrowserWindow } from 'electron';

const image = (width: number, over: Record<string, unknown> = {}) => {
  const self = {
    isEmpty: () => false,
    getSize: () => ({ width, height: 900 }),
    resize: vi.fn(({ width: w }: { width: number }) => image(w)),
    toJPEG: vi.fn(() => Buffer.from('jpeg bytes')),
    ...over,
  };
  return self;
};

const windowOf = (shot: (...args: unknown[]) => Promise<unknown>, destroyed = false) =>
  ({ isDestroyed: () => destroyed, webContents: { capturePage: shot } }) as unknown as BrowserWindow;

describe('capturing the window for a report', () => {
  it('returns a JPEG data URL, and leaves a window that is narrow enough alone', async () => {
    const shot = image(1440);
    const out = await captureWindowJpeg(windowOf(async () => shot));
    expect(out).toBe(`data:image/jpeg;base64,${Buffer.from('jpeg bytes').toString('base64')}`);
    expect(shot.resize).not.toHaveBeenCalled();
    expect(shot.toJPEG).toHaveBeenCalledWith(80);
  });

  it('takes the picture without making a hidden window visible', async () => {
    const capturePage = vi.fn(async () => image(1440));
    await captureWindowJpeg(windowOf(capturePage));
    expect(capturePage).toHaveBeenCalledWith(undefined, { stayHidden: true });
  });

  it('shrinks a wide window to 1600 pixels first', async () => {
    const shot = image(2880);
    await captureWindowJpeg(windowOf(async () => shot));
    expect(shot.resize).toHaveBeenCalledWith({ width: 1600, quality: 'good' });
  });

  it('returns nothing when there is no window, it is gone, or it cannot be captured', async () => {
    expect(await captureWindowJpeg(null)).toBeNull();
    expect(await captureWindowJpeg(windowOf(async () => image(1), true))).toBeNull();
    expect(await captureWindowJpeg(windowOf(async () => image(1440, { isEmpty: () => true })))).toBeNull();
    expect(await captureWindowJpeg(windowOf(async () => image(1440, { toJPEG: () => Buffer.alloc(0) })))).toBeNull();
    expect(await captureWindowJpeg(windowOf(async () => { throw new Error('no'); }))).toBeNull();
  });
});
