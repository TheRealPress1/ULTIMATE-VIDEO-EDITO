import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return { ...actual, rename: vi.fn(actual.rename) };
});
import {
  createProjectVersion, listProjectVersions, PROJECT_VERSION_LIMIT,
  projectVersionFingerprint, recoverProjectVersionRestore, restoreProjectVersion,
} from "./project-versions";

let dir: string;
const source = "export default () => <stage><scene id='first'/></stage>;\n";
const manifest = "version: 1\nassets:\n  - type: TRANSCRIPT\n    source: assets/captions.json\n  - type: VIDEO\n    source: assets/original.mp4\n";
const read = (path: string): Promise<string> => fs.readFile(join(dir, path), "utf8");
const write = (path: string, content: string): Promise<void> => fs.writeFile(join(dir, path), content);

beforeEach(async () => {
  dir = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "uve-versions-")));
  await fs.mkdir(join(dir, "assets"));
  await write("index.tsx", source);
  await write("assets.yml", manifest);
  await write("assets/captions.json", '{"words":["original"]}');
  await write("assets/original.mp4", "original footage bytes");
  await write("package.json", '{"projectId":"unchanging","displayName":"My edit"}');
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.mocked(fs.rename).mockReset();
  await fs.rm(dir, { recursive: true, force: true });
});

describe("persistent project versions", () => {
  it("survives module restart and project moves, capturing editing files without original footage", async () => {
    await fs.mkdir(join(dir, "components"));
    await write("components/title.tsx", "export const Title = () => <text>Hello</text>;");
    const version = await createProjectVersion(dir, { kind: "manual", label: "First edit" });
    const stored = await read(`.cutroom/versions/${version.id}.json`);
    expect(JSON.parse(stored).files.map((file: { path: string }) => file.path)).toEqual([
      "@project-settings.json", "assets.yml", "assets/captions.json", "components/title.tsx", "index.tsx",
    ]);
    expect(stored).not.toContain("original footage bytes");
    expect(version.fileCount).toBe(5);
    vi.resetModules();
    const restarted = await import("./project-versions");
    const moved = `${dir}-moved`;
    await fs.rename(dir, moved);
    dir = moved;
    expect(await restarted.listProjectVersions(dir)).toEqual([version]);
  });

  it("restores source, captions, and manifest together, and retains a reversible before-restore version", async () => {
    const version = await createProjectVersion(dir, { label: "Original" });
    await write("index.tsx", "new source");
    await write("assets/captions.json", '{"words":["edited"]}');
    await write("assets.yml", manifest + "    id: changed\n");
    await write("added.tsx", "new component");
    const fingerprint = await projectVersionFingerprint(dir);
    const restored = await restoreProjectVersion(dir, version.id, { expectedFingerprint: fingerprint });
    expect(await read("index.tsx")).toBe(source);
    expect(await read("assets.yml")).toBe(manifest);
    expect(await read("assets/captions.json")).toBe('{"words":["original"]}');
    await expect(read("added.tsx")).rejects.toHaveProperty("code", "ENOENT");
    expect(await read("assets/original.mp4")).toBe("original footage bytes");
    expect(await read("package.json")).toBe('{"projectId":"unchanging","displayName":"My edit"}');
    expect(restored.checkpoint.kind).toBe("before-restore");
    await restoreProjectVersion(dir, restored.checkpoint.id);
    expect(await read("index.tsx")).toBe("new source");
    expect(await read("assets/captions.json")).toBe('{"words":["edited"]}');
    expect(await read("added.tsx")).toBe("new component");
  });

  it("rejects stale restore requests before making changes", async () => {
    const version = await createProjectVersion(dir);
    const fingerprint = await projectVersionFingerprint(dir);
    await write("index.tsx", "external edit");
    await expect(restoreProjectVersion(dir, version.id, { expectedFingerprint: fingerprint })).rejects.toThrow("project changed");
    expect(await read("index.tsx")).toBe("external edit");
    expect(await listProjectVersions(dir)).toHaveLength(1);
  });

  it("rolls back an interrupted multi-file write without losing the latest edits", async () => {
    const version = await createProjectVersion(dir);
    await write("index.tsx", "latest source");
    await write("assets/captions.json", "latest captions");
    await write("assets.yml", manifest + "folders: []\n");
    const { rename } = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    let failed = false;
    vi.mocked(fs.rename).mockImplementation(async (old, target) => {
      if (target === join(dir, "index.tsx") && !failed) {
        failed = true;
        throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
      }
      return rename(old, target);
    });
    await expect(restoreProjectVersion(dir, version.id)).rejects.toThrow("disk full");
    expect(await read("index.tsx")).toBe("latest source");
    expect(await read("assets/captions.json")).toBe("latest captions");
    expect(await read("assets.yml")).toBe(manifest + "folders: []\n");
    expect((await listProjectVersions(dir))[0].kind).toBe("before-restore");
    expect(await recoverProjectVersionRestore(dir)).toEqual({ recovered: false, paths: [] });
  });

  it("recovers an interrupted restore after process restart", async () => {
    const target = await createProjectVersion(dir);
    await write("index.tsx", "latest source");
    const checkpoint = await createProjectVersion(dir, { kind: "before-restore" });
    await write(".cutroom/versions/restore-journal.json", JSON.stringify({
      schema: 1, phase: "applying", versionId: target.id, checkpointId: checkpoint.id,
      files: [{ path: "index.tsx", before: "latest source", after: source }],
    }));
    await write("index.tsx", source); // The process stopped after the first file swap.
    vi.resetModules();
    const restarted = await import("./project-versions");
    await expect(restarted.createProjectVersion(dir)).rejects.toThrow("interrupted version restore");
    expect(await restarted.recoverProjectVersionRestore(dir)).toEqual({ recovered: true, paths: ["index.tsx"] });
    expect(await read("index.tsx")).toBe("latest source");
    expect(await restarted.recoverProjectVersionRestore(dir)).toEqual({ recovered: false, paths: [] });
  });

  it("does not overwrite an external edit made during interrupted-restore recovery", async () => {
    const checkpoint = await createProjectVersion(dir);
    await write("index.tsx", "restored source");
    const version = await createProjectVersion(dir);
    await write(".cutroom/versions/restore-journal.json", JSON.stringify({
      schema: 1, phase: "applying", versionId: version.id, checkpointId: checkpoint.id,
      files: [{ path: "index.tsx", before: source, after: "restored source" }],
    }));
    await write("index.tsx", "external editor fixed this");
    await expect(recoverProjectVersionRestore(dir)).rejects.toThrow("changed outside UVE");
    expect(await read("index.tsx")).toBe("external editor fixed this");
    expect(await read(".cutroom/versions/restore-journal.json")).toContain('"phase":"applying"');
  });

  it("finishes cleanup of a committed restore without rolling it back", async () => {
    const version = await createProjectVersion(dir);
    await write("index.tsx", "previous");
    const checkpoint = await createProjectVersion(dir);
    await write("index.tsx", source);
    await write(".cutroom/versions/restore-journal.json", JSON.stringify({
      schema: 1, phase: "committed", versionId: version.id, checkpointId: checkpoint.id,
      files: [{ path: "index.tsx", before: "previous", after: source }],
    }));
    await recoverProjectVersionRestore(dir);
    expect(await read("index.tsx")).toBe(source);
  });

  it("deduplicates unchanged saves and bounds retained history", async () => {
    const initial = await createProjectVersion(dir);
    expect((await createProjectVersion(dir)).id).toBe(initial.id);
    const seeded = JSON.parse(await read(`.cutroom/versions/${initial.id}.json`));
    for (let i = 1; i < PROJECT_VERSION_LIMIT + 2; i++) {
      const id = `${Number(initial.id.slice(0, 13)) + i}-${randomUUID()}`;
      await write(`.cutroom/versions/${id}.json`, JSON.stringify({ ...seeded, id }));
    }
    await write("index.tsx", "latest edit");
    await createProjectVersion(dir);
    const versions = await listProjectVersions(dir);
    expect(versions).toHaveLength(PROJECT_VERSION_LIMIT);
    expect(versions.some((version) => version.id === initial.id)).toBe(false);
    await restoreProjectVersion(dir, versions[versions.length - 1].id);
    expect(await read("index.tsx")).toBe(source);
    expect(await listProjectVersions(dir)).toHaveLength(PROJECT_VERSION_LIMIT);
  }, 30_000);

  it("refuses traversal identifiers, caption paths, and tampered snapshot paths", async () => {
    const version = await createProjectVersion(dir);
    await expect(restoreProjectVersion(dir, "../../index.tsx")).rejects.toThrow("identifier");
    await write("assets.yml", "assets:\n  - type: TRANSCRIPT\n    source: ../private.json\n");
    await expect(createProjectVersion(dir)).rejects.toThrow("leaves the project");
    await write("assets.yml", manifest);
    const path = `.cutroom/versions/${version.id}.json`;
    const snapshot = JSON.parse(await read(path));
    snapshot.files[0].path = "../private.json";
    await write(path, JSON.stringify(snapshot));
    await expect(restoreProjectVersion(dir, version.id)).rejects.toThrow("Unsafe project history path");
    expect(await read("index.tsx")).toBe(source);
  });

  it("refuses symlinked history storage and symlinked caption restore targets", async () => {
    const version = await createProjectVersion(dir);
    await fs.rm(join(dir, "assets/captions.json"));
    await fs.symlink(join(dir, "package.json"), join(dir, "assets/captions.json"));
    await expect(restoreProjectVersion(dir, version.id)).rejects.toThrow("symbolic link");
    await fs.rm(join(dir, ".cutroom"), { recursive: true });
    await fs.symlink(join(dir, "assets"), join(dir, ".cutroom"));
    await expect(listProjectVersions(dir)).rejects.toThrow("symbolic link");
    expect(await read("package.json")).toContain('"projectId":"unchanging"');
  });

  it("keeps other usable versions visible if one snapshot is corrupted", async () => {
    const first = await createProjectVersion(dir);
    await write("index.tsx", "second edit");
    const second = await createProjectVersion(dir);
    await write(`.cutroom/versions/${first.id}.json`, "broken snapshot");
    expect((await listProjectVersions(dir)).map((version) => version.id)).toEqual([second.id]);
    await expect(restoreProjectVersion(dir, first.id)).rejects.toThrow();
  });

  it("preserves an orphaned caption before restoring its older manifest reference", async () => {
    const version = await createProjectVersion(dir);
    await write("assets.yml", "version: 1\nassets: []\n");
    await write("assets/captions.json", "unlinked but valuable edits");
    const result = await restoreProjectVersion(dir, version.id);
    expect(await read("assets/captions.json")).toBe('{"words":["original"]}');
    await restoreProjectVersion(dir, result.checkpoint.id);
    expect(await read("assets/captions.json")).toBe("unlinked but valuable edits");
    expect(await read("assets.yml")).toBe("version: 1\nassets: []\n");
  });

  it("rejects a damaged recovery journal without writing its contents to the project", async () => {
    const version = await createProjectVersion(dir);
    await write(".cutroom/versions/restore-journal.json", JSON.stringify({
      schema: 1, phase: "applying", versionId: version.id, checkpointId: version.id,
      files: [{ path: "index.tsx", before: "tampered backup", after: source }],
    }));
    await expect(recoverProjectVersionRestore(dir)).rejects.toThrow("does not match its preserved versions");
    expect(await read("index.tsx")).toBe(source);
  });

  it("restores editing settings while preserving current project identity and unrelated package fields", async () => {
    await write("package.json", JSON.stringify({ projectId: "original", displayName: "Old title", diffusion: { aspectRatio: "9:16", fps: 30 }, scripts: { custom: "keep" } }));
    const version = await createProjectVersion(dir);
    await write("package.json", JSON.stringify({ projectId: "new-identity", displayName: "New title", diffusion: { aspectRatio: "16:9", fps: 60 }, scripts: { custom: "new command" }, custom: true }));
    const restored = await restoreProjectVersion(dir, version.id);
    expect(JSON.parse(await read("package.json"))).toEqual({
      projectId: "new-identity", displayName: "New title", diffusion: { aspectRatio: "9:16", fps: 30 }, scripts: { custom: "new command" }, custom: true,
    });
    expect(restored.paths).toContain("package.json");
    await restoreProjectVersion(dir, restored.checkpoint.id);
    expect(JSON.parse(await read("package.json")).diffusion).toEqual({ aspectRatio: "16:9", fps: 60 });
  });

  it("restores absent settings without replacing the package record", async () => {
    const version = await createProjectVersion(dir);
    await write("package.json", '{"projectId":"current","diffusion":{"fps":60},"custom":true}');
    await restoreProjectVersion(dir, version.id);
    expect(JSON.parse(await read("package.json"))).toEqual({ projectId: "current", custom: true });
  });
});
