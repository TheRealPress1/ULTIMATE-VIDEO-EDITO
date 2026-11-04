import { beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { DapiError, toolByName } from "@diffusionstudio/dapi";
import { mainHandlers } from ".";
import { askGemini } from "./gemini";
import { serveCatalog } from "../tools-session";

import type { MainContext } from "../handler";

const service = vi.hoisted(() => ({ ask: vi.fn() }));
vi.mock("../../gemini", () => ({ gemini: () => service }));

const ctx: MainContext = {
  signal: new AbortController().signal,
  logs: () => [],
  version: "test",
  project: () => "/Users/me/Movies/Reel",
  window: { visible: () => false, show: async () => {}, hide: () => {} },
};

const done = {
  state: "done" as const, jobId: "gemini-1-x", method: "gemini" as const, model: "gemini-test",
  source: { path: "/Users/me/Movies/Reel/assets/footage/take.mp4", kind: "file" as const, duration: 40, start: 0, end: null },
  sent: { what: "video" as const, bytes: 7000, processing: "static" as const, deleted: true },
  answer: "[00:04] She laughs.", usage: { totalTokens: 1234 }, limitations: ["Gemini's reading is model output, not proof."],
};

beforeEach(() => {
  vi.clearAllMocks();
  service.ask.mockResolvedValue(done);
});

describe("ask_gemini handler", () => {
  it("is the main handler for the tool, and hands the service the parsed call, the open project and the caller's signal", async () => {
    expect(mainHandlers.ask_gemini).toBe(askGemini);
    const args = toolByName("ask_gemini").input.parse({ path: "footage/take.mp4", question: "How does it feel?", send: "audio", start: "0:10", end: "0:40" });
    await askGemini(args, ctx);
    expect(service.ask).toHaveBeenCalledWith(args, { project: "/Users/me/Movies/Reel", signal: ctx.signal });
    expect(args).toMatchObject({ send: "audio", start: 10, end: 40 });
  });

  it("works at the dashboard, with no project open", async () => {
    await askGemini(toolByName("ask_gemini").input.parse({ path: "/Users/me/Movies/take.mp4" }), { ...ctx, project: () => null });
    expect(service.ask).toHaveBeenCalledWith(expect.anything(), { project: null, signal: ctx.signal });
  });

  it("answers only what the public schema names", async () => {
    service.ask.mockResolvedValue({ ...done, key: ["AIza", "SyShouldNeverAppearInAnAgentResult"].join(""), internal: { token: "x" } });
    const answer = await askGemini(toolByName("ask_gemini").input.parse({ path: "a.mp4" }), ctx);
    expect(answer).toEqual(done);
    expect(JSON.stringify(answer)).not.toContain("AIza");
  });

  it("answers over MCP as a tool that can reach outside, and reports a refusal as an error the agent can act on", async () => {
    const session = new McpServer({ name: "gemini-test", version: "0.0.0" });
    serveCatalog(session, async (tool, args) => {
      if (tool.name === "ask_gemini") return askGemini(toolByName("ask_gemini").input.parse(args), ctx);
      throw new Error("Unexpected tool");
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await session.connect(serverTransport);
    const client = new Client({ name: "gemini-test-client", version: "0.0.0" });
    await client.connect(clientTransport);
    try {
      const listed = (await client.listTools()).tools.find((tool) => tool.name === "ask_gemini")!;
      expect(listed.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, openWorldHint: true });
      expect(listed.description).toMatch(/sends media off this Mac/);
      expect(Object.keys(listed.inputSchema.properties!)).toEqual(["action", "jobId", "path", "question", "start", "end", "send"]);

      const answer = await client.callTool({ name: "ask_gemini", arguments: { path: "footage/take.mp4", question: "How does it feel?" } });
      expect(answer.isError).not.toBe(true);
      expect(answer.structuredContent).toEqual(done);

      service.ask.mockRejectedValueOnce(new DapiError("unsupported", "Gemini isn't set up, so nothing was sent."));
      const failed = await client.callTool({ name: "ask_gemini", arguments: { path: "footage/take.mp4" } });
      expect(failed).toMatchObject({ isError: true, content: [{ type: "text", text: "Gemini isn't set up, so nothing was sent." }] });

      const invalid = await client.callTool({ name: "ask_gemini", arguments: { action: "status" } });
      expect(invalid.isError).toBe(true);
      expect(service.ask).toHaveBeenCalledTimes(2);
    } finally {
      await client.close();
      await session.close();
    }
  });
});
