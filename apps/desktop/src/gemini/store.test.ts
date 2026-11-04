import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GeminiSettingsError, GeminiStore, cleanKey, cleanModel, redactKey, type GeminiSecureStorage } from "./store";

// Built in two pieces: a literal in this shape would look like a real key to a secret scanner.
const KEY = ["AIza", "SyTestKeyForCutroomUnitTests_0123456"].join("");
const OTHER = ["AIza", "SyAnotherKeyForCutroomTests_9876543"].join("");
const DEFAULT_MODEL = "gemini-test-flash";

let directory: string;
let secure: GeminiSecureStorage & { available: boolean };

const store = () => new GeminiStore({ directory, secureStorage: secure, defaultModel: DEFAULT_MODEL });

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "cutroom-gemini-"));
  secure = {
    available: true,
    isEncryptionAvailable() { return this.available; },
    encryptString: vi.fn((value: string) => Buffer.from(`enc:${[...value].reverse().join("")}`)),
    decryptString: vi.fn((value: Buffer) => [...value.toString().slice("enc:".length)].reverse().join("")),
  };
});
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

describe("pasted keys and model names", () => {
  it("takes the key alone, or as copied from an .env line", () => {
    expect(cleanKey(KEY)).toBe(KEY);
    expect(cleanKey(`  ${KEY}\n`)).toBe(KEY);
    expect(cleanKey(`GEMINI_API_KEY=${KEY}`)).toBe(KEY);
    expect(cleanKey(`export GOOGLE_API_KEY="${KEY}"`)).toBe(KEY);
    expect(cleanKey(`'${KEY}'`)).toBe(KEY);
  });

  it("refuses anything that is not shaped like a key", () => {
    for (const text of ["", "short", "has a space in the middle of it ok", `${KEY} ${OTHER}`, `${KEY}\n${OTHER}`, "a".repeat(201), "AIza$%^&*()_+=[]{}|;:,.<>?/~`!!!!!!!!"]) {
      expect(cleanKey(text), text).toBeNull();
    }
  });

  it("reads a model as Google spells it, without the models/ prefix", () => {
    expect(cleanModel("gemini-3.8-flash")).toBe("gemini-3.8-flash");
    expect(cleanModel(" models/gemini-flash-latest ")).toBe("gemini-flash-latest");
    for (const text of ["", " ", "-flash", "gemini flash", "gemini/flash", "../x", "x".repeat(81)]) expect(cleanModel(text), text).toBeNull();
  });

  it("blanks the key, and anything shaped like one, out of a message", () => {
    expect(redactKey(`bad key ${KEY} for ${KEY}`, KEY)).toBe("bad key [key] for [key]");
    expect(redactKey(`API key not valid: ${OTHER}`)).toBe("API key not valid: [key]");
    expect(redactKey("nothing to hide", KEY)).toBe("nothing to hide");
  });
});

describe("the saved key", () => {
  it("starts empty, with the default model, and says whether this Mac can encrypt", async () => {
    expect(await store().status()).toEqual({ configured: false, encryption: true, model: DEFAULT_MODEL, defaultModel: DEFAULT_MODEL });
    expect(await store().secret()).toBeNull();
    secure.available = false;
    expect((await store().status()).encryption).toBe(false);
  });

  it("saves the key encrypted, with a hint of its last four characters and never the key in the status", async () => {
    const saved = await store().update({ key: `GEMINI_API_KEY=${KEY}` });
    expect(saved).toEqual({ configured: true, encryption: true, hint: KEY.slice(-4), model: DEFAULT_MODEL, defaultModel: DEFAULT_MODEL });
    expect(JSON.stringify(saved)).not.toContain(KEY);
    const files = await readdir(directory);
    expect(files).toEqual(["gemini.json"]);
    const onDisk = await readFile(join(directory, "gemini.json"), "utf8");
    expect(onDisk).not.toContain(KEY);
    expect(onDisk).not.toContain(KEY.slice(0, 12));
    expect(JSON.parse(onDisk)).toMatchObject({ version: 1, encryptedKey: expect.any(String) });
    if (process.platform !== "win32") expect((await stat(join(directory, "gemini.json"))).mode & 0o777).toBe(0o600);
  });

  it("gives the key back to main after a restart", async () => {
    await store().update({ key: KEY });
    const again = store();
    expect(await again.secret()).toBe(KEY);
    expect((await again.status()).configured).toBe(true);
  });

  it("replaces a key with another, and forgets it on clear", async () => {
    const first = store();
    await first.update({ key: KEY });
    await first.update({ key: OTHER });
    expect(await first.secret()).toBe(OTHER);
    expect((await first.status()).hint).toBe(OTHER.slice(-4));
    const cleared = await first.clear();
    expect(cleared).toEqual({ configured: false, encryption: true, model: DEFAULT_MODEL, defaultModel: DEFAULT_MODEL });
    expect(await readdir(directory)).toEqual([]);
    expect(await store().secret()).toBeNull();
    await expect(first.clear()).resolves.toMatchObject({ configured: false });
  });

  it("refuses what is not a key, and says nothing about what was typed", async () => {
    const error = await store().update({ key: "hunter2 hunter2 hunter2 hunter2" }).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(GeminiSettingsError);
    expect((error as Error).message).not.toContain("hunter2");
    expect(await readdir(directory)).toEqual([]);
  });

  it("never writes the key in plain text when this Mac can't encrypt", async () => {
    secure.available = false;
    await expect(store().update({ key: KEY })).rejects.toThrow("encrypted");
    expect(await readdir(directory)).toEqual([]);
    expect(secure.encryptString).not.toHaveBeenCalled();
  });

  it("reports an unreadable key instead of throwing, and a new key recovers it", async () => {
    for (const bytes of ["{not json", JSON.stringify({ version: 2 }), JSON.stringify({ version: 1, encryptedKey: "###" }), "x".repeat(20_000)]) {
      await writeFile(join(directory, "gemini.json"), bytes);
      const status = await store().status();
      expect(status.configured, bytes.slice(0, 20)).toBe(false);
      expect(status.error).toMatch(/Save/);
    }
    await store().update({ key: KEY });
    expect(await store().status()).toMatchObject({ configured: true });
    expect((await store().status()).error).toBeUndefined();
  });

  it("reports a key this Mac can no longer decrypt", async () => {
    await store().update({ key: KEY });
    (secure.decryptString as ReturnType<typeof vi.fn>).mockImplementation(() => { throw new Error("Decryption failed"); });
    const status = await store().status();
    expect(status).toMatchObject({ configured: false, error: expect.stringContaining("can't be decrypted") });
    expect(await store().secret()).toBeNull();
  });
});

describe("the model", () => {
  it("is the default until one is chosen, and choosing the default stores nothing", async () => {
    const s = store();
    expect((await s.update({ model: "models/gemini-other-flash" })).model).toBe("gemini-other-flash");
    expect(await s.currentModel()).toBe("gemini-other-flash");
    expect(JSON.parse(await readFile(join(directory, "gemini.json"), "utf8"))).toEqual({ version: 1, model: "gemini-other-flash" });
    expect((await s.update({ model: DEFAULT_MODEL })).model).toBe(DEFAULT_MODEL);
    expect(JSON.parse(await readFile(join(directory, "gemini.json"), "utf8"))).toEqual({ version: 1 });
  });

  it("goes back to the default when emptied, keeps the key, and refuses a name that isn't one", async () => {
    const s = store();
    await s.update({ key: KEY, model: "gemini-other-flash" });
    await expect(s.update({ model: "not a model" })).rejects.toBeInstanceOf(GeminiSettingsError);
    expect(await s.currentModel()).toBe("gemini-other-flash");
    const reset = await s.update({ model: "  " });
    expect(reset).toMatchObject({ configured: true, model: DEFAULT_MODEL });
    expect(await store().secret()).toBe(KEY);
  });

  it("changes the model without touching the saved key: its ciphertext is written back as it was, never encrypted again", async () => {
    await store().update({ key: KEY });
    const before = JSON.parse(await readFile(join(directory, "gemini.json"), "utf8")).encryptedKey;
    const later = store();
    await later.update({ model: "gemini-other-flash" });
    expect(await later.secret()).toBe(KEY);
    expect(JSON.parse(await readFile(join(directory, "gemini.json"), "utf8"))).toEqual({ version: 1, encryptedKey: before, model: "gemini-other-flash" });
    expect(secure.encryptString).toHaveBeenCalledTimes(1);
  });

  it("serializes overlapping saves, so the last one wins whole", async () => {
    const s = store();
    await Promise.all([s.update({ key: KEY }), s.update({ key: OTHER }), s.update({ model: "gemini-other-flash" })]);
    expect(await s.secret()).toBe(OTHER);
    expect(await s.currentModel()).toBe("gemini-other-flash");
    expect(JSON.parse(await readFile(join(directory, "gemini.json"), "utf8"))).toMatchObject({ model: "gemini-other-flash" });
    expect(await readdir(directory)).toEqual(["gemini.json"]);
  });
});
