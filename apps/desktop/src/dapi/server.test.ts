/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

vi.mock("electron", () => ({ ipcMain: { on: vi.fn() } }));
// Main's own tools are not what is under test here, only that they go through the same door.
vi.mock("./handlers", async () => {
  const { tools } = await import("@diffusionstudio/dapi");
  const main = tools.filter((tool) => tool.environment === "main");
  return { mainHandlers: Object.fromEntries(main.map((tool) => [tool.name, vi.fn(async () => ({ entries: [] }))])) };
});

import { mainHandlers } from "./handlers";
import { EXPORTS_OUTSIDE, pinProject, PROJECT_MOVED, protectedMessage, REPLACE_OUTSIDE, WRITABLE_PLACES } from "./output-policy";
import { RendererCalls } from "./renderer-calls";
import { DapiServer } from "./server";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TrackProps } from "@diffusionstudio/api-contract";
import type { DapiServerDeps } from "./server";

// The project sits in the temp folder, where tools may write; what they may
// not is somewhere no test can create anything: a folder at the disk's root
// that does not exist, or a system file that does.
const project = mkdtempSync(join(tmpdir(), "dapi-server-"));
afterAll(() => rmSync(project, { recursive: true, force: true }));
const nowhere = join("/", `cutroom-dapi-server-${randomUUID()}`);
const systemFile = "/etc/hosts";

let lastProject: string | null = project;
let projectRoot: string | null = pinProject(project);
const window = {
  visible: () => false,
  show: vi.fn(async () => {}),
  hide: vi.fn(),
  acquire: vi.fn(() => {
    throw new Error("Tests have no window");
  }),
  hold: vi.fn(() => () => {}),
  lastProject: vi.fn(() => lastProject),
  projectRoot: vi.fn(() => projectRoot),
} as unknown as DapiServerDeps["window"];
const onToolCall = vi.fn<(props: TrackProps) => void>();
const rendererCall = vi.spyOn(RendererCalls.prototype, "call");

let client: Client;

beforeEach(async () => {
  lastProject = project;
  projectRoot = pinProject(project);
  vi.clearAllMocks();
  rendererCall.mockImplementation(async () => {
    throw new Error("Unexpected renderer call");
  });
  const server = new DapiServer({ version: "0.0.0", logs: () => [], window, docsDir: null, onToolCall });
  const session = (server as unknown as { createSession(): McpServer }).createSession();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await session.connect(serverTransport);
  client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(clientTransport);
});

afterEach(() => client.close());

const text = (result: Awaited<ReturnType<Client["callTool"]>>) => (result.content as Array<{ text: string }>)[0]!.text;

describe("DapiServer dispatch", () => {
  it("refuses a renderer tool's output before the renderer, or a window, sees the call", async () => {
    const result = await client.callTool({ name: "capture", arguments: { id: "intro", output: join(nowhere, "frames") } });
    expect(result.isError).toBe(true);
    expect(text(result)).toBe(WRITABLE_PLACES);
    expect(rendererCall).not.toHaveBeenCalled();
    expect(window.acquire).not.toHaveBeenCalled();
    expect(onToolCall).toHaveBeenCalledWith(expect.objectContaining({ tool: "capture", ok: false, error: "invalid-input" }));
  });

  it("refuses an export over an existing file outside the project", async () => {
    const result = await client.callTool({ name: "export", arguments: { id: "intro", path: systemFile } });
    expect(result.isError).toBe(true);
    expect(text(result)).toBe(REPLACE_OUTSIDE);
    expect(rendererCall).not.toHaveBeenCalled();
    expect(onToolCall).toHaveBeenCalledWith(expect.objectContaining({ tool: "export", ok: false, error: "invalid-input" }));
  });

  it("judges paths against the project the editor has open", async () => {
    const masks = { name: "generate", arguments: { model: "sam-2.1", output: "../.cutroom/mask.png" } };
    const refused = await client.callTool(masks);
    expect(text(refused)).toBe(protectedMessage(".cutroom"));
    expect(window.lastProject).toHaveBeenCalled();
    expect(rendererCall).not.toHaveBeenCalled();

    // No project open: a library path is the renderer's to refuse.
    lastProject = null;
    rendererCall.mockRejectedValueOnce(new Error("No project open"));
    await client.callTool(masks);
    expect(rendererCall).toHaveBeenCalledTimes(1);
  });

  it("runs an allowed renderer tool and presents its files", async () => {
    rendererCall.mockResolvedValueOnce([{ timecode: "0f", png: new Uint8Array([137, 80, 78, 71]) }]);
    const frames = join(project, "frames");
    const result = await client.callTool({ name: "capture", arguments: { id: "intro", output: frames } });
    expect(result.isError).toBeFalsy();
    expect(rendererCall).toHaveBeenCalledWith("capture", { id: "intro", output: frames }, expect.anything());
    expect(existsSync(join(frames, "0f.png"))).toBe(true);
    expect(onToolCall).toHaveBeenCalledWith(expect.objectContaining({ tool: "capture", ok: true, error: undefined }));
  });

  it("checks again once the tool has run, so a link planted meanwhile is never written through", async () => {
    const transcript = join(project, "planted.json");
    rendererCall.mockImplementationOnce(async () => {
      symlinkSync(join(nowhere, "transcript.json"), transcript);
      return { segments: [] };
    });
    const result = await client.callTool({ name: "transcribe", arguments: { path: "clip.mp4", output: transcript } });
    expect(result.isError).toBe(true);
    expect(text(result)).toBe(WRITABLE_PLACES);
    expect(onToolCall).toHaveBeenCalledWith(expect.objectContaining({ tool: "transcribe", ok: false, error: "invalid-input" }));
  });

  it("sends main tools through the same check, then to their handler", async () => {
    const result = await client.callTool({ name: "logs", arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(mainHandlers.logs).toHaveBeenCalledTimes(1);
    expect(rendererCall).not.toHaveBeenCalled();
    expect(onToolCall).toHaveBeenCalledWith(expect.objectContaining({ tool: "logs", ok: true }));
  });

  it("writes frames over links planted at their names, never through them", async () => {
    const outside = mkdtempSync(join(tmpdir(), "dapi-server-outside-"));
    try {
      const thesis = join(outside, "thesis.docx");
      writeFileSync(thesis, "PRECIOUS");
      const frames = join(project, "planted-frames");
      mkdirSync(frames);
      symlinkSync(thesis, join(frames, "0f.png"));
      symlinkSync(join(outside, "created.png"), join(frames, "1s.png"));
      rendererCall.mockResolvedValueOnce([{ timecode: "0f", png: new Uint8Array([1]) }, { timecode: "1s", png: new Uint8Array([2]) }]);
      const result = await client.callTool({ name: "capture", arguments: { id: "intro", separate: true, output: frames } });
      expect(result.isError).toBeFalsy();
      expect(readFileSync(thesis, "utf8")).toBe("PRECIOUS");
      expect(existsSync(join(outside, "created.png"))).toBe(false);
      expect(lstatSync(join(frames, "0f.png")).isFile()).toBe(true);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("stops counting the project once its folder is swapped for a link", async () => {
    const show = join(project, "show");
    mkdirSync(show);
    lastProject = show;
    projectRoot = pinProject(show);
    renameSync(show, join(project, "show-away"));
    symlinkSync("/etc", show);

    const transcript = await client.callTool({ name: "transcribe", arguments: { path: "clip.mp4", output: join(show, "hosts") } });
    expect(text(transcript)).toBe(PROJECT_MOVED);
    const exported = await client.callTool({ name: "export", arguments: { id: "intro" } });
    expect(text(exported)).toBe(PROJECT_MOVED);
    expect(rendererCall).not.toHaveBeenCalled();
  });

  it("refuses an export without a path when the project's exports folder leads outside it", async () => {
    const show = join(project, "linked-exports");
    mkdirSync(show);
    symlinkSync(tmpdir(), join(show, "exports"));
    lastProject = show;
    projectRoot = pinProject(show);
    const result = await client.callTool({ name: "export", arguments: { id: "intro" } });
    expect(text(result)).toBe(EXPORTS_OUTSIDE);
    expect(rendererCall).not.toHaveBeenCalled();
  });

  it("refuses to open a folder whose files would then be in reach", async () => {
    const result = await client.callTool({ name: "open", arguments: { dir: "/" } });
    expect(result.isError).toBe(true);
    expect(rendererCall).not.toHaveBeenCalled();
  });
});
