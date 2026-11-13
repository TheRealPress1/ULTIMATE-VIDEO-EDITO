import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const target = vi.hoisted(() => new EventTarget());
vi.hoisted(() => {
  // The module listens on `window` as it loads.
  (globalThis as { window?: unknown }).window = undefined;
});

let whenPointerIdle: () => Promise<void>;
beforeAll(async () => {
  vi.stubGlobal('window', target);
  ({ whenPointerIdle } = await import('./pointer-idle'));
});
afterEach(() => {
  target.dispatchEvent(new Event('pointercancel'));
  vi.useRealTimers();
});

const settled = async (promise: Promise<void>): Promise<boolean> => {
  let done = false;
  void promise.then(() => { done = true; });
  await Promise.resolve();
  await Promise.resolve();
  return done;
};

describe('whenPointerIdle', () => {
  it('resolves at once when no pointer is held', async () => {
    expect(await settled(whenPointerIdle())).toBe(true);
  });

  it('waits for the pointer to be released', async () => {
    target.dispatchEvent(new Event('pointerdown'));
    const waiting = whenPointerIdle();
    expect(await settled(waiting)).toBe(false);
    target.dispatchEvent(new Event('pointerup'));
    expect(await settled(waiting)).toBe(true);
  });

  it('also stops waiting when the gesture is cancelled or the window loses focus', async () => {
    for (const end of ['pointercancel', 'blur']) {
      target.dispatchEvent(new Event('pointerdown'));
      const waiting = whenPointerIdle();
      target.dispatchEvent(new Event(end));
      expect(await settled(waiting)).toBe(true);
    }
  });

  it('gives up on a release that never comes', async () => {
    vi.useFakeTimers();
    target.dispatchEvent(new Event('pointerdown'));
    const waiting = whenPointerIdle();
    vi.advanceTimersByTime(9_999);
    expect(await settled(waiting)).toBe(false);
    vi.advanceTimersByTime(2);
    expect(await settled(waiting)).toBe(true);
  });
});
