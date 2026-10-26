import { authoredElement, authoredTree, renderAuthored } from '@diffusionstudio/reconciler';
import { Computed, focusRect, FrameRate, getEntityChildren, getLibrary, Root, Source, store } from '@diffusionstudio/runtime';
import { isUrlSource } from '@diffusionstudio/assets';
import { flushProjectEdits } from '@/projects/edits';
import { runLocalAudioFinishing } from '@/lib/local-audio-finishing';
import { sceneAudioWav, decodeFinishingAudio } from './audio-pcm';
import { cloneReframeTree } from './reframe-plan';
import { dialogueActivity, musicDuckingGroup, planMusicDucking } from './audio-ducking';
import { getDocumentEditor, isPendingSource } from './editor';
import { getEditHistory } from './history';
import { parseTime } from '@diffusionstudio/jsx';
import type { Entity, World } from 'koota';
import type { AuthoredTree } from '@diffusionstudio/reconciler';
import type { AudioLoudnessMeasurement } from '@desktop/audio-finishing-types';
import type { AssetLibrary } from '@diffusionstudio/assets';

export interface FinishingMusicTrack { id: string; name: string; path: string; index: number }
export interface SceneAudioFinishingOptions {
  targetLufs?: number; truePeakDb?: number; levelDialogue?: boolean; denoise?: boolean;
  musicIds?: readonly string[]; duckingDb?: number; activityThresholdDb?: number;
  signal?: AbortSignal; assertCurrent?: () => void; onProgress?: (message: string) => void;
}
export interface SceneAudioFinishingResult {
  sceneId: string; name: string; outputPath: string; input: AudioLoudnessMeasurement;
  dialogue: AudioLoudnessMeasurement; mix?: AudioLoudnessMeasurement; musicKeyframeCount: number; warnings: string[];
}

export function audioFinishingMusicTracks(world: World, scene: Entity): FinishingMusicTrack[] {
  return getEntityChildren(world, scene).filter((entity) => !!authoredElement(entity)).flatMap((entity, index) => {
    const authored = authoredElement(entity)!; const id = entity.get(Source)?.value;
    return authored.tag === 'audio' && id && typeof authored.props.src === 'string'
      ? [{ id, name: typeof authored.props.name === 'string' ? authored.props.name : authored.props.src, path: authored.props.src, index }] : [];
  });
}

function sceneGuard(world: World, scene: Entity, options: SceneAudioFinishingOptions) {
  const source = authoredTree(world, scene); const root = world.get(Root); const library = getLibrary(world);
  if (!source || source.tag !== 'scene' || !root?.isAlive()) throw new Error('Select an editable scene before finishing its audio.');
  const snapshot = cloneReframeTree(source); const signature = JSON.stringify(snapshot);
  const fps = world.get(FrameRate)?.value ?? 30;
  const duration = store(world, Computed).end[scene.id()]! / fps;
  if (!Number.isFinite(duration) || duration <= 0 || duration > 600) throw new Error('Audio finishing supports scenes up to ten minutes.');
  const assertCurrent = () => {
    options.signal?.throwIfAborted(); options.assertCurrent?.();
    if (!root.isAlive() || world.get(Root) !== root || getLibrary(world) !== library || !scene.isAlive() || (world.get(FrameRate)?.value ?? 30) !== fps) throw new Error('The project changed during audio finishing.');
    const now = authoredTree(world, scene);
    if (!now || JSON.stringify(cloneReframeTree(now)) !== signature) throw new Error('The scene changed during audio finishing. Review it and try again.');
  };
  return { snapshot, root, library, duration, assertCurrent };
}

type SourceStat = { source: string; size: number; mtime: number; id: string };
async function audioSourceStats(tree: AuthoredTree, library: AssetLibrary, assertCurrent: () => void): Promise<Map<string, SourceStat>> {
  const paths = new Set<string>();
  const gather = (node: AuthoredTree): void => { if (['audio', 'video', 'videoPaint'].includes(node.tag) && typeof node.props.src === 'string') paths.add(node.props.src); node.children.forEach(gather); };
  gather(tree);
  const result = new Map<string, SourceStat>();
  for (const path of paths) {
    const asset = await library.resolve(path); assertCurrent();
    if (isUrlSource(asset.source)) throw new Error('Audio finishing uses local media. Download linked remote audio into the project first.');
    const stat = await library.fs.stat(asset.source); assertCurrent();
    if (!stat) throw new Error(`${path} is missing. Relink it before finishing audio.`);
    if (asset.stat && (asset.stat.size !== stat.size || Math.floor(asset.stat.mtime) !== Math.floor(stat.mtime))) throw new Error(`${path} changed on disk. Re-import it before measuring or finishing audio.`);
    result.set(path, { source: asset.source, id: asset.id, size: stat.size, mtime: stat.mtime });
  }
  return result;
}
async function verifyAudioSources(stats: Map<string, SourceStat>, library: AssetLibrary, assertCurrent: () => void): Promise<void> {
  for (const [path, before] of stats) {
    const asset = await library.resolve(path); const stat = await library.fs.stat(asset.source); assertCurrent();
    if (asset.id !== before.id || asset.source !== before.source || !stat || stat.size !== before.size || stat.mtime !== before.mtime) throw new Error(`${path} changed while preparing audio. Review it and try again.`);
  }
}

/** Integrated loudness is measured from the lossless edited scene mix, including existing automation. */
export async function measureSceneAudio(world: World, scene: Entity, dir: string, options: SceneAudioFinishingOptions = {}): Promise<{ measurement: AudioLoudnessMeasurement; warnings: string[] }> {
  const { snapshot, library, assertCurrent } = sceneGuard(world, scene, options);
  assertCurrent(); await flushProjectEdits(dir); assertCurrent();
  const stats = await audioSourceStats(snapshot, library, assertCurrent);
  options.onProgress?.('Rendering the scene mix…');
  const wav = await sceneAudioWav(world, scene, dir, { signal: options.signal }); assertCurrent();
  options.onProgress?.('Measuring integrated loudness and true peak…');
  const result = await runLocalAudioFinishing({ action: 'measure', wav }, options.signal); assertCurrent();
  await verifyAudioSources(stats, library, assertCurrent);
  return { measurement: result.input, warnings: result.warnings };
}

/** Preserve the original scene and author a finished version with separately editable music ducking. */
export async function finishSceneAudio(world: World, scene: Entity, dir: string, options: SceneAudioFinishingOptions = {}): Promise<SceneAudioFinishingResult> {
  const { snapshot, root, library, duration, assertCurrent } = sceneGuard(world, scene, options);
  const signal = options.signal ?? new AbortController().signal;
  const sceneVolume = snapshot.props.volume ?? 0;
  if (typeof sceneVolume !== 'number' || !Number.isFinite(sceneVolume) || snapshot.children.some((node) => (node.tag === 'keyframeTrack' && node.props.property === 'volume') || (node.tag === 'animation' && node.props.type === 'gain'))) throw new Error('Use a scene with a fixed master volume before creating an audio-finished version.');
  if ((snapshot.props.playbackRate ?? 1) !== 1 || (parseTime(snapshot.props.sourceIn as string | number | undefined) ?? 0) !== 0) throw new Error('Use a scene with an untrimmed, normal-speed master timeline before audio finishing. Clip trims and speeds remain supported.');
  const tracks = audioFinishingMusicTracks(world, scene);
  const requested = new Set(options.musicIds ?? []);
  const music = tracks.filter((track) => requested.has(track.id));
  if (music.length !== requested.size) throw new Error('Choose background audio clips directly inside this scene. Nested or changed tracks need to be moved to the scene first.');
  const musicIndices = new Set(music.map((track) => track.index));
  const validate = (node: AuthoredTree): void => {
    if (node.props.syncTo !== undefined) throw new Error('This scene has audio synchronization links. Bake their start times before making an independent finished version.');
    if (['html', 'htmlPaint', 'surface', 'surfacePaint', 'shaderPaint'].includes(node.tag)) throw new Error('Custom-rendered scenes need a static copy before audio finishing.');
    node.children.forEach(validate);
  };
  validate(snapshot);
  assertCurrent(); await flushProjectEdits(dir); assertCurrent();
  const stats = await audioSourceStats(snapshot, library, assertCurrent);
  options.onProgress?.('Rendering dialogue without the selected background tracks…');
  const wav = await sceneAudioWav(world, scene, dir, { signal, excludeSources: music.map((track) => track.id) }); assertCurrent();
  options.onProgress?.('Leveling and measuring dialogue locally…');
  const processed = await runLocalAudioFinishing({ action: 'finish', wav, targetLufs: options.targetLufs, truePeakDb: options.truePeakDb, levelDialogue: options.levelDialogue, denoise: options.denoise }, signal); assertCurrent();
  if (!processed.wav || !processed.output) throw new Error('Audio finishing returned no complete derivative.');
  const pcm = await decodeFinishingAudio(new Blob([processed.wav as Uint8Array<ArrayBuffer>], { type: 'audio/wav' }), signal); assertCurrent();
  const activity = dialogueActivity(pcm, options.activityThresholdDb ?? -42);
  const ducking = planMusicDucking(activity, duration, options.duckingDb ?? 12);
  await verifyAudioSources(stats, library, assertCurrent);
  const derivative = await library.store(new Blob([processed.wav as Uint8Array<ArrayBuffer>], { type: 'audio/wav' }), { name: `Finished-dialogue-${crypto.randomUUID()}.wav` });
  await library.flush(); assertCurrent();
  const variant = cloneReframeTree(snapshot);
  const background = variant.children.filter((_node, index) => musicIndices.has(index));
  variant.children = variant.children.filter((_node, index) => !musicIndices.has(index));
  const mute = (node: AuthoredTree): void => {
    if (['audio', 'video', 'videoPaint'].includes(node.tag)) node.props.muted = true;
    node.children.forEach(mute);
  };
  variant.children.forEach(mute);
  if (background.length) variant.children.push(musicDuckingGroup(background, ducking, duration));
  variant.children.push({ tag: 'audio', props: { name: 'Finished dialogue', src: derivative.path, start: 0, sourceIn: 0, end: duration, volume: -sceneVolume }, children: [] });
  const name = `${String(snapshot.props.name ?? 'Scene')} · Audio finished`;
  const right = Math.max(0, ...getEntityChildren(world, root).map((node) => { const props = authoredElement(node)?.props; return Number(props?.x ?? 0) + Number(props?.width ?? 0); }).filter(Number.isFinite));
  Object.assign(variant.props, { name, x: right + 120, y: snapshot.props.y ?? 0 });
  delete variant.props.workarea;
  options.onProgress?.('Creating the editable finished scene…'); assertCurrent();
  const editor = getDocumentEditor(world); const history = getEditHistory(world);
  const before = new Set(world.query(Source)); const reported = new Set<string>();
  const unlisten = editor.onEdit((edit) => { if (edit.kind === 'insert') reported.add(edit.source); });
  let created: Entity | undefined;
  history.beginGesture();
  try { [created] = editor.insertElement(root, () => renderAuthored(variant)); if (!created) throw new Error('The finished scene could not be inserted.'); }
  catch (error) {
    for (const entity of world.query(Source).filter((node) => !before.has(node))) {
      if (!entity.isAlive()) continue; const id = entity.get(Source)?.value;
      if (id && isPendingSource(id)) { if (reported.has(id)) editor.remove(entity); else editor.discardPending(id); }
    }
    throw error;
  } finally { unlisten(); history.endGesture(); }
  editor.activate(created); editor.select(created);
  focusRect(world, { x: Number(variant.props.x), y: Number(variant.props.y ?? 0), width: Number(variant.props.width ?? 1920), height: Number(variant.props.height ?? 1080) });
  try { await flushProjectEdits(dir); }
  catch (cause) { throw new Error('The finished scene was created but could not be saved. Retry saving before creating another version.', { cause }); }
  const sceneId = created.get(Source)?.value;
  if (!sceneId) throw new Error('The saved finished scene is no longer available. Reopen the project to review it.');
  const warnings = [...processed.warnings];
  if (music.length) warnings.push('Music ducking follows audio activity in the dialogue mix, not recognized speakers. Adjust the group volume keyframes after listening.');
  let mix: AudioLoudnessMeasurement | undefined;
  try {
    assertCurrent(); options.onProgress?.('Checking the finished dialogue-and-music mix…');
    mix = (await measureSceneAudio(world, created, dir, options)).measurement;
    if (mix.truePeakDb !== null && mix.truePeakDb > (options.truePeakDb ?? -1) + 0.1) warnings.push(`The combined mix reaches ${mix.truePeakDb.toFixed(1)} dBTP. Lower the music or scene volume before export.`);
  } catch (error) { warnings.push(`The finished scene is saved; final mix measurement did not complete: ${error instanceof Error ? error.message : String(error)}`); }
  return { sceneId, name, outputPath: derivative.path, input: processed.input, dialogue: processed.output, mix, musicKeyframeCount: music.length ? ducking.length : 0, warnings };
}
