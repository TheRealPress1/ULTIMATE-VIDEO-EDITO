import { z } from "zod";
import { defineTool } from "../tool";
import { SceneId } from "../schemas";

export const captions = defineTool({
  name: "captions",
  title: "Caption edited scene",
  description: "Generate word-timed captions from the edited scene's complete audible mix locally with Whisper. Times follow the edited scene, including cuts, trims, speed changes and audio mixing; the export workarea is ignored. Saves a new transcript asset and adds a scene-level caption or updates an existing untrimmed scene-level caption while keeping its style. Fails when other timed or nested caption layers would overlap; reconcile those layers explicitly first. Preserves source media. Supports scenes up to two hours in resumable two-minute sections; existing captions remain intact until analysis completes; first use may download the local speech model. Waits for project saves before reporting success. No upload or speech-service account is required.",
  input: z.object({ id: SceneId }),
  output: z.object({
    id: z.string(),
    path: z.string().describe("transcript asset's library path, relative to assets/"),
    segments: z.int().nonnegative(),
    words: z.int().positive(),
    replacedExisting: z.boolean().describe("updated an existing scene caption while preserving its style"),
  }),
  environment: "renderer",
  annotations: { destructiveHint: false, openWorldHint: false },
});
