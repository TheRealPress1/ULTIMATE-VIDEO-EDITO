/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { logs } from "./logs";
import { skills, editingStyle } from "./skills";
import { memory } from "./memory";
import { skillWrite } from "./skill-write";
import { audioCatalog } from "./audio-catalog";
import { report } from "./report";
import { window } from "./window";
import { instagramAccounts, instagramPosts, instagramPostAnalytics, instagramAccountInsights } from "./instagram";
import { webMediaSearch } from "./web-media";
import { soundAnalyze } from "./sound";
import { mediaSearch } from "./media";
import { scriptLint } from "./script";
import { askGemini } from "./gemini";

import type { MainHandlers } from "../handler";

/** Every tool main answers itself, keyed by its catalog name. */
export const mainHandlers: MainHandlers = {
  skills,
  editing_style: editingStyle,
  memory,
  skill_write: skillWrite,
  audio_catalog: audioCatalog,
  logs,
  report,
  window,
  instagram_accounts: instagramAccounts,
  instagram_posts: instagramPosts,
  instagram_post_analytics: instagramPostAnalytics,
  instagram_account_insights: instagramAccountInsights,
  web_media_search: webMediaSearch,
  sound_analyze: soundAnalyze,
  media_search: mediaSearch,
  script_lint: scriptLint,
  ask_gemini: askGemini,
};
