import { describe, expect, it } from "vitest";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { AssetLibrary, hashBlob } from "@diffusionstudio/assets";
import type { ProjectFS } from "@diffusionstudio/assets";
import { restoreLayerSource } from "@desktop/project-version-layers";
import { planVersionAssets } from "@desktop/project-version-assets";

describe("independent selective layer restoration review", () => {
  it("inserts at the nearest surviving following sibling while preserving every other current byte", () => {
    const layer = '<captions id="captions" src="Words.json" preset="whisper" />';
    const saved = `export default () => <stage><scene id="scene"><video id="video" src="Film.mp4"/>${layer}<text id="title">Old title</text></scene></stage>;`;
    const current = `// Keep this comment and formatting.\nconst volume = -12;\nexport default () => <stage>\n <scene id="scene" name="Latest name">\n <video id="video" src="Film.mp4" volume={-8}/>\n <text id="new">New graphic</text>\n <text id="title">Changed title</text>\n </scene>\n</stage>;\n`;
    const result = restoreLayerSource(saved, current, "captions");
    const position = current.indexOf('<text id="title">');
    expect(result.source).toBe(current.slice(0, position) + layer + "\n" + current.slice(position));
  });

  it("expands an empty stable parent without touching its new attributes or surrounding source", () => {
    const saved = 'export default () => <stage><scene id="scene"><captions id="captions" src="Words.json"/></scene></stage>;';
    const current = '// note\nexport default () => <stage><scene id="scene" name="New scene" width={1080} height={1920} /></stage>;\n';
    const restored = restoreLayerSource(saved, current, "captions", new Map([["Words.json", 'Recovered/Words "one".json']]));
    expect(restored.source).toContain('<scene id="scene" name="New scene" width={1080} height={1920}>');
    expect(restored.source).toContain('src={"Recovered/Words \\"one\\".json"}'.replaceAll('\\\\', '\\'));
    expect(restored.source.startsWith('// note\n')).toBe(true);
    expect(restored.source.endsWith('</stage>;\n')).toBe(true);
  });

  it("keeps both current caption names readable after restoring bytes already present under another name", async () => {
    const oldWords = JSON.stringify([{ text: "Original", words: [{ text: "Original", start: 0, end: 1 }] }]);
    const newWords = JSON.stringify([{ text: "Edited", words: [{ text: "Edited", start: 0, end: 1 }] }]);
    const oldId = await hashBlob(new Blob([oldWords]));
    const newId = await hashBlob(new Blob([newWords]));
    const record = (id: string, path: string, source: string, text: string) => ({
      id, path, source, type: "TRANSCRIPT", mimeType: "application/json", createdAt: "2026-10-25T12:00:00Z", stat: { size: Buffer.byteLength(text), mtime: 1 },
    });
    const savedManifest = { version: 1, folders: [], assets: [record(oldId, "A.json", "assets/a.json", oldWords)] };
    const currentManifest = { version: 1, folders: [], assets: [record(newId, "A.json", "assets/a.json", newWords), record(oldId, "B.json", "assets/b.json", oldWords)] };
    const saved = new Map([["assets.yml", stringifyYaml(savedManifest)], ["assets/a.json", oldWords]]);
    const current = new Map([["assets.yml", stringifyYaml(currentManifest)], ["assets/a.json", newWords], ["assets/b.json", oldWords]]);
    const restored = planVersionAssets(saved, current, [{ path: "A.json", tag: "captions" }]);
    const merged = new Map([...current, ...restored.files]);
    const fs: ProjectFS = {
      readManifest: async () => parseYaml(merged.get("assets.yml")!),
      writeManifest: async () => {}, list: async () => [], write: async () => {}, remove: async () => {},
      stat: async (source) => merged.has(source) ? { size: Buffer.byteLength(merged.get(source)!), mtime: 1 } : null,
      file: async (source) => new File([merged.get(source)!], source.split("/").at(-1)!, { type: "application/json", lastModified: 1 }),
    };
    const library = new AssetLibrary(fs);
    try {
      await library.load();
      expect((await library.resolve("A.json")).id).toBe(newId);
      expect((await library.resolve("B.json")).id).toBe(oldId);
      expect((await library.resolve(restored.remap.get("A.json")!)).id).toBe(oldId);
      expect(merged.get("assets/a.json")).toBe(newWords);
      expect(merged.get("assets/b.json")).toBe(oldWords);
    } finally { library.dispose(); }
  });
});
