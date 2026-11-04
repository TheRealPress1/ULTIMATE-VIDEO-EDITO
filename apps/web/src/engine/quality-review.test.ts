import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Entity, World } from 'koota';

const mocks = vi.hoisted(() => ({
  capture: vi.fn(), encoder: vi.fn(), warmup: vi.fn(), tree: vi.fn(), library: vi.fn(),
  asset: vi.fn(), file: vi.fn(), flush: vi.fn(), ipc: vi.fn(), hasAudio: vi.fn(), pcm: vi.fn(), buffers: vi.fn(), disposeInput: vi.fn(), bounds: vi.fn(),
}));
vi.mock('./capture', () => ({ createCapture: mocks.capture }));
vi.mock('@diffusionstudio/encoder', () => ({ createImageEncoder: mocks.encoder, warmupAssets: mocks.warmup, createEncoder: vi.fn() }));
vi.mock('@diffusionstudio/runtime', () => ({
  Animation:'animation',Keyframe:'keyframe',KeyframeTrack:'keyframe-track',AssetId: 'asset', Caption: 'caption', Chars: 'chars', Computed: 'computed', FrameRate: 'fps',
  Hidden: 'hidden', Source: 'source', TextCache: 'text-cache', Workarea: 'workarea', WorldBounds: 'bounds',
  Audio: 'audio', Muted: 'muted', Paint: 'paint', PaintType: { VIDEO: 'video' },
  getParentNode: (entity: { parent?: unknown }) => entity.parent ?? null,
  store: () => mocks.bounds(),
  getAsset: mocks.asset, getAssetFile: mocks.file, getEntityTree: mocks.tree,
  getLibrary: mocks.library, isScene: () => true,
}));
vi.mock('./scene-audio', async (original) => ({ ...await original<typeof import('./scene-audio')>(), encodeScenePcm: mocks.pcm, hasAudio: mocks.hasAudio }));
vi.mock('mediabunny', () => ({
  ALL_FORMATS: [], BlobSource: class {},
  Input: class { getPrimaryAudioTrack = async () => ({}); dispose = mocks.disposeInput; },
  AudioBufferSink: class { buffers() { return mocks.buffers(); } },
}));
vi.mock('@/projects/edits', () => ({ flushProjectEdits: mocks.flush }));
vi.mock('@/lib/ipc', () => ({ mainBridge: { call: mocks.ipc } }));
vi.mock('@desktop/main-channels', () => ({ MAIN_CHANNELS: { PROJECTS_VERSIONS: 'versions', ANALYSIS_CACHE_GET: 'cache-get', ANALYSIS_CACHE_PUT: 'cache-put', ANALYSIS_CACHE_CANCEL: 'cache-cancel' } }));

import { reviewScene } from './quality-review';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function fixture() {
  const computed = { start: 0, end: 0, duration: 0, width: 1920, height: 1080 };
  const scene = { isAlive: () => true, get: (trait: string) => trait === 'source' ? { value: 'index.tsx:scene' } : trait === 'computed' ? computed : undefined } as unknown as Entity;
  const world = { get: (trait: string) => trait === 'fps' ? { value: 30 } : undefined } as unknown as World;
  const capture = { world: {}, node: { has: () => false, get: (trait: string) => trait === 'computed' ? computed : undefined }, dispose: vi.fn() };
  const encoder = { render: vi.fn().mockResolvedValue({ type: 'success', data: [] }), cancel: vi.fn() };
  const stat = { size: 1024, mtime: 100 };
  const library = { fs: { stat: vi.fn(async () => ({ ...stat })) } };
  const asset = { id: 'asset-id', source: '/project/clip.mp4', stat: { ...stat } };
  mocks.capture.mockResolvedValue(capture);
  mocks.encoder.mockResolvedValue(encoder);
  mocks.warmup.mockImplementation(async () => { Object.assign(computed, { end: 300, duration: 300 }); });
  mocks.tree.mockReturnValue([]);
  mocks.library.mockReturnValue(library);
  mocks.asset.mockReturnValue(asset);
  mocks.file.mockResolvedValue(new Blob());
  mocks.ipc.mockResolvedValue({ fingerprint: 'source-version' });
  mocks.flush.mockResolvedValue(undefined);
  mocks.hasAudio.mockReturnValue(false);
  mocks.bounds.mockReturnValue({ minX: [], minY: [], maxX: [], maxY: [] });
  return { world, scene, capture, encoder, computed, stat, library, asset };
}

let nextNodeId = 0;
function reviewNode(traits: Record<string, unknown>, parent?: unknown) {
  const id = nextNodeId++;
  if (traits.bounds) for (const [key, value] of Object.entries(traits.bounds)) mocks.bounds()[key][id] = value;
  return { parent, id: () => id, has: (trait: string) => trait in traits, get: (trait: string) => trait === 'bounds' ? undefined : traits[trait] };
}

function renderFrame(f: ReturnType<typeof fixture>) {
  const pixels = { width: 360, height: 202, data: new Uint8ClampedArray(360 * 202 * 4).fill(255) };
  f.encoder.render.mockImplementation(async () => {
    mocks.encoder.mock.calls[0]![1].onFrame(30, { width: pixels.width, height: pixels.height, getContext: () => ({ getImageData: () => pixels }) });
    return { type: 'success', data: [] };
  });
}

beforeEach(() => { vi.resetAllMocks(); nextNodeId = 0; });

describe('rendered quality review lifecycle', () => {
  it('rejects an overlong scene before rendering even when its workarea is short', async () => {
    const f = fixture();
    mocks.warmup.mockImplementation(async () => { Object.assign(f.computed, { end: 7201 * 30, duration: 7201 * 30 }); });
    f.capture.node.get = (trait: string) => trait === 'computed' ? f.computed : trait === 'workarea' ? { start: 7200 * 30, end: 7201 * 30 } as never : undefined;
    await expect(reviewScene(f.world, f.scene, '/project')).rejects.toThrow('scenes up to two hours');
    expect(mocks.encoder).not.toHaveBeenCalled(); expect(mocks.pcm).not.toHaveBeenCalled();
    expect(f.capture.dispose).toHaveBeenCalledOnce();
  });

  it('waits for media warmup before reading duration and scheduling frames', async () => {
    const f = fixture();
    const pending = deferred<void>();
    mocks.warmup.mockImplementation(async () => {
      await pending.promise;
      Object.assign(f.computed, { end: 900, duration: 900 });
    });
    const task = reviewScene(f.world, f.scene, '/project', { audio: false });
    await vi.waitFor(() => expect(mocks.warmup).toHaveBeenCalledWith(f.capture.world));
    expect(mocks.encoder).not.toHaveBeenCalled();
    pending.resolve();
    const report = await task;
    expect(report.duration).toBe(30);
    expect(mocks.encoder.mock.calls[0]![1].frames).toEqual(expect.arrayContaining([0, 899]));
    expect(report.sampledFrames).toBeGreaterThan(2);
    expect(f.capture.dispose).toHaveBeenCalledOnce();
  });

  it('cancels an encoder initialized after abort and disposes the capture', async () => {
    const f = fixture();
    const pending = deferred<typeof f.encoder>();
    mocks.encoder.mockReturnValue(pending.promise);
    const controller = new AbortController();
    const task = reviewScene(f.world, f.scene, '/project', { signal: controller.signal });
    const rejected = expect(task).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(mocks.encoder).toHaveBeenCalledOnce());
    controller.abort();
    pending.resolve(f.encoder);
    await rejected;
    expect(f.encoder.cancel).toHaveBeenCalledOnce();
    expect(f.capture.dispose).toHaveBeenCalledOnce();
    const next = fixture();
    await expect(reviewScene(next.world, next.scene, '/project')).resolves.toMatchObject({ duration: 10 });
  });

  it('rejects a media file modified during rendering and preserves the source', async () => {
    const f = fixture();
    const media = { get: (trait: string) => trait === 'asset' ? { value: 'asset-id' } : undefined };
    mocks.tree.mockImplementation((world) => world === f.world ? [media] : []);
    f.encoder.render.mockImplementation(async () => { f.stat.mtime++; return { type: 'success', data: [] }; });
    await expect(reviewScene(f.world, f.scene, '/project')).rejects.toThrow('media file changed during review');
    expect(f.capture.dispose).toHaveBeenCalledOnce();
    expect(f.asset.stat.mtime).toBe(100);
    expect(f.library.fs.stat).toHaveBeenCalledTimes(2);
  });

  it('rejects stale project fingerprints after a successful render', async () => {
    const f = fixture();
    mocks.ipc.mockResolvedValueOnce({ fingerprint: 'before' }).mockResolvedValueOnce({ fingerprint: 'after' });
    await expect(reviewScene(f.world, f.scene, '/project')).rejects.toThrow('project changed during review');
    expect(f.capture.dispose).toHaveBeenCalledOnce();
  });

  it('releases captures and the single-review lock after preparation and render failures', async () => {
    const first = fixture();
    mocks.warmup.mockRejectedValueOnce(new Error('Unreadable media'));
    await expect(reviewScene(first.world, first.scene, '/project')).rejects.toThrow('Unreadable media');
    expect(mocks.encoder).not.toHaveBeenCalled();
    expect(first.capture.dispose).toHaveBeenCalledOnce();
    const second = fixture();
    second.encoder.render.mockRejectedValueOnce(new Error('Render failed'));
    await expect(reviewScene(second.world, second.scene, '/project')).rejects.toThrow('Render failed');
    expect(second.capture.dispose).toHaveBeenCalledOnce();
    const third = fixture();
    await expect(reviewScene(third.world, third.scene, '/project')).resolves.toMatchObject({ duration: 10 });
  });

  it('flags audible clip joins but excludes text, muted clips and hidden or muted ancestors', async () => {
    const f = fixture();
    const timing = (seconds: number) => ({ start: seconds * 30, end: 300 });
    const text = reviewNode({ computed: timing(1), chars: { value: 'Title' } }, f.capture.node);
    const muted = reviewNode({ asset: {}, audio: {}, muted: {}, computed: timing(2) }, f.capture.node);
    const voice = reviewNode({ asset: {}, audio: {}, computed: timing(3) }, f.capture.node);
    const mutedParent = reviewNode({ muted: {} }, f.capture.node);
    const mutedChild = reviewNode({ asset: {}, audio: {}, computed: timing(5) }, mutedParent);
    const hiddenParent = reviewNode({ hidden: {} }, f.capture.node);
    const hiddenVideo = reviewNode({ asset: {}, paint: { value: 'video' }, computed: timing(6) }, hiddenParent);
    mocks.tree.mockImplementation((world) => world === f.capture.world ? [text, muted, voice, mutedParent, mutedChild, hiddenParent, hiddenVideo] : []);
    mocks.hasAudio.mockReturnValue(true);
    mocks.pcm.mockResolvedValue(new Blob());
    const samples = new Float32Array(80000).fill(.1);
    for (const time of [1, 2, 3, 5, 6]) samples[time * 8000] = .6;
    mocks.buffers.mockImplementation(async function* () {
      yield { timestamp: 0, buffer: { sampleRate: 8000, numberOfChannels: 1, length: samples.length, getChannelData: () => samples } };
    });
    const report = await reviewScene(f.world, f.scene, '/project');
    expect(report.audioReviewed).toBe(true);
    expect(report.findings.filter((finding) => finding.code === 'audio-join').map((finding) => finding.time)).toEqual([3]);
    expect(mocks.disposeInput).toHaveBeenCalledOnce();
  });

  it('reviews pauses with caller thresholds under their own saved-section key', async () => {
    const f = fixture();
    mocks.hasAudio.mockReturnValue(true);
    mocks.pcm.mockResolvedValue(new Blob());
    // Steady tone at 8 kHz with half a second of digital silence at 4 s.
    const samples = new Float32Array(80000).fill(.1);
    samples.fill(0, 32000, 36000);
    mocks.buffers.mockImplementation(async function* () {
      yield { timestamp: 0, buffer: { sampleRate: 8000, numberOfChannels: 1, length: samples.length, getChannelData: () => samples } };
    });
    const keys = () => mocks.ipc.mock.calls.filter(([channel]) => channel === 'cache-get').map(([, data]) => JSON.parse(data.key));
    const standard = await reviewScene(f.world, f.scene, '/project');
    expect(standard.findings.filter((finding) => finding.code === 'audio-silence')).toEqual([]);
    const tight = await reviewScene(f.world, f.scene, '/project', { pauses: { thresholdDb: -45, minSeconds: .25 } });
    expect(tight.findings.filter((finding) => finding.code === 'audio-silence').map((finding) => [finding.time, finding.end])).toEqual([[4, 4.5]]);
    const [first, second] = keys();
    expect(first).toHaveLength(7);
    expect(second).toEqual([...first, -45, .25]);
  });

  it('lists every residual pause of a tight review separately instead of one span over the speech between them', async () => {
    const f = fixture();
    mocks.hasAudio.mockReturnValue(true);
    mocks.pcm.mockResolvedValue(new Blob());
    const samples = new Float32Array(80000).fill(.1);
    for (const at of [1, 2.5, 4]) samples.fill(0, at * 8000, (at + .3) * 8000);
    mocks.buffers.mockImplementation(async function* () {
      yield { timestamp: 0, buffer: { sampleRate: 8000, numberOfChannels: 1, length: samples.length, getChannelData: () => samples } };
    });
    const report = await reviewScene(f.world, f.scene, '/project', { pauses: { thresholdDb: -45, minSeconds: .25 } });
    const pauses = report.findings.filter((finding) => finding.code === 'audio-silence');
    expect(pauses.map((finding) => [finding.time, finding.end].map((time) => Math.round(time! * 1000) / 1000))).toEqual([[1, 1.3], [2.5, 2.8], [4, 4.3]]);
    expect(pauses.every((finding) => /for 0\.30s/.test(finding.message))).toBe(true);
  });

  it('classifies generated caption text on its Caption entity while ignoring styling children', async () => {
    const f = fixture();
    const computed = { start: 0, end: 300, visibility: 1, opacity: 1, width: 320 };
    const caption = reviewNode({ caption: {}, chars: { value: 'Current generated words' }, computed,
      source: { value: 'index.tsx:captions' }, bounds: { minX: 20, minY: 180, maxX: 340, maxY: 210 },
      'text-cache': { tokens: [[{ width: 300 }]] } }, f.capture.node);
    // Current presets generate TextRange/Paint children; Chars and bounds
    // remain on the Caption node that users can navigate to and edit.
    const styleRange = reviewNode({ 'text-range': {}, computed }, caption);
    const ordinaryText = reviewNode({ chars: { value: 'Title' }, computed, source: { value: 'index.tsx:title' },
      bounds: { minX: -20, minY: 20, maxX: 100, maxY: 70 } }, f.capture.node);
    mocks.tree.mockImplementation((world) => world === f.capture.world ? [caption, styleRange, ordinaryText] : []);
    renderFrame(f);
    const report = await reviewScene(f.world, f.scene, '/project', { audio: false });
    expect(report.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'caption-overflow', node: 'index.tsx:captions', evidence: 'layout' }),
      expect.objectContaining({ code: 'text-overflow', node: 'index.tsx:title', evidence: 'layout' }),
    ]));
    expect(report.findings).toHaveLength(2);
  });

  it('reports caption safe-area placement without misclassifying it as overflow', async () => {
    const f = fixture();
    const caption = reviewNode({ caption: {}, chars: { value: 'Legible but under platform controls' },
      source: { value: 'index.tsx:captions' }, computed: { start: 0, end: 300, visibility: 1, opacity: 1, width: 320 },
      bounds: { minX: 20, minY: 175, maxX: 340, maxY: 195 } }, f.capture.node);
    mocks.tree.mockImplementation((world) => world === f.capture.world ? [caption] : []);
    renderFrame(f);
    const report = await reviewScene(f.world, f.scene, '/project', { audio: false });
    expect(report.findings).toEqual([expect.objectContaining({ code: 'caption-safe-area', node: 'index.tsx:captions' })]);
  });
});


describe('long recording review', () => {
  it('covers ninety minutes with bounded frame sections rather than dropping the tail', async () => {
    const f=fixture();mocks.warmup.mockImplementation(async()=>Object.assign(f.computed,{end:5400*30,duration:5400*30}));
    const report=await reviewScene(f.world,f.scene,'/project',{audio:false});
    expect(report.duration).toBe(5400);expect(mocks.encoder).toHaveBeenCalledTimes(45);
    expect(mocks.encoder.mock.calls.every(([,options])=>options.frames.length<=120)).toBe(true);
    expect(mocks.encoder.mock.calls.at(-1)![1].frames).toContain(5400*30-1);
  });
  it('renders only bounded audio windows including both sides of section joins', async () => {
    const f=fixture();mocks.warmup.mockImplementation(async()=>Object.assign(f.computed,{end:250*30,duration:250*30}));mocks.hasAudio.mockReturnValue(true);
    let length=0;mocks.pcm.mockImplementation(async(_w,_s,_d,{window})=>{length=Math.round((window.end-window.start)*8000);return new Blob();});
    mocks.buffers.mockImplementation(async function*(){const samples=new Float32Array(length).fill(.1);yield{timestamp:0,buffer:{sampleRate:8000,numberOfChannels:1,length,getChannelData:()=>samples}};});
    const report=await reviewScene(f.world,f.scene,'/project');
    expect(report.audioReviewed).toBe(true);expect(mocks.pcm.mock.calls.map(c=>c[3].window)).toEqual([{start:0,end:121},{start:119,end:241},{start:239,end:250}]);
  });
  it('resumes only completed sections after cancellation without rendering them again', async () => {
    const f=fixture(),controller=new AbortController();mocks.warmup.mockImplementation(async()=>Object.assign(f.computed,{end:250*30,duration:250*30}));
    const chunks:Record<string,unknown>={};let cancel=true;
    mocks.ipc.mockImplementation(async(channel,data)=>{
      if(channel==='cache-get')return{fingerprint:'a'.repeat(64),chunks:{...chunks}};
      if(channel==='cache-put'){chunks[data.chunk]=data.value;if(cancel){cancel=false;controller.abort();}return;}
      return{fingerprint:'source-version'};
    });
    await expect(reviewScene(f.world,f.scene,'/project',{signal:controller.signal,audio:false})).rejects.toMatchObject({name:'AbortError'});
    expect(Object.keys(chunks)).toEqual(['section-0']);expect(mocks.encoder).toHaveBeenCalledOnce();
    const report=await reviewScene(f.world,f.scene,'/project',{audio:false});
    expect(mocks.encoder).toHaveBeenCalledTimes(3);expect(Object.keys(chunks)).toHaveLength(3);expect(report.limitations.join(' ')).toContain('reused 1 completed section');
  });
  it('does not cache observations after a project edit lands during rendering', async () => {
    const f=fixture();let changed=false;
    mocks.ipc.mockImplementation(async(channel)=>channel==='cache-get'?{fingerprint:'a'.repeat(64),chunks:{}}:{fingerprint:changed?'different':'source-version'});
    f.encoder.render.mockImplementation(async()=>{changed=true;return{type:'success',data:[]};});
    await expect(reviewScene(f.world,f.scene,'/project',{audio:false})).rejects.toThrow('project changed');
    expect(mocks.ipc.mock.calls.some(([name])=>name==='cache-put')).toBe(false);
  });
});

it('does not count camera keyframes as drawable layers in a long interview', async () => {
  const f=fixture();const keys=Array.from({length:5000},()=>({has:(trait:string)=>trait==='keyframe',get:()=>undefined}));
  mocks.tree.mockReturnValue(keys);await expect(reviewScene(f.world,f.scene,'/project',{audio:false})).resolves.toMatchObject({duration:10});
});
