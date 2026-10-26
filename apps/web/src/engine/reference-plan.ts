import { cloneReframeTree, planCropKeyframes } from "./reframe-plan";
import type { ReframeVideo } from "./reframe-plan";
import type { AuthoredTree } from "@diffusionstudio/reconciler";
import type { ReferenceProfile } from "@desktop/reference-types";
const finite = (value: unknown, fallback: number, label: string) => {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new Error(
      `${label} must be a fixed number before matching a reference.`,
    );
  return value;
};
const clamp = (n: number, a: number, b: number) => Math.max(a, Math.min(b, n));
export type ReferenceApplyOptions = {
  matchFormat?: boolean;
  matchCaptions?: boolean;
  name?: string;
};
export type ReferencePlan = {
  tree: AuthoredTree;
  name: string;
  width: number;
  height: number;
  captionLayers: number;
  changes: string[];
  warnings: string[];
};

/** Layout only: speech/cut decisions remain the editor agent's evidence-based task. */
export function planReferenceStyle(
  scene: AuthoredTree,
  videos: readonly ReframeVideo[],
  profile: ReferenceProfile,
  fps: number,
  options: ReferenceApplyOptions = {},
): ReferencePlan {
  if (scene.tag !== "scene")
    throw new Error("Choose a scene to match the reference.");
  if (options.matchFormat === false && options.matchCaptions === false)
    throw new Error("Choose format or caption matching.");
  if (
    options.name !== undefined &&
    (!options.name.trim() || options.name.length > 100)
  )
    throw new Error("Use a version name between 1 and 100 characters.");
  const sw = finite(scene.props.width, 1920, "Scene width"),
    sh = finite(scene.props.height, 1080, "Scene height");
  if (sw <= 0 || sh <= 0 || !Number.isFinite(fps) || fps <= 0)
    throw new Error("The scene dimensions or frame rate are invalid.");
  const longEdge = Math.min(3840, Math.max(1920, sw, sh)),
    ratio = profile.width / profile.height;
  const width =
    options.matchFormat === false
      ? sw
      : Math.max(
          2,
          Math.round((ratio >= 1 ? longEdge : longEdge * ratio) / 2) * 2,
        );
  const height =
    options.matchFormat === false
      ? sh
      : Math.max(
          2,
          Math.round((ratio >= 1 ? longEdge / ratio : longEdge) / 2) * 2,
        );
  const resized = width !== sw || height !== sh;
  const tree = cloneReframeTree(scene),
    name =
      options.name?.trim() ||
      `${String(scene.props.name || "Scene").slice(0, 75)} · Reference style`;
  Object.assign(tree.props, { name, width, height, x: 0, y: 0 });
  const changes: string[] = [],
    warnings: string[] = [];
  let captionLayers = 0;
  let hasCaptions = false;
  if (options.matchFormat !== false)
    changes.push(
      `Matched the reference aspect ratio in a ${width}×${height} frame.`,
    );
  const visit = (node: AuthoredTree, key: string) => {
    const video = videos.find((v) => v.key === key);
    if (video && resized) {
      const crop = planCropKeyframes(video, width, height, [], fps);
      Object.assign(node.props, {
        x: crop.keys[0]!.x,
        y: crop.keys[0]!.y,
        width: crop.width,
        height: crop.height,
        objectFit: "cover",
        keepAspectRatio: true,
      });
      return;
    }
    if (node.tag === "captions") {
      hasCaptions = true;
      if (node.children.some((child) => child.tag === "keyframeTrack" &&
        ["x", "y", "scale", "scaleX", "scaleY", "rotation", "width", "height"].includes(String(child.props.property)))) {
        warnings.push("A caption layer has existing motion; its layout was preserved for the agent to adapt.");
        return;
      }
      if (options.matchCaptions !== false && profile.caption) {
        const c = profile.caption,
          preset = c.suggestedPreset,
          boxWidth = preset === "whisper" ? 1000 : 600,
          boxHeight = 100;
        const scale = clamp((c.width * width) / boxWidth, 0.15, 4),
          fontSize = clamp((c.fontSizeRatio * height) / scale, 18, 140);
        Object.assign(node.props, {
          preset,
          fontSize,
          textCase: "original",
          x: clamp(
            (c.x + c.width / 2) * width - (boxWidth * scale) / 2,
            width * 0.03,
            width * 0.97 - boxWidth * scale,
          ),
          y: clamp(
            (c.y + c.height / 2) * height - (boxHeight * scale) / 2,
            height * 0.03,
            height * 0.97 - boxHeight * scale,
          ),
          scale,
          pivotX: 0,
          pivotY: 0,
          offsetX: 0,
          offsetY: 0,
          verticalAlign: "center",
        });
        captionLayers++;
      } else if (resized) {
        const scale = Math.min(width / sw, height / sh);
        node.props.x =
          finite(node.props.x, (sw - 1000) / 2, "Caption x") * scale +
          (width - sw * scale) / 2;
        node.props.y =
          finite(node.props.y, sh - 200, "Caption y") * scale +
          (height - sh * scale) / 2;
        node.props.scale = finite(node.props.scale, 1, "Caption scale") * scale;
      }
      return;
    }
    if (node.tag === "sequence") {
      node.children.forEach((child, i) => visit(child, `${key}.${i}`));
      return;
    }
    if (
      !resized ||
      video ||
      [
        "audio",
        "animation",
        "keyframeTrack",
        "videoPaint",
        "imagePaint",
        "linearGradient",
        "radialGradient",
        "color",
        "shadow",
        "stroke",
      ].includes(node.tag)
    )
      return;
    const scale = Math.min(width / sw, height / sh);
    Object.assign(node.props, {
      x:
        (width - sw * scale) / 2 + finite(node.props.x, 0, "Overlay x") * scale,
      y:
        (height - sh * scale) / 2 +
        finite(node.props.y, 0, "Overlay y") * scale,
      scale: finite(node.props.scale, 1, "Overlay scale") * scale,
      pivotX: 0,
      pivotY: 0,
    });
    warnings.push(
      "Existing graphics were uniformly fitted into the reference frame; review their placement.",
    );
  };
  tree.children.forEach((node, i) => visit(node, String(i)));
  if (captionLayers)
    changes.push(
      `Matched estimated caption placement and size on ${captionLayers} caption layer${captionLayers === 1 ? "" : "s"}; retained transcript text and timing.`,
    );
  else if (options.matchCaptions !== false && (!hasCaptions || !profile.caption))
    warnings.push(
      profile.caption
        ? "This scene has no caption layer to style. Generate captions before applying caption layout."
        : "The reference has no reliable changing caption region; existing caption styling was retained.",
    );
  if (resized && videos.length)
    warnings.push(
      "Video uses a center crop in the new frame. Review subjects or run face-follow reframing when needed.",
    );
  warnings.push(
    "This layout pass does not change dialogue, shot timing, music or graphics. Use the reference cadence and sampled frames to guide the full edit.",
  );
  return {
    tree,
    name,
    width,
    height,
    captionLayers,
    changes,
    warnings: [...new Set(warnings)],
  };
}
