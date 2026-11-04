import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cutAudioArgs, ffmpegCutAudio } from "./audio";

const bundled = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "dist", "audio-tools", "ffmpeg");

describe("the cut", () => {
  it("asks ffmpeg for the first sound as 16 kHz mono WAV, cut before the input so it is exact", () => {
    expect(cutAudioArgs("/in/take.mov", "/tmp/sound.wav", { start: 12.5, duration: 30 })).toEqual([
      "-hide_banner", "-nostdin", "-v", "error", "-ss", "12.500", "-t", "30.000", "-i", "/in/take.mov",
      "-map", "0:a:0", "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "-f", "wav", "-y", "/tmp/sound.wav",
    ]);
  });

  it("leaves out what the window doesn't name", () => {
    const whole = cutAudioArgs("/in/a.wav", "/tmp/o.wav", { start: 0, duration: null });
    expect(whole).not.toContain("-ss");
    expect(whole).not.toContain("-t");
    expect(cutAudioArgs("/in/a.wav", "/tmp/o.wav", { start: 5, duration: null })).toContain("-ss");
    expect(cutAudioArgs("/in/a.wav", "/tmp/o.wav", { start: 0, duration: 4 })).toContain("-t");
  });

  it("refuses plainly when the build has no audio tools", async () => {
    await expect(ffmpegCutAudio(null)("/in/a.wav", "/tmp/o.wav", { start: 0, duration: null }, new AbortController().signal)).rejects.toMatchObject({ code: "unsupported", message: expect.stringContaining("send=video") });
  });
});

/** The byte length of a WAV's `data` chunk: its sound, whatever metadata chunks come before it. */
function dataBytes(wav: Buffer): number {
  for (let at = 12; at + 8 <= wav.length;) {
    const size = wav.readUInt32LE(at + 4);
    if (wav.subarray(at, at + 4).toString() === "data") return size;
    at += 8 + size + (size % 2);
  }
  throw new Error("no data chunk");
}

/** A WAV file of `seconds` of a 24 kHz mono tone, written without any tool. */
function tone(seconds: number): Buffer {
  const rate = 24_000;
  const samples = Math.round(seconds * rate);
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 8000), i * 2);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

// The bundled FFmpeg is built by `npm run build:desktop`'s audio tools step; without it there is nothing real to run.
describe.skipIf(!existsSync(bundled))("the cut, with the app's own FFmpeg", () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "cutroom-gemini-cut-")); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it("writes exactly the window's seconds as a 16 kHz mono 16-bit WAV", async () => {
    const input = join(dir, "in.wav");
    const output = join(dir, "out.wav");
    await writeFile(input, tone(8));
    await ffmpegCutAudio(bundled)(input, output, { start: 2, duration: 1.5 }, new AbortController().signal);
    const wav = await readFile(output);
    expect(wav.subarray(0, 4).toString()).toBe("RIFF");
    expect(wav.subarray(8, 12).toString()).toBe("WAVE");
    expect(wav.readUInt16LE(22)).toBe(1);
    expect(wav.readUInt32LE(24)).toBe(16_000);
    expect(wav.readUInt16LE(34)).toBe(16);
    // 1.5 s at 16 kHz, 2 bytes a sample: to the sample.
    expect(dataBytes(wav)).toBe(48_000);
  });

  it("runs to the end of the file when no duration is given, and stops when canceled", async () => {
    const input = join(dir, "in.wav");
    const output = join(dir, "out.wav");
    await writeFile(input, tone(5));
    await ffmpegCutAudio(bundled)(input, output, { start: 3, duration: null }, new AbortController().signal);
    // Two seconds are left after the 3 s mark of a 5 s file.
    expect(dataBytes(await readFile(output))).toBe(2 * 16_000 * 2);
    const controller = new AbortController();
    controller.abort(new Error("stop"));
    await expect(ffmpegCutAudio(bundled)(input, join(dir, "never.wav"), { start: 0, duration: null }, controller.signal)).rejects.toThrow("stop");
  });

  it("fails with what ffmpeg said when the file has no sound", async () => {
    await writeFile(join(dir, "empty.wav"), Buffer.from("not audio"));
    await expect(ffmpegCutAudio(bundled)(join(dir, "empty.wav"), join(dir, "o.wav"), { start: 0, duration: null }, new AbortController().signal)).rejects.toThrow(/failed/);
  });
});
