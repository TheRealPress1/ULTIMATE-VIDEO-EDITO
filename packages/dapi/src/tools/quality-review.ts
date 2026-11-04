import { z } from 'zod';
import { defineTool } from '../tool';
import { NodeId } from '../schemas';

/** Where the audio pass calls a quiet stretch a pause worth reporting; the defaults are -60 dBFS RMS for a second. */
export const QualityAudioThresholds = z.object({
  pauseThresholdDb: z.number().min(-70).max(-20).default(-60).describe('Unfiltered RMS level in dBFS (50 ms blocks) below which audio counts as quiet. Low rumble reads louder here than in transcript_edit_inspect\'s high-passed noiseFloorDb; raise it if expected pauses are missing.'),
  minPauseSeconds: z.number().min(0.1).max(5).default(1).describe('Shortest quiet stretch reported, in seconds.'),
});

export const qualityReview = defineTool({
  name:'quality_review',title:'Review rendered scene',environment:'renderer',
  annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false},
  description:'Render and inspect the workarea of a scene up to two hours in resumable two-minute sections, each with up to 120 sampled frames including edit boundaries. Report clickable dark frames, borders, caption/text layout risks and optional clipping/silence/audio-join observations from bounded rendered audio windows. audio may set the quiet-pause threshold and minimum length (for a tight talking-head cut, about -45 dBFS and 0.25 s) to list residual pauses, each as its own finding. Completed sections persist locally and are reused only for unchanged project/media/settings. Local, read-only, no upload. Findings need human review; this is not lip-sync or editorial-quality detection. Stale results are rejected.',
  input:z.object({id:NodeId,audio:z.union([z.boolean(),QualityAudioThresholds]).default(true).describe('false skips audio; an object reviews audio with these pause thresholds.')}),
  output:z.object({sceneId:z.string(),fingerprint:z.string(),createdAt:z.string(),duration:z.number(),sampledFrames:z.number(),audioReviewed:z.boolean(),limitations:z.array(z.string()),findings:z.array(z.object({code:z.string(),severity:z.enum(['warning','error']),message:z.string(),time:z.number(),end:z.number().optional(),node:z.string().optional(),evidence:z.enum(['pixels','layout','audio'])}))}),
});
