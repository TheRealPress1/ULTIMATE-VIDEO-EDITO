import { afterAll, describe, expect, it, vi } from 'vitest';
import type { AuthoredTree } from '@diffusionstudio/reconciler';
vi.hoisted(() => {
	for (const name of ['DOMMatrix', 'HTMLImageElement', 'HTMLCanvasElement', 'HTMLElement', 'Element', 'Text']) vi.stubGlobal(name, class {});
});
import { mount } from '@diffusionstudio/reconciler';
import { Computed, FrameRate, Source, createRuntimeWorld, motionSystem, playbackSystem, setPlayhead } from '@diffusionstudio/runtime';
import { planTranscriptEdit, timelineWords } from './transcript-edit-plan';
afterAll(() => vi.unstubAllGlobals());

const tree = (tag: string, props: Record<string, unknown>, children: AuthoredTree[] = []): AuthoredTree => ({ tag, props, children });
function fixture(fps = 30) {
	const words = timelineWords([{ text: 'Earlier. Later.', words: [{ text: 'Earlier.', start: 1, end: 2 }, { text: 'Later.', start: 6, end: 7 }] }], 10);
	const plan = planTranscriptEdit([
		{ clips: [{ tree: tree('video', { src: 'Video.mp4', width: 1920, height: 1080 }, [tree('keyframeTrack', { property: 'x' }, [tree('keyframe', { time: 4, value: 0 }), tree('keyframe', { time: 24, value: 100 })])]), start: 0, end: 10 * fps, origin: -2 * fps, rate: 2 }] },
		{ clips: [{ tree: tree('audio', { src: 'Music.wav', volume: -18 }), start: 0, end: 10 * fps, origin: 0, rate: 1 }] },
	], words, [{ start: 5, end: 10 }, { start: 0, end: 5 }], 10, fps);
	plan.children[plan.captionIndex]!.props.src = 'Edited.json';
	const sceneTree = tree('scene', { width: 1920, height: 1080 }, plan.children);
	const world = createRuntimeWorld('transcript-edit-runtime'); world.set(FrameRate, { value: fps });
	const code = `const vocabulary = require('@diffusionstudio/jsx');
function render(node, path) {
 const props = { ...node.props, __source: 'fixture.tsx:' + path };
 Object.defineProperty(props, 'children', { enumerable: true, get() { return node.children.map((child, index) => render(child, path + 'n' + index)); } });
 return vocabulary[node.tag[0].toUpperCase() + node.tag.slice(1)](props);
}
module.exports.default = () => vocabulary.Stage({ __source: 'fixture.tsx:stage', get children() { return render(${JSON.stringify(sceneTree)}, 'scene'); } });`;
	const mounted = mount(code, world);
	const find = (path: string) => world.query(Source).find((node) => node.get(Source)?.value === `fixture.tsx:${path}`)!;
	return { world, plan, scene: find('scene'), firstVideo: find('scenen0n0'), secondVideo: find('scenen0n1'), firstAudio: find('scenen1n0'), secondAudio: find('scenen1n1'), dispose: () => { mounted.dispose(); world.destroy(); } };
}

describe('transcript edit plans in the composition runtime', () => {
	it.each([24, 30, 60])('keeps reordered 2x video, music and captions aligned at %ifps', (fps) => {
		const f = fixture(fps);
		try {
			setPlayhead(f.world, f.scene, fps); playbackSystem(f.world); motionSystem(f.world);
			expect(f.firstVideo.get(Computed)?.localTime).toBe(16 * fps);
			expect(f.firstAudio.get(Computed)?.localTime).toBe(6 * fps);
			expect(f.firstVideo.get(Computed)?.positionX).toBeCloseTo(60);
			expect(f.plan.transcript[0]!.words[0]).toMatchObject({ text: 'Later.', start: 1, end: 2 });
			setPlayhead(f.world, f.scene, 6 * fps); playbackSystem(f.world); motionSystem(f.world);
			expect(f.secondVideo.get(Computed)?.localTime).toBe(6 * fps);
			expect(f.secondAudio.get(Computed)?.localTime).toBe(fps);
			expect(f.secondVideo.get(Computed)?.positionX).toBeCloseTo(10);
			expect(f.plan.transcript[1]!.words[0]).toMatchObject({ text: 'Earlier.', start: 6, end: 7 });
			expect(f.scene.get(Computed)?.end).toBe(10 * fps);
		} finally { f.dispose(); }
	});
});
