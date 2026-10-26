import { z } from 'zod';
import { defineTool } from '../tool';
import { NodeId } from '../schemas';

export const qualityReview = defineTool({
  name:'quality_review',title:'Review rendered scene',environment:'renderer',
  annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false},
  description:'Render and inspect the workarea of a scene up to two hours in resumable two-minute sections, each with up to 120 sampled frames including edit boundaries. Report clickable dark frames, borders, caption/text layout risks and optional clipping/silence/audio-join observations from bounded rendered audio windows. Completed sections persist locally and are reused only for unchanged project/media/settings. Local, read-only, no upload. Findings need human review; this is not lip-sync or editorial-quality detection. Stale results are rejected.',
  input:z.object({id:NodeId,audio:z.boolean().default(true)}),
  output:z.object({sceneId:z.string(),fingerprint:z.string(),createdAt:z.string(),duration:z.number(),sampledFrames:z.number(),audioReviewed:z.boolean(),limitations:z.array(z.string()),findings:z.array(z.object({code:z.string(),severity:z.enum(['warning','error']),message:z.string(),time:z.number(),end:z.number().optional(),node:z.string().optional(),evidence:z.enum(['pixels','layout','audio'])}))}),
});
