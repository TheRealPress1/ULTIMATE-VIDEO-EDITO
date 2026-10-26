import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthoredTree } from "@diffusionstudio/reconciler";
import type { World } from "koota";
import type { CapturedNode, EntityEdit } from "./editor";

const mocks = vi.hoisted(() => ({
  editor: vi.fn(),
  flush: vi.fn(),
  render: vi.fn(),
  focus: vi.fn(),
  call: vi.fn(),
  session: vi.fn(),
}));
vi.mock("@/lib/ipc", () => ({
  mainBridge: { call: mocks.call, handle: vi.fn(() => () => {}) },
}));
vi.mock("@/dapi/session", () => ({ editorSession: mocks.session }));
vi.mock("@desktop/main-channels", () => ({
  MAIN_CHANNELS: {
    REFERENCE_GET: "get",
    REFERENCE_ANALYZE: "analyze",
    REFERENCE_CANCEL: "cancel",
    REFERENCE_PROGRESS: "progress",
    PROJECTS_VERSIONS: "versions",
    PROJECTS_VERSION_CREATE: "version-create",
  },
}));
vi.mock("mediabunny", () => ({
  ALL_FORMATS: [],
  BlobSource: class {},
  Input: class {
    async getPrimaryVideoTrack() {
      return { getFirstTimestamp: async () => 0 };
    }
    dispose() {}
  },
}));
vi.mock("./editor", () => ({
  getDocumentEditor: mocks.editor,
  isPendingSource: (source: string) => source.startsWith("pending#"),
}));
vi.mock("@/projects/edits", () => ({ flushProjectEdits: mocks.flush }));
vi.mock("@diffusionstudio/reconciler", () => ({
  renderAuthored: mocks.render,
  authoredElement: (entity: { tag: string; props: object }) => ({
    tag: entity.tag,
    props: entity.props,
  }),
  authoredTree: (_world: unknown, entity: FakeEntity) => {
    const capture = (node: FakeEntity): AuthoredTree => ({
      tag: node.tag,
      props: { ...node.props },
      children: node.children.filter((child) => child.alive).map(capture),
    });
    return capture(entity);
  },
}));
vi.mock("@diffusionstudio/runtime", () => ({
  Root: "root",
  Source: "source",
  Library: "library",
  FrameRate: "fps",
  focusRect: mocks.focus,
  getCameraMatrix: () => [1, 0, 0, 1, 0, 0],
  getNextName: () => "Transcript cut 1",
  getEntityChildren: (_world: unknown, entity: { children: FakeEntity[] }) =>
    entity.children.filter((child) => child.alive),
}));

import { applyReferenceStyle } from "./reference-style";
import { getEditHistory } from "./history";

interface FakeEntity {
  source: string;
  tag: string;
  props: Record<string, unknown>;
  alive: boolean;
  parent?: FakeEntity;
  children: FakeEntity[];
  get(trait: string): { value: string } | undefined;
  isAlive(): boolean;
}

const fingerprint = "a".repeat(64);
const profile = {
  sourceDuration: 30,
  analyzedDuration: 30,
  sourceStart: 0,
  width: 1080,
  height: 1920,
  sampleInterval: 0.25,
  cuts: [{ time: 2, score: 0.8 }],
  pacing: { medianShotSeconds: 15, cutsPerMinute: 2, shotCount: 2 },
  caption: null,
  palette: [],
  sampleTimes: [0, 2],
  limitations: [],
};
const result = {
  fingerprint,
  engine: "apple-reference-style-v1",
  analyzedAt: new Date().toISOString(),
  profile,
};

function fixture() {
  let id = 0;
  const all: FakeEntity[] = [];
  const listeners = new Set<(edit: EntityEdit) => void>();
  const renames = new Set<(ids: Record<string, string>) => void>();
  const emit = (edit: EntityEdit) =>
    listeners.forEach((listener) => listener(edit));
  const create = (
    tree: AuthoredTree,
    parent?: FakeEntity,
    source = `pending#${++id}`,
  ): FakeEntity => {
    const entity: FakeEntity = {
      source,
      tag: tree.tag,
      props: { ...tree.props },
      parent,
      alive: true,
      children: [],
      get: (trait) =>
        trait === "source" ? { value: entity.source } : undefined,
      isAlive: () => entity.alive,
    };
    all.push(entity);
    parent?.children.push(entity);
    for (const child of tree.children) create(child, entity);
    return entity;
  };
  const root = create(
    { tag: "stage", props: {}, children: [] },
    undefined,
    "project.tsx:1",
  );
  const original = create(
    {
      tag: "scene",
      props: { name: "Original", x: 0, y: 0, width: 1920, height: 1080 },
      children: [],
    },
    root,
    "project.tsx:2",
  );
  const asset = {
    id: "video",
    path: "Interview.mp4",
    source: "/media/Interview.mp4",
    type: "VIDEO",
    duration: 30,
    width: 1920,
    height: 1080,
    handle: { getFile: async () => new Blob(["fixture"]) },
  };
  const stat = { size: 100, mtime: 123 };
  const clip = create(
    {
      tag: "video",
      props: { src: asset.path, width: 1920, height: 1080, start: 0, end: 30 },
      children: [],
    },
    original,
    "project.tsx:clip",
  );
  const library = {
    resolve: vi.fn(async () => asset),
    fs: { stat: vi.fn(async () => ({ ...stat })) },
    get: vi.fn((key: string) =>
      key === asset.id || key === asset.path ? asset : undefined,
    ),
    bySource: vi.fn(() => undefined),
    store: vi.fn().mockResolvedValue({ path: "Transcript cut captions.json" }),
    flush: vi.fn().mockResolvedValue(undefined),
  };
  const world = {
    get: vi.fn(
      (trait: string) => ({ root, library, fps: { value: 30 } })[trait],
    ),
    query: () => all.filter((entity) => entity.alive),
  } as unknown as World;
  const capture = (entity: FakeEntity): CapturedNode => ({
    source: entity.source,
    tag: entity.tag,
    props: { ...entity.props },
    children: entity.children.filter((child) => child.alive).map(capture),
  });
  const destroy = (entity: FakeEntity) => {
    entity.alive = false;
    entity.children.forEach(destroy);
  };
  const editor = {
    onEdit: (listener: (edit: EntityEdit) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onRename: (listener: (ids: Record<string, string>) => void) => {
      renames.add(listener);
      return () => renames.delete(listener);
    },
    insertElement: vi.fn((parent: FakeEntity, render: () => unknown) => {
      const previous = all.length;
      const entity = create(render() as AuthoredTree, parent);
      for (const next of all.slice(previous)) {
        emit({
          kind: "insert",
          source: next.source,
          parent: next.parent!.source,
          tag: next.tag,
          props: next.props as never,
        });
      }
      return [entity];
    }),
    remove: vi.fn((entity: FakeEntity) => {
      const node = capture(entity);
      destroy(entity);
      emit({
        kind: "remove",
        source: entity.source,
        parent: entity.parent?.source,
        node,
      });
      return [entity];
    }),
    discardPending: vi.fn((source: string) => {
      const entity = all.find((item) => item.source === source);
      if (entity) destroy(entity);
    }),
    activate: vi.fn(),
    select: vi.fn(),
    reportEdit: vi.fn(),
  };
  mocks.editor.mockReturnValue(editor);
  mocks.session.mockReturnValue({ world, project: { dir: () => "/project" } });
  mocks.flush.mockImplementation(async () => {
    const map: Record<string, string> = {};
    for (const entity of all) {
      if (entity.alive && entity.source.startsWith("pending#")) {
        const source = `project.tsx:${100 + all.indexOf(entity)}`;
        map[entity.source] = source;
        entity.source = source;
      }
    }
    renames.forEach((listener) => listener(map));
  });
  return {
    world,
    root,
    original,
    asset,
    stat,
    clip,
    library,
    editor,
    all,
    create,
    live: () => all.filter((entity) => entity.alive),
    emit,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.render.mockImplementation((tree) => tree);
  mocks.call.mockImplementation(async (channel) =>
    channel === "get"
      ? result
      : channel === "versions"
        ? { fingerprint: "project-sha" }
        : {},
  );
});
const apply = (f: ReturnType<typeof fixture>, options = {}) =>
  applyReferenceStyle(
    f.world,
    "/project",
    f.original as never,
    f.asset.path,
    fingerprint,
    options,
  );
describe("reference scene transaction", () => {
  it("creates a recovery point then a new editable scene in one undo step", async () => {
    const f = fixture(),
      original = JSON.stringify(f.original.props),
      history = getEditHistory(f.world);
    const value = await apply(f);
    expect(value).toMatchObject({
      width: 1080,
      height: 1920,
      captionLayers: 0,
    });
    expect(value.sceneId).toMatch(/^project.tsx:/);
    expect(mocks.call).toHaveBeenCalledWith("version-create", {
      dir: "/project",
      label: "Before reference style · Original",
      expectedFingerprint: "project-sha",
    });
    const version = f
      .live()
      .find((e) => e.tag === "scene" && e !== f.original)!;
    expect(version.props).toMatchObject({ x: 2040, width: 1080, height: 1920 });
    history.undo();
    expect(f.live()).toEqual([f.root, f.original, f.clip]);
    expect(history.canUndo()).toBe(false);
    history.redo();
    expect(f.live().filter((e) => e.tag === "scene")).toHaveLength(2);
    expect(JSON.stringify(f.original.props)).toBe(original);
  });
  it("rejects a stale reference fingerprint before insertion", async () => {
    const f = fixture();
    mocks.call.mockResolvedValue({ ...result, fingerprint: "b".repeat(64) });
    await expect(apply(f)).rejects.toThrow("stale");
    expect(f.editor.insertElement).not.toHaveBeenCalled();
  });
  it("rechecks the reference after creating recovery metadata", async () => {
    const f = fixture();
    mocks.call
      .mockImplementation(async (channel) =>
        channel === "get"
          ? result
          : channel === "versions"
            ? { fingerprint: "project-sha" }
            : {},
      )
      .mockResolvedValueOnce(result)
      .mockResolvedValueOnce({ fingerprint: "project-sha" })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ ...result, fingerprint: "b".repeat(64) });
    await expect(apply(f)).rejects.toThrow("reference changed");
    expect(f.editor.insertElement).not.toHaveBeenCalled();
  });
  it("cancellation or project changes during preparation preserve the original scene", async () => {
    const f = fixture(),
      controller = new AbortController();
    mocks.call.mockImplementation(async () => {
      controller.abort();
      return result;
    });
    await expect(apply(f, { signal: controller.signal })).rejects.toThrow();
    expect(f.editor.insertElement).not.toHaveBeenCalled();
    expect(f.live()).toEqual([f.root, f.original, f.clip]);
  });
  it("rejects edits to the target scene during preparation", async () => {
    const f = fixture();
    mocks.call.mockImplementation(async () => {
      f.clip.props.end = 10;
      return result;
    });
    await expect(apply(f)).rejects.toThrow("scene changed");
    expect(f.editor.insertElement).not.toHaveBeenCalled();
  });
  it("rolls back a partially rendered copy without removing original entities", async () => {
    const f = fixture();
    f.editor.insertElement.mockImplementationOnce((parent, render) => {
      f.create(render() as AuthoredTree, parent);
      throw new Error("Render failed");
    });
    await expect(apply(f)).rejects.toThrow("Render failed");
    expect(f.live()).toEqual([f.root, f.original, f.clip]);
  });
  it("reports created-but-unsaved recovery without silently making another copy", async () => {
    const f = fixture();
    mocks.flush
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("Disk full"));
    await expect(apply(f)).rejects.toThrow("created but saving failed");
    expect(f.live().filter((e) => e.tag === "scene")).toHaveLength(2);
  });
  it("reports cancellation during final save as already created", async () => {
    const f = fixture(),
      controller = new AbortController();
    mocks.flush
      .mockResolvedValueOnce(undefined)
      .mockImplementationOnce(async () => controller.abort());
    await expect(apply(f, { signal: controller.signal })).rejects.toThrow(
      "created and saved",
    );
    expect(f.live().filter((e) => e.tag === "scene")).toHaveLength(2);
  });
});


it('preserves an existing animated crop when matching the same frame size', async () => {
  const f = fixture();
  Object.assign(f.original.props, { width: 1080, height: 1920 });
  Object.assign(f.clip.props, { x: -500, width: 3413, height: 1920 });
  f.create({ tag: 'keyframeTrack', props: { property: 'x' }, children: [{ tag: 'keyframe', props: { time: 0, value: -500 }, children: [] }] }, f.clip);
  await apply(f);
  const copy = f.root.children.find((entity) => entity !== f.original && entity.alive)!;
  expect(copy.children[0]!.props.x).toBe(-500);
  expect(copy.children[0]!.children[0]!.props.property).toBe('x');
  expect(f.original.props.width).toBe(1080);
});

it('supports captions-only matching on a scene with a custom crop', async () => {
  const f = fixture(); Object.assign(f.clip.props, { x: -200, width: 2200 });
  await apply(f, { matchFormat: false });
  const copy = f.root.children.find((entity) => entity !== f.original && entity.alive)!;
  expect(copy.props.width).toBe(f.original.props.width);
  expect(copy.children[0]!.props.x).toBe(-200);
});

it('rejects cross-scene sync links even without resizing', async () => {
  const f = fixture(); f.clip.props.syncTo = 'original-clip';
  await expect(apply(f, { matchFormat: false })).rejects.toThrow('sync links');
  expect(f.editor.insertElement).not.toHaveBeenCalled();
});
