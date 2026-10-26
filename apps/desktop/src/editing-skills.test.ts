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
    expect(listed.skills).toHaveLength(12);
    expect(listed.skills.every((skill) => skill.available)).toBe(true);
    for (const skill of EDITING_SKILLS) {
      const read = await readEditingSkills(repoDocs, { action: "read", id: skill.id });
      expect(read.selected?.content).toBe(await readFile(join(repoDocs, skill.path), "utf8"));
      expect(toolByName("skills").output.safeParse(read).success).toBe(true);
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
    await expect(readEditingSkills(repoDocs, { action: "read", id: "../../secrets" })).rejects.toMatchObject({ code: "invalid-input" });
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
