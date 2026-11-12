/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The sound tools reference and the adapted earshot skills promise behavior
// agents act on; these checks keep the promises that reviews found wrong fixed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const docs = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs');
const files = {
  reference: join(docs, 'reference', 'tools', 'sound.md'),
  listening: join(docs, 'skills', 'imports', 'earshot-listening', 'SKILL.md'),
  realSound: join(docs, 'skills', 'imports', 'earshot-real-sound', 'SKILL.md'),
  soundDesign: join(docs, 'skills', 'imports', 'earshot-real-sound', 'references', 'sound-design.md'),
  licences: join(docs, 'skills', 'imports', 'earshot-real-sound', 'references', 'licences.md'),
};
const read = (path) => readFileSync(path, 'utf8');
const paragraphs = (text) => text.split(/\n\s*\n/);
/** GitHub's heading anchors: lower case, punctuation dropped, spaces to hyphens. */
const anchors = (text) => new Set([...text.matchAll(/^#{1,6}\s+(.+)$/gm)].map(([, title]) => title.trim().toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s/g, '-')));

// audio_finish takes `effectIds` (packages/dapi/src/tools/audio-finish.ts), so the docs name it
// plainly and no longer hedge with a fallback for a tool without it.
const audioFinishText = read(join(dirname(fileURLToPath(import.meta.url)), '..', 'packages', 'dapi', 'src', 'tools', 'audio-finish.ts'));
test('the docs pass effectIds to audio_finish, which takes them, without a stale fallback', () => {
  assert.match(audioFinishText, /effectIds: z\.array/);
  for (const [name, path] of Object.entries(files)) {
    const text = read(path);
    assert.doesNotMatch(text, /if the tool's input has no `effectIds`|`effectIds` when its input has it/i, name);
  }
  for (const path of [files.reference, files.listening, files.realSound]) assert.match(read(path), /`effectIds`/);
});

test('the leveling recipe compares the same meter on the take and the bed', () => {
  const recipe = paragraphs(read(files.listening)).find((text) => text.startsWith('Levels against the music'));
  assert.ok(recipe);
  assert.match(recipe, /reading `rms_dbfs` on both/);
  assert.match(recipe, /50 ms around its loudest moment/);
  assert.match(recipe, /peakSeconds - 0\.025/);
  assert.match(recipe, /Never set one side's `rms_dbfs` against the other's `lufs`/);
  assert.match(recipe, /under 0\.4 s/);
  assert.doesNotMatch(recipe, /and the take itself/);
});

test('Apple silicon is required for both tools, not only the model actions', () => {
  const reference = read(files.reference);
  assert.match(reference, /Both tools need a Mac with Apple silicon, the model-free `sound_effects` included/);
  assert.doesNotMatch(reference, /model actions need a Mac with Apple silicon/);
  assert.doesNotMatch(reference, /for this Mac's architecture/);
  for (const skill of [files.listening, files.realSound]) assert.match(read(skill), /Apple silicon/);
});

test('cancel is not promised to stop an analysis earshot already started', () => {
  for (const path of [files.reference, files.listening]) {
    const text = read(path);
    assert.doesNotMatch(text, /canceling the call stops it/i);
    assert.match(text, /earshot (cannot interrupt|finishes) (an|the) analysis/);
    // What Cutroom does about it instead (worker.ts ends the process), and what that costs.
    assert.match(text, /Blackout ends (its|the) process/);
    assert.match(text, /loads the models again/);
  }
});

const code = join(dirname(fileURLToPath(import.meta.url)), '..');
const toolText = read(join(code, 'packages', 'dapi', 'src', 'tools', 'sound.ts'));
const settingsText = read(join(code, 'apps', 'web', 'src', 'components', 'dashboard', 'audio-intelligence-data.ts'));

test('the install size and the model load time agree across the docs, the tool text and Settings', () => {
  for (const text of [read(files.reference), toolText, settingsText]) assert.match(text, /about 2\.4 GB/);
  for (const text of [read(files.reference), read(files.listening)]) {
    assert.doesNotMatch(text, /about 2\.2 GB|20-60 s/);
    assert.match(text, /about 10 s/);
  }
  assert.match(toolText, /loads the models first \(about 10 s\)/);
});

test('the sound_effects reference describes what the tool returns', () => {
  const reference = read(files.reference);
  const audit = reference.split('\n').find((line) => line.startsWith('| `audit` |'));
  assert.ok(audit);
  assert.doesNotMatch(audit, /measurements/);
  const list = reference.split('\n').find((line) => line.startsWith('| `list` |'));
  assert.match(list, /Without a filter, the bank's categories/);
  assert.match(reference, /also when it is asked for under another `name`/);
  assert.match(reference.split('\n').find((line) => line.startsWith('| `critique` |')), /`profile`/);
});

test('the decoded-audio cache and its growth are documented with the size claims', () => {
  const reference = read(files.reference);
  assert.ok(anchors(reference).has('storage'));
  const storage = reference.slice(reference.indexOf('### Storage'));
  assert.match(storage, /`home\/decoded\/`/);
  assert.match(storage, /about 23 MB per minute of stereo/);
  // addons/earshot/cache.ts trims earshot's caches to a limit; the docs give that limit and the sweep's low-water mark.
  const cacheCode = read(join(code, 'apps', 'desktop', 'src', 'addons', 'earshot', 'cache.ts'));
  assert.match(cacheCode, /CACHE_LIMIT_BYTES = 500 \* 1000 \* 1000/);
  assert.match(cacheCode, /LOW_WATER = 0\.8/);
  assert.match(storage, /keeps them under 500 MB/);
  assert.match(storage, /least recently used entries until they hold less than 400 MB/);
  assert.doesNotMatch(reference, /Nothing evicts them|never evicted/);
  assert.match(storage, /the install's size plus what the caches hold now/);
  assert.match(reference, /Decoded audio, embeddings and results are cached/);
  assert.match(read(files.listening), /decoded copy of every analyzed file and draft/);
});

test('draft exports for sound checks match the export tool, which allows a review draft without a request', () => {
  const exportTool = read(join(code, 'packages', 'dapi', 'src', 'tools', 'export.ts'));
  assert.match(exportTool, /A review draft needs no request: export it to a temporary folder/);
  assert.match(exportTool, /Export a delivery file only when the user asks/);
  assert.doesNotMatch(exportTool, /Only export when asked to/);
  for (const path of [files.reference, files.listening, files.realSound]) {
    const text = read(path);
    assert.doesNotMatch(text, /only export when asked to/i);
    assert.match(text, /export\.md#review-drafts/);
    assert.match(text, /temporary folder/);
  }
});

test('relative links and in-page anchors in the earshot docs resolve', () => {
  for (const [name, path] of Object.entries(files)) {
    const text = read(path);
    for (const [, target] of text.matchAll(/\]\(([^)\s]+)\)/g)) {
      if (/^[a-z]+:/i.test(target)) continue;
      const [file, anchor] = target.split('#');
      const destination = file ? resolve(dirname(path), file) : path;
      assert.ok(existsSync(destination), `${name}: ${target}`);
      if (anchor && destination.endsWith('.md')) assert.ok(anchors(read(destination)).has(anchor), `${name}: ${target}`);
    }
  }
});
