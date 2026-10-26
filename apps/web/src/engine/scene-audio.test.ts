import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ capture: vi.fn(), encoder: vi.fn(), tree: vi.fn(), workarea: vi.fn((value: unknown) => ({ trait: 'workarea', value })) }));
vi.mock("./capture", () => ({ createCapture: mocks.capture }));
vi.mock("@diffusionstudio/encoder", () => ({ createEncoder: mocks.encoder }));
vi.mock("@diffusionstudio/runtime", () => ({
  AssetId: "asset", Audio: "audio", getEntityTree: mocks.tree, getParentNode: (entity: { parent?: unknown }) => entity.parent, Hidden: "hidden",
  Muted: "muted", Source: 'source', Paint: "paint", PaintType: { VIDEO: "video" }, Workarea: mocks.workarea, FrameRate: "fps",
}));

import { encodeSceneAudio, encodeScenePcm, hasAudio } from "./scene-audio";
import type { Entity, World } from "koota";

const world = { get: () => ({ value: 30 }) } as unknown as World;
const scene = {} as Entity;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function fixture() {
  const capture = { world: {}, node: { remove: vi.fn(), add: vi.fn() }, dispose: vi.fn() };
  const encoder = { cancel: vi.fn(), render: vi.fn().mockResolvedValue({ type: "success", data: new Uint8Array([1]) }) };
  mocks.capture.mockResolvedValue(capture);
  mocks.encoder.mockResolvedValue(encoder);
  return { capture, encoder };
}
beforeEach(() => { vi.clearAllMocks(); mocks.tree.mockReturnValue([]); });

describe('audible scene detection', () => {
  it('ignores media inside muted or hidden parent groups without ignoring clips later on the timeline', () => {
    const node = (traits: string[], parent?: unknown) => ({ parent, has: (trait: string) => traits.includes(trait), get: () => undefined });
    const root = node([]);
    const group = node(['muted'], root);
    const clip = node(['audio', 'asset'], group);
    mocks.tree.mockReturnValue([root, group, clip]);
    expect(hasAudio(world, root as unknown as Entity)).toBe(false);
    group.has = (trait) => trait === 'hidden';
    expect(hasAudio(world, root as unknown as Entity)).toBe(false);
    group.has = () => false;
    expect(hasAudio(world, root as unknown as Entity)).toBe(true);
    root.has = (trait) => trait === 'muted';
    expect(hasAudio(world, root as unknown as Entity)).toBe(false);
  });
});

describe("caption scene audio preparation", () => {
  it("disposes a capture canceled while preparation was pending", async () => {
    const { capture } = fixture();
    const pending = deferred<typeof capture>();
    mocks.capture.mockReturnValue(pending.promise);
    const controller = new AbortController();
    const task = encodeSceneAudio(world, scene, undefined, { signal: controller.signal });
    const rejected = expect(task).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    pending.resolve(capture);
    await rejected;
    expect(mocks.encoder).not.toHaveBeenCalled();
    expect(capture.dispose).toHaveBeenCalledOnce();
  });

  it("passes cancellation to an encoder that finishes initializing later", async () => {
    const { capture, encoder } = fixture();
    const pending = deferred<typeof encoder>();
    mocks.encoder.mockReturnValue(pending.promise);
    encoder.render.mockResolvedValue({ type: "canceled" });
    const controller = new AbortController();
    const task = encodeSceneAudio(world, scene, undefined, { signal: controller.signal });
    const rejected = expect(task).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(mocks.encoder).toHaveBeenCalledOnce());
    controller.abort();
    pending.resolve(encoder);
    await rejected;
    expect(encoder.cancel).toHaveBeenCalledOnce();
    expect(encoder.render).toHaveBeenCalledOnce();
    expect(capture.dispose).toHaveBeenCalledOnce();
  });

  it("renders the complete scene with progress, independently of the export workarea", async () => {
    const { capture } = fixture();
    const progress = vi.fn();
    const file = await encodeSceneAudio(world, scene, "/project", { onProgress: progress });
    expect(capture.node.remove).toHaveBeenCalledWith(mocks.workarea);
    expect(mocks.encoder).toHaveBeenCalledWith(capture.world, expect.objectContaining({
      video: { enabled: false }, audio: { enabled: true, codec: "opus", sampleRate: 24000 },
    }));
    mocks.encoder.mock.calls[0]![1].onProgress({ progress: 3, total: 10 });
    expect(progress).toHaveBeenCalledWith(0.3);
    expect(file.type).toBe("audio/ogg");
    expect(capture.dispose).toHaveBeenCalledOnce();
  });
});

describe('lossless scene audio preparation', () => {
  it('uses48kfloatPCM and excludes only selected background sources in the capture world', async () => {
    const { capture } = fixture();
    const music = { get: () => ({ value: 'index.tsx:music' }), add: vi.fn() };
    const voice = { get: () => ({ value: 'index.tsx:voice' }), add: vi.fn() };
    mocks.tree.mockReturnValue([music, voice]);
    const file = await encodeScenePcm(world, scene, '/project', { excludeSources: ['index.tsx:music'] });
    expect(music.add).toHaveBeenCalledWith('muted'); expect(voice.add).not.toHaveBeenCalled();
    expect(mocks.encoder).toHaveBeenCalledWith(capture.world, expect.objectContaining({ format: 'mov', video: { enabled: false }, audio: { enabled: true, codec: 'pcm-f32', sampleRate: 48000, numberOfChannels: 2 } }));
    expect(file.type).toBe('video/quicktime'); expect(capture.dispose).toHaveBeenCalledOnce();
  });
  it('refuses stale track selection before encoding and releases canceled captures', async () => {
    const { capture } = fixture();
    await expect(encodeScenePcm(world, scene, '/project', { excludeSources: ['missing'] })).rejects.toThrow('background track changed');
    expect(mocks.encoder).not.toHaveBeenCalled(); expect(capture.dispose).toHaveBeenCalledOnce();
    const controller = new AbortController(); const pending = deferred<typeof capture>();
    mocks.capture.mockReturnValue(pending.promise);
    const task = encodeScenePcm(world, scene, '/project', { signal: controller.signal });
    const rejected = expect(task).rejects.toMatchObject({ name: 'AbortError' }); controller.abort(); pending.resolve(capture); await rejected;
  });
});


it('bounds requested scene PCM windows before allocating an encoder and preserves source time', async () => {
  const f=fixture();
  await encodeScenePcm(world,scene,'/project',{window:{start:120,end:242}});
  expect(f.capture.node.add).toHaveBeenCalledWith({trait:'workarea',value:{start:3600,end:7260}});
  const invalid=fixture();
  await expect(encodeScenePcm(world,scene,'/project',{window:{start:0,end:5400}})).rejects.toThrow('three minutes');
  expect(invalid.capture.dispose).toHaveBeenCalledOnce();
});

it('supports bounded speech windows using the same frame clock', async () => {
  const f=fixture();await encodeSceneAudio(world,scene,'/project',{window:{start:3600,end:3720}});
  expect(f.capture.node.add).toHaveBeenCalledWith({trait:'workarea',value:{start:108000,end:111600}});
});
