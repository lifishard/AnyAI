const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { discoverClient, readClientState, rememberClientState } = require('../electron/client-discovery.cjs');
const { resolveNative } = require('../electron/tools/claudecode.cjs');
function fixture(t) {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'client-discovery-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const env={USERPROFILE:root,LOCALAPPDATA:path.join(root,'Local'),APPDATA:path.join(root,'Roaming'),PATH:''};
 const file=(...parts)=>{const p=path.join(...parts);fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,'fixture');return fs.realpathSync(p);};
 return {root,env,file};
}
test('finds Codex desktop version directories even with a stale desktop PATH',t=>{
 const f=fixture(t),exe=f.file(f.env.LOCALAPPDATA,'OpenAI','Codex','bin','7ac07f4ce733f89a','codex.exe');
 assert.equal(discoverClient('codex',{},f.env,'win32'),exe);
});
test('finds Claude official npm native payload without executing a shim',t=>{
 const f=fixture(t),exe=f.file(f.env.APPDATA,'npm','node_modules','@anthropic-ai','claude-code','bin','claude.exe');
 f.file(f.env.APPDATA,'npm','claude.cmd');
 assert.equal(discoverClient('claude',{},f.env,'win32'),exe);
 assert.equal(resolveNative('',f.env,'win32'),exe);
});

test('Claude Desktop cannot be selected or discovered as Claude Code',t=>{
 const f=fixture(t),desktop=f.file(f.root,'Claude','app-1.0','Claude.exe');f.env.PATH=require('node:path').dirname(desktop);
 assert.throws(()=>discoverClient('claude',{tools:{claudeBin:desktop}},f.env,'win32'),/Claude Desktop/);
 assert.throws(()=>resolveNative(desktop,f.env,'win32'),/Claude Desktop/);
 assert.throws(()=>discoverClient('claude',{},f.env,'win32'),/Claude Code/);
 const cli=f.file(f.env.APPDATA,'npm','node_modules','@anthropic-ai','claude-code','bin','claude.exe');
 assert.equal(discoverClient('claude',{},f.env,'win32'),cli);
});

test('Claude Code identity requires its version signature, not just an executable filename',()=>{
 const {assertClaudeCodeBinary}=require('../electron/claude-program.cjs');
 assert.doesNotThrow(()=>assertClaudeCodeBinary('/cli/claude.exe',()=> '2.1.270 (Claude Code)\n'));
 assert.throws(()=>assertClaudeCodeBinary('/cli/claude.exe',()=> '1.0.0 (Claude Desktop)'),/CLI 标识/);
 let executed=false;assert.throws(()=>assertClaudeCodeBinary('/Applications/Claude.app/Contents/MacOS/Claude',()=>{executed=true;}),/Claude Desktop/);assert.equal(executed,false);
});
test('quoted PATH works and explicit invalid paths never silently select another client',t=>{
 const f=fixture(t),exe=f.file(f.root,'with spaces','codex.exe');f.env.PATH='"'+path.dirname(exe)+'"';
 assert.equal(discoverClient('codex',{},f.env,'win32'),exe);
 assert.throws(()=>discoverClient('codex',{clients:{codexBin:path.join(f.root,'missing.exe')}},f.env,'win32'));
 const shim=f.file(f.root,'codex.cmd');assert.throws(()=>discoverClient('codex',{clients:{codexBin:shim}},f.env,'win32'));
});
test('finds uv Kimi CLI and distinguishes desktop-only installation',t=>{
 const f=fixture(t);fs.mkdirSync(path.join(f.env.APPDATA,'kimi-desktop','daimon-bundle'),{recursive:true});
 assert.throws(()=>discoverClient('kimi',{},f.env,'win32'),e=>e.code==='DESKTOP_ONLY');
 const exe=f.file(f.env.APPDATA,'uv','tools','kimi-cli','Scripts','kimi.exe');
 assert.equal(discoverClient('kimi',{},f.env,'win32'),exe);
});

test('a validated discovered executable survives restart without PATH while explicit settings still win',t=>{
 const f=fixture(t),first=f.file(f.root,'installed','codex.exe'),explicit=f.file(f.root,'chosen','codex.exe');
 assert.equal(rememberClientState(f.root,'codex',{binary:first,status:'ready'}),true);
 const reopened=readClientState(f.root);assert.equal(reopened.clients.codex.binary,first);assert.equal(reopened.clients.codex.status,'ready');
 assert.equal(discoverClient('codex',{},f.env,'win32',reopened.clients.codex.binary),first);
 assert.equal(discoverClient('codex',{clients:{codexBin:explicit}},f.env,'win32',reopened.clients.codex.binary),explicit);
});
