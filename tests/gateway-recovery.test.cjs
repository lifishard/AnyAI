const test=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
const {createGatewayRecovery,localTarget}=require('../electron/gateway-recovery.cjs');
const profile={id:'omni',name:'OmniRoute',baseUrl:'http://127.0.0.1:20128/v1'};
const response=(body,status=200)=>({ok:status>=200&&status<300,status,text:async()=>typeof body==='string'?body:JSON.stringify(body),json:async()=>body});
function fixture(options={}){
 let running=options.running??true;const calls=[],requests=[];
 const manager=createGatewayRecovery({getSettings:()=>({keyProfiles:[profile]}),secretGet:async()=> 'PRIVATE_KEY',getClaudeConnection:()=>({baseUrl:'http://127.0.0.1:20128',env:{ANTHROPIC_AUTH_TOKEN:'CLAUDE_PRIVATE_KEY'}}),deps:{
   attempts:2,sleep:async()=>{},portState:async()=>options.portState || 'closed',discoverLauncher:()=>({binary:'C:/node/node.exe',entry:'C:/npm/omniroute/bin/omniroute.mjs'}),
   spawn:(bin,args,opts)=>{calls.push({bin,args,opts});if(!options.neverReady)running=true;const p=new EventEmitter();p.unref=()=>{};return p;},
   fetch:async(url,opts)=>{requests.push({url,opts});if(!running)throw Error('offline');if(url.endsWith('/models'))return response({data:[]},options.authFailure?401:200);return response(options.otherService?'<title>Other App</title>':'<title>OmniRoute — AI Gateway</title>');},
 }});return {manager,calls,requests};
}
test('only configured loopback OmniRoute endpoints can be started',()=>{
 assert.throws(()=>localTarget({...profile,name:'OtherGateway'}));
 for(const baseUrl of ['https://example.com/v1','http://0.0.0.0:20128/v1','http://127.0.0.1:20128/v1?cmd=bad','http://x:y@localhost:20128/v1','http://localhost:20128/other'])assert.throws(()=>localTarget({...profile,baseUrl}));
 assert.equal(localTarget(profile).port,20128);
});

test('Claude repair does not probe or launch a service for account, remote API, or unknown local API',async()=>{
 for(const baseUrl of [null,'https://company.example/anthropic','http://localhost:20128']){
  let requests=0,starts=0;
  const manager=createGatewayRecovery({getSettings:()=>({keyProfiles:[]}),secretGet:async()=>'',getClaudeConnection:()=>({baseUrl,env:{}}),deps:{fetch:async()=>{requests++;throw Error();},spawn:()=>{starts++;throw Error();}}});
  assert.equal(await manager.checkClaude(),null);assert.equal(await manager.repairClaude(),null);assert.equal(requests,0);assert.equal(starts,0);
 }
});
test('a healthy gateway is checked with credentials but never restarted or used for inference',async()=>{
 const f=fixture(),r=await f.manager.repair('omni');assert.equal(r.state,'ready');assert.equal(f.calls.length,0);
 assert.equal(f.requests.at(-1).opts.headers.Authorization,'Bearer PRIVATE_KEY');assert.ok(f.requests.every(r=>!r.url.includes('/completions')));
 assert.doesNotMatch(JSON.stringify(r),/PRIVATE_KEY/);
});
test('offline recovery starts once in background and checks readiness, including concurrent clicks',async()=>{
 const f=fixture({running:false});const results=await Promise.all([f.manager.repair('omni'),f.manager.repair('omni')]);
 assert.ok(results.every(r=>r.state==='ready'));assert.equal(f.calls.length,1);
 const c=f.calls[0];assert.equal(c.opts.shell,false);assert.equal(c.opts.windowsHide,true);assert.equal(c.opts.detached,true);assert.equal(c.opts.env.OMNIROUTE_SERVER_HOST,'127.0.0.1');
 assert.deepEqual(c.args.slice(1),['serve','--port','20128','--no-open','--no-tray','--max-restarts','2']);
});
test('occupied ports, unrelated services and invalid auth are not restart triggers',async()=>{
 for(const options of [{running:false,portState:'occupied'},{otherService:true},{authFailure:true}]){
  const f=fixture(options),r=await f.manager.repair('omni');assert.notEqual(r.state,'ready');assert.equal(f.calls.length,0);
 }
});
test('a slow startup never becomes an unbounded spawn loop',async()=>{
 const f=fixture({running:false,neverReady:true});assert.equal((await f.manager.repair('omni')).state,'starting');assert.equal((await f.manager.repair('omni')).state,'starting');assert.equal(f.calls.length,1);
});
test('Claude dependency repair reuses Claude own key without exposing it',async()=>{
 const f=fixture({running:false});const r=await f.manager.repairClaude();assert.equal(r.state,'ready');assert.equal(f.calls.length,1);
 assert.equal(f.requests.at(-1).opts.headers.Authorization,'Bearer CLAUDE_PRIVATE_KEY');assert.doesNotMatch(JSON.stringify(r),/PRIVATE_KEY/);
});

test('dashboard redirects stay on origin and never carry saved credentials',async()=>{
 for(const location of ['/dashboard','http://other.test/login']){
  const requests=[];
  const manager=createGatewayRecovery({getSettings:()=>({keyProfiles:[profile]}),secretGet:async()=> 'PRIVATE_KEY',deps:{fetch:async(url,opts)=>{
   requests.push({url,opts});
   if(url===new URL('/',profile.baseUrl).href)return {...response('',307),headers:{get:()=>location}};
   if(url.endsWith('/models'))return response({data:[]});
   return response('<title>OmniRoute</title>');
  }}});
  const result=await manager.repair('omni');
  assert.equal(result.state,location.startsWith('/')?'ready':'occupied');
  assert.ok(requests.every(r=>new URL(r.url).origin==='http://127.0.0.1:20128'));
  assert.ok(requests.filter(r=>!r.url.endsWith('/models')).every(r=>!r.opts.headers));
 }
});

test('localhost resolution failure falls back to IPv4 without launching a duplicate',async()=>{
 const local={...profile,baseUrl:'http://localhost:20128/v1'};let started=0;
 const manager=createGatewayRecovery({getSettings:()=>({keyProfiles:[local]}),secretGet:async()=>'',deps:{spawn:()=>{started++;throw Error();},fetch:async url=>{
  if(new URL(url).hostname==='localhost')throw Error('IPv6 refused');
  return response(url.endsWith('/models')?{data:[]}: '<title>OmniRoute</title>');
 }}});
 const result=await manager.repair('omni');assert.equal(result.state,'ready');assert.equal(result.baseUrl,profile.baseUrl);assert.equal(started,0);
});
