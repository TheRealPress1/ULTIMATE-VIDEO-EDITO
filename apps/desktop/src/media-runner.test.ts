/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it, vi } from "vitest";
import { DapiError } from "@diffusionstudio/dapi";
import { downloaderError, runRecovering } from "./media-runner";

import type { DownloaderRun, MediaDownloader } from "./media-runner";

const ok = (stdout = "{}"): DownloaderRun => ({ code: 0, signal: null, stdout, stderr: "" });
const failed = (line: string): DownloaderRun => ({ code: 1, signal: null, stdout: "", stderr: `[youtube] x: Downloading webpage\nERROR: ${line}\n` });

const OUTDATED = "[youtube] AbCdEfGhIj0: Unable to extract nsig function code; please report this issue on https://github.com/yt-dlp/yt-dlp/issues";
const NETWORK = "[youtube] AbCdEfGhIj0: Unable to download webpage: <urlopen error [Errno 8] nodename nor servname provided, or not known>";
const PRIVATE = "[youtube] AbCdEfGhIj0: Private video. Sign in if you've been granted access to this video";

function fake(runs: DownloaderRun[], update: { version: string; changed: boolean } | Error = { version: "2026.11.01", changed: true }) {
  const downloader = {
    status: () => ({ state: "ready" as const, version: "2026.10.26" }),
    ensure: vi.fn(async () => ({ path: "/bin/yt-dlp", version: "2026.10.26" })),
    update: vi.fn(async () => { if (update instanceof Error) throw update; return update; }),
    run: vi.fn(async () => runs.shift() ?? ok()),
  } satisfies MediaDownloader;
  return downloader;
}

const options = (signal = new AbortController().signal) => ({ signal, purpose: "download" as const, site: "youtube", networkRetryMs: 0 });

describe("runRecovering", () => {
  it("installs the downloader first and passes the run options through", async () => {
    const downloader = fake([ok("{\"a\":1}")]);
    const onStdoutLine = () => {};
    const run = await runRecovering(downloader, ["-J", "x"], { ...options(), timeoutMs: 5, onStdoutLine });
    expect(run).toMatchObject({ stdout: "{\"a\":1}", version: "2026.10.26", notes: [] });
    expect(downloader.ensure).toHaveBeenCalledOnce();
    expect(downloader.run).toHaveBeenCalledWith(["-J", "x"], expect.objectContaining({ timeoutMs: 5, onStdoutLine }));
  });

  it("updates once after an outdated failure and runs again with the new version", async () => {
    const downloader = fake([failed(OUTDATED), ok()]);
    const run = await runRecovering(downloader, ["x"], options());
    expect(downloader.update).toHaveBeenCalledOnce();
    expect(downloader.run).toHaveBeenCalledTimes(2);
    expect(run.version).toBe("2026.11.01");
    expect(run.notes).toEqual(["The downloader was updated to yt-dlp 2026.11.01 to read this page."]);
    expect(run.updated).toBe(true);
  });

  it("lets the caller read again with the new version between the update and the retry", async () => {
    const order: string[] = [];
    const downloader = fake([failed(OUTDATED), ok()]);
    downloader.run.mockImplementation(async () => { order.push("run"); return order.length === 1 ? failed(OUTDATED) : ok(); });
    downloader.update.mockImplementation(async () => { order.push("update"); return { version: "2026.11.01", changed: true }; });
    const refresh = vi.fn(async () => { order.push("refresh"); });
    await runRecovering(downloader, ["x"], { ...options(), refresh });
    expect(order).toEqual(["run", "update", "refresh", "run"]);

    // Nothing to refresh when the run worked the first time.
    const fine = fake([ok()]);
    const unused = vi.fn(async () => {});
    expect(await runRecovering(fine, ["x"], { ...options(), refresh: unused })).toMatchObject({ updated: false });
    expect(unused).not.toHaveBeenCalled();
  });

  it("doesn't update again when the call already did", async () => {
    const downloader = fake([failed(OUTDATED), ok()]);
    const error = (await runRecovering(downloader, ["x"], { ...options(), updated: true }).catch((thrown: Error) => thrown)) as Error;
    expect(downloader.update).not.toHaveBeenCalled();
    expect(downloader.run).toHaveBeenCalledOnce();
    expect(error.message).toMatch(/up to date \(yt-dlp 2026\.10\.26\) and still can't read this page/);
  });

  it("never updates twice: a second outdated failure is final", async () => {
    const downloader = fake([failed(OUTDATED), failed(OUTDATED), ok()]);
    const error = await runRecovering(downloader, ["x"], options()).catch((thrown: DapiError) => thrown);
    expect(downloader.update).toHaveBeenCalledOnce();
    expect(downloader.run).toHaveBeenCalledTimes(2);
    expect(error).toBeInstanceOf(DapiError);
    expect(error).toMatchObject({ code: "unsupported" });
    expect((error as Error).message).toMatch(/up to date \(yt-dlp 2026\.11\.01\) and still can't read this page/);
    expect((error as Error).message).not.toMatch(/github\.com|please report/);
  });

  it("doesn't run again when the update found nothing newer", async () => {
    const downloader = fake([failed(OUTDATED), ok()], { version: "2026.10.26", changed: false });
    const error = (await runRecovering(downloader, ["x"], options()).catch((thrown: Error) => thrown)) as Error;
    expect(downloader.run).toHaveBeenCalledOnce();
    expect(error.message).toMatch(/up to date \(yt-dlp 2026\.10\.26\)/);
  });

  it("says so when the update itself fails", async () => {
    const downloader = fake([failed(OUTDATED)], new Error("GitHub answered 503"));
    const error = (await runRecovering(downloader, ["x"], options()).catch((thrown: Error) => thrown)) as Error;
    expect(error.message).toMatch(/updating it failed \(GitHub answered 503\)/);
  });

  it("runs once more after a network failure, and no more", async () => {
    const recovered = fake([failed(NETWORK), ok()]);
    await runRecovering(recovered, ["x"], options());
    expect(recovered.run).toHaveBeenCalledTimes(2);
    expect(recovered.update).not.toHaveBeenCalled();

    const offline = fake([failed(NETWORK), failed(NETWORK), ok()]);
    const error = await runRecovering(offline, ["x"], options()).catch((thrown: DapiError) => thrown);
    expect(offline.run).toHaveBeenCalledTimes(2);
    expect(error).toMatchObject({ code: "invalid-input" });
    expect((error as Error).message).toMatch(/^Couldn't reach YouTube .*Check the internet connection, then try once more\.$/);
  });

  it("never retries anything else", async () => {
    const downloader = fake([failed(PRIVATE), ok()]);
    const error = await runRecovering(downloader, ["x"], options()).catch((thrown: DapiError) => thrown);
    expect(downloader.run).toHaveBeenCalledOnce();
    expect(error).toMatchObject({ code: "not-found" });
    expect((error as Error).message).toMatch(/won't work on retry\.$/);
  });

  it("stops at once when the call is canceled", async () => {
    const controller = new AbortController();
    const downloader = fake([]);
    downloader.run.mockImplementation(async () => { controller.abort(new DapiError("canceled", "The download was canceled.")); return failed(NETWORK); });
    const error = await runRecovering(downloader, ["x"], options(controller.signal)).catch((thrown: DapiError) => thrown);
    expect(error).toMatchObject({ code: "canceled" });
    expect(downloader.run).toHaveBeenCalledOnce();
  });

  it("explains a downloader that can't be set up", async () => {
    const downloader = fake([]);
    downloader.ensure.mockRejectedValueOnce(new Error("checksum mismatch for yt-dlp_macos.zip"));
    const error = await runRecovering(downloader, ["x"], options()).catch((thrown: DapiError) => thrown);
    expect(error).toMatchObject({ code: "unsupported" });
    expect((error as Error).message).toMatch(/couldn't set up its downloader \(yt-dlp\): checksum mismatch .*Settings > Downloads/);
    expect(downloader.run).not.toHaveBeenCalled();
  });
});

describe("downloaderError", () => {
  const situation = { purpose: "download" as const, version: "2026.10.26" };
  it("tells a slow metadata read apart from a slow download", () => {
    const error = downloaderError({ category: "too-large", reason: "timeout", detail: "" }, { purpose: "metadata", site: "youtube", version: "x" });
    expect(error.code).toBe("canceled");
    expect(error.message).toBe("YouTube took too long to say what this link holds. Try once more in a moment; for a playlist or channel, pass the upload's own link instead.");
  });

  it("doesn't call a public Vimeo video one for signed-in viewers when Vimeo refuses the downloader for every video", async () => {
    const downloader = fake([failed("[vimeo] 76979871: The web client only works when logged-in. Use --cookies, --cookies-from-browser, --username and --password, --netrc-cmd, or --netrc (vimeo) to provide account credentials. See  https://github.com/yt-dlp/yt-dlp/wiki/FAQ#how-do-i-pass-cookies-to-yt-dlp  for how to manually pass cookies")]);
    const error = await runRecovering(downloader, ["https://vimeo.com/76979871"], { signal: new AbortController().signal, purpose: "download", site: "vimeo" }).catch((thrown: DapiError) => thrown);
    expect(error).toMatchObject({ code: "sign-in-required" });
    expect((error as Error).message).toBe(
      "Vimeo lets the downloader read its videos only when signed in, public ones included (The web client only works when logged-in), and Cutroom doesn't sign in to sites. Ask the user for their own copy of the file, or choose a source on another site.",
    );
  });

  it.each([
    [{ category: "live", detail: "This live event will begin in 3 hours" }, "unsupported", /once the stream has ended/],
    [{ category: "account", detail: "Sign in to confirm your age", site: "YouTube" }, "sign-in-required", /^YouTube only shows this to signed-in viewers .*ask the user for their own copy/],
    [{ category: "account", reason: "bot-check", detail: "Sign in to confirm you're not a bot", site: "YouTube" }, "sign-in-required", /bot check .*another network/],
    [{ category: "blocked", reason: "rate-limited", detail: "HTTP Error 429: Too Many Requests", site: "TikTok" }, "busy", /^TikTok is limiting requests .*Wait several minutes/],
    [{ category: "blocked", reason: "os-blocked", detail: "Bad CPU type" }, "unsupported", /Settings > Downloads/],
    [{ category: "format", detail: "Requested format is not available" }, "unsupported", /kind: "audio"/],
    [{ category: "too-large", reason: "disk-full", detail: "No space left on device" }, "invalid-input", /Free some space/],
    [{ category: "too-large", reason: "byte-cap", detail: "over its limit" }, "invalid-input", /lower `maxHeight`/],
    [{ category: "too-large", reason: "timeout", detail: "" }, "canceled", /^The download took too long and was stopped\. .*lower `maxHeight`/],
    [{ category: "unavailable", reason: "private-address", detail: "Refused" }, "invalid-input", /private network address/],
    [{ category: "canceled", detail: "" }, "canceled", /canceled/],
    [{ category: "unknown", detail: "something odd" }, "invalid-input", /something odd.*report tool/],
  ] as const)("%j is a final %s error that says what to do", (failure, code, message) => {
    const error = downloaderError(failure, situation);
    expect(error.code).toBe(code);
    expect(error.message).toMatch(message);
    expect(error.message).toMatch(/[.!]$/);
  });
});
