import { ALL_FORMATS, BlobSource, Input } from "mediabunny";
import {
  authoredElement,
  authoredTree,
  renderAuthored,
} from "@diffusionstudio/reconciler";
import {
  FrameRate,
  Library,
  Root,
  Source,
  focusRect,
  getCameraMatrix,
  getEntityChildren,
} from "@diffusionstudio/runtime";
import { MAIN_CHANNELS } from "@desktop/main-channels";
import { mainBridge } from "@/lib/ipc";
import { flushProjectEdits } from "@/projects/edits";
import { editorSession } from "@/dapi/session";
import { getDocumentEditor, isPendingSource } from "./editor";
import { getEditHistory } from "./history";
import {
  cloneReframeTree,
  collectReframeVideos,
  videoSource,
} from "./reframe-plan";
import { planReferenceStyle } from "./reference-plan";
import type { World, Entity } from "koota";
import type { VideoAsset } from "@diffusionstudio/assets";
import type { AuthoredTree } from "@diffusionstudio/reconciler";
import type {
  ReferenceResult,
  ReferenceProgress,
} from "@desktop/reference-types";
import type { ReferenceApplyOptions } from "./reference-plan";
export type {
  ReferenceResult,
  ReferenceProgress,
} from "@desktop/reference-types";
export interface ReferenceOptions {
  signal?: AbortSignal;
  onProgress?: (progress: ReferenceProgress) => void;
  assertCurrent?: () => void;
}
export interface ReferenceApplyResult {
  sceneId: string;
  name: string;
  width: number;
  height: number;
  captionLayers: number;
  changes: string[];
  warnings: string[];
}
const listeners = new Map<string, (p: ReferenceProgress) => void>();
let unsubscribe: (() => void) | undefined;
function progress(id: string, callback: (p: ReferenceProgress) => void) {
  listeners.set(id, callback);
  unsubscribe ??= mainBridge.handle(MAIN_CHANNELS.REFERENCE_PROGRESS, (p) =>
    listeners.get(p.id)?.(p),
  );
  return () => {
    listeners.delete(id);
    if (!listeners.size) {
      unsubscribe?.();
      unsubscribe = undefined;
    }
  };
}
const signature = (tree: AuthoredTree) =>
  JSON.stringify(cloneReframeTree(tree), (_key, value: unknown) =>
    typeof value === "number" && !Number.isFinite(value)
      ? String(value)
      : value,
  );
function assertProject(world: World, dir: string, options: ReferenceOptions) {
  options.signal?.throwIfAborted();
  options.assertCurrent?.();
  const session = editorSession();
  if (!session || session.world !== world || session.project.dir() !== dir)
    throw new Error(
      "The open project changed. Return to the intended project.",
    );
}
async function requestFor(
  world: World,
  dir: string,
  path: string,
  options: ReferenceOptions,
) {
  assertProject(world, dir, options);
  const library = world.get(Library);
  if (!library) throw new Error("Open a local project first.");
  const asset = library.get(path) ?? library.bySource(path);
  if (!asset || asset.type !== "VIDEO")
    throw new Error("Import the reference video into this project first.");
  const saved = { ...asset };
  const stat = await library.fs.stat(saved.source);
  assertProject(world, dir, options);
  if (
    !stat ||
    stat.size <= 0 ||
    (saved.stat &&
      (stat.size !== saved.stat.size ||
        Math.floor(stat.mtime) !== Math.floor(saved.stat.mtime)))
  )
    throw new Error(
      "The reference changed on disk. Refresh the asset library.",
    );
  const input = new Input({
    formats: ALL_FORMATS,
    source: new BlobSource(await saved.handle.getFile()),
  });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error("The reference has no video track.");
    const sourceStart = Math.max(0, await track.getFirstTimestamp());
    assertProject(world, dir, options);
    return {
      request: {
        dir,
        source: saved.source,
        duration: saved.duration,
        sourceStart,
      },
      current: () => {
        assertProject(world, dir, options);
        const a = library.get(saved.id);
        if (
          world.get(Library) !== library ||
          !a ||
          a.source !== saved.source ||
          a.path !== saved.path ||
          a.type !== "VIDEO" ||
          a.duration !== saved.duration
        )
          throw new Error(
            "The reference was moved or changed. Analyze the current reference.",
          );
      },
    };
  } finally {
    input.dispose();
  }
}
export async function getCachedReferenceStyle(
  world: World,
  dir: string,
  path: string,
  options: ReferenceOptions = {},
): Promise<ReferenceResult> {
  const { request, current } = await requestFor(world, dir, path, options);
  const result = await mainBridge.call(MAIN_CHANNELS.REFERENCE_GET, request);
  current();
  return result;
}
export async function analyzeReferenceStyle(
  world: World,
  dir: string,
  path: string,
  options: ReferenceOptions = {},
): Promise<ReferenceResult> {
  const { request, current } = await requestFor(world, dir, path, options);
  const id = crypto.randomUUID();
  const stop = progress(id, (p) => {
    if (!options.signal?.aborted) options.onProgress?.(p);
  });
  const cancel = () => {
    void mainBridge
      .call(MAIN_CHANNELS.REFERENCE_CANCEL, { id })
      .catch(() => {});
  };
  options.signal?.addEventListener("abort", cancel, { once: true });
  try {
    current();
    const result = await mainBridge.call(MAIN_CHANNELS.REFERENCE_ANALYZE, {
      ...request,
      id,
    });
    current();
    return result;
  } finally {
    options.signal?.removeEventListener("abort", cancel);
    stop();
  }
}
export async function applyReferenceStyle(
  world: World,
  dir: string,
  scene: Entity,
  path: string,
  fingerprint: string,
  options: ReferenceOptions & ReferenceApplyOptions = {},
): Promise<ReferenceApplyResult> {
  assertProject(world, dir, options);
  const root = world.get(Root),
    library = world.get(Library),
    original = authoredTree(world, scene),
    fps = world.get(FrameRate)?.value ?? 30;
  if (
    !root?.isAlive() ||
    !root.get(Source)?.value ||
    !library ||
    !original ||
    original.tag !== "scene"
  )
    throw new Error("Select a saved scene to match the reference.");
  const tree = cloneReframeTree(original),
    beforeSignature = signature(tree);
  const current = () => {
    assertProject(world, dir, options);
    if (
      !root.isAlive() ||
      world.get(Root) !== root ||
      world.get(Library) !== library ||
      !scene.isAlive() ||
      (world.get(FrameRate)?.value ?? 30) !== fps ||
      !authoredTree(world, scene) ||
      signature(authoredTree(world, scene)!) !== beforeSignature
    )
      throw new Error(
        "The scene changed while applying the reference. Try again with the current scene.",
      );
  };
  current();
  await flushProjectEdits(dir);
  current();
  const reference = await getCachedReferenceStyle(world, dir, path, {
    ...options,
    assertCurrent: current,
  });
  current();
  if (!reference.profile || reference.fingerprint !== fingerprint)
    throw new Error(
      "This reference profile is stale. Analyze the reference again.",
    );
  const paths = new Set<string>();
  const gather = (node: AuthoredTree) => {
    if (node.props.syncTo !== undefined) throw new Error('This scene uses audio sync links. Bake their start times before creating a reference version.');
    const p = videoSource(node);
    if (p) paths.add(p);
    node.children.forEach(gather);
  };
  gather(tree);
  const assets = new Map<string, VideoAsset>(),
    stats = new Map<string, { size: number; mtime: number }>();
  for (const p of paths) {
    const asset = await library.resolve(p);
    current();
    if (asset.type !== "VIDEO") throw new Error(`${p} is not a video.`);
    const stat = await library.fs.stat(asset.source);
    current();
    if (
      !stat ||
      stat.size <= 0 ||
      (asset.stat &&
        (stat.size !== asset.stat.size ||
          Math.floor(stat.mtime) !== Math.floor(asset.stat.mtime)))
    )
      throw new Error(`${p} changed. Refresh the footage.`);
    assets.set(p, { ...asset });
    stats.set(p, stat);
  }
  // Existing crops and motion remain valid when the canvas does not change.
  // Validate full-frame geometry only for the operation that actually needs it.
  const layout = planReferenceStyle(tree, [], reference.profile, fps, options);
  const resized = layout.width !== (tree.props.width ?? 1920) || layout.height !== (tree.props.height ?? 1080);
  const videos = resized ? collectReframeVideos(tree, (p) => assets.get(p)) : [];
  const plan = resized ? planReferenceStyle(tree, videos, reference.profile, fps, options) : layout;
  const listing = await mainBridge.call(MAIN_CHANNELS.PROJECTS_VERSIONS, {
    dir,
  });
  current();
  await mainBridge.call(MAIN_CHANNELS.PROJECTS_VERSION_CREATE, {
    dir,
    label:
      `Before reference style · ${String(tree.props.name || "Scene")}`.slice(
        0,
        120,
      ),
    expectedFingerprint: listing.fingerprint,
  });
  current();
  const finalReference = await getCachedReferenceStyle(world, dir, path, {
    ...options,
    assertCurrent: current,
  });
  current();
  if (finalReference.fingerprint !== fingerprint)
    throw new Error(
      "The reference changed while applying its layout. Analyze it again.",
    );
  for (const [p, a] of assets) {
    const now = await library.resolve(p);
    current();
    const st = await library.fs.stat(a.source);
    current();
    const before = stats.get(p)!;
    if (
      now.id !== a.id ||
      now.source !== a.source ||
      !st ||
      st.size !== before.size ||
      st.mtime !== before.mtime
    )
      throw new Error(`${p} changed while preparing the layout.`);
  }
  const edges = getEntityChildren(world, root).flatMap((e) => {
    const a = authoredElement(e);
    return a?.tag === "scene" &&
      typeof a.props.x === "number" &&
      typeof a.props.width === "number"
      ? [a.props.x + a.props.width]
      : [];
  });
  Object.assign(plan.tree.props, {
    x: edges.length ? Math.max(...edges) + 120 : 0,
    y: -plan.height / 2,
  });
  const editor = getDocumentEditor(world),
    history = getEditHistory(world),
    before = new Set(world.query(Source)),
    reported = new Set<string>();
  const stop = editor.onEdit((e) => {
    if (e.kind === "insert") reported.add(e.source);
  });
  let created: Entity | undefined;
  current();
  const step = history.beginGroup();
  try {
    [created] = editor.insertElement(root, () => renderAuthored(plan.tree));
    if (!created)
      throw new Error("The reference version could not be inserted.");
  } catch (error) {
    for (const entity of [...world.query(Source)].filter(
      (e) => !before.has(e),
    )) {
      if (!entity.isAlive()) continue;
      const source = entity.get(Source)?.value;
      if (!source || !isPendingSource(source)) continue;
      if (reported.has(source)) editor.remove(entity);
      else editor.discardPending(source);
    }
    throw error;
  } finally {
    stop();
    history.endGroup(step);
  }
  editor.activate(created);
  editor.select(created);
  focusRect(world, {
    x: plan.tree.props.x as number,
    y: plan.tree.props.y as number,
    width: plan.width,
    height: plan.height,
  });
  editor.reportEdit(root, "camera", getCameraMatrix(world));
  try {
    await flushProjectEdits(dir);
  } catch (cause) {
    throw new Error(
      "The reference version was created but saving failed. Retry saving before creating another version.",
      { cause },
    );
  }
  try {
    assertProject(world, dir, options);
  } catch (cause) {
    throw new Error(
      "The reference version was created and saved, but the request stopped afterward. Review it before creating another copy.",
      { cause },
    );
  }
  const sceneId = created.get(Source)?.value;
  if (!sceneId)
    throw new Error(
      "The reference version was saved but is no longer in the open project.",
    );
  return {
    sceneId,
    name: plan.name,
    width: plan.width,
    height: plan.height,
    captionLayers: plan.captionLayers,
    changes: plan.changes,
    warnings: plan.warnings,
  };
}
