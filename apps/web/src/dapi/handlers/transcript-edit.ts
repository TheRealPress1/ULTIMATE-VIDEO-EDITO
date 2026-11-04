import { DapiError } from '@diffusionstudio/dapi';
import { applyTranscriptEdit, prepareTranscriptEdit } from '@/engine/transcript-edit';
import { requireScene } from '../lib/scene';
import type { ToolContext, ToolHandler } from '../handler';

function current(ctx: ToolContext, id: string) {
	const session = ctx.requireSession(), dir = session.project.dir();
	const assertCurrent = () => {
		ctx.signal.throwIfAborted();
		if (ctx.session() !== session || session.project.dir() !== dir) throw new DapiError('no-project', 'The project changed while working with the timeline transcript.');
	};
	assertCurrent();
	return { session, dir, scene: requireScene(session.world, id, 'edit transcript', 'transcript editing changes a complete scene timeline'), assertCurrent };
}

export const transcriptEditInspect: ToolHandler<'transcript_edit_inspect'> = async ({ id, refreshTranscript, wordOffset, wordLimit, pauses, fillers, retakes }, ctx) => {
	const { session, dir, scene, assertCurrent } = current(ctx, id);
	const snapshot = await prepareTranscriptEdit(session.world, dir, scene, { refreshTranscript, signal: ctx.signal, assertCurrent, suggestions: { pauses, fillers, retakes } });
	assertCurrent();
	const words = snapshot.words.slice(wordOffset, wordOffset + wordLimit);
	const visible = new Set(words.map((word) => word.id));
	// Include the pause on either page boundary, so silence between the last
	// word of one page and the first of the next never disappears from both.
	const from = words.length ? wordOffset > 0 ? snapshot.words[wordOffset - 1]?.end ?? 0 : 0 : Infinity;
	const to = words.length ? snapshot.words[wordOffset + words.length]?.start ?? snapshot.duration : -Infinity;
	return { ...snapshot, words, passages: snapshot.passages.filter((passage) => passage.wordIds.some((word) => visible.has(word))), suggestions: snapshot.suggestions.filter((suggestion) => suggestion.start <= to && suggestion.end >= from), totalWords: snapshot.words.length, wordOffset, nextWordOffset: wordOffset + words.length < snapshot.words.length ? wordOffset + words.length : null };
};

export const transcriptEditApply: ToolHandler<'transcript_edit_apply'> = async ({ id, revision, ranges }, ctx) => {
	const { session, dir, scene, assertCurrent } = current(ctx, id);
	const result = await applyTranscriptEdit(session.world, dir, scene, revision, ranges, { signal: ctx.signal, assertCurrent });
	try { assertCurrent(); }
	catch (cause) { throw new Error('The transcript edit was applied and saved before the request stopped. Open the project and review it before making another edit.', { cause }); }
	return result;
};
