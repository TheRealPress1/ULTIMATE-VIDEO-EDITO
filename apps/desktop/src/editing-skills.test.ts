import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { EDITING_SKILLS, SOUND_ANALYZE_FIELDS, isToolName, toolByName, toolJsonSchemas } from "@diffusionstudio/dapi";
import { readEditingSkills } from "./editing-skills";
import { editingStyle } from "./dapi/handlers/skills";
import { EditingStyleStore } from "./editing-style";
import type { MainContext } from "./dapi/handler";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
const repoDocs = join(__dirname, "..", "..", "..", "docs");

describe("shared UVE skill library", () => {
  it("ships every catalogued guide and returns its actual instructions to either agent", async () => {
    const listed = await readEditingSkills(repoDocs, { action: "list" });
    expect(listed.skills).toHaveLength(19);
    expect(listed.version).toBe("1.6.0");
    expect(listed.skills.every((skill) => skill.available)).toBe(true);
    for (const skill of EDITING_SKILLS) {
      const read = await readEditingSkills(repoDocs, { action: "read", id: skill.id });
      expect(read.selected?.content).toBe(await readFile(join(repoDocs, skill.path), "utf8"));
      expect(toolByName("skills").output.safeParse(read).success).toBe(true);
    }
  });

  it("lists the base guides and the web media workflow with the same frontmatter as other skills", async () => {
    const listed = await readEditingSkills(repoDocs, { action: "list" });
    expect(listed.skills.slice(0, 2).map((skill) => [skill.id, skill.path])).toEqual([["editor", "skills/editor.md"], ["watch", "skills/watch.md"]]);
    expect(listed.skills.find((skill) => skill.id === "uve-web-media")).toMatchObject({ path: "skills/uve-web-media/SKILL.md", category: "editing", available: true });
    for (const skill of EDITING_SKILLS.filter((entry) => entry.path.endsWith("/SKILL.md"))) {
      const content = await readFile(join(repoDocs, skill.path), "utf8");
      expect(content.startsWith(`---\nname: ${skill.id}\n`), skill.id).toBe(true);
    }
    const web = await readFile(join(repoDocs, "skills/uve-web-media/SKILL.md"), "utf8");
    expect(web.trimEnd().split("\n").length).toBeLessThanOrEqual(24);
    expect(web).toContain("web_media_search");
    expect(web).toContain("web_media_download");
    expect(web).toContain("assets/web/");
    expect(web).not.toContain("media/web");
  });

  it("ships original music and sound-effect workflows built on Cutroom's own tools", async () => {
    const listed = await readEditingSkills(repoDocs, { action: "list" });
    for (const id of ["uve-music", "uve-sfx"]) {
      expect(listed.skills.find((skill) => skill.id === id)).toMatchObject({ path: `skills/${id}/SKILL.md`, category: "editing", available: true });
    }
    const music = await readFile(join(repoDocs, "skills/uve-music/SKILL.md"), "utf8");
    const sfx = await readFile(join(repoDocs, "skills/uve-sfx/SKILL.md"), "utf8");
    for (const [content, words] of [
      [music, ["audio_catalog", "media_search", "media_download", "youtube_music", "instrumental", "sourceIn", "sourceOut", "audio_finish", "musicIds", "effectIds", "assets/music/", "web_media_search", "listen", "waveform", "sound_analyze", "p_vs_alts", "action: \"rank\""]],
      [sfx, ["audio_catalog", "hitAt", "web_media_search", "web_media_download", "media_download", "sourceIn", "assets/sfx/", "effectIds", "musicIds", "capture", "sound_effects", "onsetSeconds", "peakSeconds", "endSeconds", "sound_analyze", "action: \"check\""]],
    ] as const) {
      expect(content.trimEnd().split("\n").length).toBeLessThanOrEqual(30);
      for (const word of words) expect(content, word).toContain(word);
      // Cutroom's own wording and tools only: no other product's names, private files or shell recipes.
      for (const foreign of ["compound", "catalog.local.json", "media_listen", "yt-dlp", "uv run", "pip install", "curl "]) expect(content.toLowerCase(), foreign).not.toContain(foreign);
    }
    for (const [id, content] of [["uve-music", music], ["uve-sfx", sfx]]) {
      for (const [, link] of content.matchAll(/\]\((\.[^)#]+)/g)) expect(existsSync(join(repoDocs, "skills", id, link)), link).toBe(true);
    }
  });

  it("finds an instrumental with checks the tools can actually answer", async () => {
    const music = await readFile(join(repoDocs, "skills/uve-music/SKILL.md"), "utf8");
    // media_search reads each YouTube Music song's page for its channel and duration up to 10 results (the
    // default is 5) and warns when it falls back to titles only; the downloader never shows a "- Topic" suffix,
    // so the channel and length are checked again on what media_download returns.
    expect(toolByName("media_search").input.parse({ query: "song instrumental", platform: "youtube_music" }).limit).toBeLessThanOrEqual(10);
    expect(music).not.toContain("- Topic");
    expect(music).not.toMatch(/channel and duration are usually null/);
    expect(music).toMatch(/With a `limit` of 10 or less \(the default is 5\), each YouTube Music result is read for its channel and duration/);
    expect(music).toMatch(/result's `title`, `channel` and `durationSeconds`/);
    // Karaoke labels re-record songs and dress them up as instrumentals.
    for (const reject of ["every karaoke", "backing-track", "Originally Performed by"]) expect(music, reject).toContain(reject);
    expect(music).not.toMatch(/karaoke versions that keep/i);
    expect(music).toMatch(/"Instrumental Version"[^.]*prove nothing/);
    // Streaming-service links are DRM-protected: they name the song, they don't download.
    expect(music).toMatch(/Spotify, Apple Music or Shazam link only tells you the artist and title/);
    // listen takes a file path, so it can't hear the edited mix.
    expect(music).not.toMatch(/`listen` can confirm/);
    expect(music).toMatch(/`listen` reads a file, never the scene's mix/);
    // An instrumental is placed only after the local vocals check, on more than one window.
    expect(music).toMatch(/prove it has no vocals before placing it: `sound_analyze` `action: "match"` on two or three windows/);
    expect(music).toMatch(/query: "an instrumental without vocals"/);
    expect(music).toMatch(/Reject the file when any window's forced choice \(`p_vs_alts`\) favors singing/);
    // audio_finish takes effectIds, so neither skill hedges for a tool without them.
    expect(toolByName("audio_finish").input.parse({ sceneId: "index.tsx:main", action: "finish", effectIds: ["index.tsx:whoosh"] })).toMatchObject({ effectIds: ["index.tsx:whoosh"] });
    const sfx = await readFile(join(repoDocs, "skills/uve-sfx/SKILL.md"), "utf8");
    for (const content of [music, sfx]) expect(content).not.toMatch(/If the tool's input has no `effectIds`/i);
  });

  it("names only tools, actions and fields the schemas have", async () => {
    const properties = (name: string) => {
      if (!isToolName(name)) throw new Error(`${name} is not a tool`);
      return ((toolJsonSchemas(toolByName(name)).inputSchema as { properties?: Record<string, { enum?: string[] }> }).properties ?? {});
    };
    const outputs = (name: string) => Object.keys((toolJsonSchemas(toolByName(name as "skills")).outputSchema as { properties?: Record<string, unknown> }).properties ?? {});
    const soundFields = new Set(Object.values(SOUND_ANALYZE_FIELDS).flatMap((fields) => [...fields.required, ...fields.optional]));
    const platforms = properties("media_search").platform?.enum ?? [];
    // earshot's own result fields and bank categories, which the skills quote but no tool takes as input.
    const earshot = ["rms_dbfs", "p_real", "p_vs_alts", "offset_ms", "pitch_off", "ui_pop", "whoosh_fast", "pro_impact", "cut_hit", "reverse_swell"];
    const ids = ["editor", "watch", "uve-music", "uve-sfx", "uve-final-review", "uve-audio-finishing", "earshot-listening", "earshot-real-sound"];
    for (const id of ids) {
      const content = await readFile(join(repoDocs, EDITING_SKILLS.find((skill) => skill.id === id)!.path), "utf8");
      const named = [...content.matchAll(/`([a-z][a-z0-9]*_[a-z0-9_]+)`/g)].map(([, name]) => name!);
      for (const name of named) expect(isToolName(name) || soundFields.has(name) || platforms.includes(name) || earshot.includes(name), `${id}: ${name}`).toBe(true);
      // Every `action: "x"` belongs to one of the tools the same guide names.
      const actions = new Set(named.filter(isToolName).flatMap((name) => properties(name).action?.enum ?? []));
      for (const [, action] of content.matchAll(/`action: "([a-z]+)"`/g)) expect(actions.has(action!), `${id}: action ${action}`).toBe(true);
    }
    // The fields the sound workflows pass, on the actions they pass them to.
    for (const [action, field] of [["match", "alts"], ["match", "start"], ["describe", "end"], ["rank", "paths"], ["find", "kind"], ["timeline", "cues"], ["critique", "fast"], ["measure", "music"], ["measure", "light"]] as const) {
      const fields = SOUND_ANALYZE_FIELDS[action];
      expect([...fields.required, ...fields.optional], `${action}.${field}`).toContain(field);
    }
    expect(Object.keys(properties("sound_effects"))).toEqual(expect.arrayContaining(["action", "category", "kind", "id", "dur", "apex", "pitch", "seed", "path"]));
    expect(outputs("sound_effects")).toEqual(expect.arrayContaining(["src", "onsetSeconds", "peakSeconds", "endSeconds", "audit"]));
    expect(Object.keys(properties("audio_finish"))).toEqual(expect.arrayContaining(["sceneId", "musicIds", "effectIds", "duckingDb"]));
    expect(outputs("media_download")).toEqual(expect.arrayContaining(["src", "title", "channel", "durationSeconds"]));
    // Reviews export temporary drafts; the export tool itself allows that without a request.
    expect(toolByName("export").description).toMatch(/A review draft needs no request: export it to a temporary folder/);
    expect(toolByName("export").description).not.toMatch(/Only export when asked to/);
  });

  it("accepts the id or the path the instructions list, and opens only the catalogued file", async () => {
    const aliases: Record<string, string[]> = {
      editor: ["skills/editor.md", "editor.md", "editor", "./skills/editor.md", " Skills/Editor.MD ", "skills\\editor.md", join(repoDocs, "skills", "editor.md"), `${repoDocs}/skills/editor.md`],
      watch: ["skills/watch.md", "watch.md", "WATCH"],
      "uve-story-selection": ["skills/uve-story-selection/SKILL.md", "uve-story-selection/SKILL.md", "uve-story-selection.md", "uve-story-selection/skill.md"],
      "uve-web-media": ["skills/uve-web-media/SKILL.md", "uve-web-media", "./uve-web-media/SKILL.md"],
      "uve-cloud-speech": ["skills/imports/uve-cloud-speech/SKILL.md", "imports/uve-cloud-speech/SKILL.md", "uve-cloud-speech/SKILL.md"],
    };
    for (const [id, names] of Object.entries(aliases)) {
      const expected = await readFile(join(repoDocs, EDITING_SKILLS.find((skill) => skill.id === id)!.path), "utf8");
      for (const name of names) {
        const read = await readEditingSkills(repoDocs, { action: "read", id: name });
        expect(read.selected?.id, name).toBe(id);
        expect(read.selected?.content).toBe(expected);
      }
    }
  });

  it("does not imply imported cloud dependencies are installed", async () => {
    const listed = await readEditingSkills(repoDocs, { action: "list" });
    for (const id of ["uve-cloud-transcribe", "uve-cloud-speech"]) {
      expect(listed.skills.find((skill) => skill.id === id)).toMatchObject({ category: "optional", requires: expect.arrayContaining(["OPENAI_API_KEY", "OpenAI Python SDK"]) });
    }
  });

  it("lists the earshot imports as local add-on guides that need the audio add-on and Apple silicon", async () => {
    const listed = await readEditingSkills(repoDocs, { action: "list" });
    // `optional` is the cloud imports' category; the add-on's guides have their own.
    expect(listed.skills.filter((skill) => skill.category === "optional").map((skill) => skill.id).sort()).toEqual(["uve-cloud-speech", "uve-cloud-transcribe"]);
    expect(toolByName("skills").description).toMatch(/an `addon` skill is local/);
    for (const id of ["earshot-listening", "earshot-real-sound"]) {
      const skill = listed.skills.find((entry) => entry.id === id);
      expect(skill, id).toMatchObject({ path: `skills/imports/${id}/SKILL.md`, category: "addon", available: true });
      expect(skill!.requires.join(" "), id).toMatch(/audio intelligence add-on.*installs by itself/i);
      expect(skill!.requires, id).toContain("Mac with Apple silicon");
      // No key, SDK or paid service: the add-on is local, so the listing must not read like a cloud import.
      expect(skill!.requires.join(" "), id).not.toMatch(/API_KEY|SDK|API service/);
    }
    const read = await readEditingSkills(repoDocs, { action: "read", id: "skills/imports/earshot-listening/SKILL.md" });
    expect(read.selected?.id).toBe("earshot-listening");
  });

  it("routes agents from the instructions to the sound tools and the listening guide", async () => {
    const text = await readFile(join(repoDocs, "INSTRUCTIONS.md"), "utf8");
    for (const tool of ["sound_analyze", "sound_effects", "export", "listen"]) expect(text, tool).toContain(`\`${tool}\``);
    expect(text).toContain("`skills/imports/earshot-listening/SKILL.md`");
    expect(text).toMatch(/draft `export` to a temporary folder, which needs no request; export a delivery file only when asked/);
    expect(text).not.toMatch(/semantic audio analysis need/);
  });

  it("reports missing guides and rejects arbitrary file identifiers", async () => {
    expect((await readEditingSkills(null, { action: "list" })).skills.every((skill) => !skill.available)).toBe(true);
    await expect(readEditingSkills(null, { action: "read", id: "uve-story-selection" })).rejects.toMatchObject({ code: "not-found" });
    for (const id of [
      "../../secrets", "skills/../../x", "skills/../INSTRUCTIONS.md", "skills/editor.md/../../INSTRUCTIONS.md", "skills/uve-web-media/../editor.md",
      "/etc/passwd", "INSTRUCTIONS.md", "reference/tools/skills.md", "skills/imports/provenance.json", join(repoDocs, "INSTRUCTIONS.md"), `${repoDocs}/../README.md`,
      "skills", "skills/", "uve-web-media/", "skills/uve-web-media", "editor.md.bak", "uve-", "",
    ]) {
      await expect(readEditingSkills(repoDocs, { action: "read", id }), id).rejects.toMatchObject({ code: "invalid-input" });
    }
    await expect(readEditingSkills(repoDocs, { action: "read", id: "skills/missing.md" })).rejects.toThrow(/editor, watch, uve-story-selection.*uve-web-media/);
    await expect(readEditingSkills(repoDocs, { action: "read" })).rejects.toMatchObject({ code: "invalid-input" });
  });

  it("rejects a guide symlink that escapes the bundled docs", async () => {
    const root = await mkdtemp(join(tmpdir(), "uve-skills-")); dirs.push(root);
    const docs = join(root, "docs");
    await mkdir(join(docs, "skills/uve-story-selection"), { recursive: true });
    const outside = join(root, "private.txt"); await writeFile(outside, "not a skill");
    await symlink(outside, join(docs, "skills/uve-story-selection/SKILL.md"));
    await expect(readEditingSkills(docs, { action: "read", id: "uve-story-selection" })).rejects.toMatchObject({ code: "invalid-input" });
  });

  it("requires an explicit revision and notes to change preferences through MCP", async () => {
    const root = await mkdtemp(join(tmpdir(), "uve-style-tool-")); dirs.push(root);
    const ctx = { editingStyle: new EditingStyleStore(join(root, "style.json")) } as MainContext;
    await expect(editingStyle({ action: "set", notes: "preserve reactions" }, ctx)).rejects.toMatchObject({ code: "invalid-input" });
    const old = await editingStyle({ action: "get" }, ctx);
    const next = await editingStyle({ action: "set", notes: "preserve reactions", expectedRevision: old.revision }, ctx);
    expect(await editingStyle({ action: "get" }, ctx)).toEqual(next);
    await expect(editingStyle({ action: "set", notes: "stale", expectedRevision: old.revision }, ctx)).rejects.toMatchObject({ code: "busy" });
  });
});
