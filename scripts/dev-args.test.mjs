/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// A development run shares its data folder with an installed Blackout unless it is given one of its own, so
// `npm run dev:desktop -- --user-data-dir=/absolute/path` has to reach the app.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { forgeStartArgs, hasOwnProfile } from './lib/dev-args.mjs';

test('starts the app with nothing extra by default', () => {
  assert.deepEqual(forgeStartArgs([]), ['start']);
});

test('passes what the person added to the app, after forge\'s own double dash', () => {
  assert.deepEqual(forgeStartArgs(['--user-data-dir=/tmp/p', '--hidden']), ['start', '--', '--user-data-dir=/tmp/p', '--hidden']);
});

test('knows whether the run has a data folder of its own', () => {
  assert.equal(hasOwnProfile([]), false);
  assert.equal(hasOwnProfile(['--hidden']), false);
  assert.equal(hasOwnProfile(['--user-data-dir=/tmp/p']), true);
  // Chromium reads a switch's value after an equals sign only; a bare `--user-data-dir` names no folder.
  assert.equal(hasOwnProfile(['--user-data-dir']), false);
});
