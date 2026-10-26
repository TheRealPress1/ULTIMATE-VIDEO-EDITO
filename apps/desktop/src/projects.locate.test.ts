/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// A project folder renamed or moved in Finder is found again next to where it
// was, by the id in its record.

import { tmpdir } from "node:os";
import { mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { isPackaged: false, getPath: () => tmpdir() },
  dialog: {},
  shell: {},
  ipcMain: { on: () => { } },
}));

const { findMovedProject, initProject } = await import("./projects");

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "locate-test-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("findMovedProject", () => {
  it("finds a project renamed in place by its id", async () => {
    const project = await initProject(null, join(root, "golden-river"));
    await initProject(null, join(root, "another"));
    await rename(project.dir, join(root, "My Ad"));

    const found = await findMovedProject(project.dir, project.id);
    expect(found).toMatchObject({ id: project.id, dir: join(root, "My Ad") });
  });

  it("finds nothing when the folder left its parent, or the parent is gone", async () => {
    const project = await initProject(null, join(root, "golden-river"));
    await mkdir(join(root, "elsewhere", "deeper"), { recursive: true });
    await rename(project.dir, join(root, "elsewhere", "deeper", "My Ad"));

    expect(await findMovedProject(project.dir, project.id)).toBeNull();
    expect(await findMovedProject(join(root, "gone", "golden-river"), project.id)).toBeNull();
    expect(await findMovedProject(project.dir, "")).toBeNull();
  });
});
