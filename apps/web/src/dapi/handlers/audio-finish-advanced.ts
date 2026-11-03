import { getAssetFile, getLibrary, Source } from '@diffusionstudio/runtime';
import { isUrlSource } from '@diffusionstudio/assets';
import { DapiError } from '@diffusionstudio/dapi';
import { flushProjectEdits } from '@/projects/edits';
import { runLocalAudioFinishing } from '@/lib/local-audio-finishing';
import { decodeFinishingAudio } from '@/engine/audio-pcm';
import { finishSceneAudio, measureSceneAudio } from '@/engine/audio-finishing';
import { encodePcmWav } from '../lib/audio-finish';
import { requireAssetType, resolveAsset } from '../lib/assets';
import { requireScene } from '../lib/scene';
import { resolveNode } from '../lib/nodes';
import type { ToolHandler } from '../handler';
import type { AudioLoudnessMeasurement } from '@desktop/audio-finishing-types';

const legacyFields = (source: string, measurement: AudioLoudnessMeasurement) => ({
  source, duration: measurement.duration, sampleRate: measurement.sampleRate, channels: measurement.channels,
  samplePeakDb: measurement.samplePeakDb, rmsDb: measurement.rmsDb, fullScaleSamples: measurement.fullScaleSamples,
  outputPath: null as string | null, appliedGainDb: null as number | null, outputSamplePeakDb: null as number | null,
});

export const advancedAudioFinish: ToolHandler<'audio_finish'> = async (args, ctx) => {
  const session = args.sceneId || args.action === 'finish' ? ctx.requireSession() : ctx.session();
  const dir = session?.project.dir(); const library = session ? getLibrary(session.world) : undefined;
  const assertCurrent = () => {
    ctx.signal.throwIfAborted();
    if (session && (ctx.session() !== session || session.project.dir() !== dir || getLibrary(session.world) !== library)) throw new DapiError('no-project', 'The project changed during audio finishing.');
  };
  assertCurrent();
  if (args.sceneId) {
    const scene = requireScene(session!.world, args.sceneId, 'audio_finish', 'finishing follows the complete edited scene mix');
    if (args.action === 'measure') {
      const result = await measureSceneAudio(session!.world, scene, dir!, { signal: ctx.signal, assertCurrent });
      return { action: args.action, ...legacyFields(args.sceneId, result.measurement), inputLoudness: result.measurement, warnings: result.warnings };
    }
    const musicIds = args.musicIds?.map((id) => resolveNode(session!.world, id).get(Source)!.value);
    const effectIds = args.effectIds?.map((id) => resolveNode(session!.world, id).get(Source)!.value);
    const result = await finishSceneAudio(session!.world, scene, dir!, { ...args, musicIds, effectIds, signal: ctx.signal, assertCurrent });
    return { action: args.action, ...legacyFields(args.sceneId, result.input), outputPath: result.outputPath,
      outputSamplePeakDb: result.dialogue.samplePeakDb, inputLoudness: result.input, outputLoudness: result.dialogue,
      mixLoudness: result.mix, createdSceneId: result.sceneId, musicKeyframeCount: result.musicKeyframeCount, effectCount: result.effectCount, warnings: result.warnings };
  }
  const path = args.path;
  if (!path || isUrlSource(path)) throw new DapiError('invalid-input', 'Choose a local source path or sceneId.');
  const asset = await resolveAsset(ctx, path); assertCurrent(); requireAssetType(asset, ['AUDIO', 'VIDEO'], 'audio or video');
  if (isUrlSource(asset.source) || asset.duration <= 0 || asset.duration > 600) throw new DapiError('invalid-input', 'Audio finishing supports local audio/video up to ten minutes.');
  const identity = { id: asset.id, source: asset.source };
  const file = await getAssetFile(asset, true); assertCurrent();
  const pcm = await decodeFinishingAudio(file, ctx.signal); assertCurrent();
  const result = await runLocalAudioFinishing({ action: args.action === 'finish' ? 'finish' : 'measure', wav: new Uint8Array(encodePcmWav(pcm, ctx.signal)), targetLufs: args.targetLufs, truePeakDb: args.truePeakDb, levelDialogue: args.levelDialogue, denoise: args.denoise }, ctx.signal); assertCurrent();
  const currentFile = await getAssetFile(asset, true); assertCurrent();
  if (asset.id !== identity.id || asset.source !== identity.source || currentFile.size !== file.size || currentFile.lastModified !== file.lastModified) throw new DapiError('invalid-input', 'The source changed while processing audio. Re-import it and try again.');
  let outputPath: string | null = null;
  if (args.action === 'finish') {
    if (!result.wav || !library) throw new Error('No complete finished audio was returned.');
    await flushProjectEdits(dir); assertCurrent();
    const output = await library.store(new Blob([result.wav as Uint8Array<ArrayBuffer>], { type: 'audio/wav' }), { name: `Finished-${crypto.randomUUID()}.wav` });
    await library.flush();
    outputPath = output.path;
    try { assertCurrent(); }
    catch (cause) { throw new Error(`Finished audio was saved as ${outputPath} before the request stopped. Review that asset before creating another.`, { cause }); }
  }
  return { action: args.action, ...legacyFields(path, result.input), outputPath, outputSamplePeakDb: result.output?.samplePeakDb ?? null,
    inputLoudness: result.input, outputLoudness: result.output, warnings: result.warnings };
};
