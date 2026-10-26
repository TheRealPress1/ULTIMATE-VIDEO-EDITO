import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return { ...actual, rename: vi.fn(actual.rename) };
});
import { createProjectVersion, inspectProjectVersion, listProjectVersions, projectVersionFingerprint, recoverProjectVersionRestore, restoreProjectVersion, restoreProjectVersionLayer } from "./project-versions";
import { validateVersionPreview } from "./project-version-preview";
import { inspectSourceLayers, restoreLayerSource } from "./project-version-layers";

let dir: string;
const oldCaption = JSON.stringify([{ text: "Original words", words: [{ text: "Original", start: 0, end: 0.5 }, { text: "words", start: 0.5, end: 1 }] }]);
const newCaption = JSON.stringify([{ text: "New words", words: [{ text: "New", start: 0, end: 0.5 }, { text: "words", start: 0.5, end: 1 }] }]);
const contentId = (content: string): string => createHash("sha256").update(String(Buffer.byteLength(content))).update(content).digest("hex").slice(0, 16);
const original = `export default () => <stage><scene id="main" name="Main" duration={30}><video id="video1" src="assets/original.mp4"/><captions id="caption1" src="Captions.json" preset="whisper"/><text id="title">Old title</text></scene></stage>;\n`;
const current = original.replace('<captions id="caption1" src="Captions.json" preset="whisper"/>', '').replace('Old title', 'NEW TITLE');
const read = (path: string): Promise<string> => fs.readFile(join(dir, path), "utf8");
const write = (path: string, value: string): Promise<void> => fs.writeFile(join(dir, path), value);
const assets = () => [
  { id: contentId(oldCaption), path: "Captions.json", source: "assets/captions.json", type: "TRANSCRIPT", mimeType: "application/json", createdAt: "2026-10-25" },
  { id: "video-id", path: "original.mp4", source: "assets/original.mp4", type: "VIDEO", mimeType: "video/mp4", createdAt: "2026-10-25" },
];
const readAssets = async (): Promise<Array<{ id: string; path: string; source: string; type: string }>> => (parseYaml(await read("assets.yml")) as { assets: Array<{ id: string; path: string; source: string; type: string }> }).assets;

function preview(width = 1, height = 1): string {
  const crc32 = (data: Buffer): number => {
    let crc = 0xffffffff;
    for (const byte of data) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
    return (crc ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer): Buffer => {
    const bytes = Buffer.alloc(data.length + 12);
    bytes.writeUInt32BE(data.length, 0); bytes.write(type, 4); data.copy(bytes, 8);
    bytes.writeUInt32BE(crc32(bytes.subarray(4, data.length + 8)), data.length + 8);
    return bytes;
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
  return "data:image/png;base64," + Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.alloc((width * 4 + 1) * height))), chunk("IEND", Buffer.alloc(0))]).toString("base64");
}

beforeEach(async () => {
  dir = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "uve-history-review-")));
  await fs.mkdir(join(dir, "assets"));
  await write("index.tsx", original);
  await write("assets.yml", stringifyYaml({ version: 1, folders: [], assets: assets() }));
  await write("assets/captions.json", oldCaption);
  await write("assets/original.mp4", "original footage bytes");
  await write("package.json", '{"projectId":"keep-id","displayName":"Keep name","diffusion":{"fps":30}}');
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.mocked(fs.rename).mockReset();
  await fs.rm(dir, { recursive: true, force: true });
});

describe("version comparisons and previews", () => {
  it("stores an exact-fingerprint PNG preview, bounds its bytes, and reads it after restart", async () => {
    const fingerprint = await projectVersionFingerprint(dir);
    const image = preview();
    const base = await createProjectVersion(dir, { label: "Without picture" });
    const saved = await createProjectVersion(dir, { label: "Original", kind: "manual", deduplicate: false, preview: image, expectedFingerprint: fingerprint });
    expect(saved.bytes).toBe(base.bytes + Buffer.byteLength(image));
    expect(saved).not.toHaveProperty("preview");
    vi.resetModules();
    const restarted = await import("./project-versions");
    expect((await restarted.inspectProjectVersion(dir, saved.id)).preview).toBe(image);
    const content = JSON.parse(await read(`.cutroom/versions/${saved.id}.json`));
    content.preview = image.slice(0, -5) + "AAAA=";
    await write(`.cutroom/versions/${saved.id}.json`, JSON.stringify(content));
    await expect(restarted.inspectProjectVersion(dir, saved.id)).rejects.toThrow("PNG");
  });

  it("refuses stale, unpaired, oversized and malformed previews without adding a version", async () => {
    const fingerprint = await projectVersionFingerprint(dir);
    await write("index.tsx", current);
    await expect(createProjectVersion(dir, { preview: preview(), expectedFingerprint: fingerprint })).rejects.toThrow("project changed");
    await expect(createProjectVersion(dir, { preview: preview() })).rejects.toThrow("fingerprint");
    expect(() => validateVersionPreview("data:image/png;base64," + "A".repeat(1_000_000))).toThrow("PNG");
    expect(() => validateVersionPreview("data:image/png;base64,AAAA")).toThrow("PNG");
    expect(() => validateVersionPreview(preview(2049))).toThrow("PNG");
    expect(await listProjectVersions(dir)).toEqual([]);
  });

  it("compares missing and changed layers, including caption-word-only changes and valid source aliases", async () => {
    const saved = await createProjectVersion(dir);
    await write("index.tsx", current);
    let comparison = await inspectProjectVersion(dir, saved.id);
    expect(comparison.layers.find((layer) => layer.id === "caption1")).toMatchObject({ status: "missing", canRestore: true });
    expect(comparison.layers.find((layer) => layer.id === "title")).toMatchObject({ status: "changed", savedSource: '<text id="title">Old title</text>', currentSource: '<text id="title">NEW TITLE</text>' });
    expect(comparison.layers.find((layer) => layer.id === "video1")).toMatchObject({ status: "unchanged", canRestore: true });
    expect(comparison.files.find((file) => file.path === "index.tsx")).toMatchObject({ status: "changed", before: original, after: current });
    await write("index.tsx", original);
    await write("assets/captions.json", newCaption);
    comparison = await inspectProjectVersion(dir, saved.id);
    expect(comparison.layers.find((layer) => layer.id === "caption1")).toMatchObject({ status: "changed", canRestore: false, reason: expect.stringContaining("identity") });
    const manifest = assets(); manifest[0].id = contentId(newCaption);
    await write("assets.yml", stringifyYaml({ version: 1, folders: [], assets: manifest }));
    comparison = await inspectProjectVersion(dir, saved.id);
    expect(comparison.layers.find((layer) => layer.id === "caption1")).toMatchObject({ status: "changed", canRestore: true });
  });

  it("bounds display snippets while preserving complete restoration data", async () => {
    const large = original.replace('Old title', 'a'.repeat(30_000));
    await write("index.tsx", large);
    const saved = await createProjectVersion(dir);
    const comparison = await inspectProjectVersion(dir, saved.id);
    expect(comparison.truncated).toBe(true);
    expect(comparison.layers.find((layer) => layer.id === "title")?.savedSource.length).toBeLessThanOrEqual(8_000);
    await write("index.tsx", current);
    await restoreProjectVersionLayer(dir, saved.id, { file: "index.tsx", layerId: "title", expectedFingerprint: await projectVersionFingerprint(dir) });
    expect(await read("index.tsx")).toContain('a'.repeat(30_000));
  });
});

describe("selective layer recovery", () => {
  it("restores a missing caption without changing newer title, shared caption words or footage, and can reverse the restore", async () => {
    const saved = await createProjectVersion(dir, { label: "Original" });
    const newer = current.replace('</scene>', '<captions id="caption2" src="Captions.json"/></scene>');
    await write("index.tsx", newer);
    await write("assets/captions.json", newCaption);
    const manifest = assets(); manifest[0].id = contentId(newCaption);
    const newerManifest = stringifyYaml({ version: 1, folders: [], assets: manifest, custom: "keep" });
    await write("assets.yml", newerManifest);
    const restored = await restoreProjectVersionLayer(dir, saved.id, { file: "index.tsx", layerId: "caption1", expectedFingerprint: await projectVersionFingerprint(dir) });
    const source = await read("index.tsx");
    expect(source).toContain('<text id="title">NEW TITLE</text>');
    expect(source).toContain('<captions id="caption2" src="Captions.json"/>');
    expect(source.indexOf('id="caption1"')).toBeLessThan(source.indexOf('id="title"'));
    expect(await read("assets/captions.json")).toBe(newCaption);
    expect(await read("assets/original.mp4")).toBe("original footage bytes");
    const library = await readAssets();
    expect(library).toHaveLength(3);
    const recovered = library.find((asset) => asset.path.startsWith("Recovered/"))!;
    expect(recovered.id).toBe(contentId(oldCaption));
    expect(await read(recovered.source)).toBe(oldCaption);
    expect(restored.paths).toContain("index.tsx");
    expect(restored.checkpoint.kind).toBe("before-restore");
    await restoreProjectVersion(dir, restored.checkpoint.id);
    expect(await read("index.tsx")).toBe(newer);
    expect(await read("assets.yml")).toBe(newerManifest);
    expect(await read("assets/captions.json")).toBe(newCaption);
    await expect(read(recovered.source)).rejects.toHaveProperty("code", "ENOENT");
  });

  it("reuses identical caption content under a renamed path and avoids duplicate library identity", async () => {
    const saved = await createProjectVersion(dir);
    const manifest = assets(); manifest[0].path = "Renamed.json";
    await write("assets.yml", stringifyYaml({ version: 1, folders: [], assets: manifest }));
    await write("index.tsx", current);
    await restoreProjectVersionLayer(dir, saved.id, { file: "index.tsx", layerId: "caption1", expectedFingerprint: await projectVersionFingerprint(dir) });
    expect(await read("index.tsx")).toContain('src={"Renamed.json"}');
    expect(await readAssets()).toHaveLength(2);
    expect(await fs.readdir(join(dir, "assets"))).toEqual(["captions.json", "original.mp4"]);
  });

  it("checks the comparison fingerprint before storing or writing anything", async () => {
    const saved = await createProjectVersion(dir);
    const fingerprint = (await inspectProjectVersion(dir, saved.id)).fingerprint;
    await write("index.tsx", current);
    await expect(restoreProjectVersionLayer(dir, saved.id, { file: "index.tsx", layerId: "caption1", expectedFingerprint: fingerprint })).rejects.toThrow("project changed");
    expect(await read("index.tsx")).toBe(current);
    expect(await listProjectVersions(dir)).toHaveLength(1);
  });

  it("rolls back a failed selective multi-file restore while preserving both recovery snapshots", async () => {
    const saved = await createProjectVersion(dir);
    await write("index.tsx", current);
    await write("assets/captions.json", newCaption);
    const manifest = assets(); manifest[0].id = contentId(newCaption);
    const newerManifest = stringifyYaml({ version: 1, folders: [], assets: manifest });
    await write("assets.yml", newerManifest);
    const { rename } = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    let failed = false;
    vi.mocked(fs.rename).mockImplementation(async (from, to) => {
      if (to === join(dir, "index.tsx") && !failed) { failed = true; throw new Error("disk full"); }
      return rename(from, to);
    });
    await expect(restoreProjectVersionLayer(dir, saved.id, { file: "index.tsx", layerId: "caption1", expectedFingerprint: await projectVersionFingerprint(dir) })).rejects.toThrow("disk full");
    expect(await read("index.tsx")).toBe(current);
    expect(await read("assets.yml")).toBe(newerManifest);
    expect(await read("assets/captions.json")).toBe(newCaption);
    expect((await fs.readdir(join(dir, "assets"))).some((name) => name.startsWith("recovered-"))).toBe(false);
    expect((await listProjectVersions(dir)).some((version) => version.kind === "before-restore")).toBe(true);
    expect(await recoverProjectVersionRestore(dir)).toEqual({ recovered: false, paths: [] });
  });
});

describe("conservative static layer planning", () => {
  it.each([
    ['calculated properties', '<text id="title" x={compute()}>Old</text>'],
    ['spread properties', '<text id="title" {...settings}>Old</text>'],
    ['custom rendering', '<Text id="title">Old</Text>'],
    ['dynamic expression', '<group id="wrapper">{items.map(() => <group><text id="title">Old</text></group>)}</group>'],
  ])("refuses %s without executing expressions", (reason, layer) => {
    const saved = `<stage><scene id="main">${layer}</scene></stage>`;
    expect(() => restoreLayerSource(saved, saved, "title")).toThrow(reason);
    expect(inspectSourceLayers("index.tsx", saved, saved).find((entry) => entry.id === "title")).toMatchObject({ canRestore: false });
  });

  it("refuses conflicting descendants and moved parent identities", () => {
    const saved = '<stage><scene id="main"><group id="group1"><text id="title">Old</text></group></scene></stage>';
    expect(() => restoreLayerSource(saved, '<stage><scene id="main"><text id="title">New elsewhere</text></scene></stage>', 'group1')).toThrow('conflicts');
    expect(() => restoreLayerSource(saved, '<stage><scene id="other"/></stage>', 'group1')).toThrow('parent');
    expect(() => restoreLayerSource(saved, '<stage><scene id="main"><group id="group1"/><group id="group1"/></scene></stage>', 'group1')).toThrow('duplicated');
  });
});
