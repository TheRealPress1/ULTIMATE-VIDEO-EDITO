/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { BrowserWindow, Menu, webContents } from "electron";
import type { MenuItemConstructorOptions } from "electron";
import { mainBridge } from './main-manager';
import { MAIN_CHANNELS } from './main-channels';
import { PRODUCT_NAME } from './product';

/** Native role undo only edits DOM text. Composition history lives in the renderer. */
export function historyWindow(preferred?: BrowserWindow | null): BrowserWindow | null {
  if (preferred && !preferred.isDestroyed()) return preferred;
  const focused = BrowserWindow.getFocusedWindow();
  if (focused && !focused.isDestroyed()) return focused;
  // Accessibility/native menu activation can occur while the app is in the
  // background. There is no focused window then, even though its editor is
  // visible. Only choose an unambiguous destination; never guess among windows.
  const visible = BrowserWindow.getAllWindows().filter((candidate) => !candidate.isDestroyed() && candidate.isVisible());
  return visible.length === 1 ? visible[0]! : null;
}

export async function routeHistoryMenu(direction: 'undo' | 'redo', preferred?: BrowserWindow | null): Promise<void> {
  const window = historyWindow(preferred);
  if (!window || window.isDestroyed()) return;
  const focused = webContents.getFocusedWebContents();
  const target = window.webContents;
  if (target.isDestroyed()) return;
  // Only this window's DevTools gets independent DOM history. Another focused
  // window must not steal an explicitly targeted native menu action.
  if (focused && focused === target.devToolsWebContents && !focused.isDestroyed()) { focused[direction](); return; }
  const editable = await target.executeJavaScript(`(() => {
    let element = document.activeElement;
    while (element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement;
    return element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || Boolean(element?.isContentEditable);
  })()`);
  if (window.isDestroyed() || target.isDestroyed()) return;
  if (editable) target[direction]();
  else mainBridge.emit(window, MAIN_CHANNELS.EDITOR_HISTORY, { direction });
}

function historyMenuItem(direction: 'undo' | 'redo'): MenuItemConstructorOptions {
  return {
    label: direction === 'undo' ? 'Undo' : 'Redo',
    accelerator: direction === 'undo' ? 'CmdOrCtrl+Z' : 'Shift+CmdOrCtrl+Z',
    // A role here would ignore click and silently invoke DOM-only undo again.
    click: (_item, window) => {
      const target = window ? BrowserWindow.fromId(window.id) : BrowserWindow.getFocusedWindow();
      void routeHistoryMenu(direction, target).catch((error) => console.warn('Could not route Undo/Redo:', error));
    },
  };
}

export function setupAppMenu() {
  // The app submenu is a macOS convention. Elsewhere the same role menus sit
  // behind Alt (the window hides the bar) and exist for their accelerators:
  // reload, devtools, zoom, quit.
  const template: MenuItemConstructorOptions[] = []

  if (process.platform === "darwin") {
    // The role labels are built from `app.name`, which is not what people call the app.
    template.push({
      label: PRODUCT_NAME,
      submenu: [
        { role: "about", label: `About ${PRODUCT_NAME}` },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide", label: `Hide ${PRODUCT_NAME}` },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit", label: `Quit ${PRODUCT_NAME}` },
      ],
    });
  }

  template.push(
    { role: "fileMenu" },
    { label: 'Edit', submenu: [
      historyMenuItem('undo'), historyMenuItem('redo'), { type: 'separator' },
      { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'pasteAndMatchStyle' }, { role: 'delete' },
      { type: 'separator' }, { role: 'selectAll' },
      ...(process.platform === 'darwin' ? [{ type: 'separator' as const }, { label: 'Speech', submenu: [{ role: 'startSpeaking' as const }, { role: 'stopSpeaking' as const }] }] : []),
    ] },
    { role: "viewMenu" },
    { role: "windowMenu" },
  );

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
