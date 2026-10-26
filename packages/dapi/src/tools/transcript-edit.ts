import { z } from 'zod';
import { defineTool } from '../tool';
import { SceneId } from '../schemas';

const Range = z.object({ start: z.number().nonnegative().max(3600), end: z.number().positive().max(3600) }).refine((range) => range.end > range.start, 'End must follow start.');
const Revision = z.string().regex(/^[a-f0-9]{64}$/);
const Word = z.object({ id: z.string(), segment: z.int().nonnegative(), text: z.string(), start: z.number(), end: z.number() });
const Passage = z.object({ id: z.string(), text: z.string(), start: z.number(), end: z.number(), wordIds: z.array(z.string()) });
const Suggestion = z.object({ id: z.string(), kind: z.enum(['filler', 'silence']), text: z.string(), start: z.number(), end: z.number() });

export const transcriptEditInspect = defineTool({
	name: 'transcript_edit_inspect',
	title: 'Inspect editable timeline transcript',
	description: 'Read the current scene transcript and preview conservative filler-word and measured quiet-pause removal suggestions. Existing scene-aligned caption words preserve manual corrections; set refreshTranscript to transcribe the edited audio locally instead when captions are missing or outdated. Missing captions also trigger local transcription automatically. Quiet pauses are measured from the actual scene mix and exclude recognized words; suggestions are optional, not editing decisions. Does not change the composition. Returns source scene-time words/passages, a revision binding the inspected edit and media, and pagination for long transcripts. Kept passages can be reordered or subtracted before transcript_edit_apply edits this SAME scene. Supports flat multitrack clips and simple sequences; unsupported timing containers, sync links, transitions, preset animations and multiple/timed captions fail clearly. Local media and scenes up to one hour; first Whisper use may download weights.',
	input: z.object({ id: SceneId, refreshTranscript: z.boolean().default(false), wordOffset: z.int().min(0).max(100000).default(0), wordLimit: z.int().min(1).max(5000).default(2000) }),
	output: z.object({ revision: Revision, sceneId: z.string(), sceneName: z.string(), duration: z.number().positive(), frameRate: z.number().positive(), transcriptSource: z.enum(['captions', 'transcribed']), words: z.array(Word), passages: z.array(Passage), suggestions: z.array(Suggestion), warnings: z.array(z.string()), totalWords: z.int().positive(), wordOffset: z.int().nonnegative(), nextWordOffset: z.int().nonnegative().nullable() }),
	environment: 'renderer',
	annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
});

export const transcriptEditApply = defineTool({
	name: 'transcript_edit_apply',
	title: 'Edit current timeline from transcript',
	description: 'Apply ordered, nonoverlapping scene-time ranges to KEEP from transcript_edit_inspect. Omitted time is removed from the current scene, and the supplied ranges are assembled in order. Every supported video/audio/graphic layer is sliced together using its existing source trim and speed; captions are rebuilt on the edited timeline. The original media files stay intact. This changes the existing scene, saves a named Before transcript edit recovery version first, resets the export workarea, and groups changes into one Undo step. Requires the exact inspected revision and the same open project; stale scene/media or canceled preparation fails before composition mutation. At most 500 ranges and 2,000 resulting clip pieces. Review words, joins and overlapping speech before applying; the tool does not export or publish.',
	input: z.object({ id: SceneId, revision: Revision, ranges: z.array(Range).min(1).max(500).describe('Scene seconds from inspection, in desired output order. Include all time you want to retain, including desired intro/outro pauses.') }),
	output: z.object({ sceneId: z.string(), duration: z.number().positive(), previousDuration: z.number().positive(), clipCount: z.int().positive(), captionPath: z.string(), checkpointId: z.string() }),
	environment: 'renderer',
	annotations: { destructiveHint: true, openWorldHint: false },
});
