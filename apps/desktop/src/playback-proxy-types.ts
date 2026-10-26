/** Playback-only derivatives. Never replace a source asset or export input. */
export const PLAYBACK_PROXY_ENGINE = 'avfoundation-h264-720p-v1';
export const PLAYBACK_PROXY_MAX_SECONDS = 8 * 60 * 60;
export const PLAYBACK_PROXY_CACHE_BYTES = 10 * 1024 * 1024 * 1024;

export interface PlaybackProxyRequest {
  dir: string;
  source: string;
  /** Renderer lifetime identity, used by IPC to scope cache pins. */
  sessionId?: string;
  /** Content clock from the original video track, not the whole container. */
  sourceStart: number;
  duration: number;
  width: number;
  height: number;
  frameRate: number;
}
export interface PlaybackProxyJob extends PlaybackProxyRequest { id: string }
export interface PlaybackProxyDescriptor {
  path: string;
  fingerprint: string;
  sourceSignature: string;
  sourceStart: number;
  proxyStart: number;
  duration: number;
  /** Oriented proxy dimensions. Keep original asset geometry in the renderer. */
  width: number;
  height: number;
  frameRate: number;
  sourceWidth: number;
  sourceHeight: number;
  createdAt: string;
}
export interface PlaybackProxyResult {
  status: 'missing' | 'ready';
  fingerprint: string;
  sourceSignature: string;
  proxy?: PlaybackProxyDescriptor;
}
export interface PlaybackProxyProgress {
  id: string;
  phase: 'queued' | 'fingerprinting' | 'encoding' | 'verifying';
  completed: number;
  total: number;
}
export interface NativePlaybackProxyResult {
  sourceStart: number;
  proxyStart: number;
  duration: number;
  width: number;
  height: number;
  frameRate: number;
  sourceWidth: number;
  sourceHeight: number;
  frames: number;
}
