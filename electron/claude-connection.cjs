'use strict';
const fs=require('node:fs'),path=require('node:path');
// Reuse only connection/model settings. Hooks, MCP servers, permission overrides,
// apiKeyHelper commands and arbitrary environment variables are never imported.
const CONNECTION_KEYS=new Set(['ANTHROPIC_BASE_URL','ANTHROPIC_AUTH_TOKEN','ANTHROPIC_API_KEY','ANTHROPIC_CUSTOM_HEADERS','ANTHROPIC_MODEL','ANTHROPIC_DEFAULT_OPUS_MODEL','ANTHROPIC_DEFAULT_SONNET_MODEL','ANTHROPIC_DEFAULT_HAIKU_MODEL','ANTHROPIC_DEFAULT_FABLE_MODEL','CLAUDE_CODE_SUBAGENT_MODEL','CLAUDE_CODE_EFFORT_LEVEL','CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY']);
function readClaudeConnection(env=process.env,read=fs.readFileSync) {
  const home=env.USERPROFILE || env.HOME;
  const configDir=env.CLAUDE_CONFIG_DIR || (home ? path.join(home,'.claude') : null);
  if(configDir && !path.isAbsolute(configDir))throw Error('Claude Code 配置目录必须是绝对路径。');
  let settings={};
  try { if(configDir)settings=JSON.parse(read(path.join(configDir,'settings.json'),'utf8')); }
  catch(e){if(e.code!=='ENOENT')throw Error('Claude Code 用户配置无法读取，请检查 settings.json 的格式。');}
  if(!settings || typeof settings!=='object' || Array.isArray(settings))throw Error('Claude Code 用户配置必须是 JSON 对象。');
  // Do not silently turn an unimplemented credential backend into an account login.
  const source={...env,...settings.env};
  const cloud=['BEDROCK','VERTEX','FOUNDRY','MANTLE','ANTHROPIC_AWS'].find(p=>/^(1|true)$/i.test(source['CLAUDE_CODE_USE_'+p] || ''));
  if(cloud)throw Error(`检测到 Claude Code 的 ${cloud} 云平台配置，此接入尚未适配其专用认证；未改用默认账号或本机网关。`);
  if(settings.apiKeyHelper)throw Error('检测到 Claude Code 的动态凭据助手，此接入尚未适配；未改用默认账号或其他 API。');
  const safe={};
  for(const [k,v] of Object.entries(env))if(CONNECTION_KEYS.has(k) && typeof v==='string')safe[k]=v;
  for(const [k,v] of Object.entries(settings.env || {}))if(CONNECTION_KEYS.has(k) && typeof v==='string')safe[k]=v;
  if(env.CLAUDE_CONFIG_DIR)safe.CLAUDE_CONFIG_DIR=configDir;
  if(!safe.ANTHROPIC_MODEL && typeof settings.model==='string')safe.ANTHROPIC_MODEL=settings.model;
  let baseUrl=null;
  if(safe.ANTHROPIC_BASE_URL){
    try {const u=new URL(safe.ANTHROPIC_BASE_URL);if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.search||u.hash)throw Error();baseUrl=u.href.replace(/\/$/,'');}
    catch {throw Error('Claude Code 的 ANTHROPIC_BASE_URL 不是有效的 HTTP 服务地址。');}
  }
  return {env:safe,baseUrl};
}
// Recovery adapters require an explicit matching user profile. Port numbers do not identify providers.
function gatewayProfile(connection,settings={}) {
  if(!connection.baseUrl)return null;
  const u=new URL(connection.baseUrl);
  const loopback=h=>['localhost','127.0.0.1','[::1]'].includes(h);
  if(!loopback(u.hostname)||u.protocol!=='http:'||!['','/','/v1','/v1/'].includes(u.pathname))return null;
  const profile=(settings.keyProfiles || []).find(p=>{
    if(!/^(?:omni)$/i.test(p.name || '') && !/omnirout(?:e|er)/i.test(p.name || ''))return false;
    try { const target=new URL(p.baseUrl);return target.protocol===u.protocol && loopback(target.hostname) && target.port===u.port && /^\/v1\/?$/.test(target.pathname) && !target.username && !target.password && !target.search && !target.hash; }catch{return false;}
  });
  if(!profile)return null;
  const extraHeaders={};
  for(const line of (connection.env.ANTHROPIC_CUSTOM_HEADERS || '').split(/\r?\n/)){
    const colon=line.indexOf(':');if(colon>0)extraHeaders[line.slice(0,colon).trim()]=line.slice(colon+1).trim();
  }
  u.pathname='/v1';return {name:profile.name,id:'claude-route',baseUrl:u.href,extraHeaders};
}
function describeConnection(connection) {
  return {type:connection.baseUrl?'custom_api':connection.env.ANTHROPIC_API_KEY || connection.env.ANTHROPIC_AUTH_TOKEN?'api_key':'account',...(connection.baseUrl?{baseUrl:connection.baseUrl}:{})};
}
module.exports={readClaudeConnection,gatewayProfile,describeConnection};
