import { reviewScene } from '@/engine/quality-review';
import { requireScene } from '../lib/scene';
import type { ToolHandler } from '../handler';
export const qualityReview:ToolHandler<'quality_review'>=async({id,audio},ctx)=>{
  const session=ctx.requireSession(),dir=session.project.dir();
  return reviewScene(session.world,requireScene(session.world,id,'quality_review'),dir,{audio,signal:ctx.signal,assertCurrent:()=>{
    if(ctx.session()!==session||session.project.dir()!==dir)throw new Error('The open project changed during review.');
  }});
};
