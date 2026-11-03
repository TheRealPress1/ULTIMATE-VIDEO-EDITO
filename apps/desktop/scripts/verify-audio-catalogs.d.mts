/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

export type VerifyOptions = {
  kinds: Array<'music' | 'sfx'>;
  ids: Set<string> | null;
  ytDlp: string;
  ffprobe: string;
  ffmpeg: string | null;
  download: boolean;
  json: boolean;
  docsDir: string;
};
export type RunResult = { code: number; stdout: string; stderr: string };
export type VerifyDeps = {
  ytDlp(args: string[]): Promise<RunResult>;
  fetch(url: string, init: { headers: Record<string, string> }): Promise<Response>;
  download: boolean;
  measure(path: string, entry: CatalogEntryLike): Promise<{ duration: number; loudnessLufs?: number }>;
};
export type CatalogEntryLike = {
  id: string;
  title: string;
  sourceUrl: string;
  durationSeconds: number;
  sourceRange?: { start: number; end: number };
  sections?: Array<{ label: string; start: number; end: number }>;
  hitAt?: number;
  loudnessLufs?: number;
};
export type VerifyResult = { id: string; kind: 'music' | 'sfx'; title: string; status: 'ok' | 'fail'; problems: string[]; notes: string[] };

export const DEFAULT_DOCS: string;
export const METADATA_SLACK: number;
export const PROBE_SLACK: number;
export const LOUDNESS_SLACK: number;
export function parseArgs(argv: string[]): VerifyOptions;
export function timingAgainst(entry: CatalogEntryLike, duration: number): string[];
export function checkMetadata(entry: CatalogEntryLike, info: Record<string, unknown>): { fail: string[]; notes: string[] };
export function checkMeasured(entry: CatalogEntryLike, measured: { duration: number; loudnessLufs?: number }): string[];
export function verifyEntry(entry: CatalogEntryLike, kind: 'music' | 'sfx', deps: VerifyDeps): Promise<VerifyResult>;
export function verifyCatalogs(options: Pick<VerifyOptions, 'kinds' | 'ids' | 'docsDir'>, deps: VerifyDeps): Promise<VerifyResult[]>;
export function formatReport(results: VerifyResult[]): string;
export function defaultDeps(options: VerifyOptions): VerifyDeps;
