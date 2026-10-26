export type UpdateStatus = {
  state: 'unavailable' | 'idle' | 'checking' | 'downloading' | 'ready' | 'installing' | 'error';
  currentVersion: string;
  message: string;
  releaseName?: string;
  /** Opens the browser's GitHub session; this is a manual installer, not an auto-update feed. */
  privateDownloadUrl?: string;
};

export type ReleaseConfig = {
  updateFeedUrl: string | null;
  /** Older releases use the version-aware HTTP endpoint. Static hosts use Squirrel's JSON format. */
  updateFeedType?: 'default' | 'json';
  privateDownloadUrl?: string | null;
  teamId: string | null;
  signedRelease: boolean;
};
