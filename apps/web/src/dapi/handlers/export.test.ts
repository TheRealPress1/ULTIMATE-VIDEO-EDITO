import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  library: null as unknown,
  renderScene: vi.fn(),
  renderOverlay: vi.fn(() => false),
  call: vi.fn(),
}));
vi.mock("mediabunny", () => {
  class Format {
    getSupportedVideoCodecs() {
      return ["avc", "hevc", "vp9", "av1"];
    }
    getSupportedAudioCodecs() {
      return ["aac", "opus"];
    }
  }
  return { canEncodeVideo: async () => true, Mp4OutputFormat: Format, MovOutputFormat: Format, WebMOutputFormat: Format, OggOutputFormat: Format };
});
vi.mock("@diffusionstudio/encoder", () => ({ computeOutputSize: () => ({ width: 1920, height: 1080 }) }));
vi.mock("@diffusionstudio/runtime", () => ({ Computed: "Computed", FrameRate: "FrameRate", Workarea: "Workarea", getLibrary: () => mocks.library }));
vi.mock("@/context/render", () => ({ renderOverlay: mocks.renderOverlay, renderScene: mocks.renderScene }));
vi.mock("@/lib/electron-file-writable", () => ({
  ElectronWritableFileHandle: class {
    constructor(readonly path: string) {}
    async dispose() {}
  },
}));
vi.mock("@/engine/traits", () => ({ ProjectConfig: "ProjectConfig" }));
vi.mock("@/engine/project-config", () => ({ sceneConfigKey: () => "intro" }));
vi.mock("@/components/sidebar-right/inspector/export-templates", () => ({
  getDefaultExportTemplate: () => ({ format: "mp4", video: { codec: "avc", resolution: 1080 }, audio: { codec: "aac" } }),
  VIDEO_FORMAT_OPTIONS: ["mp4", "mov", "webm", "ogg"],
}));
vi.mock("@/lib/ipc", () => ({ mainBridge: { call: mocks.call } }));
vi.mock("../lib/scene", () => ({ requireScene: () => ({ get: () => undefined }) }));

import { exportScene, refuseExportsOutside, refuseSourceOverwrite } from "./export";
import type { AssetLibrary } from "@diffusionstudio/assets";
import type { ToolContext } from "../handler";

const SOURCE_MEDIA = "That path is source media used by this project; export to a new file name.";
const EXPORTS_OUTSIDE =
  "The project's exports folder leads outside the project, so an export can't be written there. Make `exports` a plain folder in the project, or give the export a `path`.";

/** A library over `sources`, whose files really are where `reals` says (missing: they do not exist). */
function fakeLibrary(sources: string[], reals: Record<string, string> = {}, options: { realPath?: boolean } = {}) {
  const realPath = vi.fn(async (source: string) => reals[source] ?? null);
  return {
    list: () => sources.map((source, i) => ({ id: `asset-${i}`, path: `clip-${i}.mp4`, source })),
    fs: { absolute: (path: string) => `/project/${path}`, ...(options.realPath === false ? {} : { realPath }) },
  } as unknown as AssetLibrary & { fs: { realPath: typeof realPath } };
}

function context(dir = "/project") {
  const session = { world: { get: () => undefined }, project: { dir: () => dir }, engine: {} };
  return { requireSession: () => session, session: () => session, signal: new AbortController().signal } as unknown as ToolContext;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.renderOverlay.mockReturnValue(false);
  mocks.renderScene.mockResolvedValue({ type: "done" });
  mocks.call.mockResolvedValue({ size: 1234, mtime: 0 });
});

describe("refuseSourceOverwrite", () => {
  it("refuses a linked original by its path", async () => {
    const library = fakeLibrary(["/Users/me/Movies/interview.mp4"]);
    await expect(refuseSourceOverwrite(library, "/Users/me/Movies/interview.mp4")).rejects.toMatchObject({ code: "invalid-input", message: SOURCE_MEDIA });
  });

  it("refuses a file the project holds under assets/", async () => {
    const library = fakeLibrary(["assets/b-roll/fox.mp4"]);
    await expect(refuseSourceOverwrite(library, "/project/assets/b-roll/fox.mp4")).rejects.toMatchObject({ message: SOURCE_MEDIA });
  });

  it("refuses a path that really leads to a source, through links on either side", async () => {
    const library = fakeLibrary(["assets/interview.mp4", "/Volumes/Footage/b.mp4"], {
      "assets/interview.mp4": "/Users/me/Movies/interview.mp4",
      "/Volumes/Footage/b.mp4": "/Volumes/Footage/b.mp4",
      "/Users/me/Movies/link-to-interview.mp4": "/Users/me/Movies/interview.mp4",
      "/Users/me/Movies/interview.mp4": "/Users/me/Movies/interview.mp4",
    });
    await expect(refuseSourceOverwrite(library, "/Users/me/Movies/interview.mp4")).rejects.toMatchObject({ message: SOURCE_MEDIA });
    await expect(refuseSourceOverwrite(library, "/Users/me/Movies/link-to-interview.mp4")).rejects.toMatchObject({ message: SOURCE_MEDIA });
  });

  it("lets an export write a new file or replace an earlier export", async () => {
    const library = fakeLibrary(["assets/interview.mp4", "https://example.com/clip.mp4"], {
      "assets/interview.mp4": "/project/assets/interview.mp4",
      "/project/exports/intro.mp4": "/project/exports/intro.mp4",
    });
    await expect(refuseSourceOverwrite(library, "/project/exports/new.mp4")).resolves.toBeUndefined();
    await expect(refuseSourceOverwrite(library, "/project/exports/intro.mp4")).resolves.toBeUndefined();
    await expect(refuseSourceOverwrite(library, "https://example.com/clip.mp4")).resolves.toBeUndefined();
    // A target that does not exist is not looked up against every source.
    library.fs.realPath.mockClear();
    await refuseSourceOverwrite(library, "/project/exports/new.mp4");
    expect(library.fs.realPath).toHaveBeenCalledTimes(1);
  });

  it("still compares paths where the host cannot resolve links", async () => {
    const library = fakeLibrary(["assets/interview.mp4"], {}, { realPath: false });
    await expect(refuseSourceOverwrite(library, "/project/assets/interview.mp4")).rejects.toMatchObject({ message: SOURCE_MEDIA });
    await expect(refuseSourceOverwrite(library, "/project/exports/intro.mp4")).resolves.toBeUndefined();
  });
});

describe("export over source media", () => {
  it("refuses before anything renders", async () => {
    mocks.library = fakeLibrary(["/Users/me/Movies/interview.mp4"], { "/Users/me/Movies/interview.mp4": "/Users/me/Movies/interview.mp4" });
    await expect(exportScene({ id: "intro", path: "/Users/me/Movies/interview.mp4" }, context())).rejects.toMatchObject({ message: SOURCE_MEDIA });
    expect(mocks.renderScene).not.toHaveBeenCalled();
  });

  it("refuses a default target that is a source too", async () => {
    mocks.library = fakeLibrary(["exports/intro.mp4"]);
    await expect(exportScene({ id: "intro" }, context())).rejects.toMatchObject({ message: SOURCE_MEDIA });
    expect(mocks.renderScene).not.toHaveBeenCalled();
  });

  it("exports to a new file", async () => {
    mocks.library = fakeLibrary(["/Users/me/Movies/interview.mp4"], { "/Users/me/Movies/interview.mp4": "/Users/me/Movies/interview.mp4" });
    await expect(exportScene({ id: "intro", path: "/Users/me/Movies/intro-cut.mp4" }, context())).resolves.toMatchObject({
      path: "/Users/me/Movies/intro-cut.mp4",
      size: 1234,
    });
    expect(mocks.renderScene).toHaveBeenCalledTimes(1);
  });
});

describe("refuseExportsOutside", () => {
  it("refuses an exports folder that really is outside the project", async () => {
    const library = fakeLibrary([], { "/project": "/private/project", exports: "/Users/me/Movies" });
    await expect(refuseExportsOutside(library, "/project")).rejects.toMatchObject({ code: "invalid-input", message: EXPORTS_OUTSIDE });
    // A sibling whose name starts like the project's is not in it.
    const sibling = fakeLibrary([], { "/project": "/private/project", exports: "/private/project-exports" });
    await expect(refuseExportsOutside(sibling, "/project")).rejects.toMatchObject({ message: EXPORTS_OUTSIDE });
  });

  it("takes an exports folder in the project, linked or not, or one not made yet", async () => {
    await expect(refuseExportsOutside(fakeLibrary([], { "/project": "/private/project", exports: "/private/project/exports" }), "/project")).resolves.toBeUndefined();
    await expect(refuseExportsOutside(fakeLibrary([], { "/project": "/private/project", exports: "/private/project/renders" }), "/project")).resolves.toBeUndefined();
    await expect(refuseExportsOutside(fakeLibrary([], { "/project": "/private/project" }), "/project")).resolves.toBeUndefined();
    await expect(refuseExportsOutside(fakeLibrary([], {}, { realPath: false }), "/project")).resolves.toBeUndefined();
  });
});

describe("export to the default target", () => {
  it("refuses before anything renders when exports leads outside the project", async () => {
    mocks.library = fakeLibrary([], { "/project": "/project", exports: "/Users/me/Movies" });
    await expect(exportScene({ id: "intro" }, context())).rejects.toMatchObject({ message: EXPORTS_OUTSIDE });
    expect(mocks.renderScene).not.toHaveBeenCalled();
  });

  it("leaves a given path to the path checks", async () => {
    mocks.library = fakeLibrary([], { "/project": "/project", exports: "/Users/me/Movies" });
    await expect(exportScene({ id: "intro", path: "/project/cut.mp4" }, context())).resolves.toMatchObject({ path: "/project/cut.mp4" });
  });

  it("exports into the project's exports folder", async () => {
    mocks.library = fakeLibrary([], { "/project": "/project", exports: "/project/exports" });
    await expect(exportScene({ id: "intro" }, context())).resolves.toMatchObject({ path: "/project/exports/intro.mp4" });
    expect(mocks.renderScene).toHaveBeenCalledTimes(1);
  });
});

describe("which screen an export gets", () => {
  const backgroundOf = () => (mocks.renderScene.mock.calls[0]![1] as { background: boolean; source: string });

  it("renders a draft in a temporary folder in the background, so it never takes over the editor", async () => {
    mocks.library = fakeLibrary([], { "/project": "/project", exports: "/project/exports" });
    await exportScene({ id: "intro", path: "/private/tmp/agent/promo-review-music-v2.mp4" }, context());
    expect(backgroundOf()).toMatchObject({ source: "agent", background: true });
    mocks.renderScene.mockClear();
    await exportScene({ id: "intro", path: "/tmp/promo-review-v1.mp4" }, context());
    expect(backgroundOf().background).toBe(true);
  });

  it("keeps a delivery on the full screen, in the project or anywhere a person would look", async () => {
    mocks.library = fakeLibrary([], { "/project": "/project", exports: "/project/exports" });
    await exportScene({ id: "intro" }, context());
    expect(backgroundOf()).toMatchObject({ source: "agent", background: false });
    mocks.renderScene.mockClear();
    await exportScene({ id: "intro", path: "/Users/me/Movies/intro-cut.mp4" }, context());
    expect(backgroundOf().background).toBe(false);
  });

  it("keeps what an export writes into the project a delivery, even when the project itself is in a temp folder", async () => {
    mocks.library = fakeLibrary([], { "/private/tmp/qa": "/private/tmp/qa", exports: "/private/tmp/qa/exports" });
    await exportScene({ id: "intro" }, context("/private/tmp/qa"));
    expect(backgroundOf().background).toBe(false);
    mocks.renderScene.mockClear();
    await exportScene({ id: "intro", path: "/private/tmp/qa/exports/cut.mp4" }, context("/private/tmp/qa"));
    expect(backgroundOf().background).toBe(false);
    mocks.renderScene.mockClear();
    await exportScene({ id: "intro", path: "/private/tmp/review-v1.mp4" }, context("/private/tmp/qa"));
    expect(backgroundOf().background).toBe(true);
  });

  it("still refuses a second export while any render is running, background or not", async () => {
    mocks.library = fakeLibrary([], { "/project": "/project", exports: "/project/exports" });
    mocks.renderOverlay.mockReturnValue(true);
    await expect(exportScene({ id: "intro", path: "/tmp/draft.mp4" }, context())).rejects.toMatchObject({ code: "busy" });
    expect(mocks.renderScene).not.toHaveBeenCalled();
  });
});
