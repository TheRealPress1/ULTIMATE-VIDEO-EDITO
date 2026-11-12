/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DapiError } from "@diffusionstudio/dapi";
import { EarshotService, ProjectJobs, parseReply, threadsFor, timeoutAdvice } from "./index";
import { InstallCanceled } from "./install";
import { WorkerTimeout } from "./worker";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { EarshotCache } from "./cache";
import type { EarshotInstaller } from "./install";
import type { EarshotWorker } from "./worker";
import type { RunResult } from "./process";
import type { EarshotStatus } from "./types";

/** An installer whose install settles when the test says so. */
function fakeInstaller(options: { ready?: boolean; status?: Partial<EarshotStatus> } = {}) {
  let ready = options.ready ?? false;
  let settle!: { resolve: () => void; reject: (error: Error) => void };
  let running: Promise<void> | null = null;
  const installer = {
    root: "/data/addons/earshot",
    home: "/data/addons/earshot/home",
    python: "/data/addons/earshot/venv/bin/python",
    isReady: vi.fn(async () => ready),
    ensureInstalled: vi.fn(() => (running ??= new Promise<void>((resolve, reject) => { settle = { resolve: () => { ready = true; resolve(); }, reject }; }))),
    status: vi.fn(async (): Promise<EarshotStatus> => ({ root: "/data/addons/earshot", state: ready ? "ready" : "installing", ...options.status, ...(ready ? { versions: { earshot: "0.4.0", commit: "591fa3e", uv: "0.13.7", python: "3.12.16", torch: "2.11.0", ffmpeg: "9.0.2" } } : {}) })),
    describe: vi.fn(() => "step 3/5, 410 of 2,077 MB"),
    earshotEnv: vi.fn(() => ({ PATH: "/data/addons/earshot/ffmpeg:/usr/bin:/bin", EARSHOT_HOME: "/data/addons/earshot/home" })),
    remove: vi.fn(async (before: () => Promise<void>) => { await before(); }),
    dispose: vi.fn(),
  };
  return { installer, finish: () => settle.resolve(), fail: (error: Error) => { settle.reject(error); running = null; } };
}

function fakeWorker(result: CallToolResult | Error = { content: [{ type: "text", text: "ok" }] }) {
  return { call: vi.fn(async () => { if (result instanceof Error) throw result; return result; }), stop: vi.fn(async () => {}), forgetCrashes: vi.fn(), dispose: vi.fn() };
}

/** earshot's caches as the service sees them: a size, and sweeps it starts and stops. */
function fakeCache(bytes = 0) {
  return { limitBytes: 500_000_000, size: vi.fn(async () => bytes), keepTidy: vi.fn(), stop: vi.fn(), forget: vi.fn() };
}

function service(installer: ReturnType<typeof fakeInstaller>["installer"], worker = fakeWorker(), run?: (command: string, args: readonly string[]) => Promise<RunResult>, waitMs = 5000, cache = fakeCache()) {
  return new EarshotService({
    userData: "/data",
    version: "0.217.0",
    installer: installer as unknown as EarshotInstaller,
    worker: worker as unknown as EarshotWorker,
    cache: cache as unknown as EarshotCache,
    waitMs,
    ...(run ? { run: (command, args) => run(command, args) } : {}),
  });
}

describe("EarshotService.ready", () => {
  it("returns at once when installed", async () => {
    const { installer } = fakeInstaller({ ready: true });
    await service(installer).ready();
    expect(installer.ensureInstalled).not.toHaveBeenCalled();
  });

  it("installs on first use and goes on when the install finishes in time", async () => {
    const { installer, finish } = fakeInstaller();
    const waiting = service(installer).ready();
    setTimeout(finish, 5);
    await waiting;
    expect(installer.ensureInstalled).toHaveBeenCalledTimes(1);
  });

  it("answers busy with how far the install is once it has waited long enough", async () => {
    const { installer } = fakeInstaller();
    await expect(service(installer, fakeWorker(), undefined, 30).ready()).rejects.toMatchObject({
      code: "busy",
      message: "Audio intelligence is installing (step 3/5, 410 of 2,077 MB). Continue with other work and call this tool again in a few minutes.",
    });
  });

  it("says why an install failed and that the next call retries it", async () => {
    const { installer, fail } = fakeInstaller();
    const waiting = service(installer).ready();
    await vi.waitFor(() => expect(installer.ensureInstalled).toHaveBeenCalled());
    fail(new Error("Installing earshot failed: Failed to fetch: `https://pypi.org/simple/torch/`: dns error."));
    await expect(waiting).rejects.toMatchObject({
      code: "unsupported",
      message: "Audio intelligence couldn't be installed: Installing earshot failed: Failed to fetch: `https://pypi.org/simple/torch/`: dns error. Calling a sound tool again retries the install (it resumes where it stopped), or use Install now in Blackout's Settings.",
    });
  });

  it("says plainly when this Mac can't run it", async () => {
    const { installer, fail } = fakeInstaller();
    const waiting = service(installer).ready();
    await vi.waitFor(() => expect(installer.ensureInstalled).toHaveBeenCalled());
    fail(new Error("Audio intelligence needs a Mac with Apple silicon: PyTorch, which earshot's sound models run on, has no current build for Intel Macs."));
    await expect(waiting).rejects.toMatchObject({ code: "unsupported", message: expect.stringMatching(/^Audio intelligence needs a Mac with Apple silicon/) });
  });

  it("reports an install Remove stopped, and a call canceled while it waits", async () => {
    const removed = fakeInstaller();
    const waiting = service(removed.installer).ready();
    await vi.waitFor(() => expect(removed.installer.ensureInstalled).toHaveBeenCalled());
    removed.fail(new InstallCanceled("Audio intelligence is being removed."));
    await expect(waiting).rejects.toMatchObject({ code: "canceled", message: expect.stringContaining("was removed from Blackout's Settings") });

    const { installer } = fakeInstaller();
    const controller = new AbortController();
    const slow = new EarshotService({ userData: "/data", version: "x", installer: installer as unknown as EarshotInstaller, worker: fakeWorker() as unknown as EarshotWorker, cache: fakeCache() as unknown as EarshotCache, waitMs: 10_000 });
    const pending = slow.ready(controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "canceled" });
  });
});

describe("EarshotService.call", () => {
  it("splits earshot's answer into its summary, its JSON and sheet's picture", async () => {
    const { installer } = fakeInstaller({ ready: true });
    const worker = fakeWorker({
      content: [
        { type: "text", text: 'PNG: /tmp/cutroom-sound-sheet-x/mix.png\n\nmix.wav: 12 events, 3 cuts.\n\nJSON (compact): {"events":12,"cuts":3}' },
        { type: "image", data: Buffer.from("jpeg bytes").toString("base64"), mimeType: "image/jpeg" },
      ],
    });
    const reply = await service(installer, worker).call("sheet", { path: "/a.wav" }, undefined, 1000);
    expect(reply).toEqual({ summary: "mix.wav: 12 events, 3 cuts.", json: { events: 12, cuts: 3 }, png: "/tmp/cutroom-sound-sheet-x/mix.png", image: { bytes: new Uint8Array(Buffer.from("jpeg bytes")), mimeType: "image/jpeg" } });
    expect(worker.call).toHaveBeenCalledWith("sheet", { path: "/a.wav" }, { signal: undefined, timeoutMs: 1000 });
  });

  it("passes earshot's own refusals on as the agent's error", async () => {
    const { installer } = fakeInstaller({ ready: true });
    const worker = fakeWorker({ isError: true, content: [{ type: "text", text: "unknown sound id 'whoosh_fast/cripsy'. Did you mean whoosh_fast/crisp?" }] });
    await expect(service(installer, worker).call("sfx_render", {}, undefined, 1000)).rejects.toMatchObject({ code: "invalid-input", message: "unknown sound id 'whoosh_fast/cripsy'. Did you mean whoosh_fast/crisp?" });
  });

  it("turns a timeout into advice that fits the tool", async () => {
    const { installer } = fakeInstaller({ ready: true });
    const worker = fakeWorker(new WorkerTimeout("earshot's timeline took longer than 60 min."));
    await expect(service(installer, worker).call("timeline", {}, undefined, 60 * 60 * 1000)).rejects.toMatchObject({ code: "busy", message: 'earshot\'s timeline took longer than 60 minutes and was stopped. Analyze a shorter start/end window, or use detail "low".' });
    await expect(service(installer, worker).call("sfx_render", {}, undefined, 5 * 60 * 1000)).rejects.toMatchObject({ code: "busy", message: "earshot's sfx_render took longer than 5 minutes and was stopped. Call it again." });
    expect(timeoutAdvice("critique")).toBe("Pass fast: true, or critique a shorter export.");
    expect(timeoutAdvice("describe")).toBe("Analyze a shorter start/end window.");
    // Other failures that mention a timeout (a worker that didn't start in time) aren't timeouts of the call.
    const late = fakeWorker(new Error("The sound analysis worker didn't start (Request timed out)."));
    await expect(service(installer, late).call("describe", {}, undefined, 1000)).rejects.toThrow("didn't start");
  });

  it("says why a call stopped when it was stopped for a reason the agent can act on", async () => {
    const { installer } = fakeInstaller({ ready: true });
    const controller = new AbortController();
    const reason = new DapiError("no-project", "The project was saved or moved while the sound effect rendered. Render it again in the project where it is now.");
    const worker = { ...fakeWorker(), call: vi.fn(async () => { controller.abort(reason); throw reason; }) };
    await expect(service(installer, worker).call("sfx_render", {}, controller.signal, 1000)).rejects.toBe(reason);
    const other = new AbortController();
    const plain = { ...fakeWorker(), call: vi.fn(async () => { other.abort(new Error("client went away")); throw new Error("aborted"); }) };
    await expect(service(installer, plain).call("describe", {}, other.signal, 1000)).rejects.toMatchObject({ code: "canceled", message: "The sound tool call was canceled." });
  });
});

describe("EarshotService.check", () => {
  it("runs earshot's audit offline and keeps its findings", async () => {
    const { installer } = fakeInstaller({ ready: true });
    const calls: Array<readonly string[]> = [];
    const run = async (_command: string, args: readonly string[]): Promise<RunResult> => {
      calls.push(args);
      return { code: 1, signal: null, stderr: "", stdout: JSON.stringify({ ok: false, summary: "hit.wav: 1 warning: 2 clicks at 0.120 s", warnings: [{ code: "clicks", msg: "2 clicks at 0.120 s" }], notes: [], measures: { clicks: 2 } }) };
    };
    const audit = await service(installer, fakeWorker(), run).check("/p/hit.wav", { role: "hit" });
    expect(calls).toEqual([["-m", "earshot", "sfx", "check", "/p/hit.wav", "--json", "--role", "hit"]]);
    expect(audit).toEqual({ ok: false, summary: "hit.wav: 1 warning: 2 clicks at 0.120 s", warnings: [{ code: "clicks", msg: "2 clicks at 0.120 s" }], notes: [] });
  });

  it("says why when earshot couldn't read the file", async () => {
    const { installer } = fakeInstaller({ ready: true });
    const run = async (): Promise<RunResult> => ({ code: 1, signal: null, stdout: "", stderr: "earshot sfx: error: LibsndfileError: Format not recognised." });
    await expect(service(installer, fakeWorker(), run).check("/p/x.bin", {})).rejects.toMatchObject({ code: "invalid-input", message: "earshot couldn't audit the file: LibsndfileError: Format not recognised." });
  });
});

describe("EarshotService.remove", () => {
  it("stops the worker and the cache sweeps before the folder goes, and starts its restart count over", async () => {
    const { installer } = fakeInstaller({ ready: true });
    const worker = fakeWorker();
    const cache = fakeCache();
    await service(installer, worker, undefined, 5000, cache).remove();
    expect(worker.stop).toHaveBeenCalled();
    expect(worker.forgetCrashes).toHaveBeenCalled();
    expect(installer.remove).toHaveBeenCalled();
    expect(cache.stop.mock.invocationCallOrder[0]).toBeLessThan(installer.remove.mock.invocationCallOrder[0]!);
    expect(cache.forget).toHaveBeenCalled();
  });
});

describe("EarshotService's caches", () => {
  it("counts what earshot's caches hold now in the ready add-on's size", async () => {
    const ready = fakeInstaller({ ready: true, status: { sizeBytes: 2_260_000_000 } });
    expect(await service(ready.installer, fakeWorker(), undefined, 5000, fakeCache(120_000_000)).status()).toMatchObject({
      state: "ready", sizeBytes: 2_380_000_000, cacheBytes: 120_000_000, cacheLimitBytes: 500_000_000,
    });
    // Not ready: the folder as it is, caches and all, measured by the installer.
    const cache = fakeCache(120_000_000);
    const partial = fakeInstaller({ status: { state: "not-installed", partial: true, sizeBytes: 900_000_000 } });
    expect(await service(partial.installer, fakeWorker(), undefined, 5000, cache).status()).toEqual({ root: "/data/addons/earshot", state: "not-installed", partial: true, sizeBytes: 900_000_000 });
    expect(cache.size).not.toHaveBeenCalled();
  });

  it("keeps the caches tidy from a call on, for as long as the worker runs", async () => {
    const { installer } = fakeInstaller({ ready: true });
    const worker = { ...fakeWorker(), running: true };
    const cache = fakeCache();
    const earshot = service(installer, worker as unknown as ReturnType<typeof fakeWorker>, async () => ({ code: 0, signal: null, stdout: JSON.stringify({ ok: true, summary: "", warnings: [], notes: [] }), stderr: "" }), 5000, cache);
    await earshot.call("describe", {}, undefined, 1000);
    expect(cache.keepTidy).toHaveBeenCalledTimes(1);
    const active = cache.keepTidy.mock.calls[0]![0] as () => boolean;
    expect(active()).toBe(true);
    worker.running = false;
    expect(active()).toBe(false);
    await earshot.check("/p/a.wav", {});
    expect(cache.keepTidy).toHaveBeenCalledTimes(2);
    earshot.dispose();
    expect(cache.stop).toHaveBeenCalled();
  });

  it("makes its own cache in the add-on's home folder, kept under 500 MB unless told otherwise", () => {
    const { installer } = fakeInstaller({ ready: true });
    const plain = new EarshotService({ userData: "/data", version: "x", installer: installer as unknown as EarshotInstaller, worker: fakeWorker() as unknown as EarshotWorker });
    expect([plain.cache.home, plain.cache.limitBytes]).toEqual(["/data/addons/earshot/home", 500_000_000]);
    const small = new EarshotService({ userData: "/data", version: "x", installer: installer as unknown as EarshotInstaller, worker: fakeWorker() as unknown as EarshotWorker, cacheLimitBytes: 100_000_000 });
    expect(small.cache.limitBytes).toBe(100_000_000);
  });
});

describe("ProjectJobs", () => {
  it("knows the temporary paths its jobs hold, and quitting stops them and removes those at once", async () => {
    const base = await realpath(await mkdtemp(join(tmpdir(), "earshot-jobs-")));
    try {
      const work = join(base, "cutroom-sfx-a");
      await mkdir(work);
      await writeFile(join(work, "take.wav"), "RIFF");
      const staged = join(base, ".dstmp-take.wav");
      await writeFile(staged, "RIFF");
      const jobs = new ProjectJobs(() => () => {}, "saved");
      const job = jobs.start("/p/a");
      job.hold(work);
      job.hold(staged);
      expect([jobs.holds(work), jobs.holds(join(base, "other"))]).toEqual([true, false]);
      jobs.dispose();
      expect(job.signal.aborted).toBe(true);
      expect(job.signal.reason).toMatchObject({ code: "canceled", message: "Blackout quit while the sound effect rendered." });
      expect(await readdir(base)).toEqual([]);
      job.done();
      expect(jobs.holds(work)).toBe(false);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});

describe("EarshotService.cancelRenders", () => {
  it("stops the renders into one project and holds its writes until they have", () => {
    const writes: string[] = [];
    const { installer } = fakeInstaller({ ready: true });
    const earshot = new EarshotService({
      userData: "/data", version: "x", installer: installer as unknown as EarshotInstaller, worker: fakeWorker() as unknown as EarshotWorker, cache: fakeCache() as unknown as EarshotCache,
      startWrite: (dir) => { writes.push(dir); return () => writes.push(`done ${dir}`); },
    });
    const a = earshot.renders.start("/p/a");
    const b = earshot.renders.start("/p/b");
    earshot.cancelRenders("/p/a");
    expect(a.signal.aborted).toBe(true);
    expect(a.signal.reason).toMatchObject({ code: "no-project" });
    expect(b.signal.aborted).toBe(false);
    expect(writes).toEqual(["/p/a"]);
    a.done();
    b.done();
    expect(writes).toEqual(["/p/a", "done /p/a"]);
  });
});

describe("parseReply", () => {
  it("reads the full and the compact JSON line, and text without any", () => {
    expect(parseReply("a.wav: a fast whoosh.\n\nJSON: {\"z\":4.0}")).toEqual({ summary: "a.wav: a fast whoosh.", json: { z: 4 } });
    expect(parseReply("JSON (compact): {\"ok\":true}")).toEqual({ summary: "", json: { ok: true } });
    expect(parseReply("no json here")).toEqual({ summary: "no json here", json: null });
    expect(parseReply("text\n\nJSON: {broken")).toEqual({ summary: "text\n\nJSON: {broken", json: null });
  });
});

describe("threadsFor", () => {
  it("uses half the cores, one to four", () => {
    expect([1, 2, 4, 8, 12, 32].map(threadsFor)).toEqual([1, 1, 2, 4, 4, 4]);
  });
});
