import { ALL_FORMATS, AudioBufferSink, BlobSource, Input } from "mediabunny";
import { getAssetFile, getLibrary } from "@diffusionstudio/runtime";
import { isUrlSource } from "@diffusionstudio/assets";
import { DapiError } from "@diffusionstudio/dapi";
import { flushProjectEdits } from "@/projects/edits";
import { analyzePcm, decibels, MAX_AUDIO_SECONDS, normalizedWav } from "../lib/audio-finish";
import { requireAssetType, resolveAsset } from "../lib/assets";
import type { ToolHandler } from "../handler";

export const audioFinish: ToolHandler<"audio_finish"> = async (args, ctx) => {
  const { path, action, targetPeakDb } = args;
  if (action === 'measure' || action === 'finish') return (await import('./audio-finish-advanced')).advancedAudioFinish(args, ctx);
  if (!path) throw new DapiError('invalid-input', 'Choose a local source path for sample-peak inspection or normalization.');
  ctx.signal.throwIfAborted();
  if (isUrlSource(path)) throw new DapiError("invalid-input", "Audio finishing uses local files. Download the source into the project first.");
  const session = action === "normalize" ? ctx.requireSession() : ctx.session();
  const dir = session?.project.dir();
  const library = action === "normalize" ? getLibrary(session!.world) : null;
  const assertCurrent = () => {
    ctx.signal.throwIfAborted();
    if (session && (ctx.session() !== session || session.project.dir() !== dir || (library && getLibrary(session.world) !== library))) {
      throw new DapiError("no-project", "The open project changed while processing audio. Open the intended project and try again.");
    }
  };
  assertCurrent();
  const asset = await resolveAsset(ctx, path);
  requireAssetType(asset, ["AUDIO", "VIDEO"], "audio or video");
  if (isUrlSource(asset.source)) throw new DapiError("invalid-input", "Audio finishing uses local files; this library asset is a remote URL.");
  if (!Number.isFinite(asset.duration) || asset.duration <= 0 || asset.duration > MAX_AUDIO_SECONDS) throw new DapiError("invalid-input", "Audio finishing supports sources up to 10 minutes. Use a shorter source segment.");
  const file = await getAssetFile(asset, true);
  assertCurrent();
  if (file.size > 512 * 1024 * 1024) throw new DapiError("invalid-input", "Audio finishing supports source files up to 512 MiB. Extract a shorter audio segment first.");
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
  const cancel = () => input.dispose();
  ctx.signal.addEventListener("abort", cancel, { once: true });
  try {
    assertCurrent();
    const track = await input.getPrimaryAudioTrack();
    if (!track) throw new DapiError("wrong-kind", "The source has no audio track.");
    if (!(await track.canDecode())) throw new DapiError("unsupported", "This audio codec cannot be decoded on this machine. Convert it to PCM WAV, AAC or Opus first.");
    const pcm = await analyzePcm(new AudioBufferSink(track).buffers(0), action === "normalize", ctx.signal);
    assertCurrent();
    const warnings = ["Sample-peak and unweighted RMS measurements are not true-peak or LUFS measurements."];
    if (pcm.fullScaleSamples) warnings.push("The source reaches full scale. Normalization lowers its level but cannot restore clipped audio.");
    let outputPath: string | null = null;
    let appliedGainDb: number | null = null;
    let outputSamplePeakDb: number | null = null;
    if (action === "normalize") {
      const normalized = normalizedWav(pcm, targetPeakDb, ctx.signal);
      await flushProjectEdits(dir);
      assertCurrent();
      // The UUID plus the library's collision handling avoids replacing any source.
      const output = await library!.store(normalized.blob, { name: `Normalized-${crypto.randomUUID()}.wav` });
      await library!.flush();
      assertCurrent();
      outputPath = output.path;
      appliedGainDb = normalized.gainDb;
      outputSamplePeakDb = normalized.peakDb;
      if (normalized.limited) warnings.push("Gain was capped at +24 dB; the resulting sample peak remains below the requested target.");
    }
    return { action, source: path, duration: pcm.frames / pcm.sampleRate, sampleRate: pcm.sampleRate, channels: pcm.channels,
      samplePeakDb: decibels(pcm.peak), rmsDb: decibels(pcm.rms), fullScaleSamples: pcm.fullScaleSamples,
      outputPath, appliedGainDb, outputSamplePeakDb, warnings };
  } finally {
    ctx.signal.removeEventListener("abort", cancel);
    input.dispose();
  }
};
