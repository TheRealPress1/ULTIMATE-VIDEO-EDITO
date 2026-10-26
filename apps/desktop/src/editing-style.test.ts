import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EditingStyleStore } from "./editing-style";

describe("editing preferences persistence", () => {
  let dir: string;
  let path: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "uve-style-")); path = join(dir, "style.json"); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it("persists and clears preferences across app restarts", async () => {
    const store = new EditingStyleStore(path);
    expect(await store.get()).toEqual({ version: 1, revision: 0, notes: "", updatedAt: null });
    const saved = await store.set("Keep natural pauses.\nUse warm colors.", 0);
    expect(await new EditingStyleStore(path).get()).toEqual(saved);
    const cleared = await store.set("", saved.revision);
    expect(cleared).toMatchObject({ revision: 2, notes: "" });
    expect(await new EditingStyleStore(path).get()).toEqual(cleared);
  });

  it("keeps newer preferences when two agent/UI writers share an old revision", async () => {
    const store = new EditingStyleStore(path);
    const result = await Promise.allSettled([store.set("First preference", 0), store.set("Stale preference", 0)]);
    expect(result[0].status).toBe("fulfilled");
    expect(result[1]).toMatchObject({ status: "rejected", reason: { code: "busy" } });
    expect((await store.get()).notes).toBe("First preference");
    await expect(store.set("Reviewed replacement", 1)).resolves.toMatchObject({ revision: 2 });
  });

  it("does not overwrite corrupt or newer-format records", async () => {
    for (const original of ["{broken", JSON.stringify({ version: 2, revision: 3, notes: "preserve me", updatedAt: null })]) {
      await writeFile(path, original);
      const store = new EditingStyleStore(path);
      await expect(store.get()).rejects.toThrow("has not been changed");
      await expect(store.set("replacement", 0)).rejects.toThrow();
      expect(await readFile(path, "utf8")).toBe(original);
    }
  });

  it("rejects oversized and incomplete requests without corrupting the record", async () => {
    const store = new EditingStyleStore(path);
    await store.set("Saved preference", 0);
    await expect(store.set("x".repeat(8001), 1)).rejects.toThrow();
    await expect(store.set(undefined as unknown as string, 1)).rejects.toThrow();
    await expect(store.set("new", undefined as unknown as number)).rejects.toThrow();
    expect((await store.get()).notes).toBe("Saved preference");
  });

  it("does not create a revision for an unchanged preference", async () => {
    const store = new EditingStyleStore(path);
    const saved = await store.set("No gratuitous zooms", 0);
    expect(await store.set(saved.notes, saved.revision)).toEqual(saved);
  });
});
