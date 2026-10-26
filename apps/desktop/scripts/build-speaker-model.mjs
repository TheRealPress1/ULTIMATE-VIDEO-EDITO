// Regular builds use checked-in model artifacts; no Python or download required.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { access, copyFile, mkdir, mkdtemp, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
if (process.platform !== 'darwin') process.exit(0);
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const manifest=JSON.parse(await readFile(join(root,'models','speaker-model.json'),'utf8'));
if(manifest.engine!=='light-asd-coreml-ava-v2'||manifest.checkpointSHA256!=='d44bc3ea7baa8e0946fa3921311714a630ed8b90a1928fab0dbe30d918909317'||JSON.stringify(Object.keys(manifest.variants??{}))!==JSON.stringify(['1','2','3','4','5','6']))throw new Error('Invalid speaker model provenance.');
for(const [duration,variant] of Object.entries(manifest.variants)){
 const name=Number(duration)===2?'LightASD.mlpackage':`LightASD-${duration}s.mlpackage`;
 if(variant.package!==name||!variant.files||!Number.isFinite(variant.parityMaxError)||variant.parityMaxError>=0.0001)throw new Error('Invalid speaker model variant.');
 const packagePath=join(root,'models',name);
 for(const [name,expected] of Object.entries(variant.files)){
  const path=resolve(packagePath,name);if(!path.startsWith(packagePath+sep))throw new Error('Invalid model manifest path.');
  if(createHash('sha256').update(await readFile(path)).digest('hex')!==expected)throw new Error(`Speaker model artifact changed: ${duration}s/${name}`);
 }
}
const dist=join(root,'dist');await mkdir(dist,{recursive:true});const staging=await mkdtemp(join(dist,'.speaker-model-'));
try{
 for(const [duration,variant] of Object.entries(manifest.variants)){
  execFileSync('xcrun',['coremlcompiler','compile',join(root,'models',variant.package),staging],{stdio:'inherit'});
  const built=join(staging,variant.package.replace('.mlpackage','.mlmodelc'));await access(join(built,'metadata.json'));
  const destination=join(dist,Number(duration)===2?'speaker-model.mlmodelc':`speaker-model-${duration}s.mlmodelc`);
  await rm(destination,{recursive:true,force:true});await rename(built,destination);
 }
 await copyFile(join(root,'models','speaker-model.json'),join(dist,'speaker-model.json'));
 await copyFile(join(root,'src','native','vendor','light-asd','LICENSE'),join(dist,'speaker-model-LICENSE.txt'));
}finally{await rm(staging,{recursive:true,force:true});}
