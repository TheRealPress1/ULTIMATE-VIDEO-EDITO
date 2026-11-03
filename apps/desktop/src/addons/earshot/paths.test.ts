/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { globRoot, resolveCues, resolveSoundFiles, resolveSoundPath, segmentPattern } from "./paths";

let base: string;
let home: string;
let project: string;
let outside: string;

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "earshot-paths-")));
  home = join(base, "home");
  project = join(home, "Movies", "Launch");
  outside = join(home, "Music", "theme.m4a");
  await mkdir(join(project, "assets", "music"), { recursive: true });
  await mkdir(join(project, "assets", "sfx"), { recursive: true });
  await mkdir(join(home, ".ssh"), { recursive: true });
  await mkdir(join(home, "Music"), { recursive: true });
  await writeFile(join(home, ".ssh", "id_ed25519"), "key");
  await writeFile(outside, "m4a");
  await writeFile(join(project, "assets", "music", "bed.wav"), "wav");
  await writeFile(join(project, "assets", "sfx", "whoosh.wav"), "wav");
  await writeFile(join(project, "voice.wav"), "wav");
  await writeFile(join(project, "assets.yml"), [
    "version: 1",
    "folders: [music]",
    "assets:",
    "  - { id: a1b2c3, path: music/theme.m4a, source: " + JSON.stringify(outside) + ", type: AUDIO, mimeType: audio/mp4 }",
    "  - { id: d4e5f6, path: music/bed.wav, source: assets/music/bed.wav, type: AUDIO, mimeType: audio/wav }",
    "  - { id: f7a8b9, path: web/song.mp3, source: 'https://example.com/song.mp3', type: AUDIO, mimeType: audio/mpeg }",
  ].join("\n"));
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

const resolve = (value: string, options: Partial<Parameters<typeof resolveSoundPath>[1]> = {}) =>
  resolveSoundPath(value, { project, what: "path", home, ...options });

describe("resolveSoundPath", () => {
  it("resolves library paths through the project's manifest, linked files included", async () => {
    expect(await resolve("music/theme.m4a")).toBe(outside);
    expect(await resolve("music/bed.wav")).toBe(join(project, "assets", "music", "bed.wav"));
    expect(await resolve("a1b2c3")).toBe(outside);
  });

  it("falls back to a path in the project, then one under assets/", async () => {
    expect(await resolve("voice.wav")).toBe(join(project, "voice.wav"));
    expect(await resolve("./assets/sfx/whoosh.wav")).toBe(join(project, "assets", "sfx", "whoosh.wav"));
    expect(await resolve("sfx/whoosh.wav")).toBe(join(project, "assets", "sfx", "whoosh.wav"));
  });

  it("takes absolute and ~ paths as they are", async () => {
    expect(await resolve(outside)).toBe(outside);
    expect(await resolve("~/Music/theme.m4a")).toBe(outside);
    expect(await resolve(outside, { project: null })).toBe(outside);
  });

  it("refuses URLs, remote library assets and paths that leave the project", async () => {
    await expect(resolve("https://example.com/a.mp3")).rejects.toMatchObject({ code: "invalid-input", message: expect.stringContaining("not URLs. Download it first") });
    await expect(resolve("file:///tmp/a.wav")).rejects.toMatchObject({ code: "invalid-input" });
    await expect(resolve("web/song.mp3")).rejects.toMatchObject({ code: "invalid-input", message: "path: the library's web/song.mp3 points to remote media. Download it into the project first." });
    await expect(resolve("../../Music/theme.m4a")).rejects.toMatchObject({ code: "invalid-input", message: expect.stringContaining("leaves the project") });
  });

  it("needs a project for relative names, and says what is missing", async () => {
    await expect(resolve("music/theme.m4a", { project: null })).rejects.toMatchObject({ code: "no-project" });
    await expect(resolve("music/missing.wav")).rejects.toMatchObject({ code: "not-found", message: expect.stringContaining("isn't in the open project's library or folder") });
    await expect(resolve(join(home, "nothing.wav"))).rejects.toMatchObject({ code: "not-found" });
  });

  it("refuses credential stores, also through a link, and folders that contain them", async () => {
    await expect(resolve(join(home, ".ssh", "id_ed25519"))).rejects.toMatchObject({ code: "invalid-input", message: "path: That location holds credentials or private app data, which editing sessions don't read." });
    await symlink(join(home, ".ssh", "id_ed25519"), join(project, "assets", "sfx", "innocent.wav"));
    await expect(resolve("sfx/innocent.wav")).rejects.toMatchObject({ code: "invalid-input" });
    await expect(resolve(home, { many: true, what: "paths" })).rejects.toMatchObject({ message: expect.stringContaining("contains credentials") });
    const store = join(base, "userData", "agent-chat");
    await mkdir(store, { recursive: true });
    await writeFile(join(store, "chat.json"), "{}");
    await expect(resolve(join(store, "chat.json"), { privateDirs: [store] })).rejects.toMatchObject({ code: "invalid-input" });
  });

  it("takes folders and globs only where earshot expands several files", async () => {
    await expect(resolve("sfx")).rejects.toMatchObject({ code: "wrong-kind" });
    expect(await resolve("sfx", { many: true })).toBe(join(project, "assets", "sfx"));
    expect(await resolve("sfx/*.wav", { many: true })).toBe(join(project, "assets", "sfx", "*.wav"));
    expect(await resolve(join(project, "assets", "**", "*.wav"), { many: true })).toBe(join(project, "assets", "**", "*.wav"));
    expect(globRoot("/a/b/*/c.wav")).toBe("/a/b");
  });

  it("checks every file a folder or glob holds, not just the folder: a link to a credential store is refused", async () => {
    // What an agent's shell can set up in a temp folder, where the shell may write.
    const drop = join(base, "drop");
    await mkdir(drop, { recursive: true });
    await writeFile(join(drop, "take.wav"), "wav");
    await symlink(join(home, ".ssh", "id_ed25519"), join(drop, "key.wav"));
    const refused = { code: "invalid-input", message: `paths: ${join(drop, "key.wav")} leads outside ${drop}. That location holds credentials or private app data, which editing sessions don't read.` };
    for (const value of [drop, join(drop, "*"), join(drop, "*.wav"), join(drop, "**", "*.wav")]) {
      await expect(resolve(value, { many: true, what: "paths" })).rejects.toMatchObject(refused);
      await expect(resolveSoundFiles(value, { project, what: "paths", home })).rejects.toMatchObject(refused);
    }

    // Through a linked folder, which earshot's glob enters (its folder walk doesn't).
    const linked = join(base, "linked");
    await mkdir(linked, { recursive: true });
    await writeFile(join(home, ".ssh", "backup.m4a"), "m4a");
    await writeFile(join(linked, "take.wav"), "wav");
    await symlink(join(home, ".ssh"), join(linked, "keys"));
    for (const value of [join(linked, "*", "*.m4a"), join(linked, "**", "*.m4a"), join(linked, "**")]) {
      await expect(resolveSoundFiles(value, { project, what: "refs", home })).rejects.toMatchObject({ code: "invalid-input", message: expect.stringContaining("credentials") });
    }
    expect(await resolveSoundFiles(linked, { project, what: "refs", home })).toEqual([join(linked, "take.wav")]);

    // A name earshot doesn't take as media is never opened, so it is no reason to refuse.
    const other = join(base, "other");
    await mkdir(other, { recursive: true });
    await symlink(join(home, ".ssh", "id_ed25519"), join(other, "key.ul"));
    await expect(resolveSoundFiles(join(other, "*"), { project, what: "paths", home })).rejects.toMatchObject({ code: "not-found", message: `paths: no audio or video files in ${join(other, "*")}.` });
  });

  it("follows links to places the tools may read, and hands on each file by its real path", async () => {
    const drop = join(base, "drop");
    await mkdir(drop, { recursive: true });
    await symlink(outside, join(drop, "theme.m4a"));
    await symlink(join(project, "assets", "sfx"), join(drop, "sfx"));
    expect(await resolveSoundFiles(drop, { project, what: "paths", home })).toEqual([outside]);
    expect(await resolveSoundFiles(join(drop, "*", "*.wav"), { project, what: "paths", home })).toEqual([join(project, "assets", "sfx", "whoosh.wav")]);
    expect(await resolve(drop, { many: true, what: "path" })).toBe(drop);
    // A file is passed as named.
    expect(await resolveSoundFiles("sfx/whoosh.wav", { project, what: "refs", home })).toEqual([join(project, "assets", "sfx", "whoosh.wav")]);
  });

  it("lists a folder or glob the way earshot does", async () => {
    const lib = join(base, "lib");
    await mkdir(join(lib, "sub", ".secret"), { recursive: true });
    await mkdir(join(lib, "take.wav"), { recursive: true });
    await mkdir(join(base, "elsewhere"), { recursive: true });
    for (const name of ["a.wav", "B.WAV", ".hidden.wav", ".wav", "notes.txt", "sub/c.mp3", "sub/.secret/d.wav", "take.wav/f.wav"]) await writeFile(join(lib, name), "x");
    await writeFile(join(base, "elsewhere", "e.wav"), "x");
    await symlink(join(base, "elsewhere"), join(lib, "linked"));
    await symlink(join(lib, "missing"), join(lib, "broken.wav"));
    await symlink(lib, join(lib, "sub", "loop"));
    const files = async (value: string) => (await resolveSoundFiles(value, { project, what: "paths", home })).map((path) => path.slice(base.length + 1));
    // Checked against Python's os.walk and glob(recursive=True) through earshot's list_media; the broken link and the folder named take.wav have nothing to read.
    expect(await files(lib)).toEqual(["lib/.hidden.wav", "lib/B.WAV", "lib/a.wav", "lib/sub/c.mp3", "lib/sub/.secret/d.wav", "lib/take.wav/f.wav"]);
    expect(await files(join(lib, "*"))).toEqual(["lib/B.WAV", "lib/a.wav"]);
    expect(await files(join(lib, "**", "*.wav"))).toEqual(["lib/a.wav", "elsewhere/e.wav", "lib/take.wav/f.wav"]);
    expect(await files(join(lib, "**"))).toEqual(["lib/B.WAV", "lib/a.wav", "elsewhere/e.wav", "lib/sub/c.mp3", "lib/take.wav/f.wav"]);
    expect(await files(join(lib, ".*"))).toEqual(["lib/.hidden.wav"]);
    expect(await files(join(lib, "[!a]*"))).toEqual(["lib/B.WAV"]);
    expect(await files(join(lib, "*", "*.mp3"))).toEqual(["lib/sub/c.mp3"]);
    await expect(files(join(lib, "*.flac"))).rejects.toMatchObject({ code: "not-found" });
  });
});

describe("segmentPattern", () => {
  it("matches names as Python's fnmatch does", () => {
    // Each answer is CPython's fnmatch.fnmatchcase.
    const cases: Array<[string, Record<string, boolean>]> = [
      ["*.wav", { "a.wav": true, ".a.wav": true, "a.WAV": false, wav: false, "a.wav.bak": false }],
      ["[!a]*.wav", { "b.wav": true, "a.wav": false, "!x.wav": true }],
      ["[]x]?.wav", { "]1.wav": true, "x1.wav": true, "y1.wav": false }],
      ["[a-c]*", { b: true, d: false, "-": false }],
      ["[z-a]*", { z: false, a: false, m: false }],
      ["[!z-a]x", { qx: true, x: false, zx: true }],
      ["[a-]x", { "-x": true, ax: true, bx: false }],
      ["[--0]x", { ".x": true, "-x": true, "0x": true, "1x": false }],
      ["a[b", { "a[b": true, ab: false }],
      ["a[!]b", { "a[!]b": true, "a!b": false }],
      ["?.wav", { "\u{1F3B5}.wav": true, "ab.wav": false }],
      ["[\\]x", { "\\x": true, "]x": false }],
      ["a\\*", { "a\\": true, "a\\zz": true, "a*": false }],
      ["[!b-a-z]", { "-": false, z: false, q: true }],
      ["[b-ad-c]", { b: false, a: false, c: false, d: false }],
      ["[^a]", { "^": true, a: true, b: false }],
      ["[a&&b]", { "&": true, a: true }],
      ["[x-z0-2]", { y: true, "1": true, "3": false }],
      ["a*b*c", { abc: true, aXbYc: true, ac: false }],
      ["[!]]", { "]": false, a: true }],
      ["[a-c-e]", { b: true, "-": true, e: true, d: false }],
    ];
    for (const [pattern, names] of cases) {
      for (const [name, matches] of Object.entries(names)) expect([pattern, name, segmentPattern(pattern).test(name)]).toEqual([pattern, name, matches]);
    }
  });
});

describe("resolveCues", () => {
  it("keeps times as earshot reads them and resolves a cues file", async () => {
    await writeFile(join(project, "cues.json"), '{"fps": 30, "events": []}');
    expect(await resolveCues([1.2, 3.4], { project, home })).toEqual([1.2, 3.4]);
    expect(await resolveCues("1.2,3.4", { project, home })).toBe("1.2,3.4");
    expect(await resolveCues("[1.2, 3.4]", { project, home })).toBe("[1.2, 3.4]");
    expect(await resolveCues("cues.json", { project, home })).toBe(join(project, "cues.json"));
  });

  it("reads only real cue text as times; every other name is a file, resolved and checked", async () => {
    await writeFile(join(project, "cues.json"), '{"fps": 30, "events": []}');
    await writeFile(join(project, "2026-cues.json"), '{"events": []}');
    await writeFile(join(project, "[draft] cues.json"), '{"events": []}');
    for (const times of ["1.2", "1.2, 3.4,", "1.2; 3.4", ".5,-0.25,3e1", '{"fps": 30, "events": [{"f": 12}]}']) {
      expect(await resolveCues(times, { project, home })).toBe(times);
    }
    expect(await resolveCues("./cues.json", { project, home })).toBe(join(project, "cues.json"));
    expect(await resolveCues("2026-cues.json", { project, home })).toBe(join(project, "2026-cues.json"));
    expect(await resolveCues("[draft] cues.json", { project, home })).toBe(join(project, "[draft] cues.json"));
    // Without the check earshot would open these relative to its own folder.
    await expect(resolveCues("../../../../../.ssh/id_ed25519", { project, home })).rejects.toMatchObject({ code: "invalid-input", message: expect.stringContaining("leaves the project") });
    await expect(resolveCues(join(home, ".ssh", "id_ed25519"), { project, home })).rejects.toMatchObject({ code: "invalid-input", message: expect.stringContaining("credentials") });
    await expect(resolveCues("1.2,abc", { project, home })).rejects.toMatchObject({ code: "not-found", message: expect.stringContaining('Cue times are a list of seconds, "1.2,3.4" or JSON text.') });
  });
});
