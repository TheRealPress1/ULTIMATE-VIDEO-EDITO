/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
import { randomUUID } from 'node:crypto';

/** A close request only succeeds when its own renderer confirms the save barrier. */
export class SaveGate {
  private pending = new Map<string, { sender: number; resolve(): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  request(sender: number, send: (id: string) => void, timeout = 30_000): Promise<void> {
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('The editor did not confirm its save. Keep the app open and retry when it responds.'));
      }, timeout);
      this.pending.set(id, { sender, resolve, reject, timer });
      try { send(id); }
      catch (error) { this.answer(sender, id, error instanceof Error ? error.message : String(error)); }
    });
  }
  answer(sender: number, id: string, error?: string): void {
    const item = this.pending.get(id);
    if (!item || item.sender !== sender) return;
    clearTimeout(item.timer);
    this.pending.delete(id);
    if (error) item.reject(new Error(error)); else item.resolve();
  }
}
