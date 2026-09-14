'use strict';
const path = require('node:path'), fs = require('node:fs'), crypto = require('node:crypto');
const { createCodexClient } = require('./codex-client.cjs');
const { claudeCode, resolveNative } = require('./tools/claudecode.cjs');

function createLocalClients({ userData, collaboration, teamFiles, getSettings, openExternal, deps = {} }) {
  const codexFactory = deps.createCodexClient || createCodexClient, runClaude = deps.claudeCode || claudeCode;
  const active = new Map(), approvals = new Map(), loginClients = new Map();
  const scratch = path.join(userData, 'client-work'); fs.mkdirSync(scratch, { recursive: true });
  const text = (value, max = 2000000) => typeof value === 'string' ? value.slice(0, max) : '';
  function binary(kind) {
    const settings = getSettings();
    if (kind === 'codex') {
      return require('./client-discovery.cjs').discoverClient('codex',settings);
    }
    if (kind !== 'claude') throw Error('未知客户端');
    return (deps.resolveNative || resolveNative)(settings.tools?.claudeBin, process.env, process.platform);
  }
  function find(scope) {
    const data = collaboration.read(), project = data.projects[scope.projectId], run = project?.runs.find(r => r.id === scope.runId);
    if (!run) throw Error('运行不存在');
    return { data, project, run, attempt: run.attempts.find(a => a.id === scope.attemptId), member: run.members.find(m => m.id === scope.memberId) };
  }
  function persist(scope, fn) {
    const current = find(scope); fn(current.run, current.attempt, current.project);
    current.run.updatedAt = Date.now(); collaboration.update(current.data.revision, current.project);
  }
  function event(run, kind, body, scope) { run.events.push({ id: crypto.randomUUID(), at: Date.now(), kind, nodeId: scope.nodeId, memberId: scope.memberId, attemptId: scope.attemptId, ...body }); }
  function authorized(scope, live = false) {
    const current = find(scope), { run, member, attempt } = current;
    const node = run.version?.graph?.nodes?.find(n => n.id === attempt?.nodeId);
    const assigned = node?.type === 'discussion' ? node.participants?.includes(scope.memberId) : node?.memberId === scope.memberId;
    if (!(live ? ['running', 'waiting_user'].includes(run.status) : run.status === 'running') || attempt?.status !== 'running' || !['agent', 'discussion', 'review', 'handoff'].includes(node?.type) || !assigned || !member?.enabled || !['client:codex', 'client:claude'].includes(member.connectionId)) throw Error('本机成员尚未获得本次执行资格');
    const allowed = run.projectSettings?.allowedConnections;
    if (!Array.isArray(allowed) || (allowed.length && !allowed.includes(member.connectionId))) throw Error('项目不允许这个本机接入');
    const amount = run.reservations?.[scope.attemptId + ':' + scope.memberId], reserved = Object.values(run.reservations || {}).reduce((sum, n) => sum + n, 0);
    if (!Number.isFinite(amount) || amount <= 0 || amount > (member.maxTokens || run.version.graph.maxTokens) || !Number.isFinite(reserved) || !Number.isFinite(run.version.graph.maxTokens) || (run.tokens || 0) + reserved > run.version.graph.maxTokens) throw Error('本机执行缺少有效的用量预留');
    let cwd = scratch;
    if (scope.fileSessionId) {
      const file = teamFiles.get(scope.fileSessionId);
      if (!file || file.projectId !== scope.projectId || file.taskId !== scope.runId || file.memberId !== scope.memberId || !['isolated', 'pending'].includes(file.status) || file.recoveryRequired || !path.isAbsolute(file.isolatedRoot || '') || !run.projectSettings.roots?.some(root => path.resolve(root) === path.resolve(file.root)) || !current.project.files.some(f => f.id === scope.fileSessionId)) throw Error('本机客户端隔离区无效或尚未授权');
      cwd = file.isolatedRoot;
    }
    return { ...current, cwd, node };
  }
  function queueOf(run) {
    const queue = run.approvalQueue || [];
    if (run.pendingApproval && !queue.some(a => a.nodeId === run.pendingApproval.nodeId)) queue.unshift(run.pendingApproval);
    run.approvalQueue = queue; return queue;
  }
  function promote(run) { const queue = queueOf(run); if (queue.length) run.pendingApproval = queue[0]; else delete run.pendingApproval; }
  function settle(entry, approved, reason = 'user') {
    if (approvals.get(entry.id) !== entry) return false;
    approvals.delete(entry.id); let decision = approved === true, denied = null;
    if (decision) {
      try { authorized(entry.job.scope, true); if (entry.job.controller.signal.aborted || !active.has(entry.job.key)) decision = false; }
      catch (error) { decision = false; denied = error; }
    }
    try {
      persist(entry.job.scope, run => {
        run.approvalQueue = queueOf(run).filter(a => a.nodeId !== entry.id);
        if (run.pendingApproval?.nodeId === entry.id) delete run.pendingApproval;
        event(run, 'permission', { text: `官方客户端当前操作：${decision ? '批准' : '拒绝'}（${reason}）`, approvalId: entry.id }, entry.job.scope); promote(run);
      });
    } catch (error) { decision = false; entry.job.failure = error.message; entry.job.controller.abort(); entry.resolve('decline'); throw error; }
    entry.resolve(decision ? 'accept' : 'decline');
    if (denied) { entry.job.failure = denied.message; entry.job.controller.abort(); throw denied; }
    return true;
  }
  function clearApprovals(job, reason) { for (const entry of [...approvals.values()]) if (entry.job === job) { try { settle(entry, false, reason); } catch { /* already aborted */ } } }
  async function check(kind) {
    if (kind === 'claude') return { kind, binary: binary(kind), status: 'installed', message: '已找到官方原生客户端；登录与额度由 Claude Code 管理，尚未调用模型。' };
    if (kind !== 'codex') throw Error('未知客户端');
    const client = codexFactory({ binary: binary(kind), cwd: scratch });
    try {
      const account = await client.readAccount(), limits = await client.readRateLimits().catch(() => null), models = await client.listModels().catch(() => null);
      const cleanWindow = w => w ? Object.fromEntries(['usedPercent', 'windowDurationMins', 'resetsAt'].filter(k => Number.isFinite(w[k])).map(k => [k, w[k]])) : null;
      const cleanLimit = l => l ? { primary: cleanWindow(l.primary), secondary: cleanWindow(l.secondary) } : null;
      return { kind, status: 'available', account: { account: account.account ? { type: ['chatgpt', 'apiKey'].includes(account.account.type) ? account.account.type : 'unknown', planType: text(account.account.planType, 80) || null } : null, requiresOpenaiAuth: !!account.requiresOpenaiAuth }, rateLimits: limits ? { rateLimits: cleanLimit(limits.rateLimits), rateLimitsByLimitId: Object.fromEntries(Object.entries(limits.rateLimitsByLimitId || {}).map(([id, value]) => [id, cleanLimit(value)])) } : null, models: models ? { data: (models.data || []).map(m => ({ id: text(m.id, 160), model: text(m.model, 160), displayName: text(m.displayName, 160), defaultReasoningEffort: text(m.defaultReasoningEffort, 40), supportedReasoningEfforts: (m.supportedReasoningEfforts || []).map(e => ({ reasoningEffort: text(e.reasoningEffort, 40), description: text(e.description, 300) })) })), nextCursor: text(models.nextCursor, 500) || null } : null };
    } catch { throw Error('无法读取官方客户端连接状态，请在官方客户端检查登录。'); }
    finally { client.close(); }
  }
  async function login() {
    loginClients.get('codex')?.close(); const client = codexFactory({ binary: binary('codex'), cwd: scratch }); loginClients.set('codex', client);
    try {
      const result = await client.login(), url = new URL(result.authUrl);
      if (url.protocol !== 'https:' || !['auth.openai.com', 'auth.chatgpt.com', 'chatgpt.com'].includes(url.hostname) || url.username || url.password) throw Error('官方登录地址无效');
      await openExternal(url.href); return { status: 'waiting_login', message: '请在官方浏览器页面完成登录，然后检查连接。' };
    } catch { client.close(); loginClients.delete('codex'); throw Error('无法打开官方客户端登录，请检查本机客户端。'); }
  }
  async function run(args = {}) {
    const scope = Object.fromEntries(['projectId', 'runId', 'attemptId', 'memberId', 'fileSessionId'].map(k => [k, args[k]]));
    if (['projectId', 'runId', 'attemptId', 'memberId'].some(k => typeof scope[k] !== 'string' || !scope[k])) throw Error('本机执行身份不完整');
    if (typeof args.prompt !== 'string' || !args.prompt.trim() || args.prompt.length > 2000000) throw Error('本机执行提示无效');
    const { run: snapshot, member, cwd: authorizedCwd, node } = authorized(scope); scope.nodeId = node.id;
    const key = JSON.stringify([scope.projectId, scope.runId, scope.attemptId, scope.memberId]);
    if (active.has(key) || snapshot.events.some(e => e.kind === 'client_dispatch' && e.clientKey === key)) throw Error('本机客户端调用已派发；请核实结果后创建新尝试');
    if ([...active.values()].filter(job => job.scope.projectId === scope.projectId && job.scope.runId === scope.runId).length >= snapshot.projectSettings.maxConcurrent) throw Error('本机客户端已达到本次运行的并发上限');
    const cwd = scope.fileSessionId ? authorizedCwd : path.join(scratch, crypto.createHash('sha256').update(key).digest('hex'));
    fs.mkdirSync(cwd, { recursive: true });
    const command = binary(member.connectionId === 'client:codex' ? 'codex' : 'claude');
    const controller = new AbortController(), job = { key, scope, controller, client: null, delta: '', output: '', failure: null, closed: false }; active.set(key, job);
    function flush() {
      if (!job.delta) return;
      const chunk = job.delta; job.delta = ''; job.output = (job.output + chunk).slice(-2000000);
      persist(scope, (run, attempt) => {
        if (attempt?.status !== 'running') throw Error('步骤已停止');
        attempt.output = (text(attempt.output) + chunk).slice(-2000000);
        attempt.clientOutputs = { ...attempt.clientOutputs, [scope.memberId]: (text(attempt.clientOutputs?.[scope.memberId]) + chunk).slice(-2000000) };
      });
    }
    const onEvent = e => {
      if (job.closed) return;
      if (e.type === 'item/agentMessage/delta') { job.delta = (job.delta + text(e.delta)).slice(-2000000); if (job.delta.length >= 8192) flush(); return; }
      flush();
      persist(scope, (run, attempt) => {
        if (!attempt || attempt.status !== 'running') throw Error('步骤已停止');
        const prior = attempt.clientSessions?.[scope.memberId] || {};
        const session = { ...prior, provider: member.connectionId, threadId: e.threadId ?? prior.threadId, turnId: e.turnId ?? prior.turnId };
        attempt.clientSession = session; attempt.clientSessions = { ...attempt.clientSessions, [scope.memberId]: session }; event(run, 'client', { text: JSON.stringify(e) }, scope);
      });
      if (e.type === 'approval/resolved') for (const entry of [...approvals.values()]) if (entry.job === job && entry.requestId === e.requestId) settle(entry, false, e.resolutionReason || 'expired');
    };
    const onApproval = request => {
      const current = authorized(scope, true), session = current.attempt.clientSessions?.[scope.memberId];
      if (controller.signal.aborted || job.closed || !/^item\/(commandExecution|fileChange)\/requestApproval$/.test(request.method) || !request.itemId || !session?.threadId || request.threadId !== session.threadId || !session?.turnId || request.turnId !== session.turnId) return Promise.resolve('decline');
      return new Promise(resolve => {
        const id = 'client:' + crypto.randomUUID(), entry = { id, job, requestId: request.requestId, resolve }; approvals.set(id, entry);
        try {
          persist(scope, run => {
            queueOf(run).push({ nodeId: id, text: `${member.name} 请求官方客户端操作\n${JSON.stringify(request, null, 2)}` });
            event(run, 'permission', { text: JSON.stringify(request), approvalId: id }, scope); promote(run);
          });
        } catch (error) { approvals.delete(id); job.failure = error.message; controller.abort(); resolve('decline'); }
      });
    };
    controller.signal.addEventListener('abort', () => clearApprovals(job, 'cancelled'), { once: true });
    const timer = setInterval(() => {
      try { authorized(scope, true); flush(); } catch (error) { job.failure = error.message; controller.abort(); }
    }, deps.pollMs || 200); timer.unref?.();
    try {
      persist(scope, run => event(run, 'client_dispatch', { clientKey: key, text: '已记录本机客户端派发；尚未收到完成证据' }, scope));
      const minutes = Math.min(member.maxMinutes || 30, snapshot.version.graph.maxMinutes || 30); let result;
      if (member.connectionId === 'client:claude') {
        const response = await runClaude({ prompt: args.prompt, cwd }, { workspaceRoots: [cwd], claudeBin: command, claudeExtraArgs: `--model ${member.model} --max-turns 10`, claudeTimeoutMs: minutes * 60000, signal: controller.signal });
        result = { status: response.ok && response.execution?.status === 'succeeded' ? 'completed' : response.uncertain ? 'unknown' : response.execution?.status === 'permission_required' ? 'approval_required' : response.cancelled ? 'cancelled' : 'failed', text: text(response.content), error: response.error || null, session: response.execution || null };
      } else {
        job.client = codexFactory({ binary: command, cwd, turnTimeoutMs: minutes * 60000 });
        result = await job.client.run({ prompt: args.prompt, model: member.model, effort: member.effort, cwd, sandbox: member.tools?.length ? 'workspaceWrite' : 'readOnly', signal: controller.signal, onEvent, onApproval });
      }
      flush(); job.output = text(result?.text) || job.output; authorized(scope, true);
      const normalized = { ...result, status: ['completed', 'failed', 'unknown', 'cancelled', 'approval_required'].includes(result?.status) ? result.status : 'unknown', text: text(result?.text), error: result?.error || null };
      if (job.failure) { normalized.status = 'unknown'; normalized.error = job.failure; }
      persist(scope, (run, attempt) => {
        if (!attempt || attempt.status !== 'running') throw Error('步骤已停止，客户端结果须重新核实');
        const session = { provider: member.connectionId, ...(normalized.session || {}), threadId: normalized.threadId || null, turnId: normalized.turnId || null, status: normalized.status };
        attempt.clientSessions = { ...attempt.clientSessions, [scope.memberId]: session }; attempt.clientSession = session;
        attempt.clientOutputs = { ...attempt.clientOutputs, [scope.memberId]: normalized.text }; event(run, 'client_result', { text: `官方客户端结果：${normalized.status}` }, scope);
      });
      return normalized;
    } catch (error) { return { status: 'unknown', text: job.output + job.delta, error: error.message }; }
    finally { job.closed = true; clearInterval(timer); clearApprovals(job, 'turn_ended'); job.client?.close(); active.delete(key); }
  }
  function approve(id, approved) {
    const entry = approvals.get(id); if (!entry) throw Error('此批准请求已过期，请重新核实');
    if (find(entry.job.scope).run.pendingApproval?.nodeId !== id) throw Error('此动作尚未轮到批准，请先处理当前请求');
    return settle(entry, approved === true);
  }
  function abort(runId) { for (const job of active.values()) if (job.scope.runId === runId) job.controller.abort(); }
  // A new controller cannot authorize promises belonging to the previous process.
  for (const project of Object.values(collaboration.read().projects)) for (const run of project.runs) {
    if (!(run.approvalQueue || []).some(a => a.nodeId.startsWith('client:')) && !run.pendingApproval?.nodeId.startsWith('client:')) continue;
    const scope = { projectId: project.id, runId: run.id };
    persist(scope, current => {
      current.approvalQueue = queueOf(current).filter(a => !a.nodeId.startsWith('client:'));
      if (current.pendingApproval?.nodeId.startsWith('client:')) delete current.pendingApproval;
      promote(current); event(current, 'permission', { text: '上次本机客户端审批已过期；不会复用批准。' }, scope);
    });
  }
  return { check, login, run, approve, abort, busy: () => active.size, close() { for (const job of active.values()) job.controller.abort(); for (const client of loginClients.values()) client.close(); loginClients.clear(); } };
}
module.exports = { createLocalClients };
