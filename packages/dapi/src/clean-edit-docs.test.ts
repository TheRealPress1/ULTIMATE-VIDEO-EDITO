/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { isToolName, toolByName } from "./catalog";
import { EDITING_SKILLS } from "./editing-skills";

const docs = join(__dirname, "..", "..", "..", "docs");
const read = (path: string) => readFileSync(join(docs, path), "utf8");
const pages = {
  skill: "skills/uve-clean-edit/SKILL.md",
  pacing: "skills/uve-dialogue-pacing/SKILL.md",
  talkingHead: "guides/walkthroughs/talking-head.md",
  podcast: "guides/walkthroughs/podcast-clip.md",
};
// Tools from other parts of this release that a page may name before they are registered.
const PENDING = new Set(["script_read_compare"]);
// Single words in backticks that are values, presets or fields rather than tools. A one-word tool
// (`check`, `listen`, `captions`…) must be registered; anything else has to be listed here.
const NOT_TOOLS = new Set(["tight", "natural", "reflective", "classic", "whisper", "stark", "cascade", "start", "end", "t", "r", "similarity", "silence", "retake", "fillers"]);

describe("clean-edit docs", () => {
  it("ship the skill with frontmatter matching its catalog entry", () => {
    const text = read(pages.skill);
    expect(text.startsWith("---\nname: uve-clean-edit\n")).toBe(true);
    expect(text).toMatch(/\nmetadata:\n {2}version: "\d+\.\d+\.\d+"\n---\n/);
    const entry = EDITING_SKILLS.find((skill) => skill.id === "uve-clean-edit");
    if (entry) expect(entry.path).toBe(pages.skill);
  });

  it("name the same pace profiles in the skill, the pacing guide and the talking-head walkthrough", () => {
    for (const path of [pages.skill, pages.pacing, pages.talkingHead]) {
      const text = read(path);
      for (const profile of ["tight", "natural", "reflective"]) expect(text, `${path}: ${profile}`).toContain(`\`${profile}\``);
    }
    // Conservative handles belong to the natural and reflective profiles only.
    expect(read(pages.pacing)).toMatch(/natural and reflective profiles/);
  });

  it("only quote tools that exist", () => {
    for (const path of Object.values(pages)) {
      const text = read(path);
      for (const [, name] of text.matchAll(/`([a-z][a-z0-9]*_[a-z0-9_]+)`/g)) {
        expect(isToolName(name!) || PENDING.has(name!), `${path}: ${name}`).toBe(true);
      }
      for (const [, name] of text.matchAll(/`([a-z][a-z0-9]*)`/g)) {
        expect(isToolName(name!) || NOT_TOOLS.has(name!), `${path}: \`${name}\` is not a registered tool; list it in NOT_TOOLS if it is a value`).toBe(true);
      }
    }
    // The one-word tools these pages lean on are all still registered.
    for (const name of ["listen", "probe", "capture", "captions", "check", "waveform", "grab", "reframe", "transcribe"]) expect(isToolName(name), name).toBe(true);
  });

  it("link only to pages and headings that exist", () => {
    // GitHub's heading anchors: lower case, punctuation dropped, spaces to hyphens.
    const anchors = (text: string) => new Set([...text.matchAll(/^#{1,6}\s+(.+)$/gm)].map(([, title]) => title!.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, "").replace(/\s/g, "-")));
    const references = ["reference/tools/transcript-edit.md", "reference/tools/check.md", "reference/tools/waveform.md", "reference/tools/quality-review.md"];
    for (const page of [...Object.values(pages), ...references]) {
      const path = join(docs, page);
      for (const [, target] of read(page).matchAll(/\]\(([^)\s]+)\)/g)) {
        if (/^[a-z]+:/i.test(target!)) continue;
        const [file, anchor] = target!.split("#");
        const destination = file ? join(dirname(path), file) : path;
        expect(existsSync(destination), `${page}: ${target}`).toBe(true);
        if (anchor && destination.endsWith(".md")) expect(anchors(readFileSync(destination, "utf8")).has(anchor), `${page}: ${target}`).toBe(true);
      }
    }
  });

  it("pass tool inputs in their JSON examples that the schemas accept", () => {
    const inputs: Array<[path: string, tool: "transcript_edit_inspect" | "transcript_edit_apply" | "quality_review" | "captions"]> = [];
    for (const path of [pages.talkingHead, pages.podcast]) {
      for (const [, body] of read(path).matchAll(/```json\n([\s\S]*?)```/g)) {
        const value = JSON.parse(body!.replace("<revision from the inspection above>", "a".repeat(64))) as Record<string, unknown>;
        const tool = "ranges" in value ? "transcript_edit_apply" : "audio" in value ? "quality_review" : "pauses" in value ? "transcript_edit_inspect" : "captions";
        inputs.push([path, tool]);
        expect(toolByName(tool).input.safeParse(value).success, `${path}: ${body}`).toBe(true);
      }
    }
    expect(inputs.map(([, tool]) => tool)).toEqual(expect.arrayContaining(["transcript_edit_inspect", "transcript_edit_apply", "quality_review"]));
  });
});
