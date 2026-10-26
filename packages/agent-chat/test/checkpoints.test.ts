/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
import { createHash } from "node:crypto";
import { chmod, mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CheckpointStore } from "../src/host/checkpoints";

let dir: string;
let project: string;
let data: string;
let store: CheckpointStore;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cutroom-checkpoint-"));
  project = join(dir, "project");
  data = join(dir, "data");
  await mkdir(project);
  await writeFile(join(project, "index.tsx"), "export default <scene />;\n");
  store = new CheckpointStore(data);
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const source = () => readFile(join(project, "index.tsx"), "utf8");

describe("composition checkpoints", () => {
  it("persists undo and redo across restarts, including added and removed source, while preserving media and imports", async () => {
    await mkdir(join(project, "components"));
    await mkdir(join(project, "assets"));
    await writeFile(join(project, "components", "old.tsx"), "old component");
    await writeFile(join(project, "assets", "clip.mp4"), "original media");
    await writeFile(join(project, "assets.yml"), "assets: []");
    const checkpoint = (await store.begin("project", project, "Add a title"))!;
    await writeFile(join(project, "index.tsx"), "export default <scene><text>Hello</text></scene>;\n");
    await rm(join(project, "components", "old.tsx"));
    await writeFile(join(project, "components", "title.tsx"), "new title");
    await store.finish(checkpoint);
    // An import after the turn is not a composition edit and must survive Undo.
    await writeFile(join(project, "assets", "music.mp3"), "later import");
    await writeFile(join(project, "assets.yml"), "assets: [clip, music]");
    store = new CheckpointStore(data);
    const review = (await store.review("project"))!;
    expect(review.changes.map((file) => [file.path, file.kind])).toEqual([
      ["components/old.tsx", "removed"], ["components/title.tsx", "added"], ["index.tsx", "modified"],
    ]);
    expect((await store.restore("project", review.id, project, "undo"))?.undone).toBe(true);
    expect(await source()).toBe("export default <scene />;\n");
    expect(await readFile(join(project, "components", "old.tsx"), "utf8")).toBe("old component");
    await expect(readFile(join(project, "components", "title.tsx"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(project, "assets", "clip.mp4"), "utf8")).toBe("original media");
    expect(await readFile(join(project, "assets", "music.mp3"), "utf8")).toBe("later import");
    expect(await readFile(join(project, "assets.yml"), "utf8")).toBe("assets: [clip, music]");
    store = new CheckpointStore(data);
    expect((await store.restore("project", review.id, project, "redo"))?.undone).toBe(false);
    expect(await source()).toContain("Hello");
    expect(await readFile(join(project, "components", "title.tsx"), "utf8")).toBe("new title");
  });

  it("allows preview navigation after the turn while still protecting later title edits", async () => {
    await writeFile(join(project, "index.tsx"), 'export default <scene id="s" playhead={0}><text id="t">Before</text></scene>');
    const checkpoint = (await store.begin("project", project, "Change title"))!;
    await writeFile(join(project, "index.tsx"), 'export default <scene id="s" playhead={0}><text id="t">After</text></scene>');
    await store.finish(checkpoint);
    await writeFile(join(project, "index.tsx"), 'export default <scene id="s" playhead={8} active><text id="t" selected>After</text></scene>');
    await store.restore("project", checkpoint.id, project, "undo");
    expect(await source()).toContain(">Before</text>");
    await writeFile(join(project, "index.tsx"), 'export default <scene id="s" playhead={8}><text id="t">My later title</text></scene>');
    await expect(store.restore("project", checkpoint.id, project, "redo")).rejects.toThrow("preserve your newer edits");
    expect(await source()).toContain("My later title");
  });

  it("refuses to overwrite newer manual edits and retains the review", async () => {
    const checkpoint = (await store.begin("project", project, "Add title"))!;
    await writeFile(join(project, "index.tsx"), "agent edit");
    await store.finish(checkpoint);
    await writeFile(join(project, "index.tsx"), "manual edit after agent");
    await expect(store.restore("project", checkpoint.id, project, "undo")).rejects.toThrow("preserve your newer edits");
    expect(await source()).toBe("manual edit after agent");
    expect((await store.review("project"))?.undone).toBe(false);
  });

  it("refuses undo through a directory replaced by a symlink, leaving external files untouched", async () => {
    await mkdir(join(project, "components"));
    await writeFile(join(project, "components", "title.tsx"), "before");
    const checkpoint = (await store.begin("project", project, "Remove title"))!;
    await rm(join(project, "components"), { recursive: true });
    await store.finish(checkpoint);
    const outside = join(dir, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "title.tsx"), "do not touch");
    await symlink(outside, join(project, "components"));
    await expect(store.restore("project", checkpoint.id, project, "undo")).rejects.toThrow("linked");
    expect(await readFile(join(outside, "title.tsx"), "utf8")).toBe("do not touch");
  });

  it("bounds source storage while excluding media, caches, dependencies, and hidden folders", async () => {
    for (const folder of ["assets", "node_modules", ".cache", "dist"]) {
      await mkdir(join(project, folder));
      await writeFile(join(project, folder, "large.json"), "x".repeat(2 * 1024 * 1024 + 1));
    }
    expect(await store.begin("project", project, "Safe source scan")).not.toBeNull();
    await writeFile(join(project, "large.json"), "x".repeat(2 * 1024 * 1024 + 1));
    await expect(store.begin("project", project, "Oversized source")).rejects.toThrow("checkpoint limit");
    expect(await source()).toBe("export default <scene />;\n");
  });

  it("keeps the last useful undo across read-only turns and rejects it after a newer edit", async () => {
    const previous = (await store.begin("project", project, "First"))!;
    await writeFile(join(project, "index.tsx"), "first");
    await store.finish(previous);
    const next = (await store.begin("project", project, "Read only"))!;
    await store.finish(next);
    expect((await store.review("project"))?.id).toBe(previous.id);
    const edited = (await store.begin("project", project, "Second edit"))!;
    await writeFile(join(project, "index.tsx"), "second");
    await store.finish(edited);
    await expect(store.restore("project", previous.id, project, "undo")).rejects.toThrow("latest checkpoint");
    expect(await source()).toBe("second");
  });
});


const checkpointPath = () => join(data, "source-checkpoints", `${createHash("sha256").update("project").digest("hex")}.json`);
const fileData = (text: string) => ({ data: Buffer.from(text).toString("base64"), mode: 0o644 });

async function interruptedRestore(direction: "undo" | "redo" = "undo") {
  await writeFile(join(project, "other.tsx"), "other before");
  const checkpoint = (await store.begin("project", project, "Edit two files"))!;
  await writeFile(join(project, "index.tsx"), "agent after");
  await writeFile(join(project, "other.tsx"), "other after");
  await store.finish(checkpoint);
  if (direction === "redo") await store.restore("project", checkpoint.id, project, "undo");
  const expected = direction === "undo" ? checkpoint.after! : checkpoint.before;
  const target = direction === "undo" ? checkpoint.before : checkpoint.after!;
  const files = Object.fromEntries(["index.tsx", "other.tsx"].map((path) => [path, { before: expected[path], after: target[path] }]));
  await writeFile(checkpointPath() + ".restore", JSON.stringify({ version: 1, projectId: "project", checkpointId: checkpoint.id, cwd: project, direction, files }));
  await writeFile(join(project, "index.tsx"), Buffer.from(target["index.tsx"]!.data, "base64"));
  return checkpoint;
}

describe("checkpoint crash recovery", () => {
  it("recovers an interrupted agent turn before a new read-only turn can replace its pending snapshot", async () => {
    const interrupted = (await store.begin("project", project, "Interrupted edit"))!;
    await writeFile(join(project, "index.tsx"), "partial agent edit");
    store = new CheckpointStore(data);
    const next = (await store.begin("project", project, "Read-only follow-up"))!;
    await store.finish(next);
    expect(await store.review("project")).toMatchObject({ id: interrupted.id, recovered: true });
    await store.restore("project", interrupted.id, project, "undo");
    expect(await source()).toBe("export default <scene />;\n");
  });

  it("does not absorb later manual edits when finish committed before pending-file cleanup", async () => {
    const checkpoint = (await store.begin("project", project, "Edit"))!;
    const pending = await readFile(checkpointPath() + ".pending");
    await writeFile(join(project, "index.tsx"), "agent edit");
    await store.finish(checkpoint);
    await writeFile(checkpointPath() + ".pending", pending);
    await writeFile(join(project, "index.tsx"), "later manual edit");
    store = new CheckpointStore(data);
    await store.recover("project", project);
    expect((await store.review("project"))?.changes[0]?.after).toBe("agent edit");
    await expect(store.restore("project", checkpoint.id, project, "undo")).rejects.toThrow("preserve your newer edits");
    expect(await source()).toBe("later manual edit");
  });

  it.each(["undo", "redo"] as const)("rolls back a partly written %s after a process restart", async (direction) => {
    const checkpoint = await interruptedRestore(direction);
    store = new CheckpointStore(data);
    await store.recover("project", project);
    expect(await source()).toBe(direction === "undo" ? "agent after" : "export default <scene />;\n");
    expect(await readFile(join(project, "other.tsx"), "utf8")).toBe(direction === "undo" ? "other after" : "other before");
    expect((await store.review("project"))?.undone).toBe(direction === "redo");
    await expect(readFile(checkpointPath() + ".restore")).rejects.toMatchObject({ code: "ENOENT" });
    await store.restore("project", checkpoint.id, project, direction);
    expect(await source()).toBe(direction === "undo" ? "export default <scene />;\n" : "agent after");
  });

  it("preserves a newer edit and the recovery journal without partially rolling back other files", async () => {
    await interruptedRestore();
    await writeFile(join(project, "other.tsx"), "newer external edit");
    store = new CheckpointStore(data);
    await expect(store.recover("project", project)).rejects.toThrow("newer edit");
    expect(await source()).toBe("export default <scene />;\n");
    expect(await readFile(join(project, "other.tsx"), "utf8")).toBe("newer external edit");
    expect(await readFile(checkpointPath() + ".restore", "utf8")).toContain("checkpointId");
    await expect(store.begin("project", project, "Another edit")).rejects.toThrow("newer edit");
  });

  it("cleans a committed restore receipt without undoing a newer manual edit", async () => {
    const checkpoint = await interruptedRestore();
    const journal = await readFile(checkpointPath() + ".restore");
    await store.recover("project", project);
    await store.restore("project", checkpoint.id, project, "undo");
    await writeFile(checkpointPath() + ".restore", journal);
    await writeFile(join(project, "index.tsx"), "later manual edit");
    store = new CheckpointStore(data);
    await store.recover("project", project);
    expect(await source()).toBe("later manual edit");
    expect((await store.review("project"))?.undone).toBe(true);
  });

  it("keeps the journal when a failed restore also cannot finish rollback, then recovers after restart", async () => {
    await writeFile(join(project, "other.tsx"), "other before");
    const checkpoint = (await store.begin("project", project, "Edit two files"))!;
    await writeFile(join(project, "index.tsx"), "agent after");
    await writeFile(join(project, "other.tsx"), "other after");
    await store.finish(checkpoint);
    const writer = store as unknown as { writeSource(cwd: string, path: string, value?: { data: string; mode: number }): Promise<void> };
    const original = writer.writeSource.bind(store);
    let writes = 0;
    vi.spyOn(writer, "writeSource").mockImplementation(async (...args) => {
      if (++writes > 1) throw new Error("Simulated storage failure");
      await original(...args);
    });
    await expect(store.restore("project", checkpoint.id, project, "undo")).rejects.toThrow("Recovery is still pending");
    expect(await source()).toBe("export default <scene />;\n");
    expect(await readFile(checkpointPath() + ".restore", "utf8")).toContain("checkpointId");
    store = new CheckpointStore(data);
    await store.recover("project", project);
    expect(await source()).toBe("agent after");
    expect((await store.review("project"))?.undone).toBe(false);
  });

  it.each(["null", "{broken", JSON.stringify({ id: "invalid", projectId: "other" })])("refuses corrupt pending state without replacing it: %s", async (damaged) => {
    await store.begin("project", project, "Edit");
    await writeFile(checkpointPath() + ".pending", damaged);
    await expect(store.begin("project", project, "Next edit")).rejects.toThrow();
    expect(await readFile(checkpointPath() + ".pending", "utf8")).toBe(damaged);
    expect(await source()).toBe("export default <scene />;\n");
  });

  it("rejects forged journal content before writing source", async () => {
    await interruptedRestore();
    const journal = JSON.parse(await readFile(checkpointPath() + ".restore", "utf8"));
    journal.files["index.tsx"].before = fileData("unrelated replacement");
    await writeFile(checkpointPath() + ".restore", JSON.stringify(journal));
    await expect(store.recover("project", project)).rejects.toThrow("unexpected source data");
    expect(await source()).toBe("export default <scene />;\n");
  });
});


it("preserves exact source permissions instead of filtering restored modes through the process umask", async () => {
  await chmod(join(project, "index.tsx"), 0o666);
  const checkpoint = (await store.begin("project", project, "Change permissions and title"))!;
  await writeFile(join(project, "index.tsx"), "agent edit");
  await chmod(join(project, "index.tsx"), 0o660);
  await store.finish(checkpoint);
  await store.restore("project", checkpoint.id, project, "undo");
  expect((await stat(join(project, "index.tsx"))).mode & 0o777).toBe(0o666);
  await store.restore("project", checkpoint.id, project, "redo");
  expect((await stat(join(project, "index.tsx"))).mode & 0o777).toBe(0o660);
});

it.each([
  { path: "../outside.tsx", data: "c291cmNl", mode: 0o644 },
  { path: "index.tsx", data: "not base64!", mode: 0o644 },
  { path: "index.tsx", data: "c291cmNl", mode: -1 },
])("rejects invalid persisted source before recovery can mutate project files", async ({ path, data: encoded, mode }) => {
  await store.begin("project", project, "Interrupted edit");
  const pending = JSON.parse(await readFile(checkpointPath() + ".pending", "utf8"));
  pending.before = { [path]: { data: encoded, mode } };
  await writeFile(checkpointPath() + ".pending", JSON.stringify(pending));
  await expect(store.recover("project", project)).rejects.toThrow();
  expect(await source()).toBe("export default <scene />;\n");
  expect(await readFile(checkpointPath() + ".pending", "utf8")).toContain(encoded);
});


it("does not discard pending recovery for an incomplete committed checkpoint", async () => {
  await store.begin("project", project, "Interrupted edit");
  const pending = await readFile(checkpointPath() + ".pending", "utf8");
  await writeFile(checkpointPath(), pending);
  await writeFile(join(project, "index.tsx"), "partial agent edit");
  await expect(store.recover("project", project)).rejects.toThrow("incomplete");
  expect(await readFile(checkpointPath() + ".pending", "utf8")).toBe(pending);
  expect(await source()).toBe("partial agent edit");
});
