/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalReframeService } from "./reframe-analysis";
import type { LocalReframeServiceOptions } from "./reframe-analysis";
import type { ReframeAnalysisProgress, ReframeAnalysisRequest } from "./reframe-types";

let directory: string;
let runtimePath: string;
let sourcePath: string;
let services: LocalReframeService[];
const events = [
  { type: "header", duration: 3, width: 1920, height: 1080, total: 2, sampleInterval: 0.5 },
  { type: "sample", time: 1, faces: [{ x: 0.2, y: 0.1, width: 0.1, height: 0.2, confidence: 0.95 }], cut: false },
  { type: "sample", time: 1.5, faces: [], cut: true },
  { type: "done", completed: 2 },
];
const emitEvents = (values: unknown[]) => `process.stdout.write(${JSON.stringify(values.map((value) => JSON.stringify(value)).join("\n") + "\n")});`;

async function runtime(body = emitEvents(events)) {
  await writeFile(runtimePath, `#!${process.execPath}\n${body}`, { mode: 0o700 });
  await chmod(runtimePath, 0o700);
}
function service(options: Partial<LocalReframeServiceOptions> = {}) {
  const value = new LocalReframeService({ runtimePath, killGraceMs: 15, ...options });
  services.push(value);
  return value;
}
function request(options: Partial<ReframeAnalysisRequest> = {}): ReframeAnalysisRequest {
  return { id: randomUUID(), path: sourcePath, start: 1, end: 2, ...options };
}
async function waitForFile(path: string) {
  for (let i = 0; i < 300; i++) {
    if (await stat(path).then(() => true, () => false)) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Test helper did not start.");
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "cutroom-reframe-test-"));
  runtimePath = join(directory, "vision-helper.cjs");
  sourcePath = join(directory, "video with $symbols `ticks`.mp4");
  services = [];
  await writeFile(sourcePath, "local source fixture");
  await runtime();
});
afterEach(async () => {
  for (const value of services) value.dispose();
  await rm(directory, { recursive: true, force: true });
});

describe.runIf(process.platform === "darwin")("local reframe analysis", () => {
  it("returns source-time oriented boxes, cut hints and valid no-face samples without modifying media", async () => {
    const value = service();
    const progress: ReframeAnalysisProgress[] = [];
    const input = request();
    const result = await value.analyze(input, (event) => progress.push(event));
    expect(result).toEqual({ duration: 3, width: 1920, height: 1080, sampleInterval: 0.5, samples: events.slice(1, 3).map(({ type: _type, ...sample }) => sample) });
    expect(progress).toEqual([0, 1, 2].map((completed) => ({ id: input.id, completed, total: 2 })));
    expect(await readFile(sourcePath, "utf8")).toBe("local source fixture");
  });

  it("passes source names literally as a separate process argument", async () => {
    const captured = join(directory, "arguments.json");
    await runtime(`require('node:fs').writeFileSync(${JSON.stringify(captured)}, JSON.stringify(process.argv.slice(2)));${emitEvents(events)}`);
    await service().analyze(request());
    expect(JSON.parse(await readFile(captured, "utf8"))).toEqual([await realpath(sourcePath), "1", "2", "0.5"]);
  });

  it.each([
    { start: -1 }, { end: 1 }, { end: NaN }, { sampleInterval: 0.01 }, { sampleInterval: 6 },
    { start: 0, end: 601 }, { start: 0, end: 600, sampleInterval: 0.25 }, { path: "relative.mp4" }, { id: "not-an-id" },
  ])("rejects invalid or unbounded requests %j", async (invalid) => {
    await expect(service().analyze(request(invalid))).rejects.toThrow();
  });

  it.each([
    events.slice(0, -1),
    [events[0], { ...events[1], time: 1.2 }, events[2], events[3]],
    [events[0], { ...events[1], faces: [{ x: 0.9, y: 0, width: 0.3, height: 0.2, confidence: 1 }] }, events[2], events[3]],
    [events[0], { ...events[1], cut: "yes" }, events[2], events[3]],
    [{ ...events[0], total: 3 }, ...events.slice(1)],
    [...events, events[1]],
  ])("rejects incomplete, out-of-order or damaged detector output %#", async (...args) => {
    const output = args as unknown[];
    await runtime(emitEvents(output));
    await expect(service().analyze(request())).rejects.toThrow();
  });

  it("reports a source replacement instead of using stale results", async () => {
    await runtime(`require('node:fs').writeFileSync(process.argv[2], 'changed source contents');${emitEvents(events)}`);
    await expect(service().analyze(request())).rejects.toThrow("source video changed");
  });

  it("cancels only the matching task, reaps a stubborn worker and allows a retry", async () => {
    const started = join(directory, "started");
    await runtime(`process.on('SIGTERM', () => {}); require('node:fs').writeFileSync(${JSON.stringify(started)}, 'ready');setInterval(() => {}, 1000);`);
    const value = service();
    const input = request();
    const work = value.analyze(input);
    const rejected = expect(work).rejects.toThrow("cancelled");
    await waitForFile(started);
    value.cancel(randomUUID());
    await expect(value.analyze(request())).rejects.toThrow("Another face analysis");
    value.cancel(input.id);
    await rejected;
    await runtime();
    await expect(value.analyze(request())).resolves.toMatchObject({ width: 1920 });
  });

  it("bounds execution time and frees the service after timeout", async () => {
    await runtime("setInterval(() => {}, 1000);");
    const value = service({ runTimeoutMs: 1000 });
    await expect(value.analyze(request())).rejects.toThrow("too long");
    await runtime();
    await expect(value.analyze(request())).resolves.toMatchObject({ width: 1920 });
  });

  it("bounds process output before parsing a runaway line", async () => {
    await runtime("process.stdout.write('x'.repeat(9 * 1024 * 1024));setInterval(() => {}, 1000);");
    await expect(service().analyze(request())).rejects.toThrow("too much data");
  });

  it("rejects an unavailable helper and a disposed service without mutating media", async () => {
    const value = service({ runtimePath: join(directory, "missing") });
    expect(await value.available()).toBe(false);
    await expect(value.analyze(request())).rejects.toThrow("Vision helper");
    value.dispose();
    await expect(value.analyze(request())).rejects.toThrow("closed");
  });

  it("ignores progress callback failures without losing cleanup or output", async () => {
    await expect(service().analyze(request(), () => { throw new Error("window closed"); })).resolves.toMatchObject({ width: 1920 });
  });
});
