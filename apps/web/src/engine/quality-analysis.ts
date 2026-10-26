/** Deterministic observations, not editorial judgments or lip-sync detection. */
export type QualityFinding = {
  code: string; severity: 'warning' | 'error'; message: string;
  time: number; end?: number; node?: string; evidence: 'pixels' | 'layout' | 'audio';
};
export type FramePixels = { width: number; height: number; data: Uint8ClampedArray };

export function inspectFramePixels(frame: FramePixels): { darkFraction: number; meanLuma: number; border: boolean } {
  const { width, height, data } = frame;
  if (width < 1 || height < 1 || data.length !== width * height * 4) throw new Error('Invalid review frame.');
  let dark = 0, luma = 0, edges = 0, darkEdges = 0;
  const insetX = Math.max(1, Math.floor(width * .025)), insetY = Math.max(1, Math.floor(height * .025));
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4;
    const value = (.2126 * data[i]! + .7152 * data[i + 1]! + .0722 * data[i + 2]!) * data[i + 3]! / 255;
    luma += value; if (value < 12) dark++;
    if (x < insetX || x >= width - insetX || y < insetY || y >= height - insetY) { edges++; if (value < 12) darkEdges++; }
  }
  const darkFraction = dark / (width * height);
  return { darkFraction, meanLuma: luma / (width * height), border: darkFraction < .8 && darkEdges / edges > .94 };
}

/** Uniform coverage plus both sides of edit boundaries, bounded before rendering. */
export function reviewFrames(start: number, end: number, fps: number, boundaries: number[] = [], limit = 120): number[] {
  if (![start, end, fps, limit].every(Number.isFinite) || start < 0 || end <= start || fps <= 0 || limit < 2) throw new Error('The scene has no reviewable duration.');
  const first = Math.ceil(start), last = Math.ceil(end) - 1;
  const frames = new Set<number>([first, last]);
  const regular = Math.min(Math.floor(limit / 2), Math.max(2, Math.ceil((end - start) / fps / 2)));
  for (let i = 0; i < regular; i++) frames.add(Math.round(first + (last - first) * i / Math.max(1, regular - 1)));
  for (const boundary of boundaries) for (const delta of [-1, 0, 1]) {
    const frame = Math.round(boundary) + delta;
    if (Number.isFinite(frame) && frame >= first && frame <= last && frames.size < limit) frames.add(frame);
  }
  return [...frames].sort((a, b) => a - b);
}

/** Merge repeated observations while retaining the first clickable moment. */
export function mergeQualityFindings(findings: QualityFinding[], gap: number, limit = 200): QualityFinding[] {
  const result: QualityFinding[] = [];
  for (const finding of [...findings].sort((a,b) => a.time - b.time)) {
    const previous = [...result].reverse().find(row => row.code === finding.code && row.node === finding.node);
    if (previous && finding.time - (previous.end ?? previous.time) <= gap) previous.end = finding.end ?? finding.time;
    else result.push({ ...finding });
  }
  return result.slice(0, limit);
}

export function inspectAudioSamples(channels: Float32Array[], sampleRate: number, joins: number[] = []): QualityFinding[] {
  if (!channels.length || !Number.isFinite(sampleRate) || sampleRate < 8000 || channels.some(c => c.length !== channels[0]!.length)) throw new Error('Invalid audio for review.');
  const findings: QualityFinding[] = [], count = channels[0]!.length;
  const block = Math.round(sampleRate * .05);
  let silentStart: number | undefined;
  for (let offset = 0; offset < count; offset += block) {
    let square = 0, peak = 0, n = 0;
    for (const samples of channels) for (let i = offset; i < Math.min(count, offset + block); i++) {
      const value = samples[i]!; if (!Number.isFinite(value)) throw new Error('Audio contains invalid samples.');
      square += value * value; peak = Math.max(peak, Math.abs(value)); n++;
    }
    if (peak >= .999) findings.push({ code:'audio-clipping',severity:'warning',message:'Samples reach full scale; listen for distortion.',time:offset/sampleRate,evidence:'audio' });
    const silent = Math.sqrt(square / Math.max(1,n)) < .001;
    if (silent && silentStart === undefined) silentStart = offset / sampleRate;
    if ((!silent || offset + block >= count) && silentStart !== undefined) {
      const end = Math.min(count, offset + (silent ? block : 0)) / sampleRate;
      if (end - silentStart >= 1) findings.push({code:'audio-silence',severity:'warning',message:'Very quiet audio for at least one second; confirm this pause is intentional.',time:silentStart,end,evidence:'audio'});
      silentStart = undefined;
    }
  }
  for (const time of joins) {
    const i = Math.round(time * sampleRate); if (i < 1 || i >= count) continue;
    const jump = Math.max(...channels.map(c => Math.abs(c[i]! - c[i-1]!)));
    if (jump > .2) findings.push({code:'audio-join',severity:'warning',message:'A sample discontinuity occurs at a clip boundary; listen for a click and add a short fade if needed.',time,evidence:'audio'});
  }
  return mergeQualityFindings(findings,.075);
}
