import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const KEY = 'cutroom.ui.layout.sidebarOpen';

let storage: Map<string, string>;
beforeEach(() => {
  // The state reads localStorage when the module loads, so each test loads it afresh.
  vi.resetModules();
  storage = new Map();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value); },
    removeItem: (key: string) => { storage.delete(key); },
  });
});
afterEach(() => vi.unstubAllGlobals());

const load = () => import('./sidebar-state');

describe('the sidebar being shown or hidden', () => {
  it('starts shown, and writes that down', async () => {
    const { sidebarOpen } = await load();
    expect(sidebarOpen()).toBe(true);
    expect(JSON.parse(storage.get(KEY)!)).toEqual({ value: true });
  });

  it('toggles, and the next launch finds it as it was left', async () => {
    const first = await load();
    first.toggleSidebar();
    expect(first.sidebarOpen()).toBe(false);
    expect(JSON.parse(storage.get(KEY)!)).toEqual({ value: false });

    vi.resetModules();
    const second = await load();
    expect(second.sidebarOpen()).toBe(false);
    second.toggleSidebar();
    expect(second.sidebarOpen()).toBe(true);
    expect(JSON.parse(storage.get(KEY)!)).toEqual({ value: true });
  });

  it('sets it outright too', async () => {
    const { sidebarOpen, setSidebarOpen } = await load();
    setSidebarOpen(false);
    setSidebarOpen(false);
    expect(sidebarOpen()).toBe(false);
    setSidebarOpen(true);
    expect(sidebarOpen()).toBe(true);
  });

  it.each(['no', 0, 'false', {}])('shows the sidebar when what was stored is %j, not a clear false', async (stored) => {
    storage.set(KEY, JSON.stringify({ value: stored }));
    const { sidebarOpen } = await load();
    expect(sidebarOpen()).toBe(true);
  });
});

describe('where the sidebar can close', () => {
  it('can close in a browser, on macOS and on Linux', async () => {
    const browser = await load();
    expect(browser.sidebarCanClose()).toBe(true);
    for (const platform of ['darwin', 'linux']) {
      vi.stubGlobal('window', { desktop: { platform } });
      expect(browser.sidebarCanClose()).toBe(true);
    }
  });

  it('stays put on Windows, which draws its own title bar over the first row, whatever was stored', async () => {
    storage.set(KEY, JSON.stringify({ value: false }));
    vi.stubGlobal('window', { desktop: { platform: 'win32' } });
    const { sidebarCanClose, sidebarShown, sidebarOpen } = await load();
    expect(sidebarOpen()).toBe(false);
    expect(sidebarCanClose()).toBe(false);
    expect(sidebarShown()).toBe(true);
  });

  it('is on screen when shown, and gone when closed where it can close', async () => {
    const { sidebarShown, toggleSidebar } = await load();
    expect(sidebarShown()).toBe(true);
    toggleSidebar();
    expect(sidebarShown()).toBe(false);
  });
});

describe('the sidebar shortcut', () => {
  const press = (over: Record<string, unknown> = {}) => ({ metaKey: true, ctrlKey: false, altKey: true, shiftKey: false, repeat: false, code: 'KeyS', ...over });

  it('is ⌥⌘S, or Ctrl+Alt+S', async () => {
    const { isSidebarShortcut } = await load();
    expect(isSidebarShortcut(press())).toBe(true);
    expect(isSidebarShortcut(press({ metaKey: false, ctrlKey: true }))).toBe(true);
  });

  it('is not ⌘S, ⌥S, ⇧⌥⌘S, ⌘B (split) or any other key, and not a held key', async () => {
    const { isSidebarShortcut } = await load();
    expect(isSidebarShortcut(press({ altKey: false }))).toBe(false);
    expect(isSidebarShortcut(press({ metaKey: false }))).toBe(false);
    expect(isSidebarShortcut(press({ shiftKey: true }))).toBe(false);
    expect(isSidebarShortcut(press({ code: 'KeyB' }))).toBe(false);
    expect(isSidebarShortcut(press({ repeat: true }))).toBe(false);
  });
});
