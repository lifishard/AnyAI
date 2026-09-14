'use strict';
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawn, execFileSync } = require('node:child_process');

function localTarget(profile) {
  const url = new URL(profile?.baseUrl || '');
  if (url.protocol !== 'http:' || !['localhost','127.0.0.1','[::1]'].includes(url.hostname)
    || url.username || url.password || url.search || url.hash || !/^\/v1\/?$/.test(url.pathname)
    || !(/^(?:omni)$/i.test(profile.name || '') || /omnirout(?:e|er)/i.test(profile.name || ''))) throw Error('一键恢复仅支持明确配置为 OmniRoute 的本机 HTTP /v1 地址。');
  return { original:url, port:Number(url.port || 80) };
}

function discoverLauncher(env = process.env, platform = process.platform) {
  const dirs = String(env.PATH || env.Path || '').split(platform === 'win32' ? ';' : ':').map(p=>p.trim().replace(/^"|"$/g,'')).filter(p=>path.isAbsolute(p));
  const roots = [...new Set([env.APPDATA && path.join(env.APPDATA,'npm','node_modules','omniroute'), ...dirs.map(p=>path.join(p,'node_modules','omniroute')), '/usr/local/lib/node_modules/omniroute', '/opt/homebrew/lib/node_modules/omniroute'].filter(Boolean))];
  let entry;
  for (const root of roots) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
      if (pkg.name !== 'omniroute' || pkg.bin?.omniroute !== 'bin/omniroute.mjs') continue;
      const file = path.join(root,'bin','omniroute.mjs');
      if (fs.statSync(file).isFile()) { entry=fs.realpathSync(file); break; }
    } catch { /* another known install location */ }
  }
  if (!entry) throw Error('未找到已安装的 OmniRoute。请先安装官方 OmniRoute CLI，再点恢复；应用不会自动下载程序。');
  for (const dir of [...dirs, ...(env.ProgramFiles ? [path.join(env.ProgramFiles,'nodejs')] : [])]) {
    const binary = path.join(dir,platform === 'win32' ? 'node.exe' : 'node');
    try {
      if (!fs.statSync(binary).isFile()) continue;
      const version = execFileSync(binary,['--version'],{encoding:'utf8',shell:false,windowsHide:true,timeout:3000}).trim();
      const match=version.match(/^v(\d+)\.(\d+)\.(\d+)$/);
      if (!match) continue;
      const [major,minor,patch]=match.slice(1).map(Number);
      if ((major===22 && (minor>22 || (minor===22 && patch>=2))) || (major>=24 && major<27)) return {binary:fs.realpathSync(binary),entry};
    } catch { /* try the next installed runtime */ }
  }
  throw Error('已找到 OmniRoute，但没有找到兼容的 Node.js（22.22.2+ 的 22 版，或 24–26 版）。请先修复 Node.js 安装。');
}

function portState(host,port) {
  return new Promise(resolve=>{
    const socket=net.createConnection({host:host.replace(/^\[|\]$/g,''),port});
    const done=value=>{socket.destroy();resolve(value);};
    socket.setTimeout(1500,()=>done('unknown'));
    socket.once('connect',()=>done('occupied'));
    socket.once('error',err=>done(err.code==='ECONNREFUSED' ? 'closed' : 'unknown'));
  });
}

function createGatewayRecovery({getSettings,secretGet,getClaudeConnection,deps={}}) {
  const request=deps.fetch || fetch, launch=deps.spawn || spawn, inspectPort=deps.portState || portState;
  const discover=deps.discoverLauncher || discoverLauncher, pause=deps.sleep || (ms=>new Promise(r=>setTimeout(r,ms)));
  const jobs=new Map(), pending=new Map();
  const result=(state,message,extra={})=>({state,message,...extra});
  async function probe(url,profile,keyProvider=()=>secretGet(profile.id)) {
    try {
      // Follow bounded dashboard/login redirects only on this origin, without credentials.
      let page=new URL('/',url),root;
      for(let hop=0;hop<5;hop++){
        root=await request(page.href,{redirect:'manual',signal:AbortSignal.timeout(2500)});
        if(![301,302,303,307,308].includes(root.status))break;
        const location=root.headers?.get('location');
        const next=location ? new URL(location,page) : null;
        if(!next || next.origin!==url.origin || next.username || next.password)
          return result('occupied','本机服务跳转到了其他地址，无法确认是 OmniRoute。请核对网关地址。');
        await root.body?.cancel();
        page=next;
      }
      if (!root.ok) return result('occupied','本机端口已有服务响应，但未能确认是 OmniRoute；没有重启或替换它。');
      const html=(await root.text()).slice(0,200000);
      if (!/<title[^>]*>[^<]*OmniRoute/i.test(html)) return result('occupied','这个端口运行的是其他服务，不能用 OmniRoute 覆盖。请核对 Base URL。');
      let key;try{key=await keyProvider();}catch{return result('auth','网关已响应，但本地凭据无法解锁。请检查凭据，未重启服务。');}
      const headers={Accept:'application/json',...(key?{Authorization:`Bearer ${key}`}:{})};
      for(const [k,v] of Object.entries(profile.extraHeaders || {})) if(k.trim())headers[k.trim()]=String(v);
      const models=await request(url.href.replace(/\/$/,'')+'/models',{headers,redirect:'manual',signal:AbortSignal.timeout(4000)});
      if(models.status===401 || models.status===403) return result('auth','OmniRoute 已启动，但当前 API 凭据未通过验证。请检查密钥；重启服务无法修复凭据。');
      if(!models.ok) return result('unhealthy',`OmniRoute 已响应，但模型接口返回 HTTP ${models.status}。请查看网关状态；未重复启动。`);
      const data=await models.json();
      if(!Array.isArray(data?.data) && !Array.isArray(data?.models)) return result('unhealthy','OmniRoute 已响应，但模型接口返回异常。请检查网关日志。');
      return result('ready','本机网关连接正常。可以接着跑或重新发送。',{baseUrl:url.href.replace(/\/$/,''),modelCount:(data.data || data.models).length});
    } catch { return result('offline','没有取得本机网关的有效响应。'); }
  }
  async function perform(profile,target,keyProvider) {
    let last=await probe(target.original,profile,keyProvider);
    if(last.state!=='offline') return last;
    const ipv4=new URL(target.original);ipv4.hostname='127.0.0.1';
    if(target.original.hostname!=='127.0.0.1') {
      last=await probe(ipv4,profile,keyProvider);
      if(last.state!=='offline') return last.state==='ready' ? {...last,message:'已通过 127.0.0.1 恢复连接，并避开 localhost 的地址解析差异。'} : last;
    }
    const hosts=[...new Set(['127.0.0.1','::1',target.original.hostname])];
    for(const host of hosts) {
      const state=await inspectPort(host,target.port);
      if(state!=='closed') return result('occupied','端口仍被占用或连接状态不明，服务可能正在启动或暂时无响应。请稍后再试；没有强制结束现有进程。');
    }
    let job=jobs.get(target.port);
    if(!job || job.exited) {
      const {binary,entry}=discover();
      job={exited:false,error:null};jobs.set(target.port,job);
      const env={...process.env,OMNIROUTE_SERVER_HOST:'127.0.0.1',HOSTNAME:'127.0.0.1'};
      delete env.ELECTRON_RUN_AS_NODE;delete env.NODE_OPTIONS;
      try {
        const child=launch(binary,[entry,'serve','--port',String(target.port),'--no-open','--no-tray','--max-restarts','2'],{cwd:path.dirname(path.dirname(entry)),env,shell:false,windowsHide:true,detached:true,stdio:'ignore'});
        child.once('error',()=>{job.exited=true;job.error='后台启动失败，请检查 OmniRoute 和 Node.js 安装。';});
        child.once('exit',code=>{job.exited=true;if(code)job.error=`OmniRoute 启动进程退出（${code}），请检查网关日志。`;});
        child.unref();
      } catch { job.exited=true;return result('failed','无法启动后台网关，请检查 OmniRoute 安装。'); }
    }
    for(let i=0;i<(deps.attempts ?? 40);i++) {
      await pause(750);
      last=await probe(ipv4,profile,keyProvider);
      if(last.state!=='offline') return last.state==='ready' ? {...last,message:'已在后台启动 OmniRoute，连接已恢复。可以接着跑或重新发送。',started:true} : last;
      if(job.error) return result('failed',job.error);
    }
    return result('starting','已发起后台启动，但网关尚未就绪。稍后再次检测；不会重复启动仍在运行的进程。');
  }
  function enqueue(profile,keyProvider) {
    if(!profile) return Promise.resolve(result('failed','这份 API 凭据已不存在，请重新选择。'));
    let target;try{target=localTarget(profile);}catch(e){return Promise.resolve(result('unsupported',e.message));}
    // Serialize across credentials sharing a local port; each credential is still checked.
    if(pending.has(target.port)) return pending.get(target.port).then(()=>enqueue(profile,keyProvider));
    const work=perform(profile,target,keyProvider).catch(e=>result('failed',e.message)).finally(()=>pending.delete(target.port));
    pending.set(target.port,work);return work;
  }
  async function claude(repair) {
    const connection=getClaudeConnection();
    const profile=require('./claude-connection.cjs').gatewayProfile(connection,getSettings());
    if(!profile)return null;
    const keyProvider=()=>connection.env.ANTHROPIC_AUTH_TOKEN || connection.env.ANTHROPIC_API_KEY || '';
    return repair ? enqueue(profile,keyProvider) : probe(new URL(profile.baseUrl),profile,keyProvider);
  }
  return {repair:profileId=>enqueue(getSettings().keyProfiles?.find(p=>p.id===profileId)),checkClaude:()=>claude(false),repairClaude:()=>claude(true)};
}
module.exports={createGatewayRecovery,localTarget,discoverLauncher};
