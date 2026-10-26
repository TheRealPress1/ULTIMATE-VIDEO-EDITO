import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return { ...actual, rename: vi.fn(actual.rename) };
});
import { createProjectVersion, projectVersionFingerprint, restoreProjectVersionLayer } from "./project-versions";

let dir: string;
const oldWords = JSON.stringify([{ text: "Original", words: [{ text: "Original", start: 0, end: 1 }] }]);
const editedWords = JSON.stringify([{ text: "Edited", words: [{ text: "Edited", start: 0, end: 1 }] }]);
const original = 'export default () => <stage id="stage"><scene id="scene"><captions id="caption" src="Words.json"/><text id="title">Old title</text></scene></stage>;\n';
const current = '// latest comment\nexport default () => <stage id="stage"><scene id="scene" width={1080} height={1920}><text id="title">Keep this title</text><captions id="other" src="Words.json"/></scene></stage>;\n';
const manifest = stringifyYaml({ version: 1, folders: [], assets: [{ id: "current-caption", type: "TRANSCRIPT", path: "Words.json", source: "assets/words.json", mimeType: "application/json" }] });
const read = (path: string) => fs.readFile(join(dir, path), "utf8");
const write = (path: string, value: string) => fs.writeFile(join(dir, path), value);

beforeEach(async () => {
  dir = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "uve-selective-review-")));
  await fs.mkdir(join(dir, "assets"));
  await write("index.tsx", original);
  await write("assets.yml", manifest);
  await write("assets/words.json", oldWords);
  await write("package.json", '{"projectId":"same-project"}');
});
afterEach(async () => {
  vi.mocked(fs.rename).mockReset();
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  vi.mocked(fs.rename).mockImplementation(actual.rename);
  await fs.rm(dir, { recursive: true, force: true });
});

describe("independent selective restore transaction review", () => {
  async function interruptRollback() {
    const version = await createProjectVersion(dir, { label: "Before", kind: "manual" });
    await write("index.tsx", current);
    await write("assets/words.json", editedWords);
    const fingerprint = await projectVersionFingerprint(dir);
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    let applyingFailed = false;
    vi.mocked(fs.rename).mockImplementation(async (from, to) => {
      if (to === join(dir, "index.tsx")) {
        applyingFailed = true;
        throw new Error("simulated interrupted composition write");
      }
      if (applyingFailed && to === join(dir, "assets.yml")) throw new Error("simulated interrupted rollback");
      return actual.rename(from, to);
    });
    await expect(restoreProjectVersionLayer(dir, version.id, { file: "index.tsx", layerId: "caption", expectedFingerprint: fingerprint })).rejects.toThrow("Recovery is pending");
    vi.mocked(fs.rename).mockImplementation(actual.rename);
    const journal = JSON.parse(await read(".cutroom/versions/restore-journal.json"));
    expect(journal.phase).toBe("applying");
    await expect(read(`.cutroom/versions/${journal.versionId}.json`)).resolves.toBeTruthy();
    await expect(read(`.cutroom/versions/${journal.checkpointId}.json`)).resolves.toBeTruthy();
    return fingerprint;
  }

  it("completes interrupted selective rollback after module restart using both preserved snapshots", async () => {
    const fingerprint = await interruptRollback();
    await expect(projectVersionFingerprint(dir)).rejects.toThrow("interrupted version restore");
    vi.resetModules();
    const restarted = await import("./project-versions");
    expect((await restarted.recoverProjectVersionRestore(dir)).recovered).toBe(true);
    expect(await read("index.tsx")).toBe(current);
    expect(await read("assets/words.json")).toBe(editedWords);
    expect(await read("assets.yml")).toBe(manifest);
    expect(await fs.readdir(join(dir, "assets"))).toEqual(["words.json"]);
    expect(await restarted.projectVersionFingerprint(dir)).toBe(fingerprint);
    expect(await restarted.recoverProjectVersionRestore(dir)).toEqual({ recovered: false, paths: [] });
  });

  it("preserves an external edit during interrupted selective recovery and leaves recovery pending", async () => {
    await interruptRollback();
    const manifestBefore = await read("assets.yml");
    await write("index.tsx", current + "// external work after interruption\n");
    vi.resetModules();
    const restarted = await import("./project-versions");
    await expect(restarted.recoverProjectVersionRestore(dir)).rejects.toThrow("changed outside UVE");
    expect(await read("index.tsx")).toBe(current + "// external work after interruption\n");
    expect(await read("assets.yml")).toBe(manifestBefore);
    await expect(read(".cutroom/versions/restore-journal.json")).resolves.toBeTruthy();
  });
});
