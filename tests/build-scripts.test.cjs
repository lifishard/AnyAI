const {test}=require('node:test');
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {pathToFileURL}=require('node:url');
const moduleOf=name=>import(pathToFileURL(path.resolve(__dirname,'../scripts',name)).href);
function sandbox(t){const base=fs.mkdtempSync(path.join(os.tmpdir(),'anyai-script-test-'));t.after(()=>{assert.equal(path.dirname(base),path.resolve(os.tmpdir()));assert.ok(path.basename(base).startsWith('anyai-script-test-'));fs.rmSync(base,{recursive:true,force:true});});return base;}

test('pre-push handles first filename, spaces and rename records without printing secret text',async t=>{
  const {parseStatus,scanText,scanWorkingFiles}=await moduleOf('sync-checks.mjs');
  assert.deepEqual(parseStatus(' M docs/ARCHITECTURE.md\0R  新 文件.md\0旧 文件.md\0?? tests/new.cjs\0'),['docs/ARCHITECTURE.md','新 文件.md','tests/new.cjs']);
  const root=sandbox(t),fake=['sk','a'.repeat(32)].join('-');fs.writeFileSync(path.join(root,'sample.txt'),'a\n'+fake);
  const hits=scanWorkingFiles(root,['sample.txt']);assert.equal(hits.length,1);assert.equal(hits[0].line,2);assert.ok(!JSON.stringify(hits).includes(fake));
  assert.equal(scanText("const fake=['sk','a'.repeat(32)].join('-');",'test.cjs').length,0);
  fs.writeFileSync(path.join(root,'sample.txt'),'const placeholder = "example";');assert.equal(scanWorkingFiles(root,['sample.txt']).length,0);
});

test('release retention keeps two newest usable versions, removes recognized legacy packages and protects other files',async t=>{
  const {retentionPlan,pruneReleases}=await moduleOf('release-retention.mjs');const root=sandbox(t);
  for(const v of ['1.0.0','1.2.0','1.3.0','1.3.1']){const dir=path.join(root,v);fs.mkdirSync(dir);fs.writeFileSync(path.join(dir,`AnyAI-${v}-win-x64-setup.exe`),'fixture');}
  fs.writeFileSync(path.join(root,'SenseNova Chat-1.0.0-x64.exe'),'fixture');
  fs.writeFileSync(path.join(root,'AnyAI-1.0.0-x64.exe.blockmap'),'fixture');
  fs.writeFileSync(path.join(root,'notes.txt'),'KEEP');fs.mkdirSync(path.join(root,'9.0.0'));fs.writeFileSync(path.join(root,'9.0.0','incomplete.txt'),'KEEP');
  assert.deepEqual(retentionPlan(root).keep,['1.3.1','1.3.0']);
  assert.throws(()=>pruneReleases(root,'9.0.0'),/未找到/);assert.ok(fs.existsSync(path.join(root,'1.0.0')));
  const active=pruneReleases(root,'1.3.1',{runningPaths:[path.join(root,'1.2.0','win-unpacked','AnyAI.exe')]});assert.deepEqual(active.skipped,['1.2.0']);
  const plan=pruneReleases(root,'1.3.1',{runningPaths:[]});assert.equal(plan.remove.length,1);
  assert.ok(!fs.existsSync(path.join(root,'1.0.0')));assert.ok(!fs.existsSync(path.join(root,'1.2.0')));
  assert.equal(fs.readFileSync(path.join(root,'notes.txt'),'utf8'),'KEEP');assert.ok(fs.existsSync(path.join(root,'9.0.0','incomplete.txt')));
  assert.deepEqual(retentionPlan(root).remove,[]);
});
