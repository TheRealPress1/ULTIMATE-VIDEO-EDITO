/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from "vitest";

import { DETAIL_MAX, IMAGES_MAX, IMAGE_MAX, chatInstructions, collectResult } from "../src/host/harness";

const png = (data = "iVBORw0KGgo=") => ({ type: "image", source: { type: "base64", media_type: "image/png", data } });

describe("collectResult", () => {
  it("joins text parts and keeps images that fit", () => {
    const result = collectResult([{ type: "text", text: "read it" }, png()]);
    expect(result).toEqual({ output: "read it", images: [{ mediaType: "image/png", data: "iVBORw0KGgo=" }] });
  });

  it("returns only images when there is no text", () => {
    expect(collectResult([png()])).toEqual({ images: [{ mediaType: "image/png", data: "iVBORw0KGgo=" }] });
  });

  it("leaves a marker for an image over the cap, and for other part kinds", () => {
    const result = collectResult([png("x".repeat(IMAGE_MAX + 1)), { type: "document", source: "not-an-image" }]);
    expect(result).toEqual({ output: "[image]\n[document]" });
  });

  it("keeps at most IMAGES_MAX images", () => {
    const parts = Array.from({ length: IMAGES_MAX + 2 }, () => png());
    const result = collectResult(parts);
    expect(result.images).toHaveLength(IMAGES_MAX);
    expect(result.output).toBe("[image]\n[image]");
  });

  it("truncates long text like any other output", () => {
    const result = collectResult([{ type: "text", text: "y".repeat(DETAIL_MAX + 10) }]);
    expect(result.output).toHaveLength(DETAIL_MAX + 1);
    expect(result.output?.endsWith("…")).toBe(true);
  });

  it("drops empty output", () => {
    expect(collectResult([])).toEqual({});
    expect(collectResult([{ type: "text", text: "  " }])).toEqual({});
  });
});

describe("chatInstructions", () => {
  it("describes each provider's own command sandbox", () => {
    const claude = chatInstructions("/projects/demo", undefined, "claude");
    expect(claude).toContain("sandboxed commands (including network downloads) run automatically");
    const codex = chatInstructions("/projects/demo", undefined, "codex");
    expect(codex).toContain("sandboxed commands have no network access");
    expect(codex).not.toContain("network downloads");
    // Codex's sandbox cannot protect these inside the project; the instructions must.
    expect(codex).toContain("Never delete files");
    expect(codex).toContain("no Delete File hunks in patches");
    expect(codex).toContain("Never create, change or delete anything in `.cutroom`, `.git`");
    expect(claude).not.toContain("Delete File hunks");
    // Only Claude's hooks refuse shell deletes and credential reads; Codex is told what its sandbox declines.
    expect(claude).toContain("refused automatically with a reason — deleting files or running system commands from the shell");
    expect(codex).not.toContain("refused automatically");
    expect(codex).not.toContain("reading credential stores");
    expect(codex).toContain("Writes outside the project and temporary folders, network access from commands and requests for extra permissions are declined automatically");
    for (const text of [claude, codex]) {
      expect(text).toContain("`/projects/demo`");
      expect(text).toContain("`web_media_search` and `web_media_download`");
    }
    expect(chatInstructions("/projects/demo", "Prefer captions.", "codex").endsWith("\n\nPrefer captions.")).toBe(true);
  });
});
