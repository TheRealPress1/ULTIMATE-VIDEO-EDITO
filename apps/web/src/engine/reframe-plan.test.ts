import { describe, expect, it } from 'vitest';
import type { AuthoredTree } from '@diffusionstudio/reconciler';
import type { VideoAsset } from '@diffusionstudio/assets';
import type { ReframeAnalysisResult, ReframeFaceSample } from '@desktop/reframe-types';
import type { SpeakerAnalysisResult } from '@desktop/speaker-types';
import { cloneReframeTree, collectReframeVideos, planCropKeyframes, planReframeVariants } from './reframe-plan';

const asset = { id: 'video', path: 'Interview.mp4', source: '/Interview.mp4', type: 'VIDEO', width: 1920, height: 1080, duration: 60 } as VideoAsset;
const tree = (): AuthoredTree => ({ tag: 'scene', props: { id: 'scene', name: 'Interview', width: 1920, height: 1080, active: true, volume: -2 }, children: [
	{ tag: 'video', props: { id: 'clip', src: 'Interview.mp4', start: 4, end: 9, sourceIn: 10, playbackRate: 2, width: 1920, height: 1080, volume: -4 }, children: [] },
	{ tag: 'audio', props: { id: 'music', src: 'Music.wav', start: 0, end: 9, volume: -20 }, children: [] },
	{ tag: 'captions', props: { id: 'captions', src: 'Words.json', preset: 'whisper', start: 4, sourceIn: 10, sourceOut: 20, playbackRate: 2, selected: true }, children: [] },
] });
const face = (time: number, x: number, cut = false): ReframeFaceSample => ({ time, cut, faces: [{ x, y: 0.2, width: 0.1, height: 0.2, confidence: 0.95 }] });
const analysis = (samples: ReframeFaceSample[]): ReframeAnalysisResult => ({ width: 1920, height: 1080, duration: 60, sampleInterval: 0.5, samples });

describe('social reframe planning', () => {
	it('builds every format with preserved audio and source timing, without mutating the original', () => {
		const scene = tree(); const original = JSON.stringify(scene);
		const videos = collectReframeVideos(scene, () => asset);
		expect(videos[0]).toMatchObject({ start: 10, end: 20 });
		const plan = planReframeVariants(scene, videos, new Map([['0', analysis([face(10, 0.2), face(11, 0.24)])]]), { formats: ['vertical', 'square', 'landscape'], mode: 'follow', fps: 30 });
		expect(plan.variants.map(({ width, height }) => [width, height])).toEqual([[1080, 1920], [1080, 1080], [1920, 1080]]);
		for (const variant of plan.variants) {
			const [clip, music, captions] = variant.tree.children;
			expect(clip!.props).toMatchObject({ start: 4, end: 9, sourceIn: 10, playbackRate: 2, volume: -4 });
			expect(music!.props).toMatchObject({ src: 'Music.wav', end: 9, volume: -20 });
			expect(captions!.props).toMatchObject({ src: 'Words.json', sourceIn: 10, sourceOut: 20, playbackRate: 2 });
			expect(clip!.children[0]!.children[0]!.props.time).toBe(10);
			expect(variant.tree.props.volume).toBe(-2);
			expect(JSON.stringify(variant.tree)).not.toContain('"id":');
			expect(JSON.stringify(variant.tree)).not.toContain('"selected":');
		}
		expect(JSON.stringify(scene)).toBe(original);
	});
	it('reports full evidence coverage for sub-second clips independently of speed and format count', () => {
		const scene = tree(); Object.assign(scene.children[0]!.props, { start: 0, end: 0.25, sourceIn: 0, playbackRate: 2 });
		const speakers: SpeakerAnalysisResult = { engine: 'fixture', fingerprint: 'a'.repeat(64), width: 1920, height: 1080, start: 0, end: 0.5, sourceStart: 0, sampleInterval: 0.5, warnings: [], totalChunks: 1, resumedChunks: 0, samples: [
			{ time: 0, cut: false, audioRms: 0.1, activeTrackId: 'speaker', reason: 'speaker', faces: [{ trackId: 'speaker', x: 0.2, y: 0.2, width: 0.1, height: 0.2, confidence: 1, speakingScore: 3 }] },
		] };
		const plan = planReframeVariants(scene, collectReframeVideos(scene, () => asset), new Map(), { formats: ['vertical', 'square'], mode: 'speakers', fps: 30, speakerAnalyses: new Map([['0', speakers]]) });
		expect(plan.speakerSummary).toMatchObject({ coverage: 1, evidenceSeconds: 0.25, analyzedSeconds: 0.25 });
	});
	it('uniformly fills the canvas and clamps the entire crop inside the source at either edge', () => {
		const video = collectReframeVideos(tree(), () => asset)[0]!;
		const crop = planCropKeyframes(video, 1080, 1920, [face(10, 0), face(11, 0.9, true)], 30);
		expect(crop.width / crop.height).toBeCloseTo(1920 / 1080);
		expect(crop.keys[0]!.x).toBe(0);
		expect(crop.keys[1]!.x).toBeCloseTo(1080 - crop.width);
		for (const key of crop.keys) { expect(key.x).toBeLessThanOrEqual(0); expect(key.x + crop.width).toBeGreaterThanOrEqual(1080); expect(key.y).toBe(0); }
	});
	it('centers footage with no usable faces and reports that fallback', () => {
		const scene = tree(); const videos = collectReframeVideos(scene, () => asset);
		const plan = planReframeVariants(scene, videos, new Map([['0', analysis([{ time: 10, cut: false, faces: [] }])]]), { formats: ['vertical'], mode: 'follow', fps: 30 });
		expect(plan.faceCoverage).toBe(0);
		expect(plan.warnings.join()).toContain('center crop');
		const clip = plan.variants[0]!.tree.children[0]!;
		expect(clip.props.x).toBeCloseTo((1080 - Number(clip.props.width)) / 2);
		expect(clip.children).toHaveLength(0);
	});
	it('holds through brief missing detections and warns on multiple faces without identifying a speaker', () => {
		const video = collectReframeVideos(tree(), () => asset)[0]!;
		const initial = face(10, 0.3); initial.faces.push({ x: 0.8, y: 0.4, width: 0.05, height: 0.05, confidence: 1 });
		const crop = planCropKeyframes(video, 1080, 1920, [initial, { time: 10.5, cut: false, faces: [] }], 30);
		expect(crop.keys[1]!.x).toBe(crop.keys[0]!.x);
		expect(crop.multiple).toBe(true);
		expect(crop.coverage).toBe(0.5);
	});
	it('uses a discontinuous hold across a sampled shot cut instead of panning through the join', () => {
		const scene = tree(); const videos = collectReframeVideos(scene, () => asset);
		const plan = planReframeVariants(scene, videos, new Map([['0', analysis([face(10, 0.1), face(11, 0.8, true)])]]), { formats: ['vertical'], mode: 'follow', fps: 30 });
		const keys = plan.variants[0]!.tree.children[0]!.children[0]!.children;
		expect(keys[0]!.props.easing).toBe('steps(1)');
		expect(keys[1]!.props.time).toBeCloseTo(11 - 1 / 30);
		expect(keys[1]!.props.value).toBe(keys[0]!.props.value);
		expect(keys[2]!.props.time).toBe(11);
		expect(keys[2]!.props.value).not.toBe(keys[0]!.props.value);
	});
	it('keeps each preset box inside the caption inset without changing its words or timing', () => {
		for (const [preset, cw, ch] of [['whisper', 1000, 100], ['guinea', 700, 200], ['cascade', 800, 200]] as const) {
			const scene = tree(); scene.children[2]!.props.preset = preset;
			const plan = planReframeVariants(scene, collectReframeVideos(scene, () => asset), new Map(), { formats: ['vertical'], mode: 'center', fps: 30 });
			const props = plan.variants[0]!.tree.children[2]!.props;
			expect(Number(props.x)).toBeGreaterThanOrEqual(1080 * 0.08 - 0.01);
			expect(Number(props.x) + cw * Number(props.scale)).toBeLessThanOrEqual(1080 * 0.92 + 0.01);
			expect(Number(props.y) + ch * Number(props.scale)).toBeCloseTo(1920 * 0.82);
			expect(props).toMatchObject({ src: 'Words.json', sourceIn: 10, playbackRate: 2, pivotX: 0, pivotY: 0 });
		}
	});
	it('supports video-painted rectangles within a sequence and respects the first out boundary', () => {
		const scene = tree(); const clip = scene.children[0]!;
		clip.tag = 'rect'; clip.children = [{ tag: 'videoPaint', props: { src: clip.props.src }, children: [] }]; delete clip.props.src;
		clip.props.sourceOut = 18;
		scene.children[0] = { tag: 'sequence', props: {}, children: [clip] };
		const videos = collectReframeVideos(scene, () => asset);
		expect(videos[0]).toMatchObject({ key: '0.0', start: 10, end: 18 });
		const plan = planReframeVariants(scene, videos, new Map(), { formats: ['square'], mode: 'center', fps: 30 });
		expect(plan.variants[0]!.tree.children[0]!.children[0]!.props.height).toBe(1080);
	});
	it.each([
		['custom crop', (scene: AuthoredTree) => { scene.children[0]!.props.x = 200; }],
		['rotation', (scene: AuthoredTree) => { scene.children[0]!.props.rotation = 20; }],
		['motion', (scene: AuthoredTree) => { scene.children[0]!.children.push({ tag: 'keyframeTrack', props: { property: 'x' }, children: [] }); }],
		['sync link', (scene: AuthoredTree) => { scene.children[1]!.props.syncTo = 'clip'; }],
		['group', (scene: AuthoredTree) => { scene.children[0] = { tag: 'group', props: {}, children: [scene.children[0]!] }; }],
	])('rejects unsupported %s before a composition can be changed', (_name, change) => {
		const scene = tree(); change(scene);
		expect(() => collectReframeVideos(scene, () => asset)).toThrow();
	});
	it('rejects dynamic authored values and duplicate formats', () => {
		const scene = tree(); scene.props.dynamic = () => true;
		expect(() => cloneReframeTree(scene)).toThrow('dynamic content');
		const ordinary = tree();
		expect(() => planReframeVariants(ordinary, collectReframeVideos(ordinary, () => asset), new Map(), { formats: ['vertical', 'vertical'], mode: 'center', fps: 30 })).toThrow('different output formats');
	});
	it('excludes transient rendered caption text while keeping real title text', () => {
		const scene = tree(); scene.children[2]!.text = 'Current spoken word';
		scene.children.push({ tag: 'text', props: {}, text: 'Actual title', children: [] });
		const copy = cloneReframeTree(scene);
		expect(copy.children[2]!.text).toBeUndefined();
		expect(copy.children[3]!.text).toBe('Actual title');
	});
});
