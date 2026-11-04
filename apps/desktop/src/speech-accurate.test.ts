/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalSpeechService } from "./speech";
import type { SpeechProgress } from "./speech-types";

const BASE = Buffer.from("A small verified base model.");
const LARGE = Buffer.from("A somewhat larger verified accurate model fixture.");
const BASE_MODEL = { url: "https://models.example.test/base.bin", bytes: BASE.length, sha256: createHash("sha256").update(BASE).digest("hex") };
const ACCURATE_MODEL = { url: "https://models.example.test/large-v3-turbo.bin", bytes: LARGE.length + 7, sha1: createHash("sha1").update(LARGE).digest("hex") };
const OUTPUT = { transcription: [{ text: " Hi.", tokens: [{ text: " Hi", offsets: { from: 0, to: 300 } }, { text: ".", offsets: { from: 300, to: 320 } }] }] };

let directory: string;
let runtimePath: string;
let captured: string;
let instances: LocalSpeechService[];

function wav(samples = 16_000): Buffer {
  const value = Buffer.alloc(44 + samples * 2);
  value.write("RIFF", 0);
  value.writeUInt32LE(value.length - 8, 4);
  value.write("WAVEfmt ", 8);
  value.writeUInt32LE(16, 16);
  value.writeUInt16LE(1, 20);
  value.writeUInt16LE(1, 22);
  value.writeUInt32LE(16_000, 24);
  value.writeUInt32LE(32_000, 28);
  value.writeUInt16LE(2, 32);
  value.writeUInt16LE(16, 34);
  value.write("data", 36);
  value.writeUInt32LE(samples * 2, 40);
  return value;
}

function service(body: (url: string) => Buffer = (url) => (url === ACCURATE_MODEL.url ? LARGE : BASE)) {
  const request = vi.fn(async (url: string) => new Response(body(url)));
  const instance = new LocalSpeechService({ runtimePath, dataDir: join(directory, "data"), model: BASE_MODEL, accurateModel: ACCURATE_MODEL, fetch: request as unknown as typeof fetch, killGraceMs: 20 });
  instances.push(instance);
  return { instance, request };
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "cutroom-speech-accurate-"));
  runtimePath = join(directory, "runtime.cjs");
  captured = join(directory, "args.json");
  instances = [];
  await writeFile(runtimePath, `#!${process.execPath}
const fs = require("node:fs"); const args = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(captured)}, JSON.stringify(args));
fs.writeFileSync(args[args.indexOf("-of") + 1] + ".json", ${JSON.stringify(JSON.stringify(OUTPUT))});
`, { mode: 0o700 });
  await chmod(runtimePath, 0o700);
});
afterEach(async () => {
  for (const instance of instances) instance.dispose();
  await rm(directory, { recursive: true, force: true });
});

describe("accurate transcription model", () => {
  it("is never downloaded unless a request asks for it", async () => {
    const { instance, request } = service();
    await instance.transcribe({ id: randomUUID(), audio: wav() });
    expect(request.mock.calls.map(([url]) => url)).toEqual([BASE_MODEL.url]);
    expect(await instance.status()).toMatchObject({ modelDownloaded: true, accurate: { modelName: "Whisper Large v3 Turbo", downloaded: false, downloadBytes: ACCURATE_MODEL.bytes } });
    expect(await readdir(join(directory, "data", "models"))).toEqual(["ggml-base.bin"]);
  });

  it("downloads once on an accurate request, says how large it is, verifies it and runs with it", async () => {
    const { instance, request } = service();
    const events: SpeechProgress[] = [];
    await expect(instance.transcribe({ id: randomUUID(), audio: wav(), quality: "accurate" }, (event) => events.push(event))).resolves.toEqual({ segments: [{ text: "Hi.", words: [{ text: "Hi.", start: 0, end: 0.32 }] }] });
    expect(request.mock.calls.map(([url]) => url)).toEqual([ACCURATE_MODEL.url]);
    expect(events.find((event) => event.stage === "downloading")?.message).toMatch(/accurate speech model \(about 1\.6 GB, once\)/);
    const args: string[] = JSON.parse(await readFile(captured, "utf8"));
    expect(args[args.indexOf("-m") + 1]).toMatch(/ggml-large-v3-turbo\.bin$/);
    expect(await readFile(join(directory, "data", "models", "ggml-large-v3-turbo.bin"))).toEqual(LARGE);
    expect(await instance.status()).toMatchObject({ modelDownloaded: false, accurate: { downloaded: true } });

    request.mockRejectedValue(new Error("Offline"));
    await instance.transcribe({ id: randomUUID(), audio: wav(), quality: "accurate" });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("refuses a damaged download with an actionable message and keeps nothing", async () => {
    const { instance } = service(() => Buffer.from("not the model"));
    await expect(instance.transcribe({ id: randomUUID(), audio: wav(), quality: "accurate" })).rejects.toThrow(/accurate speech model download \(about 1\.6 GB\) is incomplete or damaged.*quality "fast"/);
    expect((await readdir(join(directory, "data", "models"))).filter((name) => !name.startsWith("."))).toEqual([]);
  });

  it("rejects an unknown quality before any download", async () => {
    const { instance, request } = service();
    await expect(instance.transcribe({ id: randomUUID(), audio: wav(), quality: "best" as never })).rejects.toThrow("fast or accurate");
    expect(request).not.toHaveBeenCalled();
  });
});
