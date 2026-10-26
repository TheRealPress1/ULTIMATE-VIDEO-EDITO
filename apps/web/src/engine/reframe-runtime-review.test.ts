import { afterAll, describe, expect, it, vi } from 'vitest';
import type { AuthoredTree } from '@diffusionstudio/reconciler';
import type { VideoAsset } from '@diffusionstudio/assets';

vi.hoisted(() => {
	for (const name of ['DOMMatrix', 'HTMLImageElement', 'HTMLCanvasElement', 'HTMLElement', 'Element', 'Text']) vi.stubGlobal(name, class {});
});
import { mount } from '@diffusionstudio/reconciler';
import {
	CaptionAlign, Computed, LocalTransform, Source, createRuntimeWorld, computeLocalMatrix,
	motionSystem, playbackSystem, setPlayhead, store,
} from '@diffusionstudio/runtime';
import { placeCaption } from '../../../../packages/runtime/src/media/caption/position';
import { collectReframeVideos, planReframeVariants } from './reframe-plan';

afterAll(() => vi.unstubAllGlobals());

const asset = { id: 'clip', path: 'Source.mp4', source: '/Source.mp4', type: 'VIDEO', width: 1920, height: 1080, duration: 60 } as VideoAsset;
const source = (): AuthoredTree => ({ tag: 'scene', props: { name: 'Original', width: 1920, height: 1080 }, children: [
	{ tag: 'video', props: { src: 'Source.mp4', start: 4, end: 9, sourceIn: 10, playbackRate: 2, width: 1920, height: 1080 }, children: [] },
	{ tag: 'captions', props: { src: 'Words.json', preset: 'whisper', sourceOut: 9 }, children: [] },
] });

function fixture() {
	const scene = source();
	const plan = planReframeVariants(scene, collectReframeVideos(scene, () => asset), new Map([['0', {
		width: 1920, height: 1080, duration: 60, sampleInterval: 1,
		samples: [10, 11, 12].map((time, index) => ({ time, cut: index === 2, faces: [{ x: [0.2, 0.4, 0.8][index]!, y: 0.2, width: 0.1, height: 0.2, confidence: 1 }] })),
	}]]), { formats: ['vertical'], mode: 'follow', fps: 30 });
	const tree = plan.variants[0]!.tree;
	const world = createRuntimeWorld('reframe-runtime-clock-review');
	const code = `
const vocabulary = require('@diffusionstudio/jsx');
function render(node, path) {
  const props = { ...node.props, __source: 'fixture.tsx:' + path };
  Object.defineProperty(props, 'children', { enumerable: true, get() { return node.children.map((child, index) => render(child, path + 'n' + index)); } });
  return vocabulary[node.tag[0].toUpperCase() + node.tag.slice(1)](props);
}
module.exports.default = () => vocabulary.Stage({ __source: 'fixture.tsx:stage', get children() { return render(${JSON.stringify(tree)}, 'scene'); } });`;
	const mounted = mount(code, world);
	const find = (path: string) => world.query(Source).find((entity) => entity.get(Source)?.value === `fixture.tsx:${path}`)!;
	return { world, scene: find('scene'), video: find('scenen0'), captions: find('scenen1'), tree, dispose: () => { mounted.dispose(); world.destroy(); } };
}

describe('reframe plans in the actual composition runtime', () => {
	it('follows source-local keyframes after a trim, delayed start and 2x playback', () => {
		const f = fixture();
		try {
			const track = f.tree.children[0]!.children[0]!;
			const first = Number(track.children[0]!.props.value);
			const next = Number(track.children[1]!.props.value);
			setPlayhead(f.world, f.scene, 120); playbackSystem(f.world); motionSystem(f.world);
			expect(f.video.get(Computed)?.localTime).toBe(300);
			expect(f.video.get(Computed)?.positionX).toBeCloseTo(first);
			// 0.1s of timeline is 0.2s of source. The CSS ease-in/out descriptor
			// must reach the runtime, rather than silently becoming linear.
			setPlayhead(f.world, f.scene, 123); playbackSystem(f.world); motionSystem(f.world);
			expect(f.video.get(Computed)?.localTime).toBe(306);
			const fraction = (f.video.get(Computed)!.positionX - first) / (next - first);
			expect(fraction).toBeGreaterThan(0.05);
			expect(fraction).toBeLessThan(0.12);
			setPlayhead(f.world, f.scene, 135); playbackSystem(f.world); motionSystem(f.world);
			expect(f.video.get(Computed)?.localTime).toBe(330);
			expect(f.video.get(Computed)?.positionX).toBeCloseTo(next);
		} finally { f.dispose(); }
	});

	it('holds the previous crop until the sampled cut instead of easing across it', () => {
		const f = fixture();
		try {
			const track = f.tree.children[0]!.children[0]!;
			const previous = Number(track.children[1]!.props.value);
			const final = Number(track.children.at(-1)!.props.value);
			setPlayhead(f.world, f.scene, 149); playbackSystem(f.world); motionSystem(f.world);
			expect(f.video.get(Computed)?.positionX).toBeCloseTo(previous);
			setPlayhead(f.world, f.scene, 150); playbackSystem(f.world); motionSystem(f.world);
			expect(f.video.get(Computed)?.positionX).toBeCloseTo(final);
		} finally { f.dispose(); }
	});

	it('keeps the scaled whisper preset box inside its inset after runtime placement and pivot transforms', () => {
		const f = fixture();
		try {
			placeCaption(f.world, f.captions, { width: 1000, height: 100, defaultAlign: CaptionAlign.BOTTOM });
			computeLocalMatrix(f.world, f.captions);
			const transform = store(f.world, LocalTransform);
			const id = f.captions.id();
			const matrix = { a: transform.a[id]!, d: transform.d[id]!, e: transform.e[id]!, f: transform.f[id]! };
			expect(matrix.e).toBeCloseTo(1080 * 0.08);
			expect(matrix.e + matrix.a * 1000).toBeCloseTo(1080 * 0.92);
			expect(matrix.f + matrix.d * 100).toBeCloseTo(1920 * 0.82);
		} finally { f.dispose(); }
	});
});
