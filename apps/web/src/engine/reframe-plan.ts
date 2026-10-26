import { parseTime } from '@diffusionstudio/jsx';
import type { AuthoredTree } from '@diffusionstudio/reconciler';
import type { VideoAsset } from '@diffusionstudio/assets';
import { planSpeakerFraming } from './speaker-framing';
import { sourceSpeakerFraming, validateSpeakerFraming } from './speaker-framing-options';
import type { SpeakerFramingOptions, SpeakerFramingSummary } from './speaker-framing-options';
import type { SpeakerAnalysisResult } from '@desktop/speaker-types';
import type { SpeakerCropKey } from './speaker-framing';
import type { ReframeAnalysisResult, ReframeFaceSample } from '@desktop/reframe-types';

export const REFRAME_FORMATS = [
	{ id: 'vertical', label: 'Vertical · 9:16', width: 1080, height: 1920 },
	{ id: 'square', label: 'Square · 1:1', width: 1080, height: 1080 },
	{ id: 'landscape', label: 'Landscape · 16:9', width: 1920, height: 1080 },
] as const;
export type ReframeFormat = typeof REFRAME_FORMATS[number]['id'];
export type ReframeMode = 'speakers' | 'follow' | 'center';
export interface ReframeVideo {
	key: string;
	path: string;
	asset: VideoAsset;
	start: number;
	end: number;
	playbackRate?: number;
	/** Resolved scene clock, in seconds. */
	timeline?: { start: number; end: number; origin: number; rate: number };
}
export interface ReframePlannedVariant {
	format: ReframeFormat;
	name: string;
	width: number;
	height: number;
	tree: AuthoredTree;
	warnings: string[];
}
export interface ReframePlan {
	variants: ReframePlannedVariant[];
	warnings: string[];
	faceCoverage: number | null;
	videoCount: number;
	speakerSummary?: SpeakerFramingSummary;
}

const IDENTITY = new Set(['id', 'selected', 'active', 'expanded', 'timeline', 'playhead']);
const SPATIAL = new Set(['x', 'y', 'width', 'height', 'rotation', 'scale', 'scaleX', 'scaleY', 'offsetX', 'offsetY']);
const PAINTS = new Set(['solidPaint', 'linearGradientPaint', 'radialGradientPaint', 'angularGradientPaint']);
const STATIC_OVERLAYS = new Set(['text', 'image', 'rect', 'ellipse', 'polygon', 'path']);
const CAPTION_BOXES: Record<string, [number, number]> = {
	classic: [600, 100], whisper: [1000, 100], cascade: [800, 200],
	spotlight: [700, 100], paper: [700, 200], guinea: [700, 200], stark: [700, 100],
};
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const number = (value: unknown, fallback: number, label: string): number => {
	if (value === undefined) return fallback;
	if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${label} must be a fixed number before reframing.`);
	return value;
};

/** Snapshot authored data, removing every identity so each copy receives new stable IDs. */
export function cloneReframeTree(tree: AuthoredTree): AuthoredTree {
	const copy = (value: unknown): unknown => {
		if (value === null || value === undefined || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') return value;
		if (Array.isArray(value)) return value.map(copy);
		if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, copy(v)]));
		throw new Error('This scene contains dynamic content that cannot be copied safely. Create a static scene before reframing.');
	};
	return {
		tag: tree.tag,
		props: Object.fromEntries(Object.entries(tree.props).filter(([key]) => !IDENTITY.has(key)).map(([key, value]) => [key, copy(value)])),
		// Caption Chars is the decoder's current playback text, not authored
		// content. Scrubbing must neither invalidate analysis nor bake that text.
		...(tree.text === undefined || tree.tag === 'captions' ? {} : { text: tree.text }),
		children: tree.children.map(cloneReframeTree),
	};
}

export function videoSource(tree: AuthoredTree): string | undefined {
	if (tree.tag === 'video') return typeof tree.props.src === 'string' ? tree.props.src : undefined;
	if (tree.tag !== 'rect') return undefined;
	const paints = tree.children.filter((child) => child.tag === 'videoPaint');
	if (paints.length !== 1) return undefined;
	return typeof paints[0]!.props.src === 'string' ? paints[0]!.props.src : undefined;
}

function unchangedTransform(tree: AuthoredTree, label: string, replaceCrop = false): void {
	for (const [key, expected] of Object.entries({ rotation: 0, scale: 1, scaleX: 1, scaleY: 1, offsetX: 0, offsetY: 0 })) {
		if (number(tree.props[key], expected, key) !== expected) throw new Error(`${label} has a ${key} transform. Reset its transform before automatic reframing.`);
	}
	if (tree.children.some((child) => child.tag === 'animation' && !['fade', 'gain', 'blur', 'appearWord', 'appearChar', 'scramble'].includes(String(child.props.type)))) {
		throw new Error(`${label} has spatial animation. Remove that animation before automatic reframing.`);
	}
	if (tree.children.some((child) => child.tag === 'keyframeTrack' && SPATIAL.has(String(child.props.property)) && !(replaceCrop && ['x', 'y', 'scale'].includes(String(child.props.property))))) {
		throw new Error(`${label} already has crop or motion keyframes. Keep that version and use its original scene for automatic reframing.`);
	}
}

export function collectReframeVideos(scene: AuthoredTree, resolve: (path: string) => VideoAsset | undefined, options: { replaceCrop?: boolean } = {}): ReframeVideo[] {
	if (scene.tag !== 'scene') throw new Error('Select a scene to create format versions.');
	const sw = number(scene.props.width, 1920, 'Scene width');
	const sh = number(scene.props.height, 1080, 'Scene height');
	if (sw <= 0 || sh <= 0 || sw > 16384 || sh > 16384) throw new Error('The scene has invalid dimensions.');
	unchangedTransform(scene, 'The scene');
	const videos: ReframeVideo[] = [];
	const walk = (node: AuthoredTree, key: string, depth: number) => {
		if (node.props.syncTo !== undefined) throw new Error('This scene uses audio sync links. Bake their start times before creating format versions.');
		const path = videoSource(node);
		if (path) {
			const label = typeof node.props.name === 'string' ? node.props.name : path;
			const cropScale = options.replaceCrop ? number(node.props.scale, 1, 'Video scale') : 1;
			if (cropScale <= 0) throw new Error(`${label} must have a positive scale before reframing.`);
			unchangedTransform(options.replaceCrop ? { ...node, props: { ...node.props, scale: 1 } } : node, label, options.replaceCrop);
			const asset = resolve(path);
			if (!asset || asset.type !== 'VIDEO' || ![asset.width, asset.height, asset.duration].every((v) => Number.isFinite(v) && v > 0)) throw new Error(`The video ${path} is unavailable or has invalid metadata.`);
			const x = number(node.props.x, 0, 'Video x');
			const y = number(node.props.y, 0, 'Video y');
			const w = number(node.props.width, node.tag === 'video' ? 1920 : 100, 'Video width');
			const h = number(node.props.height, node.tag === 'video' ? 1080 : 100, 'Video height');
			const fit = Math.min(sw / asset.width, sh / asset.height);
			const near = (a: number, b: number) => Math.abs(a - b) <= 2;
			const fullFrame = near(x, 0) && near(y, 0) && near(w, sw) && near(h, sh);
			const fitted = near(w, asset.width * fit) && near(h, asset.height * fit) && near(x, (sw - w) / 2) && near(y, (sh - h) / 2);
			const rw = w * cropScale, rh = h * cropScale;
			const existingCover = options.replaceCrop && Math.abs(w / h - asset.width / asset.height) < 0.02 &&
				((x <= 2 && y <= 2 && x + rw >= sw - 2 && y + rh >= sh - 2) ||
				(near(rw, asset.width * fit) && near(rh, asset.height * fit) && near(x, (sw - rw) / 2) && near(y, (sh - rh) / 2)));
			if (!fullFrame && !fitted && !existingCover) throw new Error(`${label} uses a custom crop or picture-in-picture layout. Use a scene with full-frame clips for automatic reframing.`);
			if (node.children.some((child) => ['mask', 'clipPath', 'imagePaint', 'htmlPaint', 'surfacePaint'].includes(child.tag))) throw new Error(`${label} has a mask or layered paint that needs manual reframing.`);
			const paint = node.children.find((child) => child.tag === 'videoPaint');
			if (paint) unchangedTransform(paint, `${label}'s video paint`);
			const time = (prop: string, fallback: number) => {
				if (node.props[prop] === undefined) return fallback;
				const value = typeof node.props[prop] === 'number' || typeof node.props[prop] === 'string' ? parseTime(node.props[prop] as string | number) : undefined;
				if (value === undefined || !Number.isFinite(value)) throw new Error(`${label} has an invalid ${prop}.`);
				return value;
			};
			const rate = number(node.props.playbackRate, 1, 'Playback rate');
			if (rate <= 0) throw new Error(`${label} must play forward before reframing.`);
			const start = time('sourceIn', 0);
			const end = Math.min(asset.duration, time('sourceOut', asset.duration), start + (time('end', Infinity) - time('start', 0)) * rate);
			if (start < 0 || end <= start) throw new Error(`${label} has an empty or invalid source range.`);
			videos.push({ key, path, asset: { ...asset }, start, end, playbackRate: rate });
			return;
		}
		if (node.tag === 'sequence') {
			for (let i = 0; i < node.children.length; i++) walk(node.children[i]!, `${key}.${i}`, depth);
			return;
		}
		if (node.tag === 'captions') {
			if (options.replaceCrop) {
				if (number(node.props.scale, 1, 'Caption scale') <= 0) throw new Error('Caption scale must be positive.');
				unchangedTransform({ ...node, props: { ...node.props, scale: 1 } }, 'A caption layer');
			} else unchangedTransform(node, 'A caption layer');
			return;
		}
		if (node.tag === 'audio') return;
		if (PAINTS.has(node.tag) || node.tag === 'keyframeTrack' || node.tag === 'animation') return;
		if (STATIC_OVERLAYS.has(node.tag)) {
			unchangedTransform(node, 'An overlay');
			if (node.children.some((child) => ['video', 'videoPaint', 'group', 'sequence', 'surfacePaint', 'htmlPaint'].includes(child.tag))) throw new Error('A nested media layout needs manual reframing. Use full-frame clips and separate overlay layers.');
			return;
		}
		throw new Error(`The ${node.tag} layer needs manual reframing. Use a scene with full-frame video, audio, captions and static overlays.`);
	};
	scene.children.forEach((child, index) => walk(child, String(index), 0));
	if (!videos.length) throw new Error('This scene has no supported video clips to reframe.');
	if (videos.length > 100) throw new Error('Reframe up to 100 video clips at a time.');
	return videos;
}

export interface CropKeyframe { time: number; x: number; y: number; cut: boolean }

/** Face continuity, a small dead zone and bounded smoothing avoid reacting to every detection jitter. */
export function planCropKeyframes(video: ReframeVideo, width: number, height: number, samples: readonly ReframeFaceSample[], fps: number): { width: number; height: number; keys: CropKeyframe[]; coverage: number; multiple: boolean } {
	const scale = Math.max(width / video.asset.width, height / video.asset.height);
	const vw = video.asset.width * scale;
	const vh = video.asset.height * scale;
	const observations = samples.filter((s) => Number.isFinite(s.time) && s.time >= video.start - 1 / fps && s.time < video.end).sort((a, b) => a.time - b.time);
	const keys: CropKeyframe[] = [];
	let center = { x: 0.5, y: 0.5 };
	let lastSeen = -Infinity;
	let found = 0;
	let multiple = false;
	for (const sample of observations) {
		const faces = sample.faces.filter((face) => [face.x, face.y, face.width, face.height, face.confidence].every(Number.isFinite) && face.confidence >= 0.5 && face.width > 0 && face.height > 0 && face.x >= 0 && face.y >= 0 && face.x + face.width <= 1.001 && face.y + face.height <= 1.001);
		multiple ||= faces.length > 1;
		if (sample.cut) { center = { x: 0.5, y: 0.5 }; lastSeen = -Infinity; }
		let chosen = [...faces].sort((a, b) => b.width * b.height - a.width * a.height)[0];
		if (lastSeen > -Infinity && !sample.cut) {
			const nearest = [...faces].sort((a, b) => Math.hypot(a.x + a.width / 2 - center.x, a.y + a.height / 2 - center.y) - Math.hypot(b.x + b.width / 2 - center.x, b.y + b.height / 2 - center.y))[0];
			if (nearest && Math.hypot(nearest.x + nearest.width / 2 - center.x, nearest.y + nearest.height / 2 - center.y) < 0.3) chosen = nearest;
		}
		if (chosen) {
			const target = { x: chosen.x + chosen.width / 2, y: chosen.y + chosen.height / 2 };
			const first = lastSeen === -Infinity;
			const blend = first ? 1 : 0.65;
			if (Math.abs(target.x - center.x) > 0.025 || first) center.x += (target.x - center.x) * blend;
			if (Math.abs(target.y - center.y) > 0.025 || first) center.y += (target.y - center.y) * blend;
			lastSeen = sample.time; found++;
		} else if (sample.time - lastSeen > 2) {
			center.x += (0.5 - center.x) * 0.35; center.y += (0.5 - center.y) * 0.35;
		}
		keys.push({ time: Math.max(video.start, Math.round(sample.time * fps) / fps), x: clamp(width / 2 - center.x * vw, width - vw, 0), y: clamp(height * 0.4 - center.y * vh, height - vh, 0), cut: sample.cut });
	}
	if (!keys.length || !found) {
		return { width: vw, height: vh, keys: [{ time: video.start, x: (width - vw) / 2, y: (height - vh) / 2, cut: false }], coverage: 0, multiple };
	}
	if (keys[0]!.time > video.start) keys.unshift({ ...keys[0]!, time: video.start, cut: false });
	return { width: vw, height: vh, keys: keys.filter((key, i) => i === 0 || key.time !== keys[i - 1]!.time), coverage: found / Math.max(1, observations.length), multiple };
}

function keyframeTrack(property: 'x' | 'y', keys: CropKeyframe[], fps: number): AuthoredTree {
	const expanded: Array<{ time: number; value: number; easing: string }> = [];
	for (const key of keys) {
		const prev = expanded.at(-1);
		if (key.cut && prev && key.time > prev.time) {
			prev.easing = 'steps(1)';
			if (key.time - 1 / fps > prev.time) expanded.push({ time: key.time - 1 / fps, value: prev.value, easing: 'steps(1)' });
		}
		expanded.push({ time: key.time, value: key[property], easing: 'easeInOut' });
	}
	return { tag: 'keyframeTrack', props: { property }, children: expanded.map((props) => ({ tag: 'keyframe', props, children: [] })) };
}

function speakerKeyframeTrack(property: 'x' | 'y' | 'scale', keys: SpeakerCropKey[], fps: number, rate: number): AuthoredTree {
	const expanded: Array<{ time: number; value: number; easing: string }> = [];
	for (const key of keys) {
		const previous = expanded.at(-1);
		if (key.cut && previous && key.time > previous.time) {
			previous.easing = 'steps(1)';
			if (key.time - rate / fps > previous.time) expanded.push({ time: key.time - rate / fps, value: previous.value, easing: 'steps(1)' });
		}
		expanded.push({ time: key.time, value: key[property], easing: 'linear' });
	}
	return { tag: 'keyframeTrack', props: { property }, children: expanded.map((props) => ({ tag: 'keyframe', props, children: [] })) };
}

/** Produces ordinary JSX trees only: originals, media bytes and transcript times are unchanged. */
export function planReframeVariants(scene: AuthoredTree, videos: readonly ReframeVideo[], analyses: ReadonlyMap<string, ReframeAnalysisResult>, options: { formats: readonly ReframeFormat[]; mode: ReframeMode; name?: string; fps: number; speakerAnalyses?: ReadonlyMap<string, SpeakerAnalysisResult>; speakerFraming?: SpeakerFramingOptions; sceneEnd?: number }): ReframePlan {
	if (!options.formats.length || options.formats.length > 3 || new Set(options.formats).size !== options.formats.length || options.formats.some((id) => !REFRAME_FORMATS.some((format) => format.id === id))) throw new Error('Choose one or more different output formats.');
	if (!['speakers', 'follow', 'center'].includes(options.mode)) throw new Error('Choose speaker following, face following or a center crop.');
	if (!Number.isFinite(options.fps) || options.fps <= 0) throw new Error('The project frame rate is invalid.');
	if (options.name !== undefined && (!options.name.trim() || options.name.length > 100)) throw new Error('Use a version name between 1 and 100 characters.');
	validateSpeakerFraming(options.speakerFraming, options.mode, options.sceneEnd);
	if (options.speakerFraming?.overrides?.length) {
		const hasTransition = (node: AuthoredTree): boolean => !!node.props.transition || node.children.some(hasTransition);
		if (hasTransition(scene)) throw new Error('Time-range framing corrections do not yet support transition overlaps. Remove the transitions in a copy or use a whole-scene framing preference.');
	}
	const sw = number(scene.props.width, 1920, 'Scene width');
	const sh = number(scene.props.height, 1080, 'Scene height');
	const warnings = new Set<string>();
	let totalCoverage = 0;
	let measured = 0;
	const speakerStats = new Map<string, SpeakerFramingSummary>();
	const variants = options.formats.map((format): ReframePlannedVariant => {
		const spec = REFRAME_FORMATS.find((item) => item.id === format)!;
		const { width, height } = spec;
		const tree = cloneReframeTree(scene);
		const name = `${options.name?.trim() || String(scene.props.name || 'Scene')} · ${format === 'vertical' ? '9:16' : format === 'square' ? '1:1' : '16:9'}`;
		Object.assign(tree.props, { name, width, height, x: 0, y: 0 });
		const local = new Set<string>();
		const visit = (node: AuthoredTree, key: string) => {
			const video = videos.find((item) => item.key === key);
			if (video) {
				if (options.mode === 'speakers') {
					const analysis = options.speakerAnalyses?.get(key);
					const framing = sourceSpeakerFraming(video, options.speakerFraming, options.fps);
					const crop = planSpeakerFraming(video, width, height, analysis, options.fps, framing);
					const rate = framing.playbackRate;
					const first = crop.keys[0]!;
					Object.assign(node.props, { x: first.x, y: first.y, scale: first.scale, pivotX: 0, pivotY: 0, width: crop.width, height: crop.height, objectFit: 'cover', keepAspectRatio: true });
					// Replace the old camera only in the newly created scene; retain
					// source trims, speed, audio, effects and caption word timing.
					node.children = node.children.filter((child) => !(child.tag === 'keyframeTrack' && ['x', 'y', 'scale'].includes(String(child.props.property))));
					if (crop.keys.length > 1) node.children.push(...(['x', 'y', 'scale'] as const).map((property) => speakerKeyframeTrack(property, crop.keys, options.fps, rate)));
					speakerStats.set(key, { coverage: crop.coverage, switches: crop.switches, analyzedSeconds: crop.analyzedSeconds / rate, fallbackSeconds: crop.fallbackSeconds / rate, evidenceSeconds: crop.evidenceSeconds / rate, heldSeconds: crop.heldSeconds / rate, wideSeconds: crop.wideSeconds / rate, manualSeconds: crop.manualSeconds / rate });
					if (!crop.coverage) local.add(`${video.path}: no supported visible-speaker evidence${crop.manualSeconds > 0 ? '; explicit framing preferences were applied where possible' : '; the full source frame is shown'}.`);
					const uncertainSeconds = crop.fallbackRanges.reduce((sum, range) => sum + range.end - range.start, 0) / rate;
					if (crop.coverage && uncertainSeconds > 0) local.add(`${video.path}: ${Math.round(uncertainSeconds)}s used a brief hold or wider view where speaker evidence was uncertain. Review those sections.`);
					for (const warning of analysis?.warnings ?? []) local.add(`${video.path}: ${warning}`);
					return;
				}
				const analysis = analyses.get(key);
				const crop = planCropKeyframes(video, width, height, options.mode === 'follow' ? analysis?.samples ?? [] : [], options.fps);
				Object.assign(node.props, { x: crop.keys[0]!.x, y: crop.keys[0]!.y, width: crop.width, height: crop.height, objectFit: 'cover', keepAspectRatio: true });
				if (options.mode === 'follow') {
					totalCoverage += crop.coverage; measured++;
					if (!crop.coverage) local.add(`${video.path}: no usable face detections; a center crop was used.`);
					else if (crop.coverage < 0.85) local.add(`${video.path}: faces detected in ${Math.round(crop.coverage * 100)}% of sampled frames; review gaps in the crop.`);
					if (crop.multiple) local.add(`${video.path}: multiple faces detected; framing follows a nearby prominent face, not an identified speaker.`);
					if (crop.keys.length > 1) node.children.push(keyframeTrack('x', crop.keys, options.fps), keyframeTrack('y', crop.keys, options.fps));
				}
				return;
			}
			if (node.tag === 'sequence') { node.children.forEach((child, index) => visit(child, `${key}.${index}`)); return; }
			if (node.tag === 'captions') {
				const [cw, ch] = CAPTION_BOXES[String(node.props.preset ?? 'classic')] ?? CAPTION_BOXES.classic!;
				const scale = Math.min(1, width * 0.84 / cw);
				Object.assign(node.props, { x: (width - cw * scale) / 2, y: height * 0.82 - ch * scale, pivotX: 0, pivotY: 0, scale, offsetX: 0, offsetY: 0, verticalAlign: 'bottom' });
				return;
			}
			if (node.tag === 'audio' || PAINTS.has(node.tag) || node.tag === 'keyframeTrack' || node.tag === 'animation') return;
			// Keep static graphics together within an inset, uniformly fitted
			// representation of the source canvas. No anisotropic text stretching.
			const scale = Math.min(width * 0.84 / sw, height * 0.74 / sh);
			const ox = (width - sw * scale) / 2;
			const oy = (height - sh * scale) / 2;
			Object.assign(node.props, { x: ox + number(node.props.x, 0, 'Overlay x') * scale, y: oy + number(node.props.y, 0, 'Overlay y') * scale, scale, pivotX: 0, pivotY: 0 });
			local.add('Static titles and graphics were fitted into an inset of the new frame; review their size and placement.');
		};
		tree.children.forEach((child, index) => visit(child, String(index)));
		local.forEach((warning) => warnings.add(warning));
		return { format, name, width, height, tree, warnings: [...local] };
	});
	const stats = [...speakerStats.values()];
	const analyzedSeconds = stats.reduce((sum, value) => sum + value.analyzedSeconds, 0);
	return { variants, warnings: [...warnings], faceCoverage: options.mode === 'follow' ? totalCoverage / Math.max(1, measured) : null, videoCount: videos.length,
		...(options.mode === 'speakers' ? { speakerSummary: { coverage: stats.reduce((sum, value) => sum + value.coverage * value.analyzedSeconds, 0) / Math.max(1e-9, analyzedSeconds),
			switches: stats.reduce((sum, value) => sum + value.switches, 0), analyzedSeconds,
			fallbackSeconds: stats.reduce((sum, value) => sum + value.fallbackSeconds, 0),
			evidenceSeconds: stats.reduce((sum, value) => sum + value.evidenceSeconds, 0),
			heldSeconds: stats.reduce((sum, value) => sum + value.heldSeconds, 0),
			wideSeconds: stats.reduce((sum, value) => sum + value.wideSeconds, 0),
			manualSeconds: stats.reduce((sum, value) => sum + value.manualSeconds, 0) } } : {}) };
}
