import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  canAutoApproveFile,
  canAutoApproveMcp,
} from "../src/host/local-permissions";

let root: string, project: string, outside: string, temporary: string;
beforeAll(async () => {
  const base = resolve("node_modules/.tmp");
  await mkdir(base, { recursive: true });
  root = await mkdtemp(join(base, "local-permissions-"));
  project = join(root, "project");
  outside = join(root, "outside");
  temporary = await mkdtemp(join(tmpdir(), "uve-permissions-"));
  await Promise.all([
    mkdir(join(project, "assets"), { recursive: true }),
    mkdir(outside),
  ]);
  await Promise.all([
    writeFile(join(project, "assets", "Captions 3.json"), "{}"),
    writeFile(join(project, "assets", "rheesa.mp4"), "local video fixture"),
    writeFile(join(outside, "private.json"), "{}"),
    writeFile(join(temporary, "capture.png"), "image fixture"),
    symlink(outside, join(project, "escape")),
    symlink(join(outside, "missing"), join(project, "dangling")),
    symlink(project, join(root, "alias")),
    symlink(outside, join(temporary, "escape")),
  ]);
});
afterAll(async () => {
  await Promise.all([
    rm(root, { recursive: true, force: true }),
    rm(temporary, { recursive: true, force: true }),
  ]);
});

const file = (
  path: unknown,
  kind: "read" | "write" = "write",
  grantRoot?: unknown,
) => canAutoApproveFile({ cwd: project, path, kind, grantRoot });
const mcp = (
  toolName: string,
  args: unknown = {},
  serverName: unknown = "cutroom",
) =>
  canAutoApproveMcp({
    cwd: project,
    serverName,
    expectedServerName: "cutroom",
    toolName,
    arguments: args,
  });

describe("automatic project file permissions", () => {
  it("allows existing caption reads/edits and new nested project outputs", async () => {
    expect(await file("assets/Captions 3.json", "read")).toBe(true);
    expect(await file("assets/Captions 3.json")).toBe(true);
    expect(await file("exports/draft/new.mp4")).toBe(true);
  });
  it("allows temporary backups and generated capture reads", async () => {
    expect(await file(join(temporary, "caption-backup.json"))).toBe(true);
    expect(await file(join(temporary, "capture.png"), "read")).toBe(true);
  });
  it("rejects lexical traversal, prefix collisions and external files", async () => {
    expect(await file("../outside/private.json")).toBe(false);
    expect(await file(`${project}-other/title.tsx`)).toBe(false);
    expect(await file(join(outside, "private.json"), "read")).toBe(false);
  });
  it("resolves project aliases but rejects symlinks escaping either allowed root", async () => {
    expect(
      await canAutoApproveFile({
        cwd: join(root, "alias"),
        path: "assets/Captions 3.json",
        kind: "write",
      }),
    ).toBe(true);
    expect(await file("escape/private.json")).toBe(false);
    expect(await file("escape/new/deep.json")).toBe(false);
    expect(await file(join(temporary, "escape/private.json"), "read")).toBe(
      false,
    );
    expect(await file("dangling/new.json")).toBe(false);
  });
  it("does not create permission/configuration changes automatically", async () => {
    for (const path of [
      ".git/config",
      ".claude/settings.json",
      ".codex/config.toml",
      ".ssh/config",
      ".aws/credentials",
      ".mcp.json",
    ])
      expect(await file(path)).toBe(false);
  });
  it("allows only grant roots contained in an allowed root and containing the operation", async () => {
    expect(await file("assets/Captions 3.json", "write", project)).toBe(true);
    expect(await file("assets/Captions 3.json", "write", root)).toBe(false);
    expect(await file("assets/Captions 3.json", "write", outside)).toBe(false);
    expect(
      await file("assets/Captions 3.json", "write", { path: project }),
    ).toBe(false);
  });
  it("rejects missing reads, URLs, controls and malformed paths", async () => {
    for (const path of [
      null,
      {},
      "",
      "file:///tmp/test",
      "https://example.test/a",
      "bad\u0000path",
    ])
      expect(await file(path)).toBe(false);
    expect(await file("missing.json", "read")).toBe(false);
  });
});

describe("automatic known local editor tools", () => {
  it("allows local speaker framing corrections without a separate prompt", async () => {
    expect(await mcp("reframe", {
      id: "interview", formats: ["vertical"], mode: "speakers",
      speakerFraming: { preference: "auto", overrides: [
        { start: 5, end: 12, preference: "left" },
        { start: 12, end: 18, preference: "hold" },
        { start: 18, end: 21, preference: "wide" },
      ] },
    })).toBe(true);
    expect(await mcp("reframe", { id: "interview", formats: ["vertical"], speakerFraming: { preference: "right" } }, "other")).toBe(false);
    expect(await mcp("reframe", { id: "interview", formats: ["vertical"], speakerFraming: { preference: "right" }, publish: true })).toBe(false);
  });
  it("allows ordinary editing and preview calls without separate prompts", async () => {
    for (const [name, args] of Object.entries({
      context: {},
      check: { id: "rheesa" },
      capture: { id: "rheesa", times: [9.4] },
      captions: { id: "rheesa" },
      reframe: { id: "rheesa", formats: ["vertical"] },
      transcript_edit_apply: {
        id: "rheesa",
        revision: "r",
        ranges: [{ start: 0, end: 2 }],
      },
      quality_review: { id: "rheesa" },
      visual_status: {},
    }))
      expect(await mcp(name, args)).toBe(true);
  });
  it("requires the exact attached MCP server and known tool", async () => {
    expect(await mcp("check", { id: "rheesa" }, "other")).toBe(false);
    for (const name of [
      "Bash",
      "execute",
      "listen",
      "report",
      "generate",
      "job",
      "instagram_publish",
      "instagram_connect",
      "__proto__",
    ])
      expect(await mcp(name, {})).toBe(false);
  });
  it("rejects unknown fields and malformed argument envelopes", async () => {
    expect(await mcp("context", { execute: "anything" })).toBe(false);
    expect(await mcp("capture", { id: "rheesa", upload: true })).toBe(false);
    for (const args of [null, [], 42, "{}"])
      expect(await mcp("context", args)).toBe(false);
  });
  it("permits local skill/style reads but asks before changing global preferences", async () => {
    expect(await mcp("skills", {})).toBe(true);
    expect(
      await mcp("skills", { action: "read", id: "uve-caption-finishing" }),
    ).toBe(true);
    expect(await mcp("skills", { action: "install", id: "arbitrary" })).toBe(
      false,
    );
    expect(await mcp("editing_style", { action: "get" })).toBe(true);
    expect(await mcp("editing_style", { action: "set" })).toBe(false);
  });
  it("opens only the active project, including its real filesystem alias", async () => {
    expect(await mcp("open", { dir: project })).toBe(true);
    expect(await mcp("open", { dir: join(root, "alias") })).toBe(true);
    expect(await mcp("open", { dir: outside })).toBe(false);
    expect(await mcp("open", { dir: join(project, "new") })).toBe(false);
  });
  it("confines capture/transcript/export output writes even for future nested paths", async () => {
    expect(
      await mcp("capture", { id: "rheesa", output: join(temporary, "frames") }),
    ).toBe(true);
    expect(
      await mcp("export", {
        id: "rheesa",
        path: join(project, "exports/new.mp4"),
      }),
    ).toBe(true);
    expect(
      await mcp("export", { id: "rheesa", path: join(outside, "new.mp4") }),
    ).toBe(false);
    expect(
      await mcp("capture", {
        id: "rheesa",
        output: join(project, "escape/frames"),
      }),
    ).toBe(false);
    expect(
      await mcp("transcribe", {
        path: "clip.mp4",
        output: join(outside, "transcript.json"),
      }),
    ).toBe(false);
  });
  it("accepts imported library source names, rejecting remote sources and traversal", async () => {
    expect(await mcp("probe", { path: "b-roll/clip.mp4" })).toBe(true);
    expect(
      await mcp("visual_index", {
        paths: ["b-roll/clip.mp4"],
        descriptions: true,
      }),
    ).toBe(true);
    expect(await mcp("probe", { path: "https://example.test/clip.mp4" })).toBe(
      false,
    );
    expect(await mcp("probe", { path: "../outside/private.json" })).toBe(false);
    expect(
      await mcp("visual_index", {
        paths: ["valid.mp4", "https://example.test/clip.mp4"],
      }),
    ).toBe(false);
    expect(await mcp("visual_index", { paths: "clip.mp4" })).toBe(false);
  });
  it("permits local audio processing and cached Instagram observations", async () => {
    expect(
      await mcp("audio_finish", {
        sceneId: "rheesa",
        action: "finish",
        denoise: true,
      }),
    ).toBe(true);
    expect(
      await mcp("audio_finish", { sceneId: "rheesa", action: "upload" }),
    ).toBe(false);
    expect(await mcp("instagram_posts", { limit: 10, sortBy: "views" })).toBe(
      true,
    );
    expect(await mcp("instagram_posts", { refresh: true })).toBe(false);
  });
  it("approves the screenshot listen argument shape for the current project without prompting", async () => {
    const prompt =
      "Diarize this clip. For each stretch of speech give start and end in seconds and who is speaking, distinguishing voices (e.g. female host 1, Rheesa the guest in a news segment, male/female guests from the second pair, etc.), with the words spoken. Note which voice sounds like the host and which like Rheesa Theesdale. Be precise to about 0.5s.";
    expect(
      await mcp("listen", {
        path: join(project, "assets/rheesa.mp4"),
        prompt,
        end: 30,
      }),
    ).toBe(true);
    expect(
      await mcp("listen", {
        path: "assets/rheesa.mp4",
        prompt,
        start: 10,
        end: 30,
      }),
    ).toBe(true);
    expect(
      await mcp("listen", {
        path: "https://example.test/rheesa.mp4",
        prompt,
        end: 30,
      }),
    ).toBe(false);
    expect(
      await mcp("listen", {
        path: join(outside, "private.json"),
        prompt,
        end: 30,
      }),
    ).toBe(false);
    expect(
      await mcp("listen", { path: "assets/rheesa.mp4", model: "paid-audio" }),
    ).toBe(false);
  });
  it("approves reference analysis and editing with their exact known options", async () => {
    expect(await mcp("reference_analyze", { path: "reference.mp4" })).toBe(
      true,
    );
    expect(
      await mcp("reference_apply", {
        id: "scene",
        path: "reference.mp4",
        fingerprint: "a".repeat(64),
        matchFormat: true,
        matchCaptions: true,
        name: "Reference version",
      }),
    ).toBe(true);
    expect(
      await mcp("reference_apply", {
        id: "scene",
        path: "https://example.test/reference.mp4",
        fingerprint: "a".repeat(64),
      }),
    ).toBe(false);
  });
  it("approves only the local SAM model and local jobs, never remote generation or publication", async () => {
    const args = {
      model: "sam-2.1",
      video: { path: "assets/rheesa.mp4" },
      time: 0,
      points: [{ x: 0.5, y: 0.5 }],
      output: "assets/subject.mask",
    };
    expect(await mcp("generate", args)).toBe(true);
    expect(await mcp("generate", { ...args, model: "paid-model" })).toBe(false);
    expect(
      await mcp("generate", {
        ...args,
        video: { path: "https://example.test/video.mp4" },
      }),
    ).toBe(false);
    expect(
      await mcp("generate", {
        ...args,
        video: { path: "assets/rheesa.mp4", upload: true },
      }),
    ).toBe(false);
    expect(
      await mcp("generate", { ...args, output: join(outside, "mask") }),
    ).toBe(false);
    expect(
      await mcp("generate", { ...args, webhook: "https://example.test" }),
    ).toBe(false);
    expect(
      await mcp("job", {
        id: "local-11111111-1111-4111-8111-111111111111",
        cancel: true,
      }),
    ).toBe(true);
    expect(
      await mcp("job", { id: "11111111-1111-4111-8111-111111111111" }),
    ).toBe(false);
    expect(await mcp("report", { title: "Publish diagnostics" })).toBe(false);
  });
});
