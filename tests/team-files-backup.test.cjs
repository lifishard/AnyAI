'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createTeamFiles}=require('../electron/team-files.cjs');
const {createDataBackup}=require('../electron/data-backup.cjs');
function fixture(t){const tmpRoot=fs.realpathSync.native(os.tmpdir()),root=fs.mkdtempSync(path.join(tmpRoot,'wickrun-file-backup-test-'));t.after(()=>{assert.equal(path.dirname(root),tmpRoot);assert.ok(path.basename(root).startsWith('wickrun-file-backup-test-'));fs.rmSync(root,{recursive:true,force:true});});const userData=path.join(root,'app'),source=path.join(root,'source');fs.mkdirSync(userData);fs.mkdirSync(source);fs.writeFileSync(path.join(source,'report.txt'),'original');fs.writeFileSync(path.join(userData,'store.json'),JSON.stringify({kv:{},secrets:{}}));const files=createTeamFiles(userData),session=files.create({projectId:'p',taskId:'r',memberId:'m',root:source},[source]);fs.writeFileSync(path.join(session.isolatedRoot,'report.txt'),'draft');files.diff(session.id);return {root,userData,source:session.root,session};}
test('restored managed file session can be inspected and diffed without trusting replacement of external roots',t=>{
 const f=fixture(t),backup=createDataBackup(f.userData),snapshot=backup.create();backup.restore({id:snapshot.id});
 const restored=createTeamFiles(f.userData),record=restored.get(f.session.id);
 assert.notEqual(record.recoveryRequired,true);
 assert.equal(restored.diff(record.id).files[0].path,'report.txt');
 assert.equal(restored.preview(record.id,'report.txt').after,'draft');
 assert.notDeepEqual(record.isolatedIdentity,f.session.isolatedIdentity);
 assert.deepEqual(record.rootIdentity,f.session.rootIdentity);
});

test('restore never reauthorizes a replaced external project directory',t=>{
 const f=fixture(t),backup=createDataBackup(f.userData),snapshot=backup.create();
 fs.renameSync(f.source,path.join(f.root,'original-source'));fs.mkdirSync(f.source);fs.writeFileSync(path.join(f.source,'report.txt'),'different user file');
 backup.restore({id:snapshot.id});const restored=createTeamFiles(f.userData),record=restored.get(f.session.id);
 assert.equal(record.recoveryRequired,true);assert.match(record.recoveryReason,/目录身份已变化/);assert.deepEqual(record.rootIdentity,f.session.rootIdentity);
 assert.throws(()=>restored.diff(record.id),/目录身份已变化/);assert.equal(fs.readFileSync(path.join(f.source,'report.txt'),'utf8'),'different user file');
});

test('portable managed work relocates to the destination while original root identity stays fixed',t=>{
 const f=fixture(t),snapshot=createDataBackup(f.userData).create({mode:'export'}),destination=path.join(f.root,'other-app');fs.mkdirSync(destination);
 createDataBackup(destination).restore({bundle:snapshot.bundle});const restored=createTeamFiles(destination),record=restored.get(f.session.id);
 assert.notEqual(record.recoveryRequired,true);assert.equal(record.isolatedRoot,path.join(destination,'team-files',record.id,'work'));
 assert.deepEqual(record.rootIdentity,f.session.rootIdentity);assert.equal(restored.diff(record.id).files[0].path,'report.txt');
});

test('empty restored work directories are reconstructed only under their declared managed session',t=>{
 const f=fixture(t);fs.unlinkSync(path.join(f.session.isolatedRoot,'report.txt'));
 const backup=createDataBackup(f.userData),snapshot=backup.create();backup.restore({id:snapshot.id});
 const restored=createTeamFiles(f.userData),record=restored.get(f.session.id);assert.notEqual(record.recoveryRequired,true);
 const files=restored.diff(record.id).files;assert.equal(files[0].afterHash,null);assert.equal(fs.existsSync(record.isolatedRoot),true);
});

test('failure during managed identity rebinding rolls back the whole restore transaction',t=>{
 const f=fixture(t),snapshot=createDataBackup(f.userData).create();fs.writeFileSync(path.join(f.session.isolatedRoot,'report.txt'),'newer draft');
 const before=createTeamFiles(f.userData).get(f.session.id);
 assert.throws(()=>createDataBackup(f.userData,{fault(point){if(point==='managed-identities-rebound')throw Error('injected rebind failure');}}).restore({id:snapshot.id}),/原数据已还原/);
 const restored=createTeamFiles(f.userData),record=restored.get(f.session.id);assert.notEqual(record.recoveryRequired,true);
 assert.deepEqual(record.isolatedIdentity,before.isolatedIdentity);assert.equal(fs.readFileSync(path.join(record.isolatedRoot,'report.txt'),'utf8'),'newer draft');
});
