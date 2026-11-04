/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The add-on's main IPC: Settings' status line and its Install now and
// Remove buttons, `sound_effects`' main half, and `analyze`'s sound events,
// each cancelled with the call or when the window that asked goes away.

import { DapiError, isDapiError } from "@diffusionstudio/dapi";
import { mainBridge } from "../../main-manager";
import { MAIN_CHANNELS } from "../../main-channels";
import { runSoundEffects } from "./sound-effects";
import { earshotEvents } from "./events";

import type { EarshotService } from "./index";

export function registerEarshotIpc(service: EarshotService): void {
  mainBridge.handle(MAIN_CHANNELS.EARSHOT_STATUS, () => service.status());
  mainBridge.handle(MAIN_CHANNELS.EARSHOT_INSTALL, () => service.install());
  mainBridge.handle(MAIN_CHANNELS.EARSHOT_REMOVE, () => service.remove());

  const owners = new Map<string, { owner: number; cancel: () => void }>();
  mainBridge.handle(MAIN_CHANNELS.SOUND_EFFECTS_RUN, async (request, event) => {
    if (owners.has(request.id)) throw new Error("This sound effects call is already running.");
    const sender = event.sender;
    const controller = new AbortController();
    const cancel = () => controller.abort(new DapiError("canceled", "The sound effects call was canceled."));
    owners.set(request.id, { owner: sender.id, cancel });
    sender.once("destroyed", cancel);
    sender.once("render-process-gone", cancel);
    sender.once("did-start-loading", cancel);
    try {
      return await runSoundEffects(service, request, controller.signal);
    } catch (error) {
      // IPC carries the message only; the renderer turns `[code] ` back into the DapiError.
      if (isDapiError(error)) throw new Error(`[${error.code}] ${error.message}`, { cause: error });
      throw error;
    } finally {
      owners.delete(request.id);
      sender.removeListener("destroyed", cancel);
      sender.removeListener("render-process-gone", cancel);
      sender.removeListener("did-start-loading", cancel);
    }
  });
  mainBridge.handle(MAIN_CHANNELS.SOUND_EFFECTS_CANCEL, ({ id }, event) => {
    const work = owners.get(id);
    if (work?.owner === event.sender.id) work.cancel();
  });

  const listening = new Map<string, { owner: number; cancel: () => void }>();
  mainBridge.handle(MAIN_CHANNELS.EARSHOT_EVENTS, async (request, event) => {
    if (listening.has(request.id)) throw new Error("This listening call is already running.");
    const sender = event.sender;
    const controller = new AbortController();
    const cancel = () => controller.abort(new DapiError("canceled", "Listening for sound events was canceled."));
    listening.set(request.id, { owner: sender.id, cancel });
    sender.once("destroyed", cancel);
    sender.once("render-process-gone", cancel);
    sender.once("did-start-loading", cancel);
    try {
      return await earshotEvents(service, request, controller.signal);
    } catch (error) {
      if (isDapiError(error)) throw new Error(`[${error.code}] ${error.message}`, { cause: error });
      throw error;
    } finally {
      listening.delete(request.id);
      sender.removeListener("destroyed", cancel);
      sender.removeListener("render-process-gone", cancel);
      sender.removeListener("did-start-loading", cancel);
    }
  });
  mainBridge.handle(MAIN_CHANNELS.EARSHOT_EVENTS_CANCEL, ({ id }, event) => {
    const work = listening.get(id);
    if (work?.owner === event.sender.id) work.cancel();
  });
}
