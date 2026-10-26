import { z } from 'zod';
import { defineTool } from '../tool';
import { AssetPath } from '../schemas';
const Item = z.object({ assetId: z.string(), path: z.string(), status: z.enum(['unindexed', 'ready', 'indexing', 'stale', 'error']),
  error: z.string().optional(), samples: z.int().nonnegative().optional(), sampleInterval: z.number().positive().optional() });
const Evidence = z.object({ text: z.string(), confidence: z.number().min(0).max(1) });
const Match = z.object({ id: z.string(), assetId: z.string(), path: z.string(), fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  time: z.number().nonnegative(), sourceIn: z.number().nonnegative(), sourceOut: z.number().positive(), score: z.number().min(-1).max(1),
  evidence: z.object({ time: z.number().nonnegative(), labels: z.array(Evidence), text: z.array(Evidence), people: z.int().nonnegative() }),
  matchedTerms: z.array(z.string()) });
export const visualIndex = defineTool({
  name: 'visual_index', title: 'Index local visual footage',
  description: 'Index imported local videos with macOS Vision image classification, OCR and people counts. Reads frames every five seconds by default, capped at 720 frames and two hours per source; the interval grows for long videos. Saves full-SHA-256-bound evidence in the project and reuses unchanged media across restarts. No upload, source edit or timeline change. The optional descriptions flag computes local CLIP embeddings using an explicitly downloaded model. Returns per-file errors; cancellation keeps completed native analysis sections for restart resume; optional description embeddings are saved per completed video. Image categories may include activities but are still-frame evidence, not temporal action recognition, identity recognition or general semantic scene understanding.',
  input: z.object({ paths: z.array(AssetPath).min(1).max(500).optional().describe('Imported video paths; omit for all videos.'),
    descriptions: z.boolean().default(false).describe('Also build local CLIP image embeddings at the same sampled times. Requires the user to download the description model in Footage → Visual first; this tool never downloads it. Maximum 20,000 samples per batch.') }),
  output: z.object({ items: z.array(Item) }), environment: 'renderer', annotations: { destructiveHint: false, openWorldHint: false },
});
export const visualSearch = defineTool({
  name: 'visual_search', title: 'Find visual B-roll candidates',
  description: 'Search indexed frames for objects, activities and visible text using description keywords and a small explicit synonym vocabulary. Every meaningful keyword must occur in the SAME sampled frame evidence; an empty query browses all samples. Default keywords mode is label/OCR retrieval. Set mode=description to rank sampled frames by local CLIP embedding cosine similarity; description scores are not probabilities and results can be irrelevant. Refreshes source fingerprints first. Returns confidence, exact observed source timestamp, and a suggested sourceIn/sourceOut audition range (not detected shot boundaries). Use grab/filmstrip to verify these candidates before inserting B-roll. Does not transcribe, identify people, infer chronology or prove an activity happened. Unindexed/changed/unavailable sources are returned separately; a missing match is not proof of absence.',
  input: z.object({ query: z.string().trim().max(1000).default(''), path: AssetPath.optional(), limit: z.int().min(1).max(200).default(50),
    mode: z.enum(['keywords', 'description']).default('keywords').describe('Description uses local CLIP image/text embedding cosine similarity instead of keyword matching. Requires previously built description indexes. English works best; queries truncate at 77 tokens. Similarity is not confidence or proof; review candidate frames.') }),
  output: z.object({ matches: z.array(Match), total: z.int().nonnegative(), unavailable: z.array(Item), method: z.enum(['sampled-labels-ocr', 'local-clip-cosine']),
    descriptionUnindexed: z.array(z.string()).optional() }),
  environment: 'renderer', annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
});
export const visualStatus = defineTool({
  name: 'visual_status', title: 'Inspect visual indexing status',
  description: 'Inspect the current project visual indexing batch and per-video cached status. Does not start a scan, modify media or wait for a running batch. Run visual_search after indexing to refresh source fingerprints before relying on results. Includes sample counts and spacing; sparse sampling can miss brief shots.',
  input: z.object({}), output: z.object({ indexing: z.boolean(), loading: z.boolean(), items: z.array(Item),
    progress: z.object({ completed: z.int().nonnegative(), total: z.int().nonnegative(), path: z.string(), frames: z.object({ completed: z.int().nonnegative(), total: z.int().positive() }).optional() }).optional() }),
  environment: 'renderer', annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
});
