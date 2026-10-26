/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { AssetLibrary, type Asset, type ImportResult } from '@diffusionstudio/assets';
import { createProjectFS } from './fs';
import type { ProjectInfo } from './host';

/** A newly created draft's first cut, saved before an agent can change it. */
export async function initializeImportedProject(project: ProjectInfo, assets: readonly Asset[]): Promise<boolean> {
	const playable = assets.filter((asset) => asset.type === 'VIDEO' || asset.type === 'SEQUENCE' || asset.type === 'IMAGE' || asset.type === 'AUDIO');
	if (!playable.length) return false;
	const fs = createProjectFS(project.dir);
	const original = await (await fs.file(project.entry)).text();
	// Only the untouched scaffold can be replaced. Even a newly created draft
	// could have been opened or changed by something else during a long import.
	if (original.trim() !== 'export default function Project() {\n  return (\n    <stage background="#161616">\n    </stage>\n  )\n}') return false;

	const sized = playable.find((asset) => 'width' in asset);
	const width = sized && 'width' in sized ? Math.round(sized.width) : 1920;
	const height = sized && 'height' in sized ? Math.round(sized.height) : 1080;
	const scale = Math.min(480 / width, 270 / height);
	let cursor = 0;
	const clips: string[] = [];
	const prop = (value: string) => `{${JSON.stringify(value)}}`;
	for (const [index, asset] of playable.entries()) {
		if (asset.type === 'AUDIO') continue;
		const duration = 'duration' in asset ? asset.duration : 5;
		if (!Number.isFinite(duration) || duration <= 0) continue;
		const tag = asset.type === 'IMAGE' ? 'image' : 'video';
		clips.push(`        <${tag} id="clip-${index + 1}" name=${prop(asset.path)} src=${prop(asset.path)} width={${width}} height={${height}} objectFit="contain" start={${cursor}} end={${cursor + duration}} />`);
		cursor += duration;
	}
	const audio = playable.filter((asset) => asset.type === 'AUDIO');
	const duration = cursor || Math.max(...audio.map((asset) => asset.duration));
	for (const [index, asset] of audio.entries()) {
		clips.push(`        <audio id="audio-${index + 1}" name=${prop(asset.path)} src=${prop(asset.path)} start={0} end={${Math.min(asset.duration, duration)}} />`);
	}
	if (!clips.length) return false;
	const source = `export default function Project() {\n  return (\n    <stage background="#161616" camera={[${scale}, 0, 0, ${scale}, 48, 48]}>\n      <scene id="first-cut" name="First cut" width={${width}} height={${height}} fill="#000000" active>\n${clips.join('\n')}\n      </scene>\n    </stage>\n  )\n}\n`;
	await fs.write(project.entry, new Blob([source], { type: 'text/plain' }));
	return true;
}

/** Imports before the editor mounts, so the first agent turn can use library paths. */
export async function importProjectMedia(
	dir: string,
	sources: readonly string[],
	onProgress?: (completed: number, total: number) => void,
): Promise<ImportResult> {
	const fs = createProjectFS(dir);
	const library = new AssetLibrary(fs);
	const result: ImportResult = { assets: [], failed: [] };
	try {
		await library.load();
		const unique = [...new Set(sources)];
		for (const [index, source] of unique.entries()) {
			onProgress?.(index, unique.length);
			const imported = await library.import([source]);
			result.assets.push(...imported.assets);
			result.failed.push(...imported.failed);
		}
		// The library's background flush logs write errors. This foreground
		// handoff must surface a failure before telling an agent media is saved.
		await library.flush();
		await fs.writeManifest(library.manifest());
		onProgress?.(unique.length, unique.length);
		result.assets = [...new Map(result.assets.map((asset) => [asset.id, asset])).values()];
		return result;
	} finally {
		await library.dispose();
	}
}

/** Measured metadata only: no claims about scenes, speech, or the quality of a shot. */
export function mediaPromptContext(assets: readonly Asset[]): string {
	if (!assets.length) return '';
	const records = assets.slice(0, 50).map((asset) => ({
		path: asset.path,
		type: asset.type.toLowerCase(),
		...('duration' in asset ? { durationSeconds: Math.round(asset.duration * 1000) / 1000 } : {}),
		...('width' in asset ? { width: asset.width, height: asset.height } : {}),
		...('frameRate' in asset ? { fps: Math.round(asset.frameRate * 100) / 100 } : {}),
		...(asset.type === 'VIDEO' ? { hasAudio: (asset.channels ?? 0) > 0 } : {}),
	}));
	return [
		'Imported media is ready in this project’s asset library. Use these library paths as src values.',
		'The following is measured file metadata, not a review of the footage. Inspect frames or available transcripts before describing content or choosing highlights. Source files are linked and must remain unchanged.',
		JSON.stringify(records, null, 2),
		...(assets.length > records.length ? [`${assets.length - records.length} additional assets are available in the library.`] : []),
	].join('\n');
}
