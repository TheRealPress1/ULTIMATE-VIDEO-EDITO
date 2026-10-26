import { mainBridge } from '@/lib/ipc';
import { MAIN_CHANNELS } from '@desktop/main-channels';
import { flushProjectEdits } from './edits';

/** Installed at app startup so Quit also works on the dashboard or a failed project. */
export function installProjectFlushHandler(): () => void {
	return mainBridge.handle(MAIN_CHANNELS.PROJECTS_FLUSH_REQUEST, ({ id }) => {
		void (async () => {
			let error: string | undefined;
			try { await flushProjectEdits(); }
			catch (failure) { error = failure instanceof Error ? failure.message : String(failure); }
			await mainBridge.call(MAIN_CHANNELS.PROJECTS_FLUSH_RESULT, { id, ...(error ? { error } : {}) });
		})().catch((error) => console.error('Could not report project save result:', error));
	});
}
