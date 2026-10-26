import { DapiError } from "@diffusionstudio/dapi";
import { generateCaptions } from "@/engine/generate/captions";
import { flushProjectEdits } from "@/projects/edits";
import { requireScene } from "../lib/scene";
import type { ToolHandler } from "../handler";

export const captions: ToolHandler<"captions"> = async ({ id }, ctx) => {
  const session = ctx.requireSession();
  const dir = session.project.dir();
  const assertCurrent = () => {
    ctx.signal.throwIfAborted();
    if (ctx.session() !== session || session.project.dir() !== dir) {
      throw new DapiError("no-project", "The open project changed while generating captions. Open the intended project and try again.");
    }
  };
  assertCurrent();
  await flushProjectEdits(dir);
  assertCurrent();
  const scene = requireScene(session.world, id, "captions", "captions follow a complete scene's edited audio");
  const result = await generateCaptions(session.world, scene, dir, {
    signal: ctx.signal, throwErrors: true, assertCurrent,
  });
  if (!result) throw new DapiError("invalid-input", "No captions were generated.");
  // Success means the scene edit and transcript manifest have both persisted.
  await flushProjectEdits(dir);
  assertCurrent();
  return { id, ...result };
};
