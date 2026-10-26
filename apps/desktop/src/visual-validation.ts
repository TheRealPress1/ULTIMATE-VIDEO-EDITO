import { VISUAL_MAX_SAMPLES, VISUAL_MAX_SECONDS, type VisualAnalysis, type VisualEvidence, type VisualSampleWindow } from './visual-types';
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** Validate disk/native data into a bounded evidence schema without extra payloads. */
export function validateVisualAnalysis(value: unknown, duration: number, sourceStart?: number, window?: VisualSampleWindow): VisualAnalysis {
  const startIndex = window?.startIndex ?? 0;
  const total = object(value) && finite(value.sampleInterval) ? Math.ceil(duration / value.sampleInterval - 1e-9) : 0;
  const endIndex = window?.endIndex ?? total;
  if (!Number.isInteger(startIndex) || !Number.isInteger(endIndex) || startIndex < 0 || endIndex <= startIndex || endIndex > total || total > VISUAL_MAX_SAMPLES) throw new Error('Invalid visual sample window.');
  if (!object(value) || !finite(value.duration) || Math.abs(value.duration - duration) > 0.001 || duration <= 0 || duration > VISUAL_MAX_SECONDS ||
    !finite(value.sourceStart) || value.sourceStart < 0 || value.sourceStart > 86400 || (sourceStart !== undefined && Math.abs(sourceStart - value.sourceStart) > 0.000001) ||
    !finite(value.width) || !Number.isInteger(value.width) || value.width < 1 || value.width > 65536 ||
    !finite(value.height) || !Number.isInteger(value.height) || value.height < 1 || value.height > 65536 ||
    !finite(value.sampleInterval) || value.sampleInterval < 1 || value.sampleInterval > 30 ||
    !Array.isArray(value.samples) || value.samples.length < 1 || value.samples.length > VISUAL_MAX_SAMPLES ||
    value.samples.length !== endIndex - startIndex) throw new Error('Invalid visual index metadata.');
  const interval = value.sampleInterval;
  const evidence = (items: unknown, limit: number): VisualEvidence[] => {
    if (!Array.isArray(items) || items.length > limit) throw new Error('Invalid visual index evidence.');
    return items.map((item) => {
      if (!object(item) || typeof item.text !== 'string' || !item.text.trim() || item.text.length > 480 ||
        !finite(item.confidence) || item.confidence < 0 || item.confidence > 1) throw new Error('Invalid visual index evidence.');
      return { text: item.text, confidence: item.confidence };
    });
  };
  const start = value.sourceStart;
  let previous = -1;
  return { sourceStart: start, duration: value.duration, width: value.width, height: value.height, sampleInterval: interval,
    samples: value.samples.map((sample, index) => {
      if (!object(sample) || !finite(sample.time) || sample.time < 0 || sample.time >= duration || sample.time < previous ||
        !finite(sample.mediaTime) || Math.abs(sample.mediaTime - start - sample.time) > 0.000001 ||
        Math.abs(sample.time - (index + startIndex) * interval) > interval ||
        !finite(sample.people) || !Number.isInteger(sample.people) || sample.people < 0 || sample.people > 32) throw new Error('Invalid visual index sample.');
      previous = sample.time;
      return { time: sample.time, mediaTime: sample.mediaTime, people: sample.people, labels: evidence(sample.labels, 24), text: evidence(sample.text, 40) };
    }) };
}
