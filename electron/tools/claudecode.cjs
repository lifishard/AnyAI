'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { StringDecoder } = require('node:string_decoder');
const { ok, fail, guardPath, firstRoot, clip } = require('./common.cjs');
const { readClaudeConnection } = require('../claude-connection.cjs');

// Clean base environment; the user's allowlisted connection settings are merged separately.
function localLoginEnvironment(source) {
  const allowed = /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|TMPDIR|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|PROGRAMFILES|PROGRAMFILES\(X86\)|PROGRAMDATA|LANG|LC_ALL|TERM)$/i;
  return { ...Object.fromEntries(Object.entries(source).filter(([key]) => allowed.test(key))), NO_COLOR: '1', FORCE_COLOR: '0' };
}
function safeExtraArgs(value) {
  const text = String(value || '').trim();
  if (!text) return [];
  const tokens = text.match(/"[^"]*"|'[^']*'|[^\s]+/g) || [];
  const result = [], seen = new Set();
  for (let i = 0; i < tokens.length; i += 2) {
    const flag = tokens[i], raw = tokens[i + 1];
    const item = raw && raw.replace(/^(["'])(.*)\1$/, '$2');
    const valid = flag === '--model' ? /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,159}$/.test(item || '')
      : flag === '--effort' ? /^(low|medium|high|xhigh|max)$/.test(item || '')
        : flag === '--max-turns' ? /^(?:[1-9]|[1-9][0-9]|100)$/.test(item || '') : false;
    if (!valid || seen.has(flag)) throw Error('Claude Code 附加参数仅支持 --model、--effort 和 --max-turns；权限、认证与执行参数须由接入配置管理。');
    seen.add(flag); result.push(flag, item);
  }
  return result;
}
function resolveNative(bin, env, platform, exists = fs.existsSync) {
  const chosen = String(bin || '').trim();
  if(chosen && require('../claude-program.cjs').isClaudeDesktop(chosen))throw Error('选中的是 Claude Desktop，请选择 Claude Code CLI 原生程序。');
  if (chosen && /\.(cmd|bat|ps1|js)$/i.test(chosen)) throw Error('请配置官方 Claude Code 原生可执行文件，不能使用 shell 脚本或 npm 垫片。');
  const candidates = chosen ? [chosen] : [
    ...(env.USERPROFILE || env.HOME ? [path.join(env.USERPROFILE || env.HOME, '.local', 'bin', platform === 'win32' ? 'claude.exe' : 'claude')] : []),
    ...String(env.PATH || env.Path || '').split(platform === 'win32' ? ';' : ':').filter(Boolean).map(dir => path.join(dir, platform === 'win32' ? 'claude.exe' : 'claude')),
  ];
  for (const file of candidates) {
    if (!path.isAbsolute(file) || (platform === 'win32' && !/\.exe$/i.test(file))) continue;
    if (exists(file) && !require('../claude-program.cjs').isClaudeDesktop(file)) return file;
  }
  return require('../client-discovery.cjs').discoverClient('claude', {tools:{claudeBin:chosen}}, env, platform);
}
// Injectable process boundary permits offline tests without model calls.
function createClaudeCode(deps = {}) {
  const launch = deps.spawn || spawn, platform = deps.platform || process.platform;
  const environment = deps.env || process.env, later = deps.setTimeout || setTimeout, clear = deps.clearTimeout || clearTimeout;
  return function claudeCode(args = {}, ctx = {}) {
    let cwd, command, extra, connection;
    try {
      cwd = guardPath(args.cwd || firstRoot(ctx.workspaceRoots), ctx.workspaceRoots, { mustExist: true });
      if (!fs.statSync(cwd).isDirectory()) throw Error('Claude Code 工作目录必须是文件夹');
      if (!String(args.prompt || '').trim()) throw Error('prompt 不能为空');
      extra = safeExtraArgs(ctx.claudeExtraArgs);
      command = resolveNative(ctx.claudeBin, environment, platform, deps.exists);
      (deps.validateBinary || require('../claude-program.cjs').assertClaudeCodeBinary)(command);
      connection = (deps.readClaudeConnection || readClaudeConnection)(environment);
    } catch (e) { return Promise.resolve(fail(e)); }
    const runId = randomUUID(), startedAt = new Date().toISOString();
    const record = (status, details = {}) => ({ runId, startedAt, finishedAt: new Date().toISOString(), provider: 'claude-code', authSource: connection.baseUrl ? 'claude-user-routing-config' : 'official-client-local-login', status, ...details });
    if (ctx.signal?.aborted) return Promise.resolve({ ...fail('Claude Code 已取消，尚未启动'), execution: record('cancelled'), cancelled: true });
    return new Promise(resolve => {
      let child, done = false, reason = null, stdout = '', bytes = 0, timer, stopTimer;
      const decoder = new StringDecoder('utf8');
      const finish = result => {
        if (done) return; done = true; clear(timer); clear(stopTimer);
        ctx.signal?.removeEventListener('abort', cancel); resolve(result);
      };
      const stopped = (code, signal) => ({ ...fail(reason === 'timeout' ? 'Claude Code 已超时；执行结果需要核实' : reason === 'cancelled' ? 'Claude Code 已取消；已开始的操作需要核实' : 'Claude Code 输出或进程中断，结果需要核实'), uncertain: true, cancelled: reason === 'cancelled', execution: record(reason || 'interrupted', { exitCode: code ?? null, signal: signal || null }) });
      const stop = why => {
        if (done || reason) return; reason = why;
        // Windows tree termination uses native taskkill directly, never a shell.
        if (platform === 'win32' && Number.isInteger(child.pid)) {
          const root = environment.SystemRoot || environment.SYSTEMROOT || 'C:\\Windows';
          try { launch(path.join(root, 'System32', 'taskkill.exe'), ['/pid', String(child.pid), '/t', '/f'], { shell: false, windowsHide: true, stdio: 'ignore', env: localLoginEnvironment(environment) }).on('error', () => { try { child.kill(); } catch {} }); } catch { try { child.kill(); } catch {} }
        } else {
          try { (deps.killGroup || process.kill)(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch {} }
        }
        stopTimer = later(() => { if (!done) { try { if (platform !== 'win32') (deps.killGroup || process.kill)(-child.pid, 'SIGKILL'); else child.kill(); } catch {} finish(stopped(null, null)); } }, 5000);
      };
      const cancel = () => stop('cancelled');
      try {
        child = launch(command, ['-p', '--output-format', 'json', '--permission-mode', 'dontAsk', '--setting-sources', '', '--settings', '{"disableAllHooks":true}', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', ...(ctx.chatOnly ? ['--tools', '', '--disallowedTools', 'mcp__*'] : []), ...extra], {
          cwd, shell: false, windowsHide: true, detached: platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'], env: {...localLoginEnvironment(environment),...connection.env},
        });
      } catch { finish({ ...fail('无法启动 Claude Code 客户端'), execution: record('launch_failed') }); return; }
      timer = later(() => stop('timeout'), Math.min(3600000, Math.max(10000, Number(ctx.claudeTimeoutMs) || 600000)));
      child.stdout.on('data', chunk => { bytes += Buffer.byteLength(chunk); if (bytes > 4 * 1024 * 1024) stop('output_limit'); else stdout += decoder.write(Buffer.from(chunk)); });
      // Do not expose vendor diagnostics that may contain secrets or private files.
      child.stderr.on('data', () => {});
      child.stdin.on('error', () => stop('stdin_failed'));
      child.on('error', () => finish({ ...fail('无法启动 Claude Code 客户端，请检查原生客户端路径'), execution: record('launch_failed') }));
      child.on('close', (code, signal) => {
        if (reason) return finish(stopped(code, signal));
        stdout += decoder.end();
        let result;
        try { result = JSON.parse(stdout); } catch {}
        const sessionId = typeof result?.session_id === 'string' && /^[a-zA-Z0-9_-]{1,160}$/.test(result.session_id) ? result.session_id : null;
        const details = { exitCode: code ?? null, signal: signal || null, sessionId };
        if (signal || code === null) return finish({ ...fail('Claude Code 进程中断，执行结果需要核实'), uncertain: true, execution: record('interrupted', details) });
        if (code !== 0 || signal || result?.is_error === true || (result?.subtype && result.subtype !== 'success')) {
          return finish({ ...fail('Claude Code 执行失败，请在官方客户端检查登录、额度或工具权限'), execution: record('failed', details) });
        }
        if (result?.type !== 'result' || result?.subtype !== 'success' || result?.is_error !== false || typeof result.result !== 'string') {
          return finish({ ...fail('Claude Code 未返回可靠的结构化完成记录，需要核实结果'), uncertain: true, execution: record('needs_verification', details) });
        }
        if (Array.isArray(result.permission_denials) && result.permission_denials.length) {
          return finish({ ...fail('Claude Code 的工具操作需要批准；请在官方客户端完成批准后核实任务，不会自动放宽权限'), execution: record('permission_required', details) });
        }
        finish(ok(clip(result.result, 60000), { summary: 'Claude Code 已返回结果（产物仍需验收）', execution: record('succeeded', details) }));
      });
      ctx.signal?.addEventListener('abort', cancel, { once: true });
      if (ctx.signal?.aborted) cancel();
      if (!reason) child.stdin.end(String(args.prompt));
    });
  };
}
module.exports = { claudeCode: createClaudeCode(), createClaudeCode, safeExtraArgs, localLoginEnvironment, resolveNative };
