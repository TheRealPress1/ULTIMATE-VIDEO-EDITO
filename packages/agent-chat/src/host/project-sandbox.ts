import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { realpathSync } from 'node:fs';
import type { Options } from '@anthropic-ai/claude-agent-sdk';

/** Session-only settings. Login credentials are independent of settingSources. */
export function claudeProjectSandbox(cwd: string): Pick<Options, 'sandbox' | 'settings' | 'settingSources'> {
  const canonical = (path: string) => { try { return realpathSync(path); } catch { return resolve(path); } };
  return {
    // User permission lists merge additively; excluding them prevents an old
    // global allowWrite/excludedCommands entry from widening this project run.
    settingSources: [],
    sandbox: {
      enabled: true, failIfUnavailable: true, autoAllowBashIfSandboxed: true,
      // Human review does not disable the OS sandbox for this editing session.
      allowUnsandboxedCommands: false,
      excludedCommands: [],
      filesystem: { disabled: false, allowWrite: [...new Set([cwd, tmpdir(), ...(process.platform === 'win32' ? [] : ['/tmp'])].map(canonical))] },
      network: { allowedDomains: [], strictAllowlist: true, allowAllUnixSockets: false, allowLocalBinding: false },
    },
    settings: { permissions: { ask: [
      'Bash(dangerouslyDisableSandbox:true)',
      'Bash(rm *)', 'Bash(/bin/rm *)', 'Bash(rmdir *)', 'Bash(/bin/rmdir *)',
      'Bash(sudo *)', 'Bash(git push *)', 'Bash(git reset *)', 'Bash(git clean *)',
    ] } },
  };
}

/** Additional review, never an allowlist or a substitute for the OS sandbox. */
export function shellNeedsReview(input: Record<string, unknown>): boolean {
  if (input.dangerouslyDisableSandbox === true || typeof input.command !== 'string' || !input.command.trim()) return true;
  return /(?:^|[\s;&|()])(?:\/\w[\w/.-]*\/)?(?:rm|rmdir|sudo|shred|diskutil|mkfs|launchctl|osascript)(?:\s|$)/m.test(input.command) ||
    /\bgit\s+(?:push|reset|clean)\b|\b(?:os\.(?:remove|unlink|rmdir)|shutil\.rmtree)\s*\(/.test(input.command);
}

/** Preserve explicit provider/organization restrictions rather than overriding them. */
export function explicitPermissionBoundary(reason?: string, blockedPath?: string): boolean {
  return Boolean(blockedPath) || Boolean(reason && /\b(?:ask rule|deny rule|policy|organization|critical path|outside|network|unsandboxed|blocked)\b/i.test(reason));
}
