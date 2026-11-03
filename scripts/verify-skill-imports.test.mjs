/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFile, cp, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { verifySkillImports } from './verify-skill-imports.mjs';

const scripts = dirname(fileURLToPath(import.meta.url));
const imports = join(scripts, '..', 'docs', 'skills', 'imports');

// Node gives the script its real path but keeps argv[1] as typed; run through
// a link (macOS's /tmp is one), the check used to skip itself and exit 0.
test('run from the command line through a symlinked path, the verifier still checks', async (t) => {
  if (process.platform === 'win32') return t.skip('symlinks need extra rights on Windows');
  const dir = await mkdtemp(join(tmpdir(), 'skill-imports-link-'));
  try {
    const repo = join(dir, 'repo');
    await symlink(join(scripts, '..'), repo, 'dir');
    const run = spawnSync(process.execPath, [join(repo, 'scripts', 'verify-skill-imports.mjs')], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.ok(JSON.parse(run.stdout).verifiedImportedFiles > 0, run.stdout);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('imported by another script, the verifier runs nothing by itself', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'skill-imports-entry-'));
  try {
    const entry = join(dir, 'entry.mjs');
    await writeFile(entry, `import ${JSON.stringify(pathToFileURL(join(scripts, 'verify-skill-imports.mjs')).href)};\n`);
    const run = spawnSync(process.execPath, [entry], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout, '');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/** A scratch copy of the repo's imports, changed by `edit`, then verified. */
async function verifyCopy(edit) {
  const dir = await mkdtemp(join(tmpdir(), 'skill-imports-'));
  try {
    await cp(imports, dir, { recursive: true });
    await edit(dir);
    return await verifySkillImports(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('the repo imports verify, including both adapted earshot skills', async () => {
  const { errors, checked, manifest } = await verifySkillImports(imports);
  assert.deepEqual(errors, []);
  assert.ok(checked > 0);
  const adapted = manifest.imports.filter((item) => item.mode === 'adapted').map((item) => item.path).sort();
  assert.deepEqual(adapted, ['earshot-listening', 'earshot-real-sound']);
});

test('an adapted skill must sit at its folder top level, not anywhere below it', async () => {
  const { errors } = await verifyCopy((dir) => rename(join(dir, 'earshot-real-sound', 'SKILL.md'), join(dir, 'earshot-real-sound', 'references', 'SKILL.md')));
  assert.deepEqual(errors, ['Missing adapted skill: earshot-real-sound/SKILL.md']);
});

test('a missing adapted skill is reported', async () => {
  const { errors } = await verifyCopy((dir) => rm(join(dir, 'earshot-listening', 'SKILL.md')));
  assert.deepEqual(errors, ['Missing adapted skill: earshot-listening/SKILL.md']);
});

test('a changed upstream license and a lost copyright notice are reported', async () => {
  const { errors } = await verifyCopy(async (dir) => {
    await appendFile(join(dir, 'earshot-listening', 'LICENSE'), '\n');
    const design = join(dir, 'earshot-real-sound', 'references', 'sound-design.md');
    await writeFile(design, (await readFile(design, 'utf8')).replaceAll('Copyright (c) 2026 Leon Lin', 'Leon Lin'));
  });
  assert.deepEqual(errors.sort(), [
    'Adapted file lost its copyright notice: earshot-real-sound/references/sound-design.md',
    'Imported file changed: earshot-listening/LICENSE',
  ]);
});
