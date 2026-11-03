/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The music and sound-effect catalog: Cutroom's curated defaults (shipped in
// the docs, read-only) merged with the user's personal layer (an app-owned
// file in userData, the only thing `save` and `reset` change). Entries carry
// structured fields (mood, energy, vocals, rights, a usable source range, the
// moment an effect lands) so an agent filters instead of reading prose, and a
// `download` hint naming the tool call that fetches the source.

import { z } from "zod";
import { defineTool } from "../tool";

/** Personal entries per kind, at most. */
export const AUDIO_CATALOG_PERSONAL_MAX = 500;
/** The personal file's size per kind, at most. */
export const AUDIO_CATALOG_PERSONAL_BYTES = 512 * 1024;
/** Entries one `list` returns, at most. */
export const AUDIO_CATALOG_LIST_MAX = 200;

export const AUDIO_CATALOG_ID_PREFIXES = ["youtube", "freesound", "wikimedia", "openverse", "myinstants", "url", "user"] as const;

export const CatalogKind = z.enum(["music", "sfx"]);

export const CatalogId = z
  .string()
  .regex(/^(youtube|freesound|wikimedia|openverse|myinstants|url|user):[A-Za-z0-9._~-]{1,128}$/, "use `<source>:<id>`, e.g. `youtube:<video id>`, `freesound:<sound id>`, `wikimedia:<page id>`, `myinstants:<slug>` or `user:<name>`")
  .describe("stable entry id: `youtube:<video id>`, `freesound:<sound id>`, `wikimedia:<page id>`, `openverse:<id>`, `myinstants:<slug>`, `url:<name>` or `user:<name>`");

export const CatalogMood = z.enum([
  "calm", "reflective", "curious", "playful", "comedic", "upbeat", "warm", "dreamy", "nostalgic", "romantic", "emotional", "triumphant",
  "motivational", "hype", "confident", "luxurious", "tense", "dark", "eerie", "mysterious", "epic", "cinematic", "retro", "aggressive",
]);

export const CatalogUse = z.enum([
  "talking-head", "interview", "explainer", "tutorial", "vlog", "travel", "food", "fitness", "sports", "tech", "business", "product",
  "montage", "story", "documentary", "comedy", "reveal", "hook", "intro", "outro", "transition", "background-bed",
]);

const RightsCode = z.enum(["copyrighted", "royalty-free", "cc0", "cc-by", "cc-by-sa", "public-domain", "unknown"]);
export const CatalogRights = RightsCode
  .describe("copyrighted: commercial recording, fine for drafts and private edits, may be muted or claimed when published; royalty-free: free under the owner's terms in `attribution`; cc0/public-domain: no conditions; cc-by/cc-by-sa: credit the `attribution` line (and share alike)");

export const SfxCategory = z.enum([
  "whoosh", "swipe", "riser", "downlifter", "impact", "boom", "click", "pop", "typing", "notification", "shutter", "glitch",
  "sparkle", "success", "fail", "cash", "meme", "ambience", "foley",
]);

export const CatalogVocals = z.enum(["none", "light", "lead"]).describe("none: instrumental; light: wordless or sparse vocal chops; lead: a sung or rapped lead");
export const MusicVariant = z.enum(["original", "instrumental", "score", "remix", "edit"]);
export const SfxAlign = z.enum(["onset", "hit", "end", "span"]).describe("how to place an effect: onset at the event, hit so `hitAt` lands on it, end so the sound finishes on it (a riser into a cut), span across the motion (a whoosh)");
export const SectionLabel = z.enum(["intro", "build", "drop", "main", "breakdown", "bridge", "outro", "loop", "hit", "tail"]);

const MAX_SOURCE_SECONDS = 6 * 3600;
const Seconds = z.number().nonnegative().max(MAX_SOURCE_SECONDS);

/**
 * Characters that show nothing or reorder what follows: C0 and C1 controls,
 * the soft hyphen, bidi marks, embeddings, overrides and isolates, line and
 * paragraph separators, zero-width and other invisible format characters, and
 * the byte-order mark. Catalog text drops them; a URL that holds one is refused.
 */
const INVISIBLE_CLASS = "\\u0000-\\u001f\\u007f-\\u009f\\u00ad\\u061c\\u180e\\u200b-\\u200f\\u2028-\\u202e\\u2060-\\u206f\\ufeff";
const INVISIBLE = new RegExp(`[${INVISIBLE_CLASS}]`, "g");
const BREAKS = /[\r\n\t\u2028\u2029]+/g;

/** Catalog text as it is stored: line breaks and tabs to spaces, invisible and control characters out, trimmed. */
export function cleanCatalogText(value: string): string {
  return value.replace(BREAKS, " ").replace(INVISIBLE, "").trim();
}

/** Text an entry shows: cleaned first, so a value made only of invisible characters is refused rather than stored empty. */
const Text = (max: number) => z.string().overwrite(cleanCatalogText).min(1, "needs at least one visible character").max(max);
const HttpsUrl = z
  .string()
  .trim()
  .max(2048)
  .regex(new RegExp(`^https://[^\\s/?#${INVISIBLE_CLASS}]+[^\\s${INVISIBLE_CLASS}]*$`, "i"), "use an https URL without spaces, control or invisible characters");
const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "use YYYY-MM-DD");

export const SourceRange = z
  .object({ start: Seconds, end: Seconds })
  .refine((range) => range.end > range.start, "a range ends after it starts")
  .describe("source seconds worth using, for sourceIn/sourceOut");

export const CatalogSection = z
  .object({ label: SectionLabel, start: Seconds, end: Seconds })
  .refine((section) => section.end > section.start, "a section ends after it starts");

/** What every entry may carry, music or effect, besides its id. */
const fieldShape = {
  title: Text(120).describe("music: `Title — Artist`, with `(Instrumental)` when it is one"),
  description: Text(400).describe("what the piece sounds like and what it suits"),
  sourceUrl: HttpsUrl.describe("what to pass to the download tool"),
  durationSeconds: z.number().positive().max(MAX_SOURCE_SECONDS).describe("the whole source's length as verified"),
  rights: CatalogRights,
  verifiedAt: IsoDate.describe("when the source was last checked to exist and match"),
  pageUrl: HttpsUrl.optional().describe("the page to credit when `sourceUrl` is a file"),
  attribution: Text(300).optional().describe("the credit line or terms to follow"),
  tags: z.array(Text(40)).max(12).optional(),
  uses: z.array(CatalogUse).max(8).optional().describe("edits it suits"),
  avoid: z.array(CatalogUse).max(6).optional().describe("edits it is wrong for"),
  sourceRange: SourceRange.optional(),
  sections: z.array(CatalogSection).max(12).optional().describe("labeled source spans, in order"),
  suggestedVolumeDb: z.number().min(-40).max(0).optional().describe("a starting clip volume: music, a bed about 18 LU under dialogue at -16 LUFS; effects, the uve-sfx starting level for the category, raised by however far the file peaks below 0 dBFS"),
};
const entryShape = { id: CatalogId, ...fieldShape };

const musicShape = {
  artist: Text(120).optional(),
  variant: MusicVariant.optional(),
  vocals: CatalogVocals.optional(),
  explicit: z.boolean().optional(),
  moods: z.array(CatalogMood).max(6).optional(),
  energy: z.int().min(1).max(5).optional().describe("1 a quiet bed to 5 full intensity"),
  bpm: z.number().min(20).max(300).optional(),
  loudnessLufs: z.number().min(-70).max(0).optional().describe("integrated loudness over `sourceRange` (the whole source without one)"),
};

const sfxShape = {
  category: SfxCategory.optional(),
  align: SfxAlign.optional(),
  hitAt: Seconds.optional().describe("source second of the moment the effect lands: an impact's transient, a riser's peak, a whoosh's loudest point"),
  peakDb: z.number().min(-90).max(12).optional().describe("sample peak in dBFS over `sourceRange`; a decoded lossy file can pass 0"),
};

const personalShape = {
  hidden: z.boolean().optional().describe("leave this entry out of lists"),
  preferred: z.boolean().optional().describe("list this entry first"),
  notes: Text(500).optional().describe("the user's own note about when to use it"),
  addedAt: z.iso.datetime().optional().describe("when the user added the entry"),
};

/** A merged entry's fields: any kind, everything but the identity optional, since a personal entry needs only a title, a description and a source. */
export const CatalogEntry = z.object({
  ...entryShape,
  description: entryShape.description.optional(),
  durationSeconds: entryShape.durationSeconds.optional(),
  verifiedAt: entryShape.verifiedAt.optional(),
  ...musicShape,
  ...sfxShape,
  ...personalShape,
});

/** A default music entry: every musical field an agent filters by is present. */
export const MusicCatalogEntry = z.strictObject({
  ...entryShape,
  description: Text(400).min(80),
  ...musicShape,
  artist: musicShape.artist.unwrap(),
  variant: musicShape.variant.unwrap(),
  vocals: musicShape.vocals.unwrap(),
  moods: z.array(CatalogMood).min(1).max(6),
  energy: z.int().min(1).max(5),
});

/** A default effect entry. */
export const SfxCatalogEntry = z.strictObject({
  ...entryShape,
  description: Text(400).min(80),
  ...sfxShape,
  category: SfxCategory,
});

/** The bundled file, `reference/catalogs/<kind>.json`. */
export const AudioCatalogFile = z.discriminatedUnion("kind", [
  z.strictObject({ version: z.literal(1), kind: z.literal("music"), updated: IsoDate, entries: z.array(MusicCatalogEntry) }),
  z.strictObject({ version: z.literal(1), kind: z.literal("sfx"), updated: IsoDate, entries: z.array(SfxCatalogEntry) }),
]);

type Nullish<S extends Record<string, z.ZodType>> = {
  [K in keyof S]: z.ZodOptional<z.ZodNullable<z.ZodType<Exclude<z.output<S[K]>, undefined>, Exclude<z.input<S[K]>, undefined>>>>;
};

/** Every field of `shape` optional and nullable: absent inherits, null clears. */
function nullish<S extends Record<string, z.ZodType>>(shape: S): Nullish<S> {
  return Object.fromEntries(
    Object.entries(shape).map(([key, schema]) => [key, (schema instanceof z.ZodOptional ? (schema.unwrap() as z.ZodType) : schema).nullable().optional()]),
  ) as Nullish<S>;
}

/** Any entry field, as a personal override sets it: null clears an optional field, absent inherits the default. */
const patchShape = nullish({ ...fieldShape, ...musicShape, ...sfxShape, ...personalShape });

/** The fields a personal override may name, for `reset` with `fieldNames`. */
export const CATALOG_PATCH_FIELDS = Object.keys(patchShape) as Array<keyof typeof patchShape>;
export const CatalogPatchField = z.enum(CATALOG_PATCH_FIELDS as [keyof typeof patchShape, ...Array<keyof typeof patchShape>]);

/** What `save` sends: only known fields, each optional, null to clear. */
export const CatalogPatchFields = z.strictObject(patchShape);

/** One personal override as stored: an id and the fields it sets; unknown keys survive on disk. */
export const CatalogPatch = z.looseObject({ id: CatalogId, ...patchShape });

/** The personal file, `<userData>/audio-catalog/<kind>.local.json`. */
export const PersonalCatalogFile = z.object({
  version: z.literal(1),
  revision: z.int().nonnegative(),
  updatedAt: z.string().nullable(),
  entries: z.array(CatalogPatch).max(AUDIO_CATALOG_PERSONAL_MAX),
});

export const CatalogDownload = z.object({
  tool: z.enum(["media_download", "web_media_download"]),
  url: z.string(),
  folder: z.enum(["music", "sfx"]),
}).describe("the call that fetches this source into the project: pass `url` and `folder` to `tool`");

const Origin = z.enum(["default", "personal", "overridden"]);

/** A merged entry with everything it carries, as `get` and `detail: "full"` return it. */
export const MergedCatalogEntry = CatalogEntry.extend({
  rights: CatalogRights,
  origin: Origin,
  overridden: z.array(z.string()),
  needsVerification: z.boolean(),
  selectable: z.boolean(),
  download: CatalogDownload,
});

/**
 * An entry as an answer publishes it. The catalog's own fields pass through
 * as they are (reference/catalogs/README.md documents them), so the schema
 * names only what every answer relies on: spelling the whole entry out for
 * each place one appears would cost every session several kilobytes.
 */
const AnswerEntry = z.looseObject({
  id: z.string(),
  title: z.string(),
  rights: RightsCode,
  origin: Origin.describe("default: Cutroom's entry as shipped; personal: the user's own; overridden: a default the user changed"),
  overridden: z.array(z.string()).optional().describe("fields the personal layer sets; a summary leaves it out when there are none"),
  needsVerification: z.boolean().optional().describe("true when the source moved without new timing: recheck duration and range first; a summary leaves it out when false"),
  selectable: z.boolean().optional().describe("false for a hidden entry; a summary leaves it out when true"),
  download: CatalogDownload,
}).describe("the entry's catalog fields (reference/catalogs/README.md#entry-fields) with its origin and download");
const AnswerLayer = z.looseObject({ id: z.string() });

const filterShape = {
  query: z.string().trim().min(1).max(120).optional().describe("words matched against title, artist, description, tags and notes"),
  moods: z.array(CatalogMood).min(1).max(6).optional().describe("music: any of these moods"),
  uses: z.array(CatalogUse).min(1).max(8).optional().describe("any of these uses"),
  category: z.array(SfxCategory).min(1).max(19).optional().describe("effects: any of these categories"),
  vocals: z.array(CatalogVocals).min(1).max(3).optional().describe('music: e.g. ["none"] for instrumentals under speech'),
  energyMin: z.int().min(1).max(5).optional().describe("music: the lowest energy, 1 (a quiet bed) to 5 (full intensity)"),
  energyMax: z.int().min(1).max(5).optional().describe("music: the highest energy, 1 (a quiet bed) to 5 (full intensity)"),
  maxDurationSeconds: z.number().positive().max(MAX_SOURCE_SECONDS).optional().describe("usable length (the source range, else the whole source) at most this"),
  rights: z.array(CatalogRights).min(1).max(7).optional().describe('e.g. ["cc0", "cc-by", "royalty-free", "public-domain"] for a post that must not be muted'),
};
const FILTERS = Object.keys(filterShape) as Array<keyof typeof filterShape>;
const MUSIC_FILTERS = new Set(["moods", "vocals", "energyMin", "energyMax"]);

export const audioCatalog = defineTool({
  name: "audio_catalog",
  title: "Music and sound effect catalog",
  description:
    "Cutroom's curated music beds and sound effects, merged with the user's personal catalog (shared by every project and both agents). Read it before choosing music or effects the user didn't supply. `list` filters by mood, use, energy, vocals, category, rights and usable length and returns compact entries; `detail: \"full\"` adds descriptions, credits, sections and what each entry is wrong for; `get` returns one entry in full with its default and personal layers. Each entry's `download` names the call that fetches it (media_download for YouTube, MyInstants and Freesound pages, web_media_download for Commons and Freesound files) with the `url` and `folder` to pass. `sourceRange` is in source seconds for sourceIn/sourceOut, `suggestedVolumeDb` is a starting clip volume (a bed under speech; an effect at its category's level, corrected for the file's peak), and an effect's `hitAt` and `align` say where its moment lands. `rights: \"copyrighted\"` suits drafts and private edits and may be muted or claimed when posted; prefer cc0, public-domain, cc-by or royalty-free entries for published work, and put their `attribution` in the caption. `save` and `reset` change only the personal catalog, and only when the user explicitly asks to remember, prefer, hide, correct or add an entry; send `expectedRevision` from the last call, and a stale one fails without overwriting. Placing a track never saves it. Needs no open project.",
  input: z.object({
    action: z.enum(["list", "get", "save", "reset"]).default("list").describe("list (default), get one entry, save a personal override or entry, reset (drop) a personal override"),
    kind: CatalogKind.describe("music or sfx"),
    id: CatalogId.optional().describe("the entry, for get, save and reset; a new personal entry takes `user:<name>` or its source's id"),
    ...filterShape,
    includeHidden: z.boolean().default(false).describe("list: include entries the user hid"),
    detail: z.enum(["summary", "full"]).default("summary").describe("list: summary (default) leaves out descriptions, credits, sections and avoid lists"),
    limit: z.int().min(1).max(AUDIO_CATALOG_LIST_MAX).default(60).describe(`list: entries to return, 1-${AUDIO_CATALOG_LIST_MAX} (default: 60)`),
    // Published as the field names alone, each value checked in full when the call is parsed: the whole entry shape again would double the schema.
    fields: z.partialRecord(CatalogPatchField, z.unknown()).pipe(CatalogPatchFields).optional()
      .describe("save: entry fields to set on the personal layer, valued as in reference/catalogs/README.md#entry-fields; null clears one, omitted fields keep what they have"),
    expectedRevision: z.int().nonnegative().optional().describe("save/reset: `revision` from the last list or get"),
    fieldNames: z.array(CatalogPatchField).min(1).max(CATALOG_PATCH_FIELDS.length).optional().describe("reset: drop only these personal fields so they inherit the default again (default: drop the whole override)"),
    discardDamaged: z.boolean().optional().describe("reset: set an unreadable personal file aside (renamed, never deleted) and start an empty one; needs no id or revision"),
  }).superRefine((value, ctx) => {
    const discarding = value.action === "reset" && value.discardDamaged === true;
    if (value.action !== "list" && !value.id && !discarding) ctx.addIssue({ code: "custom", path: ["id"], message: `${value.action} needs an entry id.` });
    if (value.action === "save" && !value.fields) ctx.addIssue({ code: "custom", path: ["fields"], message: "save needs the fields to set." });
    if ((value.action === "save" || (value.action === "reset" && !value.discardDamaged)) && value.expectedRevision === undefined) {
      ctx.addIssue({ code: "custom", path: ["expectedRevision"], message: `${value.action} needs expectedRevision from the last list or get.` });
    }
    if (value.action !== "save" && value.fields) ctx.addIssue({ code: "custom", path: ["fields"], message: "fields apply only to save." });
    if (value.action !== "reset" && (value.fieldNames || value.discardDamaged !== undefined)) ctx.addIssue({ code: "custom", path: ["fieldNames"], message: "fieldNames and discardDamaged apply only to reset." });
    for (const filter of FILTERS) {
      if (value[filter] === undefined) continue;
      if (value.action !== "list") ctx.addIssue({ code: "custom", path: [filter], message: "Filters apply only to list." });
      else if (value.kind === "sfx" && MUSIC_FILTERS.has(filter)) ctx.addIssue({ code: "custom", path: [filter], message: `${filter} filters music, not sfx.` });
      else if (value.kind === "music" && filter === "category") ctx.addIssue({ code: "custom", path: [filter], message: "category filters sfx, not music." });
    }
    if (value.energyMin !== undefined && value.energyMax !== undefined && value.energyMin > value.energyMax) {
      ctx.addIssue({ code: "custom", path: ["energyMax"], message: "energyMax must be at least energyMin." });
    }
  }),
  output: z.object({
    kind: CatalogKind,
    revision: z.int().nonnegative().describe("the personal file's revision; pass it as expectedRevision to save or reset"),
    defaultsUpdated: z.string().nullable().describe("when Cutroom's defaults were last curated (YYYY-MM-DD)"),
    defaultsPath: z.string().nullable(),
    personalPath: z.string(),
    total: z.int().nonnegative().describe("entries matching the filters, before `limit`"),
    hiddenCount: z.int().nonnegative().describe("entries the user hid"),
    entries: z.array(AnswerEntry).describe("list: a summary leaves out sourceUrl (download.url has it), description, attribution, avoid, sections, pageUrl, verifiedAt, addedAt and loudnessLufs"),
    selected: z.object({
      id: z.string(),
      default: AnswerLayer.nullable().describe("Cutroom's entry as shipped"),
      personal: AnswerLayer.nullable().describe("the user's override: the fields it sets, null where it clears one"),
      merged: AnswerEntry.nullable().describe("the result, in full; null when too incomplete to list"),
      excludedReason: z.enum(["hidden", "incomplete", "no-source"]).optional(),
    }).optional().describe("get, save and reset: the entry's layers"),
    warnings: z.array(z.string()),
    personalError: z.string().optional().describe("why the personal file could not be read; the defaults are shown without it"),
  }),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  environment: "main",
});
