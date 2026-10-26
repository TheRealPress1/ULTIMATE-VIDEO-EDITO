import { randomUUID } from 'node:crypto';
import { mkdir, open, rename, unlink, type FileHandle } from 'node:fs/promises';
import { dirname } from 'node:path';
import { tempPathFor } from './atomic';
import { validateExportFinalization } from './export-finalization';
import type { ExportFinalization } from './export-finalization-types';

type Entry = {
  handle: FileHandle;
  path: string;
  temp: string;
  reserved: boolean;
  tail: Promise<void>;
  failure?: unknown;
  finalization?: ExportFinalization;
  controller: AbortController;
};

type FileWriteHooks = {
  noteContent?: (path: string, content: string | null) => void;
  beforeRename?: (temp: string, path: string) => Promise<void>;
  finalize?: (temp: string, config: ExportFinalization, signal: AbortSignal) => Promise<void>;
};

/** One serialized lifecycle per output, including renderer-crash cleanup. */
export class AtomicFileWrites {
  private readonly entries = new Map<string, Entry>();
  private readonly opening = new Set<Promise<{ id: string }>>();
  private readonly hooks: FileWriteHooks;

  constructor(hooks: FileWriteHooks = {}) { this.hooks = hooks; }

  get size(): number { return this.entries.size + this.opening.size; }

  open(path: string, exclusive = false, finalization?: ExportFinalization): Promise<{ id: string }> {
    if (finalization) { validateExportFinalization(finalization); if (!this.hooks.finalize) return Promise.reject(new Error('Portable AAC export is unavailable in this build.')); }
    const operation = this.create(path, exclusive, finalization).finally(() => this.opening.delete(operation));
    this.opening.add(operation);
    return operation;
  }

  private async create(path: string, exclusive: boolean, finalization?: ExportFinalization): Promise<{ id: string }> {
    await mkdir(dirname(path), { recursive: true });
    let reserved = false;
    const temp = tempPathFor(path);
    try {
      if (exclusive) {
        this.hooks.noteContent?.(path, '');
        const reservation = await open(path, 'wx');
        reserved = true;
        await reservation.close();
      }
      const handle = await open(temp, 'wx');
      const id = randomUUID();
      this.entries.set(id, { handle, path, temp, reserved, tail: Promise.resolve(), finalization, controller: new AbortController() });
      return { id };
    } catch (error) {
      if (reserved) await unlink(path).catch(() => {});
      throw error;
    }
  }

  private enqueue(id: string, operation: (entry: Entry) => Promise<void>, missingIsError = false): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry) return missingIsError ? Promise.reject(new Error(`No open file for write id ${id}`)) : Promise.resolve();
    const next = entry.tail.then(async () => {
      // A preceding close/abort can finish while this operation is queued.
      if (this.entries.get(id) !== entry) {
        if (missingIsError) throw new Error(`No open file for write id ${id}`);
        return;
      }
      await operation(entry);
    });
    entry.tail = next.catch(() => {});
    return next;
  }

  write(id: string, data: Uint8Array, position: number): Promise<void> {
    return this.enqueue(id, async (entry) => {
      if (entry.failure) throw entry.failure;
      try {
        let offset = 0;
        while (offset < data.byteLength) {
          const { bytesWritten } = await entry.handle.write(data, offset, data.byteLength - offset, position + offset);
          if (!bytesWritten) throw new Error('The disk stopped accepting output bytes.');
          offset += bytesWritten;
        }
      } catch (error) { entry.failure = error; throw error; }
    }, true);
  }

  close(id: string): Promise<void> {
    return this.enqueue(id, async (entry) => {
      if (entry.failure) throw entry.failure;
      try {
        await entry.handle.sync();
        await entry.handle.close();
        if (entry.finalization) await this.hooks.finalize!(entry.temp,entry.finalization,entry.controller.signal);
        if (entry.finalization) entry.controller.signal.throwIfAborted();
        await this.hooks.beforeRename?.(entry.temp, entry.path);
        if (entry.finalization) entry.controller.signal.throwIfAborted();
        await rename(entry.temp, entry.path);
        // Commit is terminal. Queued abort/crash cleanup must not remove it.
        this.entries.delete(id);
      } catch (error) {
        entry.failure = error;
        await entry.handle.close().catch(() => {});
        throw error;
      }
    });
  }

  abort(id: string): Promise<void> {
    // A close may be awaiting the native encoder. Cancel it before joining its queue.
    const active=this.entries.get(id);
    if(active?.finalization)active.controller.abort(new Error('Export canceled.'));
    return this.enqueue(id, async (entry) => {
      await entry.handle.close().catch(() => {});
      await unlink(entry.temp).catch(() => {});
      if (entry.reserved) {
        this.hooks.noteContent?.(entry.path, null);
        await unlink(entry.path).catch(() => {});
      }
      this.entries.delete(id);
    });
  }

  async abortAll(): Promise<void> {
    // Include IPC opens that were creating their temp file when the renderer died.
    await Promise.allSettled([...this.opening]);
    await Promise.all([...this.entries.keys()].map((id) => this.abort(id)));
  }
}
