import { mkdir,writeFile } from 'node:fs/promises';
import { dirname,join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveReleaseSettings } from './release-settings.mjs';
const root=join(dirname(fileURLToPath(import.meta.url)),'..');
const { releaseConfig }=resolveReleaseSettings();
await mkdir(join(root,'dist'),{recursive:true});
await writeFile(join(root,'dist','release-config.json'),JSON.stringify(releaseConfig,null,2)+'\n');
