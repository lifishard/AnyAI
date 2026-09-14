'use strict';
const { spawn: nativeSpawn } = require('node:child_process');
const path = require('node:path');
const { StringDecoder } = require('node:string_decoder');

// Only the official CLI owns subscription credentials. Never forward API keys,
// proxy/provider overrides, NODE_OPTIONS, or a caller-supplied CODEX_HOME.
function subscriptionEnvironment(source = process.env) {
  const allowed = /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|TMPDIR|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|PROGRAMFILES|PROGRAMFILES\(X86\)|PROGRAMDATA|LANG|LC_ALL|TERM)$/i;
  return { ...Object.fromEntries(Object.entries(source).filter(([key]) => allowed.test(key))), NO_COLOR: '1' };
}

function createCodexClient({ binary, cwd, spawn = nativeSpawn, env = process.env, requestTimeoutMs = 30000, turnTimeoutMs = 30 * 60 * 1000, cancelTimeoutMs = 5000, approvalTimeoutMs = 5 * 60 * 1000 } = {}) {
  if (!binary || !path.isAbsolute(binary) || /\.(cmd|bat|ps1|js)$/i.test(binary) || (process.platform === 'win32' && !/\.exe$/i.test(binary))) throw Error('Configure the official native Codex executable using an absolute path.');
  if (!cwd || !path.isAbsolute(cwd)) throw Error('Codex requires an absolute project directory.');
  let child, handshake, dead = false, nextId = 1, active = null, buffer = '';
  const decoder = new StringDecoder('utf8'), pending = new Map();
  const safeEnv = subscriptionEnvironment(env);
  function send(message) {
    if (dead || !child?.stdin?.writable) throw Error('Codex connection is closed.');
    child.stdin.write(JSON.stringify(message) + '\n');
  }
  function finish(status, error = null) {
    const run = active;
    if (!run || run.settled) return;
    run.settled = true;
    expireApprovals(run, 'turn_ended');
    clearTimeout(run.timer); clearTimeout(run.cancelTimer);
    run.signal?.removeEventListener('abort', run.abort);
    active = null;
    run.resolve({ status, threadId: run.threadId || null, turnId: run.turnId || null, text: run.finals.size ? [...run.finals.values()].join('\n') : run.text, error, pendingApprovals: run.approvals });
  }
  function disconnect(reason) {
    if (dead) return;
    dead = true;
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(Error(reason)); }
    pending.clear();
    finish('unknown', reason);
    try { child?.kill(); } catch { /* already exited */ }
  }
  function request(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => { pending.delete(id); reject(Error(`Codex ${method} timed out.`)); disconnect('Codex response timed out; execution state is unknown.'); }, requestTimeoutMs);
      pending.set(id, { resolve, reject, timer });
      try { send({ id, method, params }); } catch (error) { pending.delete(id); clearTimeout(timer); reject(error); }
    });
  }
  function emit(run, event) {
    try { run.onEvent?.(event); } catch { disconnect('Codex event could not be recorded; execution state is unknown.'); }
  }
  function notification(message) {
    const run = active, p = message.params || {};
    if (!run || p.threadId !== run.threadId) return;
    const eventTurn = p.turnId || p.turn?.id;
    if (!run.turnId) {
      if (run.starting && run.early.length < 1000) run.early.push(message);
      else if (run.early.length >= 1000) disconnect('Codex sent too many events before acknowledging its turn.');
      return;
    }
    const method = message.method;
    if (method === 'client/approvalRequest') { serverRequest(p.message); return; }
    if (eventTurn !== run.turnId) return;
    if (method === 'approval_required') { run.approvals.push(p); emit(run, p); return; }
    if (method === 'turn/completed') {
      emit(run, { type: method, ...p });
      const status = p.turn?.status;
      if (status === 'completed') finish(run.approvals.length || run.waitingApprovals.size ? 'approval_required' : 'completed');
      else if (status === 'interrupted') finish('cancelled');
      else if (status === 'failed') finish('failed', String(p.turn?.error?.message || 'Codex turn failed.').slice(0, 4000));
      else disconnect('Codex returned an unrecognized terminal status.');
      return;
    }
    if (method === 'item/agentMessage/delta' && typeof p.delta === 'string') run.text = (run.text + p.delta).slice(-2_000_000);
    if (method === 'item/completed' && p.item?.type === 'agentMessage' && p.item?.phase !== 'commentary' && typeof p.item.text === 'string') run.finals.set(p.item.id, p.item.text.slice(0, 2_000_000));
    if (method === 'item/started' && p.item?.type === 'fileChange' && typeof p.item.id === 'string') run.fileChanges.set(p.item.id, p.item.changes || []);
    if (/^(item\/(started|completed|agentMessage\/delta|commandExecution\/outputDelta|fileChange\/outputDelta)|turn\/started|error)$/.test(method)) emit(run, { type: method, ...p });
  }
  function expireApprovals(run, reason) {
    for (const entry of [...run.waitingApprovals.values()]) entry.resolve('decline', reason);
  }
  function serverRequest(message) {
    const p = message.params || {}, run = active;
    const interactive = /^item\/(commandExecution|fileChange)\/requestApproval$/.test(message.method);
    if (interactive && run && p.threadId === run.threadId && !run.turnId && run.starting) {
      notification({ method: 'client/approvalRequest', params: { threadId: p.threadId, turnId: p.turnId, message } });
      return;
    }
    if (interactive && run && p.threadId === run.threadId && p.turnId === run.turnId && typeof p.itemId === 'string' && p.itemId && !run.aborted && !run.settled && typeof run.onApproval === 'function') {
      if (run.seenApprovals.has(message.id)) { disconnect('Codex repeated an approval request ID.'); return; }
      run.seenApprovals.add(message.id);
      const event = { type: 'approval_required', method: message.method, requestId: message.id, threadId: p.threadId, turnId: p.turnId, itemId: p.itemId, command: p.command || null, cwd: p.cwd || null, grantRoot: p.grantRoot || null, reason: p.reason || null, changes: run.fileChanges.get(p.itemId) || [], commandActions: p.commandActions || [], networkApprovalContext: p.networkApprovalContext || null, availableDecisions: ['accept', 'decline'], decision: null };
      const entry = { timer: null, resolve: (decision, reason = 'user') => {
        if (run.waitingApprovals.get(message.id) !== entry) return;
        run.waitingApprovals.delete(message.id); clearTimeout(entry.timer);
        const valid = active === run && !run.settled && !run.aborted && !dead;
        const chosen = valid && decision === 'accept' && (!Array.isArray(p.availableDecisions) || p.availableDecisions.includes('accept')) ? 'accept' : 'decline';
        const resolved = { ...event, type: 'approval/resolved', decision: chosen, resolutionReason: reason };
        if (chosen !== 'accept') run.approvals.push({ ...resolved, type: 'approval_required' });
        // Persist the exact decision before granting the native process authority.
        if (!run.settled && !dead) emit(run, resolved);
        const finalDecision = chosen === 'accept' && (active !== run || run.settled || run.aborted || dead) ? 'decline' : chosen;
        if (!dead) { try { send({ id: message.id, result: { decision: finalDecision } }); } catch { disconnect('Codex approval response could not be delivered.'); } }
      } };
      run.waitingApprovals.set(message.id, entry);
      entry.timer = setTimeout(() => entry.resolve('decline', 'timeout'), approvalTimeoutMs);
      emit(run, { ...event, type: 'approval/requested' });
      if (dead || run.settled || run.aborted) { entry.resolve('decline', 'expired'); return; }
      // Supply a detached snapshot so UI code cannot mutate the authority scope.
      Promise.resolve().then(() => {
        if (run.waitingApprovals.get(message.id) !== entry || active !== run || run.aborted || run.settled) return 'decline';
        return run.onApproval(JSON.parse(JSON.stringify(event)));
      }).then(decision => entry.resolve(decision), () => entry.resolve('decline', 'callback_error'));
      return;
    }
    let result;
    if (interactive) result = { decision: 'decline' };
    else if (message.method === 'item/permissions/requestApproval') result = { permissions: {}, scope: 'turn' };
    else if (message.method === 'mcpServer/elicitation/request') result = { action: 'decline', content: null };
    if (result) {
      // A decline never grants authority, even when the request scope is malformed.
      send({ id: message.id, result });
      if (run && p.threadId === run.threadId) {
        const event = { type: 'approval_required', method: message.method, requestId: message.id, threadId: p.threadId, turnId: p.turnId || null, itemId: p.itemId || null, command: p.command || null, cwd: p.cwd || null, grantRoot: p.grantRoot || null, reason: p.reason || null, permissions: p.permissions || null, decision: 'decline' };
        notification({ method: 'approval_required', params: event });
      }
    } else {
      send({ id: message.id, error: { code: -32601, message: 'This client does not authorize this request.' } });
      if (run && p.threadId === run.threadId) notification({ method: 'approval_required', params: { type: 'approval_required', method: message.method, requestId: message.id, threadId: p.threadId, turnId: p.turnId || null, itemId: p.itemId || null, decision: 'decline', reason: 'Unsupported server request.' } });
    }
  }
  function accept(message) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) return;
    if (message.method && Object.hasOwn(message, 'id')) { serverRequest(message); return; }
    if (Object.hasOwn(message, 'id')) {
      const wait = pending.get(message.id); if (!wait) return;
      pending.delete(message.id); clearTimeout(wait.timer);
      if (message.error) wait.reject(Error(String(message.error.message || 'Codex request failed.').slice(0, 4000)));
      else if (Object.hasOwn(message, 'result')) wait.resolve(message.result);
      else wait.reject(Error('Malformed Codex response.'));
      return;
    }
    if (typeof message.method === 'string') notification(message);
  }
  function start() {
    if (handshake) return handshake;
    handshake = (async () => {
      child = spawn(binary, ['-c', 'model_provider="openai"', '-c', 'forced_login_method="chatgpt"', 'app-server'], { cwd, env: safeEnv, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      child.on('error', () => disconnect('The official Codex process could not start.'));
      child.on('close', code => disconnect(`Codex process exited (${code ?? 'unknown'}); no matching terminal event was received.`));
      child.stdin.on('error', () => disconnect('Codex input stream closed.'));
      child.stderr.on('data', () => {}); // Drain without persisting possible credential diagnostics.
      child.stdout.on('data', chunk => {
        buffer += decoder.write(chunk);
        if (buffer.length > 8_000_000) { disconnect('Codex protocol frame exceeded the size limit.'); return; }
        let newline;
        while (!dead && (newline = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newline).trim(); buffer = buffer.slice(newline + 1);
          if (!line) continue;
          try { accept(JSON.parse(line)); } catch { disconnect('Codex returned an invalid protocol frame.'); }
        }
      });
      await request('initialize', { clientInfo: { name: 'wickrunai', title: 'wickrunAI', version: '1.0.0' } });
      send({ method: 'initialized', params: {} });
    })();
    return handshake;
  }
  async function readAccount() {
    await start();
    const value = await request('account/read', { refreshToken: false });
    return { account: value.account ? { type: value.account.type, planType: value.account.planType || null } : null, requiresOpenaiAuth: !!value.requiresOpenaiAuth };
  }
  async function login() {
    await start();
    const value = await request('account/login/start', { type: 'chatgpt' });
    const url = new URL(value.authUrl);
    if (url.protocol !== 'https:' || !['auth.openai.com', 'auth.chatgpt.com', 'chatgpt.com'].includes(url.hostname) || url.username || url.password) throw Error('Codex returned an unexpected login address.');
    return { type: 'chatgpt', loginId: value.loginId, authUrl: value.authUrl };
  }
  async function readRateLimits() { await start(); return request('account/rateLimits/read'); }
  async function listModels({ cursor } = {}) { await start(); return request('model/list', { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) }); }
  async function run(options = {}) {
    if (active) throw Error('A Codex turn is already active.');
    const project = options.cwd || cwd, sandbox = options.sandbox || 'readOnly';
    if (!path.isAbsolute(project) || !['readOnly', 'workspaceWrite'].includes(sandbox)) throw Error('Codex requires a project directory and a supported sandbox.');
    if (typeof options.prompt !== 'string' || !options.prompt.trim()) throw Error('A prompt is required.');
    if (options.signal?.aborted) return { status: 'cancelled', threadId: options.threadId || null, turnId: null, text: '', error: null, pendingApprovals: [] };
    let resolve;
    const outcome = new Promise(done => { resolve = done; });
    const state = active = { resolve, threadId: options.threadId || null, turnId: null, text: '', finals: new Map(), fileChanges: new Map(), approvals: [], waitingApprovals: new Map(), seenApprovals: new Set(), early: [], onEvent: options.onEvent, onApproval: options.onApproval, signal: options.signal, settled: false, starting: false, aborted: false };
    state.abort = () => {
      state.aborted = true;
      expireApprovals(state, 'cancelled');
      if (!state.starting && !state.turnId) { finish('cancelled'); return; }
      if (state.turnId) request('turn/interrupt', { threadId: state.threadId, turnId: state.turnId }).catch(() => {});
      if (!state.cancelTimer) state.cancelTimer = setTimeout(() => disconnect('Cancellation was requested but not confirmed; execution state is unknown.'), cancelTimeoutMs);
    };
    state.signal?.addEventListener('abort', state.abort, { once: true });
    state.timer = setTimeout(() => disconnect('Codex turn timed out; execution state is unknown.'), turnTimeoutMs);
    (async () => {
      try {
        const account = await readAccount();
        if (state.settled) return;
        if (account.account?.type !== 'chatgpt') { finish('failed', 'Sign in through the official Codex ChatGPT login before using this subscription route. API-key authentication is not accepted.'); return; }
        let isolatedConfig;
        if(options.isolateTools){
          const effective=await request('config/read',{includeLayers:false,cwd:project});
          if(!effective.config || typeof effective.config!=='object')throw Error('Cannot verify local tool configuration for this connection.');
          isolatedConfig={'features.apps':false,'features.hooks':false,'features.codex_hooks':false,'features.multi_agent':false,'features.skill_mcp_dependency_install':false,'features.browser_use':false,'features.computer_use':false,'web_search':'disabled'};
          for(const name of Object.keys(effective.config.mcp_servers || {}))isolatedConfig[`mcp_servers.${JSON.stringify(name)}.enabled`]=false;
          for(const name of Object.keys(effective.config.plugins || {}))isolatedConfig[`plugins.${JSON.stringify(name)}.enabled`]=false;
          if(sandbox==='readOnly')Object.assign(isolatedConfig,{'features.shell_tool':false,'features.unified_exec':false,'features.apply_patch_freeform':false});
        }
        const config = { cwd: project, modelProvider: 'openai', approvalPolicy: 'untrusted', approvalsReviewer: 'user', sandbox: sandbox === 'readOnly' ? 'read-only' : 'workspace-write', ...(options.model ? { model: options.model } : {}),...(isolatedConfig?{config:isolatedConfig}:{}) };
        const thread = await request(state.threadId ? 'thread/resume' : 'thread/start', { ...config, ...(state.threadId ? { threadId: state.threadId } : {}) });
        if (state.settled) return;
        if (typeof thread.thread?.id !== 'string' || !thread.thread.id || (state.threadId && thread.thread.id !== state.threadId)) throw Error('Codex did not return the requested thread.');
        state.threadId = thread.thread.id;
        emit(state, { type: 'thread/ready', threadId: state.threadId });
        if (state.settled) return;
        state.starting = true;
        const reply = await request('turn/start', { threadId: state.threadId, cwd: project, approvalPolicy: 'untrusted', approvalsReviewer: 'user', sandboxPolicy: sandbox === 'workspaceWrite' ? { type: sandbox, writableRoots: [project], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true } : { type: sandbox, networkAccess: false }, input: [{ type: 'text', text: options.prompt }], ...(options.model ? { model: options.model } : {}), ...(options.effort ? { effort: options.effort } : {}) });
        if (state.settled) return;
        if (typeof reply.turn?.id !== 'string' || !reply.turn.id) throw Error('Codex did not identify the started turn.');
        state.turnId = reply.turn.id;
        emit(state, { type: 'turn/ready', threadId: state.threadId, turnId: state.turnId });
        if (state.aborted) state.abort();
        for (const event of state.early) notification(event);
        state.early.length = 0;
      } catch (error) {
        if (!state.settled) { const uncertain = state.starting; finish(uncertain ? 'unknown' : 'failed', error.message); if (uncertain) disconnect('Codex turn startup failed; execution state is unknown.'); }
      }
    })();
    return outcome;
  }
  return { start, readAccount, login, readRateLimits, listModels, run, close: () => disconnect('Codex connection closed; execution state is unknown.') };
}
module.exports = { createCodexClient, subscriptionEnvironment };
