/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { claudeProjectFolder } from "../src/host/automatic-policy";
import { SHELL_MESSAGES, claudeProjectSandbox, cliRemovalCheck, shellDenial } from "../src/host/project-sandbox";

describe("shell denial guidance", () => {
  it.each([
    "rm -rf assets/old-renders",
    "/bin/rm assets/a.png",
    "\\rm -f assets/a.png",
    "\"rm\" -rf assets",
    "'rm' -rf assets",
    "command rm assets/a.png",
    "rmdir exports/empty",
    "unlink assets/x.png",
    "truncate -s 0 assets.yml",
    "find assets exports -type f -delete",
    "find . -name '*.png' -delete && echo done",
    "find -delete",
    "find assets -name '*.tmp' -exec rm {} \\;",
    "find assets -name '*.tmp' -exec /bin/rm -f {} +",
    "find assets -print0 | xargs -0 rm -f",
    "ls assets/*.png | xargs rm",
    "rsync -a --delete renders/ exports/",
    "rsync -av --delete-after a/ b/",
    "rsync --remove-source-files a/ b/",
    "perl -e 'unlink glob \"assets/*/*\"'",
    "perl -MFile::Path -e 'rmtree(\"assets\")'",
    "python3 -c \"import pathlib;[p.unlink() for p in pathlib.Path('assets').rglob('*')]\"",
    "python3 -c 'import shutil; shutil.rmtree(\"exports\")'",
    "python3 - <<'PY'\nimport os\nos.remove('assets/a.png')\nPY",
    "node -e \"require('fs').rmSync('assets', { recursive: true })\"",
    "node -e \"fs.unlinkSync('assets/a.png')\"",
    "ruby -e 'FileUtils.rm_rf(\"assets\")'",
    "ruby -e 'File.delete(\"assets/a.png\")'",
    "sudo ls",
    "git push origin main",
    "git clean -fdx",
    "osascript -e 'tell app \"Finder\" to quit'",
    "echo $(which rm)",
    "/usr/bin/unlink assets/a.png",
    "xargs 'rm' < unused.txt",
    // A delete word right after the opening quote of a shell script.
    "bash -c 'rm -rf assets'",
    "bash -lc \"rm -rf assets\"",
    "sh -c \"find assets -delete\"",
    "bash -c 'unlink a'",
    "bash -c $'rm -rf assets'",
    "bash --norc -c 'rm assets/a.png'",
    "/bin/zsh -o pipefail -c 'rmdir exports/empty'",
    "bash -e -x -c 'cd assets && truncate -s 0 a.json'",
    "eval 'rm -rf exports'",
    "eval \"rm -rf \\\"$DIR\\\"\"",
    "timeout 30 bash -c 'rm -rf exports'",
    "find assets -name '*.png' -exec sh -c 'rm \"$1\"' _ {} \\;",
    "ls assets | xargs -I{} sh -c 'rm \"{}\"'",
    "sh -c \"bash -c 'rm -rf assets'\"",
    "echo 'rm -rf assets' | sh",
    "bash <<< 'rm -rf assets'",
  ])("refuses %s", (command) => {
    expect(shellDenial({ command })).toBe(SHELL_MESSAGES.destructive);
  });

  it.each([
    "ffmpeg -i rm.mov -c copy exports/rm-cut.mp4",
    "cat notes/rm.txt",
    "ls ./rm",
    "docker run --rm image",
    "python3 truncate_captions.py assets/Captions.json",
    "cat unlink-notes.txt",
    "python3 -c \"items = [1, 2]; items.remove(1); print(items)\"",
    "find assets -name '*.png' -print",
    "find assets -newer exports/delete-me.mp4",
    "rsync -a renders/ exports/",
    "git commit -m \"rm unused files\"",
    "grep -r deleted assets/",
    "curl -L -o assets/web/a.jpg https://upload.wikimedia.org/a.jpg",
    "cp assets/Captions.json /tmp/captions-backup.json",
    // Delete words as text, file names or regexes, not commands.
    "grep -rn \"unlink\" src/",
    "echo \"rm\"",
    "perl -ne 'print if /unlink/' log.txt",
    "perl -ne 'print if /rmdir|unlink/' log.txt",
    "cat /tmp/rm",
    "ls /Users/me/Movies/truncate",
    // Shell scripts without a delete.
    "bash -c 'ffmpeg -i in.mp4 out.mp4'",
    "sh -c \"echo done\"",
    "bash -c 'grep -rn \"rm\" notes.txt'",
    "printf '%s\\n' 'ffmpeg -version' | sh",
    "bash scripts/render.sh",
  ])("allows %s", (command) => {
    expect(shellDenial({ command })).toBeNull();
  });

  it("recognizes Claude Code's own dangerous-removal checks, not other ask reasons", () => {
    for (const reason of [
      "A permission rule denies a command in this shell -c script",
      "This shell -c script runs rm and could not be checked",
      "Dangerous rm operation in a shell -c script, on a target built from a value known only when it runs",
      "\u001b[1mDangerous rm operation on a directory\u001b[0m",
    ]) expect(cliRemovalCheck(reason), reason).toBe(true);
    for (const reason of [undefined, "", "Contains quoted command", "Contains brace with quote character (expansion obfuscation)", "Matched ask rule"]) {
      expect(cliRemovalCheck(reason), String(reason)).toBe(false);
    }
  });

  it("keeps the other refusals", () => {
    expect(shellDenial({ command: "ls", dangerouslyDisableSandbox: true })).toBe(SHELL_MESSAGES.unsandboxed);
    expect(shellDenial({ command: "  " })).toBe(SHELL_MESSAGES.empty);
  });

  it("points an unsandboxed download at the media tools, not at the shell", () => {
    // An agent asking to leave the sandbox is often after a download; the reply mustn't invite one.
    expect(SHELL_MESSAGES.unsandboxed).toContain("`media_download` for YouTube");
    expect(SHELL_MESSAGES.unsandboxed).toContain("`web_media_download` for openly licensed");
    expect(SHELL_MESSAGES.unsandboxed).not.toMatch(/network downloads work/i);
  });
});

describe("Claude project sandbox", () => {
  let root: string, home: string, cwd: string;
  beforeAll(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "uve-project-sandbox-")));
    home = join(root, "home");
    cwd = join(root, "project");
    await mkdir(cwd, { recursive: true });
    await mkdir(join(home, "Library", "Application Support", "Claude", "claude-code", "2.1.320"), { recursive: true });
    await mkdir(join(home, ".local", "share", "claude", "versions"), { recursive: true });
    await writeFile(join(home, "Library", "Application Support", "Claude", "claude-code", "2.1.320", "claude"), "");
    await writeFile(join(home, ".local", "share", "claude", "versions", "2.1.320"), "");
  });
  afterAll(() => rm(root, { recursive: true, force: true }));

  it("hides the host's chat store and agent stores from commands", () => {
    const dataDir = join(root, "userData", "agent-chat");
    const filesystem = claudeProjectSandbox(cwd, { home, privateDirs: [dataDir] }).sandbox!.filesystem!;
    expect(filesystem.denyRead).toEqual(expect.arrayContaining([
      dataDir, join(home, ".claude", "projects"), join(home, ".codex"), join(home, ".zshrc"),
      join(home, "Library", "Application Support", "Claude"),
    ]));
    expect(filesystem.denyRead!.some((path) => path.includes("shell-snapshots"))).toBe(false);
    expect(filesystem).not.toHaveProperty("allowRead");
  });

  it("keeps a CLI installed inside a denied store readable, and only that folder", () => {
    const bundled = join(home, "Library", "Application Support", "Claude", "claude-code", "2.1.320", "claude");
    expect(claudeProjectSandbox(cwd, { home, cliPath: bundled }).sandbox!.filesystem!.allowRead).toEqual([
      join(home, "Library", "Application Support", "Claude", "claude-code", "2.1.320"),
    ]);
    const usual = join(home, ".local", "share", "claude", "versions", "2.1.320");
    expect(claudeProjectSandbox(cwd, { home, cliPath: usual }).sandbox!.filesystem).not.toHaveProperty("allowRead");
  });

  it("keeps this session's saved tool results readable, and only that folder", async () => {
    const session = "0f0b3799-b99b-4e2f-91cb-d40487d93c06";
    const projects = join(home, ".claude", "projects");
    const own = join(projects, claudeProjectFolder(cwd), session, "tool-results");
    const filesystem = claudeProjectSandbox(cwd, { home, sessionId: session }).sandbox!.filesystem!;
    expect(filesystem.denyRead).toContain(projects);
    expect(filesystem.allowRead).toContain(own);
    if (process.platform === "darwin") expect(filesystem.allowRead).toContain(`/System/Volumes/Data${own}`);
    // Every entry is that one folder, spelled for each home and cwd form.
    for (const path of filesystem.allowRead!) expect(path.endsWith(join(session, "tool-results"))).toBe(true);

    // The CLI names the folder after the resolved cwd.
    const linked = join(root, "linked-project");
    await symlink(cwd, linked);
    expect(claudeProjectSandbox(linked, { home, sessionId: session }).sandbox!.filesystem!.allowRead).toEqual(expect.arrayContaining([
      own, join(projects, claudeProjectFolder(linked), session, "tool-results"),
    ]));

    for (const sessionId of ["../other", "a/b", ""]) {
      expect(claudeProjectSandbox(cwd, { home, sessionId }).sandbox!.filesystem, sessionId).not.toHaveProperty("allowRead");
    }
  });
});

describe("Claude Code's project folder names", () => {
  /** Java's String.hashCode, which the CLI's hash matches, computed independently with BigInt. */
  const javaHash = (text: string): number => {
    let hash = 0n;
    for (let index = 0; index < text.length; index++) hash = (hash * 31n + BigInt(text.charCodeAt(index))) % 2n ** 32n;
    return Number(BigInt.asIntN(32, hash));
  };

  it("matches the CLI's sanitizer", () => {
    expect(claudeProjectFolder("/Users/someone/Movies/Cutroom/Red Bull edit"))
      .toBe("-Users-someone-Movies-Cutroom-Red-Bull-edit");
    expect(claudeProjectFolder("/Users/me/Movies/Été 2026")).toBe("-Users-me-Movies--t--2026");
    const long = `/Users/me/Movies/${"Long project name ".repeat(15)}`;
    const folder = claudeProjectFolder(long);
    expect(folder).toBe(`${long.replace(/[^a-zA-Z0-9]/g, "-").slice(0, 200)}-${Math.abs(javaHash(long)).toString(36)}`);
  });
});
