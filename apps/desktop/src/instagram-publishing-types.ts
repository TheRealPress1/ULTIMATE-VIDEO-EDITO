export type InstagramPublishDraft = {
  accountId: string; videoUrl: string; caption: string; scheduledAt: string; shareToFeed: boolean;
};
export type InstagramPublishState = 'draft' | 'approved' | 'preparing' | 'processing' | 'publishing' | 'published' | 'needs_review' | 'failed' | 'cancelled';
export type InstagramPublishItem = InstagramPublishDraft & {
  id: string; revision: string; state: InstagramPublishState; createdAt: string; approvedAt: string | null;
  containerId: string | null; mediaId: string | null; publishedAt: string | null; error: string | null;
};
export type InstagramPublishQueue = { items: InstagramPublishItem[]; error: string | null };
export type InstagramPublishOperation =
  | { kind: 'create'; videoUrl: string; caption: string; shareToFeed: boolean }
  | { kind: 'status'; containerId: string }
  | { kind: 'publish'; containerId: string };
export type InstagramPublishResponse = { id?: string; status?: 'IN_PROGRESS' | 'FINISHED' | 'ERROR' | 'EXPIRED' | 'PUBLISHED' };
export type InstagramAuthStatus = { configured: boolean; pending: boolean; expiresAt: string | null; error: string | null };
