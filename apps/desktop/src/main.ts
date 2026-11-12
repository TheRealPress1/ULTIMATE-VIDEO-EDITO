/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { app, autoUpdater, BrowserWindow, dialog, nativeImage, safeStorage, session, shell } from "electron";
import { basename, dirname, join } from "node:path";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseReleaseConfig, ReleaseUpdates } from './updates';
import { collectProject, relinkProjectMedia } from './project-portability';
import { withProjectLock, recoverProjectWrites } from './project-write-transactions';
import { listProjectVersions, createProjectVersion, restoreProjectVersion, projectVersionFingerprint, recoverProjectVersionRestore, inspectProjectVersion, restoreProjectVersionLayer } from './project-versions';
import { AtomicFileWrites } from './file-writes';
import { writeFileAtomic } from './atomic';
import { resolveLaunchProfile } from './launch-profile';
import { finalizePcmExport } from './export-finalization';
import { resolveAudioToolsDir, resolveAudioToolsPath } from './audio-tools';
import { LocalAudioFinishingService } from './audio-finishing';
import { registerInterviewAnalysis } from './interview-analysis-ipc';
import { registerVideoWorkflows } from './video-workflows-ipc';
import { LocalVisualIndexService } from './visual-index';
import { DapiServer } from "./dapi/server";
import { pinProject } from "./dapi/output-policy";
import { instructions } from "./dapi/docs";
import { EditingStyleStore } from "./editing-style";
import { agentMemoryStore, memoryDisabled, unavailableMemorySnapshot } from "./agent-memory";
import { AudioCatalogStore } from "./audio-catalog";
import { readEditingSkills } from "./editing-skills";
import { DapiError, toolByName } from "@diffusionstudio/dapi";
import { agentChatEndpoint, configureAgentChat, deleteProjectChats, stopAgentChat } from "./agent-chat";
import { cliStatus, installCli, uninstallCli } from "./cli-install";
import { applyMcp, mcpStatus } from "./mcp-install";
import { configureAnalytics, countCanvasEdits, track } from "./analytics";
import { setupAppMenu } from "./menu";
import { clipboardPaths } from "./clipboard";
import { installedEditors, openInEditor } from "./editors";
import { AppTray } from "./tray";
import { SaveGate } from './save-gate';
import { WindowHost } from "./window-host";
import { handleSquirrelEvent } from "./squirrel";
import { mainBridge } from "./main-manager";
import { MAIN_CHANNELS } from "./main-channels";
import { instagramService } from "./instagram";
import { InstagramAuthService } from './instagram-auth';
import { InstagramPublishingService } from './instagram-publishing';
import { LocalSpeechService } from "./speech";
import { LocalReframeService } from "./reframe-analysis";
import { configureWebMediaService } from "./web-media";
import { configureEarshot } from "./addons/earshot";
import { registerEarshotIpc } from "./addons/earshot/ipc";
import { configureGemini } from "./gemini";
import { registerGeminiIpc } from "./gemini/ipc";
import { configureMediaSearch } from "./media-search";
import { configureMediaDownloads, findInstagramMedia, mediaTools } from "./media-download";
import { configureYtDlp, ytDlp } from "./downloader";
import {
  compileProject,
  createProject,
  deleteProject,
  duplicateProject,
  getProject,
  askAboutMissingProject,
  findMovedProject,
  initProject,
  pickFolder,
  pickSaveLocation,
  renameProject,
  resolveProject,
  saveProject,
  moveProject,
  unwatchAll,
  listEntries,
  realPathEntry,
  noteContent,
  noteRenamed,
  readConfig,
  readManifest,
  removeEntry,
  startWrite,
  statEntry,
  unwatchProject,
  watchProject,
  writeConfig,
  writeManifest,
  writeProject,
} from "./projects";
import type { DeepLinkChannel } from "./main-channels";
import type { LogEntry } from "@diffusionstudio/dapi";

const DEV_URL = "http://localhost:5173";
const WINDOW_IDLE_MS = 10 * 60 * 1000;
const AUTH_PROTOCOL = "cutroom";
const MACOS_CORNER_RADIUS = 18;
const MACOS_BACKDROP = { blur: 80, red: 0.07, green: 0.07, blue: 0.07, alpha: 0.9 };
// Window Controls Overlay on Windows: as tall as the renderer's `h-10` drag
// strip, coloured like the sidebar it sits on (`--sidebar`), with symbols in
// `--muted-foreground` like the other title bar icons. The dark value is that
// token flattened onto the sidebar, since the overlay takes opaque colours.
const WINDOWS_OVERLAY_HEIGHT = 40;
const WINDOWS_OVERLAY_COLORS = {
  dark: { color: "#121212", symbolColor: "#a1a1a1" },
  light: { color: "#f7f7f7", symbolColor: "#737373" },
};

// A Squirrel.Windows install/update/uninstall launch: housekeeping only, the
// app quits on its own. Decided first so nothing below starts a service or
// checks for updates on a launch that is about to end.
const launchProfile = resolveLaunchProfile(
  join(app.getPath('appData'), 'Cutroom'),
  app.commandLine.hasSwitch('user-data-dir') ? app.commandLine.getSwitchValue('user-data-dir') : undefined,
);
const squirrelLaunch = !launchProfile.isolated && handleSquirrelEvent();

// The app's internal name, from before it was renamed Blackout. Electron names the Keychain item that
// protects stored secrets (Instagram, Gemini) after it, so changing it would lock the app out of them.
// What people read is PRODUCT_NAME.
app.setName("Cutroom");
mkdirSync(launchProfile.directory, { recursive: true });
app.setPath('userData', launchProfile.directory);
if (launchProfile.isolated) {
  app.setPath('sessionData', launchProfile.directory);
  app.setAppLogsPath(join(launchProfile.directory, 'logs'));
  mkdirSync(join(launchProfile.directory, 'crashes'), { recursive: true });
  app.setPath('crashDumps', join(launchProfile.directory, 'crashes'));
}
app.commandLine.appendSwitch("enable-blink-features", "CanvasDrawElement");
app.commandLine.appendSwitch("enable-features", "SharedArrayBuffer");
app.commandLine.appendSwitch("disable-background-timer-throttling");
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");

let setNativeCornerRadius: ((handle: Buffer, radius: number) => void) | null = null;
let setNativeBackdrop:
  | ((handle: Buffer, blur: number, r: number, g: number, b: number, a: number) => void)
  | null = null;

if (process.platform === "darwin") {
  ({ setCornerRadius: setNativeCornerRadius, setBackdrop: setNativeBackdrop } = require(
    join(app.getAppPath(), "dist", "corner_radius.node"),
  ));
}

function applyCornerRadius(radius: number) {
  if (!setNativeCornerRadius || !mainWindow || mainWindow.isDestroyed()) return;
  setNativeCornerRadius(mainWindow.getNativeWindowHandle(), radius);
}

function applyBackdrop() {
  if (!setNativeBackdrop || !mainWindow || mainWindow.isDestroyed()) return;
  const { blur, red, green, blue, alpha } = MACOS_BACKDROP;
  setNativeBackdrop(mainWindow.getNativeWindowHandle(), blur, red, green, blue, alpha);
}

function setColorMode(mode: "dark" | "light") {
  if (process.platform === "darwin" || !mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.setTitleBarOverlay({ ...WINDOWS_OVERLAY_COLORS[mode], height: WINDOWS_OVERLAY_HEIGHT });
}

// Updates are configured by Cutroom releases; never contact the upstream updater.
let rendererBusy = false;
const openWrites = new AtomicFileWrites({ noteContent, beforeRename: noteRenamed,
  finalize:(temp,config,signal)=>finalizePcmExport(resolveAudioToolsPath(app.getAppPath()),temp,config,signal) });
let updatesPromise:Promise<ReleaseUpdates>|undefined;
function releaseUpdates():Promise<ReleaseUpdates>{
  return updatesPromise??=(async()=>{
    await app.whenReady();
    let config=parseReleaseConfig(null);
    try{config=parseReleaseConfig(JSON.parse(readFileSync(join(app.getAppPath(),'dist','release-config.json'),'utf8')));}catch{/* Unconfigured builds never contact an update server. */}
    const updates=new ReleaseUpdates({updater:autoUpdater,config,version:app.getVersion(),platform:process.platform,arch:process.arch,verifySignature:async()=>{
      if(!app.isPackaged||process.platform!=='darwin')return false;
      const bundle=join(app.getAppPath(),'..','..','..');
      try{await promisify(execFile)('/usr/bin/codesign',['--verify','--deep','--strict',bundle],{timeout:30000});
        const result=await promisify(execFile)('/usr/bin/codesign',['-d','--verbose=2',bundle],{timeout:10000});
        return result.stderr.includes(`TeamIdentifier=${config.teamId}`)&&result.stderr.includes('Authority=Developer ID Application:');
      }catch{return false;}
    }});await updates.initialize();return updates;
  })();
}

let mainWindow: BrowserWindow | null = null;
let lastProject: string | null = null;
// Where lastProject really was when it was opened. Tools write in the project
// freely, so they get this pinned path, never a fresh resolution of a folder
// an agent's shell could since have swapped for a link (see output-policy).
let lastProjectRoot: string | null = null;

const saveGate = new SaveGate();
async function flushRenderer(window: BrowserWindow): Promise<void> {
  if (window.isDestroyed() || window.webContents.isDestroyed() || window.webContents.isCrashed()) return;
  await saveGate.request(window.webContents.id, (id) => mainBridge.emit(window, MAIN_CHANNELS.PROJECTS_FLUSH_REQUEST, { id }));
}
const windows = new WindowHost({
  beforeDestroy: flushRenderer,
  create: createWindow,
  idleMs: WINDOW_IDLE_MS,
  onChange: () => {
    tray.refresh();
  },
});

const tray = new AppTray({
  visible: () => windows.visible(),
  active: () => windows.active(),
  project: () => lastProject,
  show: () => void windows.show(),
  hide: () => windows.hide(),
});

// Deep links that arrived before the renderer could take them, keyed by the
// channel they belong to so auth and checkout never drain each other's link.
const pendingDeepLinks = new Map<DeepLinkChannel, string>();

// Renderer console mirror, served to the CLI via LOGS_GET. Lives in main so
// it survives reloads and captures everything the devtools console shows
// (page logs, worker logs, uncaught errors) without touching the web bundle.
const LOG_BUFFER_MAX = 2000;
const logBuffer: LogEntry[] = [];

// The docs the MCP instructions point agents at: staged into the bundle by
// scripts/stage-docs.mjs (Contents/Resources/docs) when packaged; the repo's
// own `docs/` in development, so edits show up without a staging step. Null
// when neither exists.
function docsDir(): string | null {
  const dir = app.isPackaged ? join(process.resourcesPath, "docs") : join(app.getAppPath(), "..", "..", "docs");
  return existsSync(dir) ? dir : null;
}

// Web media search (a main tool) and downloads (over IPC, for the renderer
// tool) share one service, so a download keeps a search result's provenance.
// A file Cutroom's audio catalog ships is credited with the catalog's checked rights (the store is created below, before any download runs).
const webMedia = configureWebMediaService({ version: app.getVersion(), noteContent, startWrite, catalogCredit: (url) => audioCatalog.credit(url) });

// The managed yt-dlp behind media_search and media_download (see ./downloader):
// installed into this profile's userData on first use, never into the signed
// app, its JavaScript runtime this binary in Node mode.
const downloader = configureYtDlp({
  root: join(app.getPath("userData"), "tools", "yt-dlp"),
  ffmpegDir: resolveAudioToolsDir(app.getAppPath()),
  appExecPath: process.execPath,
  version: app.getVersion(),
});

// Audio intelligence (earshot): installed into this profile's userData on the
// first sound tool call (or Settings' Install now), its worker warm while used.
const earshotAddon = configureEarshot({ userData: app.getPath("userData"), version: app.getVersion(), noteContent, startWrite });

// Platform media: media_search (a main tool) and media_download (over IPC, for
// the renderer tool) run the managed downloader once it is configured, probe
// with the bundled FFmpeg, and read MyInstants pages with the browser's
// network stack. A web_media_search result handed to media_download is sent
// back to web_media_download, which keeps its license.
const managedDownloader = () => { try { return ytDlp(); } catch { return null; } };
const mediaPageFetch = (url: string, init: { signal: AbortSignal; headers: Record<string, string>; redirect: "manual" }) => session.defaultSession.fetch(url, init);
configureMediaSearch({ downloader: managedDownloader, pageFetch: mediaPageFetch, version: app.getVersion() });
const mediaFfmpeg = resolveAudioToolsPath(app.getAppPath());
const mediaFfprobe = join(dirname(mediaFfmpeg), process.platform === "win32" ? "ffprobe.exe" : "ffprobe");
const mediaDownloads = configureMediaDownloads({
  downloader: managedDownloader,
  ...mediaTools({ ffmpeg: existsSync(mediaFfmpeg) ? mediaFfmpeg : null, ffprobe: existsSync(mediaFfprobe) ? mediaFfprobe : null }),
  pageFetch: mediaPageFetch,
  noteContent,
  startWrite,
  isWebResult: (url) => webMedia.recall(url) !== undefined,
  instagramMedia: async (url) => findInstagramMedia(await instagramService().snapshot(), url),
  instagramFresh: (url, signal) => instagramService().freshPost(url, signal),
  version: app.getVersion(),
});

// Gemini (optional): the user's own Google AI Studio key, encrypted by the OS
// keychain in userData/services. ask_gemini sends media to Google only once a
// key is saved, and Settings is the only place that saves one.
const geminiConnection = configureGemini({
  userData: app.getPath("userData"),
  secureStorage: safeStorage,
  ffmpeg: existsSync(mediaFfmpeg) ? mediaFfmpeg : null,
  ffprobe: existsSync(mediaFfprobe) ? mediaFfprobe : null,
});

// The MCP server agents and the Cutroom CLI talk to. Started once the app is
// ready; renderer tools create the window when there is none.
const editingStyle = new EditingStyleStore(join(app.getPath("userData"), "editing-style.json"));
// Cutroom's music and effect catalog under the user's personal layer (userData/audio-catalog, which only the app writes).
const audioCatalog = new AudioCatalogStore({ docsDir: docsDir(), personalDir: join(app.getPath("userData"), "audio-catalog") });
// What agents remember (memory) and the user's own skills, in this profile's
// userData, written only by their tools and Settings. CUTROOM_MEMORY=0 turns
// both off for the session.
const memoryOff = memoryDisabled();
const agentMemoryFile = join(app.getPath("userData"), "agent-memory", "memory.json");
const agentSkillsDir = join(app.getPath("userData"), "agent-skills");
const dapi = new DapiServer({
  port: launchProfile.isolated ? 0 : undefined,
  editingStyle,
  audioCatalog,
  ...(memoryOff ? {} : { agentMemoryFile, agentSkillsDir }),
  version: app.getVersion(),
  logs: () => logBuffer,
  docsDir: docsDir(),
  window: {
    visible: () => windows.visible(),
    show: () => windows.show(),
    hide: () => windows.hide(),
    acquire: () => windows.acquire(),
    hold: () => windows.hold(),
    lastProject: () => lastProject,
    projectRoot: () => lastProjectRoot,
  },
  onToolCall: (props) => track("tool_called", props),
});

function pushLog(level: LogEntry["level"], message: string, source: string) {
  logBuffer.push({ ts: Date.now(), level, message, source });
  if (logBuffer.length > LOG_BUFFER_MAX) logBuffer.shift();
}

function captureConsole(window: BrowserWindow) {
  window.webContents.on("console-message", ({ level, message, lineNumber, sourceId }) => {
    pushLog(level, message, sourceId ? `${sourceId}:${lineNumber}` : "");
  });
  window.webContents.on("preload-error", (_event, path, error) => {
    pushLog("error", `Preload error: ${error.message}`, path);
  });
  window.webContents.on("render-process-gone", (_event, details) => {
    pushLog("error", `Renderer process gone: ${details.reason} (exit code ${details.exitCode})`, "");
    if (details.reason !== 'clean-exit') {
      rendererBusy = false;
      windows.setBusy(false);
      const cleanup = openWrites.abortAll();
      void dialog.showMessageBox(window, { type: 'error', title: 'Recover editor', message: 'The editor stopped unexpectedly.', detail: 'Reload to recover pending edits and reopen your project.', buttons: ['Reload editor', 'Later'], defaultId: 0, cancelId: 1 }).then(async ({ response }) => {
        await cleanup;
        if (response === 0 && !window.isDestroyed()) window.webContents.reload();
      }).catch((error) => pushLog('error', `Renderer recovery failed: ${String(error)}`, ''));
    }
  });
}

function findProtocolUrl(argv: string[]): string | null {
  return argv.find((arg) => arg.startsWith(`${AUTH_PROTOCOL}://`)) ?? null;
}

function isHiddenLaunch(argv: string[]): boolean {
  return argv.includes("--hidden");
}

// cutroom://auth/callback → auth, cutroom://checkout/callback → checkout.
function deepLinkChannel(url: string): DeepLinkChannel | null {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return null;
  }

  if (host === "auth") return MAIN_CHANNELS.AUTH_CALLBACK;
  if (host === "checkout") return MAIN_CHANNELS.CHECKOUT_CALLBACK;
  return null;
}

function deliverDeepLink(url: string) {
  const channel = deepLinkChannel(url);
  if (!channel) return;

  // A link that arrives before the page can receive it is parked rather than
  // pushed: the renderer's subscription only exists once the component holding
  // it mounts, which is well after did-finish-load. Parked links are handed
  // over by the take* handlers below, which every consumer calls on mount.
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isLoading()) {
    pendingDeepLinks.set(channel, url);
    return;
  }

  mainBridge.emit(mainWindow, channel, { url });
}

function takePendingDeepLink(channel: DeepLinkChannel): string | null {
  const url = pendingDeepLinks.get(channel) ?? null;
  pendingDeepLinks.delete(channel);
  return url;
}

async function setFileInputFiles(selector: string, absolutePath: string) {
  if (!mainWindow) throw new Error("No main window");
  const wc = mainWindow.webContents;
  // Stay attached between calls — attach/detach dominates the cost of a
  // transfer, and file materialization happens in bursts.
  if (!wc.debugger.isAttached()) wc.debugger.attach("1.3");
  const { root } = await wc.debugger.sendCommand("DOM.getDocument");
  const { nodeId } = await wc.debugger.sendCommand("DOM.querySelector", {
    nodeId: root.nodeId,
    selector,
  });
  if (!nodeId) throw new Error(`Selector not found: ${selector}`);
  await wc.debugger.sendCommand("DOM.setFileInputFiles", {
    files: [absolutePath],
    nodeId,
  });
}

// The main window, not shown: WindowHost decides when it is.
function createWindow(): BrowserWindow {

  const options: Electron.BrowserWindowConstructorOptions = {
    show: false,
    width: 1200,
    height: 800,
    webPreferences: {
      preload: join(app.getAppPath(), "dist", "preload.js"),
      backgroundThrottling: false,
    },
  }

  if (process.platform === "darwin") {
    options.titleBarStyle = "hiddenInset" as const;
    options.trafficLightPosition = { x: 14, y: 14 };
    options.vibrancy = "sidebar" as const;
    options.backgroundColor = "#00000000";
  }

  if (process.platform === "win32") {
    options.titleBarStyle = "hidden" as const;
    options.titleBarOverlay = { ...WINDOWS_OVERLAY_COLORS.dark, height: WINDOWS_OVERLAY_HEIGHT };
    options.autoHideMenuBar = true;
    options.backgroundColor = WINDOWS_OVERLAY_COLORS.dark.color;

    if (!app.isPackaged) {
      options.icon = join(app.getAppPath(), "assets", "icon-dev.png");
    }
  }

  mainWindow = new BrowserWindow(options);

  captureConsole(mainWindow);

  applyCornerRadius(MACOS_CORNER_RADIUS);
  applyBackdrop();

  mainWindow.once("ready-to-show", () => {
    applyCornerRadius(MACOS_CORNER_RADIUS);
    applyBackdrop();
  });

  mainWindow.on("show", () => {
    applyCornerRadius(MACOS_CORNER_RADIUS);
    applyBackdrop();
  });

  mainWindow.on("enter-full-screen", () => {
    applyCornerRadius(0);
    mainBridge.emit(mainWindow, MAIN_CHANNELS.WINDOW_FULLSCREEN_CHANGE, { fullscreen: true });
  });
  mainWindow.on("leave-full-screen", () => {
    applyCornerRadius(MACOS_CORNER_RADIUS);
    mainBridge.emit(mainWindow, MAIN_CHANNELS.WINDOW_FULLSCREEN_CHANGE, { fullscreen: false });
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
    unwatchAll();
  });

  if (!app.isPackaged) {
    mainWindow.loadURL(DEV_URL);
  } else {
    mainWindow.loadFile(join(app.getAppPath(), "web", "index.html"));
  }

  return mainWindow;
}

if (!launchProfile.isolated) {
  if (process.defaultApp && process.argv.length >= 2) {
    app.setAsDefaultProtocolClient(AUTH_PROTOCOL, process.execPath, [
      join(process.cwd(), process.argv[1]!),
    ]);
  } else {
    app.setAsDefaultProtocolClient(AUTH_PROTOCOL);
  }
}

if (squirrelLaunch) {
  // Update.exe is at work; handleSquirrelEvent quits the app when it is done.
} else if (app.requestSingleInstanceLock()) {
  if (isHiddenLaunch(process.argv)) {
    app.dock?.hide();
  }

  app.on("second-instance", (_event, argv) => {
    const url = findProtocolUrl(argv);
    if (url && !launchProfile.isolated) {
      deliverDeepLink(url);
    }
    if (!isHiddenLaunch(argv)) {
      windows.show();
    }
  });

  app.on("open-url", (event, url) => {
    event.preventDefault();
    if (launchProfile.isolated) return;
    deliverDeepLink(url);
    windows.show();
  });

  mainBridge.handle(MAIN_CHANNELS.APP_OPEN_EXTERNAL, ({ url }) => shell.openExternal(url));
  mainBridge.handle(MAIN_CHANNELS.UPDATES_STATUS,async()=> (await releaseUpdates()).snapshot());
  mainBridge.handle(MAIN_CHANNELS.UPDATES_CHECK,async()=> (await releaseUpdates()).check());
  mainBridge.handle(MAIN_CHANNELS.UPDATES_INSTALL,async()=> (await releaseUpdates()).install(async()=>{
    if(rendererBusy||openWrites.size)throw new Error('Finish or cancel the active export before installing the update.');
    const window=windows.current();if(window)await flushRenderer(window);
    if(rendererBusy||openWrites.size)throw new Error('A file write started while saving. Finish it before restarting.');
  }));
  mainBridge.handle(MAIN_CHANNELS.DOWNLOADER_STATUS, () => downloader.details());
  mainBridge.handle(MAIN_CHANNELS.DOWNLOADER_CHECK, async () => { await downloader.checkNow(); return downloader.details(); });
  mainBridge.handle(MAIN_CHANNELS.DOWNLOADER_REINSTALL, async () => { await downloader.reinstall(); return downloader.details(); });
  app.on("will-quit", () => downloader.dispose());
  mainBridge.handle(MAIN_CHANNELS.APP_SHOW_IN_FOLDER, ({ path }) => shell.showItemInFolder(path));
  mainBridge.handle(MAIN_CHANNELS.APP_EDITORS_LIST, () => installedEditors());
  mainBridge.handle(MAIN_CHANNELS.APP_OPEN_IN_EDITOR, ({ id, dir }) => openInEditor(id, dir));
  mainBridge.handle(MAIN_CHANNELS.ANALYTICS_CONFIGURE, (config) => configureAnalytics(config));
  mainBridge.handle(MAIN_CHANNELS.INSTAGRAM_GET, () => instagramService().snapshot());
  let brokerUrl=process.env.UVE_INSTAGRAM_AUTH_URL;
  if(!brokerUrl)try{const value=JSON.parse(readFileSync(join(app.getAppPath(),'dist','release-config.json'),'utf8'));if(typeof value.instagramAuthUrl==='string')brokerUrl=value.instagramAuthUrl;}catch{/* Browser login is optional until a broker is deployed. */}
  const authOptions={connect:async(token:string)=>{await publishing.pauseApproved();return instagramService().connect(token);}};
  let instagramAuth:InstagramAuthService;
  try{instagramAuth=new InstagramAuthService({...authOptions,brokerUrl});}catch{instagramAuth=new InstagramAuthService(authOptions);}
  const publishing=new InstagramPublishingService({storageDirectory:join(app.getPath('userData'),'instagram'),request:(accountId,operation)=>instagramService().publishingRequest(accountId,operation)});
  publishing.start();app.on('will-quit',()=>{publishing.dispose();void instagramAuth.cancel().catch(()=>{});});
  mainBridge.handle(MAIN_CHANNELS.INSTAGRAM_AUTH_STATUS,()=>instagramAuth.status());
  mainBridge.handle(MAIN_CHANNELS.INSTAGRAM_AUTH_START,()=>instagramAuth.start());
  mainBridge.handle(MAIN_CHANNELS.INSTAGRAM_AUTH_POLL,()=>instagramAuth.poll());
  mainBridge.handle(MAIN_CHANNELS.INSTAGRAM_AUTH_CANCEL,()=>instagramAuth.cancel());
  mainBridge.handle(MAIN_CHANNELS.INSTAGRAM_QUEUE_GET,()=>publishing.snapshot());
  mainBridge.handle(MAIN_CHANNELS.INSTAGRAM_QUEUE_CREATE,request=>publishing.create(request));
  mainBridge.handle(MAIN_CHANNELS.INSTAGRAM_QUEUE_APPROVE,({id,revision})=>publishing.approve(id,revision));
  mainBridge.handle(MAIN_CHANNELS.INSTAGRAM_QUEUE_CANCEL,({id})=>publishing.cancel(id));
  mainBridge.handle(MAIN_CHANNELS.INSTAGRAM_QUEUE_REMOVE,({id})=>publishing.remove(id));
  mainBridge.handle(MAIN_CHANNELS.INSTAGRAM_QUEUE_RECONCILE,({id})=>publishing.reconcile(id));
  mainBridge.handle(MAIN_CHANNELS.EDITING_SKILLS, (args) => readEditingSkills(docsDir(), toolByName("skills").input.parse(args), { userSkillsDir: memoryOff ? null : agentSkillsDir }));
  mainBridge.handle(MAIN_CHANNELS.EDITING_STYLE_GET, () => editingStyle.get());
  mainBridge.handle(MAIN_CHANNELS.EDITING_STYLE_SET, ({ notes, expectedRevision }) => editingStyle.set(notes, expectedRevision));
  mainBridge.handle(MAIN_CHANNELS.MEMORY_GET, async () => memoryOff ? unavailableMemorySnapshot() : agentMemoryStore(agentMemoryFile).snapshot());
  mainBridge.handle(MAIN_CHANNELS.MEMORY_APPLY, async (request) => {
    if (memoryOff) throw new Error("Agent memory is turned off for this session (CUTROOM_MEMORY=0).");
    return agentMemoryStore(agentMemoryFile).apply(request);
  });
  registerVideoWorkflows();
  registerInterviewAnalysis();
  const visual = new LocalVisualIndexService({runtimePath:join(app.getAppPath(),'dist','visual-vision')});
  const visualOwners = new Map<string,{owner:number;cancel:()=>void}>();
  mainBridge.handle(MAIN_CHANNELS.VISUAL_GET,async(request)=>{
    const source=await realPathEntry(request.dir,request.source);
    if(!source)throw new Error('Visual search needs local footage. Relink this source first.');
    return visual.get({...request,source});
  });
  mainBridge.handle(MAIN_CHANNELS.VISUAL_INDEX,async(request,event)=>{
    if(visualOwners.has(request.id))throw new Error('This visual index job is already running.');
    const sender=event.sender,window=BrowserWindow.fromWebContents(sender);let canceled=false;
    const cancel=()=>{canceled=true;visual.cancel(request.id);};
    visualOwners.set(request.id,{owner:sender.id,cancel});
    sender.once('destroyed',cancel);sender.once('render-process-gone',cancel);sender.once('did-start-loading',cancel);
    try {const source=await realPathEntry(request.dir,request.source);if(canceled)throw new Error('Visual indexing canceled.');
      if(!source)throw new Error('Visual search needs local footage. Relink this source first.');
      return await visual.index({...request,source},progress=>{if(!sender.isDestroyed())mainBridge.emit(window,MAIN_CHANNELS.VISUAL_PROGRESS,progress);});
    }finally{visualOwners.delete(request.id);sender.removeListener('destroyed',cancel);sender.removeListener('render-process-gone',cancel);sender.removeListener('did-start-loading',cancel);}
  });
  mainBridge.handle(MAIN_CHANNELS.VISUAL_CANCEL,({id},event)=>{const work=visualOwners.get(id);if(work?.owner===event.sender.id)work.cancel();});
  const audioFinishing=new LocalAudioFinishingService({runtimePath:resolveAudioToolsPath(app.getAppPath())});
  const audioOwners=new Map<string,{owner:number;cancel:()=>void}>();
  mainBridge.handle(MAIN_CHANNELS.AUDIO_FINISH_RUN,async(request,event)=>{
    if(audioOwners.has(request.id))throw new Error('This audio job is already running.');
    const sender=event.sender,cancel=()=>audioFinishing.cancel(request.id);
    audioOwners.set(request.id,{owner:sender.id,cancel});sender.once('destroyed',cancel);sender.once('render-process-gone',cancel);sender.once('did-start-loading',cancel);
    try{return await audioFinishing.run(request);}
    finally{audioOwners.delete(request.id);sender.removeListener('destroyed',cancel);sender.removeListener('render-process-gone',cancel);sender.removeListener('did-start-loading',cancel);}
  });
  mainBridge.handle(MAIN_CHANNELS.AUDIO_FINISH_CANCEL,({id},event)=>{const work=audioOwners.get(id);if(work?.owner===event.sender.id)work.cancel();});
  app.on('will-quit',()=>{visual.dispose();audioFinishing.dispose();});
  const webMediaOwners = new Map<string, { owner: number; cancel: () => void }>();
  mainBridge.handle(MAIN_CHANNELS.WEB_MEDIA_DOWNLOAD, async (request, event) => {
    if (webMediaOwners.has(request.id)) throw new Error("This download is already running.");
    const sender = event.sender;
    const controller = new AbortController();
    const cancel = () => controller.abort(new DapiError("canceled", "The download was canceled."));
    webMediaOwners.set(request.id, { owner: sender.id, cancel });
    sender.once("destroyed", cancel);
    sender.once("render-process-gone", cancel);
    sender.once("did-start-loading", cancel);
    try {
      return await webMedia.download(request, controller.signal);
    } finally {
      webMediaOwners.delete(request.id);
      sender.removeListener("destroyed", cancel);
      sender.removeListener("render-process-gone", cancel);
      sender.removeListener("did-start-loading", cancel);
    }
  });
  mainBridge.handle(MAIN_CHANNELS.WEB_MEDIA_CANCEL, ({ id }, event) => {
    const work = webMediaOwners.get(id);
    if (work?.owner === event.sender.id) work.cancel();
  });
  mainBridge.handle(MAIN_CHANNELS.WEB_MEDIA_COMMIT, (request) => webMedia.commit(request));
  mainBridge.handle(MAIN_CHANNELS.WEB_MEDIA_DISCARD, ({ id }) => webMedia.discard(id));
  app.on("will-quit", () => webMedia.dispose());
  registerEarshotIpc(earshotAddon);
  registerGeminiIpc(geminiConnection);
  // One listener for both: Node warns when `app` has more than ten, and a listener of its own tipped it over.
  app.on("will-quit", () => { earshotAddon.dispose(); geminiConnection.dispose(); });
  const mediaOwners = new Map<string, { owner: number; cancel: () => void }>();
  mainBridge.handle(MAIN_CHANNELS.MEDIA_DOWNLOAD, async (request, event) => {
    if (mediaOwners.has(request.id)) throw new Error("This download is already running.");
    const sender = event.sender;
    const controller = new AbortController();
    const cancel = () => controller.abort(new DapiError("canceled", "The download was canceled."));
    mediaOwners.set(request.id, { owner: sender.id, cancel });
    sender.once("destroyed", cancel);
    sender.once("render-process-gone", cancel);
    sender.once("did-start-loading", cancel);
    try {
      return await mediaDownloads.download(request, controller.signal);
    } finally {
      mediaOwners.delete(request.id);
      sender.removeListener("destroyed", cancel);
      sender.removeListener("render-process-gone", cancel);
      sender.removeListener("did-start-loading", cancel);
    }
  });
  mainBridge.handle(MAIN_CHANNELS.MEDIA_CANCEL, ({ id }, event) => {
    const work = mediaOwners.get(id);
    if (work?.owner === event.sender.id) work.cancel();
  });
  mainBridge.handle(MAIN_CHANNELS.MEDIA_COMMIT, (request) => mediaDownloads.commit(request));
  mainBridge.handle(MAIN_CHANNELS.MEDIA_DISCARD, ({ id }) => mediaDownloads.discard(id));
  app.on("will-quit", () => mediaDownloads.dispose());
  const reframe = new LocalReframeService({ runtimePath: join(app.getAppPath(), "dist", "reframe-vision"), cacheDir: join(app.getPath('userData'), 'reframe-cache') });
  const reframeOwners = new Map<string, { owner: number; cancel: () => void }>();
  app.on("will-quit", () => reframe.dispose());
  mainBridge.handle(MAIN_CHANNELS.REFRAME_ANALYZE, async ({ dir, source, ...request }, event) => {
    if (reframeOwners.has(request.id)) throw new Error("This reframing analysis is already running.");
    const sender = event.sender;
    const window = BrowserWindow.fromWebContents(sender);
    let canceled = false;
    const cancel = () => { canceled = true; reframe.cancel(request.id); };
    reframeOwners.set(request.id, { owner: sender.id, cancel });
    sender.once("destroyed", cancel);
    sender.once("render-process-gone", cancel);
    sender.once("did-start-loading", cancel);
    try {
      const path = await realPathEntry(dir, source);
      if (canceled) throw new Error("Reframing canceled.");
      if (!path) throw new Error("This footage is unavailable. Relink it to a local file before reframing.");
      return await reframe.analyze({ ...request, path }, (progress) => {
        if (!sender.isDestroyed()) mainBridge.emit(window, MAIN_CHANNELS.REFRAME_PROGRESS, progress);
      });
    } finally {
      reframeOwners.delete(request.id);
      sender.removeListener("destroyed", cancel);
      sender.removeListener("render-process-gone", cancel);
      sender.removeListener("did-start-loading", cancel);
    }
  });
  mainBridge.handle(MAIN_CHANNELS.REFRAME_CANCEL, ({ id }, event) => {
    const work = reframeOwners.get(id);
    if (work?.owner === event.sender.id) work.cancel();
  });
  mainBridge.handle(MAIN_CHANNELS.INSTAGRAM_CONNECT, async ({ accessToken }) => {await instagramAuth.cancel();await publishing.pauseApproved();return instagramService().connect(accessToken);});
  mainBridge.handle(MAIN_CHANNELS.INSTAGRAM_SYNC, () => instagramService().sync());
  mainBridge.handle(MAIN_CHANNELS.INSTAGRAM_DISCONNECT, async () => {
    try {await instagramAuth.cancel(true);await publishing.pauseApproved();}
    finally {await instagramService().disconnect();}
    return instagramService().snapshot();
  });
  const speech = new LocalSpeechService({
    runtimePath: join(app.isPackaged ? process.resourcesPath : app.getAppPath(), "speech", "whisper-cli"),
    dataDir: join(app.getPath("userData"), "speech"),
  });
  const speechOwners = new Map<string, number>();
  app.on("will-quit", () => speech.dispose());
  mainBridge.handle(MAIN_CHANNELS.PROJECTS_FLUSH_RESULT, ({ id, error }, event) => saveGate.answer(event.sender.id, id, error));
  mainBridge.handle(MAIN_CHANNELS.SPEECH_STATUS, () => speech.status());
  mainBridge.handle(MAIN_CHANNELS.SPEECH_TRANSCRIBE, async (request, event) => {
    if (speechOwners.has(request.id)) throw new Error("This transcription is already running.");
    const sender = event.sender;
    const window = BrowserWindow.fromWebContents(sender);
    speechOwners.set(request.id, sender.id);
    const cancel = () => speech.cancel(request.id);
    sender.once("destroyed", cancel);
    sender.once("render-process-gone", cancel);
    sender.once("did-start-loading", cancel);
    try {
      return await speech.transcribe(request, (progress) => {
        if (!sender.isDestroyed()) mainBridge.emit(window, MAIN_CHANNELS.SPEECH_PROGRESS, progress);
      });
    } finally {
      speechOwners.delete(request.id);
      sender.removeListener("destroyed", cancel);
      sender.removeListener("render-process-gone", cancel);
      sender.removeListener("did-start-loading", cancel);
    }
  });
  mainBridge.handle(MAIN_CHANNELS.SPEECH_CANCEL, ({ id }, event) => {
    if (speechOwners.get(id) === event.sender.id) speech.cancel(id);
  });
  mainBridge.handle(MAIN_CHANNELS.AUTH_GET_PENDING_CALLBACK, () =>
    takePendingDeepLink(MAIN_CHANNELS.AUTH_CALLBACK),
  );
  mainBridge.handle(MAIN_CHANNELS.CHECKOUT_GET_PENDING_CALLBACK, () =>
    takePendingDeepLink(MAIN_CHANNELS.CHECKOUT_CALLBACK),
  );
  mainBridge.handle(MAIN_CHANNELS.WINDOW_IS_FULLSCREEN, () => mainWindow?.isFullScreen() ?? false);
  mainBridge.handle(MAIN_CHANNELS.WINDOW_SET_COLOR_MODE, ({ mode }) => setColorMode(mode));
  mainBridge.handle(MAIN_CHANNELS.WINDOW_SET_BUSY, ({ busy }) => { rendererBusy = busy; windows.setBusy(busy); });
  mainBridge.handle(MAIN_CHANNELS.WINDOW_SHOW, () => windows.show());
  mainBridge.handle(MAIN_CHANNELS.WINDOW_CAPTURE, async () => {
    if (!mainWindow || mainWindow.isDestroyed()) throw new Error("No main window");
    const image = await mainWindow.webContents.capturePage(undefined, { stayHidden: true });
    const { width, height } = image.getSize();
    const png = image.toPNG();
    // A plain Uint8Array over the PNG, so the renderer sees bytes and not a Buffer.
    return { png: new Uint8Array(png.buffer, png.byteOffset, png.byteLength), width, height };
  });
  mainBridge.handle(MAIN_CHANNELS.CLIPBOARD_PATHS, async () => clipboardPaths());
  mainBridge.handle(MAIN_CHANNELS.LOGS_GET, () => logBuffer);
  mainBridge.handle(MAIN_CHANNELS.AGENT_CHAT_ENDPOINT, () => agentChatEndpoint());
  const isolatedSetupMessage = 'Use the normal Blackout profile to change system command or agent registrations.';
  mainBridge.handle(MAIN_CHANNELS.MCP_STATUS, () => launchProfile.isolated ? { url: dapi.url, agents: [] } : mcpStatus());
  mainBridge.handle(MAIN_CHANNELS.MCP_APPLY, (request) => launchProfile.isolated
    ? { added: [], removed: [], failures: [...new Set([...request.add, ...request.remove])].map(id => ({ id, error: isolatedSetupMessage })) }
    : applyMcp(request));
  mainBridge.handle(MAIN_CHANNELS.CLI_STATUS, () => launchProfile.isolated
    ? { installed: false, path: null, managed: false, available: false } : cliStatus());
  mainBridge.handle(MAIN_CHANNELS.CLI_INSTALL, () => launchProfile.isolated
    ? { status: 'error' as const, error: isolatedSetupMessage } : installCli());
  mainBridge.handle(MAIN_CHANNELS.CLI_UNINSTALL, () => launchProfile.isolated
    ? { status: 'error' as const, error: isolatedSetupMessage } : uninstallCli());
  mainBridge.handle(MAIN_CHANNELS.PROJECTS_PICK_FOLDER, () => pickFolder(mainWindow));
  mainBridge.handle(MAIN_CHANNELS.PROJECTS_GET, ({ dir }) => getProject(dir));
  mainBridge.handle(MAIN_CHANNELS.PROJECTS_INIT, ({ dir }) => initProject(mainWindow, dir));
  mainBridge.handle(MAIN_CHANNELS.PROJECTS_RESOLVE, ({ dir }) => resolveProject(dir));
  mainBridge.handle(MAIN_CHANNELS.PROJECTS_FIND_MOVED, ({ dir, id }) => findMovedProject(dir, id));
  mainBridge.handle(MAIN_CHANNELS.PROJECTS_ASK_MISSING, ({ displayName, dir }) =>
    askAboutMissingProject(mainWindow, displayName, dir),
  );
  mainBridge.handle(MAIN_CHANNELS.PROJECTS_CREATE, () => createProject());
  mainBridge.handle(MAIN_CHANNELS.PROJECTS_PICK_SAVE, ({ dir, name, startIn, action }) =>
    pickSaveLocation(mainWindow, dir, name, startIn, action),
  );
  // A download into the folder would only hold the move up: the renderer has let go of the project, so its result is dropped anyway.
  mainBridge.handle(MAIN_CHANNELS.PROJECTS_SAVE, ({ dir, target }) => { webMedia.cancelDownloads(dir); mediaDownloads.cancelDownloads(dir); earshotAddon.cancelRenders(dir); return saveProject(dir, target); });
  mainBridge.handle(MAIN_CHANNELS.PROJECTS_MOVE, ({ dir, target }) => { webMedia.cancelDownloads(dir); mediaDownloads.cancelDownloads(dir); earshotAddon.cancelRenders(dir); return moveProject(dir, target); });
  mainBridge.handle(MAIN_CHANNELS.PROJECTS_RENAME, ({ dir, displayName }) => renameProject(dir, displayName));
  // A platform download into the folder would be copied half done; it stops first (and can be asked for again).
  // Downloads keep running through a duplicate: their work folders carry the temp prefix the copy leaves out.
  mainBridge.handle(MAIN_CHANNELS.PROJECTS_DUPLICATE, ({ dir }) => duplicateProject(dir));
  mainBridge.handle(MAIN_CHANNELS.PROJECTS_DELETE, ({ dir }) => deleteProject(dir).then(deleteProjectChats));
  mainBridge.handle(MAIN_CHANNELS.PROJECTS_COMPILE, ({ dir }) => compileProject(dir));
  mainBridge.handle(MAIN_CHANNELS.PROJECTS_WRITE, ({ dir, edits, operationId }) => {
    countCanvasEdits(edits.map((edit) => edit.kind));
    return writeProject(dir, edits, operationId);
  });
  mainBridge.handle(MAIN_CHANNELS.PROJECTS_COLLECT_PICK, async ({ dir }) => {
    const options = { title: 'Collect project and media', buttonLabel: 'Collect', defaultPath: join(dirname(dir), `${basename(dir)} Collected`), properties: ['createDirectory', 'showOverwriteConfirmation'] as ('createDirectory' | 'showOverwriteConfirmation')[] };
    const result = mainWindow ? await dialog.showSaveDialog(mainWindow, options) : await dialog.showSaveDialog(options);
    return result.canceled ? null : result.filePath ?? null;
  });
  mainBridge.handle(MAIN_CHANNELS.PROJECTS_COLLECT, ({ dir, target }) => withProjectLock(dir, async () => {
    await recoverProjectWrites(dir);
    await recoverProjectVersionRestore(dir);
    return collectProject(dir, target);
  }));
  mainBridge.handle(MAIN_CHANNELS.PROJECTS_RELINK, ({ dir, searchDir, apply, expectedPreview }, event) => withProjectLock(dir, async () => {
    await recoverProjectWrites(dir);
    await recoverProjectVersionRestore(dir);
    const result = await relinkProjectMedia(dir, searchDir, apply, expectedPreview);
    if (result.applied) {
      const window = BrowserWindow.fromWebContents(event.sender);
      mainBridge.emit(window, MAIN_CHANNELS.PROJECTS_CHANGED, { dir, path: 'assets.yml' });
      mainBridge.emit(window, MAIN_CHANNELS.PROJECTS_CHANGED, { dir, path: 'index.tsx' });
    }
    return result;
  }));
  mainBridge.handle(MAIN_CHANNELS.PROJECTS_VERSIONS, ({ dir }) => withProjectLock(dir, async () => {
    await recoverProjectWrites(dir);
    await recoverProjectVersionRestore(dir);
    return { versions: await listProjectVersions(dir), fingerprint: await projectVersionFingerprint(dir) };
  }));
  mainBridge.handle(MAIN_CHANNELS.PROJECTS_VERSION_CREATE, ({ dir, label, preview, expectedFingerprint }) => withProjectLock(dir, async () => {
    await recoverProjectWrites(dir);
    await recoverProjectVersionRestore(dir);
    return createProjectVersion(dir, { label, preview, expectedFingerprint, kind: 'manual', deduplicate: false });
  }));
  mainBridge.handle(MAIN_CHANNELS.PROJECTS_VERSION_INSPECT, ({ dir, id }) => withProjectLock(dir, async () => {
    await recoverProjectWrites(dir);
    await recoverProjectVersionRestore(dir);
    return inspectProjectVersion(dir, id);
  }));
  mainBridge.handle(MAIN_CHANNELS.PROJECTS_VERSION_RESTORE_LAYER, ({ dir, id, file, layerId, expectedFingerprint }, event) => withProjectLock(dir, async () => {
    await recoverProjectWrites(dir);
    await recoverProjectVersionRestore(dir);
    const result = await restoreProjectVersionLayer(dir, id, { file, layerId, expectedFingerprint });
    const window = BrowserWindow.fromWebContents(event.sender);
    for (const path of result.paths) mainBridge.emit(window, MAIN_CHANNELS.PROJECTS_CHANGED, { dir, path });
    return result;
  }));
  mainBridge.handle(MAIN_CHANNELS.PROJECTS_VERSION_RESTORE, ({ dir, id, expectedFingerprint }, event) => withProjectLock(dir, async () => {
    await recoverProjectWrites(dir);
    const result = await restoreProjectVersion(dir, id, { expectedFingerprint });
    const window = BrowserWindow.fromWebContents(event.sender);
    for (const path of result.paths) mainBridge.emit(window, MAIN_CHANNELS.PROJECTS_CHANGED, { dir, path });
    return result;
  }));
  mainBridge.handle(MAIN_CHANNELS.PROJECTS_RELOAD, ({ dir }, event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    for (const path of ['assets.yml', 'package.json', 'index.tsx']) mainBridge.emit(window, MAIN_CHANNELS.PROJECTS_CHANGED, { dir, path });
  });
  mainBridge.handle(MAIN_CHANNELS.PROJECTS_WATCH, ({ dir }, event) => {
    lastProject = dir;
    lastProjectRoot = pinProject(dir);
    tray.refresh();
    watchProject(BrowserWindow.fromWebContents(event.sender), dir);
  });
  mainBridge.handle(MAIN_CHANNELS.PROJECTS_UNWATCH, ({ dir }) => {
    if (lastProject === dir) {
      lastProject = null;
      tray.refresh();
    }
    unwatchProject(dir);
  });
  mainBridge.handle(MAIN_CHANNELS.PROJECTS_MANIFEST_READ, ({ dir }) => readManifest(dir));
  mainBridge.handle(MAIN_CHANNELS.PROJECTS_MANIFEST_WRITE, ({ dir, manifest }) => writeManifest(dir, manifest));
  mainBridge.handle(MAIN_CHANNELS.PROJECTS_CONFIG_READ, ({ dir }) => readConfig(dir));
  mainBridge.handle(MAIN_CHANNELS.PROJECTS_CONFIG_WRITE, ({ dir, config }) => writeConfig(dir, config));
  mainBridge.handle(MAIN_CHANNELS.PROJECTS_FS_LIST, ({ dir, source }) => listEntries(dir, source));
  mainBridge.handle(MAIN_CHANNELS.PROJECTS_FS_STAT, ({ dir, source }) => statEntry(dir, source));
  mainBridge.handle(MAIN_CHANNELS.PROJECTS_FS_REMOVE, ({ dir, path }) => removeEntry(dir, path));
  mainBridge.handle(MAIN_CHANNELS.PROJECTS_FS_REAL_PATH, ({ dir, source }) => realPathEntry(dir, source));
  mainBridge.handle(MAIN_CHANNELS.FILE_TRANSFER, ({ selector, absolutePath }) =>
    setFileInputFiles(selector, absolutePath),
  );

  mainBridge.handle(MAIN_CHANNELS.EXPORT_PICK_SAVE, async ({ suggestedName, format }) => {
    if (!["mp4", "webm", "ogg", "mov"].includes(format)) throw new Error("Unsupported export format");
    const options = {
      title: format === "ogg" ? "Export audio" : "Export video",
      buttonLabel: "Export",
      defaultPath: join(app.getPath("downloads"), basename(suggestedName)),
      filters: [{ name: `${format.toUpperCase()} file`, extensions: [format] }],
    };
    const result = mainWindow && !mainWindow.isDestroyed()
      ? await dialog.showSaveDialog(mainWindow, options)
      : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) return null;
    // Keep the filename's extension consistent with the actual container.
    if (!result.filePath.toLowerCase().endsWith(`.${format}`)) {
      throw new Error(`Choose a filename ending in .${format}.`);
    }
    return result.filePath;
  });

  mainBridge.handle(MAIN_CHANNELS.FILE_WRITE_OPEN, ({ path, exclusive, finalization }) => openWrites.open(path, exclusive, finalization));
  mainBridge.handle(MAIN_CHANNELS.FILE_WRITE_CHUNK, ({ id, data, position }) => openWrites.write(id, data, position));
  mainBridge.handle(MAIN_CHANNELS.FILE_WRITE_CLOSE, ({ id }) => openWrites.close(id));
  mainBridge.handle(MAIN_CHANNELS.FILE_WRITE_ABORT, ({ id }) => openWrites.abort(id));

  app.whenReady().then(() => {
    if (!app.isPackaged && process.platform === "darwin") {
      const devIcon = nativeImage.createFromPath(join(app.getAppPath(), "assets", "icon-dev.png"));
      if (!devIcon.isEmpty()) app.dock?.setIcon(devIcon);
    }

    setupAppMenu();
    session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(true));
    session.defaultSession.setPermissionCheckHandler(() => true);
    session.defaultSession.setDevicePermissionHandler(() => true);

    const url = findProtocolUrl(process.argv);
    if (url && !launchProfile.isolated) deliverDeepLink(url);

    dapi.start();
    // The chat's sessions get the MCP server by URL.
    dapi.mcpUrl().then(async (url) => {
      configureAgentChat({
        dataDir: join(app.getPath("userData"), "agent-chat"),
        mcpUrl: url,
        version: app.getVersion(),
        instructions: instructions(docsDir()),
        // Each chat session renders the saved memory into its instructions when it opens or resumes.
        memory: memoryOff ? null : { file: agentMemoryFile, editingStyleFile: join(app.getPath("userData"), "editing-style.json"), skillsDir: agentSkillsDir },
      });
      if (launchProfile.isolated) {
        await writeFileAtomic(join(launchProfile.directory, 'profile-session.json'), JSON.stringify({
          pid: process.pid, startedAt: new Date().toISOString(), version: app.getVersion(), mcpUrl: url,
          profile: launchProfile.directory, appPath: app.getAppPath(),
        }, null, 2) + '\n');
      }
    }).catch(error => console.error('[profile] Could not record isolated session:', error));
    // MCP registration and CLI installation are explicit Settings actions.
    tray.start();
    // A newer yt-dlp, looked for at most daily and only for recent users.
    downloader.startBackgroundChecks();

    // Opened by a person (Finder, Dock, Start menu): show the editor
    if (!isHiddenLaunch(process.argv)) {
      windows.show();
    }
  });

  let quitApproved = false;
  let quitPending = false;
  app.prependListener('before-quit', (event) => {
    const window = windows.current();
    if (quitApproved || !window) return;
    event.preventDefault();
    if (quitPending) return;
    if (rendererBusy || openWrites.size) {
      quitPending = true;
      void windows.show().then(() => dialog.showMessageBox(window, { type: 'info', title: 'Finish the current operation', message: 'An export or file write is still running.', detail: 'Finish or cancel it in the editor before quitting.', buttons: ['Return to editor'] })).finally(() => { quitPending = false; });
      return;
    }
    quitPending = true;
    const release = windows.hold();
    flushRenderer(window).then(() => {
      quitApproved = true;
      app.quit();
    }).catch(async (error) => {
      await windows.show();
      await dialog.showMessageBox(window, { type: 'error', title: 'Project could not be saved', message: 'The editor is staying open to protect your work.', detail: error instanceof Error ? error.message : String(error), buttons: ['Keep editing'] });
    }).finally(() => { quitPending = false; release(); });
  });
  app.on("will-quit", () => {
    unwatchAll();
    stopAgentChat();
    dapi.stop();
    tray.destroy();
  });

  // No window is no reason to quit: the app keeps serving agents from the
  // tray, and the window is destroyed whenever it idles out. Only Quit ends it.
  app.on("window-all-closed", () => { });

  // The Dock icon, or launching the app again while it runs.
  app.on("activate", () => windows.show());
} else {
  app.quit();
}
