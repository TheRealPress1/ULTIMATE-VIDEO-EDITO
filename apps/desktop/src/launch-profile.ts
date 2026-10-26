import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export type LaunchProfile = { directory: string; isolated: boolean };

// Resolve existing parents too: a fresh directory below a symlink must not
// accidentally become a child of the person's normal profile.
function canonicalPath(path: string): string {
  const missing: string[] = [];
  let parent = resolve(path);
  for (;;) {
    try {
      return join(realpathSync(parent), ...missing.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const next = dirname(parent);
      if (next === parent) throw error;
      missing.push(basename(parent));
      parent = next;
    }
  }
}

function contains(parent: string, child: string, platform: string): boolean {
  // Default macOS volumes and Windows paths are case insensitive. Reject
  // ambiguous aliases conservatively even on a case-sensitive test volume.
  if (platform === 'darwin' || platform === 'win32') {
    parent = parent.toLowerCase();
    child = child.toLowerCase();
  }
  const path = relative(parent, child);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

/** An explicit alternate profile never overlaps the normal user data. */
export function resolveLaunchProfile(defaultDirectory: string, override?: string, platform = process.platform): LaunchProfile {
  if (override === undefined) return { directory: defaultDirectory, isolated: false };
  if (!override.trim() || !isAbsolute(override) || /[\x00-\x1f]/.test(override)) {
    throw new Error('--user-data-dir must name an absolute, separate profile directory.');
  }
  const directory = canonicalPath(override);
  const normal = canonicalPath(defaultDirectory);
  if (contains(directory, normal, platform) || contains(normal, directory, platform)) {
    throw new Error('--user-data-dir must not overlap the normal Cutroom profile. Choose a separate directory.');
  }
  return { directory, isolated: true };
}
