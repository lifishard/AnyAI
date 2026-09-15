'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createConversationClients}=require('../electron/conversation-clients.cjs');
const {createRunStore}=require('../electron/run-store.cjs');
const {rememberClientState}=require('../electron/client-discovery.cjs');
function fixture(t, overrides={}){
  const root=fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()),'wickrun-clients-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const store=createRunStore(path.join(root,'runtime')),calls=[],opened=[];
  const record={id:'run-1',conversationId:'conversation-1',answerId:'answer-1',config:{toolsEnabled:false,client:{kind:'codex',model:'gpt-test',effort:'high'}},state:{working:[],status:'running'}};store.save(record);
  const deps={discoverClient:()=>path.join(root,'codex.exe'),createCodexClient:()=>({readAccount:async()=>({account:{type:'chatgpt'}}),listModels:async()=>({data:[{model:'gpt-test',displayName:'Test',supportedReasoningEfforts:[{reasoningEffort:'high'}]}]}),login:async()=>({authUrl:'https://chatgpt.com/auth/test'}),run:async options=>{calls.push(options);return {status:'completed',text:'saved output',threadId:'thread-1'};},close(){}}),...overrides};
  const host=createConversationClients({userData:root,store,getSettings:()=>({tools:{workspaceRoots:[root]}}),openExternal:async url=>opened.push(url),deps});t.after(()=>host.close());return {root,store,record,calls,opened,host};
}
test('official models and login are discovered without any renderer credential',async t=>{
  const f=fixture(t);const result=await f.host.check('codex');assert.equal(result.status,'ready');assert.deepEqual(result.models[0].efforts,['high']);assert.equal((await f.host.connect('codex')).status,'ready');assert.equal(f.opened.length,0);
});

test('restart restores a previously validated native client path and rechecks its account',async t=>{
  const root=fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()),'wickrun-client-restart-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const binary=path.join(root,'saved','codex.exe');fs.mkdirSync(path.dirname(binary),{recursive:true});fs.writeFileSync(binary,'fixture');
  assert.equal(rememberClientState(root,'codex',{binary,status:'ready'}),true);
  let checks=0;
  const host=createConversationClients({userData:root,store:createRunStore(path.join(root,'runtime')),getSettings:()=>({}),openExternal:async()=>{},deps:{env:{USERPROFILE:root,LOCALAPPDATA:path.join(root,'none'),APPDATA:path.join(root,'none'),PATH:''},platform:'win32',createCodexClient:options=>{
    assert.equal(options.binary,fs.realpathSync(binary));checks++;
    return {readAccount:async()=>({account:{type:'chatgpt'}}),listModels:async()=>({data:[{model:'restored-model'}]}),close(){}};
  }}});t.after(()=>host.close());
  const restored=await host.restore();assert.equal(restored[0].status,'ready');assert.equal(checks,1);
});

test('Claude Code reports account, API key and custom API sources without assuming OmniRoute',async t=>{
 const {EventEmitter}=require('node:events');
 for(const [type,connection] of [['account',{env:{},baseUrl:null}],['api_key',{env:{ANTHROPIC_API_KEY:'PRIVATE_KEY'},baseUrl:null}],['custom_api',{env:{ANTHROPIC_BASE_URL:'https://company.example/anthropic',ANTHROPIC_AUTH_TOKEN:'PRIVATE_KEY'},baseUrl:'https://company.example/anthropic'}]]){
  const f=fixture(t,{readClaudeConnection:()=>connection,validateClaudeBinary:()=>{},claudeGatewayCheck:async()=>null,spawn:(_binary,_args,options)=>{
   assert.equal(options.shell,false);assert.equal(options.env.NODE_OPTIONS,undefined);
   const p=new EventEmitter();p.kill=()=>{};queueMicrotask(()=>p.emit('close',0));return p;
  }});
  const result=await f.host.check('claude');assert.equal(result.status,'ready');assert.equal(result.connection.type,type);assert.match(result.message,/Claude Code CLI/);assert.doesNotMatch(JSON.stringify(result),/OmniRoute|PRIVATE_KEY/);
 }
});

test('Claude repair checks the selected executable before any gateway startup',async t=>{
 let repairs=0;
 const f=fixture(t,{validateClaudeBinary:()=>{throw Error('Claude Desktop');},repairClaudeGateway:async()=>{repairs++;return {state:'ready'};}});
 assert.equal((await f.host.repairClaude()).status,'error');assert.equal(repairs,0);
});
test('one-click connection starts official login only when an account is required',async t=>{
  const f=fixture(t,{createCodexClient:()=>({readAccount:async()=>({account:null}),login:async()=>({authUrl:'https://chatgpt.com/auth/test'}),close(){}})});
  assert.equal((await f.host.connect('codex')).status,'waiting_login');assert.equal(f.opened.length,1);
});
test('durable dispatch and terminal outcome deduplicate requests, including after renderer loss',async t=>{
  const f=fixture(t);const args={runId:'run-1',requestId:'request-1',prompt:'portable prior context'};
  assert.equal((await f.host.run(args)).text,'saved output');assert.equal((await f.host.run(args)).status,'completed');assert.equal(f.calls.length,1);
  assert.equal(f.calls[0].sandbox,'readOnly');assert.equal(f.calls[0].isolateTools,true);assert.equal(f.host.recover('run-1','native-request-1').text,'saved output');
});
test('dispatched request without a terminal record is never silently replayed',async t=>{
  const f=fixture(t);f.store.saveJob('run-1','native-request-1',{status:'dispatched'});
  await assert.rejects(f.host.run({runId:'run-1',requestId:'request-1',prompt:'hello'}),/不会重复执行/);assert.equal(f.calls.length,0);assert.equal(f.host.recover('run-1','native-request-1').status,'unknown');
});
test('Work rejects an unapproved directory before launching the official client',async t=>{
  const f=fixture(t);f.record.config.toolsEnabled=true;f.store.save(f.record);
  await assert.rejects(f.host.run({runId:'run-1',requestId:'request-2',prompt:'write',cwd:os.tmpdir()}),/授权目录/);assert.equal(f.calls.length,0);
});
test('permission answers are scoped and persisted before reaching the client',async t=>{
  let decision;
  const f=fixture(t,{createCodexClient:()=>({run:async options=>{decision=await options.onApproval({command:'create a file'});return {status:'completed',text:'done'};},close(){}})});
  f.record.config.toolsEnabled=true;f.store.save(f.record);
  await f.host.run({runId:'run-1',requestId:'request-3',prompt:'work',cwd:f.root},event=>{
    assert.throws(()=>f.host.approve('wrong-request',event.id,true),/过期/);f.host.approve(event.requestId,event.id,true);
    assert.equal(f.store.job('run-1','approval-'+event.id).approved,true);
  });assert.equal(decision,'accept');
});
test('Chat refuses native permission even if a client asks for mutation',async t=>{
  let decision;
  const f=fixture(t,{createCodexClient:()=>({run:async options=>{decision=await options.onApproval({command:'write'});return {status:'approval_required',text:''};},close(){}})});
  await f.host.run({runId:'run-1',requestId:'request-4',prompt:'chat'});assert.equal(decision,'decline');
});
test('unexpected login domains never open and API accounts are not called subscription-ready',async t=>{
  const f=fixture(t,{createCodexClient:()=>({readAccount:async()=>({account:{type:'apiKey'}}),login:async()=>({authUrl:'https://evil.example/'}),close(){}})});
  assert.equal((await f.host.check('codex')).status,'login_required');await assert.rejects(f.host.connect('codex'));assert.equal(f.opened.length,0);
});

test('Kimi ACP streams text and bridges work permissions through the generic queue',async t=>{
  const calls=[],notifications=[];
  const f=fixture(t,{discoverClient:kind=>{assert.equal(kind,'kimi');return path.join(f.root,'kimi.exe');},createAcpClient:()=>({
    run:async options=>{
      calls.push(options);
      options.onEvent({type:'text',delta:'partial output'});
      const decision=await options.onApproval({type:'permission_required',requestId:17,sessionId:'session-1',toolCall:{title:'Write file',kind:'edit',locations:[{path:path.join(f.root,'output.txt')}]},options:[{optionId:'allow_once',name:'Allow once',kind:'allow_once'}]});
      assert.equal(decision,'accept');
      options.onEvent({type:'text',delta:' and final output'});
      return {status:'completed',text:'partial output and final output',sessionId:'session-1'};
    },close(){},
  })});
  f.record.config={toolsEnabled:true,client:{kind:'kimi',model:'kimi-k2',effort:'high'}};f.store.save(f.record);
  const result=await f.host.run({runId:'run-1',requestId:'request-kimi',prompt:'work',cwd:f.root},event=>{
    notifications.push(event);
    if(event.type==='approval')f.host.approve(event.requestId,event.id,true);
  });
  assert.equal(result.status,'completed');assert.equal(result.text,'partial output and final output');
  assert.equal(calls.length,1);assert.equal(calls[0].mode,'work');assert.equal(calls[0].model,'kimi-k2');assert.equal(calls[0].effort,'high');
  assert.deepEqual(notifications.map(event=>event.type),['delta','approval','delta']);
  assert.equal(notifications[0].text,'partial output');assert.equal(notifications[2].text,' and final output');
});

test('Kimi Work refuses unscoped native mutations and cannot report completion',async t=>{
  for(const hostile of ['outside path','unknown kind','missing locations']){
    const notifications=[];let decision;let f;
    f=fixture(t,{discoverClient:kind=>{assert.equal(kind,'kimi');return path.join(f.root,'kimi.exe');},createAcpClient:() => ({
      run:async options=>{
        const toolCall=hostile==='outside path'
          ? {kind:'edit',locations:[{path:path.join(f.root,'..','outside.txt')}]}
          : hostile==='unknown kind'
            ? {kind:'execute',locations:[{path:path.join(f.root,'inside.txt')}]}
            : {kind:'edit'};
        decision=await options.onApproval({type:'permission_required',requestId:21,sessionId:'session-1',toolCall,options:[{optionId:'allow_once',name:'Allow once',kind:'allow_once'}]});
        return {status:'completed',text:'must not be accepted',sessionId:'session-1'};
      },close(){},
    })});
    f.record.config={toolsEnabled:true,client:{kind:'kimi',model:'kimi-k2'}};f.store.save(f.record);
    const result=await f.host.run({runId:'run-1',requestId:`request-hostile-${hostile.replace(/\W/g,'')}`,prompt:'work',cwd:f.root},notification=>notifications.push(notification));
    assert.equal(decision,'decline',hostile);assert.equal(result.status,'permission_required',hostile);assert.match(result.error,/Kimi Work|ACP|授权工作目录/,hostile);assert.deepEqual(notifications,[],hostile);
  }
});

test('Kimi Work refuses an edit location that escapes through a symlink',async t=>{
  const outside=fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()),'wickrun-kimi-outside-'));t.after(()=>fs.rmSync(outside,{recursive:true,force:true}));
  const notifications=[];let decision;let f;
  f=fixture(t,{discoverClient:kind=>{assert.equal(kind,'kimi');return path.join(f.root,'kimi.exe');},createAcpClient:() => ({
    run:async options=>{decision=await options.onApproval({type:'permission_required',requestId:23,sessionId:'session-1',toolCall:{kind:'edit',locations:[{path:path.join(f.root,'link','escaped.txt')}]},options:[{optionId:'allow_once',name:'Allow once',kind:'allow_once'}]});return {status:'completed',text:'must not be accepted',sessionId:'session-1'};},close(){},
  })});
  try{fs.symlinkSync(outside,path.join(f.root,'link'),'junction');}catch(error){t.skip(`junction creation unavailable: ${error.message}`);return;}
  f.record.config={toolsEnabled:true,client:{kind:'kimi',model:'kimi-k2'}};f.store.save(f.record);
  const result=await f.host.run({runId:'run-1',requestId:'request-symlink',prompt:'work',cwd:f.root},event=>notifications.push(event));
  assert.equal(decision,'decline');assert.equal(result.status,'permission_required');assert.match(result.error,/符号链接|Kimi Work|授权工作目录/);assert.deepEqual(notifications,[]);
});

test('Kimi ACP chat declines native permissions and does not publish an approval card',async t=>{
  let decision,notifications=[];
  const f=fixture(t,{discoverClient:kind=>{assert.equal(kind,'kimi');return path.join(f.root,'kimi.exe');},createAcpClient:()=>({
    run:async options=>{decision=await options.onApproval({type:'permission_required',requestId:9,sessionId:'session-1',toolCall:{title:'Mutate'},options:[{optionId:'allow_once',name:'Allow once',kind:'allow_once'}]});return {status:'permission_required',text:'',sessionId:'session-1'};},close(){},
  })});
  f.record.config={toolsEnabled:false,client:{kind:'kimi',model:'kimi-k2'}};f.store.save(f.record);
  const result=await f.host.run({runId:'run-1',requestId:'request-kimi-chat',prompt:'chat'},event=>notifications.push(event));
  assert.equal(result.status,'permission_required');assert.equal(decision,'decline');assert.deepEqual(notifications,[]);
  assert.equal(f.store.job('run-1','native-request-kimi-chat').result.status,'permission_required');
});

test('Kimi ACP authentication errors are reported as login required without starting a live login flow',async t=>{
  const f=fixture(t,{discoverClient:kind=>{assert.equal(kind,'kimi');return path.join(f.root,'kimi.exe');},createAcpClient:()=>({
    inspect:async()=>{const error=Error('AUTH_REQUIRED');error.authRequired=true;error.code=-32000;throw error;},close(){},
  })});
  const result=await f.host.check('kimi');
  assert.equal(result.status,'login_required');assert.match(result.message,/kimi login/);
});

test('Kimi ACP inspection maps advertised models and the shared thinking picker',async t=>{
  const f=fixture(t,{discoverClient:kind=>{assert.equal(kind,'kimi');return path.join(f.root,'kimi.exe');},createAcpClient:()=>({
    inspect:async()=>({models:[{id:'kimi-k2',name:'Kimi K2'},{id:'kimi-k2-thinking',name:'Thinking'}],efforts:[{id:'low'},{id:'high'}],current:{effort:'low'},capabilities:{}}),close(){},
  })});
  const result=await f.host.check('kimi');
  assert.deepEqual(result.models,[
    {id:'kimi-k2',label:'Kimi K2',efforts:['low','high'],defaultEffort:'low'},
    {id:'kimi-k2-thinking',label:'Thinking',efforts:['low','high'],defaultEffort:'low'},
  ]);
});
