const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {execFileSync}=require('node:child_process');

test('release requires all eight platform packages with valid headers',async t=>{
  const {requiredAssets,verifyReleaseAssets}=await import('../scripts/release-assets.mjs');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'anyai-release-assets-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const names=requiredAssets('1.3.1');
  assert.equal(names.length,8);
  for(const name of names){
    const fd=fs.openSync(path.join(dir,name),'w');
    const header=name.endsWith('.exe')?'MZ':name.endsWith('.zip')?'PK':name.endsWith('.deb')?'!<arch>\n':name.endsWith('.AppImage')?'\x7fELF':'dmg';
    fs.writeSync(fd,header);fs.ftruncateSync(fd,1024*1024);fs.closeSync(fd);
  }
  assert.deepEqual(verifyReleaseAssets(dir,'1.3.1'),names);
  const mac=path.join(dir,'AnyAI-1.3.1-mac-arm64.dmg');
  fs.renameSync(mac,mac+'.saved');
  assert.throws(()=>verifyReleaseAssets(dir,'1.3.1'),/Missing or incomplete/);
  fs.renameSync(mac+'.saved',mac);
  const exe=fs.openSync(path.join(dir,names[0]),'r+');fs.writeSync(exe,'XX');fs.closeSync(exe);
  assert.throws(()=>verifyReleaseAssets(dir,'1.3.1'),/Unexpected asset format/);
});

test('release tag push is repeatable and cannot replace a different commit',async t=>{
  const {releaseTag}=await import('../scripts/release-tag.mjs');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'anyai-release-git-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const remote=path.join(dir,'remote.git'),repo=path.join(dir,'repo');
  const git=(args,cwd=dir)=>execFileSync('git',args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  git(['init','--bare',remote]);git(['init',repo]);
  git(['config','user.name','Release Test'],repo);git(['config','user.email','test@example.invalid'],repo);
  git(['remote','add','origin',remote],repo);
  git(['commit','--allow-empty','-m','initial'],repo);
  assert.equal(releaseTag(repo,'1.3.1').alreadyPushed,false);
  assert.equal(releaseTag(repo,'1.3.1').alreadyPushed,true);
  const original=git(['rev-parse','refs/tags/v1.3.1^{}'],remote);
  git(['commit','--allow-empty','-m','new'],repo);
  assert.throws(()=>releaseTag(repo,'1.3.1'),/不能覆盖/);
  assert.equal(git(['rev-parse','refs/tags/v1.3.1^{}'],remote),original);
});
