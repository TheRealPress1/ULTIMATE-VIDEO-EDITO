import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ReferenceIndexStore } from "./reference-index-store";
import { LocalReferenceStyleService } from "./reference-index";
import { buildReferenceProfile } from "./reference-profile";
import type { ReferenceAnalysis } from "./reference-types";
let dir: string, source: string;
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
    change: time === 0.5 ? 0.9 : 0,
    text: [],
    palette: ["#202020"],
  })),
};
const profile = buildReferenceProfile(analysis),
  request = () => ({ dir, source, duration: 1 });
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "uve-reference-"));
  source = join(dir, "source.mp4");
  await writeFile(source, "original bytes");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});
async function seed(store = new ReferenceIndexStore()) {
  const c = await store.get(request());
  return store.put({
    ...request(),
    expectedFingerprint: c.fingerprint,
    profile,
  });
}
describe("reference persistence", () => {
  it("reuses the full fingerprint across restart and rename without touching source bytes", async () => {
    const saved = await seed();
    await rename(source, join(dir, "renamed.mp4"));
    source = join(dir, "renamed.mp4");
    expect(await new ReferenceIndexStore().get(request())).toEqual(saved);
    expect(await readFile(source, "utf8")).toBe("original bytes");
  });
  it("rejects stale profile commits and invalidates changed references", async () => {
    const saved = await seed();
    await writeFile(source, "changed source bytes");
    const store = new ReferenceIndexStore();
    expect((await store.get(request())).profile).toBeNull();
    await expect(
      store.put({
        ...request(),
        expectedFingerprint: saved.fingerprint,
        profile,
      }),
    ).rejects.toThrow("changed");
  });
  it("rejects corrupted cached evidence without overwriting it", async () => {
    await seed();
    const path = join(dir, ".cutroom/reference-styles.json");
    const data = JSON.parse(await readFile(path, "utf8"));
    Object.values(data.entries).forEach((v) => {
      (v as { profile: typeof profile }).profile.cuts[0]!.time = 200;
    });
    const damaged = JSON.stringify(data);
    await writeFile(path, damaged);
    await expect(new ReferenceIndexStore().get(request())).rejects.toThrow(
      "damaged",
    );
    expect(await readFile(path, "utf8")).toBe(damaged);
  });
  it("rejects symlink caches and relative source traversal", async () => {
    await mkdir(join(dir, "elsewhere"));
    await symlink(join(dir, "elsewhere"), join(dir, ".cutroom"));
    await expect(new ReferenceIndexStore().get(request())).rejects.toThrow(
      "real project directory",
    );
    await expect(
      new ReferenceIndexStore().get({ ...request(), source: "../other.mp4" }),
    ).rejects.toThrow("absolute local path");
  });
  it("does not commit after cancellation", async () => {
    const store = new ReferenceIndexStore(),
      current = await store.get(request()),
      controller = new AbortController();
    controller.abort();
    await expect(
      store.put(
        { ...request(), expectedFingerprint: current.fingerprint, profile },
        controller.signal,
      ),
    ).rejects.toThrow();
    expect((await store.get(request())).profile).toBeNull();
  });
  it.runIf(process.platform === "darwin")(
    "analyzes via a process and reuses the persisted result without running it again",
    async () => {
      const runtimePath = join(dir, "helper.cjs");
      const events = [
        ...analysis.samples.map((_, i) => ({
          type: "progress",
          completed: i + 1,
          total: 4,
        })),
        { type: "result", analysis },
      ];
      await writeFile(
        runtimePath,
        `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(events.map((e) => JSON.stringify(e)).join("\n") + "\n")});`,
      );
      await chmod(runtimePath, 0o700);
      const service = new LocalReferenceStyleService({ runtimePath });
      try {
        const result = await service.analyze({
          ...request(),
          id: randomUUID(),
        });
        expect(result.profile).toEqual(profile);
        await rm(runtimePath);
        expect(
          await service.analyze({ ...request(), id: randomUUID() }),
        ).toEqual(result);
      } finally {
        service.dispose();
      }
    },
  );
});
