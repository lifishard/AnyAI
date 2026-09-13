'use strict';
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {createDurableJson}=require('./durable-json.cjs');
const hash=buffer=>crypto.createHash('sha256').update(buffer).digest('hex');
const EXCLUDED=new Set(['.git','node_modules','.next','dist','build']);
function inside(root,p){const rel=path.relative(root,p);return !rel.startsWith('..'+path.sep)&&rel!=='..'&&!path.isAbsolute(rel);}
function noLinks(target){
 const absolute=path.resolve(target),parts=absolute.slice(path.parse(absolute).root.length).split(path.sep).filter(Boolean);let at=path.parse(absolute).root;
 for(const part of parts){at=path.join(at,part);try{if(fs.lstatSync(at).isSymbolicLink())throw Error('目录或祖先已被符号链接替换，停止文件操作');}catch(error){if(error.code!=='ENOENT')throw error;}}
 return absolute;
}
function identity(root){noLinks(root);const st=fs.statSync(root);if(!st.isDirectory())throw Error('文件协作范围必须是目录');return {realPath:fs.realpathSync.native(root),dev:String(st.dev),ino:String(st.ino),birthtimeMs:st.birthtimeMs};}
function sameDirectory(root,expected){
 if(!expected)throw Error('旧隔离记录缺少目录身份，请重新创建隔离区');
 const actual=identity(root);if(JSON.stringify(actual)!==JSON.stringify(expected))throw Error('目录身份已变化，停止文件操作');
}
function scan(root){identity(root);const files=Object.create(null);let bytes=0,count=0;
 function walk(dir){for(const ent of fs.readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){if(EXCLUDED.has(ent.name))continue;const full=path.join(dir,ent.name),st=fs.lstatSync(full);if(st.isSymbolicLink())throw Error('隔离范围含符号链接，请选择更小的目录：'+full);if(st.isDirectory()){walk(full);continue;}if(!st.isFile())throw Error('隔离范围包含非常规文件');bytes+=st.size;count++;if(bytes>128*1024*1024||count>10000)throw Error('隔离范围超过 128 MB 或 10000 文件，请缩小项目目录');const buf=fs.readFileSync(full);files[path.relative(root,full).split(path.sep).join('/')]=hash(buf);}}
 walk(root);return files;
}
function checked(root,rel){
 noLinks(root);if(typeof rel!=='string'||!rel||path.isAbsolute(rel)||rel.split(/[\\/]/).some(s=>s==='..'||s==='.'||!s||/[<>:"|?*\x00-\x1f]/.test(s)||/[. ]$/.test(s)||/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(s)))throw Error('文件路径无效');
 const target=path.resolve(root,rel);if(!inside(root,target))throw Error('路径超出隔离范围');noLinks(target);return target;
}
function createTeamFiles(userData){
 const base=path.resolve(userData,'team-files');let baseIdentity;
 function ensureBase(){noLinks(base);fs.mkdirSync(base,{recursive:true});if(baseIdentity)sameDirectory(base,baseIdentity);else baseIdentity=identity(base);noLinks(path.join(base,'sessions.json'));}
 const doc=createDurableJson(path.join(base,'sessions.json'),{initial:()=>({version:1,sessions:{}}),validate:d=>{if(d?.version!==1||!d.sessions)throw Error('文件协作记录版本无效');}});
 function save(rec){ensureBase();doc.update(d=>{d.sessions[rec.id]=rec;});return rec;}
 function rawGet(id){ensureBase();if(typeof id!=='string'||!/^[a-f0-9-]{36}$/i.test(id))throw Error('隔离编号无效');const rec=doc.read().sessions[id];if(!rec)throw Error('隔离记录不存在');return rec;}
 function check(rec){ensureBase();sameDirectory(rec.root,rec.rootIdentity);sameDirectory(rec.isolatedRoot,rec.isolatedIdentity);if(!inside(path.join(base,rec.id),rec.isolatedRoot))throw Error('隔离记录路径无效');}
 function journalPath(id){return path.join(base,id,'merge.json');}
 function readJournal(rec){
  const file=journalPath(rec.id);noLinks(file);if(!fs.existsSync(file))return null;
  const journal=JSON.parse(fs.readFileSync(file,'utf8'));
  if(journal.id!==rec.id||!Array.isArray(journal.files)||!['prepared','applying','committed','rolled_back','needs_review'].includes(journal.state)||!path.isAbsolute(journal.rollbackRoot)||!inside(path.join(base,rec.id),journal.rollbackRoot))throw Error('合并日志结构无效，需要人工核实');
  for(const f of journal.files){checked(rec.root,f.path);if(![f.beforeHash,f.afterHash].every(h=>h===null||/^[a-f0-9]{64}$/.test(h)))throw Error('合并日志哈希无效');}
  return journal;
 }
 function writeJournal(rec,journal){noLinks(journalPath(rec.id));createDurableJson(journalPath(rec.id),{initial:()=>({})}).write(journal);}
 function get(id){const rec=rawGet(id);let issue;
  try{check(rec);const journal=readJournal(rec);if(journal&&['prepared','applying','needs_review'].includes(journal.state))issue='上次合并中断，必须先核实并恢复；不会重复合并';if(journal?.state==='committed'&&rec.status!=='merged')issue='文件提交和状态记录不一致，必须核实并恢复';}catch(error){issue=error.message;}
  if(issue&&(!rec.recoveryRequired||rec.recoveryReason!==issue)){rec.recoveryRequired=true;rec.recoveryReason=issue;rec.status='conflict';save(rec);}return rec;
 }
 function create({projectId,taskId,memberId,root},allowedRoots){
  ensureBase();noLinks(root);root=fs.realpathSync.native(root);if(!allowedRoots.some(r=>root===fs.realpathSync.native(noLinks(r))))throw Error('请先在项目设置中选择该目录');
  if(inside(root,base)||inside(base,root))throw Error('不能把应用数据目录作为项目隔离范围');
  const rootIdentity=identity(root),baseline=scan(root),id=crypto.randomUUID(),isolatedRoot=path.join(base,id,'work');fs.mkdirSync(isolatedRoot,{recursive:true});
  for(const rel of Object.keys(baseline)){sameDirectory(root,rootIdentity);const dest=checked(isolatedRoot,rel);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.copyFileSync(checked(root,rel),dest);}
  sameDirectory(root,rootIdentity);
  if(JSON.stringify(scan(root))!==JSON.stringify(baseline)||JSON.stringify(scan(isolatedRoot))!==JSON.stringify(baseline))throw Error('复制期间项目文件发生变化，请重新创建隔离区');
  const rec={id,projectId,taskId,memberId,root,rootIdentity,isolatedRoot,isolatedIdentity:identity(isolatedRoot),status:'isolated',files:[],baseline,excluded:[...EXCLUDED],createdAt:Date.now()};return save(rec);
 }
 function diff(id){const rec=get(id);check(rec);if(rec.recoveryRequired)throw Error(rec.recoveryReason||'请先恢复中断合并');if(rec.status==='merged')return rec;
  const after=scan(rec.isolatedRoot);const files=[...new Set([...Object.keys(rec.baseline),...Object.keys(after)])].filter(p=>rec.baseline[p]!==after[p]).map(p=>({path:p,beforeHash:rec.baseline[p]??null,afterHash:after[p]??null,status:'pending'}));
  for(const file of files){const target=checked(rec.root,file.path);const now=fs.existsSync(target)?hash(fs.readFileSync(target)):null;if(now!==file.beforeHash)file.status='conflict';}
  rec.files=files;rec.status=files.some(f=>f.status==='conflict')?'conflict':'pending';return save(rec);
 }
 function preview(id,relativePath){const rec=get(id);check(rec);const file=rec.files.find(f=>f.path===relativePath);if(!file)throw Error('请先检查差异');const read=root=>{const p=checked(root,relativePath);if(!fs.existsSync(p))return null;const b=fs.readFileSync(p);if(b.length>512*1024||b.includes(0))return '[二进制或文件超过 512 KB，仅显示哈希]';return b.toString('utf8');};return {path:relativePath,before:read(rec.root),after:read(rec.isolatedRoot)};}
 function atomicReplace(target,bytes){noLinks(target);const tmp=target+'.wickrun-'+crypto.randomUUID()+'.tmp';let fd;try{fs.mkdirSync(path.dirname(target),{recursive:true});fd=fs.openSync(tmp,'wx',0o600);fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;noLinks(target);fs.renameSync(tmp,target);}finally{if(fd!==undefined)fs.closeSync(fd);try{fs.unlinkSync(tmp);}catch{}}}
 function rollback(rec,journal){
  check(rec);const work=[];
  // Preflight the entire rollback before altering any file. Changed user files
  // are never overwritten, even if a previous merge touched their siblings.
  for(const f of journal.files){const target=checked(rec.root,f.path),now=fs.existsSync(target)?hash(fs.readFileSync(target)):null;if(now===f.beforeHash)continue;if(now!==f.afterHash)throw Error('主文件既不匹配合并前也不匹配合并后，保留现场：'+f.path);let before=null;if(f.beforeHash){before=fs.readFileSync(checked(journal.rollbackRoot,f.path));if(hash(before)!==f.beforeHash)throw Error('合并前备份校验失败：'+f.path);}work.push({f,target,before});}
  for(const {f,target,before} of work){check(rec);const now=fs.existsSync(target)?hash(fs.readFileSync(target)):null;if(now!==f.afterHash)throw Error('恢复期间主文件变化，保留现场：'+f.path);if(before)atomicReplace(target,before);else if(fs.existsSync(target))fs.unlinkSync(target);}
  journal.state='rolled_back';writeJournal(rec,journal);
 }
 function recover(id){const rec=rawGet(id);check(rec);const journal=readJournal(rec);if(!journal)throw Error('没有可恢复的合并日志');if(rec.status==='merged'&&journal.state==='committed')throw Error('已完成合并不能通过中断恢复撤销，请新建修改');
  try{rollback(rec,journal);rec.recoveryRequired=false;delete rec.recoveryReason;rec.status='isolated';save(rec);return diff(id);}catch(error){rec.recoveryRequired=true;rec.recoveryReason=error.message;rec.status='conflict';save(rec);throw Error('恢复未完成，原件和日志保留：'+error.message);}
 }
 function merge(id,expectedFiles){
  const rec=diff(id);if(rec.status==='merged')throw Error('此隔离区已合并，不会重复执行');if(rec.status==='conflict')throw Error('主工作区已变化，需先处理冲突');
  if(JSON.stringify(rec.files.map(({path,beforeHash,afterHash})=>({path,beforeHash,afterHash})))!==JSON.stringify(expectedFiles))throw Error('差异已变化，请重新检查后合并');
  check(rec);const rollbackRoot=path.join(base,id,'pre-merge-'+crypto.randomUUID());fs.mkdirSync(rollbackRoot,{recursive:true});
  const journal={id,at:Date.now(),state:'prepared',files:rec.files,rollbackRoot};
  const prior=journalPath(id);if(fs.existsSync(prior)){noLinks(prior);fs.copyFileSync(prior,path.join(base,id,'merge-history-'+crypto.randomUUID()+'.json'));}
  for(const f of rec.files){if(f.beforeHash){const back=checked(rollbackRoot,f.path),bytes=fs.readFileSync(checked(rec.root,f.path));if(hash(bytes)!==f.beforeHash)throw Error('合并前主文件变化');atomicReplace(back,bytes);}}
  writeJournal(rec,journal);
  try{
   journal.state='applying';writeJournal(rec,journal);
   for(const f of rec.files){check(rec);const target=checked(rec.root,f.path);const now=fs.existsSync(target)?hash(fs.readFileSync(target)):null;if(now!==f.beforeHash)throw Error('合并期间主工作区发生变化：'+f.path);
    if(f.afterHash){const buf=fs.readFileSync(checked(rec.isolatedRoot,f.path));if(hash(buf)!==f.afterHash)throw Error('隔离区已变化');atomicReplace(target,buf);}else fs.unlinkSync(target);
   }
   journal.state='committed';writeJournal(rec,journal);rec.status='merged';rec.files=rec.files.map(f=>({...f,status:'merged'}));return save(rec);
  }catch(error){
   let recoveryError;try{rollback(rec,journal);}catch(e){recoveryError=e.message;journal.state='needs_review';journal.error=recoveryError;try{writeJournal(rec,journal);}catch{}}
   rec.status='conflict';rec.recoveryRequired=true;rec.recoveryReason=recoveryError||'合并失败，已还原原文件；请核实恢复记录后继续';try{save(rec);}catch{}
   throw Error('合并未完成，原件和日志已保留；请执行恢复检查。'+(recoveryError||error.message));
  }
 }
 return {create,diff,preview,merge,recover,get,list:()=>{ensureBase();return Object.keys(doc.read().sessions).map(get);}};
}
module.exports={createTeamFiles,scan,checked,noLinks,identity};
