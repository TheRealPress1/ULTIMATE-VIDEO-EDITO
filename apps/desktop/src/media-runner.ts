/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// How media_search and media_download run the managed downloader: install it
// on first use, run it, and recover inside the call from the two failures a
// second try fixes. An extractor that no longer reads a site (`outdated`)
// gets one update of the downloader and one more run; a dropped connection
// (`network`) gets one more run after a short wait. Nothing else is retried,
// and no call retries more than that, so an error that reaches the agent is
// final and says what to do instead.

import { DapiError } from "@diffusionstudio/dapi";
import { classifyYtDlpError } from "./downloader";
import { siteName } from "./platform-url";

import type { DapiErrorCode } from "@diffusionstudio/dapi";
import type { ManagedRunOptions, YtDlp, YtDlpError, YtDlpRunResult } from "./downloader";

export type DownloaderRunOptions = ManagedRunOptions;
export type DownloaderRun = YtDlpRunResult;

/** The managed yt-dlp as the media tools use it (see ./downloader). */
export type MediaDownloader = Pick<YtDlp, "status" | "ensure" | "update" | "run">;

export type ClassifyDownloaderError = (stderr: string, code: number | null, signal?: NodeJS.Signals | null) => YtDlpError;

/** What a run is for, which some messages differ by. */
export type RunPurpose = "search" | "metadata" | "download";

export type RecoveringRun = DownloaderRun & {
  /** The downloader's version that made the run. */
  version: string;
  /** Notes for the agent about what recovering took (an update), which the result carries. */
  notes: string[];
  /** Whether the downloader was updated during this run. */
  updated: boolean;
};

export type RecoveryOptions = DownloaderRunOptions & {
  signal: AbortSignal;
  purpose: RunPurpose;
  /** The site the run reads, for messages, when the link says. */
  site?: string;
  classify?: ClassifyDownloaderError;
  /** The wait before a run that a dropped connection ended is tried again. */
  networkRetryMs?: number;
  /** The downloader was updated earlier in this call, so an `outdated` failure is final rather than worth another update. */
  updated?: boolean;
  /**
   * Runs after an update, before the run is tried again: a run built on what
   * the older downloader read (a saved info.json, whose format links came
   * from its extractor) reads it again with the new one here.
   */
  refresh?: () => Promise<void>;
  /** Told about every run that failed, with how it was classified (for logs). */
  onFailure?: (failure: YtDlpError, attempt: number) => void;
};

const NETWORK_RETRY_MS = 2_000;

function canceledError(signal: AbortSignal): DapiError {
  const reason: unknown = signal.reason;
  return reason instanceof DapiError ? reason : new DapiError("canceled", "The request was canceled.");
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(canceledError(signal));
    const timer = setTimeout(() => { signal.removeEventListener("abort", stop); resolve(); }, ms);
    const stop = () => { clearTimeout(timer); reject(canceledError(signal)); };
    signal.addEventListener("abort", stop, { once: true });
  });
}

/** The downloader installed and ready, or a final error about setting it up. */
export async function ensureDownloader(downloader: MediaDownloader, signal: AbortSignal): Promise<{ path: string; version: string }> {
  try {
    return await downloader.ensure(signal);
  } catch (error) {
    if (signal.aborted) throw canceledError(signal);
    if (error instanceof DapiError && error.code === "canceled") throw error;
    const detail = error instanceof Error ? error.message.replace(/\s+/g, " ").trim().slice(0, 300) : String(error);
    throw new DapiError(
      "unsupported",
      `Cutroom couldn't set up its downloader (yt-dlp): ${detail.replace(/\.$/, "")}. Check the internet connection, then try again; Settings > Downloads shows its state.`,
      { cause: error },
    );
  }
}

/** A run that failed before it started (it threw) as the exit the classifier reads. */
function thrownRun(error: unknown): DownloaderRun {
  const message = error instanceof Error ? error.message : String(error);
  return { code: null, signal: null, stdout: "", stderr: `ERROR: ${message}` };
}

/**
 * Runs the downloader with `args`, installing it first when it is missing,
 * and recovers as the file comment says. Resolves with the run that exited
 * 0; throws the final failure as a DapiError written for the agent.
 */
export async function runRecovering(downloader: MediaDownloader, args: string[], options: RecoveryOptions): Promise<RecoveringRun> {
  const { signal, purpose, site, classify = classifyYtDlpError, networkRetryMs = NETWORK_RETRY_MS, onFailure, updated: before = false, refresh, ...runOptions } = options;
  let { version } = await ensureDownloader(downloader, signal);
  const notes: string[] = [];
  let updated = before;
  let changed = false;
  let networkRetried = false;
  for (let attempt = 1; ; attempt++) {
    if (signal.aborted) throw canceledError(signal);
    let run: DownloaderRun;
    try {
      run = await downloader.run(args, { ...runOptions, signal });
    } catch (error) {
      if (signal.aborted) throw canceledError(signal);
      if (error instanceof DapiError) throw error;
      run = thrownRun(error);
    }
    if (signal.aborted) throw canceledError(signal);
    if (run.code === 0) return { ...run, version, notes, updated: changed };

    const failure = classify(run.stderr, run.code, run.signal);
    onFailure?.(failure, attempt);
    if (failure.category === "outdated" && !updated) {
      updated = true;
      let result: { version: string; changed: boolean };
      try {
        result = await downloader.update(signal);
      } catch (error) {
        if (signal.aborted) throw canceledError(signal);
        throw downloaderError(failure, { purpose, site, version, updateFailed: error instanceof Error ? error.message : String(error) });
      }
      if (!result.changed) throw downloaderError(failure, { purpose, site, version, current: true });
      notes.push(`The downloader was updated to yt-dlp ${result.version} to read this page.`);
      version = result.version;
      changed = true;
      await refresh?.();
      continue;
    }
    if (failure.category === "network" && !networkRetried) {
      networkRetried = true;
      await wait(networkRetryMs, signal);
      continue;
    }
    throw downloaderError(failure, { purpose, site, version, updated });
  }
}

type Situation = {
  purpose: RunPurpose;
  site?: string;
  version: string;
  /** The update after an `outdated` failure found nothing newer. */
  current?: boolean;
  /** The downloader was updated during this call, and it still failed. */
  updated?: boolean;
  /** Why the update after an `outdated` failure failed. */
  updateFailed?: string;
};

/** The failure's detail as a parenthetical, or nothing when there is none. */
function aside(detail: string): string {
  const text = detail.replace(/\.$/, "").trim();
  return text ? ` (${text})` : "";
}

/** A final downloader failure as the error the agent reads: what happened and, last, what to do. */
export function downloaderError(failure: YtDlpError, situation: Situation): DapiError {
  const place = failure.site ?? (situation.site ? siteName(situation.site) : undefined);
  const where = place ?? "The site";
  const detail = aside(failure.detail);
  const error = (code: DapiErrorCode, message: string) => new DapiError(code, message);
  switch (failure.category) {
    case "canceled":
      return error("canceled", "The download was canceled.");
    case "unavailable":
      if (failure.reason === "private-address") {
        return error("invalid-input", "That link leads to a local or private network address, which Cutroom doesn't download from. Use a public link.");
      }
      if (failure.reason === "drm") return error("unsupported", `${where} protects this with DRM${detail}, so it can't be downloaded. Choose another source or ask the user for their own copy.`);
      if (failure.reason === "geo") return error("not-found", `${where} doesn't offer this in this country${detail}. Choose another source; this link won't work on retry.`);
      return error("not-found", situation.purpose === "search"
        ? `${where} has nothing to list there${detail}. Check the name or link, or search instead.`
        : `This media can't be downloaded${detail}. Choose a different source; this link won't work on retry.`);
    case "live":
      return error("unsupported", `This is a live or upcoming stream${detail}. Download it once the stream has ended, or choose another source.`);
    case "account":
      if (failure.reason === "bot-check") {
        return error("sign-in-required", `${place ?? "YouTube"} asked for a bot check${detail}, which happens on VPNs and shared networks. Try again later on another network, or import the user's own copy.`);
      }
      // Vimeo's site answers this for every video now, public ones included: it is about the downloader, not this upload.
      if (/only works when logged[- ]in/i.test(failure.detail)) {
        return error("sign-in-required", `${where} lets the downloader read its videos only when signed in, public ones included${detail}, and Cutroom doesn't sign in to sites. Ask the user for their own copy of the file, or choose a source on another site.`);
      }
      return error("sign-in-required", `${where} only shows this to signed-in viewers${detail}. Cutroom doesn't sign in to sites: choose another source, or ask the user for their own copy of the file.`);
    case "outdated":
      if (situation.updateFailed) {
        return error("unsupported", `The downloader couldn't read this page${detail}, and updating it failed (${situation.updateFailed.replace(/\.$/, "")}). Check the internet connection, then try once more.`);
      }
      if (situation.current || situation.updated) {
        return error("unsupported", `The downloader is up to date (yt-dlp ${situation.version}) and still can't read this page${detail}. ${where} may be blocking downloads right now; tell the user rather than retrying.`);
      }
      return error("unsupported", `The downloader couldn't read this page${detail}. Tell the user rather than retrying.`);
    case "network":
      if (failure.reason === "stalled") return error("invalid-input", `${where} stopped sending data${detail}. Check the internet connection, then try once more.`);
      return error("invalid-input", `Couldn't reach ${place ?? "the site"}${detail}. Check the internet connection, then try once more.`);
    case "blocked":
      if (failure.reason === "rate-limited") return error("busy", `${where} is limiting requests from this network${detail}. Wait several minutes before trying again, or choose another source.`);
      return error("unsupported", `macOS stopped the downloader from running${detail}. Reinstall it from Settings > Downloads, or allow it in System Settings > Privacy & Security.`);
    case "format":
      return error("unsupported", `${where} offers no format Cutroom can use for this${detail}. Try \`kind: "audio"\`, a lower \`maxHeight\`, or another source.`);
    case "too-large":
      if (failure.reason === "disk-full") return error("invalid-input", `The disk is full${detail}. Free some space, then download again.`);
      if (failure.reason === "timeout") {
        if (situation.purpose === "search") return error("canceled", `${where} took too long to answer${detail}. Try again in a moment, or narrow the search.`);
        if (situation.purpose === "metadata") {
          return error("canceled", `${where} took too long to say what this link holds${detail}. Try once more in a moment; for a playlist or channel, pass the upload's own link instead.`);
        }
        return error("canceled", `The download took too long and was stopped${detail}. Try a shorter source, \`kind: "audio"\`, or a lower \`maxHeight\`.`);
      }
      return error("invalid-input", `This file is larger than the download cap${detail}. Use \`kind: "audio"\`, a lower \`maxHeight\`, or a shorter source.`);
    default:
      return error("invalid-input", `The downloader failed${detail}. Try another source; if it keeps happening, describe it with the report tool.`);
  }
}
