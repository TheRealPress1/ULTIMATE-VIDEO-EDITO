import { Caption, Chars, Computed, Hidden, Source, TextCache, WorldBounds, getParentNode, store } from '@diffusionstudio/runtime';
import type { Entity, World } from 'koota';
import type { QualityFinding } from './quality-analysis';

/** Read the transform system's derived bounds, including text culled outside the picture. */
export function inspectTextLayout(world: World, nodes: readonly Entity[], picture: { width: number; height: number }, time: number): QualityFinding[] {
  const bounds = store(world, WorldBounds);
  const findings: QualityFinding[] = [];
  for (const node of nodes) {
    const computed = node.get(Computed);
    const text = computed?.chars ?? node.get(Chars)?.value;
    if (!computed || !text?.trim()) continue;
    let visible = true;
    for (let ancestor: Entity | null = node; ancestor; ancestor = getParentNode(ancestor)) {
      const values = ancestor.get(Computed);
      if (ancestor.has(Hidden) || values && (values.visibility <= 0 || values.opacity <= 0)) { visible = false; break; }
    }
    if (!visible) continue;
    // WorldBounds is written directly into SoA arrays, not attached as an
    // entity trait. node.get(WorldBounds) is undefined on normal runtime nodes.
    const id = node.id();
    const minX = bounds.minX[id], minY = bounds.minY[id], maxX = bounds.maxX[id], maxY = bounds.maxY[id];
    if (![minX, minY, maxX, maxY].every(Number.isFinite)) continue;
    const caption = node.has(Caption);
    const overflow = minX < -1 || minY < -1 || maxX > picture.width + 1 || maxY > picture.height + 1;
    const wordOverflow = node.get(TextCache)?.tokens?.some(line => line.some(token => token.width > computed.width + 1));
    const source = node.get(Source)?.value;
    if (overflow || wordOverflow) findings.push({
      code: caption ? 'caption-overflow' : 'text-overflow', severity: 'warning',
      message: caption ? 'Caption layout extends beyond its box or the picture. Check this wording and size.' : 'Text layout extends beyond its box or the picture.',
      time, node: source, evidence: 'layout',
    });
    else if (caption && (minX < picture.width * .05 || maxX > picture.width * .95 || maxY > picture.height * .88)) findings.push({
      code: 'caption-safe-area', severity: 'warning', message: 'Caption layout is near an edge where platform controls may cover it.',
      time, node: source, evidence: 'layout',
    });
  }
  return findings;
}
