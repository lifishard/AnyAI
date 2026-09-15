'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const KINDS = ['codex', 'claude', 'kimi'];
const STATE_VERSION = 1;

function stateFile(userData) { return path.join(path.resolve(userData), 'conversation-clients', 'connections.json'); }
function readClientState(userData) {
  try {
    const value = JSON.parse(fs.readFileSync(stateFile(userData), 'utf8'));
    if (value?.version !== STATE_VERSION || !value.clients || typeof value.clients !== 'object' || Array.isArray(value.clients)) return {version:STATE_VERSION,clients:{}};
    return value;
  } catch { return {version:STATE_VERSION,clients:{}}; }
}
function rememberClientState(userData, kind, update) {
  if (!KINDS.includes(kind) || !path.isAbsolute(userData)) return false;
  const current = readClientState(userData), previous = current.clients[kind] || {};
  let binary = typeof update?.binary === 'string' ? update.binary : previous.binary;
  try {
    if (!path.isAbsolute(binary) || /\.(cmd|bat|ps1|js|mjs|cjs)$/i.test(binary) || (process.platform === 'win32' && !/\.exe$/i.test(binary))) return false;
    binary = fs.realpathSync(binary);
    if (!fs.statSync(binary).isFile()) return false;
  } catch { return false; }
  const status = typeof update?.status === 'string' && update.status.length <= 40 ? update.status : previous.status;
  const next = {version:STATE_VERSION,clients:{...current.clients,[kind]:{binary,status,lastCheckedAt:Date.now()}}};
  const target = stateFile(userData), tmp = `${target}.${crypto.randomUUID()}.tmp`;
  try {
    fs.mkdirSync(path.dirname(target),{recursive:true});
    fs.writeFileSync(tmp,JSON.stringify(next),{mode:0o600});
    fs.renameSync(tmp,target);
    return true;
  } catch { return false; }
  finally { try { fs.unlinkSync(tmp); } catch { /* renamed or never written */ } }
}
// Only inspect bounded, known installation directories. Never launch shell shims.
function children(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name).sort((a,b) => b.localeCompare(a, undefined, { numeric:true })).slice(0,32); } catch { return []; }
}
function discoverClient(kind, settings = {}, env = process.env, platform = process.platform, remembered = '') {
  if (!KINDS.includes(kind)) throw Error('未知连接器');
  const configured = String((kind === 'claude' ? settings.tools?.claudeBin : settings.clients?.[kind + 'Bin']) || '').trim();
  if(kind==='claude' && configured && require('./claude-program.cjs').isClaudeDesktop(configured))throw Error('选中的是 Claude Desktop。请为 Claude Code 选择 CLI 原生程序。');
  const home = env.USERPROFILE || env.HOME, suffix = platform === 'win32' ? '.exe' : '';
  const candidates = configured ? [configured] : [
    ...(typeof remembered === 'string' && remembered.trim() ? [remembered.trim()] : []),
    ...(home ? [path.join(home, '.local', 'bin', kind + suffix), path.join(home, '.cargo', 'bin', kind + suffix)] : []),
    ...String(env.PATH || env.Path || '').split(platform === 'win32' ? ';' : ':').map(dir => dir.trim().replace(/^"|"$/g, '')).filter(Boolean).map(dir => path.join(dir, kind + suffix)),
  ];
  if (!configured && platform === 'win32') {
    if (kind === 'codex' && env.LOCALAPPDATA) {
      const root = path.join(env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin');
      candidates.push(path.join(root, 'codex.exe'));
      for (const version of children(root)) candidates.push(path.join(root, version, 'codex.exe'));
    }
    if (kind === 'claude') {
      const prefixes = [env.APPDATA && path.join(env.APPDATA,'npm'), ...String(env.PATH || env.Path || '').split(';').map(p => p.trim().replace(/^"|"$/g,''))].filter(Boolean);
      for (const prefix of prefixes) {
        candidates.push(path.join(prefix,'node_modules','@anthropic-ai','claude-code','bin','claude.exe'));
        for (const arch of ['x64','arm64']) candidates.push(path.join(prefix,'node_modules','@anthropic-ai',`claude-code-win32-${arch}`,'claude.exe'));
      }
      if (home) {
        const versions = path.join(home,'.local','share','claude','versions');
        for (const version of children(versions)) candidates.push(path.join(versions,version,'claude.exe'));
      }
    }
    if (kind === 'kimi') {
      for (const root of [env.APPDATA && path.join(env.APPDATA,'uv','tools','kimi-cli'), env.LOCALAPPDATA && path.join(env.LOCALAPPDATA,'uv','tools','kimi-cli'), home && path.join(home,'.local','share','uv','tools','kimi-cli')].filter(Boolean)) candidates.push(path.join(root,'Scripts','kimi.exe'));
      if (home) candidates.push(path.join(home,'.local','bin','kimi.exe'));
    }
  }
  if (!configured && kind === 'codex') {
    if(env.LOCALAPPDATA)for(const appName of ['Codex','ChatGPT'])candidates.push(path.join(env.LOCALAPPDATA,'Programs',appName,'resources','codex.exe'),path.join(env.LOCALAPPDATA,'Programs',appName,'app','resources','codex.exe'));
    if(platform==='darwin')candidates.push('/Applications/Codex.app/Contents/Resources/codex','/Applications/ChatGPT.app/Contents/Resources/codex');
    // Official npm distributions contain a native binary; never execute their shell shims.
    const vendors = [env.APPDATA && path.join(env.APPDATA, 'npm', 'node_modules', '@openai', 'codex', 'vendor'),
      '/usr/local/lib/node_modules/@openai/codex/vendor', '/opt/homebrew/lib/node_modules/@openai/codex/vendor'].filter(Boolean);
    for (const vendor of vendors) {
      try { for (const dir of fs.readdirSync(vendor).slice(0, 12)) candidates.push(path.join(vendor, dir, 'codex', 'codex' + suffix)); } catch {}
    }
    const apps = env.ProgramFiles && path.join(env.ProgramFiles, 'WindowsApps');
    if (platform === 'win32' && apps) {
      try { for (const dir of fs.readdirSync(apps).filter(n => /^OpenAI\.(Codex|ChatGPT)/.test(n)).slice(-8)) candidates.push(path.join(apps, dir, 'app', 'resources', 'codex.exe')); } catch {}
    }
  }
  for (const file of candidates) {
    if (!path.isAbsolute(file) || /\.(cmd|bat|ps1|js|mjs|cjs)$/i.test(file) || (platform === 'win32' && !/\.exe$/i.test(file))) continue;
    try {
      const real = fs.realpathSync(file);
      if(kind==='claude' && require('./claude-program.cjs').isClaudeDesktop(real))continue;
      if (/\.(cmd|bat|ps1|js|mjs|cjs)$/i.test(real) || (platform === 'win32' && !/\.exe$/i.test(real))) continue;
      if (fs.statSync(real).isFile()) return real;
    } catch {}
  }
  if (!configured && kind === 'kimi' && env.APPDATA && fs.existsSync(path.join(env.APPDATA,'kimi-desktop','daimon-bundle'))) {
    const error = Error('已发现 Kimi 桌面应用，但未找到提供 ACP 接口的 Kimi Code CLI。请安装官方 Kimi Code CLI，或选择其 kimi.exe 后重新检测。');
    error.code = 'DESKTOP_ONLY'; throw error;
  }
  throw Error(`未找到 ${kind === 'codex' ? 'Codex' : kind === 'claude' ? 'Claude Code' : 'Kimi Code'} 官方原生客户端，请安装后重新检测，或选择程序位置。`);
}
module.exports = { discoverClient, KINDS, readClientState, rememberClientState };
