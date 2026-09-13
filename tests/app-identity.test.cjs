const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {configureIdentity}=require('../electron/app-identity.cjs');

function fixture(t,custom=false){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'wickrun-identity-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const paths={appData:root,userData:path.join(root,custom?'isolated':'wickrunAI')};
  paths.sessionData=paths.userData;
  let name='wickrunAI';
  return {root,paths,app:{getPath:k=>paths[k],setPath:(k,v)=>{paths[k]=v;},getName:()=>name,setName:v=>{name=v;},setAboutPanelOptions:()=>{}}};
}

test('rename reuses the complete installed profile including task and browser data',t=>{
  const {root,paths,app}=fixture(t),old=path.join(root,'anyai');
  const files=['store.json','runtime-v2/checkpoint.json','chrome-profile/Default/Cookies'];
  for(const f of files){fs.mkdirSync(path.dirname(path.join(old,f)),{recursive:true});fs.writeFileSync(path.join(old,f),'existing-'+f);}
  configureIdentity(app);
  assert.equal(app.getName(),'anyai');
  assert.equal(paths.userData,old);assert.equal(paths.sessionData,old);
  for(const f of files)assert.equal(fs.readFileSync(path.join(paths.userData,f),'utf8'),'existing-'+f);
  assert.equal(fs.existsSync(path.join(root,'wickrunAI')),false);
});

test('explicitly isolated profiles stay isolated during branding initialization',t=>{
  const {paths,app}=fixture(t,true),before={...paths};
  configureIdentity(app);
  assert.deepEqual(paths,before);
  assert.equal(app.getName(),'anyai');
});
