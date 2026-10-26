import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { EDITING_SKILLS, toolByName } from "@diffusionstudio/dapi";
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
    expect(listed.skills).toHaveLength(15);
    expect(listed.version).toBe("1.4.0");
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
