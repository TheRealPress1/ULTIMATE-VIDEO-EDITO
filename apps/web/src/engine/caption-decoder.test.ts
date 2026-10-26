import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Asset, AssetLibrary } from "@diffusionstudio/assets";
import type { World } from "koota";
import { createRuntimeWorld } from "../../../../packages/runtime/src/world/create-world";
import { createEntity } from "../../../../packages/runtime/src/actions/entities";
import { resolveCaptionDecoder } from "../../../../packages/runtime/src/media/caption";
import { CaptionType } from "../../../../packages/runtime/src/constants";
import { playbackSystem } from "../../../../packages/runtime/src/systems/playback";
import { setPlayhead } from "../../../../packages/runtime/src/actions/playback";
import {
  AssetId, Caption, CaptionDecoderHandle, Chars, ChildOf, Culled, FramePromises, Geometry, Library, Mode, Paint, Root, Scene, Shadow, Source, TextRange,
} from "../../../../packages/runtime/src/traits";

const worlds: World[] = [];

beforeEach(() => {
  // The runtime's size helper checks DOM hosts. These entities have none;
  // the tests exercise real decoder styles and world observers without canvas.
  vi.stubGlobal("HTMLElement", class {});
  vi.stubGlobal("HTMLCanvasElement", class {});
});

afterEach(() => {
  for (const world of worlds.splice(0)) world.destroy();
  vi.unstubAllGlobals();
});

function fixture(type = CaptionType.CLASSIC) {
  const world = createRuntimeWorld("caption-styling-test");
  worlds.push(world);
  const assets = new Map(["first", "edited"].map((id) => [id, {
    id, type: "AUDIO", transcript: [], duration: 1,
  } as unknown as Asset]));
  world.set(Library, { get: (id: string) => assets.get(id) } as AssetLibrary);
  const scene = createEntity(world);
  scene.add(Scene);
  const caption = createEntity(world);
  caption.add(Caption({ type }), AssetId({ value: "first" }), ChildOf(scene));
  return { world, caption, scene };
}

function pendingCapture() {
  const { world, caption, scene } = fixture(CaptionType.WHISPER);
  let resolveFile!: (file: File) => void;
  const file = new Promise<File>((resolve) => { resolveFile = resolve; });
  Object.assign(world.get(Library)!.get("first")!, {
    type: "TRANSCRIPT", mimeType: "application/json", handle: { getFile: () => file },
  });
  world.set(Mode, { value: "offline-video" });
  scene.add(Geometry, ChildOf(world.get(Root)!));
  caption.add(Geometry);
  setPlayhead(world, scene, 90);
  world.set(FramePromises, { list: [] });
  return { world, caption, resolveFile };
}

describe("caption decoder style lifecycle", () => {
  it("keeps one preset shadow through repeated transcript edits and undo", () => {
    const { world, caption } = fixture();
    let decoder = resolveCaptionDecoder(world, caption);
    expect(world.query(ChildOf(caption), Shadow)).toHaveLength(1);

    for (const id of ["edited", "first", "edited", "first"]) {
      caption.set(AssetId, { value: id });
      expect(caption.get(CaptionDecoderHandle)).toBeNull();
      const replacement = resolveCaptionDecoder(world, caption);
      expect(replacement).not.toBe(decoder);
      expect(world.query(ChildOf(caption), Shadow)).toHaveLength(1);
      decoder = replacement;
    }
  });

  it("keeps one preset fill when Stark's decoder is recreated", () => {
    const { world, caption } = fixture(CaptionType.STARK);
    resolveCaptionDecoder(world, caption);
    expect(world.query(ChildOf(caption), Paint)).toHaveLength(1);
    caption.set(AssetId, { value: "edited" });
    resolveCaptionDecoder(world, caption);
    expect(world.query(ChildOf(caption), Paint)).toHaveLength(1);
  });

  it("does not accumulate shadows when a culled caption returns to view", () => {
    const { world, caption } = fixture();
    resolveCaptionDecoder(world, caption);
    caption.add(Culled);
    expect(caption.get(CaptionDecoderHandle)).toBeNull();
    caption.remove(Culled);
    resolveCaptionDecoder(world, caption);
    expect(world.query(ChildOf(caption), Shadow)).toHaveLength(1);
  });

  it("preserves authored fills, shadows, and text ranges while clearing generated ones", () => {
    const { world, caption } = fixture();
    const authored = [Paint, Shadow, TextRange].map((trait, index) => {
      const child = createEntity(world);
      child.add(trait, Source({ value: `authored-${index}` }), ChildOf(caption));
      return child;
    });
    resolveCaptionDecoder(world, caption);
    const oldGeneratedShadow = world.query(ChildOf(caption), Shadow).find((child) => !child.has(Source))!;
    const oldGeneratedRange = createEntity(world);
    oldGeneratedRange.add(TextRange, ChildOf(caption));
    const rangeFill = createEntity(world);
    rangeFill.add(Paint, ChildOf(oldGeneratedRange));

    caption.set(AssetId, { value: "edited" });
    resolveCaptionDecoder(world, caption);
    expect(authored.every((child) => child.isAlive())).toBe(true);
    expect(oldGeneratedShadow.isAlive()).toBe(false);
    expect(oldGeneratedRange.isAlive()).toBe(false);
    expect(rangeFill.isAlive()).toBe(false);
    expect(world.query(ChildOf(caption), Shadow)).toHaveLength(2);
    expect(world.query(ChildOf(caption), Paint)).toHaveLength(1);
    expect(world.query(ChildOf(caption), TextRange)).toHaveLength(1);
  });

  it("does not replace or accumulate styles when resolving the same live decoder", () => {
    const { world, caption } = fixture();
    const decoder = resolveCaptionDecoder(world, caption);
    const shadow = world.query(ChildOf(caption), Shadow)[0];
    expect(resolveCaptionDecoder(world, caption)).toBe(decoder);
    expect([...world.query(ChildOf(caption), Shadow)]).toEqual([shadow]);
  });

  it("removes the previous preset's generated styles on a preset switch", () => {
    const { world, caption } = fixture();
    resolveCaptionDecoder(world, caption);
    expect(world.query(ChildOf(caption), Shadow)).toHaveLength(1);
    caption.set(Caption, { type: CaptionType.STARK });
    resolveCaptionDecoder(world, caption);
    expect(world.query(ChildOf(caption), Shadow)).toHaveLength(0);
    expect(world.query(ChildOf(caption), Paint)).toHaveLength(1);
  });
});

describe("caption capture readiness", () => {
  it("waits for transcript loading and seeks the first captured frame before drawing", async () => {
    const { world, caption, resolveFile } = pendingCapture();
    playbackSystem(world);
    expect(caption.get(CaptionDecoderHandle)?.ready).toBe(false);
    expect(caption.get(Chars)?.value ?? "").toBe("");
    const pending = world.get(FramePromises)?.list ?? [];
    expect(pending.length).toBeGreaterThan(0);

    resolveFile(new File([JSON.stringify([{ text: "specifically", words: [
      { text: "specifically", start: 2.6, end: 3.35 },
    ] }])], "captions.json"));
    await Promise.all(pending);
    expect(caption.get(CaptionDecoderHandle)?.ready).toBe(true);
    expect(caption.get(Chars)?.value).toBe("specifically");
  });

  it("does not apply a loading decoder's words after the source changes", async () => {
    const { world, caption, resolveFile } = pendingCapture();
    playbackSystem(world);
    const pending = [...world.get(FramePromises)?.list ?? []];
    caption.set(AssetId, { value: "edited" });
    resolveFile(new File([JSON.stringify([{ text: "old words", words: [
      { text: "old words", start: 2.6, end: 3.35 },
    ] }])], "captions.json"));
    await Promise.all(pending);
    expect(caption.get(Chars)?.value ?? "").toBe("");
  });

  it("fails the offline frame when its caption transcript cannot be parsed", async () => {
    const { world, resolveFile } = pendingCapture();
    playbackSystem(world);
    const frame = Promise.all(world.get(FramePromises)?.list ?? []);
    resolveFile(new File(["invalid json"], "captions.json"));
    await expect(frame).rejects.toThrow();
  });
});
