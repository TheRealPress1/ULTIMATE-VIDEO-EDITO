/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Wire-level channels — the only raw ipcRenderer/ipcMain channels in play for
// the main↔renderer request/event protocol. Everything else multiplexes
// through these via an envelope carrying the logical MAIN_CHANNELS name and
// (for requests) a UUID for correlation.
//
// Tool calls from the MCP server use their own wire (DAPI_WIRE in
// @diffusionstudio/dapi), in the other direction: main asks, the renderer answers.
import type { LogEntry, ScreenshotResult, ToolArgs, ToolOutput, EditingStyle } from "@diffusionstudio/dapi";
import type { SourceEdit, WriteResult } from "./edit-types";
import type { AgentId } from "./mcp-config";
import type { EditorId, EditorInfo } from "./editors";
import type { MissingProjectChoice, SaveAction } from "./projects";
import type { InstagramDashboard } from "./instagram-types";
import type { CollectProjectResult, RelinkProjectMediaResult } from "./project-portability";
import type { ProjectVersion, ProjectVersionInspection } from "./project-versions";
import type { SpeechProgress, SpeechResult, SpeechStatus } from "./speech-types";
import type { FootageIndexPutRequest, FootageIndexRequest, FootageIndexResult, FootageChunkRequest, FootageChunkPutRequest, FootageChunksResult } from "./footage-types";
import type { ReframeAnalysisRequest, ReframeAnalysisResult, ReframeAnalysisProgress } from "./reframe-types";
import type { VisualIndexRequest, VisualIndexJob, VisualIndexResult, VisualProgress } from './visual-types';
import type { AudioFinishingRequest, AudioFinishingResult } from './audio-finishing-types';
import type { UpdateStatus } from './update-types';
import type { InstagramAuthStatus, InstagramPublishDraft, InstagramPublishQueue } from './instagram-publishing-types';
import type { InstagramAuthPoll } from './instagram-auth';
import type { ReferenceRequest, ReferenceJob, ReferenceResult, ReferenceProgress } from './reference-types';
import type { SpeakerAnalysisRequest, SpeakerAnalysisResult, SpeakerAnalysisProgress } from './speaker-types';
import type { AnalysisCacheRequest, AnalysisCacheResult, AnalysisCachePut } from './analysis-cache-types';
import type { PlaybackProxyRequest, PlaybackProxyJob, PlaybackProxyResult, PlaybackProxyProgress } from './playback-proxy-types';
import type { WebMediaCommitRequest, WebMediaCommitResult, WebMediaDownloaded, WebMediaDownloadRequest } from './web-media-types';

export const MAIN_WIRE = {
  REQUEST: "main:request",
  RESPONSE: "main:response",
  EVENT: "main:event",
} as const;

export type MainWireChannel = (typeof MAIN_WIRE)[keyof typeof MAIN_WIRE];

// Logical channels. Two categories:
//   • Renderer→Main requests (request + response)
//   • Main→Renderer events   (push, no response)
// Tool calls are not here: they arrive from main over DAPI_WIRE and are
// answered by the renderer's handlers (apps/web/src/dapi).
import type { ExportFinalization } from './export-finalization-types';

export const MAIN_CHANNELS = {
  // Renderer→Main requests
  APP_OPEN_EXTERNAL: "app:open-external",
  UPDATES_STATUS: 'updates:status',
  UPDATES_CHECK: 'updates:check',
  UPDATES_INSTALL: 'updates:install',
  APP_SHOW_IN_FOLDER: "app:show-in-folder",
  APP_EDITORS_LIST: "app:editors-list",
  APP_OPEN_IN_EDITOR: "app:open-in-editor",
  ANALYTICS_CONFIGURE: "analytics:configure",
  INSTAGRAM_GET: "instagram:get",
  EDITING_SKILLS: "editing:skills",
  EDITING_STYLE_GET: "editing:style-get",
  EDITING_STYLE_SET: "editing:style-set",
  FOOTAGE_INDEX_GET: "footage:index-get",
  FOOTAGE_INDEX_PUT: "footage:index-put",
  FOOTAGE_INDEX_CHUNKS_GET: 'footage:chunks-get',
  FOOTAGE_INDEX_CANCEL: 'footage:index-cancel',
  FOOTAGE_INDEX_CHUNK_PUT: 'footage:chunk-put',
  ANALYSIS_CACHE_GET: 'analysis:cache-get',
  ANALYSIS_CACHE_PUT: 'analysis:cache-put',
  ANALYSIS_CACHE_CANCEL: 'analysis:cache-cancel',
  SPEAKER_ANALYZE: 'speaker:analyze',
  SPEAKER_CANCEL: 'speaker:cancel',
  SPEAKER_PROGRESS: 'speaker:progress',
  REFRAME_ANALYZE: "reframe:analyze",
  REFRAME_CANCEL: "reframe:cancel",
  VISUAL_GET: 'visual:get',
  VISUAL_INDEX: 'visual:index',
  VISUAL_CANCEL: 'visual:cancel',
  VISUAL_PROGRESS: 'visual:progress',
  REFERENCE_GET: 'reference:get',
  REFERENCE_ANALYZE: 'reference:analyze',
  REFERENCE_CANCEL: 'reference:cancel',
  REFERENCE_PROGRESS: 'reference:progress',
  PLAYBACK_PROXY_GET: 'playback-proxy:get',
  PLAYBACK_PROXY_PREPARE: 'playback-proxy:prepare',
  PLAYBACK_PROXY_CANCEL: 'playback-proxy:cancel',
  PLAYBACK_PROXY_RELEASE: 'playback-proxy:release',
  PLAYBACK_PROXY_PROGRESS: 'playback-proxy:progress',
  AUDIO_FINISH_RUN: 'audio-finish:run',
  AUDIO_FINISH_CANCEL: 'audio-finish:cancel',
  WEB_MEDIA_DOWNLOAD: 'web-media:download',
  WEB_MEDIA_CANCEL: 'web-media:cancel',
  WEB_MEDIA_COMMIT: 'web-media:commit',
  WEB_MEDIA_DISCARD: 'web-media:discard',
  INSTAGRAM_CONNECT: "instagram:connect",
  INSTAGRAM_SYNC: "instagram:sync",
  INSTAGRAM_DISCONNECT: "instagram:disconnect",
  INSTAGRAM_AUTH_STATUS: 'instagram:auth-status',
  INSTAGRAM_AUTH_START: 'instagram:auth-start',
  INSTAGRAM_AUTH_POLL: 'instagram:auth-poll',
  INSTAGRAM_AUTH_CANCEL: 'instagram:auth-cancel',
  INSTAGRAM_QUEUE_GET: 'instagram:queue-get',
  INSTAGRAM_QUEUE_CREATE: 'instagram:queue-create',
  INSTAGRAM_QUEUE_APPROVE: 'instagram:queue-approve',
  INSTAGRAM_QUEUE_CANCEL: 'instagram:queue-cancel',
  INSTAGRAM_QUEUE_REMOVE: 'instagram:queue-remove',
  INSTAGRAM_QUEUE_RECONCILE: 'instagram:queue-reconcile',
  SPEECH_STATUS: "speech:status",
  SPEECH_TRANSCRIBE: "speech:transcribe",
  SPEECH_CANCEL: "speech:cancel",
  AUTH_GET_PENDING_CALLBACK: "auth:get-pending-callback",
  CHECKOUT_GET_PENDING_CALLBACK: "checkout:get-pending-callback",
  WINDOW_IS_FULLSCREEN: "window:is-fullscreen",
  WINDOW_SET_COLOR_MODE: "window:set-color-mode",
  WINDOW_CAPTURE: "window:capture",
  WINDOW_SET_BUSY: "window:set-busy",
  WINDOW_SHOW: "window:show",
  CLIPBOARD_PATHS: "clipboard:paths",
  FILE_TRANSFER: "file:transfer",
  EXPORT_PICK_SAVE: "export:pick-save",
  FILE_WRITE_OPEN: "file:write-open",
  FILE_WRITE_CHUNK: "file:write-chunk",
  FILE_WRITE_CLOSE: "file:write-close",
  FILE_WRITE_ABORT: "file:write-abort",
  LOGS_GET: "logs:get",
  PROJECTS_PICK_FOLDER: "projects:pick-folder",
  PROJECTS_GET: "projects:get",
  PROJECTS_INIT: "projects:init",
  PROJECTS_RESOLVE: "projects:resolve",
  PROJECTS_FIND_MOVED: "projects:find-moved",
  PROJECTS_ASK_MISSING: "projects:ask-missing",
  PROJECTS_CREATE: "projects:create",
  PROJECTS_PICK_SAVE: "projects:pick-save",
  PROJECTS_SAVE: "projects:save",
  PROJECTS_MOVE: "projects:move",
  PROJECTS_RENAME: "projects:rename",
  PROJECTS_DUPLICATE: "projects:duplicate",
  PROJECTS_DELETE: "projects:delete",
  PROJECTS_COMPILE: "projects:compile",
  PROJECTS_WRITE: "projects:write",
  PROJECTS_VERSIONS: "projects:versions",
  PROJECTS_COLLECT_PICK: "projects:collect-pick",
  PROJECTS_COLLECT: "projects:collect",
  PROJECTS_RELINK: "projects:relink",
  PROJECTS_VERSION_CREATE: "projects:version-create",
  PROJECTS_VERSION_RESTORE: "projects:version-restore",
  PROJECTS_VERSION_INSPECT: "projects:version-inspect",
  PROJECTS_VERSION_RESTORE_LAYER: "projects:version-restore-layer",
  PROJECTS_RELOAD: "projects:reload",
  PROJECTS_FLUSH_RESULT: "projects:flush-result",
  PROJECTS_WATCH: "projects:watch",
  PROJECTS_UNWATCH: "projects:unwatch",
  PROJECTS_MANIFEST_READ: "projects:manifest-read",
  PROJECTS_MANIFEST_WRITE: "projects:manifest-write",
  PROJECTS_CONFIG_READ: "projects:config-read",
  PROJECTS_CONFIG_WRITE: "projects:config-write",
  PROJECTS_FS_LIST: "projects:fs-list",
  PROJECTS_FS_STAT: "projects:fs-stat",
  PROJECTS_FS_REMOVE: "projects:fs-remove",
  PROJECTS_FS_REAL_PATH: "projects:fs-real-path",
  AGENT_CHAT_ENDPOINT: "agent-chat:endpoint",
  MCP_STATUS: "mcp:status",
  MCP_APPLY: "mcp:apply",
  CLI_STATUS: "cli:status",
  CLI_INSTALL: "cli:install",
  CLI_UNINSTALL: "cli:uninstall",

  // Main→Renderer events
  AUTH_CALLBACK: "auth:callback",
  CHECKOUT_CALLBACK: "checkout:callback",
  WINDOW_FULLSCREEN_CHANGE: "window:fullscreen-change",
  EDITOR_HISTORY: 'editor:history',
  PROJECTS_CHANGED: "projects:changed",
  PROJECTS_FLUSH_REQUEST: "projects:flush-request",
  SPEECH_PROGRESS: "speech:progress",
  REFRAME_PROGRESS: "reframe:progress",
} as const;

/**
 * A project folder, wherever it lives: a real npm package with a JSX entry.
 * Its package.json is the project record: `projectId` is what the project
 * is, `displayName` the human name, `main` the entry file.
 */
export type ProjectInfo = {
  /**
   * package.json `projectId`: the project's identity, and the segment its URL
   * carries. Empty for a folder that predates ids and has not been opened
   * since — `PROJECTS_RESOLVE` is what gives one out.
   */
  id: string;
  /** Folder name. The user can move or rename it, so it is not the identity. */
  name: string;
  /** Human name from package.json `displayName` (falls back to the folder name). */
  displayName: string;
  /** Absolute path of the project folder. */
  dir: string;
  /** Entry file relative to `dir`: package.json `main`, else index.tsx/ts/jsx/js. */
  entry: string;
  /** mtime of the entry file, ISO string. */
  modifiedAt: string;
  /** birthtime of the folder, ISO string. */
  createdAt: string;
  /**
   * Whether the folder is a draft's: in the app's drafts folder, named after
   * the id, until the user saves it somewhere of their choosing.
   */
  draft: boolean;
};

export type CompileResult =
  { ok: true; code: string } | { ok: false; error: string };

export type { SourceEdit, WriteResult };
export type { AgentId };
export type { EditorId, EditorInfo };
export type { MissingProjectChoice };

// One agent the settings page lists: whether it is set up on this machine,
// whether its config already carries the app's MCP entry, and — for the
// agents that need the bundled `dapi` binary — why this build cannot
// connect it (null when it can).
export type McpAgentStatus = {
  id: AgentId;
  label: string;
  detected: boolean;
  connected: boolean;
  /** Absolute path of the config file the entry goes into. */
  config: string;
  unavailable: string | null;
};

/** `url` is the HTTP endpoint any other agent can be pointed at by hand. */
export type McpStatus = { url: string; agents: McpAgentStatus[] };

export type McpApplyRequest = { add: AgentId[]; remove: AgentId[] };

// Per agent: written, taken out, or left as it was with the reason.
export type McpApplyResult = {
  added: AgentId[];
  removed: AgentId[];
  failures: { id: AgentId; error: string }[];
};

// Where the `cutroom` command stands. `managed` means this build owns its
// link or shim; `available` means this build can install the command.
export type CliStatus = {
  installed: boolean;
  path: string | null;
  managed: boolean;
  available: boolean;
};

// Outcome of linking the Cutroom CLI into PATH. "cancelled" means the
// user dismissed the macOS admin prompt — not an error, not installed.
export type CliInstallResult =
  | { status: "installed" }
  | { status: "cancelled" }
  | { status: "error"; error: string };

// Outcome of taking the symlink back out. "absent" means there was none to
// remove; "cancelled" that the admin prompt was dismissed and it stays.
export type CliUninstallResult =
  | { status: "removed" }
  | { status: "absent" }
  | { status: "cancelled" }
  | { status: "error"; error: string };

export type MainChannel = (typeof MAIN_CHANNELS)[keyof typeof MAIN_CHANNELS];

// Events fed by a `diffusion://` deep link. Main routes each link to exactly
// one of these by its host, so auth and checkout never consume each other's.
export type DeepLinkChannel =
  typeof MAIN_CHANNELS.AUTH_CALLBACK | typeof MAIN_CHANNELS.CHECKOUT_CALLBACK;

export type MainRequestMap = {
  [MAIN_CHANNELS.UPDATES_STATUS]: {request:void;response:UpdateStatus};
  [MAIN_CHANNELS.UPDATES_CHECK]: {request:void;response:UpdateStatus};
  [MAIN_CHANNELS.UPDATES_INSTALL]: {request:void;response:void};
  [MAIN_CHANNELS.EDITING_SKILLS]: { request: ToolArgs<"skills">; response: ToolOutput<"skills"> };
  [MAIN_CHANNELS.EDITING_STYLE_GET]: { request: void; response: EditingStyle };
  [MAIN_CHANNELS.EDITING_STYLE_SET]: { request: { notes: string; expectedRevision: number }; response: EditingStyle };
  [MAIN_CHANNELS.FOOTAGE_INDEX_GET]: { request: FootageIndexRequest; response: FootageIndexResult };
  [MAIN_CHANNELS.FOOTAGE_INDEX_PUT]: { request: FootageIndexPutRequest; response: FootageIndexResult };
  [MAIN_CHANNELS.FOOTAGE_INDEX_CANCEL]: { request: {id:string}; response: void };
  [MAIN_CHANNELS.FOOTAGE_INDEX_CHUNKS_GET]: { request: FootageChunkRequest; response: FootageChunksResult };
  [MAIN_CHANNELS.FOOTAGE_INDEX_CHUNK_PUT]: { request: FootageChunkPutRequest; response: FootageChunksResult };
  [MAIN_CHANNELS.ANALYSIS_CACHE_GET]: { request: AnalysisCacheRequest; response: AnalysisCacheResult };
  [MAIN_CHANNELS.ANALYSIS_CACHE_PUT]: { request: AnalysisCachePut; response: void };
  [MAIN_CHANNELS.ANALYSIS_CACHE_CANCEL]: { request: {id:string}; response: void };
  [MAIN_CHANNELS.SPEAKER_ANALYZE]: { request: Omit<SpeakerAnalysisRequest, 'path'> & {source:string}; response: SpeakerAnalysisResult };
  [MAIN_CHANNELS.SPEAKER_CANCEL]: { request: {id:string}; response: void };
  [MAIN_CHANNELS.REFRAME_ANALYZE]: { request: Omit<ReframeAnalysisRequest, "path"> & { dir: string; source: string }; response: ReframeAnalysisResult };
  [MAIN_CHANNELS.VISUAL_GET]: { request: VisualIndexRequest; response: VisualIndexResult };
  [MAIN_CHANNELS.VISUAL_INDEX]: { request: VisualIndexJob; response: VisualIndexResult };
  [MAIN_CHANNELS.VISUAL_CANCEL]: { request: {id:string}; response:void };
  [MAIN_CHANNELS.REFERENCE_GET]: { request: ReferenceRequest; response: ReferenceResult };
  [MAIN_CHANNELS.REFERENCE_ANALYZE]: { request: ReferenceJob; response: ReferenceResult };
  [MAIN_CHANNELS.REFERENCE_CANCEL]: { request: {id:string}; response:void };
  [MAIN_CHANNELS.PLAYBACK_PROXY_GET]: { request: PlaybackProxyRequest; response: PlaybackProxyResult };
  [MAIN_CHANNELS.PLAYBACK_PROXY_PREPARE]: { request: PlaybackProxyJob; response: PlaybackProxyResult };
  [MAIN_CHANNELS.PLAYBACK_PROXY_CANCEL]: { request: {id:string}; response:void };
  [MAIN_CHANNELS.PLAYBACK_PROXY_RELEASE]: { request: {dir:string;sessionId:string}; response:void };
  [MAIN_CHANNELS.AUDIO_FINISH_RUN]: { request:AudioFinishingRequest; response:AudioFinishingResult };
  [MAIN_CHANNELS.AUDIO_FINISH_CANCEL]: { request:{id:string}; response:void };
  // web_media_download: main fetches into the project, the renderer imports, then commits (ledger + CREDITS.md) or discards.
  [MAIN_CHANNELS.WEB_MEDIA_DOWNLOAD]: { request: WebMediaDownloadRequest; response: WebMediaDownloaded };
  [MAIN_CHANNELS.WEB_MEDIA_CANCEL]: { request: { id: string }; response: void };
  [MAIN_CHANNELS.WEB_MEDIA_COMMIT]: { request: WebMediaCommitRequest; response: WebMediaCommitResult };
  [MAIN_CHANNELS.WEB_MEDIA_DISCARD]: { request: { id: string }; response: void };
  [MAIN_CHANNELS.REFRAME_CANCEL]: { request: { id: string }; response: void };
  [MAIN_CHANNELS.PROJECTS_COLLECT_PICK]: { request: {dir: string}; response: string | null };
  [MAIN_CHANNELS.PROJECTS_COLLECT]: { request: {dir: string; target: string}; response: CollectProjectResult };
  [MAIN_CHANNELS.PROJECTS_RELINK]: { request: {dir: string; searchDir: string; apply?: boolean; expectedPreview?: string}; response: RelinkProjectMediaResult };
  [MAIN_CHANNELS.PROJECTS_VERSIONS]: { request: {dir: string}; response: {versions: ProjectVersion[]; fingerprint: string} };
  [MAIN_CHANNELS.PROJECTS_VERSION_CREATE]: { request: {dir: string; label?: string; preview?: string; expectedFingerprint?: string}; response: ProjectVersion };
  [MAIN_CHANNELS.PROJECTS_VERSION_RESTORE]: { request: {dir: string; id: string; expectedFingerprint: string}; response: {version: ProjectVersion; checkpoint: ProjectVersion; paths: string[]} };
  [MAIN_CHANNELS.PROJECTS_VERSION_INSPECT]: { request: {dir: string; id: string}; response: ProjectVersionInspection };
  [MAIN_CHANNELS.PROJECTS_VERSION_RESTORE_LAYER]: { request: {dir: string; id: string; file: string; layerId: string; expectedFingerprint: string}; response: {version: ProjectVersion; checkpoint: ProjectVersion; paths: string[]} };
  [MAIN_CHANNELS.PROJECTS_RELOAD]: { request: {dir: string}; response: void };
  [MAIN_CHANNELS.PROJECTS_FLUSH_RESULT]: { request: {id: string; error?: string}; response: void };
  [MAIN_CHANNELS.SPEECH_STATUS]: { request: void; response: SpeechStatus };
  [MAIN_CHANNELS.SPEECH_TRANSCRIBE]: {
    request: { id: string; audio: Uint8Array; language?: string };
    response: SpeechResult;
  };
  [MAIN_CHANNELS.SPEECH_CANCEL]: { request: { id: string }; response: void };
  [MAIN_CHANNELS.INSTAGRAM_GET]: { request: void; response: InstagramDashboard };
  [MAIN_CHANNELS.INSTAGRAM_AUTH_STATUS]: {request:void;response:InstagramAuthStatus};
  [MAIN_CHANNELS.INSTAGRAM_AUTH_START]: {request:void;response:{authorizationUrl:string;expiresAt:string}};
  [MAIN_CHANNELS.INSTAGRAM_AUTH_POLL]: {request:void;response:InstagramAuthPoll};
  [MAIN_CHANNELS.INSTAGRAM_AUTH_CANCEL]: {request:void;response:InstagramAuthStatus};
  [MAIN_CHANNELS.INSTAGRAM_QUEUE_GET]: {request:void;response:InstagramPublishQueue};
  [MAIN_CHANNELS.INSTAGRAM_QUEUE_CREATE]: {request:InstagramPublishDraft;response:InstagramPublishQueue};
  [MAIN_CHANNELS.INSTAGRAM_QUEUE_APPROVE]: {request:{id:string;revision:string};response:InstagramPublishQueue};
  [MAIN_CHANNELS.INSTAGRAM_QUEUE_CANCEL]: {request:{id:string};response:InstagramPublishQueue};
  [MAIN_CHANNELS.INSTAGRAM_QUEUE_REMOVE]: {request:{id:string};response:InstagramPublishQueue};
  [MAIN_CHANNELS.INSTAGRAM_QUEUE_RECONCILE]: {request:{id:string};response:InstagramPublishQueue};
  [MAIN_CHANNELS.INSTAGRAM_CONNECT]: { request: { accessToken: string }; response: InstagramDashboard };
  [MAIN_CHANNELS.INSTAGRAM_SYNC]: { request: void; response: InstagramDashboard };
  [MAIN_CHANNELS.INSTAGRAM_DISCONNECT]: { request: void; response: InstagramDashboard };
  [MAIN_CHANNELS.APP_OPEN_EXTERNAL]: {
    request: { url: string };
    response: void;
  };
  // Where main sends events and as whom: on launch and every auth change.
  [MAIN_CHANNELS.ANALYTICS_CONFIGURE]: {
    request: { apiUrl: string; token: string | null };
    response: void;
  };
  [MAIN_CHANNELS.AUTH_GET_PENDING_CALLBACK]: {
    request: void;
    response: string | null;
  };
  [MAIN_CHANNELS.CHECKOUT_GET_PENDING_CALLBACK]: {
    request: void;
    response: string | null;
  };
  [MAIN_CHANNELS.WINDOW_IS_FULLSCREEN]: { request: void; response: boolean };
  [MAIN_CHANNELS.WINDOW_SET_COLOR_MODE]: { request: { mode: "light" | "dark" }; response: void };
  [MAIN_CHANNELS.WINDOW_CAPTURE]: { request: void; response: ScreenshotResult };
  [MAIN_CHANNELS.WINDOW_SET_BUSY]: { request: { busy: boolean }; response: void };
  [MAIN_CHANNELS.WINDOW_SHOW]: { request: void; response: void };
  [MAIN_CHANNELS.CLIPBOARD_PATHS]: { request: void; response: string[] };
  [MAIN_CHANNELS.FILE_TRANSFER]: {
    request: { selector: string; absolutePath: string };
    response: void;
  };
  [MAIN_CHANNELS.EXPORT_PICK_SAVE]: {
    request: { suggestedName: string; format: "mp4" | "webm" | "ogg" | "mov" };
    response: string | null;
  };
  [MAIN_CHANNELS.FILE_WRITE_OPEN]: {
    request: { path: string; exclusive?: boolean; finalization?: ExportFinalization };
    response: { id: string };
  };
  [MAIN_CHANNELS.FILE_WRITE_CHUNK]: {
    request: { id: string; data: Uint8Array; position: number };
    response: void;
  };
  [MAIN_CHANNELS.FILE_WRITE_CLOSE]: {
    request: { id: string };
    response: void;
  };
  [MAIN_CHANNELS.FILE_WRITE_ABORT]: {
    request: { id: string };
    response: void;
  };
  // Reveals a file or folder in the OS file manager (Finder on macOS).
  [MAIN_CHANNELS.APP_SHOW_IN_FOLDER]: {
    request: { path: string };
    response: void;
  };
  // The code editors installed here that a folder can be opened in.
  [MAIN_CHANNELS.APP_EDITORS_LIST]: {
    request: void;
    response: EditorInfo[];
  };
  [MAIN_CHANNELS.APP_OPEN_IN_EDITOR]: {
    request: { id: EditorId; dir: string };
    response: void;
  };
  [MAIN_CHANNELS.LOGS_GET]: { request: void; response: LogEntry[] };
  [MAIN_CHANNELS.PROJECTS_PICK_FOLDER]: {
    request: void;
    response: string | null;
  };
  [MAIN_CHANNELS.PROJECTS_GET]: {
    request: { dir: string };
    response: ProjectInfo | null;
  };
  [MAIN_CHANNELS.PROJECTS_INIT]: {
    request: { dir: string };
    response: ProjectInfo;
  };
  [MAIN_CHANNELS.PROJECTS_RESOLVE]: {
    request: { dir: string };
    response: ProjectInfo | null;
  };
  // The project `id` in a folder beside `dir`, which no longer holds it (a
  // folder renamed or moved in Finder); null when none does.
  [MAIN_CHANNELS.PROJECTS_FIND_MOVED]: {
    request: { dir: string; id: string };
    response: ProjectInfo | null;
  };
  // Asks what to do about a project whose folder can't be found.
  [MAIN_CHANNELS.PROJECTS_ASK_MISSING]: {
    request: { displayName: string; dir: string };
    response: MissingProjectChoice;
  };
  // A new project, as a draft called "Untitled" until it is saved.
  [MAIN_CHANNELS.PROJECTS_CREATE]: {
    request: void;
    response: ProjectInfo;
  };
  // Where to save a draft, or move a saved project; `name` fills the picker.
  [MAIN_CHANNELS.PROJECTS_PICK_SAVE]: {
    request: { dir: string; name: string; startIn: string | null; action: SaveAction };
    response: string | null;
  };
  [MAIN_CHANNELS.PROJECTS_SAVE]: {
    request: { dir: string; target: string };
    response: ProjectInfo;
  };
  [MAIN_CHANNELS.PROJECTS_MOVE]: {
    request: { dir: string; target: string };
    response: ProjectInfo;
  };
  [MAIN_CHANNELS.PROJECTS_RENAME]: {
    request: { dir: string; displayName: string };
    response: ProjectInfo;
  };
  [MAIN_CHANNELS.PROJECTS_DUPLICATE]: {
    request: { dir: string };
    response: ProjectInfo;
  };
  [MAIN_CHANNELS.PROJECTS_DELETE]: { request: { dir: string }; response: void };
  [MAIN_CHANNELS.PROJECTS_COMPILE]: {
    request: { dir: string };
    response: CompileResult;
  };
  [MAIN_CHANNELS.PROJECTS_WRITE]: {
    request: { dir: string; edits: SourceEdit[]; operationId?: string };
    response: WriteResult;
  };
  [MAIN_CHANNELS.PROJECTS_WATCH]: { request: { dir: string }; response: void };
  [MAIN_CHANNELS.PROJECTS_UNWATCH]: {
    request: { dir: string };
    response: void;
  };
  // The asset manifest (`assets.yml`) as plain data; null when there is none.
  [MAIN_CHANNELS.PROJECTS_MANIFEST_READ]: {
    request: { dir: string };
    response: unknown;
  };
  [MAIN_CHANNELS.PROJECTS_MANIFEST_WRITE]: {
    request: { dir: string; manifest: unknown };
    response: void;
  };
  // The project's config: the `diffusion` field of its package.json, as
  // parsed (null when absent). The renderer owns its shape; see
  // `engine/project-config` in the web app.
  [MAIN_CHANNELS.PROJECTS_CONFIG_READ]: {
    request: { dir: string };
    response: unknown;
  };
  [MAIN_CHANNELS.PROJECTS_CONFIG_WRITE]: {
    request: { dir: string; config: unknown };
    response: void;
  };
  // Project file system, for the asset library. `source` is project-relative
  // or absolute; `path` is always project-relative. Writes stream through the
  // FILE_WRITE_* channels (which create parent directories).
  [MAIN_CHANNELS.PROJECTS_FS_LIST]: {
    request: { dir: string; source: string };
    response: FsEntry[];
  };
  [MAIN_CHANNELS.PROJECTS_FS_STAT]: {
    request: { dir: string; source: string };
    response: FsStat | null;
  };
  [MAIN_CHANNELS.PROJECTS_FS_REMOVE]: {
    request: { dir: string; path: string };
    response: void;
  };
  [MAIN_CHANNELS.PROJECTS_FS_REAL_PATH]: {
    request: { dir: string; source: string };
    response: string | null;
  };
  // Where the agent chat host listens (`ws://127.0.0.1:PORT/?token=…`); null
  // while it is starting or restarting. The only desktop IPC the chat uses.
  [MAIN_CHANNELS.AGENT_CHAT_ENDPOINT]: {
    request: void;
    response: { url: string } | null;
  };
  // The app's MCP server in the agents' configs (see mcp-install.ts), and
  // the `cutroom` command on PATH (see cli-install.ts). Protected macOS
  // system directories may require an admin prompt to install/uninstall.
  [MAIN_CHANNELS.MCP_STATUS]: { request: void; response: McpStatus };
  [MAIN_CHANNELS.MCP_APPLY]: { request: McpApplyRequest; response: McpApplyResult };
  [MAIN_CHANNELS.CLI_STATUS]: { request: void; response: CliStatus };
  [MAIN_CHANNELS.CLI_INSTALL]: { request: void; response: CliInstallResult };
  [MAIN_CHANNELS.CLI_UNINSTALL]: { request: void; response: CliUninstallResult };
};

export type FsEntry = {
  name: string;
  kind: "file" | "directory";
  size: number;
  mtime: number;
  /** Set when the entry is a symlink; `kind` is what it points at. */
  link?: boolean;
};
export type FsStat = { size: number; mtime: number };
export type MainRequestChannel = keyof MainRequestMap;

export type MainEventMap = {
  [MAIN_CHANNELS.EDITOR_HISTORY]: { direction: 'undo' | 'redo' };
  [MAIN_CHANNELS.PROJECTS_FLUSH_REQUEST]: {id: string};
  [MAIN_CHANNELS.SPEECH_PROGRESS]: SpeechProgress;
  [MAIN_CHANNELS.REFRAME_PROGRESS]: ReframeAnalysisProgress;
  [MAIN_CHANNELS.SPEAKER_PROGRESS]: SpeakerAnalysisProgress;
  [MAIN_CHANNELS.VISUAL_PROGRESS]: VisualProgress;
  [MAIN_CHANNELS.REFERENCE_PROGRESS]: ReferenceProgress;
  [MAIN_CHANNELS.PLAYBACK_PROXY_PROGRESS]: PlaybackProxyProgress;
  [MAIN_CHANNELS.AUTH_CALLBACK]: { url: string };
  [MAIN_CHANNELS.CHECKOUT_CALLBACK]: { url: string };
  [MAIN_CHANNELS.WINDOW_FULLSCREEN_CHANGE]: { fullscreen: boolean };
  // A file inside a watched project folder changed (path relative to `dir`).
  [MAIN_CHANNELS.PROJECTS_CHANGED]: { dir: string; path: string };
};
export type MainEventChannel = keyof MainEventMap;

export type MainRequest = {
  id: string;
  channel: MainRequestChannel;
  data: unknown;
};

export type MainEvent = {
  channel: MainEventChannel;
  data: unknown;
};

export type MainReply =
  | { id: string; ok: true; data: unknown }
  | { id: string; ok: false; error: string };
