import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isEntryPoint } from "./lib/entry-point.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Checks every import recorded in `<imports>/provenance.json`; returns the problems found and the files verified. */
export async function verifySkillImports(imports = join(root, "docs/skills/imports")) {
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
  // Adapted imports are rewritten for Cutroom, so only the files kept byte-identical (the license) are pinned,
  // the skill itself must sit at the folder's top level, and every Markdown file in the folder must still carry
  // the upstream copyright notice.
  for (const upstream of manifest.imports.filter((item) => item.mode === "adapted")) {
    for (const [name, expected] of Object.entries(upstream.files)) {
      const hash = await readFile(join(imports, name)).then((bytes) => createHash("sha256").update(bytes).digest("hex"), () => null);
      if (hash === null) errors.push(`Missing imported file: ${name}`);
      else if (hash !== expected) errors.push(`Imported file changed: ${name}`);
      else checked += 1;
    }
    const skill = join(imports, upstream.path, "SKILL.md");
    if (!(await stat(skill).then((info) => info.isFile(), () => false))) errors.push(`Missing adapted skill: ${upstream.path}/SKILL.md`);
    const markdown = [];
    async function collect(dir) {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) await collect(join(dir, entry.name));
        else if (entry.name.endsWith(".md")) markdown.push(join(dir, entry.name));
      }
    }
    await collect(join(imports, upstream.path));
    for (const path of markdown) {
      if (!(await readFile(path, "utf8")).includes(upstream.notice)) errors.push(`Adapted file lost its copyright notice: ${relative(imports, path)}`);
    }
  }
  return { errors, checked, manifest };
}

if (isEntryPoint(import.meta.url)) {
  const { errors, checked, manifest } = await verifySkillImports();
  if (errors.length) {
    console.error(errors.join("\n"));
    process.exitCode = 1;
  } else {
    console.log(JSON.stringify({ ok: true, verifiedImportedFiles: checked, providers: manifest.imports.map(({ repository, revision, mode }) => ({ repository, revision, mode })) }, null, 2));
  }
}
