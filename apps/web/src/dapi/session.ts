/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The tool handlers register once for the app's lifetime (see ./api); what
// changes as projects open and close is this slot. The editor publishes its
// world and project here while it is mounted, and project-bound handlers read
// the slot per request instead of closing over a world at registration time.

import { createSignal, untrack } from "solid-js";
import { DapiError } from "@diffusionstudio/dapi";

import type { Accessor } from "solid-js";
import type { World } from "koota";
import type { Engine } from "@/engine";

/**
 * The open project, as the editor knows it. Structural on purpose: this is
 * the slice of the project context the handlers read, without depending on
 * the Solid context it comes from.
 */
export type OpenProject = {
  dir: () => string;
};

/** What only an open project can offer: the world drawing it, the engine running it, and which project that is. */
export type EditorSession = { world: World; project: OpenProject; engine: Engine };

const [session, setSession] = createSignal<EditorSession | null>(null);
type LoadState = { state: 'loading' | 'ready' | 'error'; error?: Error };
const loads = new WeakMap<World, LoadState>();
const listeners = new Set<() => void>();
const changed = () => { for (const listener of [...listeners]) listener(); };

/** The open project's session; null at the dashboard (and between projects). */
export const editorSession: Accessor<EditorSession | null> = session;

/** Set by the editor while a project is open; cleared on its way out. */
export function setEditorSession(next: EditorSession | null): void {
  setSession(next);
  changed();
}

/** A generation belongs to one compile/mount; stale completions cannot mark a new load ready. */
export function beginEditorLoad(world: World): { ready(): void; fail(error: unknown): void } {
  const load: LoadState = { state: 'loading' };
  loads.set(world, load);
  changed();
  return {
    ready() {
      if (loads.get(world) !== load) return;
      load.state = 'ready';
      changed();
    },
    fail(error) {
      if (loads.get(world) !== load) return;
      load.state = 'error';
      load.error = error instanceof Error ? error : new Error(String(error));
      changed();
    },
  };
}

/**
 * Opening a route is not opening its asynchronously compiled editor. Wait for
 * that specific session's initial mount, without waiting for media decoding or
 * background analysis: missing media must remain openable for repair.
 */
export function waitForEditorSession(dir: string, signal: AbortSignal, timeoutMs = 30_000): Promise<EditorSession> {
  if (signal.aborted) return Promise.reject(new DapiError('canceled', 'Opening the project was canceled.'));
  return new Promise((resolve, reject) => {
    let targetSeen = false;
    let settled = false;
    const finish = (value: EditorSession | Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      listeners.delete(check);
      signal.removeEventListener('abort', onAbort);
      if (value instanceof Error) reject(value);
      else resolve(value);
    };
    const onAbort = () => finish(new DapiError('canceled', 'Opening the project was canceled.'));
    const check = () => {
      const current = untrack(session);
      if (!current || untrack(current.project.dir) !== dir) {
        if (targetSeen) finish(new DapiError('canceled', 'The project changed before it finished opening.'));
        return;
      }
      targetSeen = true;
      const load = loads.get(current.world);
      if (load?.state === 'error') finish(load.error!);
      else if (load?.state === 'ready') finish(current);
    };
    const timer = setTimeout(() => finish(new Error(`The project did not finish opening within ${Math.round(timeoutMs / 1000)} seconds. Check its load errors and try again.`)), timeoutMs);
    listeners.add(check);
    signal.addEventListener('abort', onAbort, { once: true });
    check();
  });
}

/** The session, or the failure a caller can act on. */
export function requireEditorSession(): EditorSession {
  const current = session();
  if (!current) throw new DapiError("no-project", "No project open — open one first (`dapi open <dir>`).");
  return current;
}
