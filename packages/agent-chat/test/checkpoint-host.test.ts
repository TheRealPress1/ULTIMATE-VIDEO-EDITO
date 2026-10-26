/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { AgentHost } from "../src/host/host";
import { ChatStore } from "../src/host/store";
import { CheckpointStore } from "../src/host/checkpoints";
import type { Harness } from "../src/host/harness";

let host: AgentHost | undefined;
let dir: string;
afterEach(async () => { await host?.stop(); if (dir) await rm(dir, { recursive: true, force: true }); });

it("checkpoints an interrupted edit and serializes edits/restores across project chats", async () => {
  dir = await mkdtemp(join(tmpdir(), "cutroom-checkpoint-host-"));
  const cwd = join(dir, "project");
  await mkdir(cwd);
  await writeFile(join(cwd, "index.tsx"), "original source");
  let release!: () => void;
  let edited!: () => void;
  const editStarted = new Promise<void>((resolve) => { edited = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  const harness: Harness = {
    id: "claude",
    probe: async () => ({ id: "claude", label: "Test", status: "ready", models: [{ id: "test", label: "Test" }] }),
    open: async () => ({
      resume: { claude: { sessionId: "test" } },
      send: async () => {
        await writeFile(join(cwd, "index.tsx"), "partially edited source");
        edited();
        await held;
        return { status: "completed" };
      },
      respond() {},
      interrupt: async () => { release(); },
      close: async () => {},
    }),
  };
  host = new AgentHost({ store: new ChatStore(dir), checkpoints: new CheckpointStore(dir), harnesses: [harness], env: Promise.resolve({ env: {}, extraDirs: [] }), mcp: null, version: "test" });
  await host.start();
  const connection = { send() {} };
  const input = { projectId: "project", cwd, text: "Edit my video", model: { harness: "claude" as const, model: "test" } };
  const { chatId } = await host.handle(connection, "turn.send", input);
  await editStarted;
  await expect(host.handle(connection, "turn.send", input)).rejects.toMatchObject({ code: "busy" });
  await expect(host.handle(connection, "edits.restore", { projectId: "project", cwd, checkpointId: "any", direction: "undo" })).rejects.toMatchObject({ code: "busy" });
  await host.handle(connection, "turn.interrupt", { chatId });
  const review = (await host.handle(connection, "edits.review", { projectId: "project" }))!;
  expect(review.changes).toHaveLength(1);
  expect(review.changes[0]?.after).toBe("partially edited source");
  await host.handle(connection, "edits.restore", { projectId: "project", cwd, checkpointId: review.id, direction: "undo" });
  expect(await readFile(join(cwd, "index.tsx"), "utf8")).toBe("original source");
});
