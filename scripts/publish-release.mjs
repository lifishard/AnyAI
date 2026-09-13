import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { normalizeLinuxAssets, verifyReleaseAssets } from './release-assets.mjs';
const version=JSON.parse(fs.readFileSync('package.json','utf8')).version,tag=`v${version}`;
if(process.env.GITHUB_REF!==`refs/tags/${tag}`)throw new Error('Release tag must match package.json');
if(!/^[a-f0-9]{40}$/.test(process.env.GITHUB_SHA||''))throw new Error('Missing source commit');
const dir=path.resolve(process.argv[2]||'release-assets');
normalizeLinuxAssets(dir,version);
const required=verifyReleaseAssets(dir,version);
const files=fs.readdirSync(dir).filter(n=>n.startsWith(`wickrunAI-${version}-`)||/^latest(?:-[a-z0-9-]+)?\.yml$/.test(n)).sort();
const manifest=files.map(name=>{const bytes=fs.readFileSync(path.join(dir,name));return{name,bytes:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex')};});
fs.writeFileSync(path.join(dir,'SHA256SUMS.txt'),manifest.map(f=>`${f.sha256}  ${f.name}`).join('\n')+'\n');
fs.writeFileSync(path.join(dir,'release-manifest.json'),JSON.stringify({version,commit:process.env.GITHUB_SHA,required,files:manifest},null,2));
files.push('SHA256SUMS.txt','release-manifest.json');
const gh=args=>execFileSync('gh',args,{encoding:'utf8',stdio:['ignore','pipe','pipe']});
let existing;
try{existing=JSON.parse(gh(['release','view',tag,'--json','isDraft']));}catch{}
if(existing&&!existing.isDraft)throw new Error(`${tag} is already public; refusing to replace published assets`);
const notes=path.join('docs','releases',`${tag}.md`);
if(!existing)gh(['release','create',tag,'--verify-tag','--draft','--title',`wickrunAI ${version}`,...(fs.existsSync(notes)?['--notes-file',notes]:['--generate-notes'])]);
gh(['release','upload',tag,...files.map(f=>path.join(dir,f)),'--clobber']);
const uploaded=JSON.parse(gh(['release','view',tag,'--json','assets'])).assets;
for(const name of files){const asset=uploaded.find(a=>a.name===name);if(!asset||asset.size!==fs.statSync(path.join(dir,name)).size)throw new Error(`Uploaded asset missing or wrong size: ${name}`);}
gh(['release','edit',tag,'--draft=false','--latest']);
console.log(gh(['release','view',tag,'--json','url','--jq','.url']));
