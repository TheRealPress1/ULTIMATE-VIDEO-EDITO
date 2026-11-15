/**
 * In-app feedback: what the dialog sends and what Settings shows, shared by the main process and the web app.
 * The access key appears in one place only, `FeedbackConfigInput`, which writes it. It is never read back.
 */

export const FEEDBACK_KINDS = ['feedback', 'idea'] as const;
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number];

export const FEEDBACK_AREAS = ['timeline', 'tracks', 'markers', 'playback', 'monitor', 'board', 'ai', 'projects', 'other'] as const;
export type FeedbackArea = (typeof FEEDBACK_AREAS)[number];

export const FEEDBACK_AREA_LABELS: Record<FeedbackArea, string> = {
  timeline: 'Timeline: cutting and trimming',
  tracks: 'Track headers (eye, M, S, padlock)',
  markers: 'Markers',
  playback: 'Playback and audio',
  monitor: 'Program monitor',
  board: 'Board (the canvas)',
  ai: 'AI assistant (the chat)',
  projects: 'Projects, import or export',
  other: 'Something else',
};

/** How much a problem gets in the way. */
export const FEEDBACK_IMPACTS = ['blocks-work', 'slows-me-down', 'annoying', 'small'] as const;
export type FeedbackImpact = (typeof FEEDBACK_IMPACTS)[number];

export const FEEDBACK_IMPACT_LABELS: Record<FeedbackImpact, string> = {
  'blocks-work': 'Blocks my work',
  'slows-me-down': 'Slows me down',
  annoying: 'Annoying',
  small: 'Small thing',
};

/** How much an idea matters to the person. */
export const FEEDBACK_IMPORTANCES = ['must-have', 'changes-my-work', 'nice-to-have'] as const;
export type FeedbackImportance = (typeof FEEDBACK_IMPORTANCES)[number];

export const FEEDBACK_IMPORTANCE_LABELS: Record<FeedbackImportance, string> = {
  'must-have': 'I would not edit without it',
  'changes-my-work': 'It would change how I work',
  'nice-to-have': 'Nice to have',
};

/** What the dialog collects. The two kinds share fields; the dialog words them differently. */
export type FeedbackReport = {
  kind: FeedbackKind;
  /** One line, up to 120 characters. */
  title: string;
  area: FeedbackArea;
  /** Feedback: what they were trying to do. Idea: what they would want to be able to do. */
  doing: string;
  /** Feedback: what happened. Unused for an idea. */
  happened: string;
  /** Feedback: what they expected, or what Premiere does there. Idea: how they do it today in Premiere. */
  expected: string;
  /** Idea: why it matters in a real edit. Unused for feedback. */
  why: string;
  /** Feedback only. */
  impact: FeedbackImpact;
  /** Idea only. */
  importance: FeedbackImportance;
  /** The workspace that was open, which only the app window knows. */
  workspace: 'edit' | 'board' | null;
  /** A JPEG data URL the main process captured when the dialog was asked for, if the person kept it. */
  screenshot: string | null;
};

export type FeedbackStatus = {
  /** A repository, a name and a key are all set. */
  configured: boolean;
  repo: string | null;
  reporter: string | null;
  hasKey: boolean;
  /** Whether this Mac can keep the key encrypted. Without it the key is refused rather than stored in the clear. */
  secureStorage: boolean;
};

/** Written by Settings. A missing `key` leaves the saved key as it is. */
export type FeedbackConfigInput = {
  repo: string;
  reporter: string;
  key?: string;
};

export type FeedbackSubmitResult = {
  number: number;
  /** `failed`: the report was sent without its screenshot. */
  screenshot: 'attached' | 'none' | 'failed';
};

export type FeedbackListItem = {
  number: number;
  title: string;
  state: 'open' | 'closed';
  kind: FeedbackKind | null;
  reporter: string | null;
  createdAt: string;
  updatedAt: string;
  comments: number;
};

export type FeedbackComment = {
  id: number;
  /** Written from inside the app (by `reporter`) rather than by the team on GitHub. */
  fromApp: boolean;
  reporter: string | null;
  createdAt: string;
  body: string;
};

export type FeedbackThread = Omit<FeedbackListItem, 'comments'> & {
  /** The report as written, without the marker line the app uses to recognize it. */
  body: string;
  comments: FeedbackComment[];
};

export type FeedbackConnection = {
  repo: string;
  private: boolean;
};
