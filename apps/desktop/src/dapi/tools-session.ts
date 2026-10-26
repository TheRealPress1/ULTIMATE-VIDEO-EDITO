/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { toolJsonSchemas, tools } from "@diffusionstudio/dapi";
import { present, toCallToolResult, toErrorResult } from "./present";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { GenericTool, ToolName } from "@diffusionstudio/dapi";

/** Runs one tool wherever it lives (main or renderer) and returns the handler's raw result. */
export type ToolRunner = (tool: GenericTool, args: unknown, signal: AbortSignal) => Promise<unknown>;

/**
 * Serves the whole catalog on an MCP session: every tool registered with the
 * SDK, which validates arguments against the zod schema and structured
 * content against the output schema, and a `tools/list` of our own.
 *
 * The list is ours because the SDK's converts the zod schemas to JSON Schema
 * draft-07, and the validators clients run reject that dialect — Claude Code
 * fails every call on the `outputSchema` before it reaches the app. What
 * clients get instead is the same schema in 2020-12 (see `toolJsonSchemas`);
 * `tools/call` and the validation behind it stay the SDK's.
 */
export function serveCatalog(session: McpServer, run: ToolRunner): void {
  for (const tool of tools) {
    session.registerTool(
      tool.name,
      { title: tool.title, description: tool.description, inputSchema: tool.input, outputSchema: tool.output, annotations: tool.annotations },
      async (args, extra) => {
        try {
          const result = await run(tool, args, extra.signal);
          return toCallToolResult(await present(tool.name as ToolName, args, result));
        } catch (error) {
          return toErrorResult(error);
        }
      },
    );
  }
  session.server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: tools.map((tool) => ({ name: tool.name, title: tool.title, description: tool.description, ...toolJsonSchemas(tool), ...(tool.annotations ? { annotations: tool.annotations } : {}) })),
  }));
}
