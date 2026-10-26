/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalVisualAnalyzer } from "./visual-analysis";
import type { LocalVisualAnalyzerOptions } from "./visual-analysis";
import type { VisualProgress } from "./visual-types";
import type { VisualAnalysisRequest } from "./visual-analysis";

let directory: string;
let runtimePath: string;
let sourcePath: string;
let services: LocalVisualAnalyzer[];
const events = [
  { type: "header", sourceStart: 0, duration: 10, width: 1920, height: 1080, total: 2, sampleInterval: 5 },
  { type: "sample", time: 0, mediaTime: 0, labels: [{ text: "bicycle", confidence: 0.95 }], text: [{ text: "café", confidence: 0.8 }], people: 1 },
  { type: "sample", time: 5, mediaTime: 5, labels: [], text: [], people: 0 },
  { type: "done", completed: 2 },
];
const emitEvents = (values: unknown[]) => `process.stdout.write(${JSON.stringify(values.map((value) => JSON.stringify(value)).join("\n") + "\n")});`;

async function runtime(body = emitEvents(events)) {
  await writeFile(runtimePath, `#!${process.execPath}\n${body}`, { mode: 0o700 });
  await chmod(runtimePath, 0o700);
}
function service(options: Partial<LocalVisualAnalyzerOptions> = {}) {
  const value = new LocalVisualAnalyzer({ runtimePath, killGraceMs: 15, ...options });
  services.push(value);
  return value;
}
function request(options: Partial<VisualAnalysisRequest> = {}): VisualAnalysisRequest {
  return { id: randomUUID(), path: sourcePath, duration: 10, ...options };
}
async function waitForFile(path: string) {
  for (let i = 0; i < 300; i++) {
    if (await stat(path).then(() => true, () => false)) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Test helper did not start.");
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "cutroom-visual-test-"));
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

describe.runIf(process.platform === "darwin")("local visual analysis", () => {
  it("returns timestamped labels, OCR and valid empty samples without modifying media", async () => {
    const value = service();
    const progress: VisualProgress[] = [];
    const input = request();
    const result = await value.analyze(input, (event) => progress.push(event));
    expect(result).toEqual({ sourceStart: 0, duration: 10, width: 1920, height: 1080, sampleInterval: 5, samples: events.slice(1, 3).map(({ type: _type, ...sample }) => sample) });
    expect(progress).toEqual([0, 1, 2].map((completed) => ({ id: input.id, completed, total: 2 })));
    expect(await readFile(sourcePath, "utf8")).toBe("local source fixture");
  });

  it("passes source names literally as a separate process argument", async () => {
    const captured = join(directory, "arguments.json");
    await runtime(`require('node:fs').writeFileSync(${JSON.stringify(captured)}, JSON.stringify(process.argv.slice(2)));${emitEvents(events)}`);
    await service().analyze(request());
    expect(JSON.parse(await readFile(captured, "utf8"))).toEqual([await realpath(sourcePath), "10", "5", "0"]);
  });

  it('preserves actual frame PTS and normalizes an offset source instead of substituting sampling slots', async () => {
    const output = [{ ...events[0], sourceStart: 0.033 },
      { ...events[1], time: 0, mediaTime: 0.033 },
      { ...events[2], time: 4.971633333333333, mediaTime: 5.0046333333333335 }, events[3]];
    await runtime(emitEvents(output));
    const result = await service().analyze(request({ sourceStart: 0.033 }));
    expect(result.sourceStart).toBe(0.033);
    expect(result.samples[1]).toMatchObject({ time: 4.971633333333333, mediaTime: 5.0046333333333335 });
    await expect(service().analyze(request({ sourceStart: 2 }))).rejects.toThrow('metadata');
  });

  it.each([
    { sourceStart: -1 }, { sourceStart: NaN }, { sourceStart: 86401 }, { duration: -1 }, { duration: 0 }, { duration: NaN }, { sampleInterval: 0.01 }, { sampleInterval: 31 },
    { duration: 7201 }, { duration: 7200, sampleInterval: 1 }, { startIndex: -1 }, { endIndex: 3 }, { startIndex: 1, endIndex: 1 }, { path: "relative.mp4" }, { id: "not-an-id" },
  ])("rejects invalid or unbounded requests %j", async (invalid) => {
    await expect(service().analyze(request(invalid))).rejects.toThrow();
  });

  it.each([
    events.slice(0, -1),
    [events[0], { ...events[1], time: 2 }, events[2], events[3]],
    [events[0], { ...events[1], labels: [{ text: "invalid", confidence: 2 }] }, events[2], events[3]],
    [events[0], { ...events[1], people: -1 }, events[2], events[3]],
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
    await expect(value.analyze(request())).rejects.toThrow("Another visual indexing");
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
    await runtime("process.stdout.write('x'.repeat(25 * 1024 * 1024));setInterval(() => {}, 1000);");
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
  it("preserves non-ASCII OCR split across native output chunks", async () => {
    const output = events.map((event) => JSON.stringify(event)).join('\n') + '\n';
    await runtime(`const bytes = Buffer.from(${JSON.stringify(output)});const split=bytes.indexOf(Buffer.from('é'))+1;process.stdout.write(bytes.subarray(0,split));setTimeout(()=>process.stdout.write(bytes.subarray(split)),20);`);
    const result = await service().analyze(request());
    expect(result.samples[0]!.text[0]!.text).toBe('café');
  });

});
