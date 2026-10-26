/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  ALLOW,
  POLICY_MESSAGES,
  auditAutomaticApproval,
  decideNetworkAccess,
  decideNetworkHost,
  decideRead,
  decideWrite,
  protectedMessage,
  sensitiveReadPaths,
} from "../src/host/automatic-policy";

let root: string, project: string, outside: string, temporary: string, home: string, hiddenParentProject: string;
beforeAll(async () => {
  const base = resolve("node_modules/.tmp");
  await mkdir(base, { recursive: true });
  root = await mkdtemp(join(base, "automatic-policy-"));
  project = join(root, "project");
  outside = join(root, "outside");
  home = join(root, "home");
  hiddenParentProject = join(root, ".cutroom", "nested-project");
  temporary = await mkdtemp(join(tmpdir(), "uve-policy-"));
  await Promise.all([
    mkdir(join(project, "assets"), { recursive: true }),
    mkdir(outside),
    mkdir(join(hiddenParentProject, "assets"), { recursive: true }),
    mkdir(join(home, "Desktop"), { recursive: true }),
    mkdir(join(home, "Documents"), { recursive: true }),
    mkdir(join(home, "Movies"), { recursive: true }),
    mkdir(join(home, ".ssh"), { recursive: true }),
    mkdir(join(home, ".aws"), { recursive: true }),
    mkdir(join(home, ".config", "gh"), { recursive: true }),
    mkdir(join(home, "Library", "Application Support", "Cutroom", "instagram"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(project, "assets", "Captions 3.json"), "{}"),
    writeFile(join(outside, "private.json"), "{}"),
    writeFile(join(temporary, "capture.png"), "image fixture"),
    writeFile(join(home, "Documents", "script.txt"), "user document"),
    writeFile(join(home, ".ssh", "id_ed25519"), "secret"),
    writeFile(join(home, ".aws", "credentials"), "secret"),
    writeFile(join(home, ".config", "gh", "hosts.yml"), "secret"),
    writeFile(join(home, "Library", "Application Support", "Cutroom", "instagram", "token.json"), "secret"),
    symlink(outside, join(project, "escape")),
    symlink(join(outside, "missing"), join(project, "dangling")),
    symlink(project, join(root, "alias")),
    symlink(outside, join(temporary, "escape")),
    symlink(join(home, ".aws"), join(project, "credentials-link")),
    symlink(outside, join(home, "Desktop", "linked")),
  ]);
});
afterAll(async () => {
  await Promise.all([
    rm(root, { recursive: true, force: true }),
    rm(temporary, { recursive: true, force: true }),
  ]);
});

const write = (path: unknown, grantRoot?: unknown, cwd = project) => decideWrite({ cwd, path, grantRoot, home });
const read = (path: unknown, recursive = false) => decideRead({ cwd: project, path, recursive, home });
const refused = (message: string) => ({ allow: false, message });

describe("write decision", () => {
  it("allows existing project edits and new nested outputs", async () => {
    expect(await write("assets/Captions 3.json")).toEqual(ALLOW);
    expect(await write(join(project, "assets/Captions 3.json"))).toEqual(ALLOW);
    expect(await write("exports/draft/new.mp4")).toEqual(ALLOW);
  });

  it("allows temporary backups in the system temp folders", async () => {
    expect(await write(join(temporary, "caption-backup.json"))).toEqual(ALLOW);
    expect(await write(join(temporary, "capture.png"))).toEqual(ALLOW);
    if (process.platform !== "win32") expect(await write("/tmp/uve-policy-backup.json")).toEqual(ALLOW);
  });

  it("keeps configuration and metadata folders off-limits with a named reason", async () => {
    for (const [path, segment] of [
      [".git/config", ".git"],
      [".claude/settings.json", ".claude"],
      [".codex/config.toml", ".codex"],
      [".ssh/config", ".ssh"],
      [".aws/credentials", ".aws"],
      [".mcp.json", ".mcp.json"],
      [".cutroom/web-media.json", ".cutroom"],
      ["assets/nested/.git/HEAD", ".git"],
    ] as const) expect(await write(path)).toEqual(refused(protectedMessage(segment)));
    expect(await write(join(temporary, ".claude", "settings.json"))).toEqual(refused(protectedMessage(".claude")));
    if (process.platform === "darwin") expect(await write(".GIT/config")).toEqual(refused(protectedMessage(".git")));
  });

  it("judges protected names below the project root, not in the folders that hold it", async () => {
    expect(await write("assets/new.json", undefined, hiddenParentProject)).toEqual(ALLOW);
    expect(await write(".cutroom/index.json", undefined, hiddenParentProject)).toEqual(refused(protectedMessage(".cutroom")));
  });

  it("refuses to replace files outside the project and explains how to adapt", async () => {
    expect(await write("../outside/private.json")).toEqual(refused(POLICY_MESSAGES.outsideExisting));
    expect(await write(join(outside, "private.json"))).toEqual(refused(POLICY_MESSAGES.outsideExisting));
    expect(await write(join(home, "Documents", "script.txt"))).toEqual(refused(POLICY_MESSAGES.outsideExisting));
    expect(await write("escape/private.json")).toEqual(refused(POLICY_MESSAGES.outsideExisting));
  });

  it("creates new files only in the user's content folders, never below hidden folders", async () => {
    expect(await write(join(home, "Desktop", "title-card.png"))).toEqual(ALLOW);
    expect(await write(join(home, "Movies", "renders", "final.mp4"))).toEqual(ALLOW);
    expect(await write("~/Documents/notes.txt")).toEqual(ALLOW);
    expect(await write(join(home, "Desktop", ".hidden", "new.txt"))).toEqual(refused(POLICY_MESSAGES.outside));
    expect(await write(join(home, ".config", "new.txt"))).toEqual(refused(POLICY_MESSAGES.outside));
    expect(await write(join(home, "new.txt"))).toEqual(refused(POLICY_MESSAGES.outside));
    expect(await write(join(outside, "new.json"))).toEqual(refused(POLICY_MESSAGES.outside));
    expect(await write(`${project}-other/title.tsx`)).toEqual(refused(POLICY_MESSAGES.outside));
  });

  it("follows symlinks: aliases of the project work, escapes do not", async () => {
    expect(await decideWrite({ cwd: join(root, "alias"), path: "assets/Captions 3.json", home })).toEqual(ALLOW);
    expect(await write("escape/new/deep.json")).toEqual(refused(POLICY_MESSAGES.outside));
    expect(await write(join(temporary, "escape", "new.json"))).toEqual(refused(POLICY_MESSAGES.outside));
    expect(await write("dangling/new.json")).toEqual(refused(POLICY_MESSAGES.outside));
    expect(await write(join(home, "Desktop", "linked", "new.png"))).toEqual(refused(POLICY_MESSAGES.outside));
  });

  it("honors grant roots only inside the project or temp and around the target", async () => {
    expect(await write("assets/Captions 3.json", project)).toEqual(ALLOW);
    expect((await write("assets/Captions 3.json", root)).allow).toBe(false);
    expect((await write("assets/Captions 3.json", outside)).allow).toBe(false);
    expect((await write("assets/Captions 3.json", { path: project })).allow).toBe(false);
    expect((await write(join(home, "Desktop", "new.png"), join(home, "Desktop"))).allow).toBe(false);
  });

  it("refuses URLs, control characters and malformed paths", async () => {
    for (const path of [null, {}, "", "file:///tmp/test", "https://example.test/a", "bad\u0000path", "\\\\server\\share\\a"])
      expect(await write(path)).toEqual(refused(POLICY_MESSAGES.outside));
  });
});

describe("read decision", () => {
  it("reads anywhere outside credential stores, including missing files", async () => {
    expect(await read("/etc/hosts")).toEqual(ALLOW);
    expect(await read(join(outside, "private.json"))).toEqual(ALLOW);
    expect(await read(join(temporary, "capture.png"))).toEqual(ALLOW);
    expect(await read("missing.json")).toEqual(ALLOW);
    expect(await read(join(home, "Documents", "script.txt"))).toEqual(ALLOW);
  });

  it("refuses credential stores and private app data, however they are spelled", async () => {
    for (const path of [
      join(home, ".ssh", "id_ed25519"),
      "~/.ssh/id_ed25519",
      join(home, ".aws"),
      join(home, ".config", "gh", "hosts.yml"),
      join(home, ".netrc"),
      join(home, "Library", "Application Support", "Cutroom", "instagram", "token.json"),
      join(home, "Library", "Keychains", "login.keychain-db"),
      "credentials-link/credentials",
    ]) expect(await read(path)).toEqual(refused(POLICY_MESSAGES.sensitive));
    if (process.platform === "darwin") {
      expect(await read("/etc/master.passwd")).toEqual(refused(POLICY_MESSAGES.sensitive));
      expect(await read(join(home, ".SSH", "id_ed25519"))).toEqual(refused(POLICY_MESSAGES.sensitive));
    }
  });

  it("refuses credential stores beyond the dot folders: tokens, shell history and browser profiles", async () => {
    for (const path of [
      join(home, ".cargo", "credentials.toml"),
      join(home, ".vault-token"),
      join(home, ".zsh_history"),
      join(home, "Library", "Application Support", "Google", "Chrome", "Default", "Cookies"),
      join(home, "Library", "Application Support", "Firefox", "Profiles", "a.default", "logins.json"),
    ]) expect(await read(path)).toEqual(refused(POLICY_MESSAGES.sensitive));
    expect(await read(join(home, "Library", "Application Support", "Cutroom", "skills.json"))).toEqual(ALLOW);
  });

  it("refuses agent transcripts, settings and shell startup files, but never the CLI's shell snapshots or install", async () => {
    for (const path of [
      join(home, ".claude", "projects", "-Users-me-Movies-Clip", "0b5c.jsonl"),
      join(home, ".claude", "projects", "-Users-me-Movies-Clip", "memory", "MEMORY.md"),
      join(home, ".claude", "settings.json"),
      join(home, ".claude", "settings.local.json"),
      join(home, ".claude", "history.jsonl"),
      join(home, ".claude", "todos", "a.json"),
      join(home, ".claude", "file-history", "s", "f@v1"),
      join(home, ".claude", "paste-cache", "p.txt"),
      join(home, ".claude", "backups", ".claude.json.backup.1"),
      join(home, ".claude.json.backup"),
      join(home, ".codex", "config.toml"),
      join(home, ".codex", "sessions", "2026", "10", "rollout.jsonl"),
      join(home, ".codex", "auth.json"),
      join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json"),
      ...[".zshrc", ".zprofile", ".zshenv", ".zlogin", ".bashrc", ".bash_profile", ".profile"].map((name) => join(home, name)),
    ]) expect(await read(path), path).toEqual(refused(POLICY_MESSAGES.sensitive));
    for (const path of [
      join(home, ".claude", "shell-snapshots", "snapshot-zsh-1.sh"),
      join(home, ".claude", "session-env", "s", "hook-0.sh"),
      join(home, ".claude", "local", "claude"),
      join(home, ".local", "share", "claude", "versions", "2.1.310"),
      join(home, ".zsh_plugins", "theme.zsh"),
    ]) expect(await read(path), path).toEqual(ALLOW);
    expect(await read(join(home, ".claude"), true)).toEqual(refused(POLICY_MESSAGES.sensitiveSearch));
  });

  it("refuses the host's chat store, wherever the app keeps it, but not drafts beside it", async () => {
    const support = join(home, "Library", "Application Support", "Cutroom Isolated");
    const dataDir = join(support, "agent-chat");
    const privately = (path: string, recursive = false) => decideRead({ cwd: project, path, recursive, home, privateDirs: [dataDir] });
    expect(await privately(join(dataDir, "chats", "c1", "events.jsonl"))).toEqual(refused(POLICY_MESSAGES.sensitive));
    expect(await privately(support, true)).toEqual(refused(POLICY_MESSAGES.sensitiveSearch));
    expect(await privately(join(support, "Drafts", "d1", "index.tsx"))).toEqual(ALLOW);
    expect(await privately(join(support, "Drafts", "d1"), true)).toEqual(ALLOW);
    // Without the option the same file is ordinary app data.
    expect(await read(join(dataDir, "chats", "c1", "events.jsonl"))).toEqual(ALLOW);
    expect(sensitiveReadPaths(home, [dataDir])).toContain(dataDir);
  });

  it("refuses folder searches that would reach a credential store", async () => {
    expect(await read(home, true)).toEqual(refused(POLICY_MESSAGES.sensitiveSearch));
    expect(await read(join(home, "Library"), true)).toEqual(refused(POLICY_MESSAGES.sensitiveSearch));
    expect(await read(join(home, "Movies"), true)).toEqual(ALLOW);
    expect(await read(project, true)).toEqual(ALLOW);
  });

  it.runIf(process.platform === "darwin")("refuses the macOS data-volume and inode spellings of a credential store", async () => {
    const realHome = await realpath(home);
    const dataVolume = (path: string) => `/System/Volumes/Data${path}`;
    // realpath keeps this spelling, so only the policy can map it back.
    expect(await realpath(dataVolume(join(realHome, ".ssh")))).toBe(dataVolume(join(realHome, ".ssh")));
    for (const path of [dataVolume(join(realHome, ".ssh", "id_ed25519")), dataVolume(join(realHome, ".SSH", "id_ed25519"))])
      expect(await read(path)).toEqual(refused(POLICY_MESSAGES.sensitive));
    expect(await read(dataVolume(realHome), true)).toEqual(refused(POLICY_MESSAGES.sensitiveSearch));
    expect(await read("/System/Volumes", true)).toEqual(refused(POLICY_MESSAGES.sensitiveSearch));
    expect(await read(dataVolume(join(realHome, "Documents", "script.txt")))).toEqual(ALLOW);
    for (const path of [`/.nofollow${join(realHome, ".ssh", "id_ed25519")}`, "/.vol/1/2", `/.resolve/1${realHome}`])
      expect(await read(path)).toEqual(refused(POLICY_MESSAGES.notLocal));
  });

  it("lists the same stores, in every spelling, for the shell sandbox's read denials", async () => {
    const paths = sensitiveReadPaths(home);
    const realHome = await realpath(home);
    for (const store of [".ssh", ".aws", ".netrc", ".zsh_history", join("Library", "Keychains"), join("Library", "Application Support", "Cutroom", "instagram")]) {
      expect(paths).toContain(join(home, store));
      expect(paths).toContain(join(realHome, store));
      if (process.platform === "darwin") expect(paths).toContain(`/System/Volumes/Data${join(realHome, store)}`);
    }
    if (process.platform === "darwin") expect(paths).toContain("/private/etc/master.passwd");
    for (const store of [join(".claude", "projects"), join(".claude", "settings.json"), ".codex", ".zshenv", join("Library", "Application Support", "Claude")])
      expect(paths).toContain(join(home, store));
    expect(paths.some((path) => /shell-snapshots|session-env/.test(path))).toBe(false);
    expect(paths.every((path) => resolve(path) === path)).toBe(true);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it("refuses paths that are not plain local paths", async () => {
    for (const path of ["https://example.test/a", "file:///etc/hosts", "bad\u0000path"])
      expect(await read(path)).toEqual(refused(POLICY_MESSAGES.notLocal));
  });
});

describe("network host decision", () => {
  it.each([
    "api.openverse.org", "commons.wikimedia.org", "upload.wikimedia.org.", "registry.npmjs.org",
    "example.com:443", "8.8.8.8", "172.32.0.1", "100.128.0.1", "11.0.0.1",
    "2606:4700:4700::1111", "[2606:4700:4700::1111]:443", "::ffff:8.8.8.8", "localhost.example.com",
  ])("allows public host %s", (host) => {
    expect(decideNetworkHost(host)).toEqual(ALLOW);
  });

  it.each([
    "localhost", "LOCALHOST.", "app.localhost", "printer.local", "metadata.google.internal", "nas.home.arpa",
    "127.0.0.1", "127.1", "2130706433", "0x7f000001", "0177.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255",
    "192.168.1.10", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255", "127.0.0.1:43127",
    "::1", "[::1]", "[::1]:43127", "::", "fe80::1%en0", "fd00::1", "fc00::1", "ff02::1", "fec0::1",
    "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:192.168.0.1", "64:ff9b::a00:1", "2002:c0a8:101::1",
    "nas", "router.", "printer:631",
  ])("refuses local or private host %s", (host) => {
    expect(decideNetworkHost(host)).toEqual(refused(POLICY_MESSAGES.privateHost));
  });

  it.each([42, null, "", " ", "user@host", "host/path", "a b", "127.0.0.1%25en0"])("refuses malformed host %s", (host) => {
    expect(decideNetworkHost(host).allow).toBe(false);
  });

  it.each(["198.18.0.1", "198.19.255.254", "::ffff:198.18.0.7"])("treats fake-IP proxy address %s as public", (host) => {
    expect(decideNetworkHost(host)).toEqual(ALLOW);
  });
});

describe("network access decision (resolved)", () => {
  const records: Record<string, string[]> = {
    "upload.wikimedia.org": ["198.35.26.112", "2620:0:863:ed1a::2:b"],
    "192-168-1-1.nip.io": ["192.168.1.1"],
    "127.0.0.1.nip.io": ["127.0.0.1"],
    "localtest.me": ["127.0.0.1", "::1"],
    "split.example": ["93.184.215.14", "10.0.0.5"],
    "cgnat.example": ["100.64.1.2"],
    "linklocal.example": ["169.254.169.254"],
    "ula.example": ["fd12:3456::1"],
    "scoped.example": ["fe80::1%en0"],
    "mapped.example": ["::ffff:192.168.0.10"],
    "multicast.example": ["239.255.255.250"],
    "zero.example": ["0.0.0.0"],
    "fakeip.example": ["198.18.3.4"],
    "nothing.example": [],
  };
  const lookup = vi.fn(async (name: string) => {
    const addresses = records[name];
    if (!addresses) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${name}`), { code: "ENOTFOUND" });
    return addresses.map((address) => ({ address }));
  });
  const access = (host: unknown) => decideNetworkAccess(host, { lookup });

  it("allows names that resolve only to public addresses, fake-IP proxy answers included", async () => {
    expect(await access("upload.wikimedia.org")).toEqual(ALLOW);
    expect(await access("UPLOAD.wikimedia.org.")).toEqual(ALLOW);
    expect(await access("fakeip.example")).toEqual(ALLOW);
  });

  it.each([
    "192-168-1-1.nip.io", "127.0.0.1.nip.io", "localtest.me", "split.example", "cgnat.example", "linklocal.example",
    "ula.example", "scoped.example", "mapped.example", "multicast.example", "zero.example",
  ])("refuses %s, which resolves to a non-public address", async (host) => {
    expect(await access(host)).toEqual(refused(POLICY_MESSAGES.privateHost));
  });

  it("refuses names that do not resolve, or not in time", async () => {
    expect(await access("missing.example")).toEqual(refused(POLICY_MESSAGES.unresolvedHost));
    expect(await access("nothing.example")).toEqual(refused(POLICY_MESSAGES.unresolvedHost));
    const hanging = () => new Promise<never>(() => {});
    expect(await decideNetworkAccess("slow.example", { lookup: hanging, timeoutMs: 10 })).toEqual(refused(POLICY_MESSAGES.unresolvedHost));
  });

  it("decides literals and local names without resolving them", async () => {
    lookup.mockClear();
    expect(await access("8.8.8.8")).toEqual(ALLOW);
    expect(await access("[::1]:43127")).toEqual(refused(POLICY_MESSAGES.privateHost));
    expect(await access("printer.local")).toEqual(refused(POLICY_MESSAGES.privateHost));
    expect(await access("nas")).toEqual(refused(POLICY_MESSAGES.privateHost));
    expect(await access("user@host")).toEqual(refused(POLICY_MESSAGES.invalidHost));
    expect(lookup).not.toHaveBeenCalled();
  });
});

describe("audit trail", () => {
  it("records the decision and scope without inputs", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    auditAutomaticApproval("claude", "Write", "deny", "project-file");
    auditAutomaticApproval("codex", "fileChange", "allow", "project-file");
    expect(info.mock.calls.map((call) => JSON.parse(call[1] as string))).toEqual([
      { provider: "claude", tool: "Write", decision: "auto-deny", scope: "project-file" },
      { provider: "codex", tool: "fileChange", decision: "auto-allow", scope: "project-file" },
    ]);
    info.mockRestore();
  });
});
