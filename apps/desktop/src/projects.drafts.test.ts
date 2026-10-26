/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// A new project is a draft: made without asking, in the app's own folder,
// named after its id — until it is saved, which moves it where the user said
// and names it after the folder they chose.

import { tmpdir } from "node:os";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let userData = "";

vi.mock("electron", () => ({
  app: { isPackaged: false, getPath: (name: string) => (name === "userData" ? userData : tmpdir()) },
  dialog: {},
  shell: {},
  ipcMain: { on: () => { } },
}));

const { createProject, draftsRoot, duplicateProject, moveProject, readManifest, saveProject, startWrite, writeManifest } =
  await import("./projects");
const { WebMediaService } = await import("./web-media");

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "drafts-test-"));
  userData = join(root, "userData");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("drafts", () => {
  it("creates a draft in the drafts folder, named after its id", async () => {
    const project = await createProject();
    expect(project.draft).toBe(true);
    expect(project.dir).toBe(join(draftsRoot(), project.id));
    expect(project.name).toBe(project.id);
    expect(project.displayName).toBe("Untitled");
    expect(project.entry).toBe("index.tsx");
  });

  it("duplicates a draft as a draft with an id of its own", async () => {
    const source = await createProject();
    const copy = await duplicateProject(source.dir);
    expect(copy.draft).toBe(true);
    expect(copy.id).not.toBe(source.id);
    expect(copy.dir).toBe(join(draftsRoot(), copy.id));
  });

  it("saves a draft by moving it and naming it after the folder", async () => {
    const draft = await createProject();
    const target = join(root, "Saved", "My Ad");

    const saved = await saveProject(draft.dir, target);
    expect(saved).toMatchObject({ id: draft.id, dir: target, name: "My Ad", displayName: "My Ad", draft: false });
    expect(await readdir(draftsRoot())).toEqual([]);
    const pkg = JSON.parse(await readFile(join(target, "package.json"), "utf8"));
    expect(pkg.projectId).toBe(draft.id);
  });

  it("lands a write asked for before the save in the saved folder", async () => {
    const draft = await createProject();
    const target = join(root, "My Ad");

    const manifest = { version: 1, folders: [], assets: [{ id: "a" }] };
    const writing = writeManifest(draft.dir, manifest);
    await saveProject(draft.dir, target);
    await writing;
    expect(await readManifest(target)).toEqual(manifest);
    expect(await readdir(draftsRoot())).toEqual([]);
  });

  it("duplicates without waiting for a web download's network, or copying its partial file", async () => {
    const source = await createProject();
    let finish = () => {};
    const media = new WebMediaService({
      startWrite,
      resolve: async () => [{ address: "93.184.216.34", family: 4 }],
      // Its first bytes, then nothing until the test says so: a download minutes from done.
      fetch: async () => new Response(new ReadableStream({
        start(stream) {
          stream.enqueue(new Uint8Array(5000).fill(1).fill(0xff, 0, 2).fill(0xd8, 1, 2).fill(0xff, 2, 3));
          finish = () => { stream.enqueue(new Uint8Array(100).fill(2)); stream.close(); };
        },
      })),
    });
    const web = join(source.dir, "assets", "web");
    const pending = media.download({ id: "d1", dir: source.dir, url: "https://e.example/big.jpg", prefer: "image" }, new AbortController().signal);
    await vi.waitFor(async () => expect((await readdir(web).catch(() => [])).some((name) => name.startsWith(".dstmp-"))).toBe(true));

    const copy = await duplicateProject(source.dir);
    expect(await readdir(join(copy.dir, "assets", "web"))).toEqual([]);

    finish();
    const downloaded = await pending;
    expect(await readdir(web)).toEqual([downloaded.source.split("/").pop()]);
  });

  it("refuses a folder that exists, and a project that is not a draft", async () => {
    const draft = await createProject();
    const taken = join(root, "taken");
    await mkdir(taken);
    await expect(saveProject(draft.dir, taken)).rejects.toThrow(/already exists/);

    const saved = await saveProject(draft.dir, join(root, "saved"));
    await expect(saveProject(saved.dir, join(root, "again"))).rejects.toThrow(/saved already/);
  });

  it("moves a saved project, keeping its name, and refuses to move a draft", async () => {
    const draft = await createProject();
    await expect(moveProject(draft.dir, join(root, "elsewhere"))).rejects.toThrow(/Save the draft/);

    const saved = await saveProject(draft.dir, join(root, "My Ad"));
    const target = join(root, "Archive", "Ad Folder");
    const moved = await moveProject(saved.dir, target);
    expect(moved).toMatchObject({ id: draft.id, dir: target, name: "Ad Folder", displayName: "My Ad", draft: false });
    expect(await readdir(root)).not.toContain("My Ad");
  });
});
