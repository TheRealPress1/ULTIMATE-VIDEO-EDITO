import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { transformSync } from "esbuild";
import { describe, expect, it, vi } from "vitest";

// Execute the real component's event handlers with plain JSX nodes. These tests
// cover async orchestration, not DOM rendering or Solid's rendering engine.
const compiled = transformSync(
  readFileSync(
    fileURLToPath(new URL("./reference-style-dialog.tsx", import.meta.url)),
    "utf8",
  ),
  {
    loader: "tsx",
    format: "cjs",
    jsx: "transform",
    jsxFactory: "view",
    jsxFragment: "fragment",
  },
).code;
type Node = {
  type: unknown;
  props: Record<string, unknown>;
  children: unknown[];
};
type AnalysisOptions = { signal: AbortSignal; assertCurrent: () => void };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}
const profile = {
  fingerprint: "a".repeat(64),
  engine: "test",
  analyzedAt: "2026-10-25",
  profile: {
    width: 1080,
    height: 1920,
    sourceDuration: 8,
    analyzedDuration: 8,
    sampleTimes: [0, 2, 4, 6],
    cuts: [{ time: 2, score: 0.8 }],
    pacing: { medianShotSeconds: 2 },
    caption: null,
    palette: [],
  },
};
function harness() {
  const nodes: Node[] = [],
    changes: unknown[] = [],
    cleanups: Array<() => void> = [];
  let source = "project.tsx:scene",
    alive = true,
    dir = "/project",
    show!: () => void;
  const scene = {
    isAlive: () => alive,
    get: (trait: string) => ({
      value: trait === "source" ? source : "Interview",
    }),
  };
  const analyze = vi.fn(
      async (
        _world: unknown,
        _dir: string,
        _path: string,
        _options: AnalysisOptions,
      ) => profile,
    ),
    flush = vi.fn(async (_dir: string) => {}),
    send = vi.fn(
      async (_options: { text: string; beforeDispatch: () => void }) => "chat",
    );
  const library = {
    assets: () => [
      {
        type: "VIDEO",
        path: "reference.mp4",
        handle: { getFile: async () => new Blob() },
      },
    ],
  };
  const view = (
    type: unknown,
    props: Record<string, unknown> | null,
    ...children: unknown[]
  ) => {
    const node = { type, props: props ?? {}, children };
    nodes.push(node);
    return node;
  };
  const deps: Record<string, unknown> = {
    "solid-js": {
      createSignal: (initial: unknown) => {
        let value = initial;
        return [
          () => value,
          (next: unknown) => {
            value = next;
            changes.push(next);
          },
        ];
      },
      createMemo: (fn: () => unknown) => fn,
      createEffect: () => {},
      onCleanup: (fn: () => void) => cleanups.push(fn),
      For: "For",
      Show: "Show",
    },
    "@diffusionstudio/koota-solid": { useWorld: () => ({}) },
    "@diffusionstudio/runtime": {
      getActiveEntity: () => scene,
      Name: "name",
      Source: "source",
    },
    "@/context/project": {
      useProject: () => ({ dir: () => dir, id: () => "project" }),
    },
    "@/engine/library": { useLibrary: () => () => library },
    "@/engine/asset-actions": { importFiles: vi.fn(), pickFiles: vi.fn() },
    "@/engine/reference-style": {
      analyzeReferenceStyle: analyze,
      applyReferenceStyle: vi.fn(),
    },
    "@/projects/edits": { flushProjectEdits: flush },
    "@/agent-chat/store": {
      chatState: { lists: {} },
      currentModel: () => ({ harness: "claude", model: "fixture" }),
      modelLabel: () => "Fixture",
      send,
      setSidebarTab: vi.fn(),
    },
    "./ui/button": { Button: "Button" },
    "./ui/dialog": Object.fromEntries(
      [
        "Dialog",
        "DialogContent",
        "DialogDescription",
        "DialogHeader",
        "DialogPortal",
        "DialogTitle",
      ].map((k) => [k, k]),
    ),
  };
  const module = {
    exports: {} as {
      ReferenceStyleDialog: (props: {
        triggerRef: (show: () => void) => void;
      }) => unknown;
    },
  };
  new Function("require", "module", "exports", "view", "fragment", compiled)(
    (name: string) => {
      if (!(name in deps)) throw new Error(`Unexpected dependency ${name}`);
      return deps[name];
    },
    module,
    module.exports,
    view,
    "fragment",
  );
  module.exports.ReferenceStyleDialog({ triggerRef: (fn) => (show = fn) });
  show();
  const click = (label: string) => {
    const button = nodes.find(
      (node) => node.type === "Button" && node.children.includes(label),
    );
    if (!button) throw new Error(`Missing button ${label}`);
    (button.props.onClick as () => void)();
  };
  return {
    analyze,
    flush,
    send,
    click,
    changes,
    dispose: () => cleanups.forEach((fn) => fn()),
    setSource: (value: string) => (source = value),
    navigate: () => {
      dir = "/other";
    },
    killScene: () => {
      alive = false;
    },
  };
}
describe("reference dialog handoff", () => {
  it("aborts native analysis and never saves or sends a late successful result after Cancel", async () => {
    const h = harness(),
      pending = deferred<typeof profile>();
    h.analyze.mockReturnValueOnce(pending.promise);
    h.click("Edit like this");
    expect(h.analyze).toHaveBeenCalledOnce();
    h.click("Cancel");
    expect(h.analyze.mock.calls[0]![3].signal.aborted).toBe(true);
    pending.resolve(profile);
    await vi.waitFor(() =>
      expect(h.changes).toContain("Reference analysis canceled."),
    );
    expect(h.flush).not.toHaveBeenCalled();
    expect(h.send).not.toHaveBeenCalled();
  });
  it("does not hand off a late native result after the dialog is unmounted", async () => {
    const h = harness(),
      pending = deferred<typeof profile>();
    h.analyze.mockReturnValueOnce(pending.promise);
    h.click("Edit like this");
    h.dispose();
    pending.resolve(profile);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.analyze.mock.calls[0]![3].signal.aborted).toBe(true);
    expect(h.send).not.toHaveBeenCalled();
    expect(h.flush).not.toHaveBeenCalled();
  });
  it("waits for the pre-handoff save before reading the new stable scene identifier", async () => {
    const h = harness(),
      saving = deferred<void>();
    h.setSource("pending#scene");
    h.flush.mockReturnValueOnce(saving.promise);
    h.click("Edit like this");
    await vi.waitFor(() => expect(h.flush).toHaveBeenCalledOnce());
    expect(h.send).not.toHaveBeenCalled();
    h.setSource("project.tsx:saved-scene");
    saving.resolve();
    await vi.waitFor(() => expect(h.send).toHaveBeenCalledOnce());
    expect(h.send.mock.calls[0]![0].text).toContain("project.tsx:saved-scene");
    expect(h.send.mock.calls[0]![0].text).not.toContain("pending#");
  });
  it("the final dispatch guard rejects cancellation while send is waiting on connection or saving", async () => {
    const h = harness(),
      accepted = deferred<string>();
    h.send.mockReturnValueOnce(accepted.promise);
    h.click("Edit like this");
    await vi.waitFor(() => expect(h.send).toHaveBeenCalledOnce());
    h.click("Cancel");
    expect(() => h.send.mock.calls[0]![0].beforeDispatch()).toThrow();
    accepted.resolve("chat");
  });
  it("the final dispatch guard rejects navigation and scene identity changes", async () => {
    for (const change of ["navigate", "rename"] as const) {
      const h = harness(),
        accepted = deferred<string>();
      h.send.mockReturnValueOnce(accepted.promise);
      h.click("Edit like this");
      await vi.waitFor(() => expect(h.send).toHaveBeenCalledOnce());
      if (change === "navigate") h.navigate();
      else h.setSource("project.tsx:other");
      expect(() => h.send.mock.calls[0]![0].beforeDispatch()).toThrow();
      accepted.resolve("chat");
    }
  });
});
