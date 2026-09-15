'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createChromeLaunch}=require('../electron/chrome-launch.cjs');

function fixture(t){
  const appData=fs.mkdtempSync(path.join(os.tmpdir(),'wickrun-chrome-'));
  t.after(()=>fs.rmSync(appData,{recursive:true,force:true}));
  const userData=path.join(appData,'anyai'),legacy=path.join(appData,'wickrunAI','chrome-profile');
  fs.mkdirSync(path.join(legacy,'Default','Network'),{recursive:true});
  fs.writeFileSync(path.join(legacy,'Default','Network','Cookies'),'existing login database');
  const browser=path.join(appData,'Chrome','chrome.exe');fs.mkdirSync(path.dirname(browser),{recursive:true});fs.writeFileSync(browser,'fixture');
  let running=false;const launches=[];
  const make=()=>createChromeLaunch({app:{getPath:key=>key==='appData'?appData:userData},platform:'win32',env:{ProgramFiles:path.dirname(path.dirname(browser)),LOCALAPPDATA:''},
    fetch:async()=>running?{ok:true,json:async()=>({Browser:'Fixture Chrome'})}:{ok:false},wait:async()=>{},
    spawn:(command,args,options)=>{launches.push({command,args,options});running=true;return {unref(){}};}});
  return {appData,userData,legacy,browser,launches,make,stop(){running=false;}};
}

test('dedicated Chrome login profile migrates once and restores with the same directory after restart',async t=>{
  const f=fixture(t),first=f.make();
  const opened=await first.launch(9222,f.browser);
  const profile=path.join(f.userData,'chrome-profile');
  assert.equal(opened.ok,true);assert.equal(opened.profileDir,profile);
  assert.equal(fs.readFileSync(path.join(profile,'Default','Network','Cookies'),'utf8'),'existing login database');
  assert.equal(fs.existsSync(f.legacy),false);
  assert.ok(f.launches[0].args.includes(`--user-data-dir=${profile}`));
  assert.equal(fs.existsSync(path.join(f.userData,'chrome-connection.json')),true);

  f.stop();const second=f.make(),restored=await second.restore();
  assert.equal(restored.ok,true);assert.equal(restored.restored,true);assert.equal(f.launches.length,2);
  assert.ok(f.launches[1].args.includes(`--user-data-dir=${profile}`));
  assert.equal(fs.readFileSync(path.join(profile,'Default','Network','Cookies'),'utf8'),'existing login database');
});

test('an explicitly isolated profile never imports the installed profile',t=>{
  const f=fixture(t),isolated=path.join(f.appData,'isolated');
  const launch=createChromeLaunch({app:{getPath:key=>key==='appData'?f.appData:isolated},platform:'win32',env:{}});
  assert.equal(launch.profileDir(),path.join(isolated,'chrome-profile'));
  assert.equal(fs.existsSync(path.join(isolated,'chrome-profile')),false);
  assert.equal(fs.existsSync(f.legacy),true);
});
