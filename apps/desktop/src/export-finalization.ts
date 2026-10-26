import { randomUUID } from 'node:crypto';
import { open, rename, unlink } from 'node:fs/promises';
import { runAudioTool } from './audio-tools';
import type { ExportFinalization } from './export-finalization-types';

export function validateExportFinalization(value: ExportFinalization): void {
  if (!value || !['mp4','mov'].includes(value.format) || !Number.isInteger(value.audioBitrate) || value.audioBitrate < 32000 || value.audioBitrate > 512000) throw new Error('Invalid audio export settings.');
}

/** Native AAC exposes its delay to the muxer, which writes a correct edit list. */
export async function finalizePcmExport(binary: string, temp: string, config: ExportFinalization, signal: AbortSignal): Promise<void> {
  validateExportFinalization(config);signal.throwIfAborted();
  const output=`${temp}.${randomUUID()}.aac-final`;
  try {
    await runAudioTool(binary,['-hide_banner','-nostdin','-loglevel','error','-n','-i',temp,
      '-map','0:v?','-map','0:a:0','-map_metadata','0','-c:v','copy','-c:a','aac','-b:a',String(config.audioBitrate),
      '-movflags','+faststart','-use_editlist','1','-f',config.format,output],{signal,timeoutMs:1_800_000});
    signal.throwIfAborted();
    const finalized = await open(output, 'r');
    try { await finalized.sync(); } finally { await finalized.close(); }
    signal.throwIfAborted();
    await rename(output,temp);
  }finally{await unlink(output).catch(()=>{});}
}
