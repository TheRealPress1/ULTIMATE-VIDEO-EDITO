import type { Asset, Transcript, TranscriptWord } from '@diffusionstudio/assets';
import type { AuthoredTree } from '@diffusionstudio/reconciler';

/** A retained source range, carrying the identity used when its words were indexed. */
export interface Passage {
	assetId: string;
	fingerprint: string;
	sourceIn: number;
	sourceOut: number;
	words: TranscriptWord[];
}

export interface TranscriptCutFormat {
	name?: string;
	width?: number;
	height?: number;
}

export interface TranscriptCutPlan {
	width: number;
	height: number;
	duration: number;
	clips: AuthoredTree[];
	transcript: Transcript;
}

/** Resolve and validate everything before any library or document mutation. */
export function planTranscriptCut(
	passages: readonly Passage[],
	resolve: (id: string) => Asset | undefined,
	fps: number,
	options: TranscriptCutFormat = {},
): TranscriptCutPlan {
	if (!Array.isArray(passages) || !passages.length || passages.length > 100) {
		throw new Error('Choose between 1 and 100 transcript passages.');
	}
	if (!Number.isFinite(fps) || fps <= 0) throw new Error('The project frame rate is invalid.');
	if (options.name !== undefined && (typeof options.name !== 'string' || !options.name.trim() || options.name.length > 120)) {
		throw new Error('Give the cut a name between 1 and 120 characters.');
	}
	const sources = passages.map((passage) => {
		if (!passage || typeof passage.assetId !== 'string' || !passage.assetId || typeof passage.fingerprint !== 'string' || !passage.fingerprint) {
			throw new Error('A selected passage has no verified source identity. Search the footage again.');
		}
		const asset = resolve(passage.assetId);
		if (!asset || (asset.type !== 'VIDEO' && asset.type !== 'AUDIO')) {
			throw new Error('A selected source is no longer an audio or video asset in this project.');
		}
		if (!Number.isFinite(asset.duration) || asset.duration <= 0 || !Number.isFinite(passage.sourceIn) ||
			!Number.isFinite(passage.sourceOut) || passage.sourceIn < 0 || passage.sourceOut <= passage.sourceIn ||
			passage.sourceOut > asset.duration + 0.000001) {
			throw new Error('A selected passage is outside its source duration. Search the footage again.');
		}
		if (!asset.path || !Array.isArray(passage.words) || !passage.words.length || passage.words.length > 100_000) {
			throw new Error('A selected passage has no usable transcript words.');
		}
		if (asset.type === 'VIDEO' && (!Number.isFinite(asset.width) || !Number.isFinite(asset.height) || asset.width <= 0 || asset.height <= 0)) {
			throw new Error('A selected video has invalid dimensions.');
		}
		return asset;
	});
	const firstVideo = sources.find((asset) => asset.type === 'VIDEO');
	const width = options.width ?? Math.round(firstVideo?.width ?? 1920);
	const height = options.height ?? Math.round(firstVideo?.height ?? 1080);
	if (![width, height].every((value) => Number.isInteger(value) && value > 0 && value <= 16384)) {
		throw new Error('Cut dimensions must be whole pixels between 1 and 16384.');
	}
	let cursor = 0;
	const transcript: Transcript = [];
	const clips = passages.map((passage, index): AuthoredTree => {
		const asset = sources[index]!;
		// The runtime rounds each boundary separately. Accumulate integer frames
		// so arbitrarily many fractional source ranges remain exactly gapless.
		const inFrame = Math.round(passage.sourceIn * fps);
		const outFrame = Math.min(Math.round(passage.sourceOut * fps), Math.round(asset.duration * fps));
		if (outFrame <= inFrame) throw new Error('A selected passage is shorter than one project frame.');
		const start = cursor / fps;
		const sourceIn = inFrame / fps;
		const sourceOut = outFrame / fps;
		const duration = (outFrame - inFrame) / fps;
		let previous = -Infinity;
		const words: TranscriptWord[] = [];
		for (const word of passage.words) {
			if (!word || typeof word.text !== 'string' || !word.text.trim() || !Number.isFinite(word.start) || !Number.isFinite(word.end) ||
				word.start < 0 || word.end <= word.start || word.start < previous || word.end > asset.duration + 0.001) {
				throw new Error('A selected passage contains invalid word timestamps. Re-index its source.');
			}
			previous = word.start;
			const from = Math.max(word.start, sourceIn);
			const to = Math.min(word.end, sourceOut);
			if (to <= from) continue;
			words.push({ text: word.text, start: start + from - sourceIn, end: Math.min(start + duration, start + to - sourceIn) });
		}
		if (!words.length) throw new Error('A selected passage contains no words inside its source range.');
		transcript.push({ text: words.map((word) => word.text.trim()).join(' '), words });
		cursor += outFrame - inFrame;
		const timing = { start, sourceIn, sourceOut, playbackRate: 1 };
		const name = `${asset.path.split('/').at(-1)?.replace(/\.[^.]+$/, '') || 'Footage'} · ${index + 1}`;
		if (asset.type === 'AUDIO') {
			return { tag: 'audio', props: { name, src: asset.path, ...timing, x: (width - 500) / 2, y: (height - 150) / 2, width: 500, height: 150 }, children: [] };
		}
		const scale = Math.min(width / asset.width, height / asset.height);
		const clipWidth = asset.width * scale;
		const clipHeight = asset.height * scale;
		return {
			tag: 'rect',
			props: { name, ...timing, keepAspectRatio: true, x: (width - clipWidth) / 2, y: (height - clipHeight) / 2, width: clipWidth, height: clipHeight },
			children: [{ tag: 'videoPaint', props: { src: asset.path }, children: [] }],
		};
	});
	return { width, height, duration: cursor / fps, clips, transcript };
}
