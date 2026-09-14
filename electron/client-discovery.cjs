'use strict';
const fs = require('node:fs'), path = require('node:path');
const KINDS = ['codex', 'claude', 'kimi'];
function discoverClient(kind, settings = {}, env = process.env, platform = process.platform) {
  if (!KINDS.includes(kind)) throw Error('未知连接器');
  const configured = kind === 'claude' ? settings.tools?.claudeBin : settings.clients?.[kind + 'Bin'];
  const home = env.USERPROFILE || env.HOME, suffix = platform === 'win32' ? '.exe' : '';
  const candidates = configured ? [configured] : [
    ...(home ? [path.join(home, '.local', 'bin', kind + suffix), path.join(home, '.cargo', 'bin', kind + suffix)] : []),
    ...String(env.PATH || env.Path || '').split(platform === 'win32' ? ';' : ':').filter(Boolean).map(dir => path.join(dir, kind + suffix)),
  ];
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
    try { if (fs.statSync(file).isFile()) return fs.realpathSync(file); } catch {}
  }
  throw Error(`未找到 ${kind === 'codex' ? 'Codex' : kind === 'claude' ? 'Claude Code' : 'Kimi Code'} 官方原生客户端，请安装后重新检测，或选择程序位置。`);
}
module.exports = { discoverClient, KINDS };
