/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { DapiError } from "@diffusionstudio/dapi";

import type { MainHandler } from "../handler";

/** In main: the personal layer lives in userData, which only the app writes. */
export const audioCatalog: MainHandler<"audio_catalog"> = async (args, ctx) => {
  if (!ctx.audioCatalog) throw new DapiError("unsupported", "The music and sound effect catalog is unavailable in this app session.");
  return ctx.audioCatalog.run(args);
};
