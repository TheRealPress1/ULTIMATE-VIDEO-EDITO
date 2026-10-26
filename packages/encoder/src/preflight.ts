import { AdjustmentLayer, AssetId, Audio, Caption, ChildOf, Computed, Geometry, Group, Hidden, Muted, Paint, PaintType, SourceError, LoadRequest, PendingSource, PendingSync, SyncRequest, clearAudioTrackCache, getAsset, getAssetFile, mediaFailure } from '@diffusionstudio/runtime';
import type { Entity, World } from 'koota';

/** Check only media which can contribute to this export's window and tracks. */
type ExportWindow = {
	start: number; end: number; video: boolean; audio: boolean;
};

export function assertExportSources(world: World, scene: Entity, options: ExportWindow): Entity[] {
	const sources: Entity[] = [];
	const visit = (entity: Entity, start: number, end: number, muted: boolean): void => {
		if (entity.has(Hidden)) return;
		const computed = entity.get(Computed);
		if ((entity.has(Geometry) || entity.has(Group) || entity.has(AdjustmentLayer)) && computed) {
			start = Math.max(start, computed.start);
			end = Math.min(end, computed.end);
		}
		if (end <= start) return;
		muted ||= entity.has(Muted);
		const paint = entity.get(Paint)?.value;
		const audio = !muted && options.audio && (entity.has(Audio) || paint === PaintType.VIDEO);
		const visual = options.video && !entity.has(Audio);
		const relevant = entity.has(Caption) ? visual : audio || visual;
		if (relevant) {
			const failure = entity.get(SourceError)?.value;
			if (failure) throw mediaFailure(world, entity, failure);
			if (entity.has(LoadRequest) || entity.has(PendingSource) || entity.has(PendingSync) || entity.has(SyncRequest)) {
				throw mediaFailure(world, entity, 'The source has not finished loading or synchronizing.');
			}
			const id = entity.get(AssetId)?.value;
			if (id) {
				const asset = getAsset(world, id);
				if (!asset) throw mediaFailure(world, entity, 'The media is missing from the project library.');
				if (entity.has(Audio) && asset.type !== 'AUDIO' && asset.type !== 'VIDEO') throw mediaFailure(world, entity, 'The source is not audio or video.');
				if (entity.has(Caption) && asset.type !== 'TRANSCRIPT' && !((asset.type === 'AUDIO' || asset.type === 'VIDEO') && asset.transcript)) throw mediaFailure(world, entity, 'The source has no caption transcript.');
				if (paint === PaintType.IMAGE && asset.type !== 'IMAGE') throw mediaFailure(world, entity, 'The source is not an image.');
				if (paint === PaintType.VIDEO && !['VIDEO', 'SEQUENCE', 'MASK'].includes(asset.type)) throw mediaFailure(world, entity, 'The source is not video or an image sequence.');
				sources.push(entity);
			}
		}
		for (const child of world.query(ChildOf(entity))) visit(child, start, end, muted);
	};
	visit(scene, options.start, options.end, false);
	return sources;
}

/** Preview caches must not conceal a file moved or removed before export. */
export async function prepareExportSources(world: World, scene: Entity, options: ExportWindow): Promise<void> {
	const sources = assertExportSources(world, scene, options);
	const checked = new Set<string>();
	for (const entity of sources) {
		const asset = getAsset(world, entity.get(AssetId)!.value)!;
		if (checked.has(asset.id)) continue;
		checked.add(asset.id);
		try { await getAssetFile(asset, true); }
		catch (error) { throw mediaFailure(world, entity, error); }
	}
	// Audio tracks hold their original File too. Reopen them against the fresh
	// bytes; decoders already playing in the live editor keep their own track.
	if (options.audio) clearAudioTrackCache();
}
