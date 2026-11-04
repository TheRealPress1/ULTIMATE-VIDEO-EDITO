/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { earshotEvents } from "./events";

import type { EarshotService } from "./index";

let project: string;

beforeEach(async () => {
  project = await realpath(await mkdtemp(join(tmpdir(), "earshot-events-")));
  await mkdir(join(project, "assets", "footage"), { recursive: true });
  await writeFile(join(project, "assets", "footage", "talk.mp4"), "video");
});
afterEach(async () => {
  await rm(project, { recursive: true, force: true });
});

function service(ready: boolean) {
  const call = vi.fn(async () => ({ summary: "Speech, then applause.", json: { events: [{ t: 12, tags: ["Applause"] }] } }));
  const fake = { installer: { isReady: async () => ready }, privateDirs: [], call, earshotVersion: async () => "0.4.0" } as unknown as EarshotService;
  return { fake, call };
}

describe("analyze's sound events", () => {
  it("runs earshot's timeline at low detail over the window of a library source", async () => {
    const { fake, call } = service(true);
    const reply = await earshotEvents(fake, { id: "1", dir: project, path: "assets/footage/talk.mp4", start: 10, end: 70 });
    expect(call).toHaveBeenCalledWith("timeline", { path: join(project, "assets", "footage", "talk.mp4"), start: 10, end: 70, detail: "low" }, undefined, expect.any(Number));
    expect(reply).toEqual({ version: "0.4.0", summary: "Speech, then applause.", result: { events: [{ t: 12, tags: ["Applause"] }] } });
  });

  it("never waits on an install: an add-on that is not ready answers busy at once", async () => {
    const { fake, call } = service(false);
    await expect(earshotEvents(fake, { id: "1", dir: project, path: "assets/footage/talk.mp4" })).rejects.toMatchObject({ code: "busy" });
    expect(call).not.toHaveBeenCalled();
  });
});
