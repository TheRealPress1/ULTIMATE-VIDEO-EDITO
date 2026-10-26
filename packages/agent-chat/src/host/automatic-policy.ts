/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The zero-prompt policy both harnesses share. Cutroom chats never show a
// permission card: every file, path and network decision is made here and
// is either an allow or a refusal carrying guidance the model can act on.
// The cutroom tools enforce their own write safety on the editor side.

import { lookup } from "node:dns/promises";
import { realpathSync } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { isIP } from "node:net";
import { homedir, tmpdir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

export type PolicyDecision = { allow: true } | { allow: false; message: string };

export const ALLOW: PolicyDecision = Object.freeze({ allow: true });

export const deny = (message: string): PolicyDecision => ({ allow: false, message });

export const POLICY_MESSAGES = {
  outsideExisting:
    "Files outside the project can't be replaced automatically. Write to a new file name (for example `name-2.ext`) or work on a copy inside the project.",
  outside:
    "Only the project folder, temporary folders, and new files in Desktop, Documents, Downloads, Movies, Music or Pictures can be written.",
  sensitive:
    "That location holds credentials or private app data, which editing sessions don't read.",
  sensitiveSearch:
    "That folder contains credentials or private app data, which editing sessions don't read. Search a narrower folder, such as the project, Desktop, Documents, Downloads, Movies, Music or Pictures.",
  notLocal: "Use a plain local file path; URLs, network shares and control characters aren't supported.",
  privateHost:
    "Local and private network addresses aren't reachable from the editing sandbox. Use the cutroom MCP tools for the editor.",
  invalidHost: "That network host name isn't valid.",
  unresolvedHost:
    "That host name didn't resolve, so where it leads couldn't be checked. Check the address, or retry if the network was slow.",
} as const;

export function protectedMessage(segment: string): string {
  return `Cutroom keeps ${segment} off-limits to editing sessions. Write project files elsewhere in the project folder.`;
}

export type AuditScope =
  | "project-file"
  | "file-read"
  | "local-editor-tool"
  | "other-mcp"
  | "project-sandbox"
  | "sandbox-network"
  | "turn-permissions"
  | "web"
  | "built-in"
  | "unavailable-tool"
  | "inactive";

/** Host audit trail only: never log tool input, credentials, command text, paths or file contents. */
export function auditAutomaticApproval(
  provider: "claude" | "codex",
  tool: string,
  decision: "allow" | "deny",
  scope: AuditScope,
): void {
  console.info(
    "[uve-permissions]",
    JSON.stringify({ provider, tool, decision: decision === "allow" ? "auto-allow" : "auto-deny", scope }),
  );
}

// -------------------------------------------------------------------
// Paths

/** Names editing sessions never write, even inside the project or temp. */
export const PROTECTED_SEGMENTS: readonly string[] = [".git", ".claude", ".codex", ".ssh", ".aws", ".cutroom", ".mcp.json"];

/** New files may be created here; existing ones are never replaced. */
const USER_CONTENT = ["Desktop", "Documents", "Downloads", "Movies", "Music", "Pictures"];

/**
 * Credential stores and private app data under HOME. Never read by file
 * tools, and hidden from Claude's sandboxed shell, which can reach the
 * network without asking.
 */
const SENSITIVE_IN_HOME = [
  ".ssh", ".aws", ".gnupg", ".config/gh", ".config/gcloud", ".config/glab-cli", ".config/op", ".config/hub",
  ".config/git/credentials", ".azure", ".kube", ".docker", ".password-store",
  ".netrc", ".npmrc", ".pypirc", ".git-credentials", ".cargo/credentials", ".cargo/credentials.toml",
  ".gem/credentials", ".pgpass", ".my.cnf", ".mylogin.cnf", ".terraform.d/credentials.tfrc.json",
  ".boto", ".s3cfg", ".vault-token", ".zsh_history", ".zsh_sessions", ".bash_history", ".bash_sessions",
  // Shell startup files often export API keys. Commands never need them:
  // Claude Code snapshots the shell outside the sandbox, and zsh/bash skip
  // a startup file they cannot read.
  ".zshrc", ".zprofile", ".zshenv", ".zlogin", ".zshrc.pre-oh-my-zsh", ".bashrc", ".bash_profile", ".bash_login", ".profile",
  // Agent stores: other sessions' transcripts, pasted text, settings and MCP
  // server secrets. Never `.claude/shell-snapshots` or `.claude/session-env`
  // (every Bash command sources a script from there) nor the CLI's install.
  ".codex", ".claude.json", ".claude.json.backup", ".claude/.credentials.json", ".claude/hfi-auth.json",
  ".claude/settings.json", ".claude/settings.local.json", ".claude/history.jsonl", ".claude/projects",
  ".claude/todos", ".claude/tasks", ".claude/teams", ".claude/plans", ".claude/agent-memory", ".claude/file-history",
  ".claude/paste-cache", ".claude/backups", ".claude/debug", ".claude/ide", ".claude/jobs", ".claude/sessions",
  ".claude/usage-data", ".claude/feedback-bundles", ".claude/ssh",
  "Library/Application Support/Claude",
  "Library/Keychains", "Library/Cookies", "Library/Messages", "Library/Mail", "Library/Safari", "Library/Accounts",
  "Library/Application Support/Cutroom/instagram",
  // Browser profiles hold cookies and saved passwords.
  "Library/Application Support/Google/Chrome", "Library/Application Support/Chromium",
  "Library/Application Support/Firefox", "Library/Application Support/BraveSoftware",
  "Library/Application Support/Microsoft Edge", "Library/Application Support/Arc",
  "Library/Application Support/Vivaldi", "Library/Application Support/1Password",
];
const SENSITIVE_ABSOLUTE = ["/etc/master.passwd", "/private/etc/master.passwd"];

// Case-insensitive volumes are the default on macOS and Windows. Deny lists
// compare folded paths so `.SSH` cannot step around `.ssh`.
const FOLD_CASE = process.platform === "darwin" || process.platform === "win32";
const fold = (path: string): string => (FOLD_CASE ? path.toLowerCase() : path);

function within(root: string, path: string): boolean {
  const part = relative(root, path);
  return part === "" || (!isAbsolute(part) && part !== ".." && !part.startsWith(`..${sep}`));
}

const foldedWithin = (root: string, path: string): boolean => within(fold(root), fold(path));

// macOS also reaches /Users and /private through the data volume, and
// realpath keeps whichever spelling it is given.
const DATA_VOLUME = "/System/Volumes/Data";

/** A path and its data-volume twin on macOS. */
function volumeForms(path: string): string[] {
  if (process.platform !== "darwin") return [path];
  return foldedWithin(DATA_VOLUME, path) ? [path, path.slice(DATA_VOLUME.length) || "/"] : [path, `${DATA_VOLUME}${path}`];
}

/** macOS spellings that name files by inode (/.vol) or bypass symlink handling (/.nofollow, /.resolve). */
const opaqueAlias = (path: string): boolean =>
  process.platform === "darwin" && /^\/\.(?:vol|nofollow|resolve)(?:\/|$)/i.test(path);

function localPath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    !/[\x00-\x1f\x7f]/u.test(value) &&
    !/^[a-z][a-z\d+.-]*:/i.test(value) &&
    !value.startsWith("\\\\")
  );
}

/** Both providers expand a leading `~` in tool paths; decide on what they will open. */
function requestedPath(cwd: string, path: string, home: string): string {
  if (path === "~") return resolve(home);
  if (path.startsWith("~/") || (process.platform === "win32" && path.startsWith("~\\"))) return resolve(home, path.slice(2));
  return resolve(cwd, path);
}

/** Resolve existing symlinks even when the final output does not exist yet. */
async function canonical(path: string, future: boolean): Promise<string | null> {
  try {
    return await realpath(path);
  } catch (error) {
    if (!future || (error as NodeJS.ErrnoException).code !== "ENOENT") return null;
    // A dangling symlink is not a new output path. Do not look past it.
    try {
      await lstat(path);
      return null;
    } catch (statError) {
      if ((statError as NodeJS.ErrnoException).code !== "ENOENT") return null;
    }
    const parent = dirname(path);
    if (parent === path) return null;
    const resolved = await canonical(parent, true);
    return resolved ? join(resolved, basename(path)) : null;
  }
}

const present = <T>(value: T | null | undefined): value is T => value !== null && value !== undefined;

/** Every spelling of a root: as written, and resolved through symlinks. */
async function rootForms(paths: string[]): Promise<string[]> {
  const resolved = await Promise.all(paths.map((path) => canonical(path, false)));
  return [...new Set([...paths.map((path) => resolve(path)), ...resolved.filter(present)])];
}

function temporaryRoots(): string[] {
  return [tmpdir(), ...(process.platform === "win32" ? [] : ["/tmp", "/private/tmp"])];
}

/** The deepest root containing the path, so the tail below it is what the session chose. */
function containingRoot(roots: string[], path: string): string | undefined {
  return roots.filter((root) => within(root, path)).sort((a, b) => b.length - a.length)[0];
}

function tail(roots: string[], path: string): string[] {
  const root = containingRoot(roots, path);
  return (root ? relative(root, path) : path).split(/[\\/]/).filter(Boolean);
}

/**
 * The write decision for editing sessions (root = the chat's cwd).
 * `grantRoot` is Codex's request to keep writing under a folder; it is
 * honored only inside the project or temp and only when it holds the target.
 */
export async function decideWrite(input: {
  cwd: string;
  path: unknown;
  grantRoot?: unknown;
  home?: string;
}): Promise<PolicyDecision> {
  if (!localPath(input.path) || !isAbsolute(input.cwd)) return deny(POLICY_MESSAGES.outside);
  const home = input.home ?? homedir();
  const requested = requestedPath(input.cwd, input.path, home);
  const [path, project, temps] = await Promise.all([
    canonical(requested, true),
    canonical(input.cwd, false),
    rootForms(temporaryRoots()),
  ]);
  if (!path) return deny(POLICY_MESSAGES.outside);
  const roots = [project, ...temps].filter(present);
  if (containingRoot(roots, path)) {
    const lexicalRoots = [resolve(input.cwd), ...roots];
    const protectedSegment = [...tail(roots, path), ...tail(lexicalRoots, requested)]
      .map(fold)
      .find((segment) => PROTECTED_SEGMENTS.includes(segment));
    if (protectedSegment) return deny(protectedMessage(protectedSegment));
    if (input.grantRoot !== undefined && input.grantRoot !== null) {
      if (!localPath(input.grantRoot)) return deny(POLICY_MESSAGES.outside);
      const grant = await canonical(requestedPath(input.cwd, input.grantRoot, home), true);
      if (!grant || !within(grant, path) || !containingRoot(roots, grant)) return deny(POLICY_MESSAGES.outside);
    }
    return ALLOW;
  }

  let exists: boolean;
  try {
    await lstat(requested);
    exists = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return deny(POLICY_MESSAGES.outside);
    exists = false;
  }
  if (exists) return deny(POLICY_MESSAGES.outsideExisting);
  // A session-wide grant outside the project would let later calls replace files.
  if (input.grantRoot !== undefined && input.grantRoot !== null) return deny(POLICY_MESSAGES.outside);
  const canonicalHome = (await canonical(home, false)) ?? resolve(home);
  const content = await rootForms(
    USER_CONTENT.flatMap((name) => [join(home, name), join(canonicalHome, name)]),
  );
  // The resolved target decides containment; both spellings must name a
  // file below the folder and stay out of hidden folders.
  const resolvedRoot = containingRoot(content, path);
  if (!resolvedRoot) return deny(POLICY_MESSAGES.outside);
  const writtenRoot = containingRoot(content, requested);
  const pairs: [string, string][] = [[resolvedRoot, path], ...(writtenRoot ? [[writtenRoot, requested] as [string, string]] : [])];
  const acceptable = pairs.every(([root, candidate]) => {
    const below = relative(root, candidate);
    return below !== "" && !below.split(/[\\/]/).some((segment) => segment.startsWith("."));
  });
  return acceptable ? ALLOW : deny(POLICY_MESSAGES.outside);
}

/**
 * `privateDirs` are the host's own stores (the chat transcripts of every
 * project), wherever the app keeps them. Absolute paths only.
 */
function sensitivePaths(home: string, canonicalHome: string, privateDirs: readonly string[]): string[] {
  return [
    ...SENSITIVE_IN_HOME.flatMap((path) => [join(home, path), join(canonicalHome, path)]),
    ...(process.platform === "win32" ? [] : SENSITIVE_ABSOLUTE),
    ...privateDirs.filter((path) => typeof path === "string" && isAbsolute(path)),
  ];
}

async function sensitiveRoots(home: string, privateDirs: readonly string[]): Promise<string[]> {
  const canonicalHome = (await canonical(home, false)) ?? resolve(home);
  return [...new Set((await rootForms(sensitivePaths(home, canonicalHome, privateDirs))).flatMap(volumeForms))];
}

/**
 * The same credential stores as absolute paths, for the shell sandbox's
 * read denials: every spelling the read decision refuses.
 */
export function sensitiveReadPaths(home: string = homedir(), privateDirs: readonly string[] = []): string[] {
  const resolved = (path: string): string | null => {
    try { return realpathSync(path); } catch { return null; }
  };
  const paths = sensitivePaths(home, resolved(home) ?? resolve(home), privateDirs);
  return [...new Set([...paths.map((path) => resolve(path)), ...paths.map(resolved).filter(present)].flatMap(volumeForms))];
}

/** Claude Code's longest folder name under ~/.claude/projects before it adds a hash. */
const CLAUDE_PROJECT_FOLDER_MAX = 200;

/**
 * The folder Claude Code (2.1.x) keeps a working directory's sessions in,
 * under ~/.claude/projects: every character other than an ASCII letter or
 * digit becomes `-` (per UTF-16 unit), and a long name is cut and suffixed
 * with a hash of the path.
 */
export function claudeProjectFolder(cwd: string): string {
  const name = cwd.replace(/[^a-zA-Z0-9]/g, "-");
  if (name.length <= CLAUDE_PROJECT_FOLDER_MAX) return name;
  let hash = 0;
  for (let index = 0; index < cwd.length; index++) hash = ((hash << 5) - hash + cwd.charCodeAt(index)) | 0;
  return `${name.slice(0, CLAUDE_PROJECT_FOLDER_MAX)}-${Math.abs(hash).toString(36)}`;
}

/**
 * Where Claude Code saves this session's oversized tool results
 * (`<projects>/<cwd folder>/<session id>/tool-results`). Its note to the
 * model says to process them from the shell (jq, grep), so the shell
 * sandbox re-opens this one folder inside the hidden ~/.claude/projects.
 * It holds only output this session has already received. The CLI names
 * the folder after the resolved, NFC-normalized cwd; every spelling is
 * covered, like the read denials.
 */
export function claudeToolResultPaths(cwd: string, sessionId: string, home: string = homedir()): string[] {
  if (!isAbsolute(cwd) || !/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) return [];
  const resolved = (path: string): string | null => {
    try { return realpathSync(path); } catch { return null; }
  };
  const homes = [...new Set([resolve(home), resolved(home)].filter(present))];
  const cwds = [resolve(cwd), resolved(cwd)].filter(present).flatMap((path) => [path, path.normalize("NFC")]);
  const folders = [...new Set(cwds.map(claudeProjectFolder))];
  const paths = homes.flatMap((root) => folders.map((folder) => join(root, ".claude", "projects", folder, sessionId, "tool-results")));
  return [...new Set(paths.flatMap(volumeForms))];
}

/**
 * The read decision: anywhere except credential stores and private app
 * data. `recursive` (Glob, Grep) also refuses a folder that contains one.
 */
export async function decideRead(input: {
  cwd: string;
  path: unknown;
  recursive?: boolean;
  home?: string;
  privateDirs?: readonly string[];
}): Promise<PolicyDecision> {
  if (!localPath(input.path) || !isAbsolute(input.cwd)) return deny(POLICY_MESSAGES.notLocal);
  const home = input.home ?? homedir();
  const requested = requestedPath(input.cwd, input.path, home);
  const [path, sensitive] = await Promise.all([canonical(requested, true), sensitiveRoots(home, input.privateDirs ?? [])]);
  const candidates = [requested, path].filter(present);
  if (candidates.some(opaqueAlias)) return deny(POLICY_MESSAGES.notLocal);
  if (candidates.some((candidate) => sensitive.some((root) => foldedWithin(root, candidate)))) {
    return deny(POLICY_MESSAGES.sensitive);
  }
  if (input.recursive && candidates.some((candidate) => sensitive.some((root) => foldedWithin(candidate, root)))) {
    return deny(POLICY_MESSAGES.sensitiveSearch);
  }
  return ALLOW;
}

// -------------------------------------------------------------------
// Network

const LOCAL_NAMES = new Set(["localhost", "localhost.localdomain", "ip6-localhost", "ip6-loopback", "broadcasthost"]);

/** inet_aton forms (`127.1`, `0x7f.0.0.1`, `2130706433`) that resolvers accept as IPv4 literals. */
function parseIPv4(text: string): number | null {
  const parts = text.split(".");
  if (parts.length < 1 || parts.length > 4) return null;
  const values: number[] = [];
  for (const part of parts) {
    let value: number;
    if (/^0x[\da-f]*$/i.test(part)) value = part.length === 2 ? 0 : parseInt(part.slice(2), 16);
    else if (/^0[0-7]*$/.test(part)) value = parseInt(part, 8);
    else if (/^[1-9]\d*$/.test(part)) value = Number(part);
    else return null;
    if (!Number.isSafeInteger(value)) return null;
    values.push(value);
  }
  const last = values.pop()!;
  if (values.some((value) => value > 255) || last >= 2 ** (8 * (4 - values.length))) return null;
  return values.reduce((sum, value, index) => sum + value * 2 ** (8 * (3 - index)), 0) + last;
}

/**
 * 198.18.0.0/15 (benchmarking) is deliberately public: fake-IP proxies
 * (Surge, Clash and similar) answer every name with an address from it,
 * so refusing it would cut those Macs off from the web entirely.
 */
function privateIPv4(address: number): boolean {
  const a = Math.floor(address / 2 ** 24);
  const b = Math.floor(address / 2 ** 16) % 256;
  return (
    a === 0 || // "this network", including 0.0.0.0
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224 // multicast, reserved and broadcast
  );
}

/** Eight 16-bit words of an address `isIP` already accepted as IPv6. */
function ipv6Words(address: string): number[] {
  let text = address;
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted) {
    const v4 = parseIPv4(dotted[1]!) ?? 0;
    text = `${text.slice(0, -dotted[1]!.length)}${Math.floor(v4 / 65536).toString(16)}:${(v4 % 65536).toString(16)}`;
  }
  const [head, rest] = text.split("::") as [string, string | undefined];
  const start = head ? head.split(":") : [];
  const end = rest === undefined ? [] : rest ? rest.split(":") : [];
  const words = rest === undefined ? start : [...start, ...Array<string>(8 - start.length - end.length).fill("0"), ...end];
  return words.map((word) => parseInt(word, 16));
}

function privateIPv6(address: string): boolean {
  const w = ipv6Words(address);
  const embedded = (high: number, low: number) => privateIPv4(high * 65536 + low);
  const zeros = (from: number, to: number) => w.slice(from, to).every((word) => word === 0);
  if (zeros(0, 6)) return embedded(w[6]!, w[7]!); // ::, ::1 and IPv4-compatible
  if (zeros(0, 5) && w[5] === 0xffff) return embedded(w[6]!, w[7]!); // IPv4-mapped
  if (zeros(0, 4) && w[4] === 0xffff && w[5] === 0) return embedded(w[6]!, w[7]!); // IPv4-translated
  if (w[0] === 0x64 && w[1] === 0xff9b && zeros(2, 6)) return embedded(w[6]!, w[7]!); // NAT64
  if (w[0] === 0x2002) return embedded(w[1]!, w[2]!); // 6to4
  const first = w[0]!;
  return (
    (first & 0xffc0) === 0xfe80 || // link-local
    (first & 0xffc0) === 0xfec0 || // site-local
    (first & 0xfe00) === 0xfc00 || // unique local
    (first & 0xff00) === 0xff00 // multicast
  );
}

/** Whether a resolved address is loopback, private, link-local, CGNAT, ULA, multicast or unspecified. */
function privateAddress(address: string): boolean {
  const bare = address.replace(/%.*$/, "");
  if (isIP(bare) === 6) return privateIPv6(bare);
  const v4 = isIP(bare) === 4 ? parseIPv4(bare) : null;
  // Anything a resolver returns that is not an address is not trusted either.
  return v4 === null || privateIPv4(v4);
}

/** A decision from the host as written, or the name still to be resolved. */
function judgeHostName(host: unknown): { decision: PolicyDecision } | { name: string } {
  const decided = (decision: PolicyDecision) => ({ decision });
  if (typeof host !== "string") return decided(deny(POLICY_MESSAGES.invalidHost));
  let name = host.trim().toLowerCase();
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(name);
  if (bracketed) name = bracketed[1]!;
  else if (/^[^:]+:\d+$/.test(name)) name = name.slice(0, name.lastIndexOf(":"));
  name = name.replace(/\.+$/, "");
  if (!name || /[\s\x00-\x1f\x7f/\\@]/u.test(name)) return decided(deny(POLICY_MESSAGES.invalidHost));
  if (LOCAL_NAMES.has(name) || /\.(?:localhost|local|internal|home\.arpa)$/.test(name)) return decided(deny(POLICY_MESSAGES.privateHost));
  const address = name.replace(/%.*$/, "");
  if (isIP(address) === 6) return decided(privateIPv6(address) ? deny(POLICY_MESSAGES.privateHost) : ALLOW);
  if (address !== name) return decided(deny(POLICY_MESSAGES.invalidHost));
  const v4 = parseIPv4(name);
  if (v4 !== null) return decided(privateIPv4(v4) ? deny(POLICY_MESSAGES.privateHost) : ALLOW);
  // A single-label name (`nas`, `router`) resolves through the local search domains.
  if (!name.includes(".")) return decided(deny(POLICY_MESSAGES.privateHost));
  return { name };
}

/**
 * The host decision on the name alone: local names and private literals are
 * refused, any other dotted name passes. `decideNetworkAccess` also checks
 * where the name resolves.
 */
export function decideNetworkHost(host: unknown): PolicyDecision {
  const judged = judgeHostName(host);
  return "decision" in judged ? judged.decision : ALLOW;
}

/** Every address a name resolves to (`dns.lookup` with `all: true`). Injectable for tests. */
export type HostLookup = (hostname: string) => Promise<ReadonlyArray<{ address: string }>>;

const systemLookup: HostLookup = (hostname) => lookup(hostname, { all: true, verbatim: true });

/** Longer than a healthy resolver needs; a refusal is not remembered, so a retry asks again. */
export const HOST_LOOKUP_TIMEOUT_MS = 3000;

function beforeDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/**
 * The network decision for one host: the sandboxed shell (Claude asks once
 * per new host) and WebFetch. Public hosts are allowed so downloads and
 * package installs work; the editor's own loopback services and the local
 * network are not. A name is resolved and refused when ANY of its addresses
 * is non-public, so wildcard DNS (`192-168-1-1.nip.io`) cannot reach the LAN.
 *
 * Remaining window: the sandbox proxy resolves the name again when it
 * connects, and the CLI remembers an allowed host for the rest of the
 * session, so a name with a short TTL can answer publicly here and privately
 * later (DNS rebinding). Claude Code's sandbox runtime still refuses
 * loopback, link-local, cloud-metadata and this Mac's own addresses at
 * connect time; what stays exposed is other devices on the LAN. Closing it
 * fully needs `strictAllowlist` with a fixed list of hosts.
 */
export async function decideNetworkAccess(
  host: unknown,
  options: { lookup?: HostLookup; timeoutMs?: number } = {},
): Promise<PolicyDecision> {
  const judged = judgeHostName(host);
  if ("decision" in judged) return judged.decision;
  let addresses: ReadonlyArray<{ address: string }>;
  try {
    addresses = await beforeDeadline((options.lookup ?? systemLookup)(judged.name), options.timeoutMs ?? HOST_LOOKUP_TIMEOUT_MS);
  } catch {
    return deny(POLICY_MESSAGES.unresolvedHost);
  }
  if (!Array.isArray(addresses) || addresses.length === 0) return deny(POLICY_MESSAGES.unresolvedHost);
  return addresses.some((entry) => typeof entry?.address !== "string" || privateAddress(entry.address))
    ? deny(POLICY_MESSAGES.privateHost)
    : ALLOW;
}
