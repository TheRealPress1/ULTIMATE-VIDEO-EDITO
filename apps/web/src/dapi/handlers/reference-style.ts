import { DapiError } from "@diffusionstudio/dapi";
import {
  analyzeReferenceStyle,
  applyReferenceStyle,
} from "@/engine/reference-style";
import { requireScene } from "../lib/scene";
import type { ToolHandler } from "../handler";
export const referenceAnalyze: ToolHandler<"reference_analyze"> = async (
  { path },
  ctx,
) => {
  const session = ctx.requireSession(),
    dir = session.project.dir();
  const assertCurrent = () => {
    ctx.signal.throwIfAborted();
    if (ctx.session() !== session || session.project.dir() !== dir)
      throw new DapiError(
        "no-project",
        "The open project changed during reference analysis.",
      );
  };
  assertCurrent();
  return analyzeReferenceStyle(session.world, dir, path, {
    signal: ctx.signal,
    assertCurrent,
  });
};
export const referenceApply: ToolHandler<"reference_apply"> = async (
  { id, path, fingerprint, matchFormat, matchCaptions, name },
  ctx,
) => {
  const session = ctx.requireSession(),
    dir = session.project.dir();
  const assertCurrent = () => {
    ctx.signal.throwIfAborted();
    if (ctx.session() !== session || session.project.dir() !== dir)
      throw new DapiError(
        "no-project",
        "The open project changed while applying the reference.",
      );
  };
  assertCurrent();
  const scene = requireScene(
    session.world,
    id,
    "reference_apply",
    "reference layout copies a complete scene",
  );
  const result = await applyReferenceStyle(
    session.world,
    dir,
    scene,
    path,
    fingerprint,
    { matchFormat, matchCaptions, name, signal: ctx.signal, assertCurrent },
  );
  try {
    assertCurrent();
  } catch (cause) {
    throw new Error(
      "The reference version was created and saved, but the request stopped afterward. Review it before creating another copy.",
      { cause },
    );
  }
  return result;
};
