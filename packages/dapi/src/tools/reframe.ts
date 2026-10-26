import { z } from 'zod';
import { defineTool } from '../tool';
import { SceneId } from '../schemas';

const FramingPreference = z.enum(['auto', 'left', 'right', 'wide']);
const SpeakerFraming = z.object({
	preference: FramingPreference.optional().describe('Default for the scene: auto follows supported speaker evidence; left/right selects the person on that side and keeps their anonymous track within the shot; wide fits the complete image. Defaults to auto.'),
	overrides: z.array(z.object({
		start: z.number().nonnegative().describe('Inclusive start in edited scene seconds, after trims and playback speed; not original source seconds.'),
		end: z.number().positive().describe('Exclusive end in edited scene seconds; must be after start and within the scene.'),
		preference: z.enum(['auto', 'left', 'right', 'wide', 'hold']).describe('Framing for this range. Hold freezes the previous camera position; a shot cut resets it to full view.'),
	}).strict().refine(value => value.end > value.start, { message: 'A framing correction must end after it starts.', path: ['end'] })).max(100).optional()
		.describe('Non-overlapping scene-time corrections. Each replaces the default preference during [start,end); adjacent ranges are allowed.'),
}).strict().superRefine((value, ctx) => {
	const ranges = (value.overrides ?? []).map((range, index) => ({ ...range, index })).sort((a, b) => a.start - b.start);
	for (let i = 1; i < ranges.length; i++) if (ranges[i]!.start < ranges[i - 1]!.end) {
		ctx.addIssue({ code: 'custom', path: ['overrides', ranges[i]!.index, 'start'], message: 'Framing correction ranges must not overlap.' });
	}
});

export const reframe = defineTool({
	name: 'reframe',
	title: 'Create social format versions',
	description: 'Create editable new scene versions in vertical 9:16 (1080×1920), square 1:1 (1080×1080), or landscape 16:9 (1920×1080). Keeps the original scene and source files; copies audio, trims, speed and caption timing. Speakers mode uses a local audio/video active-speaker model to frame a supported visible speaker, with a brief hold or full-frame fit for uncertain, silent, overlapping or off-camera speech. Optional speakerFraming sets a global auto/left/right/wide preference and non-overlapping scene-second corrections, including hold of previous framing; explicit preferences do not count as model evidence. It authors editable x/y/scale camera keyframes in a new scene; it does not infer names or diarize off-camera voices. Speakers mode can replace existing x/y/scale crop tracks on full-frame video copies. Completed analysis sections persist across cancellation and restart. Follow mode samples faces locally on this Mac and authors smooth crop x/y keyframes, holding briefly through missed detections and resetting at sampled shot changes. It follows a prominent nearby face, not an identified speaker or arbitrary object. No-face footage uses a center crop with a warning. Center mode does no analysis. Captions are placed inside conservative inset margins; static overlays are uniformly fitted and flagged for review. Supports full-frame clips, sequences, audio, captions and static overlays; custom crops, spatial animation, nested video layouts and audio sync links require manual preparation. Speaker and face modes support up to two source hours per clip and 100 clips using bounded resumable analysis sections. All requested versions are one undoable composition change. Review captures, joins and framing before export; this does not publish or export.',
	input: z.object({
		id: SceneId,
		formats: z.array(z.enum(['vertical', 'square', 'landscape'])).min(1).max(3).refine((values) => new Set(values).size === values.length, 'Choose different formats.'),
		mode: z.enum(['speakers', 'follow', 'center']).default('follow'),
		speakerFraming: SpeakerFraming.optional().describe('Optional quick corrections for speakers mode only. Explicit left/right/wide/hold choices are editing preferences and never count as model confidence or detected speech.'),
		name: z.string().trim().min(1).max(100).optional().describe('Optional name prefix for the scene versions.'),
	}).superRefine((value, ctx) => {
		if (value.speakerFraming && value.mode !== 'speakers') ctx.addIssue({ code: 'custom', path: ['speakerFraming'], message: 'Speaker framing preferences require mode "speakers".' });
	}),
	output: z.object({
		variants: z.array(z.object({ sceneId: z.string(), name: z.string(), width: z.number(), height: z.number(), warnings: z.array(z.string()) })),
		warnings: z.array(z.string()),
		faceCoverage: z.number().min(0).max(1).nullable().describe('Fraction of analyzed samples containing a usable face, averaged across clips; null in center mode.'),
		videoCount: z.int().positive(),
		speakerSummary: z.object({ coverage: z.number().min(0).max(1), switches: z.int().nonnegative(), analyzedSeconds: z.number().nonnegative(), fallbackSeconds: z.number().nonnegative(),
			evidenceSeconds: z.number().nonnegative().optional(), heldSeconds: z.number().nonnegative().optional(), wideSeconds: z.number().nonnegative().optional(), manualSeconds: z.number().nonnegative().optional(),
		}).optional().describe('Visible-speaker evidence and framing durations. Explicit corrections are reported in manualSeconds and never increase model evidence coverage. Coverage is not a probability or real-world identity.'),
	}),
	environment: 'renderer',
	annotations: { destructiveHint: false, openWorldHint: false },
});
