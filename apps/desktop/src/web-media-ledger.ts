/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Where a project keeps what it downloaded from the web: a JSON ledger in the
// app's own folder (`.cutroom/`, which the watcher, git and Collect Project
// leave alone), and a readable CREDITS.md at the project root, rebuilt from
// the ledger, that travels with the project and holds the attribution text to
// paste into a post. The credits are a section of the file between markers,
// so a CREDITS.md the user already keeps is extended, never replaced.

import { lstat, mkdir, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { writeFileAtomic } from "./atomic";
import { PROVIDER_NAMES } from "./web-media-providers";

import type { WebMediaLedger, WebMediaLedgerItem } from "./web-media-types";

export const LEDGER_DIR = ".cutroom";
export const LEDGER_FILE = "web-media.json";
export const CREDITS_FILE = "CREDITS.md";

const START = "<!-- cutroom:web-media:start -->";
const END = "<!-- cutroom:web-media:end -->";
/** A CREDITS.md larger than this is not the app's to rewrite. */
const CREDITS_MAX = 4 * 1024 * 1024;

const emptyLedger = (): WebMediaLedger => ({ version: 1, items: [] });

/** The app's folder in the project, created when missing; refused when it is a link (it must not lead elsewhere). */
async function ledgerDir(dir: string): Promise<string> {
  const folder = join(await realpath(dir), LEDGER_DIR);
  await mkdir(folder, { recursive: true });
  const info = await lstat(folder);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("The project's .cutroom folder must be a real folder.");
  return folder;
}

function isItem(value: unknown): value is WebMediaLedgerItem {
  const item = value as WebMediaLedgerItem;
  return !!item && typeof item === "object" && typeof item.file === "string" && typeof item.sha256 === "string"
    && typeof item.fileUrl === "string" && !!item.license && typeof item.license.code === "string";
}

/** The ledger as plain data; an empty one when the project has none, and a damaged one is read as far as it is whole. */
export function parseLedger(text: string): WebMediaLedger {
  try {
    const value = JSON.parse(text) as { items?: unknown };
    return { version: 1, items: Array.isArray(value?.items) ? value.items.filter(isItem) : [] };
  } catch {
    return emptyLedger();
  }
}

export async function readLedger(dir: string): Promise<WebMediaLedger> {
  try {
    return parseLedger(await readFile(join(await realpath(dir), LEDGER_DIR, LEDGER_FILE), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyLedger();
    throw error;
  }
}

export async function writeLedger(dir: string, ledger: WebMediaLedger): Promise<void> {
  await writeFileAtomic(join(await ledgerDir(dir), LEDGER_FILE), `${JSON.stringify(ledger, null, 2)}\n`);
}

/** Where a ledger item's bytes are: inside the project, or (for a library asset with the same content) wherever that is. */
export function itemPath(dir: string, file: string): string {
  return isAbsolute(file) ? file : join(dir, ...file.split("/"));
}

export async function fileExists(path: string): Promise<boolean> {
  return (await stat(path).catch(() => null))?.isFile() ?? false;
}

/** One line of text as Markdown shows it literally. */
function md(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/[\\`*_[\]<>|#]/g, "\\$&").trim();
}

/** A link Markdown renders as itself; URLs reach here normalized, with `<`, `>` and spaces escaped. */
const link = (url: string): string => `<${url.replace(/[<>\s]/g, encodeURIComponent)}>`;

function entry(item: WebMediaLedgerItem): string {
  const name = item.src ?? item.file.split("/").pop()!;
  const lines = [`- **${md(item.title ?? name)}**: \`${name.replace(/`/g, "'")}\``];
  if (item.attribution) lines.push(`  Credit: ${md(item.attribution)}`);
  const terms = item.license.verified
    ? `${md(item.license.name)}${item.license.url ? ` (${link(item.license.url)})` : ""}.`
    : "not verified. Confirm the rights before publishing.";
  lines.push(`  License: ${terms}${item.provider ? ` Found on ${PROVIDER_NAMES[item.provider]}.` : ""}`);
  lines.push(`  Source: ${link(item.pageUrl ?? item.fileUrl)}, downloaded ${item.downloadedAt.slice(0, 10)}.`);
  return lines.join("\n");
}

/** The credits section for the items whose files are still there. */
export function creditsSection(items: WebMediaLedgerItem[]): string {
  const body = items.length
    ? items.map(entry).join("\n")
    : "No downloaded web media is in this project any more.";
  return [
    START,
    "## Web media",
    "",
    "Blackout rewrites this section from `.cutroom/web-media.json` after each `web_media_download`. Check each license before publishing, and paste the credit lines into the post's caption or description where a license asks for attribution.",
    "",
    body,
    END,
  ].join("\n");
}

/** `existing` CREDITS.md with its web media section replaced, or appended; a new file when there is none. */
export function mergeCredits(existing: string | null, section: string): string {
  if (existing === null || !existing.trim()) return `# Credits\n\n${section}\n`;
  const start = existing.indexOf(START);
  const end = existing.indexOf(END, start);
  if (start >= 0 && end >= 0) return `${existing.slice(0, start)}${section}${existing.slice(end + END.length)}`;
  return `${existing.trimEnd()}\n\n${section}\n`;
}

/**
 * Rewrites CREDITS.md from the ledger, claiming the content first so the
 * project watcher does not take the app's own write for an edit and reload
 * the project. Returns its path.
 */
export async function writeCredits(
  dir: string,
  ledger: WebMediaLedger,
  noteContent: (path: string, text: string | null) => void,
): Promise<string> {
  const path = join(dir, CREDITS_FILE);
  const present: WebMediaLedgerItem[] = [];
  for (const item of ledger.items) if (await fileExists(itemPath(dir, item.file))) present.push(item);
  const info = await lstat(path).catch(() => null);
  if (info && (!info.isFile() || info.size > CREDITS_MAX)) return path;
  const existing = info ? await readFile(path, "utf8") : null;
  const text = mergeCredits(existing, creditsSection(present));
  if (text === existing) return path;
  noteContent(path, text);
  await writeFileAtomic(path, text);
  return path;
}
