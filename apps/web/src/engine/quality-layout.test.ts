import { afterAll, describe, expect, it, vi } from 'vitest';
vi.hoisted(() => { vi.stubGlobal('DOMMatrix', class {}); });
import { createWorld } from 'koota';
import { Caption, Chars, Computed, Culled, Hidden, Source, WorldBounds, WorldTransform, appendChild, computeWorldBounds, createEntity, store } from '@diffusionstudio/runtime';
import { inspectTextLayout } from './quality-layout';
afterAll(() => vi.unstubAllGlobals());

describe('rendered text layout evidence', () => {
  it('finds the acceptance fixture overflow from real derived stores without attached WorldBounds', () => {
    const world = createWorld();
    try {
      const text = createEntity(world);
      text.add(Chars({ value: 'Overflow' }), Source({ value: 'index.tsx:reviewtext' }));
      text.set(Computed, { width: 240, height: 80, visibility: 1, opacity: 1 });
      const matrix = store(world, WorldTransform), id = text.id();
      // 640×360 scene reviewed at 360×202: text x=620, y=100.
      matrix.a[id] = .5625; matrix.b[id] = 0; matrix.c[id] = 0; matrix.d[id] = .5625; matrix.e[id] = 620 * .5625; matrix.f[id] = 100 * .5625;
      computeWorldBounds(world, text);
      expect(text.get(WorldBounds)).toBeUndefined();
      expect(inspectTextLayout(world, [text], { width: 360, height: 202 }, 0)).toEqual([
        expect.objectContaining({ code: 'text-overflow', node: 'index.tsx:reviewtext', time: 0 }),
      ]);
      // Fully offscreen text is culled from painting, but still needs review.
      matrix.e[id] = 800; computeWorldBounds(world, text); text.add(Culled);
      expect(inspectTextLayout(world, [text], { width: 360, height: 202 }, 1)[0]?.code).toBe('text-overflow');
    } finally { world.destroy(); }
  });

  it('distinguishes caption bounds and respects hidden, transparent and inactive ancestors', () => {
    const world = createWorld();
    try {
      const parent = createEntity(world), caption = createEntity(world);
      appendChild(world, caption, parent);
      caption.add(Caption, Chars({ value: 'Current words' }), Source({ value: 'index.tsx:caption' }));
      const bounds = store(world, WorldBounds), id = caption.id();
      bounds.minX[id] = 20; bounds.maxX[id] = 340; bounds.minY[id] = 180; bounds.maxY[id] = 210;
      expect(inspectTextLayout(world, [caption], { width: 360, height: 202 }, 1)[0]?.code).toBe('caption-overflow');
      parent.add(Hidden);
      expect(inspectTextLayout(world, [caption], { width: 360, height: 202 }, 1)).toEqual([]);
      parent.remove(Hidden); parent.set(Computed, { opacity: 0 });
      expect(inspectTextLayout(world, [caption], { width: 360, height: 202 }, 1)).toEqual([]);
      parent.set(Computed, { opacity: 1, visibility: 0 });
      expect(inspectTextLayout(world, [caption], { width: 360, height: 202 }, 1)).toEqual([]);
      parent.set(Computed, { visibility: 1 }); caption.set(Computed, { chars: '' });
      expect(inspectTextLayout(world, [caption], { width: 360, height: 202 }, 1)).toEqual([]);
    } finally { world.destroy(); }
  });
});
