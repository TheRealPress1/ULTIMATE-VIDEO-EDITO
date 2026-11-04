/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// script_read_compare's alignment, off the editor's main thread: a long
// shoot has tens of thousands of words, and the editor keeps drawing while
// they are lined up. One worker per request.

import { alignScriptRead } from './script-align';

import type { ScriptAlignOptions, ScriptLine, ScriptReadReport, SpokenWord } from './script-align';

export interface ScriptAlignRequest { script: ScriptLine[]; words: SpokenWord[]; options: ScriptAlignOptions }
export type ScriptAlignResponse = { report: ScriptReadReport } | { error: string };

// The app's lib is the DOM's, so the worker scope is narrowed by hand.
const scope = self as unknown as {
	onmessage: ((event: MessageEvent<ScriptAlignRequest>) => void) | null;
	postMessage(message: ScriptAlignResponse): void;
};

scope.onmessage = ({ data }) => {
	try {
		scope.postMessage({ report: alignScriptRead(data.script, data.words, data.options) });
	} catch (error) {
		scope.postMessage({ error: error instanceof Error ? error.message : String(error) });
	}
};
