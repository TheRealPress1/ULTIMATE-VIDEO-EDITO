/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterAll, describe, expect, it, vi } from 'vitest';
vi.hoisted(() => { vi.stubGlobal('DOMMatrix', class {}); });
import { createWorld } from 'koota';
import { AssetId, BlendMode, BlendModeType, Cache, Chars, Color, Geometry, GeometryType, Opacity, Paint, PaintType, ScaleMode, ScaleModeType, WorldBounds, WorldTransform, createEntity, store } from '@diffusionstudio/runtime';
import { betweenCutsOfOneRecording, canvasBounds, inheritLook, ownsFrames, shortVisibleStretches, stretchLayer, visibleStretches } from './visible-stretches';
import type { StretchLayer } from './visible-stretches';
afterAll(() => vi.unstubAllGlobals());

// 30 fps, a ten-second scene: 300 frames, a 0.4 s minimum is 12 frames.
const window = { start: 0, end: 300 };
const full = (id: number, start: number, end: number, order: number): StretchLayer => ({ id, node: `index.tsx:${id}`, start, end, order, coverage: 1, opacity: 1 });
/** Two talking-head pieces cut at frame 150, and a B-roll shot over them. */
const edit = (broll: [number, number], extra: StretchLayer[] = []) => [full(1, 0, 150, 1), full(2, 150, 300, 2), full(3, broll[0], broll[1], 3), ...extra];
const flashes = (layers: StretchLayer[]) => shortVisibleStretches(visibleStretches(layers, window), window, 12);

describe('visible stretches', () => {
	it('flags a talking-head sliver left by a B-roll edge 0.2 s after the cut', () => {
		const stretches = visibleStretches(edit([156, 240]), window);
		expect(stretches.map(({ start, end, owner }) => [start, end, owner?.id])).toEqual([[0, 150, 1], [150, 156, 2], [156, 240, 3], [240, 300, 2]]);
		expect(flashes(edit([156, 240]))).toEqual([expect.objectContaining({ start: 150, end: 156, owner: expect.objectContaining({ node: 'index.tsx:2' }) })]);
	});

	it('accepts an edge on the cut or at least the minimum away from it', () => {
		expect(flashes(edit([150, 240]))).toEqual([]);
		expect(flashes(edit([165, 240]))).toEqual([]);
		expect(flashes(edit([162, 240]))).toEqual([]);
		expect(flashes(edit([161, 240]))).toHaveLength(1);
	});

	it('ignores partial overlays and translucent layers', () => {
		const logo = { ...full(4, 151, 156, 4), coverage: 0.5 };
		const tint = { ...full(5, 60, 63, 5), opacity: 0.6 };
		expect(flashes(edit([150, 240], [logo, tint]))).toEqual([]);
		expect(ownsFrames(logo)).toBe(false);
		expect(ownsFrames(tint)).toBe(false);
	});

	it('exempts a stretch that touches the start or end of the window', () => {
		expect(flashes(edit([6, 100]))).toEqual([]);
		expect(flashes(edit([100, 295]))).toEqual([]);
		expect(visibleStretches(edit([100, 290]), window).at(-1)).toMatchObject({ start: 290, end: 300 });
		expect(flashes(edit([100, 290]))).toEqual([]);
	});

	it('flags a short shot between two others and never a gap with no owner', () => {
		const insert = [full(1, 0, 150, 1), full(6, 150, 155, 2), full(2, 155, 300, 1)];
		expect(flashes(insert).map((stretch) => stretch.owner?.id)).toEqual([6]);
		const black = [full(1, 0, 150, 1), full(2, 155, 300, 1)];
		expect(visibleStretches(black, window).map((stretch) => stretch.owner?.id ?? null)).toEqual([1, null, 2]);
		expect(flashes(black)).toEqual([]);
	});

	it('tells a word left between two cuts in one recording from a sliver an insert leaves', () => {
		const head = (id: number, start: number, end: number): StretchLayer => ({ ...full(id, start, end, 1), media: 'head.mov' });
		// A tight pass kept "So," (0.25 s) between two removed pauses.
		const jumps = visibleStretches([head(1, 0, 120), head(2, 120, 128), head(3, 128, 300)], window);
		const [piece] = shortVisibleStretches(jumps, window, 12);
		expect(piece).toMatchObject({ start: 120, end: 128 });
		expect(betweenCutsOfOneRecording(jumps, piece!)).toBe(true);
		// The same sliver before a B-roll shot is an insert edge to move.
		const insert = visibleStretches([head(1, 0, 150), head(2, 150, 300), { ...full(3, 156, 240, 3), media: 'broll.mov' }], window);
		const [sliver] = shortVisibleStretches(insert, window, 12);
		expect(betweenCutsOfOneRecording(insert, sliver!)).toBe(false);
		// A short B-roll shot between two pieces of the head is not a piece of the head.
		const flash = visibleStretches([head(1, 0, 150), { ...full(6, 150, 155, 2), media: 'broll.mov' }, head(2, 155, 300)], window);
		expect(betweenCutsOfOneRecording(flash, shortVisibleStretches(flash, window, 12)[0]!)).toBe(false);
	});

	it('lets an unjudged layer own nothing', () => {
		const masked = { ...full(7, 156, 240, 3), skipped: 'masked' };
		expect(flashes([full(1, 0, 150, 1), full(2, 150, 300, 2), masked])).toEqual([]);
	});
});

describe('layers read from the runtime', () => {
	function scene() {
		const world = createWorld();
		const bounds = store(world, WorldBounds), matrix = store(world, WorldTransform);
		const place = (entity: ReturnType<typeof createEntity>, box: [number, number, number, number], b = 0) => {
			const id = entity.id();
			[bounds.minX[id], bounds.minY[id], bounds.maxX[id], bounds.maxY[id]] = box;
			matrix.a[id] = 1; matrix.b[id] = b; matrix.c[id] = 0; matrix.d[id] = 1;
			return entity;
		};
		const canvas = place(createEntity(world), [100, 200, 1180, 2120]);
		const video = (box: [number, number, number, number] = [100, 200, 1180, 2120], b = 0) => {
			const entity = createEntity(world);
			entity.add(Geometry({ value: GeometryType.RECT }), Paint({ value: PaintType.VIDEO }));
			return place(entity, box, b);
		};
		return { world, canvas, video, place, bounds: canvasBounds(world, canvas)! };
	}

	it('measures coverage against the scene canvas', () => {
		const { world, video, bounds } = scene();
		try {
			expect(bounds).toEqual({ minX: 100, minY: 200, maxX: 1180, maxY: 2120 });
			const clip = video(); clip.add(AssetId({ value: 'asset-head' }));
			const head = stretchLayer(world, clip, { start: 0, end: 90 }, { opacity: 1 }, bounds, 0, 'index.tsx:head');
			expect(head).toMatchObject({ node: 'index.tsx:head', media: 'asset-head', coverage: 1, opacity: 1, start: 0, end: 90 });
			expect(ownsFrames(head!)).toBe(true);
			// Half the width of the picture: an overlay, not a shot.
			const inset = stretchLayer(world, video([100, 200, 640, 2120]), { start: 0, end: 90 }, { opacity: 1 }, bounds, 1);
			expect(inset!.coverage).toBeCloseTo(0.5);
			expect(ownsFrames(inset!)).toBe(false);
			// Overscan past the canvas still counts as covering it.
			expect(stretchLayer(world, video([0, 0, 1400, 2400]), { start: 0, end: 90 }, { opacity: 1 }, bounds, 2)!.coverage).toBe(1);
		} finally { world.destroy(); }
	});

	it('reports masked, keyframed, blended, rotated and letterboxed layers as not evaluated', () => {
		const { world, video, bounds } = scene();
		try {
			const at = { start: 0, end: 90 };
			const masked = video(); masked.add(Cache); masked.set(Cache, { masks: [createEntity(world)] });
			expect(stretchLayer(world, masked, at, inheritLook(masked, { opacity: 1 }), bounds, 0)?.skipped).toBe('masked');
			const group = createEntity(world); group.add(Cache); group.set(Cache, { keyframeTracks: [createEntity(world)] });
			const child = video();
			expect(stretchLayer(world, child, at, inheritLook(child, inheritLook(group, { opacity: 1 })), bounds, 1)?.skipped).toBe('animated');
			const blended = video(); blended.add(BlendMode({ value: BlendModeType.SCREEN }));
			expect(stretchLayer(world, blended, at, inheritLook(blended, { opacity: 1 }), bounds, 2)?.skipped).toBe('blended');
			const rotated = video(undefined, 0.2);
			expect(stretchLayer(world, rotated, at, inheritLook(rotated, { opacity: 1 }), bounds, 3)?.skipped).toBe('rotated');
			const fitted = video(); fitted.add(ScaleMode({ value: ScaleModeType.FIT }));
			expect(stretchLayer(world, fitted, at, inheritLook(fitted, { opacity: 1 }), bounds, 4)?.skipped).toBe('fitted');
		} finally { world.destroy(); }
	});

	it('counts filled rectangles and multiplies ancestor opacity, but never text', () => {
		const { world, place, bounds } = scene();
		try {
			const card = place(createEntity(world), [100, 200, 1180, 2120]);
			card.add(Geometry({ value: GeometryType.RECT }), Color({ value: 0x101010 }));
			const parent = createEntity(world); parent.add(Opacity({ value: 0.5 }));
			const layer = stretchLayer(world, card, { start: 0, end: 30 }, inheritLook(card, inheritLook(parent, { opacity: 1 })), bounds, 0);
			expect(layer).toMatchObject({ coverage: 1, opacity: 0.5 });
			expect(ownsFrames(layer!)).toBe(false);
			const empty = place(createEntity(world), [100, 200, 1180, 2120]); empty.add(Geometry({ value: GeometryType.RECT }));
			expect(stretchLayer(world, empty, { start: 0, end: 30 }, { opacity: 1 }, bounds, 1)).toBeNull();
			const title = place(createEntity(world), [100, 200, 1180, 2120]); title.add(Geometry({ value: GeometryType.TEXT }), Chars({ value: 'Title' }), Color({ value: 0xffffff }));
			expect(stretchLayer(world, title, { start: 0, end: 30 }, { opacity: 1 }, bounds, 2)).toBeNull();
		} finally { world.destroy(); }
	});
});
