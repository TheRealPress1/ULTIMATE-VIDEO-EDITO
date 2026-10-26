import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return { ...actual, copyFile: vi.fn(actual.copyFile) };
});
import { collectProject, relinkProjectMedia } from "./project-portability";
import { createProjectVersion, listProjectVersions, restoreProjectVersion } from "./project-versions";

let sandbox: string;
let project: string;
let media: string;
let destination: string;
const payload = "precious original footage";
const id = createHash("sha256").update(String(Buffer.byteLength(payload))).update(payload).digest("hex").slice(0, 16);
const read = (path: string): Promise<string> => fs.readFile(path, "utf8");
const write = (path: string, content: string): Promise<void> => fs.writeFile(path, content);
const manifest = (source: string) => ({ version: 1, folders: [], assets: [{ id, path: "Interview.mp4", source, type: "VIDEO", mimeType: "video/mp4", stat: { size: Buffer.byteLength(payload), mtime: 0 } }] });

beforeEach(async () => {
  sandbox = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "uve-portable-")));
  project = join(sandbox, "Project");
  media = join(sandbox, "Footage");
  destination = join(sandbox, "Collected");
  await fs.mkdir(project);
  await fs.mkdir(media);
  await write(join(media, "Interview.mp4"), payload);
  await write(join(project, "index.tsx"), 'export default () => <stage><scene><video src="Interview.mp4" /></scene></stage>;');
  await write(join(project, "package.json"), '{"projectId":"original-project","displayName":"Interview","main":"index.tsx","diffusion":{"fps":30}}');
  await write(join(project, "assets.yml"), stringifyYaml(manifest(join(media, "Interview.mp4"))));
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.mocked(fs.copyFile).mockReset();
  await fs.rm(sandbox, { recursive: true, force: true });
});

describe("collecting a portable project", () => {
  it("collects external footage and local captions, creates independent identity/history, and survives moving the original away", async () => {
    await fs.mkdir(join(project, "assets"));
    await write(join(project, "assets/captions.json"), '[{"text":"Hello","words":[]}]');
    const original = manifest(join(media, "Interview.mp4"));
    original.assets.push({ id: "captions", path: "Captions.json", source: "assets/captions.json", type: "TRANSCRIPT", mimeType: "application/json", stat: { size: 29, mtime: 0 } });
    await write(join(project, "assets.yml"), stringifyYaml(original));
    await createProjectVersion(project, { label: "Old history" });
    await fs.mkdir(join(project, "node_modules"));
    await write(join(project, "node_modules/not-portable.js"), "ignored dependency");
    await write(join(project, ".env"), "DO_NOT_COPY=example");
    const result = await collectProject(project, destination);
    expect(result).toMatchObject({ dir: destination, assetCount: 2 });
    expect(result.bytes).toBeGreaterThan(payload.length);
    const copied = parseYaml(await read(join(destination, "assets.yml")));
    expect(copied.assets[0].source).toMatch(/^assets\/collected\//);
    expect(copied.assets[1].source).toBe("assets/captions.json");
    expect(await read(join(destination, copied.assets[0].source))).toBe(payload);
    const pkg = JSON.parse(await read(join(destination, "package.json")));
    expect(pkg.projectId).not.toBe("original-project");
    expect(pkg.displayName).toBe("Interview Copy");
    expect(pkg.diffusion).toEqual({ fps: 30 });
    expect((await listProjectVersions(destination)).map((version) => version.label)).toEqual(["Collected project"]);
    await expect(fs.stat(join(destination, "node_modules"))).rejects.toHaveProperty("code", "ENOENT");
    await expect(fs.stat(join(destination, ".env"))).rejects.toHaveProperty("code", "ENOENT");
    await fs.rename(project, `${project}-moved`);
    await fs.rename(media, `${media}-moved`);
    expect(await read(join(destination, copied.assets[0].source))).toBe(payload);
    expect(parseYaml(await read(join(`${project}-moved`, "assets.yml"))).assets[0].source).toBe(join(media, "Interview.mp4"));
  }, 30_000);

  it("preserves direct project-relative media and local module imports", async () => {
    await fs.mkdir(join(project, "assets"));
    await fs.mkdir(join(project, "components"));
    await write(join(project, "assets/local.mp4"), "local bytes");
    await write(join(project, "components/title.tsx"), 'export const Title = () => <text>Hello</text>;');
    await write(join(project, "index.tsx"), 'import { Title } from "./components/title"; const src = "assets/local.mp4"; export default () => <stage><video src={src}/><Title/></stage>;');
    await collectProject(project, destination);
    expect(await read(join(destination, "assets/local.mp4"))).toBe("local bytes");
    expect(await read(join(destination, "components/title.tsx"))).toContain("Hello");
  }, 30_000);

  it("does not replace an existing destination or modify the original", async () => {
    await fs.mkdir(destination);
    await write(join(destination, "keep.txt"), "keep me");
    await expect(collectProject(project, destination)).rejects.toThrow("already exists");
    expect(await read(join(destination, "keep.txt"))).toBe("keep me");
    expect(JSON.parse(await read(join(project, "package.json"))).projectId).toBe("original-project");
  });

  it("rejects missing assets, direct external references, dynamic src, and external imports before creating a copy", async () => {
    await fs.rename(join(media, "Interview.mp4"), join(media, "moved.mp4"));
    await expect(collectProject(project, destination)).rejects.toThrow("Missing media");
    await fs.rename(join(media, "moved.mp4"), join(media, "Interview.mp4"));
    await write(join(project, "index.tsx"), `export default () => <video src=${JSON.stringify(join(media, "Interview.mp4"))}/>;`);
    await expect(collectProject(project, destination)).rejects.toThrow("direct external media reference");
    await write(join(project, "index.tsx"), "export default (props) => <video src={props.file}/>;");
    await expect(collectProject(project, destination)).rejects.toThrow("dynamic media references");
    await write(join(project, "index.tsx"), `const src = ${JSON.stringify(join(media, "Interview.mp4"))}; export const props = { src }; export default () => <text>Hello</text>;`);
    await expect(collectProject(project, destination)).rejects.toThrow("media reference");
    await write(join(project, "index.tsx"), 'import value from "some-unbundled-package"; export default () => <text>{value}</text>;');
    await expect(collectProject(project, destination)).rejects.toThrow("external dependency");
    await expect(fs.stat(destination)).rejects.toHaveProperty("code", "ENOENT");
  });

  it("rejects traversal and symlinked project files without reading or copying their targets", async () => {
    await write(join(project, "assets.yml"), stringifyYaml(manifest("../Footage/Interview.mp4")));
    await expect(collectProject(project, destination)).rejects.toThrow("Unsafe project asset path");
    await write(join(project, "assets.yml"), stringifyYaml(manifest(join(media, "Interview.mp4"))));
    await fs.symlink(join(media, "Interview.mp4"), join(project, "linked.mp4"));
    await expect(collectProject(project, destination)).rejects.toThrow("symbolic link");
    await expect(fs.stat(destination)).rejects.toHaveProperty("code", "ENOENT");
  });

  it("cleans up partial copies after a media write failure", async () => {
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(fs.copyFile).mockImplementation(async (source, target, mode) => {
      if (String(source).endsWith("Interview.mp4")) throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
      await actual.copyFile(source, target, mode);
    });
    await expect(collectProject(project, destination)).rejects.toThrow("disk full");
    await expect(fs.stat(destination)).rejects.toHaveProperty("code", "ENOENT");
    expect((await fs.readdir(sandbox)).filter((name) => name.startsWith(".dstmp-collect"))).toEqual([]);
    expect(await read(join(media, "Interview.mp4"))).toBe(payload);
  });

  it("detects a file changed during collection and leaves no incomplete project", async () => {
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(fs.copyFile).mockImplementation(async (source, target, mode) => {
      await actual.copyFile(source, target, mode);
      if (String(source).endsWith("Interview.mp4")) await fs.appendFile(source, " changed");
    });
    await expect(collectProject(project, destination)).rejects.toThrow("changed during collection");
    await expect(fs.stat(destination)).rejects.toHaveProperty("code", "ENOENT");
  });

  it("preserves a destination someone creates while collection is running", async () => {
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(fs.copyFile).mockImplementation(async (source, target, mode) => {
      await actual.copyFile(source, target, mode);
      if (String(source).endsWith("Interview.mp4")) {
        await fs.mkdir(destination);
        await write(join(destination, "user-file.txt"), "do not replace");
      }
    });
    await expect(collectProject(project, destination)).rejects.toHaveProperty("code", "EEXIST");
    expect(await read(join(destination, "user-file.txt"))).toBe("do not replace");
    expect((await fs.readdir(sandbox)).filter((name) => name.startsWith(".dstmp-collect"))).toEqual([]);
  });

  it("collects image-sequence folders with relative source paths", async () => {
    const frames = join(media, "frames");
    await fs.mkdir(frames);
    await write(join(frames, "0001.png"), "frame 1");
    await write(join(frames, "0002.png"), "frame 2");
    const value = manifest(frames);
    value.assets[0].type = "SEQUENCE";
    await write(join(project, "assets.yml"), stringifyYaml(value));
    await collectProject(project, destination);
    const copied = parseYaml(await read(join(destination, "assets.yml")));
    expect(await read(join(destination, copied.assets[0].source, "0002.png"))).toBe("frame 2");
  });
});

describe("batch media relinking", () => {
  async function disconnect(): Promise<string> {
    const search = join(sandbox, "Moved footage");
    await fs.rename(media, search);
    return search;
  }

  async function applyPreview(search: string) {
    const preview = await relinkProjectMedia(project, search);
    return relinkProjectMedia(project, search, true, preview.previewToken);
  }

  it("previews and applies verified matches, preserving IDs and keeping restorable history", async () => {
    const search = await disconnect();
    const before = await read(join(project, "assets.yml"));
    const preview = await relinkProjectMedia(project, search);
    expect(preview.applied).toBe(false);
    expect(preview.planned).toEqual([{ id, path: "Interview.mp4", previousSource: join(media, "Interview.mp4"), source: join(search, "Interview.mp4") }]);
    expect(await read(join(project, "assets.yml"))).toBe(before);
    expect((await relinkProjectMedia(project, search)).previewToken).toBe(preview.previewToken);
    const result = await relinkProjectMedia(project, search, true, preview.previewToken);
    expect(result.applied).toBe(true);
    const linked = parseYaml(await read(join(project, "assets.yml")));
    expect(linked.assets[0]).toMatchObject({ id, source: join(search, "Interview.mp4") });
    const versions = await listProjectVersions(project);
    const original = versions.find((version) => version.label === "Before relinking media")!;
    await restoreProjectVersion(project, original.id);
    expect(parseYaml(await read(join(project, "assets.yml"))).assets[0].source).toBe(join(media, "Interview.mp4"));
  });

  it("refuses ambiguous identical candidates and wrong same-name footage", async () => {
    const search = await disconnect();
    await fs.mkdir(join(search, "Duplicate"));
    await write(join(search, "Duplicate/Interview.mp4"), payload);
    let result = await applyPreview(search);
    expect(result.planned).toEqual([]);
    expect(result.ambiguous[0].candidates).toHaveLength(2);
    expect(result.applied).toBe(false);
    await fs.rm(join(search, "Duplicate"), { recursive: true });
    await write(join(search, "Interview.mp4"), "x".repeat(payload.length));
    result = await applyPreview(search);
    expect(result.planned).toEqual([]);
    expect(result.missing).toHaveLength(1);
    expect(parseYaml(await read(join(project, "assets.yml"))).assets[0].source).toBe(join(media, "Interview.mp4"));
  });

  it("keeps existing links and ignores symlink escape candidates", async () => {
    expect((await applyPreview(media)).planned).toEqual([]);
    const search = await disconnect();
    const candidate = join(search, "Interview.mp4");
    const elsewhere = join(sandbox, "elsewhere.mp4");
    await fs.rename(candidate, elsewhere);
    await fs.symlink(elsewhere, candidate);
    const result = await applyPreview(search);
    expect(result.missing[0].path).toBe("Interview.mp4");
    expect(result.applied).toBe(false);
  });

  it("uses a project-relative link when the matching media is inside the project", async () => {
    const search = join(project, "recovered");
    await fs.mkdir(search);
    await fs.rename(join(media, "Interview.mp4"), join(search, "Interview.mp4"));
    const result = await applyPreview(search);
    expect(result.planned[0].source).toBe("recovered/Interview.mp4");
    expect(basename(result.planned[0].source)).toBe("Interview.mp4");
  });

  it("requires a reviewed preview before applying", async () => {
    const search = await disconnect();
    const before = await read(join(project, "assets.yml"));
    await expect(relinkProjectMedia(project, search, true)).rejects.toThrow("review the matches");
    expect(await read(join(project, "assets.yml"))).toBe(before);
    expect(await listProjectVersions(project)).toEqual([]);
  });

  it("does not apply newly discovered matches that were absent from the preview", async () => {
    const search = await disconnect();
    const value = manifest(join(media, "Interview.mp4"));
    const second = "second interview footage";
    const secondId = createHash("sha256").update(String(Buffer.byteLength(second))).update(second).digest("hex").slice(0, 16);
    value.assets.push({ ...value.assets[0], id: secondId, path: "Second.mp4", source: join(media, "Second.mp4"), stat: { size: Buffer.byteLength(second), mtime: 0 } });
    await write(join(project, "assets.yml"), stringifyYaml(value));
    const before = await read(join(project, "assets.yml"));
    const preview = await relinkProjectMedia(project, search);
    expect(preview.planned).toHaveLength(1);
    expect(preview.missing).toHaveLength(1);
    await write(join(search, "Second.mp4"), second);
    await expect(relinkProjectMedia(project, search, true, preview.previewToken)).rejects.toThrow("changed since your preview");
    expect(await read(join(project, "assets.yml"))).toBe(before);
    expect(await listProjectVersions(project)).toEqual([]);
    expect((await applyPreview(search)).planned).toHaveLength(2);
  });

  it("requires a new preview when the manifest or selected search folder changes", async () => {
    const search = await disconnect();
    const preview = await relinkProjectMedia(project, search);
    const changed = manifest(join(media, "Interview.mp4"));
    changed.assets[0].path = "Renamed interview.mp4";
    await write(join(project, "assets.yml"), stringifyYaml(changed));
    await expect(relinkProjectMedia(project, search, true, preview.previewToken)).rejects.toThrow("changed since your preview");
    const updated = await relinkProjectMedia(project, search);
    const other = join(sandbox, "Other footage");
    await fs.mkdir(other);
    await write(join(other, "Interview.mp4"), payload);
    await expect(relinkProjectMedia(project, other, true, updated.previewToken)).rejects.toThrow("changed since your preview");
    expect(parseYaml(await read(join(project, "assets.yml"))).assets[0]).toMatchObject(changed.assets[0]);
  });

  it("requires a new preview when a reviewed candidate is replaced", async () => {
    const search = await disconnect();
    const preview = await relinkProjectMedia(project, search);
    const candidate = join(search, "Interview.mp4");
    await fs.rename(candidate, join(search, "saved-original.mp4"));
    await write(candidate, payload);
    await expect(relinkProjectMedia(project, search, true, preview.previewToken)).rejects.toThrow("changed since your preview");
    expect(parseYaml(await read(join(project, "assets.yml"))).assets[0].source).toBe(join(media, "Interview.mp4"));
  });

  it("never identifies older assets by filename and size alone", async () => {
    const search = await disconnect();
    const old = manifest(join(media, "Interview.mp4"));
    old.assets[0].id = "legacy-asset-id";
    await write(join(project, "assets.yml"), stringifyYaml(old));
    await write(join(search, "Interview.mp4"), "x".repeat(payload.length));
    const result = await applyPreview(search);
    expect(result.planned).toEqual([]);
    expect(result.missing[0].reason).toContain("no recorded content identity");
    expect(result.applied).toBe(false);
    expect(parseYaml(await read(join(project, "assets.yml"))).assets[0]).toMatchObject(old.assets[0]);
  });

  it.each([
    ["manifest", "The asset library changed during relinking"],
    ["candidate", "Media changed during relinking"],
    ["original", "An original file reappeared during relinking"],
  ])("rechecks the %s after creating the recovery checkpoint", async (change, message) => {
    const search = await disconnect();
    const before = await read(join(project, "assets.yml"));
    const externalManifest = `${before}# Saved by another editor during the checkpoint\n`;
    const preview = await relinkProjectMedia(project, search);
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    let changed = false;
    vi.spyOn(fs, "rename").mockImplementation(async (source, target) => {
      await actual.rename(source, target);
      if (!changed && String(target).startsWith(join(project, ".cutroom/versions/")) && String(target).endsWith(".json")) {
        changed = true;
        if (change === "manifest") await write(join(project, "assets.yml"), externalManifest);
        if (change === "candidate") await fs.appendFile(join(search, "Interview.mp4"), " changed externally");
        if (change === "original") {
          await fs.mkdir(media);
          await write(join(media, "Interview.mp4"), payload);
        }
      }
    });

    await expect(relinkProjectMedia(project, search, true, preview.previewToken)).rejects.toThrow(message);
    expect(changed).toBe(true);
    expect(await read(join(project, "assets.yml"))).toBe(change === "manifest" ? externalManifest : before);
    if (change === "candidate") expect(await read(join(search, "Interview.mp4"))).toBe(`${payload} changed externally`);
    if (change === "original") expect(await read(join(media, "Interview.mp4"))).toBe(payload);
    expect((await listProjectVersions(project)).map((version) => version.label)).toEqual(["Before relinking media"]);
  });
});
