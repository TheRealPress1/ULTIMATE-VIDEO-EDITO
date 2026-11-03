// Prepare a release version without committing, tagging, pushing, or publishing.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { isEntryPoint } from './lib/entry-point.mjs';
import { npm } from './lib/npm.mjs';
import { stableVersion } from './lib/release-artifacts.mjs';
import { compareVersions } from './update-feed.mjs';

export function nextVersion(current, bump) {
  stableVersion(current);
  let next = bump;
  const [major, minor, patch] = current.split('.').map(Number);
  if (bump === 'major') next = `${major + 1}.0.0`;
  else if (bump === 'minor') next = `${major}.${minor + 1}.0`;
  else if (bump === 'patch') next = `${major}.${minor}.${patch + 1}`;
  stableVersion(next);
  assert(compareVersions(next, current) > 0, 'Release version must increase.');
  return next;
}

function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { 'dry-run': { type: 'boolean' } } });
  assert(positionals.length === 1, 'Usage: npm run release -- <patch|minor|major|x.y.z> [--dry-run]');
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const files = ['package.json', 'apps/desktop/package.json', 'apps/cli/package.json', 'apps/web/package.json'];
  const originals = new Map([...files, 'package-lock.json'].map(file => [file, readFileSync(join(root, file), 'utf8')]));
  const current = JSON.parse(originals.get('package.json')).version;
  const next = nextVersion(current, positionals[0]);
  for (const file of files) assert.equal(JSON.parse(originals.get(file)).version, current, `Version mismatch in ${file}.`);
  console.log(`${current} -> ${next}${values['dry-run'] ? ' (preview only)' : ''}`);
  if (values['dry-run']) return;
  try {
    for (const file of files) writeFileSync(join(root, file), JSON.stringify({ ...JSON.parse(originals.get(file)), version: next }, null, 2) + '\n');
    npm(['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: root });
  } catch (error) {
    for (const [file, text] of originals) writeFileSync(join(root, file), text);
    throw error;
  }
  console.log('Version prepared. Run the release checks and signed build in docs/releasing.md. Git history and hosted releases are unchanged.');
}
if (isEntryPoint(import.meta.url)) main();
