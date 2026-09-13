const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{EventEmitter}=require('node:events');
test('desktop install selects only the current setup and launches literal paths without a shell',async t=>{
 const {desktopInstallTarget,launchDesktopInstall}=await import('../scripts/desktop-install.mjs');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'wickrun installer & spaces '));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const target=path.join(root,'release','2.0.0','wickrunAI-2.0.0-win-x64-setup.exe');fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,'MZfixture');
 assert.equal(desktopInstallTarget(root,'2.0.0'),target);assert.throws(()=>desktopInstallTarget(root,'1.3.4'),/ENOENT/);
 let unref=false;await launchDesktopInstall(target,(file,args,options)=>{assert.equal(file,target);assert.deepEqual(args,[]);assert.equal(options.shell,false);assert.equal(options.cwd,path.dirname(target));const child=new EventEmitter();child.unref=()=>unref=true;queueMicrotask(()=>child.emit('spawn'));return child;});assert.equal(unref,true);
 fs.writeFileSync(target,'XX');assert.throws(()=>desktopInstallTarget(root,'2.0.0'),/格式无效/);assert.throws(()=>desktopInstallTarget(root,'../2.0.0'),/版本格式/);
});
test('installer start errors remain failures and batch entrypoints keep cwd and exit status',async()=>{
 const {launchDesktopInstall}=await import('../scripts/desktop-install.mjs');await assert.rejects(launchDesktopInstall('fixture.exe',()=>{const child=new EventEmitter();child.unref=()=>{};queueMicrotask(()=>child.emit('error',Error('denied')));return child;}),/denied/);
 for(const name of ['打包桌面版.bat','同步到github.bat','发布三平台版本.bat']){const b=fs.readFileSync(path.join(__dirname,'..',name));assert.ok([...b].every(n=>n<128));const s=b.toString();assert.match(s,/cd \/d "%~dp0"/);assert.match(s,/set "RC=%ERRORLEVEL%"/);assert.match(s,/exit \/b %RC%/);}
 assert.match(fs.readFileSync(path.join(__dirname,'..','打包桌面版.bat'),'utf8'),/build-desktop.mjs" --install %\*/);
});
