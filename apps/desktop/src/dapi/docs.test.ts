/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { INSTRUCTIONS_LIMIT, instructions } from "./docs";

// The docs in miniature, laid out like the repo's `docs/`.
const root = mkdtempSync(join(tmpdir(), "dapi-docs-"));
const docsDir = join(root, "docs");
const repoDocs = join(__dirname, "..", "..", "..", "..", "docs");

beforeAll(() => {
  mkdirSync(join(docsDir, "skills"), { recursive: true });
  writeFileSync(join(docsDir, "INSTRUCTIONS.md"), "Cutroom is running.\n\nRead `skills/editor.md`.\n");
  writeFileSync(join(docsDir, "skills", "editor.md"), "# Editing\n\nHow to edit.\n");
  writeFileSync(join(docsDir, "skills", "watch.md"), "# Watching\n\nHow to watch.\n");
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("instructions", () => {
  it("is where the docs sit on disk, followed by INSTRUCTIONS.md verbatim", () => {
    const text = instructions(docsDir);
    expect(text.startsWith(`Cutroom's docs are the files at \`${docsDir}\``)).toBe(true);
    expect(text.endsWith("\n\nCutroom is running.\n\nRead `skills/editor.md`.")).toBe(true);
  });

  it("falls back to a one-liner when nothing is staged", () => {
    const text = instructions(null);
    expect(text).toContain("The tools are the whole API");
    expect(text).not.toContain("skills/editor.md");
  });

  it("builds from the repo's own docs without broken instructions", () => {
    if (!existsSync(repoDocs)) return;
    const text = instructions(repoDocs);
    expect(text).toContain(repoDocs);
    expect(text).not.toContain("dapi://");
    expect(text).not.toContain("\\`");
  });

  // Claude Code keeps only the first 4,096 characters of a server's
  // instructions; everything past that, the docs path included, never arrives.
  it("fits the instructions cap with the docs path first, wherever the app is installed", () => {
    if (!existsSync(repoDocs)) return;
    const body = readFileSync(join(repoDocs, "INSTRUCTIONS.md"), "utf8").trim();
    // The same page staged under a long install path (a copy in a user's Applications folder).
    const installed = join(root, `Users/${"someone".repeat(8)}/Applications/Cutroom Beta.app/Contents/Resources/docs`);
    mkdirSync(installed, { recursive: true });
    writeFileSync(join(installed, "INSTRUCTIONS.md"), body);
    for (const dir of [repoDocs, installed]) {
      const text = instructions(dir);
      expect(text.length, dir).toBeLessThanOrEqual(INSTRUCTIONS_LIMIT);
      expect(text.indexOf(dir)).toBeLessThan(200);
      expect(text.indexOf(dir)).toBeLessThan(text.indexOf("skills/editor.md"));
      expect(text.endsWith(body)).toBe(true);
    }
    expect(INSTRUCTIONS_LIMIT).toBeLessThan(4096);
  });
});

describe("the repo's INSTRUCTIONS.md", () => {
  it("names the skills, and every page it names exists", () => {
    if (!existsSync(repoDocs)) return;
    const text = readFileSync(join(repoDocs, "INSTRUCTIONS.md"), "utf8");
    const pages = [...text.matchAll(/`((?:skills|reference|guides|examples|brand)\/[^`]*?\.(?:md|tsx?))`/g)].map((m) => m[1]);
    expect(pages).toContain("skills/editor.md");
    expect(pages).toContain("skills/watch.md");
    expect(pages).toContain("skills/uve-music/SKILL.md");
    expect(pages).toContain("skills/uve-sfx/SKILL.md");
    for (const page of pages) expect(existsSync(join(repoDocs, ...page.split("/"))), page).toBe(true);
  });

  it("routes platform media, licensed stock and the curated catalog to their own tools", () => {
    if (!existsSync(repoDocs)) return;
    const text = readFileSync(join(repoDocs, "INSTRUCTIONS.md"), "utf8");
    for (const tool of ["media_search", "media_download", "web_media_search", "web_media_download", "audio_catalog", "skills", "context", "editing_style"]) {
      expect(text, tool).toContain(`\`${tool}\``);
    }
    expect(text).toMatch(/never fetch media with yt-dlp/);
    expect(text).not.toMatch(/ask the user to export|only stream through their players/i);
  });
});

/** Every Markdown page under `dir`, as paths relative to it. */
function markdownPages(dir: string, prefix = ""): string[] {
  return readdirSync(join(dir, prefix), { withFileTypes: true }).flatMap((entry) => {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) return markdownPages(dir, path);
    return entry.isFile() && entry.name.endsWith(".md") ? [path] : [];
  });
}

describe("the repo's docs", () => {
  // Any page an agent reads can undo the instructions' routing, so none may
  // tell it to download media itself or that platforms can't be downloaded.
  it("never send media downloads to the shell or call platforms stream-only", () => {
    if (!existsSync(repoDocs)) return;
    const pages = markdownPages(repoDocs);
    expect(pages).toContain("reference/jsx/media.md");
    for (const page of pages) {
      const text = readFileSync(join(repoDocs, ...page.split("/")), "utf8");
      expect(text, page).not.toMatch(/\b(?:yt-dlp|youtube-dl)\b[^\n]{0,160}?(?:`-o`|\s-o\s|--output\b)/i);
      expect(text, page).not.toMatch(/\bpoint\s+\[?(?:yt-dlp|youtube-dl|curl|wget)\b/i);
      expect(text, page).not.toMatch(/\b(?:curl|wget)\b[^\n`]{0,80}\bassets\//i);
      expect(text, page).not.toMatch(/only stream through their players/i);
    }
  });

  it("send a download into the library through the app's tools", () => {
    if (!existsSync(repoDocs)) return;
    const media = readFileSync(join(repoDocs, "reference", "jsx", "media.md"), "utf8");
    expect(media).toContain("[`media_download`](../tools/media.md)");
    expect(media).toContain("[`web_media_download`](../tools/web-media.md)");
  });
});
