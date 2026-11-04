/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Settings' side of the Gemini connection: its status, saving a key or a model,
// and removing the key. The key goes in and never comes back; a refused key is
// reported by a message that is safe to show.

import { mainBridge } from "../main-manager";
import { MAIN_CHANNELS } from "../main-channels";

import type { GeminiService } from "./index";

export function registerGeminiIpc(service: GeminiService): void {
  mainBridge.handle(MAIN_CHANNELS.GEMINI_STATUS, () => service.status());
  mainBridge.handle(MAIN_CHANNELS.GEMINI_UPDATE, (change) => service.update(change));
  mainBridge.handle(MAIN_CHANNELS.GEMINI_CLEAR, () => service.clear());
}
