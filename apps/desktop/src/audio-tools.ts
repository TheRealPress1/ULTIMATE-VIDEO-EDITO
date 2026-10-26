import { spawn } from 'node:child_process';
import { join } from 'node:path';

/** The binary and corresponding source/license are included beside the desktop JavaScript. */
export function resolveAudioToolsPath(appPath: string): string {
  return join(appPath, 'dist', 'audio-tools', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
}

export interface AudioToolRunOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  maxOutputBytes?: number;
  onStderr?: (chunk: string) => void;
}

/** Shared by audio finishing and container finalization. Arguments must come from trusted application code. */
export function runAudioTool(binary: string, args: readonly string[], options: AudioToolRunOptions = {}): Promise<{ stdout: string; stderr: string }> {
  options.signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(binary, [...args], { shell: false, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = ''; let stderr = ''; let bytes = 0; let failure: Error | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const stop = (error: Error): void => {
      if (failure) return;
      failure = error; child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 1500);
    };
    const abort = (): void => stop(options.signal?.reason instanceof Error ? options.signal.reason : new Error('Audio processing canceled.'));
    const timeout = setTimeout(() => stop(new Error('Audio processing exceeded its time limit. Try a shorter scene.')), options.timeoutMs ?? 600_000);
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    const collect = (buffer: Buffer, stream: 'stdout' | 'stderr'): void => {
      bytes += buffer.length;
      if (bytes > (options.maxOutputBytes ?? 1024 * 1024)) { stop(new Error('Audio processing returned too much diagnostic output.')); return; }
      const text = buffer.toString('utf8');
      if (stream === 'stdout') stdout += text;
      else { stderr += text; try { options.onStderr?.(text); } catch { /* Notification failure must not leak the process. */ } }
    };
    child.stdout.on('data', (data: Buffer) => collect(data, 'stdout'));
    child.stderr.on('data', (data: Buffer) => collect(data, 'stderr'));
    child.on('error', (error) => { failure ??= error; });
    child.on('close', (code, signal) => {
      clearTimeout(timeout); clearTimeout(killTimer); options.signal?.removeEventListener('abort', abort);
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error(`Local audio processing failed (${code ?? signal}): ${stderr.trim().slice(-3000)}`));
      else resolve({ stdout, stderr });
    });
  });
}
