import { z } from "zod";
import { defineTool } from "../tool";
import { AssetPath } from "../schemas";

const Fingerprint = z.string().regex(/^[a-f0-9]{64}$/).describe("Full source SHA-256 returned by footage_search; binds a passage to the inspected recording.");
const Passage = z.object({
  assetId: z.string().min(1).max(200),
  fingerprint: Fingerprint,
  sourceIn: z.number().nonnegative().max(7200).describe("Passage start in original source seconds."),
  sourceOut: z.number().positive().max(7200).describe("Passage end in original source seconds."),
}).refine((value) => value.sourceOut > value.sourceIn, "A passage must end after it starts.");
const Word = z.object({ text: z.string(), start: z.number().nonnegative(), end: z.number().positive() });
const Match = z.object({
  id: z.string(),
  assetId: z.string(),
  path: z.string(),
  fingerprint: Fingerprint,
  sourceIn: z.number().nonnegative(),
  sourceOut: z.number().positive(),
  text: z.string(),
  words: z.array(Word),
});
const Item = z.object({
  assetId: z.string(),
  path: z.string(),
  status: z.enum(["unindexed", "partial", "ready", "indexing", "stale", "error", "no-speech"]),
  error: z.string().optional(),
  partial: z.object({ completed: z.int().nonnegative(), total: z.int().positive() }).optional(),
});

export const footageIndex = defineTool({
  name: "footage_index",
  title: "Index project footage",
  description: "Build or refresh the open project's persistent local speech index for imported video/audio, optionally restricted to library paths. Uses Whisper base on this computer; first use downloads its model. Reuses transcripts for unchanged full source contents across restarts, renames and copies. No media is uploaded or modified. Supports local sources up to two hours, processed in five-minute sections with overlap; completed sections survive cancellation and restart. Call footage_index again to resume a partial item; assets without speech are recorded separately from errors. Returns per-asset status, including failures. Use footage_search to find spoken passages afterward. This searches recognized speech, not objects, visual scenes, speakers or music.",
  input: z.object({ paths: z.array(AssetPath).min(1).max(2000).optional().describe("Imported library paths; omit to index all current audio/video assets.") }),
  output: z.object({ items: z.array(Item) }),
  environment: "renderer",
  annotations: { destructiveHint: false, openWorldHint: false },
});

export const footageSearch = defineTool({
  name: "footage_search",
  title: "Search indexed speech",
  description: "Search the open project's persistent footage transcripts for literal spoken words and phrases. Refreshes source fingerprints before searching, so changed, missing or unindexed media cannot supply stale results. Does not run transcription: use footage_index first. Returns source-time passages with current asset IDs, full source fingerprints and word timings. An empty query browses recognized passages. Use a path filter and limit for large libraries. Verify recognition and surrounding context before editing; semantic visual or speaker search is not provided.",
  input: z.object({
    query: z.string().trim().max(1000).default(""),
    path: AssetPath.optional().describe("Restrict matches to this imported library path."),
    limit: z.int().min(1).max(200).default(100),
  }),
  output: z.object({
    matches: z.array(Match),
    total: z.int().nonnegative().describe("Matching passages before the limit was applied."),
    unavailable: z.array(Item).describe("Sources omitted because they are unindexed, changed, indexing, or unavailable; inspect these before treating an empty search as conclusive."),
  }),
  environment: "renderer",
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
});

export const footageCut = defineTool({
  name: "footage_cut",
  title: "Create cut from speech passages",
  description: "Assemble an editable new scene from ordered source-time passages returned by footage_search. Pass each asset ID, full fingerprint, sourceIn and sourceOut; the app resolves trusted indexed words and revalidates source files before writing. Stale or missing media fails without replacing an existing cut. Original footage and existing scenes are preserved. Supports up to 100 passages; each passage keeps its source audio and starts after the preceding passage in the new timeline. Word-derived captions use the assembled timeline. Review joins and recognition afterward, and use capture/check before presenting the edit.",
  input: z.object({
    passages: z.array(Passage).min(1).max(100),
    name: z.string().trim().min(1).max(120).optional().describe("Name for the new scene."),
    width: z.int().positive().max(8192).optional(),
    height: z.int().positive().max(8192).optional(),
  }),
  output: z.object({ sceneId: z.string(), duration: z.number().positive(), clipCount: z.int().positive() }),
  environment: "renderer",
  annotations: { destructiveHint: false, openWorldHint: false },
});
