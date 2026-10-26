/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { lstat, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

function within(root: string, path: string): boolean {
  const part = relative(root, path);
  return (
    part === "" ||
    (!isAbsolute(part) && part !== ".." && !part.startsWith(`..${sep}`))
  );
}

function localPath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    !/[\x00-\x1f\x7f]/u.test(value) &&
    !/^[a-z][a-z\d+.-]*:/i.test(value) &&
    !value.startsWith("\\\\")
  );
}

/** Resolve existing symlinks even when the final output does not exist yet. */
async function canonical(
  path: string,
  future: boolean,
): Promise<string | null> {
  try {
    return await realpath(path);
  } catch (error) {
    if (!future || (error as NodeJS.ErrnoException).code !== "ENOENT")
      return null;
    // A dangling symlink is not a new output path. Do not look past it.
    try {
      await lstat(path);
      return null;
    } catch (statError) {
      if ((statError as NodeJS.ErrnoException).code !== "ENOENT") return null;
    }
    const parent = dirname(path);
    if (parent === path) return null;
    const resolved = await canonical(parent, true);
    return resolved ? join(resolved, basename(path)) : null;
  }
}

const PROTECTED_WRITE = new Set([
  ".git",
  ".claude",
  ".codex",
  ".ssh",
  ".aws",
  ".mcp.json",
]);

export async function canAutoApproveFile(input: {
  cwd: string;
  path: unknown;
  kind: "read" | "write";
  grantRoot?: unknown;
}): Promise<boolean> {
  if (!localPath(input.path) || !isAbsolute(input.cwd)) return false;
  const requested = resolve(input.cwd, input.path);
  const [path, project, temp, unixTemp] = await Promise.all([
    canonical(requested, input.kind === "write"),
    canonical(input.cwd, false),
    canonical(tmpdir(), false),
    process.platform === "win32"
      ? Promise.resolve(null)
      : canonical("/tmp", false),
  ]);
  if (!path || !project) return false;
  const roots = [project, temp, unixTemp].filter(
    (root): root is string => root !== null,
  );
  if (!roots.some((root) => within(root, path))) return false;
  if (
    input.kind === "write" &&
    [requested, path].some((candidate) =>
      candidate.split(sep).some((part) => PROTECTED_WRITE.has(part)),
    )
  )
    return false;
  if (input.grantRoot !== undefined && input.grantRoot !== null) {
    if (!localPath(input.grantRoot)) return false;
    const grant = await canonical(resolve(input.cwd, input.grantRoot), true);
    if (
      !grant ||
      !within(grant, path) ||
      !roots.some((root) => within(root, grant))
    )
      return false;
  }
  return true;
}

/** Explicit local tool surface. New tools/options require a policy decision. */
const LOCAL_TOOL_KEYS: Record<string, readonly string[]> = {
  context: [],
  check: ["id"],
  quality_review: ["id", "audio"],
  capture: ["id", "times", "separate", "perSheet", "output"],
  screenshot: ["output"],
  export: ["id", "path"],
  open: ["dir"],
  skills: ["action", "id"],
  editing_style: ["action"],
  logs: ["tail", "level", "since", "contains"],
  window: ["visible"],
  fonts: ["family", "provider", "popular", "weights", "style", "limit"],
  probe: ["path"],
  transcribe: ["path", "output"],
  listen: ["path", "prompt", "start", "end"],
  grab: [
    "path",
    "times",
    "count",
    "auto",
    "start",
    "end",
    "quality",
    "uncapped",
    "separate",
    "perSheet",
    "output",
  ],
  filmstrip: ["path", "start", "end", "scale", "output"],
  waveform: ["path", "start", "end", "scale", "output"],
  footage_index: ["paths"],
  footage_search: ["query", "path", "limit"],
  footage_cut: ["passages", "name", "width", "height"],
  visual_index: ["paths", "descriptions"],
  visual_search: ["query", "path", "limit", "mode"],
  visual_status: [],
  transcript_edit_inspect: [
    "id",
    "refreshTranscript",
    "wordOffset",
    "wordLimit",
  ],
  transcript_edit_apply: ["id", "revision", "ranges"],
  generate: [
    "model",
    "video",
    "size",
    "time",
    "points",
    "exclude",
    "box",
    "preview",
    "start",
    "end",
    "output",
    "maxCredits",
    "estimate",
  ],
  job: ["id", "cancel"],
  reference_analyze: ["path"],
  reference_apply: [
    "id",
    "path",
    "fingerprint",
    "matchFormat",
    "matchCaptions",
    "name",
  ],
  reframe: ["id", "formats", "mode", "name", "speakerFraming"],
  captions: ["id"],
  audio_finish: [
    "path",
    "sceneId",
    "action",
    "targetPeakDb",
    "targetLufs",
    "truePeakDb",
    "levelDialogue",
    "denoise",
    "musicIds",
    "duckingDb",
    "activityThresholdDb",
  ],
  instagram_accounts: [],
  instagram_posts: ["sortBy", "limit"],
  instagram_post_analytics: ["postId"],
  instagram_account_insights: [],
};

async function localSource(cwd: string, path: unknown): Promise<boolean> {
  if (!localPath(path)) return false;
  // Relative inputs name imported library assets. The editor resolves their
  // existing source binding, including media the user imported from elsewhere.
  if (!isAbsolute(path)) return !path.split(/[\\/]/).includes("..");
  return canAutoApproveFile({ cwd, path, kind: "read" });
}

export async function canAutoApproveMcp(input: {
  cwd: string;
  serverName: unknown;
  expectedServerName: string;
  toolName: unknown;
  arguments: unknown;
}): Promise<boolean> {
  if (
    !input.expectedServerName ||
    input.serverName !== input.expectedServerName ||
    typeof input.toolName !== "string"
  )
    return false;
  const keys = Object.hasOwn(LOCAL_TOOL_KEYS, input.toolName)
    ? LOCAL_TOOL_KEYS[input.toolName]!
    : undefined;
  if (
    !keys ||
    !input.arguments ||
    typeof input.arguments !== "object" ||
    Array.isArray(input.arguments)
  )
    return false;
  const args = input.arguments as Record<string, unknown>;
  if (Object.keys(args).some((key) => !keys.includes(key))) return false;
  if (input.toolName === "generate") {
    if (
      args.model !== "sam-2.1" ||
      !args.video ||
      typeof args.video !== "object" ||
      Array.isArray(args.video)
    )
      return false;
    const video = args.video as Record<string, unknown>;
    if (
      Object.keys(video).length !== 1 ||
      !(await localSource(input.cwd, video.path))
    )
      return false;
  }
  if (
    input.toolName === "job" &&
    (typeof args.id !== "string" ||
      !/^local-[\da-f]{8}-[\da-f]{4}-[1-8][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i.test(
        args.id,
      ))
  )
    return false;
  if (input.toolName === "listen" && args.path === undefined) return false;
  if (
    input.toolName === "skills" &&
    args.action !== undefined &&
    !["list", "read"].includes(String(args.action))
  )
    return false;
  if (
    input.toolName === "editing_style" &&
    args.action !== undefined &&
    args.action !== "get"
  )
    return false;
  if (
    input.toolName === "audio_finish" &&
    args.action !== undefined &&
    !["inspect", "normalize", "measure", "finish"].includes(String(args.action))
  )
    return false;
  if (input.toolName === "open") {
    if (!localPath(args.dir)) return false;
    const [project, requested] = await Promise.all([
      canonical(input.cwd, false),
      canonical(resolve(input.cwd, args.dir), false),
    ]);
    return project !== null && project === requested;
  }
  if (
    args.output !== undefined &&
    !(await canAutoApproveFile({
      cwd: input.cwd,
      path: args.output,
      kind: "write",
    }))
  )
    return false;
  if (
    args.path !== undefined &&
    !(input.toolName === "export"
      ? await canAutoApproveFile({
          cwd: input.cwd,
          path: args.path,
          kind: "write",
        })
      : await localSource(input.cwd, args.path))
  )
    return false;
  if (
    args.paths !== undefined &&
    (!Array.isArray(args.paths) ||
      !(
        await Promise.all(
          args.paths.map((path) => localSource(input.cwd, path)),
        )
      ).every(Boolean))
  )
    return false;
  return true;
}
