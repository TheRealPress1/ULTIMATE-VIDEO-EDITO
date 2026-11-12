/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChecksumError, fetchVerified, folderBytes, lastLine, spawnRunner } from "./process";

import type { Fetch } from "./process";

let dir: string;
const bytes = new TextEncoder().encode("the pinned bytes");
const sha256 = createHash("sha256").update(bytes).digest("hex");
const file = { url: "https://github.com/astral-sh/uv/releases/download/0.13.7/uv-aarch64-apple-darwin.tar.gz", sha256, bytes: bytes.byteLength };

/** GitHub as far as a download sees it: a redirect to its asset host, then the bytes. */
function github(body: Uint8Array = bytes, asset = "https://release-assets.githubusercontent.com/github-production-release-asset/1?sig=x"): { fetch: Fetch; urls: string[] } {
  const urls: string[] = [];
  const fetch: Fetch = async (url, init) => {
    urls.push(url);
    expect(init.redirect).toBe("manual");
    if (url === file.url) return new Response(null, { status: 302, headers: { location: asset } });
    return new Response(body, { status: 200 });
  };
  return { fetch, urls };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "earshot-process-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("fetchVerified", () => {
  it("follows GitHub's redirect, checks the hash, and only then names the file", async () => {
    const { fetch, urls } = github();
    const seen: number[] = [];
    await fetchVerified(fetch, file, join(dir, "uv.tar.gz"), new AbortController().signal, (count) => seen.push(count));
    expect(urls).toEqual([file.url, "https://release-assets.githubusercontent.com/github-production-release-asset/1?sig=x"]);
    expect(await readFile(join(dir, "uv.tar.gz"), "utf8")).toBe("the pinned bytes");
    expect(seen.at(-1)).toBe(bytes.byteLength);
    expect(await readdir(dir)).toEqual(["uv.tar.gz"]);
  });

  it("refuses bytes that don't match the pin and leaves nothing behind", async () => {
    const { fetch } = github(new TextEncoder().encode("something else"));
    const error = await fetchVerified(fetch, file, join(dir, "uv.tar.gz"), new AbortController().signal).catch((thrown: Error) => thrown);
    expect(error).toBeInstanceOf(ChecksumError);
    expect((error as Error).message).toMatch(/^uv-aarch64-apple-darwin\.tar\.gz didn't match its pinned SHA-256 \(got [0-9a-f]{12}…\), so it wasn't used\.$/);
    expect(await readdir(dir)).toEqual([]);
  });

  it("only downloads over HTTPS from the hosts it knows, redirects included", async () => {
    const { fetch } = github(bytes, "https://evil.example/uv.tar.gz");
    await expect(fetchVerified(fetch, file, join(dir, "uv.tar.gz"), new AbortController().signal)).rejects.toThrow("was sent to evil.example, which Blackout doesn't download from.");
    const plain = { ...file, url: "http://github.com/astral-sh/uv.tar.gz" };
    await expect(fetchVerified(github().fetch, plain, join(dir, "uv.tar.gz"), new AbortController().signal)).rejects.toThrow("which Blackout doesn't download from");
    const local = { ...file, url: "https://127.0.0.1/uv.tar.gz" };
    await expect(fetchVerified(github().fetch, local, join(dir, "uv.tar.gz"), new AbortController().signal)).rejects.toThrow("127.0.0.1, which Blackout doesn't download from");
    expect(await readdir(dir)).toEqual([]);
  });

  it("says what the host answered", async () => {
    const fetch: Fetch = async () => new Response("rate limited", { status: 429 });
    await expect(fetchVerified(fetch, file, join(dir, "uv.tar.gz"), new AbortController().signal)).rejects.toThrow("github.com answered 429 for uv-aarch64-apple-darwin.tar.gz.");
  });

  it("stops on cancel and removes the partial file", async () => {
    const controller = new AbortController();
    const fetch: Fetch = async () => new Response(new ReadableStream<Uint8Array>({
      pull(stream) {
        stream.enqueue(new Uint8Array(4));
        controller.abort(new Error("stopped"));
      },
    }), { status: 200 });
    await expect(fetchVerified(fetch, file, join(dir, "uv.tar.gz"), controller.signal)).rejects.toThrow("stopped");
    expect(await readdir(dir)).toEqual([]);
  });
});

describe("lastLine", () => {
  it("keeps uv's error and its deepest cause on one line", () => {
    const stderr = [
      "Resolved 86 packages in 1.2s",
      "error: Failed to fetch: `https://pypi.org/simple/torch/`",
      "  Caused by: Request failed after 3 retries",
      "  Caused by: error sending request for url (https://pypi.org/simple/torch/)",
      "  Caused by: dns error: failed to lookup address information",
    ].join("\n");
    expect(lastLine(stderr)).toBe("Failed to fetch: `https://pypi.org/simple/torch/`: dns error: failed to lookup address information");
    expect(lastLine("Traceback (most recent call last):\n  File x\nOSError: disk full\n")).toBe("OSError: disk full");
    expect(lastLine("x".repeat(400))).toHaveLength(298);
  });
});

describe("spawnRunner", () => {
  it("runs to the end and reports the exit code and output", async () => {
    const result = await spawnRunner("/bin/sh", ["-c", "echo out; echo err >&2; exit 3"], { env: { PATH: "/usr/bin:/bin" } });
    expect(result).toEqual({ code: 3, signal: null, stdout: "out\n", stderr: "err\n" });
  });

  it("stops the whole process group on cancel", async () => {
    const controller = new AbortController();
    const running = spawnRunner("/bin/sh", ["-c", "sleep 30 & sleep 30; wait"], { env: { PATH: "/usr/bin:/bin" }, signal: controller.signal });
    setTimeout(() => controller.abort(new Error("Audio intelligence is being removed.")), 50);
    await expect(running).rejects.toThrow("Audio intelligence is being removed.");
  });

  it("times out", async () => {
    await expect(spawnRunner("/bin/sh", ["-c", "sleep 30"], { env: { PATH: "/usr/bin:/bin" }, timeoutMs: 50 })).rejects.toThrow("sh took longer than 1 min and was stopped.");
  });
});

describe("folderBytes", () => {
  it("adds up what the files take on disk, links not followed", async () => {
    await mkdir(join(dir, "a", "b"), { recursive: true });
    await writeFile(join(dir, "a", "b", "f"), "x".repeat(10_000));
    expect(await folderBytes(dir)).toBeGreaterThanOrEqual(10_000);
    expect(await folderBytes(join(dir, "missing"))).toBe(0);
  });
});
