import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  local: true,
  signIn: vi.fn(),
  startLocalJob: vi.fn(),
  localJob: vi.fn(),
  generate: vi.fn(),
  estimate: vi.fn(),
  getJob: vi.fn(),
}));
vi.mock("@/lib/environment", () => ({
  get LOCAL_MODE() {
    return mocks.local;
  },
  CLOUD_UNAVAILABLE_MESSAGE: "Hosted generation is not configured in Blackout.",
}));
vi.mock("@/lib/api", () => ({
  api: {
    generate: { mutate: mocks.generate },
    estimate: { query: mocks.estimate },
    jobs: { get: { query: mocks.getJob }, cancel: { mutate: mocks.getJob } },
  },
}));
vi.mock("@/lib/uploads", () => ({ uploadFile: vi.fn() }));
vi.mock("@/engine/scene-audio", () => ({ encodeSceneAudio: vi.fn(), hasAudio: vi.fn() }));
vi.mock("@diffusionstudio/runtime", () => ({ getAssetFile: vi.fn(), getLibrary: vi.fn() }));
vi.mock("../lib/assets", () => ({ resolveAsset: vi.fn() }));
vi.mock("../lib/audio", () => ({ audioFile: vi.fn() }));
vi.mock("../lib/scene", () => ({ requireScene: vi.fn() }));
vi.mock("../lib/remote", () => ({ requireSignIn: mocks.signIn, apiError: (error: unknown) => error }));
vi.mock("../local/jobs", () => ({ startLocalJob: mocks.startLocalJob, localJob: mocks.localJob }));

import { DapiError } from "@diffusionstudio/dapi";
import { generate, job } from "./generate";
import type { ToolArgs } from "@diffusionstudio/dapi";
import type { ToolContext } from "../handler";

function context() {
  const session = vi.fn(() => null);
  const requireSession = vi.fn(() => {
    throw new DapiError("no-project", "No project is open.");
  });
  return { session, requireSession, signal: new AbortController().signal } as unknown as ToolContext & {
    session: ReturnType<typeof vi.fn>;
    requireSession: ReturnType<typeof vi.fn>;
  };
}

const hostedRequest = { model: "flux-2-klein", prompt: "A red fox at dawn", output: "b-roll/fox.png" } as unknown as ToolArgs<"generate">;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.local = true;
  mocks.signIn.mockRejectedValue(new DapiError("sign-in-required", "Sign in first."));
  mocks.startLocalJob.mockResolvedValue({ job: { id: "local-job", status: "queued", assets: [] }, saveTo: null });
  mocks.localJob.mockResolvedValue({ job: { id: "local-job", status: "running", assets: [] }, saveTo: null });
});

describe("generate without hosted generation", () => {
  it("refuses a hosted model at once, pointing to the web media tools", async () => {
    const ctx = context();
    const refused = generate(hostedRequest, ctx);
    await expect(refused).rejects.toMatchObject({
      code: "unsupported",
      message:
        "Hosted generation (flux-2-klein) isn't configured in Blackout, so it can't run. For photos, video or audio from the web use web_media_search then web_media_download; build titles and graphics as native JSX layers. Local sam-2.1 masking still works.",
    });
    // Nothing else ran first: no project lookup, sign-in check, upload, estimate or job.
    expect(ctx.session).not.toHaveBeenCalled();
    expect(ctx.requireSession).not.toHaveBeenCalled();
    expect(mocks.signIn).not.toHaveBeenCalled();
    expect(mocks.estimate).not.toHaveBeenCalled();
    expect(mocks.generate).not.toHaveBeenCalled();
    expect(mocks.startLocalJob).not.toHaveBeenCalled();
  });

  it("refuses an estimate for a hosted model the same way", async () => {
    await expect(generate({ ...hostedRequest, estimate: true }, context())).rejects.toMatchObject({ code: "unsupported" });
    expect(mocks.estimate).not.toHaveBeenCalled();
  });

  it("sends hosted transcription to the local transcribe tool", async () => {
    const request = { model: "universal-3.5-pro", audio: { path: "/clip.wav" } } as unknown as ToolArgs<"generate">;
    await expect(generate(request, context())).rejects.toMatchObject({ code: "unsupported", message: expect.stringContaining("transcribe tool") });
  });

  it("still runs the local model", async () => {
    const request = { model: "sam-2.1", video: { path: "/clip.mp4" } } as unknown as ToolArgs<"generate">;
    await expect(generate(request, context())).resolves.toMatchObject({ job: { id: "local-job" } });
    expect(mocks.startLocalJob).toHaveBeenCalledTimes(1);
  });

  it("refuses to poll a hosted job, and still polls a local one", async () => {
    await expect(job({ id: "6f1c7a8e-2a1b-4c3d-9e8f-0123456789ab" }, context())).rejects.toMatchObject({
      code: "unsupported",
      message: expect.stringContaining("web_media_search then web_media_download"),
    });
    expect(mocks.signIn).not.toHaveBeenCalled();
    expect(mocks.getJob).not.toHaveBeenCalled();
    await expect(job({ id: "local-job" }, context())).resolves.toMatchObject({ job: { id: "local-job" } });
    expect(mocks.localJob).toHaveBeenCalledWith("local-job", false);
  });
});

describe("generate with hosted generation configured", () => {
  it("goes on to the sign-in check for a hosted model", async () => {
    mocks.local = false;
    await expect(generate(hostedRequest, context())).rejects.toMatchObject({ code: "sign-in-required" });
    expect(mocks.signIn).toHaveBeenCalledTimes(1);
    await expect(job({ id: "6f1c7a8e-2a1b-4c3d-9e8f-0123456789ab" }, context())).rejects.toMatchObject({ code: "sign-in-required" });
  });
});
