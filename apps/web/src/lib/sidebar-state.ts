/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createStoredSignal } from '@/lib/store';
import { store } from '@/init';

/**
 * Whether the left navigation sidebar is shown: one setting for the editor
 * and the dashboard, kept between launches. Anything stored but `false`
 * counts as shown, so a damaged value can never leave the sidebar hidden.
 */
const [shown, setShown] = createStoredSignal(
  store.define<boolean>('layout.sidebarOpen', true, (value) => value !== false),
);

export const sidebarOpen = shown;
export const setSidebarOpen = setShown;
export const toggleSidebar = () => setShown(!shown());

/**
 * Windows draws its own title bar across the first row, which lines up with
 * the sidebar below it, so there the sidebar stays put.
 */
export const sidebarCanClose = (): boolean => typeof window === 'undefined' || window.desktop?.platform !== 'win32';

/** Whether the sidebar is on screen: shown, or unable to close. */
export const sidebarShown = (): boolean => shown() || !sidebarCanClose();

/**
 * ⌥⌘S (Ctrl+Alt+S elsewhere), the Show/Hide Sidebar shortcut of macOS apps.
 * Matched by key code, since ⌥ changes the character the key types.
 */
export function isSidebarShortcut(
  event: Pick<KeyboardEvent, 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'repeat' | 'code'>,
): boolean {
  return (event.metaKey || event.ctrlKey) && event.altKey && !event.shiftKey && !event.repeat && event.code === 'KeyS';
}
