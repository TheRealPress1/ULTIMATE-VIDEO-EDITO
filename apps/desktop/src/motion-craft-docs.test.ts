import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { isToolName, toolByName, toolJsonSchemas } from "@diffusionstudio/dapi";
import { readEditingSkills } from "./editing-skills";

const repoDocs = join(__dirname, "..", "..", "..", "docs");
const craft = "skills/uve-motion-graphics/references/craft.md";
const read = (path: string) => readFile(join(repoDocs, path), "utf8");

/** How GitHub names a heading's anchor: lower case, punctuation dropped, spaces to hyphens. */
const slug = (heading: string) => heading.toLowerCase().replace(/`/g, "").replace(/[^\p{L}\p{N}\s-]/gu, "").trim().replace(/\s+/g, "-");
const anchors = (markdown: string) => new Set([...markdown.matchAll(/^#{1,6}\s+(.+)$/gm)].map(([, heading]) => slug(heading!)));

/** Every relative Markdown link in a file: where it points and which anchor it asks for. */
const links = (markdown: string) => [...markdown.matchAll(/\]\((\.{1,2}\/[^)\s#]*|[a-z0-9][^):\s#]*\.md)(?:#([^)\s]+))?\)/gi)].map(([, target, anchor]) => ({ target: target!, anchor }));

describe("the motion craft page", () => {
  it("is a supporting file of the motion graphics skill, served exactly and under the file limit", async () => {
    const listed = await readEditingSkills(repoDocs, { action: "list" });
    expect(listed.skills.find((skill) => skill.id === "uve-motion-graphics")?.files).toEqual(["references/craft.md"]);
    const served = await readEditingSkills(repoDocs, { action: "read", id: "uve-motion-graphics", file: "references/craft.md" });
    expect(served.selected?.content).toBe(await read(craft));
    expect((await read(craft)).length).toBeLessThan(16 * 1024);
    // The skill itself sends agents there, and says how to read it.
    const skill = await read("skills/uve-motion-graphics/SKILL.md");
    expect(skill).toContain("[motion craft](references/craft.md)");
    expect(skill).toContain('`file: "references/craft.md"`');
  });

  it("only links to files and headings that exist, from the page and from the guides that point at it", async () => {
    for (const path of [craft, "skills/uve-motion-graphics/SKILL.md", "skills/uve-final-review/SKILL.md", "skills/uve-caption-finishing/SKILL.md", "skills/editor.md"]) {
      const text = await read(path);
      for (const { target, anchor } of links(text)) {
        const file = resolve(dirname(join(repoDocs, path)), target);
        expect(existsSync(file), `${path} -> ${target}`).toBe(true);
        if (anchor) expect(anchors(await readFile(file, "utf8")).has(anchor), `${path} -> ${target}#${anchor}`).toBe(true);
      }
    }
    // The three guides point at the sections that exist.
    for (const [path, anchor] of [["skills/uve-final-review/SKILL.md", "#review"], ["skills/uve-caption-finishing/SKILL.md", "#time-on-screen"]] as const) {
      expect(await read(path), path).toContain(`references/craft.md${anchor}`);
    }
    for (const heading of ["plan-before-building", "decisions-not-defaults", "time-on-screen", "choreography", "review", "matching-a-reference"]) {
      expect(anchors(await read(craft)).has(heading), heading).toBe(true);
    }
  });

  it("names only tools and fields that exist, and easings the guide defines", async () => {
    const text = await read(craft);
    for (const [, name] of text.matchAll(/`([a-z][a-z0-9]*_[a-z0-9_]+)`/g)) expect(isToolName(name!), name).toBe(true);
    const capture = (toolJsonSchemas(toolByName("capture")).inputSchema as { properties: Record<string, unknown> }).properties;
    for (const field of ["perSheet", "times"]) expect(capture, field).toHaveProperty(field);
    expect(text).toContain("`perSheet` 1");
    const easings = await read("guides/motion/easings.md");
    for (const [, name] of text.matchAll(/`((?:snappy|expo)(?:In|Out)|inOut|outIn)`/g)) expect(easings, name).toContain(`\`${name}\``);
    expect(text).toMatch(/snappyOut/);
  });

  it("agrees with the house style instead of competing with it", async () => {
    const text = await read(craft);
    const video = await read("brand/video.md");
    // The staggers and times it quotes as the house's are the house's.
    expect(video).toMatch(/Stagger support by 100 ms/);
    expect(video).toMatch(/Enter over 400 ms/);
    expect(video).toMatch(/Exit over 200 ms/);
    expect(text).toContain("house 100 ms");
    expect(text).toContain("(400 ms, `snappyOut`)");
    expect(text).toMatch(/house numbers win/);
    // The 9:16 safe area is the house's too, not a second set of numbers.
    expect(text).not.toMatch(/\b(?:x|y) \d+-\d+%/);
    expect(text).toContain("brand/design.md#916-text-safe-area");
  });

  it("uses Blackout's own wording and no other product's names or shell recipes", async () => {
    const text = (await read(craft)).toLowerCase();
    for (const foreign of ["fframes", "remotion", "compound", "rust", "cargo", "curl ", "pip install", "npx ", "yt-dlp"]) expect(text, foreign).not.toContain(foreign);
  });
});

describe("the provenance of the guidance", () => {
  it("records the fframes skill as a reference only, pinned to a commit, with nothing redistributed", async () => {
    const manifest = JSON.parse(await read("skills/imports/provenance.json")) as { imports: Array<Record<string, unknown>>; notes: string[] };
    const entry = manifest.imports.find((item) => item.id === "fframes-craft");
    expect(entry).toMatchObject({
      mode: "reference-only",
      repository: "https://github.com/dmtrKovalenko/fframes",
      license: "MIT",
      notice: expect.stringMatching(/^Copyright \(c\) .*Dmitriy Kovalenko$/),
      informs: craft,
      redistributedFiles: [],
    });
    expect(entry!.revision).toMatch(/^[0-9a-f]{40}$/);
    expect(String(entry!.sourceUrl)).toContain(String(entry!.revision));
    expect(existsSync(join(repoDocs, String(entry!.informs)))).toBe(true);
    expect(manifest.notes.join(" ")).toMatch(/fframes agent skill \(MIT\) informed uve-motion-graphics\/references\/craft\.md/);
    expect(manifest.notes.join(" ")).toMatch(/No fframes text, code or files are redistributed/);
    // Nothing of fframes sits in the imports folder.
    expect(existsSync(join(repoDocs, "skills/imports/fframes-craft"))).toBe(false);
    expect(existsSync(join(repoDocs, "skills/imports/fframes-video"))).toBe(false);
  });
});
