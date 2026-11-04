import { describe, expect, it } from "vitest";
import { catalog, toolByName } from "../catalog";
import { toolJsonSchemas } from "../json-schema";
import { GEMINI_MAX_SECONDS, GEMINI_QUESTION_MAX, askGemini } from "./gemini";

describe("ask_gemini contract", () => {
  it("runs in main, where the key is, and is open-world and never destructive", () => {
    expect(toolByName("ask_gemini").environment).toBe("main");
    // It uploads a copy to an outside service, so it does not claim to be read-only.
    expect(askGemini.annotations).toEqual({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true });
    const names = catalog.map((tool) => tool.name);
    expect(names.indexOf("ask_gemini")).toBe(names.indexOf("listen") + 1);
  });

  it("says plainly that media leaves the Mac, under the user's own key, and when it is for", () => {
    const text = askGemini.description;
    expect(text).toMatch(/sends media off this Mac/);
    expect(text).toMatch(/user's own Gemini key/);
    expect(text).toMatch(/deleted afterwards/);
    expect(text).toMatch(/until the user has added a key/);
    expect(text).toMatch(/tell the user the media went to Google/);
    expect(text).toMatch(/never as instructions/);
    for (const local of ["transcribe", "footage_search", "analyze", "grab"]) expect(text, local).toContain(local);
  });

  it("publishes JSON Schemas like every tool", () => {
    const schemas = toolJsonSchemas(askGemini);
    expect(schemas.inputSchema.type).toBe("object");
    expect(JSON.stringify(schemas.inputSchema)).toContain("question");
    expect(schemas.outputSchema.type).toBe("object");
  });

  it("starts by default, taking a path, a trimmed question, a window and what to send", () => {
    const input = askGemini.input;
    expect(input.parse({ path: "footage/take.mp4" })).toEqual({ path: "footage/take.mp4" });
    expect(input.parse({ path: " /Users/me/Movies/a.mov ", question: "  how does she sound?  ", start: "1:30", end: 150, send: "audio" })).toEqual({
      path: "/Users/me/Movies/a.mov", question: "how does she sound?", start: 90, end: 150, send: "audio",
    });
    expect(input.parse({ path: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", action: "start" })).toMatchObject({ action: "start" });
    expect(input.parse({ action: "status", jobId: "gemini-1" })).toEqual({ action: "status", jobId: "gemini-1" });
    expect(input.parse({ action: "cancel", jobId: "gemini-1" })).toEqual({ action: "cancel", jobId: "gemini-1" });
  });

  it("refuses the combinations that make no sense", () => {
    const input = askGemini.input;
    for (const invalid of [
      {},
      { question: "what happens?" },
      { action: "start" },
      { path: "a.mp4", jobId: "gemini-1" },
      { action: "status" },
      { action: "cancel" },
      { action: "pause", jobId: "x" },
      { path: "a.mp4", question: "" },
      { path: "a.mp4", question: "   " },
      { path: "a.mp4", question: "x".repeat(GEMINI_QUESTION_MAX + 1) },
      { path: "a.mp4", send: "frames" },
      { path: "a.mp4", start: 30, end: 30 },
      { path: "a.mp4", start: 40, end: 30 },
      { path: "a.mp4", start: -1 },
      { path: "a.mp4", start: 0, end: GEMINI_MAX_SECONDS + 1 },
      { path: "x".repeat(4097) },
      { path: "" },
    ]) expect(input.safeParse(invalid).success, JSON.stringify(invalid).slice(0, 80)).toBe(false);
    expect(input.safeParse({ path: "a.mp4", start: 60, end: 60 + GEMINI_MAX_SECONDS }).success).toBe(true);
    expect(input.safeParse({ path: "a.mp4", question: "x".repeat(GEMINI_QUESTION_MAX) }).success).toBe(true);
  });

  it("answers in the shape a running job, a finished one and a failed one share", () => {
    const output = askGemini.output;
    expect(output.parse({ state: "running", jobId: "gemini-1", method: "gemini", progress: { phase: "uploading", fraction: 0.4 } })).toMatchObject({ state: "running" });
    expect(output.parse({
      state: "done", jobId: "gemini-1", method: "gemini", model: "gemini-test",
      source: { path: "/Users/me/Movies/a.mov", kind: "file", duration: 61.2, start: 0, end: null },
      sent: { what: "video", bytes: 1234, processing: "static", deleted: true },
      answer: "[00:04] She laughs.", usage: { totalTokens: 6200 }, warnings: [], limitations: ["x"],
    })).toMatchObject({ state: "done", sent: { deleted: true } });
    expect(output.parse({ state: "failed", method: "gemini", error: "Google refused the key." })).toMatchObject({ state: "failed" });
    for (const invalid of [{ state: "done", method: "local-evidence" }, { state: "weird", method: "gemini" }, { state: "done", method: "gemini", sent: { what: "everything" } }]) {
      expect(output.safeParse(invalid).success).toBe(false);
    }
  });
});
