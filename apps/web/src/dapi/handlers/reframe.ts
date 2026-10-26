import { DapiError } from '@diffusionstudio/dapi';
import { createReframeVariants } from '@/engine/reframe';
import { requireScene } from '../lib/scene';
import type { ToolHandler } from '../handler';

export const reframe: ToolHandler<'reframe'> = async ({ id, formats, mode, name, speakerFraming }, ctx) => {
	const session = ctx.requireSession();
	const dir = session.project.dir();
	const assertCurrent = () => {
		ctx.signal.throwIfAborted();
		if (ctx.session() !== session || session.project.dir() !== dir) throw new DapiError('no-project', 'The open project changed while creating format versions.');
	};
	assertCurrent();
	const scene = requireScene(session.world, id, 'reframe', 'format versions copy a complete scene');
	const result = await createReframeVariants(session.world, dir, scene, { formats, mode, name, ...(speakerFraming ? { speakerFraming } : {}), signal: ctx.signal, assertCurrent });
	try { assertCurrent(); }
	catch (cause) { throw new Error('The format versions were created and saved, but the request stopped afterward. Open the project and review them before creating more.', { cause }); }
	return result;
};
