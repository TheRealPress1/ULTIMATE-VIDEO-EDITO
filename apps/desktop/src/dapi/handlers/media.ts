/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { mediaSearchService } from "../../media-search";

import type { MainHandler } from "../handler";

/**
 * Searches in main, where the managed downloader and the network are the
 * app's: the agent's sandbox has neither. Downloading is `media_download`, a
 * renderer tool, since the file has to go into the open project's live
 * library.
 */
export const mediaSearch: MainHandler<"media_search"> = (args, ctx) => mediaSearchService().search(args, ctx.signal);
