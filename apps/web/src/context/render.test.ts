import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ElectronWritableFileHandle } from '@/lib/electron-file-writable';

const mocks = vi.hoisted(() => ({ capture: vi.fn(), encoder: vi.fn(), track: vi.fn() }));
vi.mock("@/engine/capture", () => ({ createCapture: mocks.capture }));
vi.mock("@/lib/analytics", () => ({ track: mocks.track }));
vi.mock("@diffusionstudio/runtime", () => ({ Computed: "computed", FrameRate: "frame-rate", Workarea: "workarea" }));
vi.mock("@diffusionstudio/encoder", () => ({
  createEncoder: mocks.encoder,
  computeOutputSize: (width: number, height: number, resolution: number) => ({
    width: width * resolution / Math.min(width, height),
    height: height * resolution / Math.min(width, height),
  }),
}));

import { cancelRender, completedExport, dismissCompletedExport, renderOverlay, renderScene } from "./render";
import type { Engine } from "@/engine";
import type { Entity } from "koota";

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function fixture() {
  const capture = { world: {}, dispose: vi.fn() };
  const encoder = { cancel: vi.fn(), render: vi.fn().mockResolvedValue({ type: "success" }) };
  const scene = { get: (trait: string) => trait === "computed" ? { duration: 900, width: 1280, height: 720 } : undefined } as unknown as Entity;
  const engine = { world: { get: () => ({ value: 30 }) }, start: vi.fn(), stop: vi.fn() } as unknown as Engine;
  const options = {
    scene,
    target: { createWritable: vi.fn() },
    source: "ui" as const,
    config: { format: "mp4" as const, video: { resolution: 1080 } },
    output: { name: "edit.mp4", path: "/exports/edit.mp4" },
  };
  mocks.capture.mockResolvedValue(capture);
  mocks.encoder.mockResolvedValue(encoder);
  return { capture, encoder, engine, options };
}

beforeEach(() => {
  vi.clearAllMocks();
  dismissCompletedExport();
});
afterEach(()=>vi.unstubAllGlobals());

describe("scene export lifecycle", () => {
  it('uses a lossless intermediate for macOS AAC exports while reporting the requested container',async()=>{
    const {engine,options}=fixture();vi.stubGlobal('window',{desktop:{platform:'darwin'}});
    const target=new ElectronWritableFileHandle('/exports/edit.mp4');const finalize=vi.spyOn(target,'finalizeAudio');
    await renderScene(engine,{...options,target});
    expect(mocks.encoder.mock.calls[0]![1]).toMatchObject({format:'mov',audio:{codec:'pcm-f32'}});
    expect(finalize).toHaveBeenCalledWith({format:'mp4',audioBitrate:128000});expect(completedExport()?.format).toBe('mp4');
  });
  it("honors cancellation during preparation without opening an encoder", async () => {
    const { capture, engine, options } = fixture();
    const pending = deferred<typeof capture>();
    mocks.capture.mockReturnValue(pending.promise);
    const job = renderScene(engine, options);
    expect(renderOverlay()?.phase).toBe("preparing");
    cancelRender();
    expect(renderOverlay()?.phase).toBe("canceling");
    pending.resolve(capture);
    await expect(job).resolves.toEqual({ type: "canceled" });
    expect(mocks.encoder).not.toHaveBeenCalled();
    expect(capture.dispose).toHaveBeenCalledOnce();
    expect(engine.start).toHaveBeenCalledOnce();
    expect(renderOverlay()).toBeNull();
    expect(completedExport()).toBeNull();
  });

  it("passes a pending cancellation to an encoder that is still being created", async () => {
    const { encoder, engine, options } = fixture();
    const pending = deferred<typeof encoder>();
    mocks.encoder.mockReturnValue(pending.promise);
    encoder.render.mockResolvedValue({ type: "canceled" });
    const job = renderScene(engine, options);
    await vi.waitFor(() => expect(mocks.encoder).toHaveBeenCalledOnce());
    cancelRender();
    pending.resolve(encoder);
    await expect(job).resolves.toEqual({ type: "canceled" });
    expect(encoder.cancel).toHaveBeenCalledOnce();
    expect(renderOverlay()).toBeNull();
  });

  it("refuses a concurrent render without disturbing the active render", async () => {
    const { capture, engine, options } = fixture();
    const pending = deferred<typeof capture>();
    mocks.capture.mockReturnValue(pending.promise);
    const first = renderScene(engine, options);
    await expect(renderScene(engine, options)).rejects.toThrow("already running");
    expect(engine.stop).toHaveBeenCalledOnce();
    expect(renderOverlay()).not.toBeNull();
    pending.resolve(capture);
    await expect(first).resolves.toMatchObject({ type: "success" });
    expect(engine.start).toHaveBeenCalledOnce();
  });

  it("restores the live preview and clears progress after preparation fails", async () => {
    const { engine, options } = fixture();
    mocks.capture.mockRejectedValue(new Error("Missing footage"));
    await expect(renderScene(engine, options)).rejects.toThrow("Missing footage");
    expect(engine.start).toHaveBeenCalledOnce();
    expect(renderOverlay()).toBeNull();
    expect(completedExport()).toBeNull();
  });

  it("reports the completed filename, location, actual dimensions and duration", async () => {
    const { engine, options } = fixture();
    await renderScene(engine, options);
    expect(completedExport()).toEqual({ name: "edit.mp4", path: "/exports/edit.mp4", width: 1920, height: 1080, format: "mp4", duration: 30 });
    expect(renderOverlay()).toBeNull();
  });

  it("propagates a decoder failure without announcing a completed export", async () => {
    const { capture, encoder, engine, options } = fixture();
    const error = new Error('Cannot render Interview (footage.mp4): decoding failed');
    encoder.render.mockResolvedValue({ type: 'error', error });
    await expect(renderScene(engine, options)).resolves.toEqual({ type: 'error', error });
    expect(completedExport()).toBeNull();
    expect(renderOverlay()).toBeNull();
    expect(capture.dispose).toHaveBeenCalledOnce();
    expect(engine.start).toHaveBeenCalledOnce();
    expect(mocks.track).not.toHaveBeenCalledWith('export_succeeded', expect.anything());
  });
});
