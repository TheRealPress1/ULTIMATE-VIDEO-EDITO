import { constants } from 'node:fs';
import { access, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeAudioPcm, measureAudioPcm } from './audio-pcm';
import { runAudioTool } from './audio-tools';
import { AUDIO_FINISH_MAX_BYTES } from './audio-finishing-types';
import type { AudioFinishingRequest, AudioFinishingResult, AudioLoudnessMeasurement } from './audio-finishing-types';
import type { DecodedAudioPcm } from './audio-pcm';

type Loudnorm = { input_i: string; input_tp: string; input_lra: string; input_thresh: string; target_offset: string; normalization_type?: string };
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const number = (value: string): number | null => Number.isFinite(Number(value)) ? Number(value) : null;

export function parseLoudnessReport(stderr: string): Loudnorm {
  const text = stderr.match(/\{\s*"input_i"[\s\S]*?\}/g)?.at(-1);
  if (!text) throw new Error('The bundled audio meter returned no complete loudness report.');
  const result = JSON.parse(text) as Loudnorm;
  if (['input_i', 'input_tp', 'input_lra', 'input_thresh', 'target_offset'].some((key) => typeof result[key as keyof Loudnorm] !== 'string' || !/^(?:[-+]?\d+(?:\.\d+)?|[-+]?inf)$/i.test(result[key as keyof Loudnorm]!))) throw new Error('The bundled audio meter returned invalid measurements.');
  return result;
}

function validate(request: AudioFinishingRequest): Required<AudioFinishingRequest> {
  if (!request || !/^[0-9a-f-]{36}$/i.test(request.id) || !['measure', 'finish'].includes(request.action)) throw new Error('Invalid audio finishing request.');
  const targetLufs = request.targetLufs ?? -16; const truePeakDb = request.truePeakDb ?? -1;
  if (!finite(targetLufs) || targetLufs < -36 || targetLufs > -9 || !finite(truePeakDb) || truePeakDb < -9 || truePeakDb > -0.1 ||
    (request.levelDialogue !== undefined && typeof request.levelDialogue !== 'boolean') || (request.denoise !== undefined && typeof request.denoise !== 'boolean')) throw new Error('Choose a loudness target from −36 to −9 LUFS and a true-peak ceiling from −9 to −0.1 dBTP.');
  return { ...request, targetLufs, truePeakDb, levelDialogue: request.levelDialogue ?? false, denoise: request.denoise ?? false };
}

/** Runs a pinned, local FFmpeg build against private temporary PCM files only. */
export class LocalAudioFinishingService {
  private active: { id: string; controller: AbortController } | null = null;
  private disposed = false;
  private readonly options: { runtimePath: string; timeoutMs?: number };
  constructor(options: { runtimePath: string; timeoutMs?: number }) { this.options = options; }

  available(): Promise<boolean> { return access(this.options.runtimePath, constants.X_OK).then(() => !this.disposed, () => false); }
  cancel(id: string): void { if (this.active?.id === id) this.active.controller.abort(new Error('Audio finishing canceled.')); }
  dispose(): void { this.disposed = true; this.active?.controller.abort(new Error('Audio finishing closed.')); }

  async run(input: AudioFinishingRequest): Promise<AudioFinishingResult> {
    if (this.disposed) throw new Error('The local audio service has closed.');
    if (this.active) throw new Error('Another audio finishing operation is running. Finish or cancel it first.');
    const request = validate(input);
    const task = { id: request.id, controller: new AbortController() };
    this.active = task;
    let folder: string | undefined;
    try {
      if (!await this.available()) throw new Error('This build is missing its bundled audio tools. Reinstall a complete UVE build.');
      const signal = task.controller.signal; signal.throwIfAborted();
      const pcm = decodeAudioPcm(request.wav);
      folder = await mkdtemp(join(tmpdir(), 'cutroom-audio-'));
      const source = join(folder, 'input.wav');
      await writeFile(source, request.wav, { mode: 0o600 }); signal.throwIfAborted();
      const sourceReport = await this.measure(source, pcm, request, signal);
      const warnings: string[] = [];
      if (sourceReport.measurement.fullScaleSamples) warnings.push('The source reaches full scale. Processing cannot recover previously clipped detail.');
      if (sourceReport.measurement.duration < 3) warnings.push('Very short clips provide limited loudness-range evidence.');
      if (request.action === 'measure') return { input: sourceReport.measurement, warnings };
      if (sourceReport.measurement.integratedLufs === null) throw new Error('There is no programme audio above the loudness gate to normalize.');

      let working = source; let report = sourceReport.report;
      const prefilters: string[] = [];
      if (request.denoise) {
        // Pinned FFmpeg 8.1.3 af_afftdn.c uses a 3-hop window and emits
        // its oldest hop: window_length - sample_advance = 2*floor(rate/80).
        // Pad its tail before filtering, then remove that algorithmic delay
        // and reset timestamps, so denoising neither shifts dialogue nor
        // discards the end of a sentence. This is unrelated to AAC priming.
        const delay = 2 * Math.floor(pcm.sampleRate / 80);
        prefilters.push(`apad=pad_len=${delay}`, 'afftdn=nr=8:nf=-50:tn=1', `atrim=start_sample=${delay}:end_sample=${pcm.frames + delay}`, 'asetpts=PTS-STARTPTS');
      }
      if (request.levelDialogue) prefilters.push('dynaudnorm=f=250:g=15:p=0.9:m=4:r=0.15:n=0:c=1');
      if (prefilters.length) {
        working = join(folder, 'prepared.wav');
        await this.process(source, working, prefilters.join(','), pcm, signal);
        const prepared = decodeAudioPcm(await this.readWav(working));
        report = (await this.measure(working, prepared, request, signal)).report;
        if (number(report.input_i) === null) throw new Error('The prepared dialogue has no measurable programme loudness.');
      }
      const filter = `loudnorm=I=${request.targetLufs}:TP=${request.truePeakDb}:LRA=11:measured_I=${report.input_i}:measured_TP=${report.input_tp}:measured_LRA=${report.input_lra}:measured_thresh=${report.input_thresh}:offset=${report.target_offset}:linear=true:print_format=json`;
      const finished = join(folder, 'finished.wav');
      const normalizationReport = parseLoudnessReport(await this.process(working, finished, filter, pcm, signal));
      let wav = await this.readWav(finished);
      let outputPcm = decodeAudioPcm(wav);
      if (outputPcm.frames !== pcm.frames || outputPcm.channels !== pcm.channels || outputPcm.sampleRate !== pcm.sampleRate) throw new Error('Audio finishing changed sample timing. The derivative was not accepted.');
      let output = (await this.measure(finished, outputPcm, request, signal)).measurement;
      // The final output rate can expose interpolation peaks absent from the
      // internal normalization rate. Measure the actual derivative and correct
      // conservatively rather than advertising an unverified peak ceiling.
      if (output.truePeakDb !== null && output.truePeakDb > request.truePeakDb + 0.05) {
        const corrected = join(folder, 'corrected.wav');
        const reduction = request.truePeakDb - output.truePeakDb - 0.15;
        await this.process(finished, corrected, `volume=${reduction}dB`, pcm, signal);
        wav = await this.readWav(corrected); outputPcm = decodeAudioPcm(wav);
        output = (await this.measure(corrected, outputPcm, request, signal)).measurement;
        warnings.push('A final gain reduction kept the measured true peak below the requested ceiling.');
      }
      if (output.truePeakDb !== null && output.truePeakDb > request.truePeakDb + 0.1) throw new Error('The finished audio did not meet its measured true-peak ceiling. No derivative was saved.');
      if (output.integratedLufs !== null && Math.abs(output.integratedLufs - request.targetLufs) > 1) warnings.push(`Measured output is ${output.integratedLufs.toFixed(1)} LUFS. Peak protection or the source dynamics prevented the exact requested loudness.`);
      if (request.denoise) warnings.push('Noise reduction is conservative spectral filtering. Listen for changed consonants or ambience before using this derivative.');
      if (request.levelDialogue) warnings.push('Dialogue leveling changes dynamic range. Use it on isolated speech, not an already balanced music mix.');
      signal.throwIfAborted();
      return { input: sourceReport.measurement, output, wav, normalization: normalizationReport.normalization_type?.toLowerCase() === 'linear' ? 'linear' : 'dynamic', warnings };
    } finally {
      if (folder) await rm(folder, { recursive: true, force: true }).catch(() => {});
      if (this.active === task) this.active = null;
    }
  }

  private async readWav(path: string): Promise<Uint8Array> {
    const info = await stat(path);
    if (info.size > AUDIO_FINISH_MAX_BYTES) throw new Error('Finished audio exceeded the 256 MiB limit.');
    return new Uint8Array(await readFile(path));
  }

  private async measure(path: string, pcm: DecodedAudioPcm, request: Required<AudioFinishingRequest>, signal: AbortSignal): Promise<{ report: Loudnorm; measurement: AudioLoudnessMeasurement }> {
    const output = await runAudioTool(this.options.runtimePath, ['-hide_banner', '-nostdin', '-nostats', '-i', path, '-map', '0:a:0', '-af', `loudnorm=I=${request.targetLufs}:TP=${request.truePeakDb}:LRA=11:print_format=json`, '-f', 'null', '-'], { signal, timeoutMs: this.options.timeoutMs });
    const report = parseLoudnessReport(output.stderr);
    return { report, measurement: { ...measureAudioPcm(pcm), integratedLufs: number(report.input_i), truePeakDb: number(report.input_tp), loudnessRangeLu: number(report.input_lra), thresholdLufs: number(report.input_thresh) } };
  }

  private async process(source: string, target: string, filter: string, pcm: DecodedAudioPcm, signal: AbortSignal): Promise<string> {
    const result = await runAudioTool(this.options.runtimePath, ['-hide_banner', '-nostdin', '-nostats', '-i', source, '-map', '0:a:0', '-af', `${filter},aresample=${pcm.sampleRate},atrim=end_sample=${pcm.frames},apad=whole_len=${pcm.frames}`, '-ar', String(pcm.sampleRate), '-ac', String(pcm.channels), '-c:a', 'pcm_f32le', '-f', 'wav', target], { signal, timeoutMs: this.options.timeoutMs });
    return result.stderr;
  }
}
