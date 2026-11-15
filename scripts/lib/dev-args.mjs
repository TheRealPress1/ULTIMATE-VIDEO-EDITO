/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * How `electron-forge start` is called. What follows `npm run dev:desktop --` goes to the app, which is how a
 * development run gets a data folder of its own (`--user-data-dir=/absolute/path`) instead of sharing an installed
 * Blackout's chats, settings and saved keys.
 */
export function forgeStartArgs(extra) {
  return extra.length ? ['start', '--', ...extra] : ['start'];
}

/** Whether the arguments give the app a data folder of its own. Chromium reads a switch's value after an equals sign only. */
export const hasOwnProfile = (extra) => extra.some((arg) => arg.startsWith('--user-data-dir='));
