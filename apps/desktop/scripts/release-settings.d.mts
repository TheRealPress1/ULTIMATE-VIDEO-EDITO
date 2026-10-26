export interface BuiltReleaseConfig {
  signedRelease: boolean;
  updateFeedUrl: string | null;
  updateFeedType: 'default' | 'json';
  privateDownloadUrl: string | null;
  teamId: string | null;
  instagramAuthUrl: string | null;
}
export function resolveReleaseSettings(env?: NodeJS.ProcessEnv, platform?: string): {
  releaseConfig: BuiltReleaseConfig;
  osxSign: { identity?: string; keychain?: string; continueOnError: false; strictVerify: true } | undefined;
  osxNotarize: { keychainProfile: string; keychain?: string } | { appleId: string; appleIdPassword: string; teamId: string } | undefined;
};
export function assertBuiltReleaseConfig(path: string, expected: BuiltReleaseConfig): void;
