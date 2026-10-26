/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { CollectionRecord } from "@/projects";

export type DashboardView = "home" | "projects" | "drafts" | "templates" | "ai-credits" | "billing" | "account" | "settings" | "mcp" | "preferences" | "help";
/** Which projects the projects view lists: all of them, the drafts, or one collection's. */
export type ProjectScope =
  | { kind: "all" }
  | { kind: "drafts" }
  | { kind: "collection"; collection: CollectionRecord };
export type ProjectSortOption = | "last-viewed" | "alphabetical" | "date-created";
export type TemplateSourceOption = "official" | "custom";
export type TemplatePreviewKind = "landscape" | "portrait" | "square";

export type TemplateCard = {
  name: string;
  resolution: string;
  badge: string;
  previewKind: TemplatePreviewKind;
};
