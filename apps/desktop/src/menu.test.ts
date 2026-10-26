import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ emit: vi.fn(), focusedWindow: vi.fn(), windows: vi.fn(() => []), focusedContents: vi.fn(), setMenu: vi.fn(), buildMenu: vi.fn((template) => template) }));
vi.mock('electron', () => ({ app: { name: 'UVE' }, BrowserWindow: { getFocusedWindow: mocks.focusedWindow, getAllWindows: mocks.windows, fromId: mocks.focusedWindow }, webContents: { getFocusedWebContents: mocks.focusedContents }, Menu: { setApplicationMenu: mocks.setMenu, buildFromTemplate: mocks.buildMenu } }));
vi.mock('./main-manager', () => ({ mainBridge: { emit: mocks.emit } }));
import { historyWindow, routeHistoryMenu, setupAppMenu } from './menu';
import type { BrowserWindow, MenuItemConstructorOptions } from 'electron';
function fixture(editable = false) {
  const contents = { isDestroyed: vi.fn(() => false), executeJavaScript: vi.fn(async () => editable), undo: vi.fn(), redo: vi.fn(), devToolsWebContents: undefined as unknown };
  const window = { isDestroyed: vi.fn(() => false), isVisible: () => true, webContents: contents };
  mocks.focusedWindow.mockReturnValue(window); mocks.focusedContents.mockReturnValue(contents);
  return { window: window as unknown as BrowserWindow, contents };
}
beforeEach(() => { vi.clearAllMocks(); mocks.windows.mockReturnValue([]); });
describe('native Undo/Redo routes', () => {
  it('uses composition history for canvas focus and preserves native DOM history for editable fields', async () => {
    const f = fixture(); await routeHistoryMenu('undo');
    expect(mocks.emit).toHaveBeenCalledWith(f.window, 'editor:history', { direction: 'undo' });
    expect(f.contents.undo).not.toHaveBeenCalled();
    mocks.emit.mockClear(); f.contents.executeJavaScript.mockResolvedValue(true);
    await routeHistoryMenu('redo'); expect(f.contents.redo).toHaveBeenCalledOnce(); expect(mocks.emit).not.toHaveBeenCalled();
  });
  it('leaves devtools text history local and does nothing after its window closes', async () => {
    const f = fixture(); const other = { isDestroyed: () => false, undo: vi.fn(), redo: vi.fn() };
    f.contents.devToolsWebContents = other;
    mocks.focusedContents.mockReturnValue(other); await routeHistoryMenu('undo'); expect(other.undo).toHaveBeenCalledOnce(); expect(mocks.emit).not.toHaveBeenCalled();
    mocks.focusedContents.mockReturnValue(f.contents);
    f.contents.executeJavaScript.mockImplementation(async () => { f.contents.isDestroyed.mockReturnValue(true); return false; });
    await routeHistoryMenu('undo'); expect(mocks.emit).not.toHaveBeenCalled();
  });
  it('routes a background native menu to the sole visible app window without guessing among multiple windows', async () => {
    const f = fixture(); mocks.focusedWindow.mockReturnValue(null); mocks.focusedContents.mockReturnValue(null);
    mocks.windows.mockReturnValue([f.window] as never);
    await routeHistoryMenu('redo'); expect(mocks.emit).toHaveBeenCalledWith(f.window, 'editor:history', { direction: 'redo' });
    mocks.windows.mockReturnValue([f.window, { isDestroyed: () => false, isVisible: () => true }] as never);
    expect(historyWindow()).toBeNull();
  });
  it('does not send a targeted history command to unrelated focused web contents', async () => {
    const f = fixture(); const other = { isDestroyed: () => false, undo: vi.fn() }; mocks.focusedContents.mockReturnValue(other);
    await routeHistoryMenu('undo', f.window); expect(other.undo).not.toHaveBeenCalled();
    expect(mocks.emit).toHaveBeenCalledWith(f.window, 'editor:history', { direction: 'undo' });
  });
  it('registers explicit accelerators without Electron roles that bypass the app callback', () => {
    setupAppMenu(); const template = mocks.buildMenu.mock.calls[0]![0] as MenuItemConstructorOptions[];
    const edit = template.find((item) => item.label === 'Edit')!;
    const entries = edit.submenu as MenuItemConstructorOptions[];
    expect(entries[0]).toMatchObject({ label: 'Undo', accelerator: 'CmdOrCtrl+Z', click: expect.any(Function) });
    expect(entries[1]).toMatchObject({ label: 'Redo', accelerator: 'Shift+CmdOrCtrl+Z', click: expect.any(Function) });
    expect(entries[0]!.role).toBeUndefined(); expect(entries.some((item) => item.role === 'paste')).toBe(true);
  });
});
