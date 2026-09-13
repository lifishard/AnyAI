import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
const require=createRequire(import.meta.url);

const versionPattern = /^\d+\.\d+\.\d+$/;
const artifactPattern = /^(?:wickrunAI|AnyAI|SenseNova Chat)-(\d+\.\d+\.\d+)-.+\.(?:exe|dmg|zip|AppImage|deb)(?:\.blockmap)?$/i;
const compare = (a,b) => { const x=a.split('.').map(Number),y=b.split('.').map(Number); return y[0]-x[0]||y[1]-x[1]||y[2]-x[2]; };
export function retentionPlan(releaseDir) {
  const root = path.resolve(releaseDir);
  if (!fs.existsSync(root)) return {root,keep:[],remove:[]};
  if (fs.lstatSync(root).isSymbolicLink()) throw new Error('产物目录不能是链接');
  const isPackage=(dir,n) => artifactPattern.test(n)&&!n.endsWith('.blockmap')&&fs.lstatSync(path.join(dir,n)).isFile()&&fs.statSync(path.join(dir,n)).size>0;
  const entries = fs.readdirSync(root,{withFileTypes:true}).flatMap(e=>{
    if(e.isSymbolicLink())return [];
    const version=e.isDirectory()&&versionPattern.test(e.name)?e.name:e.isFile()?e.name.match(artifactPattern)?.[1]:undefined;
    if(e.isDirectory()&&version&&!fs.readdirSync(path.join(root,e.name)).some(n=>n.match(artifactPattern)?.[1]===version&&isPackage(path.join(root,e.name),n)))return [];
    return version?[{name:e.name,version,directory:e.isDirectory(),usable:e.isDirectory()||isPackage(root,e.name)}]:[];
  });
  const keep=[...new Set(entries.filter(e=>e.usable).map(e=>e.version))].sort(compare).slice(0,2);
  const loose=path.join(root,'win-unpacked');
  if(fs.existsSync(loose)&&!fs.lstatSync(loose).isSymbolicLink()){
    try{
      const pkg=JSON.parse(require('@electron/asar').extractFile(path.join(loose,'resources','app.asar'),'package.json'));
      if(['wickrunai','anyai','sensenova-chat'].includes(pkg.name)&&versionPattern.test(pkg.version))entries.push({name:'win-unpacked',version:pkg.version,directory:true,usable:false});
    }catch{/* Unknown folders are not release cleanup targets. */}
  }
  return {root,keep,remove:entries.filter(e=>!keep.includes(e.version))};
}
export function pruneReleases(releaseDir, builtVersion, options={}) {
  const plan=retentionPlan(releaseDir);
  if (!versionPattern.test(builtVersion)) throw new Error('版本格式无效，未清理旧产物');
  // Only clean up after a new usable package is present; a failed build preserves all older packages.
  const dir=path.join(plan.root,builtVersion);
  const usable=fs.existsSync(dir)&&!fs.lstatSync(dir).isSymbolicLink()&&fs.readdirSync(dir).some(n=>{
    const match=n.match(artifactPattern),p=path.join(dir,n);
    return match?.[1]===builtVersion&&!n.endsWith('.blockmap')&&fs.lstatSync(p).isFile()&&fs.statSync(p).size>0;
  });
  if (!usable) throw new Error('未找到本次成功生成的安装包，旧产物保持不变');
  let running=options.runningPaths??[];
  if(options.runningPaths===undefined&&process.platform==='win32'){
    const check=spawnSync('powershell',['-NoProfile','-NonInteractive','-Command',"Get-CimInstance Win32_Process -Filter \"Name LIKE 'wickrunAI%' OR Name LIKE 'AnyAI%' OR Name LIKE 'SenseNova Chat%'\" -ErrorAction Stop | Select-Object ProcessId,ParentProcessId,ExecutablePath | ConvertTo-Json -Compress"],{encoding:'utf8',windowsHide:true});
    if(check.error||check.status!==0)throw new Error('无法核实运行中的应用位置，旧产物保持不变');
    const found=check.stdout.trim()?JSON.parse(check.stdout):[];
    const processes=Array.isArray(found)?found:[found];
    running=processes.map(p=>{
      const seen=new Set();
      while(p&&!p.ExecutablePath&&!seen.has(p.ProcessId)){seen.add(p.ProcessId);p=processes.find(x=>x.ProcessId===p.ParentProcessId);}
      if(!p?.ExecutablePath)throw new Error('无法核实运行中的应用位置，旧产物保持不变');
      return p.ExecutablePath;
    });
  }
  running=running.map(p=>path.resolve(p).toLowerCase());
  plan.skipped=[];
  for (const entry of plan.remove) {
    const target=path.resolve(plan.root,entry.name),relative=path.relative(plan.root,target);
    if (!relative||relative.startsWith('..')||path.isAbsolute(relative)||path.dirname(target)!==plan.root) throw new Error('清理路径越界');
    if (fs.lstatSync(target).isSymbolicLink()) throw new Error('清理目标已变成链接');
    const physicalRoot=fs.realpathSync(plan.root),physicalTarget=fs.realpathSync(target),within=path.relative(physicalRoot,physicalTarget);
    if(!within||within.startsWith('..')||path.isAbsolute(within))throw new Error('清理实际路径越界');
    if(running.some(p=>p===target.toLowerCase()||(entry.directory&&p.startsWith(target.toLowerCase()+path.sep)))){
      plan.skipped.push(entry.name);continue;
    }
    fs.rmSync(target,{recursive:entry.directory,force:false});
  }
  return plan;
}
if (process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
  const version=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8')).version;
  const plan=process.argv.includes('--apply')?pruneReleases(path.join(root,'release'),version):retentionPlan(path.join(root,'release'));
  console.log(JSON.stringify(plan,null,2));
}
