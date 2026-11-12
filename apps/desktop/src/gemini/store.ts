/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The user's own Google AI Studio key, and the model it is used with. The key
// is encrypted with the OS keychain (Electron's safeStorage) before it touches
// disk, in a folder agents are never allowed to read; where the OS can't
// encrypt it, it is not saved at all. Only main ever reads it back.

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { GeminiSettingsUpdate, GeminiStatus } from "./types";

/** The part of Electron's `safeStorage` this store needs. */
export type GeminiSecureStorage = {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
};

export type GeminiStoreOptions = {
  /** `<userData>/services`, which the agents' read rule keeps private. */
  directory: string;
  secureStorage: GeminiSecureStorage;
  defaultModel: string;
};

const FILE = "gemini.json";
const MAX_FILE_BYTES = 16 * 1024;
const KEY_SHAPE = /^[A-Za-z0-9_-]{20,200}$/;
const MODEL_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

/** Thrown with a message that is safe to show: it never holds the key. */
export class GeminiSettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GeminiSettingsError";
  }
}

/**
 * What a pasted key reads as: the key alone, the way people copy it from the
 * dashboard or an `.env` line (`GEMINI_API_KEY="…"`). Null when it isn't one.
 */
export function cleanKey(text: string): string | null {
  const stripped = text.trim().replace(/^(?:export\s+)?(?:GEMINI|GOOGLE)_API_KEY\s*=\s*/i, "").replace(/^(["'])(.*)\1$/, "$2").trim();
  return KEY_SHAPE.test(stripped) ? stripped : null;
}

/** A model id as Google spells it, without the `models/` prefix a copied name often carries. Null when it isn't one. */
export function cleanModel(text: string): string | null {
  const model = text.trim().replace(/^models\//i, "");
  return MODEL_SHAPE.test(model) ? model : null;
}

/** `text` with the key, and anything shaped like a Google API key, blanked out: for messages that leave the store or the client. */
export function redactKey(text: string, key?: string | null): string {
  let out = key ? text.split(key).join("[key]") : text;
  out = out.replace(/AIza[0-9A-Za-z_-]{20,}/g, "[key]");
  return out;
}

type Stored = { version: 1; encryptedKey?: string; model?: string };

export class GeminiStore {
  private readonly options: GeminiStoreOptions;
  private loaded = false;
  private key: string | null = null;
  /** The saved key as it sits on disk (base64 ciphertext), so a change of model writes it back untouched. */
  private encrypted: string | null = null;
  private model: string | null = null;
  private problem: string | undefined;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(options: GeminiStoreOptions) {
    this.options = options;
  }

  private get path(): string {
    return join(this.options.directory, FILE);
  }

  /** Runs `work` after everything queued before it, so a save and a read never interleave. */
  private serialized<T>(work: () => Promise<T>): Promise<T> {
    const next = this.chain.then(work, work);
    this.chain = next.catch(() => {});
    return next;
  }

  private encryption(): boolean {
    try { return this.options.secureStorage.isEncryptionAvailable(); } catch { return false; }
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    this.key = null;
    this.encrypted = null;
    this.model = null;
    this.problem = undefined;
    let stored: Stored;
    try {
      if ((await stat(this.path)).size > MAX_FILE_BYTES) throw new Error("too large");
      stored = JSON.parse(await readFile(this.path, "utf8")) as Stored;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.problem = "The saved Gemini settings could not be read. Save the key again.";
      return;
    }
    if (!stored || stored.version !== 1) {
      this.problem = "The saved Gemini settings could not be read. Save the key again.";
      return;
    }
    if (typeof stored.model === "string" && cleanModel(stored.model)) this.model = cleanModel(stored.model);
    if (typeof stored.encryptedKey !== "string") return;
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(stored.encryptedKey)) {
      this.problem = "The saved Gemini key could not be read. Save it again.";
      return;
    }
    try {
      if (!this.encryption()) throw new Error("no keychain");
      const key = this.options.secureStorage.decryptString(Buffer.from(stored.encryptedKey, "base64"));
      if (!KEY_SHAPE.test(key)) throw new Error("not a key");
      this.key = key;
      this.encrypted = stored.encryptedKey;
    } catch {
      this.problem = "The saved Gemini key can't be decrypted on this Mac. Save it again.";
    }
  }

  private snapshot(): GeminiStatus {
    return {
      configured: this.key !== null,
      encryption: this.encryption(),
      ...(this.key ? { hint: this.key.slice(-4) } : {}),
      model: this.model ?? this.options.defaultModel,
      defaultModel: this.options.defaultModel,
      ...(this.problem ? { error: this.problem } : {}),
    };
  }

  /** What Settings shows. Never the key. */
  status(): Promise<GeminiStatus> {
    return this.serialized(async () => { await this.load(); return this.snapshot(); });
  }

  /** The key, for a request main is about to make; null when none is saved. */
  secret(): Promise<string | null> {
    return this.serialized(async () => { await this.load(); return this.key; });
  }

  /** The model to ask: the one chosen in Settings, or the default. */
  currentModel(): Promise<string> {
    return this.serialized(async () => { await this.load(); return this.model ?? this.options.defaultModel; });
  }

  /** Saves a new key and/or model. Throws a GeminiSettingsError whose message is safe to show. */
  update(change: GeminiSettingsUpdate): Promise<GeminiStatus> {
    return this.serialized(async () => {
      await this.load();
      let key = this.key;
      let encrypted = this.encrypted;
      let model = this.model;
      if (change.key !== undefined) {
        const clean = cleanKey(change.key);
        if (!clean) throw new GeminiSettingsError("That doesn't look like a Google AI Studio key. Copy the whole key from aistudio.google.com/apikey.");
        if (!this.encryption()) throw new GeminiSettingsError("This Mac can't store the key encrypted, so Blackout won't save it.");
        key = clean;
        encrypted = this.options.secureStorage.encryptString(clean).toString("base64");
      }
      if (change.model !== undefined) {
        if (change.model.trim() === "") model = null;
        else {
          const clean = cleanModel(change.model);
          if (!clean) throw new GeminiSettingsError("That isn't a model name. Use one like gemini-flash-latest.");
          model = clean === this.options.defaultModel ? null : clean;
        }
      }
      const stored: Stored = { version: 1, ...(key && encrypted ? { encryptedKey: encrypted } : {}), ...(model ? { model } : {}) };
      await this.write(stored);
      this.key = key;
      this.encrypted = encrypted;
      this.model = model;
      this.problem = undefined;
      return this.snapshot();
    });
  }

  /** Forgets the key (and the model choice): nothing of them stays on disk. */
  clear(): Promise<GeminiStatus> {
    return this.serialized(async () => {
      await rm(this.path, { force: true });
      this.loaded = true;
      this.key = null;
      this.encrypted = null;
      this.model = null;
      this.problem = undefined;
      return this.snapshot();
    });
  }

  private async write(value: Stored): Promise<void> {
    await mkdir(this.options.directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(value), { encoding: "utf8", mode: 0o600, flag: "wx" });
      await rename(temporary, this.path);
    } finally {
      await rm(temporary, { force: true }).catch(() => {});
    }
  }
}
