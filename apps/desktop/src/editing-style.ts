import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { DapiError, toolByName } from "@diffusionstudio/dapi";
import type { EditingStyle } from "@diffusionstudio/dapi";

/** One app-owned record; serialized optimistic writes protect simultaneous settings/chat changes. */
export class EditingStyleStore {
  private pending: Promise<unknown> = Promise.resolve();
  private readonly path: string;
  constructor(path: string) { this.path = path; }

  async get(): Promise<EditingStyle> {
    try {
      const text = await readFile(this.path, "utf8");
      return toolByName("editing_style").output.parse(JSON.parse(text));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, revision: 0, notes: "", updatedAt: null };
      throw new Error("Your saved editing style could not be read. It has not been changed.", { cause: error });
    }
  }

  set(notes: string, expectedRevision: number): Promise<EditingStyle> {
    const work = this.pending.then(async () => {
      const parsed = toolByName("editing_style").input.parse({ action: "set", notes, expectedRevision });
      if (parsed.notes === undefined || parsed.expectedRevision === undefined) throw new DapiError("invalid-input", "Saving editing style requires notes and an expected revision.");
      const current = await this.get();
      if (current.revision !== parsed.expectedRevision) {
        throw new DapiError("busy", "Your editing style changed elsewhere. Reload it and review the latest preferences before saving again.");
      }
      if (current.notes === notes) return current;
      const next: EditingStyle = { version: 1, revision: current.revision + 1, notes, updatedAt: new Date().toISOString() };
      await mkdir(dirname(this.path), { recursive: true });
      const temp = `${this.path}.${randomUUID()}.tmp`;
      try {
        const file = await open(temp, "wx", 0o600);
        try {
          await file.writeFile(JSON.stringify(next, null, 2) + "\n");
          await file.sync();
        } finally { await file.close(); }
        await rename(temp, this.path);
        if (process.platform !== "win32") {
          const folder = await open(dirname(this.path), "r");
          try { await folder.sync(); } finally { await folder.close(); }
        }
      } finally { await unlink(temp).catch(() => {}); }
      return next;
    });
    this.pending = work.catch(() => {});
    return work;
  }
}
