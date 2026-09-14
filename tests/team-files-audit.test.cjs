'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createTeamFiles } = require('../electron/team-files.cjs');
function fixture(t) {
 const tmpRoot=fs.realpathSync.native(os.tmpdir());
 const dir=fs.mkdtempSync(path.join(tmpRoot,'wickrun-team-files-test-'));
 t.after(()=>{assert.equal(path.dirname(dir),tmpRoot);assert.ok(path.basename(dir).startsWith('wickrun-team-files-test-'));fs.rmSync(dir,{recursive:true,force:true});});
 const project=path.join(dir,'project'),userData=path.join(dir,'data');fs.mkdirSync(project);fs.writeFileSync(path.join(project,'a.txt'),'before-a');fs.writeFileSync(path.join(project,'b.txt'),'before-b');
 const api=createTeamFiles(userData),rec=api.create({projectId:'p',taskId:'t',memberId:'m',root:project},[project]);
 // team-files canonicalizes roots with realpathSync.native. Reuse that exact
 // persisted spelling so injected child-process hooks target the real root on
 // Windows, where temp paths may differ by case or short/long form.
 return {dir,project:rec.root,userData,api,rec};
}
const expected=rec=>rec.files.map(({path,beforeHash,afterHash})=>({path,beforeHash,afterHash}));
test('merge exact diff and reject repeated action',t=>{
 const {project,api,rec}=fixture(t);fs.writeFileSync(path.join(rec.isolatedRoot,'a.txt'),'after-a');const d=api.diff(rec.id);assert.equal(d.files.length,1);
 const result=api.merge(rec.id,expected(d));assert.equal(result.status,'merged');assert.equal(fs.readFileSync(path.join(project,'a.txt'),'utf8'),'after-a');assert.throws(()=>api.merge(rec.id,expected(d)),/不会重复/);
});
test('project root junction replacement cannot redirect merge outside approved identity',t=>{
 const {dir,project,api,rec}=fixture(t),outside=path.join(dir,'outside');fs.mkdirSync(outside);fs.writeFileSync(path.join(outside,'a.txt'),'before-a');fs.writeFileSync(path.join(outside,'b.txt'),'before-b');
 fs.writeFileSync(path.join(rec.isolatedRoot,'a.txt'),'attacker-write');const d=api.diff(rec.id);fs.renameSync(project,path.join(dir,'original'));fs.symlinkSync(outside,project,'junction');
 assert.throws(()=>api.merge(rec.id,expected(d)),/符号链接/);assert.equal(fs.readFileSync(path.join(outside,'a.txt'),'utf8'),'before-a');assert.equal(api.get(rec.id).recoveryRequired,true);
});
test('replacement real directory and replaced isolation root are both rejected',t=>{
 const f=fixture(t);fs.renameSync(f.project,path.join(f.dir,'original'));fs.mkdirSync(f.project);fs.writeFileSync(path.join(f.project,'a.txt'),'before-a');assert.throws(()=>f.api.diff(f.rec.id),/身份/);
 const g=fixture(t),outside=path.join(g.dir,'outside');fs.mkdirSync(outside);fs.renameSync(g.rec.isolatedRoot,path.join(g.dir,'isolated-original'));fs.symlinkSync(outside,g.rec.isolatedRoot,'junction');assert.throws(()=>g.api.diff(g.rec.id),/符号链接/);
});
test('symlink inserted into an ancestor is rejected before any file write',t=>{
 const {dir,userData,api,rec}=fixture(t);fs.writeFileSync(path.join(rec.isolatedRoot,'a.txt'),'after');const d=api.diff(rec.id);const moved=path.join(dir,'moved-data');fs.renameSync(userData,moved);fs.symlinkSync(moved,userData,'junction');assert.throws(()=>api.merge(rec.id,expected(d)),/符号链接/);
});
test('actual process crash marks interrupted merge and explicit recover restores exact baselines',t=>{
 const {project,userData,api,rec}=fixture(t);fs.writeFileSync(path.join(rec.isolatedRoot,'a.txt'),'after-a');fs.writeFileSync(path.join(rec.isolatedRoot,'b.txt'),'after-b');const d=api.diff(rec.id);
 const script="const fs=require('node:fs'),path=require('node:path');const rename=fs.renameSync;fs.renameSync=(a,b)=>{rename(a,b);if(b===path.join(process.argv[3],'a.txt'))process.exit(73)};require(process.argv[1]).createTeamFiles(process.argv[2]).merge(process.argv[4],JSON.parse(process.argv[5]));";
 const result=spawnSync(process.execPath,['-e',script,path.resolve(__dirname,'../electron/team-files.cjs'),userData,project,rec.id,JSON.stringify(expected(d))],{shell:false,windowsHide:true,encoding:'utf8'});
 assert.equal(result.status,73,result.stderr);assert.equal(fs.readFileSync(path.join(project,'a.txt'),'utf8'),'after-a');assert.equal(fs.readFileSync(path.join(project,'b.txt'),'utf8'),'before-b');
 const next=createTeamFiles(userData);assert.equal(next.get(rec.id).recoveryRequired,true);assert.throws(()=>next.merge(rec.id,expected(d)),/中断/);
 const recovered=next.recover(rec.id);assert.equal(recovered.recoveryRequired,false);assert.equal(recovered.status,'pending');assert.equal(fs.readFileSync(path.join(project,'a.txt'),'utf8'),'before-a');assert.equal(fs.readFileSync(path.join(project,'b.txt'),'utf8'),'before-b');
});
test('recovery never overwrites user changes made after interrupted merge',t=>{
 const {project,userData,api,rec}=fixture(t);fs.writeFileSync(path.join(rec.isolatedRoot,'a.txt'),'after-a');const d=api.diff(rec.id);
 const rename=fs.renameSync;let once=true;fs.renameSync=(from,to)=>{if(once&&to===path.join(project,'a.txt')){once=false;throw Error('EIO fixture');}return rename(from,to);};
 try{assert.throws(()=>api.merge(rec.id,expected(d)),/合并未完成/);}finally{fs.renameSync=rename;}
 fs.writeFileSync(path.join(project,'a.txt'),'user-edit');const next=createTeamFiles(userData);assert.throws(()=>next.recover(rec.id),/既不匹配/);assert.equal(fs.readFileSync(path.join(project,'a.txt'),'utf8'),'user-edit');assert.equal(next.get(rec.id).recoveryRequired,true);
});
