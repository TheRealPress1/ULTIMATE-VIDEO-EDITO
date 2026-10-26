import { existsSync } from 'node:fs';
import { mkdtemp,readFile,rm,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { describe,expect,it } from 'vitest';
import { finalizePcmExport,validateExportFinalization } from './export-finalization';
import { runAudioTool } from './audio-tools';
import { decodeAudioPcm } from './audio-pcm';
const binary=resolve('dist/audio-tools/ffmpeg');
describe('portable AAC finalization',()=>{
  it('rejects arbitrary formats and encoder settings',()=>{
    expect(()=>validateExportFinalization({format:'mp4',audioBitrate:128000})).not.toThrow();
    expect(()=>validateExportFinalization({format:'mp4',audioBitrate:Infinity})).toThrow();
    expect(()=>validateExportFinalization({format:'-y' as 'mp4',audioBitrate:128000})).toThrow();
  });
  it.skipIf(!existsSync(binary))('roundtrips an impulse at the original time with explicit AAC edit metadata',async()=>{
    const dir=await mkdtemp(join(tmpdir(),'uve-aac-test-'));
    try{
      const rate=48000,frames=rate*2,data=Buffer.alloc(44+frames*4);
      data.write('RIFF');data.writeUInt32LE(data.length-8,4);data.write('WAVEfmt ',8);data.writeUInt32LE(16,16);data.writeUInt16LE(3,20);data.writeUInt16LE(1,22);data.writeUInt32LE(rate,24);data.writeUInt32LE(rate*4,28);data.writeUInt16LE(4,32);data.writeUInt16LE(32,34);data.write('data',36);data.writeUInt32LE(frames*4,40);
      for(let i=rate/2;i<rate/2+480;i++)data.writeFloatLE(.6*Math.sin(2*Math.PI*1000*i/rate),44+i*4);
      const wav=join(dir,'source.wav'),movie=join(dir,'intermediate.mov'),decoded=join(dir,'decoded.wav');await writeFile(wav,data);
      await runAudioTool(binary,['-v','error','-i',wav,'-c:a','pcm_f32le','-f','mov',movie]);
      await finalizePcmExport(binary,movie,{format:'mp4',audioBitrate:128000},new AbortController().signal);
      const bytes=await readFile(movie);expect(bytes.includes(Buffer.from('elst'))).toBe(true);
      await runAudioTool(binary,['-v','error','-i',movie,'-c:a','pcm_f32le','-f','wav',decoded]);
      const pcm=decodeAudioPcm(await readFile(decoded));
      const start=pcm.samples.findIndex(v=>Math.abs(v)>.1)/rate;
      expect(Math.abs(start-.5)).toBeLessThan(.002);
      // AAC may retain less than one padded packet at its tail; it must not shift the signal.
      expect(Math.abs(pcm.frames/rate-2)).toBeLessThan(1024/rate);
    }finally{await rm(dir,{recursive:true,force:true});}
  },30000);
});
