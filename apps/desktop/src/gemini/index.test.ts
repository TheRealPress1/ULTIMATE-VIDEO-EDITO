import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toolByName } from "@diffusionstudio/dapi";
import { POLICY_MESSAGES } from "@diffusionstudio/agent-chat/host/policy";
import { GEMINI_DEFAULT_MODEL, GeminiService, configureGemini, gemini } from "./index";
import { GeminiSettingsError, type GeminiSecureStorage } from "./store";

import type { ToolArgs } from "@diffusionstudio/dapi";

// Built in two pieces: a literal in this shape would look like a real key to a secret scanner.
const KEY = ["AIza", "SyTestKeyForCutroomUnitTests_0123456"].join("");

let userData: string;
let elsewhere: string;
let secure: GeminiSecureStorage;
let network: ReturnType<typeof vi.fn>;

// The real service, wired as the app wires it, but with no FFmpeg and a network that fails the test if anything reaches it.
const service = () => new GeminiService({ userData, secureStorage: secure, ffmpeg: null, ffprobe: null });
const ask = (s: GeminiService, args: Partial<ToolArgs<"ask_gemini">>) =>
  s.ask(toolByName("ask_gemini").input.parse(args), { project: null, signal: new AbortController().signal });

beforeEach(async () => {
  userData = await mkdtemp(join(tmpdir(), "cutroom-gemini-userdata-"));
  elsewhere = await mkdtemp(join(tmpdir(), "cutroom-gemini-files-"));
  secure = {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`enc:${[...value].reverse().join("")}`),
    decryptString: (value: Buffer) => [...value.toString().slice("enc:".length)].reverse().join(""),
  };
  network = vi.fn(async () => { throw new Error("a test reached the network"); });
  vi.stubGlobal("fetch", network);
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all([rm(userData, { recursive: true, force: true }), rm(elsewhere, { recursive: true, force: true })]);
});

describe("the service as the app wires it", () => {
  it("asks Google nothing and reads nothing until a key is saved", async () => {
    const s = service();
    await expect(ask(s, { path: join(elsewhere, "take.mp4") })).rejects.toMatchObject({ code: "unsupported", message: expect.stringContaining("nothing was sent") });
    expect(network).not.toHaveBeenCalled();
    expect(await s.status()).toEqual({ configured: false, encryption: true, model: GEMINI_DEFAULT_MODEL, defaultModel: GEMINI_DEFAULT_MODEL });
  });

  it("keeps the key in userData/services, encrypted, and shows only its end", async () => {
    const s = service();
    const status = await s.update({ key: `GEMINI_API_KEY=${KEY}`, model: "gemini-3.5-flash-lite" });
    expect(status).toEqual({ configured: true, encryption: true, hint: KEY.slice(-4), model: "gemini-3.5-flash-lite", defaultModel: GEMINI_DEFAULT_MODEL });
    const saved = await readFile(join(userData, "services", "gemini.json"), "utf8");
    expect(saved).not.toContain(KEY);
    expect((await service().status()).configured).toBe(true);
    await expect(s.update({})).rejects.toBeInstanceOf(GeminiSettingsError);
    // Anything that isn't a string is ignored, so a confused or hostile caller can't save an object as a key.
    await expect(s.update({ key: { evil: true } as unknown as string })).rejects.toThrow("Nothing to save.");
    const cleared = await s.clear();
    expect(cleared.configured).toBe(false);
    await expect(ask(s, { path: join(elsewhere, "take.mp4") })).rejects.toMatchObject({ code: "unsupported" });
  });

  it("refuses to send its own key file, or any of the app's private folders, however it is reached", async () => {
    const s = service();
    await s.update({ key: KEY });
    await mkdir(join(userData, "agent-chat"), { recursive: true });
    await mkdir(join(userData, "instagram"), { recursive: true });
    await writeFile(join(userData, "agent-chat", "chat.mp4"), "private");
    await writeFile(join(userData, "instagram", "clip.mp4"), "private");
    await symlink(join(userData, "services", "gemini.json"), join(elsewhere, "innocent.mp4"));
    for (const path of [join(userData, "services", "gemini.json"), join(userData, "agent-chat", "chat.mp4"), join(userData, "instagram", "clip.mp4"), join(elsewhere, "innocent.mp4")]) {
      await expect(ask(s, { path }), path).rejects.toMatchObject({ code: "invalid-input", message: expect.stringContaining(POLICY_MESSAGES.sensitive) });
    }
    expect(network).not.toHaveBeenCalled();
  });

  it("refuses what isn't a video or audio file, and links that aren't YouTube, before anything is sent", async () => {
    const s = service();
    await s.update({ key: KEY });
    await writeFile(join(elsewhere, "notes.txt"), "not media");
    await expect(ask(s, { path: join(elsewhere, "notes.txt") })).rejects.toMatchObject({ code: "invalid-input", message: expect.stringContaining("isn't a video or audio file") });
    await expect(ask(s, { path: "https://example.com/clip.mp4" })).rejects.toMatchObject({ code: "invalid-input", message: expect.stringContaining("media_download") });
    await expect(ask(s, { path: join(elsewhere, "missing.mp4") })).rejects.toMatchObject({ code: "not-found" });
    // Without FFmpeg a sound can't be cut, so it says so instead of uploading the whole file.
    await writeFile(join(elsewhere, "take.mp4"), "x".repeat(100));
    await expect(ask(s, { path: join(elsewhere, "take.mp4"), send: "audio" })).rejects.toMatchObject({ code: "invalid-input", message: expect.stringContaining("can't be read here") });
    expect(network).not.toHaveBeenCalled();
  });
});

describe("the app's connection", () => {
  it("is unavailable until main sets it up, then is the one it set up", () => {
    expect(() => gemini()).toThrow(/isn't set up/);
    const first = configureGemini({ userData, secureStorage: secure, ffmpeg: null, ffprobe: null });
    expect(gemini()).toBe(first);
    const second = configureGemini({ userData, secureStorage: secure, ffmpeg: null, ffprobe: null });
    expect(gemini()).toBe(second);
    expect(second).not.toBe(first);
  });
});
