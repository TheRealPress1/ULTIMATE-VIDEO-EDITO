#!/usr/bin/env node
// Read-only standalone bundle verification. This checks portable dependencies,
// not Gatekeeper/notarization or installation on another physical machine.
// Usage: node scripts/verify-standalone-bundle.mjs /path/Cutroom.app [arm64|x64] [--output report.json]
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { accessSync, closeSync, constants, lstatSync, openSync, readFileSync, readdirSync, readlinkSync, readSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import Module, { builtinModules, createRequire } from "node:module";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const args = process.argv.slice(2);
const bundleArg = args.shift();
if (!bundleArg) throw new Error('Usage: node scripts/verify-standalone-bundle.mjs app-path [arm64|x64] [--output report.json]');
const architecture = args[0] && !args[0].startsWith('--') ? args.shift() : process.arch;
let output;
if (args[0] === '--output' && args.length === 2 && args[1]) output = resolve(args[1]);
else if (args.length) throw new Error('Expected an architecture and/or --output report.json.');
assert.equal(process.platform, 'darwin', 'macOS bundle verification must run on macOS.');
assert(['arm64', 'x64'].includes(architecture), 'Expected arm64 or x64.');
const bundle = realpathSync(resolve(bundleArg));
assert(lstatSync(bundle).isDirectory(), 'Expected an app bundle directory.');
const resources = join(bundle, "Contents", "Resources");
const application = join(resources, "app");
const checks = [];
const within = (base, path) => path === base || path.startsWith(`${base}${sep}`);
if (output) {
  // Require an existing output directory so even symlinked paths cannot create
  // files inside the signed bundle during this read-only verification.
  output = join(realpathSync(dirname(output)), basename(output));
  assert(!within(bundle, output), 'The verification report must be outside the app bundle.');
}
const plist = (key) => execFileSync('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', join(bundle, 'Contents', 'Info.plist')], { encoding: 'utf8' }).trim();
const executableName = plist('CFBundleExecutable');
assert(executableName && !/[\\/]/.test(executableName), 'Invalid bundle executable.');
function file(path, executable = false) {
  assert(lstatSync(path).isFile(), `Missing regular file: ${relative(bundle, path)}`);
  accessSync(path, executable ? constants.R_OK | constants.X_OK : constants.R_OK);
  return path;
}
for (const path of [
  "package.json", "dist/main.js", "dist/preload.js", "dist/agent-host.mjs", "dist/corner_radius.node", "dist/reframe-vision", "dist/visual-vision", "dist/reference-style", "dist/playback-proxy", "dist/speaker-analysis", "dist/speaker-model.json", "dist/speaker-model-LICENSE.txt", "dist/audio-tools/ffmpeg", "dist/audio-tools/runtime.json", "dist/release-config.json", "web/index.html",
]) file(join(application, path));
for (const path of [
  "cli/dapi.js", "cli/bin/dapi", "runtime/package.json", "docs/INSTRUCTIONS.md", "docs/skills/editor.md", "docs/skills/watch.md", "docs/skills/uve-web-media/SKILL.md", "docs/reference/tools/web-media.md",
  "docs/reference/tools/transcribe.md", "docs/reference/tools/reference-style.md", "docs/reference/tools/speaker-framing.md", "docs/playback-performance.md", "speech/whisper-cli", "speech/LICENSE", "speech/runtime.json",
]) file(join(resources, path));
file(join(bundle, "Contents", "MacOS", executableName), true);
file(join(resources, "cli", "bin", "dapi"), true);
file(join(resources, "speech", "whisper-cli"), true);
file(join(application, "dist", "reframe-vision"), true);
file(join(application, "dist", "visual-vision"), true);
file(join(application, "dist", "audio-tools", "ffmpeg"), true);
const pkg = JSON.parse(readFileSync(join(application, "package.json"), "utf8"));
assert.equal(pkg.main, "dist/main.js");
assert.equal(plist('CFBundleIdentifier'), 'app.cutroom.editor');
assert.equal(plist('CFBundleShortVersionString'), pkg.version, 'Bundle and application versions differ.');
assert.equal(plist('CFBundleVersion'), pkg.version, 'Bundle build and application versions differ.');
checks.push(`Bundle identity and all app version fields agree: ${pkg.version}`);
const speech = JSON.parse(readFileSync(join(resources, "speech", "runtime.json"), "utf8"));
assert.equal(speech.platform, "darwin");
assert.equal(speech.arch, architecture);
checks.push("Editor, preload, agent host, CLI, docs, and local speech resources exist");

file(join(application, "dist", "speaker-analysis"), true);
const speaker = JSON.parse(readFileSync(join(application, "dist", "speaker-model.json"), "utf8"));
assert.equal(speaker.engine, "light-asd-coreml-ava-v2");
assert.equal(speaker.checkpointSHA256, "d44bc3ea7baa8e0946fa3921311714a630ed8b90a1928fab0dbe30d918909317");
assert.equal(speaker.license, "MIT");
assert.equal(speaker.fps, 25);
assert.equal(speaker.audioRate, 16000);
assert.deepEqual(speaker.input, { audio: [1, 200, 13], video: [1, 50, 112, 112] });
assert(Number.isFinite(speaker.parityMaxError) && speaker.parityMaxError < 0.0001, "Missing passing CoreML conversion parity");
assert.deepEqual(Object.keys(speaker.variants).sort(), ['1', '2', '3', '4', '5', '6']);
for (const seconds of [1, 2, 3, 4, 5, 6]) {
  const variant = speaker.variants[seconds];
  assert.deepEqual(variant.input, {audio: [1, seconds * 100, 13], video: [1, seconds * 25, 112, 112]});
  assert(Number.isFinite(variant.parityMaxError) && variant.parityMaxError < 0.0001);
  const modelRoot = join(application, "dist", seconds === 2 ? "speaker-model.mlmodelc" : `speaker-model-${seconds}s.mlmodelc`);
  for (const artifact of ["coremldata.bin", "model.mil", "metadata.json", "weights/weight.bin"]) file(join(modelRoot, artifact));
  const weightsHash = createHash("sha256").update(readFileSync(join(modelRoot, "weights", "weight.bin"))).digest("hex");
  assert.equal(weightsHash, variant.files["Data/com.apple.CoreML/weights/weight.bin"]);
  if (seconds === 2) assert.equal(weightsHash, "a19e3257de22cb48f7ae19601c729e905d2251b03839a4e7e239ebc2c7521af3");
  const [modelMetadata] = JSON.parse(readFileSync(join(modelRoot, "metadata.json"), "utf8"));
  assert.equal(modelMetadata.modelType.name, "MLModelType_mlProgram");
  for (const [name, shape] of Object.entries(variant.input)) {
    const input = modelMetadata.inputSchema.find(input => input.name === name);
    assert(input, `Missing model input ${name}`);
    assert.deepEqual(JSON.parse(input.shape), shape);
    assert.equal(input.dataType, "Float32");
  }
  const logits = modelMetadata.outputSchema.find(output => output.name === "logits");
  assert.deepEqual(JSON.parse(logits.shape), [seconds * 25, 2]);
  assert.equal(logits.dataType, "Float32");
}
assert.match(readFileSync(join(application, "dist", "speaker-model-LICENSE.txt"), "utf8"), /MIT License[\s\S]*Copyright \(c\) 2023 Liao Junhua/);
checks.push("Local speaker helper, pinned CoreML weights, input/output schemas, conversion parity, provenance, and MIT license are packaged");


const html = readFileSync(join(application, "web", "index.html"), "utf8");
assert(!/localhost:5173|\/src\/main\./.test(html), "Web entry still references the development server");
let webAssets = 0;
for (const [, asset] of html.matchAll(/(?:src|href)=["']([^"']+)["']/g)) {
  if (/^(?:[a-z]+:|#|\/\/)/i.test(asset)) continue;
  assert(!isAbsolute(asset), `Web asset is not relative: ${asset}`);
  const path = resolve(application, "web", asset.split(/[?#]/)[0]);
  assert(within(join(application, "web"), path), `Web asset escapes bundled web directory: ${asset}`);
  file(path);
  webAssets += 1;
}
assert(webAssets > 0, "No built web assets linked");
checks.push(`${webAssets} web entry assets resolve within the bundle`);
const builtAssets = join(application, 'web', 'assets');
const assetNames = readdirSync(builtAssets);
assert(assetNames.some(name => /^ort-wasm-simd-threaded\.jsep-.*\.wasm$/.test(name)), 'Missing local CLIP WASM');
assert(assetNames.some(name => /^ort-wasm-simd-threaded\.jsep-.*\.mjs$/.test(name)), 'Missing local CLIP WASM loader');
assert(assetNames.some(name => /asyncify.*\.wasm$/.test(name)), 'Missing separate SAM2 WASM');
assert(assetNames.some(name => /^worker-.*\.js$/.test(name) && readFileSync(join(builtAssets, name), 'utf8').includes('uve-clip-model-d15189d7')), 'Missing pinned local description worker');
checks.push('Pinned CLIP worker and its local WASM loader coexist with the separate SAM2 runtime');

const machos = [];
let symlinks = 0;
const magic = new Set([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca]);
function walk(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      assert(!isAbsolute(readlinkSync(path)), `Nonportable absolute symlink: ${relative(bundle, path)}`);
      assert(within(bundle, realpathSync(path)), `Symlink escapes bundle: ${relative(bundle, path)}`);
      symlinks += 1;
    } else if (entry.isDirectory()) walk(path);
    else if (entry.isFile()) {
      const fd = openSync(path, "r");
      try {
        const header = Buffer.alloc(4);
        if (readSync(fd, header, 0, 4, 0) === 4 && magic.has(header.readUInt32BE())) machos.push(path);
      } finally { closeSync(fd); }
    }
  }
}
walk(bundle);
for (const path of machos) {
  const arches = execFileSync("/usr/bin/lipo", ["-archs", path], { encoding: "utf8" }).trim().split(/\s+/);
  const nativeArchitecture = architecture === 'x64' ? 'x86_64' : architecture;
  assert(arches.includes(nativeArchitecture), `Wrong architecture (${arches.join(", ")}): ${relative(bundle, path)}`);
  // otool interprets a trailing '(GPU)' in Electron helper filenames as an
  // archive-member selector. Inspect the same read-only file descriptor instead.
  const fd = openSync(path, "r");
  let linked;
  let installNames;
  try {
    linked = execFileSync("/usr/bin/otool", ["-L", "/dev/fd/3"], {
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe", fd],
    }).split("\n").slice(1);
    installNames = new Set(execFileSync("/usr/bin/otool", ["-D", "/dev/fd/3"], {
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe", fd],
    }).split("\n").map(line => line.trim()).filter(line => line && !line.endsWith(":")));
  } finally { closeSync(fd); }
  for (const line of linked) {
    const dependency = line.trim().split(" (compatibility version")[0];
    if (!dependency || dependency.endsWith(":") || dependency.startsWith("@") || installNames.has(dependency)) continue;
    assert(dependency.startsWith("/usr/lib/") || dependency.startsWith("/System/Library/"),
      `Non-system native dependency in ${relative(bundle, path)}: ${dependency}`);
  }
}
assert(machos.length >= 3, "Native app/runtime binaries were not detected");
checks.push(`${machos.length} native binaries support ${architecture} with only system/relative linkage`);
checks.push(`${symlinks} symlinks stay relative and inside the bundle`);

// Reject module resolution falling back to a checkout's ancestor node_modules.
// Running the check against a build still inside the checkout must not mask a missing runtime dependency.
const runtime = join(resources, "runtime");
const require = createRequire(join(runtime, "package.json"));
const originalResolve = Module._resolveFilename;
const builtins = new Set(builtinModules.flatMap(name => [name, `node:${name}`]));
let runtimeModules = 0;
assert(!process.env.ESBUILD_BINARY_PATH, "Unset ESBUILD_BINARY_PATH before standalone verification");
try {
  Module._resolveFilename = function (request, ...rest) {
    const path = originalResolve.call(this, request, ...rest);
    if (!builtins.has(path)) {
      assert(within(runtime, realpathSync(path)), `Runtime dependency resolved outside bundle: ${request}`);
      runtimeModules += 1;
    }
    return path;
  };
  const esbuild = require("esbuild");
  assert.match(esbuild.transformSync("const answer: number = 42", { loader: "ts" }).code, /42/);
  const babel = require("@babel/core");
  const result = babel.transformSync("export const scene = <div>Ready</div>", {
    filename: "scene.tsx", configFile: false, babelrc: false,
    presets: [require("@babel/preset-typescript"), require("babel-preset-solid")],
  });
  assert(result?.code?.includes("Ready"), "Bundled JSX compiler did not produce output");
} finally { Module._resolveFilename = originalResolve; }
checks.push(`Babel/TypeScript/Solid and native esbuild execute with ${runtimeModules} module resolutions confined to packaged runtime`);

const version = execFileSync(join(resources, "cli", "bin", "dapi"), ["--version"], {
  encoding: "utf8", timeout: 15_000, env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
}).trim();
assert.equal(version, pkg.version);
checks.push(`Bundled CLI runs on its own Electron with system-only PATH: ${version}`);
const report = JSON.stringify({ ok: true, scope: 'bundle-portability', bundle, architecture, version: pkg.version, checkedAt: new Date().toISOString(), checks }, null, 2) + '\n';
if (output) {
  const temporary = `${output}.${randomUUID()}.tmp`;
  let created = false;
  try {
    const fd = openSync(temporary, 'wx');
    created = true;
    try { writeFileSync(fd, report); } finally { closeSync(fd); }
    renameSync(temporary, output);
  } finally { if (created) rmSync(temporary, { force: true }); }
}
process.stdout.write(report);
