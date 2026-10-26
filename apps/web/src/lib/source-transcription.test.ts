import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks=vi.hoisted(()=>({file:vi.fn(),cache:vi.fn(),transcribe:vi.fn()}));
vi.mock('@diffusionstudio/runtime',()=>({getAssetFile:mocks.file}));
vi.mock('./footage-cache',()=>({requestFootage:mocks.cache}));
vi.mock('./local-transcription',()=>({transcribeLocally:mocks.transcribe}));
import { transcribeSource } from './source-transcription';
import { MAIN_CHANNELS as C } from '@desktop/main-channels';
const asset={id:'source',type:'VIDEO' as const,source:'/video.mp4',duration:5400} as Parameters<typeof transcribeSource>[0];
const segments=[{text:'Evidence',words:[{text:'Evidence',start:500,end:501}]}];
beforeEach(()=>{vi.clearAllMocks();mocks.file.mockResolvedValue(new Blob(['original']));mocks.transcribe.mockResolvedValue(segments);mocks.cache.mockImplementation(async(channel)=>({fingerprint:'a'.repeat(64),transcript:channel===C.FOOTAGE_INDEX_GET?null:segments}));});
describe('persistent original-source transcription',()=>{
 it('returns a complete cache without decoding source media',async()=>{mocks.cache.mockResolvedValueOnce({fingerprint:'a'.repeat(64),transcript:segments});expect(await transcribeSource(asset,{dir:'/project'})).toEqual(segments);expect(mocks.file).not.toHaveBeenCalled();});
 it('passes original compressed media to bounded transcription and commits only after completion',async()=>{await transcribeSource(asset,{dir:'/project'});expect(mocks.transcribe).toHaveBeenCalledWith(expect.any(Blob),expect.objectContaining({cache:{dir:'/project',source:'/video.mp4',duration:5400,expectedFingerprint:'a'.repeat(64)}}));expect(mocks.cache).toHaveBeenLastCalledWith(C.FOOTAGE_INDEX_PUT,expect.objectContaining({transcript:segments}),undefined);});
 it('does not commit a late completed transcript after navigation',async()=>{let active=true;mocks.transcribe.mockImplementation(async()=>{active=false;return segments;});await expect(transcribeSource(asset,{dir:'/project',assertCurrent:()=>{if(!active)throw new Error('project changed');}})).rejects.toThrow('project changed');expect(mocks.cache.mock.calls.some(([channel])=>channel===C.FOOTAGE_INDEX_PUT)).toBe(false);});
 it('keeps a requested window on the bounded path without allocating/extracting a whole-file audio blob',async()=>{await transcribeSource(asset,{dir:'/project',window:{start:400,end:1000}});expect(mocks.cache).not.toHaveBeenCalled();expect(mocks.transcribe).toHaveBeenCalledWith(expect.any(Blob),expect.objectContaining({window:{start:400,end:1000}}));});
});
