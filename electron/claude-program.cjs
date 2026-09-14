'use strict';
const fs=require('node:fs'),path=require('node:path'),{execFileSync}=require('node:child_process');
function isClaudeDesktop(file) {
  const p=file.replace(/\\/g,'/');
  if(/\/Claude\.app\/Contents\/MacOS\//i.test(p) || /\/(?:Claude|AnthropicClaude)(?:\/app-[^/]+)?\/Claude\.exe$/i.test(p))return true;
  return /(?:^|\/)Claude\.exe$/i.test(p) && fs.existsSync(path.join(path.dirname(file),'resources','app.asar'));
}
function assertClaudeCodeBinary(file,run=execFileSync) {
  if(isClaudeDesktop(file))throw Error('选中的是 Claude Desktop 桌面应用。这里需要 Claude Code CLI 的原生程序，请重新选择。');
  let version='';
  try {version=run(file,['--version'],{encoding:'utf8',shell:false,windowsHide:true,timeout:4000,maxBuffer:16384,env:require('./codex-client.cjs').subscriptionEnvironment()});}catch {throw Error('无法确认这是 Claude Code CLI，请检查程序位置或安装状态。');}
  if(!/^\d+\.\d+\.\d+[^\r\n]*\(Claude Code\)\s*$/i.test(String(version).trim()))throw Error('所选程序没有返回 Claude Code CLI 标识，不能用于此连接。');
}
module.exports={isClaudeDesktop,assertClaudeCodeBinary};
