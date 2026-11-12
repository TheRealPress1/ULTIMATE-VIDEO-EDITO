/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { isDapiError } from "@diffusionstudio/dapi";
import {
  checkToolOutputs,
  EXPORTS_OUTSIDE,
  guardToolOutputs,
  HOSTED_NOTE,
  OPEN_EXISTING,
  OPEN_PLACES,
  openRefusal,
  pinProject,
  PROJECT_MOVED,
  protectedMessage,
  REPLACE_OUTSIDE,
  stillPinned,
  WRITABLE_PLACES,
  writeRefusal,
} from "./output-policy";

import type { WritePolicy } from "./output-policy";

// Spelled as `mkdtemp` hands it back, not canonicalized: on macOS that is
// `/var/…`, really `/private/var/…`, so every check below also exercises the
// policy's own symlink resolution.
const root = mkdtempSync(join(tmpdir(), "dapi-output-policy-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const home = join(root, "home");
const temp = join(root, "tmp");
const elsewhere = join(root, "elsewhere");
const project = join(home, "Documents", "Show");
for (const dir of ["Desktop", "Documents", "Downloads", "Movies", "Music", "Pictures", ".ssh", ".config", "Library"]) {
  mkdirSync(join(home, dir), { recursive: true });
}
for (const dir of [temp, elsewhere, join(project, "assets"), join(project, ".git"), join(project, "exports")]) {
  mkdirSync(dir, { recursive: true });
}
writeFileSync(join(project, "exports", "intro.mp4"), "");
writeFileSync(join(home, "Documents", "notes.txt"), "");
writeFileSync(join(elsewhere, "existing.txt"), "");
writeFileSync(join(temp, "scratch.json"), "");

const policy: WritePolicy = { project, pinned: pinProject(project), home, temp: [temp], base: project };
/** Whether this machine's disks are taken as case-insensitive, as macOS's and Windows' are by default. */
const foldsCase = process.platform === "darwin" || process.platform === "win32";
const refusal = (path: string, kind: Parameters<typeof writeRefusal>[1] = "file", options: Partial<WritePolicy> = {}) =>
  writeRefusal(path, kind, { ...policy, ...options });

describe("writeRefusal", () => {
  it("lets tools write anywhere in the project, replacing files there", async () => {
    await expect(refusal(join(project, "exports", "new.mp4"))).resolves.toBeNull();
    await expect(refusal(join(project, "exports", "intro.mp4"))).resolves.toBeNull();
    await expect(refusal(join(project, "deep", "new", "folder", "frame.png"))).resolves.toBeNull();
    await expect(refusal(project, "fresh")).resolves.toBeNull();
  });

  it("lets tools write anywhere in a temp folder", async () => {
    await expect(refusal(join(temp, "frames", "0f.png"))).resolves.toBeNull();
    await expect(refusal(join(temp, "scratch.json"))).resolves.toBeNull();
  });

  it("treats the system temp folder as a temp folder by default", async () => {
    await expect(writeRefusal(join(tmpdir(), "dapi-frames", "0f.png"), "frames", { project: null, pinned: null, home })).resolves.toBeNull();
  });

  it("keeps protected folders off-limits even inside the project and temp folders", async () => {
    await expect(refusal(join(project, ".git", "config"))).resolves.toBe(protectedMessage(".git"));
    await expect(refusal(join(project, ".cutroom", "web-media.json"))).resolves.toBe(protectedMessage(".cutroom"));
    await expect(refusal(join(project, "sub", ".claude", "settings.json"))).resolves.toBe(protectedMessage(".claude"));
    await expect(refusal(join(project, ".mcp.json"))).resolves.toBe(protectedMessage(".mcp.json"));
    await expect(refusal(join(temp, ".ssh", "id_ed25519"))).resolves.toBe(protectedMessage(".ssh"));
    await expect(refusal(join(project, ".codex"), "fresh")).resolves.toBe(protectedMessage(".codex"));
    expect(protectedMessage(".git")).toBe("Blackout keeps .git off-limits to editing sessions. Write project files elsewhere in the project folder.");
  });

  it.runIf(foldsCase)("knows a protected name however it is capitalized, as the disk does", async () => {
    await expect(refusal(join(project, ".Cutroom", "web-media.json"))).resolves.toBe(protectedMessage(".cutroom"));
    await expect(refusal(join(project, ".Claude", "settings.json"))).resolves.toBe(protectedMessage(".claude"));
    await expect(refusal(join(project, ".MCP.json"))).resolves.toBe(protectedMessage(".mcp.json"));
    await expect(refusal(join(temp, ".GIT", "config"))).resolves.toBe(protectedMessage(".git"));
  });

  it("allows a new file in the user's content folders", async () => {
    await expect(refusal(join(home, "Desktop", "cut.mp4"))).resolves.toBeNull();
    await expect(refusal(join(home, "Movies", "new", "folder", "cut.mp4"))).resolves.toBeNull();
    await expect(refusal(join(home, "Documents", "Other Show", "frame.png"))).resolves.toBeNull();
  });

  it("refuses to replace an existing file outside the project and temp folders", async () => {
    await expect(refusal(join(home, "Documents", "notes.txt"))).resolves.toBe(REPLACE_OUTSIDE);
    await expect(refusal(join(elsewhere, "existing.txt"))).resolves.toBe(REPLACE_OUTSIDE);
    await expect(refusal(join(home, "Documents"))).resolves.toBe(REPLACE_OUTSIDE);
  });

  it("refuses new files anywhere else", async () => {
    await expect(refusal(join(elsewhere, "new.png"))).resolves.toBe(WRITABLE_PLACES);
    await expect(refusal(join(home, "Library", "new.png"))).resolves.toBe(WRITABLE_PLACES);
    await expect(refusal(join(home, "new.png"))).resolves.toBe(WRITABLE_PLACES);
    await expect(refusal("/new-file-at-the-root.png")).resolves.toBe(WRITABLE_PLACES);
  });

  it("refuses hidden folders below the home folder", async () => {
    await expect(refusal(join(home, ".ssh", "authorized_keys"))).resolves.toBe(WRITABLE_PLACES);
    await expect(refusal(join(home, ".config", "new.json"))).resolves.toBe(WRITABLE_PLACES);
    await expect(refusal(join(home, "Documents", ".hidden", "new.png"))).resolves.toBe(WRITABLE_PLACES);
    await expect(refusal(join(home, ".config"), "fresh")).resolves.toBe(WRITABLE_PLACES);
  });

  it("refuses what is not a local path", async () => {
    await expect(refusal("https://example.com/frame.png")).resolves.toBe(WRITABLE_PLACES);
    await expect(refusal("file:///tmp/frame.png")).resolves.toBe(WRITABLE_PLACES);
    await expect(refusal(`${project}/a\u0000b.png`)).resolves.toBe(WRITABLE_PLACES);
    await expect(refusal(`${project}/line\nbreak.png`)).resolves.toBe(WRITABLE_PLACES);
    await expect(refusal("\\\\server\\share\\frame.png")).resolves.toBe(WRITABLE_PLACES);
    await expect(refusal("   ")).resolves.toBe(WRITABLE_PLACES);
  });

  it("resolves a relative path against the base", async () => {
    await expect(refusal("exports/relative.mp4")).resolves.toBeNull();
    await expect(refusal("../../../elsewhere/new.png")).resolves.toBe(WRITABLE_PLACES);
    await expect(refusal("exports/relative.mp4", "file", { base: elsewhere })).resolves.toBe(WRITABLE_PLACES);
  });

  it("judges a path by where its symlinks lead", async () => {
    const links = join(project, "links");
    mkdirSync(links, { recursive: true });
    symlinkSync(elsewhere, join(links, "outside-dir"));
    symlinkSync(join(home, "Documents", "notes.txt"), join(links, "user-file.txt"));
    symlinkSync(join(project, ".git"), join(links, "git"));
    symlinkSync(join(home, "Movies"), join(links, "movies"));
    symlinkSync(join(elsewhere, "missing.png"), join(links, "dangling.png"));
    symlinkSync(join(project, "missing.png"), join(links, "dangling-inside.png"));
    symlinkSync(join(project, "exports"), join(home, "Documents", ".hidden-link"));

    await expect(refusal(join(links, "outside-dir", "new.png"))).resolves.toBe(WRITABLE_PLACES);
    await expect(refusal(join(links, "outside-dir", "existing.txt"))).resolves.toBe(REPLACE_OUTSIDE);
    await expect(refusal(join(links, "user-file.txt"))).resolves.toBe(REPLACE_OUTSIDE);
    await expect(refusal(join(links, "git", "config"))).resolves.toBe(protectedMessage(".git"));
    // A new file a project link leads to in a content folder is still a new file.
    await expect(refusal(join(links, "movies", "cut.mp4"))).resolves.toBeNull();
    // A dangling link is not a new file, wherever it points.
    await expect(refusal(join(links, "dangling.png"))).resolves.toBe(WRITABLE_PLACES);
    await expect(refusal(join(links, "dangling-inside.png"))).resolves.toBe(WRITABLE_PLACES);
    // Through a hidden link into the project: the project is where it lands.
    await expect(refusal(join(home, "Documents", ".hidden-link", "new.mp4"))).resolves.toBeNull();
  });

  it("omits the project root when none is open", async () => {
    await expect(refusal(join(project, "exports", "new.mp4"), "file", { project: null })).resolves.toBeNull();
    await expect(refusal(join(project, "exports", "intro.mp4"), "file", { project: null })).resolves.toBe(REPLACE_OUTSIDE);
    await expect(refusal(join(elsewhere, "new.png"), "file", { project: null })).resolves.toBe(WRITABLE_PLACES);
  });

  it("omits a project folder that no longer exists", async () => {
    await expect(refusal(join(elsewhere, "new.png"), "file", { project: join(root, "gone") })).resolves.toBe(WRITABLE_PLACES);
  });

  describe("existing folders", () => {
    it("takes a fresh file into an existing content folder", async () => {
      await expect(refusal(join(home, "Desktop"), "fresh")).resolves.toBeNull();
      await expect(refusal(join(home, "Documents"), "fresh")).resolves.toBeNull();
      await expect(refusal(elsewhere, "fresh")).resolves.toBe(WRITABLE_PLACES);
    });

    it("refuses an existing file where a fresh one may go", async () => {
      await expect(refusal(join(home, "Documents", "notes.txt"), "fresh")).resolves.toBe(REPLACE_OUTSIDE);
    });

    it("takes frames into a content folder unless frames of the same names could be replaced", async () => {
      const shots = join(home, "Pictures", "shots");
      mkdirSync(shots, { recursive: true });
      writeFileSync(join(shots, "holiday.png"), "");
      await expect(refusal(shots, "frames")).resolves.toBeNull();
      await expect(refusal(join(home, "Pictures", "new-shots"), "frames")).resolves.toBeNull();
      writeFileSync(join(shots, "08s10f.png"), "");
      await expect(refusal(shots, "frames")).resolves.toBe(REPLACE_OUTSIDE);
      const sheets = join(home, "Desktop", "sheets");
      mkdirSync(sheets, { recursive: true });
      writeFileSync(join(sheets, "0f-01m02s03f.PNG"), "");
      await expect(refusal(sheets, "frames")).resolves.toBe(REPLACE_OUTSIDE);
    });

    it("replaces frames inside the project freely", async () => {
      const frames = join(project, "frames");
      mkdirSync(frames, { recursive: true });
      writeFileSync(join(frames, "0f.png"), "");
      await expect(refusal(frames, "frames")).resolves.toBeNull();
    });

    it("refuses a plain file target that is an existing folder outside", async () => {
      await expect(refusal(join(home, "Desktop"), "file")).resolves.toBe(REPLACE_OUTSIDE);
    });
  });

  describe("numbered outputs", () => {
    const downloads = join(home, "Downloads");
    writeFileSync(join(downloads, "fox.jpg"), "");
    writeFileSync(join(downloads, "wolf-2.webp"), "");
    writeFileSync(join(downloads, "foxes.png"), "");

    it("refuses a name whose extension or numbering could land on an existing file", async () => {
      await expect(refusal(join(downloads, "fox.png"), "numbered")).resolves.toBe(REPLACE_OUTSIDE);
      await expect(refusal(join(downloads, "fox"), "numbered")).resolves.toBe(REPLACE_OUTSIDE);
      await expect(refusal(join(downloads, "wolf.png"), "numbered")).resolves.toBe(REPLACE_OUTSIDE);
    });

    it("allows a name nothing there shares", async () => {
      await expect(refusal(join(downloads, "fo.png"), "numbered")).resolves.toBeNull();
      await expect(refusal(join(downloads, "bear.png"), "numbered")).resolves.toBeNull();
      await expect(refusal(join(downloads, "new", "fox.png"), "numbered")).resolves.toBeNull();
    });

    it("lets the project's own files be replaced", async () => {
      writeFileSync(join(project, "assets", "fox.jpg"), "");
      await expect(refusal(join(project, "assets", "fox.png"), "numbered")).resolves.toBeNull();
    });
  });
});

/** A project folder of its own, pinned as main pins it when the editor opens it. */
function opened(name: string, parent = join(home, "Movies")): WritePolicy & { project: string } {
  const dir = join(parent, name);
  mkdirSync(join(dir, "exports"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ projectId: name, main: "index.tsx" }));
  return { ...policy, project: dir, pinned: pinProject(dir), base: dir };
}

describe("the open project", () => {
  it("is written freely while its folder is where it was opened", async () => {
    const show = opened("Pinned Show");
    writeFileSync(join(show.project, "cut.mp4"), "");
    await expect(writeRefusal(join(show.project, "cut.mp4"), "file", show)).resolves.toBeNull();
    await expect(stillPinned(show.project, show.pinned)).resolves.toBe(true);
  });

  it("is no project once its folder is swapped for a link, so the link's target is not writable through it", async () => {
    const show = opened("swapped", temp);
    writeFileSync(join(home, "Documents", "thesis.docx"), "PRECIOUS");
    writeFileSync(join(home, ".zshrc"), "");
    renameSync(show.project, join(temp, "swapped-away"));
    symlinkSync(home, show.project);

    // What the link leads to is judged as with no project open.
    await expect(writeRefusal(join(home, "Documents", "thesis.docx"), "fresh", show)).resolves.toBe(REPLACE_OUTSIDE);
    await expect(writeRefusal(join(home, ".zshrc"), "file", show)).resolves.toBe(REPLACE_OUTSIDE);
    await expect(writeRefusal(join(home, "Movies", "new-cut.mp4"), "file", show)).resolves.toBeNull();
    // Through the project's own path, the refusal says what happened.
    await expect(writeRefusal(join(show.project, "Documents", "thesis.docx"), "file", show)).resolves.toBe(PROJECT_MOVED);
    await expect(writeRefusal(join(show.project, "new.json"), "fresh", show)).resolves.toBe(PROJECT_MOVED);
    await expect(writeRefusal(join(show.pinned!, "new.json"), "fresh", show)).resolves.toBe(PROJECT_MOVED);
    await expect(stillPinned(show.project, show.pinned)).resolves.toBe(false);
    // Opening it again is judged where it leads now.
    await expect(openRefusal(show.project, show)).resolves.toBe(OPEN_PLACES);
  });

  it("is no project once its folder is replaced, even by a link to the same files", async () => {
    const show = opened("Relinked Show");
    writeFileSync(join(show.project, "cut.mp4"), "");
    renameSync(show.project, join(home, "Movies", "Relinked Show Real"));
    symlinkSync(join(home, "Movies", "Relinked Show Real"), show.project);
    await expect(writeRefusal(join(show.project, "cut.mp4"), "file", show)).resolves.toBe(PROJECT_MOVED);
    await expect(checkToolOutputs("export", { id: "intro" }, show)).rejects.toThrow(PROJECT_MOVED);
    // The renderer's tools write into the project by its path, so none runs but `open`, the way back,
    // here to where the project went.
    await expect(checkToolOutputs("captions", { id: "intro" }, show)).rejects.toThrow(PROJECT_MOVED);
    await expect(checkToolOutputs("open", { dir: join(home, "Movies", "Relinked Show Real") }, show)).resolves.toBeUndefined();
    await expect(checkToolOutputs("logs", {}, show)).resolves.toBeUndefined();
  });

  it("is no project when its folder is gone, or was never pinned", async () => {
    const show = opened("Unpinned Show");
    writeFileSync(join(show.project, "cut.mp4"), "");
    await expect(writeRefusal(join(show.project, "cut.mp4"), "file", { ...show, pinned: null })).resolves.toBe(PROJECT_MOVED);
    await expect(stillPinned(show.project, null)).resolves.toBe(false);
    await expect(stillPinned(join(root, "gone"), pinProject(join(root, "gone")))).resolves.toBe(false);
  });

  it("is no project when it holds the home folder, however it was opened", async () => {
    const whole: WritePolicy = { ...policy, project: home, pinned: pinProject(home) };
    await expect(writeRefusal(join(home, "Documents", "notes.txt"), "file", whole)).resolves.toBe(REPLACE_OUTSIDE);
    await expect(writeRefusal(join(home, "Library", "new.png"), "file", whole)).resolves.toBe(WRITABLE_PLACES);
  });
});

describe("checkToolOutputs", () => {
  const refused = async (tool: string, args: unknown, options: Partial<WritePolicy> = {}) => {
    try {
      await checkToolOutputs(tool, args, { ...policy, ...options });
      return null;
    } catch (error) {
      expect(isDapiError(error)).toBe(true);
      expect((error as { code: string }).code).toBe("invalid-input");
      return (error as Error).message;
    }
  };

  it("checks every tool's output before it runs", async () => {
    await expect(refused("capture", { id: "intro", output: join(project, "frames") })).resolves.toBeNull();
    await expect(refused("capture", { id: "intro", output: join(elsewhere, "frames") })).resolves.toBe(WRITABLE_PLACES);
    await expect(refused("grab", { path: "clip.mp4", output: join(project, ".git", "frames") })).resolves.toBe(protectedMessage(".git"));
    await expect(refused("screenshot", { output: join(home, "Desktop") })).resolves.toBeNull();
    await expect(refused("transcribe", { path: "clip.mp4", output: join(home, "Documents", "notes.txt") })).resolves.toBe(REPLACE_OUTSIDE);
    await expect(refused("waveform", { path: "clip.mp4", output: join(home, "Documents") })).resolves.toBeNull();
    await expect(refused("someday_tool", { output: join(home, "Documents") })).resolves.toBe(REPLACE_OUTSIDE);
  });

  it("resolves a main-written relative output against the base", async () => {
    await expect(refused("filmstrip", { path: "clip.mp4", output: "strip.png" }, { base: elsewhere })).resolves.toBe(WRITABLE_PLACES);
  });

  it("checks export's path, leaving a relative one to the export tool", async () => {
    await expect(refused("export", { id: "intro", path: join(project, "exports", "intro.mp4") })).resolves.toBeNull();
    await expect(refused("export", { id: "intro", path: join(home, "Movies", "intro.mp4") })).resolves.toBeNull();
    await expect(refused("export", { id: "intro", path: join(elsewhere, "existing.txt") })).resolves.toBe(REPLACE_OUTSIDE);
    await expect(refused("export", { id: "intro", path: join(project, ".cutroom", "intro.mp4") })).resolves.toBe(protectedMessage(".cutroom"));
    await expect(refused("export", { id: "intro", path: "https://example.com/intro.mp4" })).resolves.toBe(WRITABLE_PLACES);
    await expect(refused("export", { id: "intro", path: "exports/intro.mp4" }, { base: elsewhere })).resolves.toBeNull();
    await expect(refused("export", { id: "intro" })).resolves.toBeNull();
  });

  describe("export without a path", () => {
    it("writes into the project's exports folder, made or not", async () => {
      await expect(refused("export", { id: "intro" })).resolves.toBeNull();
      const show = opened("No Exports Yet");
      rmSync(join(show.project, "exports"), { recursive: true });
      await expect(refused("export", { id: "intro" }, show)).resolves.toBeNull();
      await expect(refused("export", { id: "intro" }, { project: null })).resolves.toBeNull();
    });

    it("refuses an exports folder that leads outside the project", async () => {
      const show = opened("Linked Exports");
      rmSync(join(show.project, "exports"), { recursive: true });
      symlinkSync(join(home, "Movies"), join(show.project, "exports"));
      await expect(refused("export", { id: "intro" }, show)).resolves.toBe(EXPORTS_OUTSIDE);
      // As the explicit path to the same file would be.
      writeFileSync(join(home, "Movies", "wedding.mp4"), "");
      await expect(refused("export", { id: "wedding", path: join(show.project, "exports", "wedding.mp4") }, show)).resolves.toBe(REPLACE_OUTSIDE);
    });

    it("refuses a dangling exports link, and one into a protected folder", async () => {
      const show = opened("Odd Exports");
      rmSync(join(show.project, "exports"), { recursive: true });
      symlinkSync(join(elsewhere, "missing"), join(show.project, "exports"));
      await expect(refused("export", { id: "intro" }, show)).resolves.toBe(EXPORTS_OUTSIDE);
      rmSync(join(show.project, "exports"));
      mkdirSync(join(show.project, ".git"));
      symlinkSync(join(show.project, ".git"), join(show.project, "exports"));
      await expect(refused("export", { id: "intro" }, show)).resolves.toBe(protectedMessage(".git"));
    });

    it("takes an exports folder linked elsewhere in the project", async () => {
      const show = opened("Renders Show");
      rmSync(join(show.project, "exports"), { recursive: true });
      mkdirSync(join(show.project, "renders"));
      symlinkSync(join(show.project, "renders"), join(show.project, "exports"));
      await expect(refused("export", { id: "intro" }, show)).resolves.toBeNull();
    });
  });

  it("leaves other tools' paths alone: those are read", async () => {
    await expect(refused("probe", { path: join(home, ".ssh", "id_ed25519") })).resolves.toBeNull();
    await expect(refused("footage_index", { paths: [join(elsewhere, "existing.txt")] })).resolves.toBeNull();
  });

  it("puts a generate library path under the project's assets", async () => {
    await expect(refused("generate", { model: "sam-2.1", output: "b-roll/fox.png" })).resolves.toBeNull();
    await expect(refused("generate", { model: "sam-2.1", output: "../.cutroom/fox.png" })).resolves.toBe(protectedMessage(".cutroom"));
    await expect(refused("generate", { model: "sam-2.1", output: "../../../../elsewhere/fox.png" })).resolves.toBe(WRITABLE_PLACES);
    // With no project open the renderer refuses a library path itself.
    await expect(refused("generate", { model: "sam-2.1", output: "b-roll/fox.png" }, { project: null })).resolves.toBeNull();
  });

  it("checks a generate disk path with the numbering it could get", async () => {
    await expect(refused("generate", { model: "sam-2.1", output: join(home, "Downloads", "fox.webp") })).resolves.toBe(REPLACE_OUTSIDE);
    await expect(refused("generate", { model: "flux-2-klein", output: join(home, "Downloads", "lynx.webp") })).resolves.toBeNull();
  });

  it("says with a hosted model's refused output that hosted generation must be configured too", async () => {
    await expect(refused("generate", { model: "flux-2-klein", output: join(home, "Downloads", "fox.webp") })).resolves.toBe(
      `${REPLACE_OUTSIDE} ${HOSTED_NOTE}`,
    );
    await expect(refused("generate", { model: "flux-2-klein", output: "https://example.com/fox.png" })).resolves.toBe(
      `${WRITABLE_PLACES} ${HOSTED_NOTE}`,
    );
    expect(HOSTED_NOTE).toContain("web_media_search");
  });

  it("checks the folder open would make the project", async () => {
    await expect(refused("open", { dir: project })).resolves.toBeNull();
    await expect(refused("open", { dir: home })).resolves.toBe(OPEN_PLACES);
    await expect(refused("open", { dir: join(project, ".git") })).resolves.toBe(protectedMessage(".git"));
  });

  it("ignores calls without outputs", async () => {
    await expect(refused("context", {})).resolves.toBeNull();
    await expect(refused("context", undefined)).resolves.toBeNull();
    await expect(refused("capture", { id: "intro" })).resolves.toBeNull();
    await expect(refused("capture", { id: "intro", output: 42 })).resolves.toBeNull();
  });
});

describe("media_download's folder", () => {
  const none: WritePolicy = { project: null, pinned: null, home, temp: [temp] };

  it("judges an absolute folder as a place a new file is made in", async () => {
    await expect(checkToolOutputs("media_download", { url: "https://youtu.be/x", folder: join(home, "Music") }, none)).resolves.toBeUndefined();
    await expect(checkToolOutputs("media_download", { url: "https://youtu.be/x", folder: join(home, "Music", "Blackout", "new") }, none)).resolves.toBeUndefined();
    await expect(checkToolOutputs("media_download", { url: "https://youtu.be/x", folder: join(home, "Library") }, none)).rejects.toThrow(WRITABLE_PLACES);
    await expect(checkToolOutputs("media_download", { url: "https://youtu.be/x", folder: join(home, ".ssh") }, none)).rejects.toThrow(WRITABLE_PLACES);
    await expect(checkToolOutputs("media_download", { url: "https://youtu.be/x", folder: join(project, ".git") }, policy)).rejects.toThrow(/off-limits/);
  });

  it("leaves a library folder to the download, which keeps it in the project", async () => {
    await expect(checkToolOutputs("media_download", { url: "https://youtu.be/x", folder: "music" }, none)).resolves.toBeUndefined();
    await expect(checkToolOutputs("media_download", { url: "https://youtu.be/x", folder: "b-roll/city" }, policy)).resolves.toBeUndefined();
  });
});

describe("openRefusal", () => {
  const show = join(home, "Movies", "Existing Show");
  const footage = join(home, "Movies", "Footage");
  const empty = join(home, "Movies", "Empty");
  const draft = join(home, "Library", "Application Support", "Cutroom", "Drafts", "draft-id");
  const external = join(elsewhere, "Volume Show");
  for (const dir of [show, footage, empty, draft, external]) mkdirSync(dir, { recursive: true });
  for (const dir of [show, draft, external]) {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ projectId: "id", main: "index.tsx" }));
    writeFileSync(join(dir, "index.tsx"), "");
  }
  writeFileSync(join(footage, "wedding.mov"), "");
  writeFileSync(join(footage, "package.json"), JSON.stringify({ name: "not-a-project" }));
  writeFileSync(join(empty, ".DS_Store"), "");
  // A record planted in a content folder itself does not make it openable.
  writeFileSync(join(home, "Music", "package.json"), JSON.stringify({ projectId: "planted" }));
  writeFileSync(join(home, "Music", "index.tsx"), "");

  const opening = (dir: string, options: Partial<WritePolicy> = {}) => openRefusal(dir, { ...policy, ...options });

  it("opens the project again, by either spelling", async () => {
    await expect(opening(project)).resolves.toBeNull();
    await expect(opening(join(project, "exports", ".."))).resolves.toBeNull();
  });

  it("opens an existing Blackout project wherever it is", async () => {
    await expect(opening(show)).resolves.toBeNull();
    await expect(opening(draft)).resolves.toBeNull();
    await expect(opening(external)).resolves.toBeNull();
    await expect(opening(show, { project: null })).resolves.toBeNull();
  });

  it("opens a new or empty folder where a new file could go", async () => {
    await expect(opening(join(home, "Movies", "New Show"))).resolves.toBeNull();
    await expect(opening(join(home, "Desktop", "a", "b"))).resolves.toBeNull();
    await expect(opening(empty)).resolves.toBeNull();
    await expect(opening(join(temp, "scratch-project"))).resolves.toBeNull();
    await expect(opening(join(home, "Movies", "New Show"), { project: null })).resolves.toBeNull();
  });

  it("opens any folder in the project or a temp folder, where tools write anyway", async () => {
    await expect(opening(join(project, "exports"))).resolves.toBeNull();
    await expect(opening(join(project, "nested", "show"))).resolves.toBeNull();
  });

  it("refuses an existing folder that is not a project, so its files stay out of reach, and says how to open it instead", async () => {
    await expect(opening(footage)).resolves.toBe(OPEN_EXISTING);
    await expect(opening(elsewhere)).resolves.toBe(OPEN_EXISTING);
    await expect(opening(join(home, "Library"))).resolves.toBe(OPEN_EXISTING);
    expect(OPEN_EXISTING).toContain("dashboard");
    expect(OPEN_EXISTING).toContain("copy its files into a new folder");
  });

  it("refuses the disk's root, the home folder and the folders holding it, and content and temp folders themselves", async () => {
    await expect(opening(home)).resolves.toBe(OPEN_PLACES);
    await expect(opening(root)).resolves.toBe(OPEN_PLACES);
    await expect(opening("/")).resolves.toBe(OPEN_PLACES);
    await expect(opening(join(home, "Movies"))).resolves.toBe(OPEN_PLACES);
    await expect(opening(join(home, "Music"))).resolves.toBe(OPEN_PLACES);
    await expect(opening(temp)).resolves.toBe(OPEN_PLACES);
  });

  it("refuses new folders anywhere else, and in hidden folders below home", async () => {
    await expect(opening(join(elsewhere, "new-show"))).resolves.toBe(OPEN_PLACES);
    await expect(opening(join(home, "new-show"))).resolves.toBe(OPEN_PLACES);
    await expect(opening(join(home, ".config", "show"))).resolves.toBe(OPEN_PLACES);
    await expect(opening(join(home, "Library", "Application Support", "Show"))).resolves.toBe(OPEN_PLACES);
  });

  it("refuses a path through a protected folder", async () => {
    await expect(opening(join(project, ".git"))).resolves.toBe(protectedMessage(".git"));
    await expect(opening(join(home, "Movies", "Show", ".claude"))).resolves.toBe(protectedMessage(".claude"));
  });

  it.runIf(foldsCase)("knows a protected or content folder however it is capitalized", async () => {
    await expect(opening(join(project, ".Cutroom"))).resolves.toBe(protectedMessage(".cutroom"));
    await expect(opening(join(home, "movies"))).resolves.toBe(OPEN_PLACES);
  });

  it("judges a folder by where its links lead", async () => {
    const links = join(project, "open-links");
    mkdirSync(links, { recursive: true });
    symlinkSync(join(home, "Movies"), join(links, "movies"));
    symlinkSync(footage, join(links, "footage"));
    symlinkSync(show, join(links, "show"));
    await expect(opening(join(links, "movies"))).resolves.toBe(OPEN_PLACES);
    await expect(opening(join(links, "footage"))).resolves.toBe(OPEN_EXISTING);
    await expect(opening(join(links, "show"))).resolves.toBeNull();
  });

  it("leaves a relative folder and a file to open itself, and refuses what is not a local path", async () => {
    await expect(opening("Show")).resolves.toBeNull();
    await expect(opening(join(home, "Documents", "notes.txt"))).resolves.toBeNull();
    await expect(opening("\\\\server\\share\\show")).resolves.toBe(OPEN_PLACES);
    await expect(opening(`${home}/Movies/a\u0000b`)).resolves.toBe(OPEN_PLACES);
  });
});

describe("guardToolOutputs", () => {
  it("refuses before the tool runs", async () => {
    const run = vi.fn(async () => []);
    await expect(guardToolOutputs("capture", { id: "intro", output: join(elsewhere, "frames") }, policy, run)).rejects.toThrow(WRITABLE_PLACES);
    expect(run).not.toHaveBeenCalled();
  });

  it("runs an allowed tool and hands back its result", async () => {
    const result = { segments: [] };
    await expect(guardToolOutputs("transcribe", { path: "clip.mp4", output: join(project, "intro.json") }, policy, async () => result)).resolves.toBe(result);
  });

  it("checks again after the tool ran, before its files are written: a link planted meanwhile is not followed", async () => {
    const transcript = join(project, "planted.json");
    await expect(
      guardToolOutputs("transcribe", { path: "clip.mp4", output: transcript }, policy, async () => {
        symlinkSync(join(home, "Documents", "notes.txt"), transcript);
        return { segments: [] };
      }),
    ).rejects.toThrow(REPLACE_OUTSIDE);

    const frames = join(project, "planted-frames");
    await expect(
      guardToolOutputs("capture", { id: "intro", output: frames }, policy, async () => {
        symlinkSync(elsewhere, frames);
        return [];
      }),
    ).rejects.toThrow(WRITABLE_PLACES);
  });

  it("does not check again a tool that wrote its own file", async () => {
    const cut = join(home, "Movies", "guarded-cut.mp4");
    await expect(
      guardToolOutputs("export", { id: "intro", path: cut }, policy, async () => {
        writeFileSync(cut, "");
        return { path: cut };
      }),
    ).resolves.toEqual({ path: cut });
  });
});
