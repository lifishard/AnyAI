'use strict';
const fs = require('node:fs'), path = require('node:path');
const { spawn } = require('node:child_process');
const {randomUUID}=require('node:crypto');
const { discoverClient, KINDS } = require('./client-discovery.cjs');
const { createCodexClient, subscriptionEnvironment } = require('./codex-client.cjs');
const { claudeCode } = require('./tools/claudecode.cjs');
const { guardPath } = require('./tools/common.cjs');

const KIMI_WORK_SCOPE_MESSAGE = 'Kimi Work 已禁用：ACP 未提供可验证的文件编辑范围；只允许在授权工作目录内的一次性文件编辑，执行、终端、网络和未知操作均被拒绝。';
const KIMI_WORK_PATH_MESSAGE = 'Kimi Work 已禁用：ACP 请求的文件路径不在授权工作目录内，或存在符号链接越界；无法安全批准此操作。';

function validateKimiWorkPermission(event, root) {
  const toolCall = event?.toolCall;
  const kind = typeof toolCall?.kind === 'string' ? toolCall.kind.toLowerCase() : '';
  // ACP's standard `edit` kind is the only native mutation that can be
  // reviewed safely here.  The ACP client has no OS-level sandbox that we
  // can verify for terminal, command, network, delete, move, or unknown work.
  if (kind !== 'edit') return { ok: false, message: KIMI_WORK_SCOPE_MESSAGE };
  if (toolCall.locationsUnsafe || !Array.isArray(toolCall.locations) || toolCall.locations.length === 0) {
    return { ok: false, message: KIMI_WORK_SCOPE_MESSAGE };
  }
  const paths = [];
  try {
    for (const location of toolCall.locations) {
      const candidate = location?.path;
      // ACP ToolCallLocation.path is an absolute path.  Do not let the host
      // process's cwd resolve a relative or URI-like value for us.
      if (typeof candidate !== 'string' || !candidate || !path.isAbsolute(candidate)) return { ok: false, message: KIMI_WORK_SCOPE_MESSAGE };
      const guarded = guardPath(candidate, [root]);
      if (fs.existsSync(guarded) && fs.statSync(guarded).isDirectory()) return { ok: false, message: KIMI_WORK_PATH_MESSAGE };
      paths.push(guarded);
    }
  } catch {
    return { ok: false, message: KIMI_WORK_PATH_MESSAGE };
  }
  return { ok: true, paths };
}

function createConversationClients({ userData, getSettings, store, openExternal, deps = {} }) {
  const scratch = path.join(userData, 'conversation-clients'); fs.mkdirSync(scratch, { recursive:true });
  const active = new Map(), logins = new Map(), approvals=new Map();
  const discover = kind => (deps.discoverClient || discoverClient)(kind, getSettings());
  const codex = (binary,options={}) => (deps.createCodexClient || createCodexClient)({binary, cwd:scratch,...options});
  const acp = binary => (deps.createAcpClient || require('./acp-client.cjs').createAcpClient)({binary, cwd:scratch});
  const cleanModels = data => (data || []).slice(0,500).filter(m => typeof (m.model || m.id) === 'string').map(m => ({id:(m.model || m.id).slice(0,160),label:String(m.displayName || m.name || m.model || m.id).slice(0,160),efforts:(m.supportedReasoningEfforts || []).map(e=>e.reasoningEffort).filter(e=>typeof e==='string').slice(0,12),defaultEffort:m.defaultReasoningEffort}));
  async function check(kind) {
    if (!KINDS.includes(kind)) throw Error('未知连接器');
    let binary; try { binary = discover(kind); } catch(error) { return {kind,status:'missing',models:[],message:error.message}; }
    let client;
    try {
      if (kind === 'codex') {
        client = codex(binary); const account = await client.readAccount();
        if (account.account?.type !== 'chatgpt') return {kind,binary,status:'login_required',models:[],message:'连接官方 ChatGPT 账号后即可选择订阅提供的模型。'};
        let all=[], cursor; const seen = new Set();
        do { const page=await client.listModels({cursor}); all.push(...(page.data||[])); cursor=page.nextCursor; if(seen.has(cursor))break;seen.add(cursor); } while(cursor && all.length<500);
        return {kind,binary,status:'ready',message:'已连接官方 ChatGPT 账号，模型列表来自本机 Codex。',models:cleanModels(all)};
      }
      if (kind === 'claude') {
        const loggedIn = await new Promise(resolve => {
          const child=(deps.spawn || spawn)(binary,['auth','status'],{cwd:scratch,env:subscriptionEnvironment(),shell:false,windowsHide:true,stdio:['ignore','ignore','ignore']});
          const timer=setTimeout(()=>{child.kill();resolve(false);},15000);
          child.on('error',()=>{clearTimeout(timer);resolve(false);});child.on('close',code=>{clearTimeout(timer);resolve(code===0);});
        });
        return {kind,binary,status:loggedIn?'ready':'login_required',message:loggedIn?'使用本机 Claude Code 的现有授权。下列为官方模型别名，实际可用性和强度由客户端验证。':'请先在官方 Claude Code 中登录，再重新检测。',models:loggedIn?[{id:'default',label:'官方客户端默认模型',efforts:[]},...['sonnet','opus','haiku'].map(id=>({id,label:`${id} · 官方别名`,efforts:id==='haiku'?[]:['low','medium','high','xhigh','max']}))]:[]};
      }
      client=acp(binary); const info=await client.inspect();
      return {kind,binary,status:'ready',message:'已连接 Kimi ACP；执行范围受客户端能力与授权限制。',models:info.models?.length?info.models.map(m=>({id:m.id,label:m.name || m.id,efforts:(info.efforts || []).map(e=>e.id),defaultEffort:info.current?.effort || undefined})):[{id:'default',label:'官方客户端默认模型',efforts:[]}],capabilities:info.capabilities};
    } catch(error) {
      if(kind==='kimi' && error?.authRequired) return {kind,binary,status:'login_required',models:[],message:'Kimi ACP 要求登录；请先在官方客户端运行 kimi login，再重新检测。'};
      return {kind,binary,status:'error',models:[],message:'客户端未完成连接，请检查官方客户端版本、登录或网络后重新检测。'};
    }
    finally { client?.close(); }
  }
  async function connect(kind) {
    if (kind !== 'codex') return check(kind);
    const status=await check(kind);
    if(status.status!=='login_required')return status;
    logins.get(kind)?.close(); const client=codex(discover(kind)); logins.set(kind,client);
    try {
      const reply=await client.login();const url=new URL(reply.authUrl);
      if(url.protocol!=='https:' || !['auth.openai.com','auth.chatgpt.com','chatgpt.com'].includes(url.hostname) || url.username || url.password)throw Error('无效登录地址');
      await openExternal(url.href);
      const timer=setTimeout(()=>{if(logins.get(kind)===client){client.close();logins.delete(kind);}},10*60*1000);timer.unref?.();
      return {kind,status:'waiting_login',models:[],message:'已打开官方登录页面，完成登录后点击重新检测。'};
    } catch {client.close();logins.delete(kind);throw Error('无法发起官方登录，请检查 Codex 客户端。');}
  }
  async function run(args={},notify=()=>{}) {
    if(!/^[\w-]{1,160}$/.test(args.requestId || '') || !/^[\w-]{1,160}$/.test(args.runId || ''))throw Error('执行编号无效');
    const record=store.list().find(r=>r.id===args.runId), selection=record?.config?.client;
    if(!record || record.state.status!=='running' || !KINDS.includes(selection?.kind))throw Error('请先保存本轮会话和连接配置');
    if(typeof selection.model!=='string'||!/^[\w./:-]{1,160}$/.test(selection.model)||(selection.effort!==undefined && (typeof selection.effort!=='string'||!/^[\w-]{1,30}$/.test(selection.effort))))throw Error('模型或思考强度格式无效');
    if(typeof args.prompt!=='string'||!args.prompt.trim()||args.prompt.length>2000000)throw Error('上下文为空或过长');
    const jobId='native-'+args.requestId, prior=store.job(args.runId,jobId);
    if(prior){if(prior.result)return prior.result;throw Error('此调用已派发但结果未确认，请先核实，不会重复执行。');}
    if(active.has(args.runId))throw Error('当前会话正在执行');
    const settings=getSettings(), work=record.config.toolsEnabled===true;
    let cwd=scratch;
    if(work && args.cwd){
      const requested=fs.realpathSync(args.cwd);
      const allowed=(settings.tools?.workspaceRoots||[]).some(root=>{try{return fs.realpathSync(root)===requested;}catch{return false;}});
      if(!allowed)throw Error('请先将工作目录加入应用的授权目录');
      if(!fs.statSync(requested).isDirectory())throw Error('工作目录无效');cwd=requested;
    }
    const binary=discover(selection.kind), controller=new AbortController(), job={controller,client:null};
    active.set(args.runId,job);
    let kimiWorkCapabilityFailure=null;
    const onApproval=event=>{
      if(!work || controller.signal.aborted)return Promise.resolve('decline');
      let scopedPaths;
      if(selection.kind==='kimi'){
        const scope=validateKimiWorkPermission(event,cwd);
        if(!scope.ok){
          kimiWorkCapabilityFailure=scope.message;
          return Promise.resolve('decline');
        }
        scopedPaths=scope.paths;
      }
      return new Promise(resolve=>{
        const id=randomUUID();
        const finish=approved=>{if(!approvals.has(id))return;approvals.delete(id);clearTimeout(timer);controller.signal.removeEventListener('abort',stop);
          const permitted=approved===true&&!controller.signal.aborted&&active.get(args.runId)===job;
          try{store.saveJob(args.runId,'approval-'+id,{at:Date.now(),requestId:args.requestId,event,...(scopedPaths?{scopedPaths}:{}),approved:permitted});resolve(permitted?'accept':'decline');}catch{controller.abort();resolve('decline');}};
        const stop=()=>finish(false),timer=setTimeout(stop,180000);
        approvals.set(id,{requestId:args.requestId,finish});controller.signal.addEventListener('abort',stop,{once:true});
        try{store.saveJob(args.runId,'approval-'+id,{at:Date.now(),requestId:args.requestId,event,status:'waiting'});notify({type:'approval',requestId:args.requestId,id,event});}catch{finish(false);controller.abort();}
      });
    };
    try {
      store.saveJob(args.runId,jobId,{status:'dispatched',at:Date.now(),kind:selection.kind,cwd});
      let result;
      if(selection.kind==='codex'){
        job.client=codex(binary,{turnTimeoutMs:Math.min(3600000,Math.max(10000,(record.config.runtime?.maxMinutes || 30)*60000))});
        let partial='',lastSave=0;
        const raw=await job.client.run({prompt:args.prompt,model:selection.model==='default'?undefined:selection.model,effort:selection.effort||undefined,cwd,sandbox:work?'workspaceWrite':'readOnly',signal:controller.signal,onApproval,isolateTools:true,
          onEvent:event=>{if(event.type==='thread/ready')store.saveJob(args.runId,jobId,{status:'running',threadId:event.threadId,at:Date.now(),kind:selection.kind,cwd});
            if(event.type==='item/agentMessage/delta' && typeof event.delta==='string'){partial=(partial+event.delta).slice(-2000000);if(Date.now()-lastSave>500){store.saveJob(args.runId,jobId,{status:'running',partial,at:Date.now(),kind:selection.kind,cwd});lastSave=Date.now();}notify({type:'delta',requestId:args.requestId,text:event.delta});}}});
        result={status:raw.status,text:raw.text,error:raw.error,sessionId:raw.threadId};
      }else if(selection.kind==='claude'){
        const extra=[selection.model==='default'?'':`--model ${selection.model}`,selection.effort?`--effort ${selection.effort}`:''].filter(Boolean).join(' ');
        const raw=await (deps.claudeCode || claudeCode)({prompt:args.prompt,cwd},{workspaceRoots:[cwd],claudeBin:binary,claudeExtraArgs:extra,claudeTimeoutMs:Math.min(3600000,(record.config.runtime?.maxMinutes || 10)*60000),signal:controller.signal,chatOnly:!work});
        result={status:raw.uncertain?'unknown':raw.ok?'completed':'failed',text:raw.content||'',error:raw.error,sessionId:raw.execution?.sessionId};
      }else{
        job.client=(deps.createAcpClient || require('./acp-client.cjs').createAcpClient)({binary,cwd});
        let partial='',lastSave=0;
        const onEvent=event=>{
          if(event?.type!=='text' || typeof event.delta!=='string' || !event.delta)return;
          partial=(partial+event.delta).slice(-2000000);
          if(Date.now()-lastSave>500){
            store.saveJob(args.runId,jobId,{status:'running',partial,at:Date.now(),kind:selection.kind,cwd});
            lastSave=Date.now();
          }
          notify({type:'delta',requestId:args.requestId,text:event.delta});
        };
        result=await job.client.run({prompt:args.prompt,model:selection.model==='default'?undefined:selection.model,effort:selection.effort && selection.effort!=='default'?selection.effort:undefined,mode:work?'work':'chat',signal:controller.signal,onEvent,onApproval});
        if(kimiWorkCapabilityFailure){
          result={...result,status:result?.status==='unknown'?'unknown':'permission_required',error:kimiWorkCapabilityFailure};
        }
      }
      store.saveJob(args.runId,jobId,{status:result.status,result,at:Date.now(),kind:selection.kind,cwd});return result;
    }finally{controller.abort();job.client?.close();active.delete(args.runId);}
  }
  return {check,connect,run,recover(runId,callId){if(!/^native-[\w-]{1,160}$/.test(callId || '')||!store.list().some(r=>r.id===runId))throw Error('执行记录无效');const saved=store.job(runId,callId);return saved?.result || (saved?{status:'unknown',text:saved.partial || '',error:'先前操作未留下可靠的完成记录，请核实后再继续。'}:null);},approve(requestId,id,approved){const entry=approvals.get(id);if(!entry||entry.requestId!==requestId)throw Error('此操作已结束或授权已过期');entry.finish(approved===true);},abort:id=>active.get(id)?.controller.abort(),busy:()=>active.size>0,close(){for(const job of active.values())job.controller.abort();for(const client of logins.values())client.close();logins.clear();}};
}
module.exports={createConversationClients};
