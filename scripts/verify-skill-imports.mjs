import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const imports = join(root, "docs/skills/imports");
const manifest = JSON.parse(await readFile(join(imports, "provenance.json"), "utf8"));
let checked = 0;
const errors = [];
for (const upstream of manifest.imports.filter((item) => item.mode === "vendored")) {
  const expected = new Set(Object.keys(upstream.files));
  async function visit(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) {
        const name = relative(imports, path).split("\\").join("/");
        const hash = createHash("sha256").update(await readFile(path)).digest("hex");
        if (!expected.delete(name)) errors.push(`Unexpected imported file: ${name}`);
        else if (upstream.files[name] !== hash) errors.push(`Imported file changed: ${name}`);
        checked += 1;
      } else errors.push(`Unsupported imported file: ${path}`);
    }
  }
  await visit(join(imports, upstream.path));
  for (const missing of expected) errors.push(`Missing imported file: ${missing}`);
}
if (errors.length) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({ ok: true, verifiedImportedFiles: checked, providers: manifest.imports.map(({ repository, revision, mode }) => ({ repository, revision, mode })) }, null, 2));
}
