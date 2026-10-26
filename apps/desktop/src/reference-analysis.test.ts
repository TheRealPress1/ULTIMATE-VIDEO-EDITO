import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalReferenceAnalyzer } from "./reference-analysis";
import type { ReferenceAnalysis } from "./reference-types";
let dir: string, runtimePath: string, path: string;
let services: LocalReferenceAnalyzer[];
const analysis: ReferenceAnalysis = {
  duration: 1,
  sourceStart: 0,
  analyzedDuration: 1,
  width: 1080,
  height: 1920,
  sampleInterval: 0.25,
  samples: [0, 0.25, 0.5, 0.75].map((time) => ({
    time,
    mediaTime: time,
    change: 0,
    text: [],
    palette: [],
  })),
};
const events = [
  ...analysis.samples.map((_, i) => ({
    type: "progress",
    completed: i + 1,
    total: 4,
  })),
  { type: "result", analysis },
];
const output = (value: unknown[]) =>
  `process.stdout.write(${JSON.stringify(value.map((e) => JSON.stringify(e)).join("\n") + "\n")});`;
async function runtime(body = output(events)) {
  await writeFile(runtimePath, `#!${process.execPath}\n${body}`);
  await chmod(runtimePath, 0o700);
}
function service(timeout = 10000) {
  const s = new LocalReferenceAnalyzer({
    runtimePath,
    runTimeoutMs: timeout,
    killGraceMs: 20,
  });
  services.push(s);
  return s;
}
const request = () => ({ id: randomUUID(), path, duration: 1 });
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "uve-reference-process-"));
  runtimePath = join(dir, "helper.cjs");
  path = join(dir, "source with $ticks `now`.mp4");
  services = [];
  await writeFile(path, "original bytes");
  await runtime();
});
afterEach(async () => {
  services.forEach((s) => s.dispose());
  await rm(dir, { recursive: true, force: true });
});
describe.runIf(process.platform === "darwin")(
  "reference process boundaries",
  () => {
    it("returns local evidence and ordered progress without touching the reference", async () => {
      const progress: number[] = [];
      expect(
        await service().analyze(request(), (p) => progress.push(p.completed)),
      ).toEqual(analysis);
      expect(progress).toEqual([1, 2, 3, 4]);
      expect(await readFile(path, "utf8")).toBe("original bytes");
    });
    it.each([
      events.slice(0, -1),
      events.slice(1),
      [...events, { type: "extra" }],
      [
        ...events.slice(0, -1),
        { type: "result", analysis: { ...analysis, samples: [] } },
      ],
    ])(
      "rejects incomplete, out-of-order or extra output %#",
      async (...value) => {
        await runtime(output(value));
        await expect(service().analyze(request())).rejects.toThrow();
      },
    );
    it("rejects media changed by another process before accepting evidence", async () => {
      await runtime(
        `require('node:fs').writeFileSync(process.argv[2],'replacement bytes');${output(events)}`,
      );
      await expect(service().analyze(request())).rejects.toThrow("changed");
    });
    it("bounds runaway output and execution time", async () => {
      await runtime(
        "process.stdout.write('x'.repeat(9*1024*1024));setInterval(()=>{},1000);",
      );
      await expect(service().analyze(request())).rejects.toThrow("too much");
      await runtime("setInterval(()=>{},1000);");
      await expect(service(200).analyze(request())).rejects.toThrow("too long");
    });
    it("cancels a stubborn matching job and permits retry after cleanup", async () => {
      const started = join(dir, "started");
      await runtime(
        `process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(${JSON.stringify(started)},'ready');setInterval(()=>{},1000);`,
      );
      const s = service(),
        req = request(),
        work = s.analyze(req);
      const rejected = expect(work).rejects.toThrow("cancelled");
      for (let i = 0; i < 300; i++) {
        if (
          await stat(started).then(
            () => true,
            () => false,
          )
        )
          break;
        await new Promise((r) => setTimeout(r, 5));
      }
      s.cancel(randomUUID());
      await expect(s.analyze(request())).rejects.toThrow("Another");
      s.cancel(req.id);
      await rejected;
      await runtime();
      await expect(s.analyze(request())).resolves.toEqual(analysis);
    });
    it("rejects requests outside bounded local input and preserves cleanup when progress throws", async () => {
      const s = service();
      await expect(
        s.analyze({ ...request(), duration: 86401 }),
      ).rejects.toThrow("Invalid");
      await expect(
        s.analyze({ ...request(), path: "relative.mp4" }),
      ).rejects.toThrow("Invalid");
      await expect(
        s.analyze(request(), () => {
          throw new Error("unmounted");
        }),
      ).resolves.toEqual(analysis);
    });
  },
);
