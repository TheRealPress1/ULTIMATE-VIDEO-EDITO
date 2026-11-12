import assert from 'node:assert/strict';
import { parseArgs } from 'node:util';
import { basename, dirname, join, resolve } from 'node:path';
import { realpath } from 'node:fs/promises';
import { atomicJson, verifyMacApp, verifyMacDmg, withVerifiedZip } from './lib/release-artifacts.mjs';

const { values } = parseArgs({ options: Object.fromEntries(['app', 'zip', 'dmg', 'team', 'output'].map(name => [name, { type: 'string' }])) });
assert(values.app && values.zip && values.dmg && values.team, 'Usage: node scripts/verify-macos-release.mjs --app Blackout.app --zip release.zip --dmg release.dmg --team TEAMID --output verification.json');
if (values.output) {
  const output = join(await realpath(dirname(resolve(values.output))), basename(values.output)).toLowerCase();
  const app = (await realpath(values.app)).toLowerCase();
  assert(output !== app && !output.startsWith(app + '/'), 'Verification output must be outside the signed app.');
  for (const path of [values.zip, values.dmg]) assert.notEqual(output, (await realpath(path)).toLowerCase(), 'Verification output must not replace an artifact.');
}
const app = await verifyMacApp(values.app, values.team);
const zip = await withVerifiedZip(values.zip, values.team);
for (const key of ['version', 'arch', 'teamId', 'cdhash']) assert.equal(zip[key], app[key], `ZIP and staged app disagree: ${key}`);
const dmg = await verifyMacDmg(values.dmg, values.team, app);
const report = { ok: true, verifiedAt: new Date().toISOString(), app: { path: resolve(values.app), ...app }, zip: { path: resolve(values.zip), ...zip }, dmg: { path: resolve(values.dmg), ...dmg } };
if (values.output) await atomicJson(values.output, report);
console.log(JSON.stringify(report, null, 2));
