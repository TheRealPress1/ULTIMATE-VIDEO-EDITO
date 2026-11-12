import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { realpathSync } from 'node:fs';
import type { Options } from '@anthropic-ai/claude-agent-sdk';

import { PROTECTED_SEGMENTS, claudeToolResultPaths, sensitiveReadPaths } from './automatic-policy';

/** Patterns the CLI refuses outright: a backstop behind the PreToolUse hook's guided denials. */
const DENIED_SHELL_RULES = [
  'Bash(dangerouslyDisableSandbox:true)',
  'Bash(rm *)', 'Bash(/bin/rm *)', 'Bash(rmdir *)', 'Bash(/bin/rmdir *)',
  'Bash(sudo *)', 'Bash(git push *)', 'Bash(git reset *)', 'Bash(git clean *)',
];

const contains = (root: string, path: string): boolean => {
  const part = relative(root, path);
  return part === '' || (!isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`));
};

export type ProjectSandboxOptions = {
  home?: string;
  /** The host's own stores (chat transcripts), unreadable to commands. */
  privateDirs?: readonly string[];
  /** The `claude` executable: its folder stays readable even inside a denied store. */
  cliPath?: string;
  /** The session the CLI runs: its saved tool results stay readable inside ~/.claude/projects. */
  sessionId?: string;
};

/** Session-only settings. Login credentials are independent of settingSources. */
export function claudeProjectSandbox(cwd: string, options: ProjectSandboxOptions = {}): Pick<Options, 'sandbox' | 'settings' | 'settingSources'> {
  const canonical = (path: string) => { try { return realpathSync(path); } catch { return resolve(path); } };
  const writable = [...new Set([cwd, tmpdir(), ...(process.platform === 'win32' ? [] : ['/tmp'])].map(canonical))];
  const denyRead = sensitiveReadPaths(options.home, options.privateDirs);
  // Bash sources the CLI's shell snapshot, which can call back into its own
  // binary (bundled ripgrep). A CLI installed inside a denied store (Claude
  // Desktop keeps a copy under Application Support/Claude) stays readable.
  const cliFolder = options.cliPath ? dirname(canonical(options.cliPath)) : null;
  // The CLI saves an oversized tool result in the session's own folder under
  // ~/.claude/projects and tells the model to query it with jq or grep.
  const toolResults = options.sessionId ? claudeToolResultPaths(cwd, options.sessionId, options.home) : [];
  const allowRead = [...(cliFolder ? [cliFolder] : []), ...toolResults]
    .filter((path) => denyRead.some((root) => contains(root, path)));
  return {
    // User permission lists merge additively; excluding them prevents an old
    // global allowWrite/excludedCommands entry from widening this project run.
    settingSources: [],
    sandbox: {
      enabled: true, failIfUnavailable: true, autoAllowBashIfSandboxed: true,
      // There is no review to escalate to: commands always stay in the OS sandbox.
      allowUnsandboxedCommands: false,
      excludedCommands: [],
      filesystem: {
        disabled: false,
        allowWrite: writable,
        // Protected names (.cutroom, .codex, .git…) stay unwritable inside the writable roots.
        denyWrite: writable.flatMap((root) => PROTECTED_SEGMENTS.map((segment) => join(root, segment))),
        // Commands reach public hosts without asking, so they never see the
        // credential stores and transcripts the file tools are refused.
        denyRead,
        ...(allowRead.length ? { allowRead } : {}),
      },
      // Each new host reaches canUseTool("SandboxNetworkAccess"), which applies
      // the automatic host decision instead of a strict allowlist.
      network: { allowedDomains: [], strictAllowlist: false, allowAllUnixSockets: false, allowLocalBinding: false },
    },
    settings: { permissions: { deny: DENIED_SHELL_RULES } },
  };
}

export const SHELL_MESSAGES = {
  destructive:
    "Blackout editing sessions don't run deleting or system commands (rm, rmdir, unlink, truncate, find -delete, rsync --delete, scripted deletes, sudo, git push/reset/clean, diskutil, launchctl, osascript…). Leave unused files in place — media in assets/ and exports/ may be the only copy — or write a new temporary file instead.",
  unsandboxed:
    "Commands always run inside the project sandbox, which still reaches public hosts; retry without dangerouslyDisableSandbox. Get media through the cutroom tools rather than a command: `media_download` for YouTube, SoundCloud and other platform links, `web_media_download` for openly licensed files and pages.",
  empty: "Provide the shell command to run.",
  managed:
    "This Mac's managed Claude Code policy requires review for shell commands, which Blackout chats can't show. Use the cutroom tools instead.",
} as const;

// These patterns are guidance, not a security boundary: a determined command
// can always be spelled another way. The OS sandbox's write scope (project and
// temp, protected names denied) is what actually bounds a shell command.

const COMMAND_WORDS = 'rm|rmdir|unlink|truncate|shred|srm|sudo|diskutil|mkfs|launchctl|osascript';
/** A program folder (`/bin/`, `/usr/local/sbin/`), so `/tmp/rm` stays a file name. */
const BIN_PATH = String.raw`(?:(?:/[\w.-]+)*/s?bin/)?`;
/** A deleting or system command word, bare, escaped (`\rm`) or from a program folder (`/bin/rm`). */
const DESTRUCTIVE_COMMAND = new RegExp(String.raw`(?:^|[\s;&|()\`])\\?${BIN_PATH}(?:${COMMAND_WORDS})(?=[\s;&|)\`]|$)`, 'm');
/**
 * The same word quoted (`"rm" -rf assets`) where a command starts or after a
 * word that runs its argument (`xargs 'rm'`), so `echo "rm"` stays text.
 */
const QUOTED_COMMAND = new RegExp(
  String.raw`(?:(?:^|[;&|(\`])\s*|(?:^|\s)(?:command|builtin|exec|nohup|time|env|xargs|-exec|-execdir|-ok|-okdir)(?:\s+-\S+)*\s+)` +
  String.raw`(["'])${BIN_PATH}(?:${COMMAND_WORDS})\1(?=[\s;&|)\`]|$)`,
  'm',
);
/** `find … -delete` (`find … -exec rm` is caught by the command word). */
const FIND_DELETE = /(?:^|[\s;&|()`])find(?:\s[^\n;&|]*?)?\s-delete(?=[\s;&|)]|$)/m;
/** `rsync … --delete…` / `--del` / `--remove-source-files`. */
const RSYNC_DELETE = /(?:^|[\s;&|()`])rsync(?:\s[^\n;&|]*?)?\s--(?:del|delete[\w-]*|remove-source-files)(?=[\s=;&|)]|$)/m;
const GIT_DESTRUCTIVE = /\bgit\s+(?:push|reset|clean)\b/;
/**
 * Deleting calls in inline interpreter code (python -c, heredocs, node -e,
 * ruby -e): only qualified forms, so `items.remove(x)` stays allowed.
 */
const DELETING_CALL =
  /\b(?:os\.(?:remove|unlink|rmdir|removedirs)|shutil\.rmtree|send2trash|fs\.(?:promises\.)?(?:unlink|rm|rmdir)(?:Sync)?|unlinkSync|rmSync|rmdirSync)\s*\(|\.(?:unlink|rmdir|rmtree)\s*\(|\b(?:File|FileUtils|Dir|Pathname)\.(?:delete|unlink|rm|rm_r|rm_rf|rm_f|remove\w*|rmdir|rmtree)\b/;
/**
 * Perl's `unlink`/`rmtree` take no parentheses; judge them only in a perl
 * command, and not as a regex (`/unlink/`, `/rmdir|unlink/`).
 */
const PERL_DELETE = /(?:^|[\s;&|()`])(?:[\w.~-]*\/)*perl\b[^\n]*?(?<![/|])\b(?:unlink|rmtree|remove_tree)\b(?![/|)])/m;
const DESTRUCTIVE_PATTERNS = [DESTRUCTIVE_COMMAND, QUOTED_COMMAND, FIND_DELETE, RSYNC_DELETE, GIT_DESTRUCTIVE, DELETING_CALL, PERL_DELETE];

/** A shell program, by name or path. */
const SHELL = String.raw`(?:[\w.~-]*/)*(?:ba|da|k|z|fi|tc|c|a|mk)?sh`;
/** A quoted argument: `$'…'` (group 1), `'…'` (2) or `"…"` (3); the closing quote may be missing. */
const QUOTED = String.raw`\$'((?:[^'\\]|\\[\s\S])*)'?|'([^']*)'?|"((?:[^"\\]|\\[\s\S])*)"?`;
/**
 * A script handed to a shell as one argument: `sh -c '…'`, `bash -lc "…"`,
 * `bash -o pipefail -c '…'`, `eval '…'`, wherever they appear (after
 * `timeout`, inside `find -exec` or `xargs`).
 */
const INLINE_SCRIPT = new RegExp(
  String.raw`(?:^|[\s;&|()\`])(?:${SHELL}(?:\s+(?:--?[\w-]+|[-+]o\s+\w+))*?\s+-[a-zA-Z]*c[a-zA-Z]*|eval(?:\s+--)?)\s+(?:${QUOTED})`,
  'g',
);
/** A shell reading its script from a pipe or a here-string: every quoted string may be part of it. */
const SHELL_STDIN = new RegExp(String.raw`\|\s*${SHELL}(?=[\s;&|)\`]|$)|(?:^|[\s;&|()\`])${SHELL}\s[^\n;&|]*<<<`, 'm');
const QUOTED_STRING = new RegExp(QUOTED, 'g');
/** Shells within shells: deep enough for `find -exec sh -c "bash -c '…'"`. */
const SCRIPT_DEPTH = 4;

function scriptText([, ansi, single, double]: RegExpMatchArray): string {
  if (ansi !== undefined) return ansi.replace(/\\([\s\S])/g, (_, char: string) => (char === 'n' ? '\n' : char === 't' ? '\t' : char));
  if (single !== undefined) return single;
  return (double ?? '').replace(/\\(["\\$`\n])/g, '$1');
}

/**
 * The scripts a command hands to a shell, unquoted, nested ones included.
 * A delete word right after a script's opening quote (`bash -c 'rm -rf x'`)
 * starts a command there, but no pattern sees it in the outer command.
 */
function inlineScripts(command: string, depth = 0): string[] {
  if (depth >= SCRIPT_DEPTH) return [];
  const matches = [...command.matchAll(INLINE_SCRIPT), ...(SHELL_STDIN.test(command) ? command.matchAll(QUOTED_STRING) : [])];
  return matches.map(scriptText).flatMap((script) => [script, ...inlineScripts(script, depth + 1)]);
}

/** The guidance a refused shell command gets, or null. Never a substitute for the OS sandbox. */
export function shellDenial(input: Record<string, unknown>): string | null {
  if (input.dangerouslyDisableSandbox === true) return SHELL_MESSAGES.unsandboxed;
  if (typeof input.command !== 'string' || !input.command.trim()) return SHELL_MESSAGES.empty;
  const command = input.command;
  const destructive = [command, ...inlineScripts(command)]
    .some((text) => DESTRUCTIVE_PATTERNS.some((pattern) => pattern.test(text)));
  return destructive ? SHELL_MESSAGES.destructive : null;
}

/**
 * Claude Code's own dangerous-removal checks (an `rm` whose target it
 * can't vet, a denied command inside a `sh -c` script) reach canUseTool as
 * asks. With no one to ask, they are refused like the commands above.
 * Matches the reasons CLI 2.1.310+ sends; an unknown wording falls back to
 * shellDenial and the OS sandbox.
 */
const CLI_REMOVAL_REASON =
  /(?:Dangerous \w+ operation\b|A permission rule denies a command in(?:side)? this shell -c script|This shell -c script runs rm\b)/;

export function cliRemovalCheck(decisionReason: unknown): boolean {
  return typeof decisionReason === 'string' && CLI_REMOVAL_REASON.test(decisionReason);
}
