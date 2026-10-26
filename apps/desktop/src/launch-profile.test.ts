import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveLaunchProfile } from './launch-profile';

let root: string;
let normal: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'cutroom-profile-')));
  normal = join(root, 'appData', 'Cutroom');
  mkdirSync(normal, { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('alternate launch profiles', () => {
  it('keeps ordinary launches on their existing profile', () => {
    expect(resolveLaunchProfile(normal)).toEqual({ directory: normal, isolated: false });
  });

  it('supports a new or reused separate profile and canonicalizes its parents', () => {
    const profile = join(root, 'qa', 'profile');
    expect(resolveLaunchProfile(normal, profile)).toEqual({ directory: profile, isolated: true });
    mkdirSync(profile, { recursive: true });
    symlinkSync(join(root, 'qa'), join(root, 'qa-link'));
    expect(resolveLaunchProfile(normal, join(root, 'qa-link', 'profile'))).toEqual({ directory: profile, isolated: true });
  });

  it.each(['', ' ', 'relative/profile', '~/profile', '/tmp/profile\nother'])('rejects invalid explicit profile %j', (profile) => {
    expect(() => resolveLaunchProfile(normal, profile)).toThrow(/absolute/);
  });

  it('rejects the normal profile, its ancestors, and its descendants', () => {
    for (const profile of [normal, root, join(root, 'appData'), join(normal, 'qa'), join(normal, 'one', 'two')]) {
      expect(() => resolveLaunchProfile(normal, profile)).toThrow(/overlap/);
    }
  });

  it('rejects symlinks into the normal profile even when their leaf does not exist', () => {
    symlinkSync(normal, join(root, 'normal-link'));
    expect(() => resolveLaunchProfile(normal, join(root, 'normal-link', 'new', 'qa'))).toThrow(/overlap/);
  });

  it('rejects case aliases on macOS', () => {
    expect(() => resolveLaunchProfile(normal, join(root, 'appData', 'cutroom', 'new'), 'darwin')).toThrow(/overlap/);
  });
});
