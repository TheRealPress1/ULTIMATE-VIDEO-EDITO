/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { webMediaService } from "../../web-media";

import type { MainHandler } from "../handler";

/**
 * Searches in main, where the network is the app's: the agent's sandbox has
 * none. Downloading is `web_media_download`, a renderer tool, since the file
 * has to go into the open project's live library.
 */
export const webMediaSearch: MainHandler<"web_media_search"> = (args, ctx) => webMediaService().search(args, ctx.signal);
