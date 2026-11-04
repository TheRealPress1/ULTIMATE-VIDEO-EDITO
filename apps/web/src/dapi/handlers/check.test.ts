/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterAll, describe, expect, it, vi } from 'vitest';
vi.hoisted(() => { vi.stubGlobal('DOMMatrix', class {}); });
import { createWorld } from 'koota';
import { AssetId, Cache, Computed, FrameRate, Geometry, GeometryType, Paint, PaintType, Scene, Source, WorldBounds, WorldTransform, createEntity, store } from '@diffusionstudio/runtime';
import { check } from './check';
import type { Entity, World } from 'koota';
import type { ToolContext } from '../handler';
afterAll(() => vi.unstubAllGlobals());

/** A 1080×1920 scene of 300 frames at 30 fps, with full-frame videos at the given frame spans in paint order. */
function fixture(spans: Array<[name: string, start: number, end: number, box?: [number, number, number, number]]>) {
	const world = createWorld();
	world.add(FrameRate({ value: 30 }));
	const bounds = store(world, WorldBounds), matrix = store(world, WorldTransform);
	const place = (entity: Entity, [minX, minY, maxX, maxY]: [number, number, number, number]) => {
		const id = entity.id();
		bounds.minX[id] = minX; bounds.minY[id] = minY; bounds.maxX[id] = maxX; bounds.maxY[id] = maxY;
		matrix.a[id] = 1; matrix.b[id] = 0; matrix.c[id] = 0; matrix.d[id] = 1;
	};
	const children = spans.map(([name, start, end, box = [0, 0, 1080, 1920]]) => {
		const clip = createEntity(world);
		// Pieces named head-N are cut from one recording.
		clip.add(Geometry({ value: GeometryType.RECT }), Paint({ value: PaintType.VIDEO }), Source({ value: `index.tsx:${name}` }), AssetId({ value: name.replace(/-\d+$/, '') }));
		clip.set(Computed, { start, end, duration: end - start });
		place(clip, box);
		return clip;
	});
	const scene = createEntity(world);
	scene.add(Scene, Geometry({ value: GeometryType.RECT }), Source({ value: 'index.tsx:reel' }), Cache);
	scene.set(Computed, { start: 0, end: 300, duration: 300 });
	scene.set(Cache, { children });
	place(scene, [0, 0, 1080, 1920]);
	const ctx = { signal: new AbortController().signal, requireSession: () => ({ world }) } as unknown as ToolContext;
	return { world, ctx };
}

const run = async (world: World, ctx: ToolContext, minVisibleSeconds?: number) => {
	try { return await check({ id: 'index.tsx:reel', ...minVisibleSeconds === undefined ? {} : { minVisibleSeconds } } as never, ctx); }
	finally { world.destroy(); }
};

describe('check: short visible stretches', () => {
	it('flags the talking-head sliver a B-roll edge leaves just after a cut, on the visible node', async () => {
		const { world, ctx } = fixture([['head-1', 0, 150], ['head-2', 150, 300], ['broll', 156, 240], ['logo', 150, 160, [900, 40, 1040, 180]]]);
		const result = await run(world, ctx);
		const issue = result.issues.find((item) => item.code === 'short-visible-stretch');
		expect(issue).toMatchObject({ severity: 'warning', node: 'index.tsx:head-2', ranges: [{ start: 5, end: 5.2 }] });
		expect(issue!.message).toContain('0.2s (6 frames)');
		expect(issue!.message).toMatch(/Move the neighbouring edge onto the cut/);
		expect(result.stats.visibility).toEqual({ minVisibleSeconds: 0.4, stretches: 4, shortStretches: 1, evaluatedLayers: 4, skippedLayers: 0, skipped: [] });
		expect(result.issues.filter((item) => item.code === 'black-frames')).toEqual([]);
	});

	it('accepts the same edit when the edge sits on the cut, and can be turned off', async () => {
		const clean = fixture([['head-1', 0, 150], ['head-2', 150, 300], ['broll', 150, 240]]);
		expect((await run(clean.world, clean.ctx)).issues).toEqual([]);
		const off = fixture([['head-1', 0, 150], ['head-2', 150, 300], ['broll', 156, 240]]);
		const result = await run(off.world, off.ctx, 0);
		expect(result.issues).toEqual([]);
		expect(result.stats.visibility).toBeUndefined();
	});

	it('gives a talking-head word left between two cuts its own remedy', async () => {
		const { world, ctx } = fixture([['head-1', 0, 120], ['head-2', 120, 128], ['head-3', 128, 300]]);
		const [issue] = (await run(world, ctx)).issues;
		expect(issue).toMatchObject({ code: 'short-visible-stretch', node: 'index.tsx:head-2', ranges: [{ start: 4, end: 4.267 }] });
		expect(issue!.message).toMatch(/^A 0\.267s \(8 frames\) piece of one recording between two cuts in it/);
		expect(issue!.message).toMatch(/Keep the pause on one side so the piece joins its neighbour/);
	});

	it('honors a stricter minimum', async () => {
		const { world, ctx } = fixture([['head-1', 0, 150], ['head-2', 150, 300], ['broll', 165, 240]]);
		const result = await run(world, ctx, 0.6);
		expect(result.issues.map((item) => [item.code, item.node])).toEqual([['short-visible-stretch', 'index.tsx:head-2']]);
	});
});
