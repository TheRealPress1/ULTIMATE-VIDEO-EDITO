/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { realpathSync } from "node:fs";
import { lstat, mkdir, mkdtemp, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { DapiError, flattenSegmentJob, generatedPath } from "@diffusionstudio/dapi";
import { tempPathFor } from "../atomic";
import { assertWritable, outputKind } from "./output-policy";

import type { GenerationResult, TimecodedImage, ToolArgs, ToolName, ToolOutput, ToolResult } from "@diffusionstudio/dapi";
import type { OutputKind, WritePolicy } from "./output-policy";

/** A file the tool wrote, kept in memory only long enough to decide whether to inline it; a PNG unless `mimeType` says otherwise. */
export type WrittenImage = { path: string; bytes: Uint8Array; mimeType?: string };

export type Presented = { output: unknown; images: WrittenImage[] };

/** More than this, or any image larger than INLINE_MAX_BYTES, and the caller gets paths only. */
const INLINE_MAX_IMAGES = 4;
const INLINE_MAX_BYTES = 1 << 20;

const APP_SLUG = "cutroom";

/**
 * The temp dir with its real spelling. On Windows `%TEMP%` is often set with short names
 */
function tempDir(): string {
  const dir = tmpdir();
  try {
    return realpathSync.native(dir);
  } catch {
    return dir;
  }
}

/**
 * Writes what the tool made where the caller asked and says where. With a
 * `policy` (the call's, see output-policy), each folder and file is judged by
 * it again right before it is written, where it then really is.
 */
export async function present(name: ToolName, args: unknown, result: unknown, policy?: WritePolicy): Promise<Presented> {
  const judge: Judge = policy ? (path, kind) => assertWritable(path, kind, policy) : async () => {};
  switch (name) {
    case "capture":
      return presentImages(result as ToolResult<"capture">, (args as ToolArgs<"capture">).output, "capture", judge);
    case "grab":
      return presentImages(result as ToolResult<"grab">, (args as ToolArgs<"grab">).output, "grab", judge);
    case "filmstrip":
      return presentPreview(result as ToolResult<"filmstrip">, (args as ToolArgs<"filmstrip">).output, "filmstrip", judge);
    case "waveform":
      return presentPreview(result as ToolResult<"waveform">, (args as ToolArgs<"waveform">).output, "waveform", judge);
    case "screenshot":
      return presentScreenshot(result as ToolResult<"screenshot">, (args as ToolArgs<"screenshot">).output, judge);
    case "transcribe":
      return presentTranscript(result as ToolResult<"transcribe">, (args as ToolArgs<"transcribe">).output, judge);
    case "generate":
      if ((args as ToolArgs<"generate">).estimate) return { output: result, images: [] };
      return presentJob(result as GenerationResult, judge);
    case "job":
      return presentJob(result as GenerationResult, judge);
    case "web_media_search":
      return presentWebMedia(result as ToolResult<"web_media_search">, judge);
    case "sound_analyze":
      return presentSound(result as ToolResult<"sound_analyze">);
    case "media_search":
      return presentMediaSearch(result as ToolResult<"media_search">, judge);
    case "analyze":
      return presentAnalysis(result as ToolResult<"analyze">, judge);
    case "segment":
      return presentSegment(result as ToolResult<"segment">, (args as ToolArgs<"segment">).preview === true, judge);
    default:
      return { output: result, images: [] };
  }
}

/** Throws when the call may not write `path` (as `kind`) right now; see `present`. */
type Judge = (path: string, kind: OutputKind) => Promise<void>;

export const OUTPUT_MOVED = "The output folder changed on disk while the tool ran, so nothing more was written to it. Run the tool again.";

// Every file here is written so that no link decides where it lands. An
// agent's shell may write in the project and temp folders, links included,
// so a link planted at a frame's name, in place of the output folder, or at
// a parent of a folder still to be made would otherwise carry the write to
// any file the app can reach. So folders are made, and files written, by the
// real path judged a moment before; a file replaced is written beside its
// name and renamed over it, which replaces a link rather than following it;
// and a fresh file is created only where nothing, not even a link, is.

/**
 * Where `dir` really is, made when it is missing and judged right before
 * anything is written into it. Missing folders are made one at a time below
 * the real path of the nearest existing one, never through `dir`'s spelling,
 * so a link planted at a parent since the call was checked is judged where it
 * leads instead of being followed; files then go in by that real path, so
 * swapping `dir` for a link afterwards changes nothing.
 */
async function realFolder(dir: string, judge: Judge, kind: OutputKind): Promise<string> {
  const given = resolve(dir);
  await judge(given, kind);
  const missing: string[] = [];
  let existing = given;
  while (!(await lstat(existing).catch(() => null))) {
    if (dirname(existing) === existing) throw new Error(`${dir} is on no disk this machine has`);
    missing.unshift(basename(existing));
    existing = dirname(existing);
  }
  let real = await realpath(existing).catch(() => {
    throw new DapiError("invalid-input", OUTPUT_MOVED);
  });
  await judge(join(real, ...missing), kind);
  for (const part of missing) {
    real = join(real, part);
    await mkdir(real).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
  }
  await unmoved(real);
  return real;
}

/** Throws unless the real folder `dir` is still a folder there: nothing along its path has become a link. */
async function unmoved(dir: string): Promise<void> {
  const [real, entry] = await Promise.all([realpath(dir).catch(() => null), lstat(dir).catch(() => null)]);
  if (real !== dir) throw new DapiError("invalid-input", OUTPUT_MOVED);
  if (!entry?.isDirectory()) throw new Error(`${dir} is not a folder`);
}

/** Writes `name` in the real folder `dir`, over whatever is there: a temp file beside it, renamed into place. */
async function replaceFile(dir: string, name: string, data: Uint8Array | string): Promise<void> {
  await unmoved(dir);
  const path = join(dir, name);
  const temp = tempPathFor(path);
  try {
    await writeFile(temp, data, { flag: "wx" });
    await rename(temp, path);
  } catch (error) {
    await unlink(temp).catch(() => {});
    throw error;
  }
}

/** Writes `name` in the real folder `dir` only where nothing is, not even a link; false when something is. */
async function createFile(dir: string, name: string, data: Uint8Array | string): Promise<boolean> {
  await unmoved(dir);
  try {
    await writeFile(join(dir, name), data, { flag: "wx" });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

// Frames and contact sheets arrive in the same shape: each image is stamped
// with its timecode (`08s10f`, or `0f-08s10f` for a sheet), which is the
// filename too.
async function presentImages(images: TimecodedImage[], output: string | undefined, kind: string, judge: Judge): Promise<Presented> {
  const dir = output ?? (await mkdtemp(join(tempDir(), `dapi-${kind}-`)));
  const real = await realFolder(dir, judge, outputKind(kind));
  const written: WrittenImage[] = [];
  const refs: ToolOutput<"capture">["images"] = [];
  for (const { timecode, png } of images) {
    const name = `${timecode}.png`;
    await replaceFile(real, name, png);
    const path = join(dir, name);
    written.push({ path, bytes: png });
    refs.push({ timecode, path });
  }
  return { output: { images: refs }, images: written };
}

/**
 * Writes a single-file tool's file and says where: at `output` when given,
 * over what is there; under the fresh `name` in the temp dir otherwise, or
 * inside `output` when it names an existing folder rather than an EISDIR.
 */
async function writeSingle(output: string | undefined, name: string, data: Uint8Array | string, kind: OutputKind, judge: Judge): Promise<string> {
  const folder = output === undefined ? tempDir() : (await stat(output).catch(() => null))?.isDirectory() ? output : null;
  if (folder !== null) {
    const real = await realFolder(folder, judge, kind);
    if (!(await createFile(real, name, data))) throw new Error(`${join(folder, name)} already exists`);
    return join(folder, name);
  }
  const file = output!;
  await judge(resolve(file), kind);
  const real = await realFolder(dirname(file), judge, "fresh");
  await judge(join(real, basename(file)), kind);
  await replaceFile(real, basename(file), data);
  return file;
}

async function presentPreview(
  result: { png: Uint8Array } & Record<string, unknown>,
  output: string | undefined,
  kind: "filmstrip" | "waveform",
  judge: Judge,
): Promise<Presented> {
  const { png, ...rest } = result;
  const path = await writeSingle(output, `dapi-${kind}-${randomUUID()}.png`, png, outputKind(kind), judge);
  return { output: { path, ...rest }, images: [{ path, bytes: png }] };
}

async function presentScreenshot(result: ToolResult<"screenshot">, output: string | undefined, judge: Judge): Promise<Presented> {
  const dir = output ?? tempDir();
  const real = await realFolder(dir, judge, outputKind("screenshot"));
  const taken = new Date();
  let attempt = 1;
  while (!(await createFile(real, screenshotFilename(taken, attempt), result.png))) attempt++;
  const path = join(dir, screenshotFilename(taken, attempt));
  const presented: ToolOutput<"screenshot"> = { path, width: result.width, height: result.height };
  return { output: presented, images: [{ path, bytes: result.png }] };
}

async function presentTranscript(transcript: ToolResult<"transcribe">, output: string | undefined, judge: Judge): Promise<Presented> {
  const text = JSON.stringify(transcript, null, 2);
  const path = await writeSingle(output, `dapi-transcript-${randomUUID()}.json`, text, outputKind("transcribe"), judge);
  const { segments, ...meta } = transcript;
  const words = segments.reduce((sum, segment) => sum + segment.words.length, 0);
  const presented: ToolOutput<"transcribe"> = { path, segments: segments.length, words, ...meta };
  return { output: presented, images: [] };
}

/** An analysis's contact sheets go to a fresh temp folder, inlined in order when few and small enough; each sheet's path replaces its bytes. */
async function presentAnalysis({ sheets, ...answer }: ToolResult<"analyze">, judge: Judge): Promise<Presented> {
  if (!sheets?.length) return { output: answer, images: [] };
  const { images, paths } = await writePreviews(sheets.map(({ index, bytes, mimeType }) => ({ index, bytes, mimeType })), "dapi-analyze-", judge);
  const shown: ToolOutput<"analyze"> = {
    ...answer,
    sheets: sheets.flatMap(({ bytes: _bytes, mimeType: _mimeType, ...sheet }) => (paths.has(sheet.index) ? [{ ...sheet, path: paths.get(sheet.index)! }] : [])),
  };
  return { output: shown, images };
}

/** A segment call's job, presented as `job` presents it (its picture and any file bound for disk written), then flattened. */
async function presentSegment(result: GenerationResult, preview: boolean, judge: Judge): Promise<Presented> {
  const { output, images } = await presentJob(result, judge);
  return { output: flattenSegmentJob(output as GenerationResult["job"], preview), images };
}

const PREVIEW_EXTENSIONS: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif" };

/**
 * Search thumbnails go to a fresh directory under the temp dir, named by
 * result index, and each result whose thumbnail came gets its path. They
 * are inlined in their own format, in result order.
 */
async function presentWebMedia({ results, warnings, previews }: ToolResult<"web_media_search">, judge: Judge): Promise<Presented> {
  if (!previews.length) return { output: { results, warnings }, images: [] };
  const { images, paths } = await writePreviews(previews, "dapi-web-media-", judge);
  const shown: ToolOutput<"web_media_search"> = {
    results: results.map((result) => (paths.has(result.index) ? { ...result, previewPath: paths.get(result.index)! } : result)),
    warnings,
  };
  return { output: shown, images };
}

/** Thumbnails by result index into a fresh temp folder, inlined in result order; each written one's path, by index. */
async function writePreviews(previews: Array<{ index: number; bytes: Uint8Array; mimeType: string }>, prefix: string, judge: Judge): Promise<{ images: WrittenImage[]; paths: Map<number, string> }> {
  const images: WrittenImage[] = [];
  const paths = new Map<number, string>();
  if (!previews.length) return { images, paths };
  const dir = await mkdtemp(join(tempDir(), prefix));
  const real = await realFolder(dir, judge, "fresh");
  for (const { index, bytes, mimeType } of [...previews].sort((a, b) => a.index - b.index)) {
    const name = `${index}.${PREVIEW_EXTENSIONS[mimeType] ?? "img"}`;
    if (!(await createFile(real, name, bytes))) continue;
    const path = join(dir, name);
    images.push({ path, bytes, mimeType });
    paths.set(index, path);
  }
  return { images, paths };
}

/** Platform search thumbnails, as web media's are (see `presentWebMedia`). */
async function presentMediaSearch({ previews, ...answer }: ToolResult<"media_search">, judge: Judge): Promise<Presented> {
  const { images, paths } = await writePreviews(previews, "dapi-media-search-", judge);
  const shown: ToolOutput<"media_search"> = {
    ...answer,
    results: answer.results.map((result) => (paths.has(result.index) ? { ...result, previewPath: paths.get(result.index)! } : result)),
  };
  return { output: shown, images };
}

/** A sound sheet's PNG is in the temp folder main made for it; the JPEG copy earshot sent along is what gets inlined. */
function presentSound({ image, ...output }: ToolResult<"sound_analyze">): Presented {
  return { output, images: image && output.sheet ? [{ path: output.sheet, bytes: image.bytes, mimeType: image.mimeType }] : [] };
}

/** Files of succeeded jobs saved to disk, by job id: the first poll that sees a job succeed saves them, the rest reuse the paths. */
const jobFiles = new Map<string, Promise<string[]>>();

/** Pictures of local jobs, by job id: each is written to the temp dir, and shown inline, the first poll it comes with. */
const jobImages = new Map<string, string>();

/**
 * A job's files bound for disk are saved once it has succeeded — downloaded
 * from their `url`, or written from the `bytes` a local model made — to
 * `saveTo` (see `generatedPath`; a file already there is written over, as the
 * other tools' outputs are) or under their own names into a directory of the
 * job's own under the temp dir, and their `url` or `bytes` is swapped for the
 * `path`. Files the renderer saved into the library arrive with their paths.
 * A local job's picture goes to the temp dir, named in `details.image`.
 */
async function presentJob({ job, saveTo, image }: GenerationResult, judge: Judge): Promise<Presented> {
  const images: WrittenImage[] = [];
  let shown = job;
  if (image) {
    let path = jobImages.get(job.id);
    if (path === undefined) {
      const name = `dapi-${job.id}.png`;
      await replaceFile(await realFolder(tempDir(), judge, "fresh"), name, image);
      path = join(tempDir(), name);
      jobImages.set(job.id, path);
      images.push({ path, bytes: image });
    }
    shown = { ...job, details: { ...job.details, image: path } };
  }

  const pending = job.assets.filter((file) => file.url !== undefined || file.bytes !== undefined);
  if (job.status !== "succeeded" || pending.length === 0) return { output: shown, images };

  let paths = jobFiles.get(job.id);
  if (!paths) {
    const temp = join(tempDir(), `dapi-generate-${job.id}`);
    const targets = job.assets.map((file, i) =>
      saveTo === null ? join(temp, basename(file.filename)) : generatedPath(saveTo, file.filename, i, job.assets.length),
    );
    paths = saveAll(job.assets, targets, judge);
    paths.catch(() => jobFiles.delete(job.id));
    jobFiles.set(job.id, paths);
  }
  const written = await paths;
  const assets = job.assets.map(({ url: _url, bytes: _bytes, ...file }, i) => ({ ...file, path: written[i] }));
  return { output: { ...shown, assets }, images };
}

async function saveAll(files: GenerationResult["job"]["assets"], targets: string[], judge: Judge): Promise<string[]> {
  for (const [i, file] of files.entries()) {
    const target = targets[i]!;
    const bytes = file.bytes ?? (await download(file.url!, file.filename));
    const real = await realFolder(dirname(target), judge, "fresh");
    await judge(join(real, basename(target)), "file");
    await replaceFile(real, basename(target), bytes);
  }
  return targets;
}

async function download(url: string, filename: string): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not download ${filename} (${response.status})`);
  return new Uint8Array(await response.arrayBuffer());
}

function screenshotFilename(taken: Date, attempt: number): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  const date = [taken.getFullYear(), pad(taken.getMonth() + 1), pad(taken.getDate())].join("-");
  const time = [pad(taken.getHours()), pad(taken.getMinutes()), pad(taken.getSeconds())].join("-");
  return `${APP_SLUG}_${date}_${time}${attempt > 1 ? `-${attempt}` : ""}.png`;
}

/** The MCP result: the output as text and structured content, plus the images when they are few and small. */
export function toCallToolResult({ output, images }: Presented): CallToolResult {
  const content: CallToolResult["content"] = [{ type: "text", text: JSON.stringify(output) }];
  const inline = images.length <= INLINE_MAX_IMAGES && images.every((image) => image.bytes.byteLength <= INLINE_MAX_BYTES);
  if (inline) {
    for (const { bytes, mimeType } of images) {
      content.push({ type: "image", data: Buffer.from(bytes).toString("base64"), mimeType: mimeType ?? "image/png" });
    }
  }
  return { content, structuredContent: output as Record<string, unknown> };
}

/** A failure the agent reads as a sentence, not a protocol error. */
export function toErrorResult(error: unknown): CallToolResult {
  return { isError: true, content: [{ type: "text", text: (error as Error).message }] };
}
