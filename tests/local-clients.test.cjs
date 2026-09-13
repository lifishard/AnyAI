'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createLocalClients } = require('../electron/local-clients.cjs');
const clone = value => structuredClone(value);
function fixture(t, configure = () => {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wickrun-local-client-test-'));
  const calls = [], clients = [], sessions = new Map(); let writes = 0;
  const members = [1, 2].map(n => ({ id: 'm' + n, name: 'Member ' + n, enabled: true, connectionId: 'client:codex', model: 'test-model', effort: 'high', tools: [], maxTokens: 100, maxMinutes: 1 }));
  let data = { revision: 0, projects: { p: { id: 'p', files: [], runs: [{ id: 'r', status: 'running', members, projectSettings: { allowedConnections: ['client:codex', 'client:claude'], roots: [root], maxConcurrent: 2 }, version: { graph: { maxTokens: 1000, maxMinutes: 2, nodes: [1, 2].map(n => ({ id: 'n' + n, type: 'agent', memberId: 'm' + n })) } }, tokens: 0, reservations: { 'a1:m1': 100, 'a2:m2': 100 }, attempts: [1, 2].map(n => ({ id: 'a' + n, nodeId: 'n' + n, status: 'running', output: '' })), events: [] }] } } };
  configure(data.projects.p.runs[0], data.projects.p);
  const store = { read: () => clone(data), update(revision, project) { assert.equal(revision, data.revision); data.projects[project.id] = clone(project); data.revision++; writes++; } };
  const factory = () => {
    const client = {
      closed: false,
      close() { this.closed = true; },
      async readAccount() { return { account: { type: 'chatgpt', planType: 'plus', email: 'SECRET_EMAIL', accessToken: 'SECRET_TOKEN' }, auth: 'SECRET_AUTH' }; },
      async readRateLimits() { return { rateLimits: { primary: { usedPercent: 20, windowDurationMins: 300, resetsAt: 1, authToken: 'SECRET_TOKEN' }, refreshToken: 'SECRET_REFRESH' }, token: 'SECRET_TOKEN' }; },
      async listModels() { return { data: [{ id: 'model', displayName: 'Model', token: 'SECRET_MODEL_TOKEN' }] }; },
      run(options) {
        const call = { options, client }; calls.push(call);
        options.onEvent({ type: 'thread/ready', threadId: 'thread-' + calls.length });
        options.onEvent({ type: 'turn/ready', threadId: 'thread-' + calls.length, turnId: 'turn-' + calls.length });
        return new Promise(resolve => { call.finish = resolve; options.signal.addEventListener('abort', () => resolve({ status: 'unknown', text: 'partial', error: 'cancelled without terminal' }), { once: true }); });
      },
    }; clients.push(client); return client;
  };
  const manager = createLocalClients({ userData: root, collaboration: store, teamFiles: { get: id => clone(sessions.get(id)) }, getSettings: () => ({ clients: { codexBin: __filename } }), openExternal: async () => {}, deps: { createCodexClient: factory, pollMs: 10 } });
  t.after(() => { manager.close(); assert.equal(path.dirname(root), fs.realpathSync(os.tmpdir())); assert.ok(path.basename(root).startsWith('wickrun-local-client-test-')); fs.rmSync(root, { recursive: true, force: true }); });
  return { manager, calls, clients, sessions, root, get: () => data.projects.p.runs[0], project: () => data.projects.p, writes: () => writes, start(n = 1, extra = {}) { return manager.run({ projectId: 'p', runId: 'r', attemptId: 'a' + n, memberId: 'm' + n, prompt: 'Do this', ...extra }); } };
}
function ask(f, index = 0) {
  return f.calls[index].options.onApproval({ method: 'item/commandExecution/requestApproval', requestId: 7, threadId: 'thread-' + (index + 1), turnId: 'turn-' + (index + 1), itemId: 'item', command: 'echo test', cwd: f.root });
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('parallel members queue approvals without overwriting and decisions resolve asynchronously', async t => {
  const f = fixture(t), a = f.start(1), b = f.start(2), first = ask(f), second = ask(f, 1);
  assert.equal(f.manager.busy(), 2); assert.equal(f.get().approvalQueue.length, 2);
  const [id1, id2] = f.get().approvalQueue.map(a => a.nodeId); assert.notEqual(id1, id2);
  assert.throws(() => f.manager.approve(id2, true), /尚未/);
  let resolved = false; first.then(() => { resolved = true; }); await tick(); assert.equal(resolved, false);
  f.manager.approve(id1, true); assert.equal(await first, 'accept'); assert.equal(f.get().pendingApproval.nodeId, id2);
  f.manager.approve(id2, false); assert.equal(await second, 'decline'); assert.equal(f.get().pendingApproval, undefined);
  f.calls[0].finish({ status: 'completed', text: 'one', error: null }); f.calls[1].finish({ status: 'completed', text: 'two', error: null });
  assert.equal((await a).status, 'completed'); assert.equal((await b).text, 'two'); assert.equal(f.manager.busy(), 0);
});

test('client queue cleanup preserves an unrelated API approval', async t => {
  const f = fixture(t, r => { r.pendingApproval = { nodeId: 'api:approval', text: 'API request' }; r.approvalQueue = [r.pendingApproval]; });
  const p = f.start(), decision = ask(f), id = f.get().approvalQueue[1].nodeId;
  assert.equal(f.get().pendingApproval.nodeId, 'api:approval'); f.manager.abort('r');
  assert.equal(await decision, 'decline'); await p;
  assert.deepEqual(f.get().approvalQueue, [{ nodeId: 'api:approval', text: 'API request' }]); assert.throws(() => f.manager.approve(id, true), /过期/);
});

test('terminal result clears pending approval and late UI clicks cannot act', async t => {
  const f = fixture(t), p = f.start(), decision = ask(f), id = f.get().pendingApproval.nodeId;
  f.calls[0].finish({ status: 'unknown', text: 'partial', error: 'process exited' });
  assert.equal((await p).status, 'unknown'); assert.equal(await decision, 'decline'); assert.equal(f.get().pendingApproval, undefined);
  assert.throws(() => f.manager.approve(id, true), /过期/); assert.equal(f.clients[0].closed, true);
});

test('adapter timeout event expires the UI approval before a terminal result', async t => {
  const f = fixture(t), p = f.start(), decision = ask(f), id = f.get().pendingApproval.nodeId;
  f.calls[0].options.onEvent({ type: 'approval/resolved', requestId: 7, threadId: 'thread-1', turnId: 'turn-1', decision: 'decline', resolutionReason: 'timeout' });
  assert.equal(await decision, 'decline'); assert.throws(() => f.manager.approve(id, true), /过期/);
  f.calls[0].finish({ status: 'approval_required', text: '', error: null }); assert.equal((await p).status, 'approval_required');
});

test('dispatch requires the assigned enabled member and positive budget reservation', async t => {
  for (const change of [r => r.members[0].enabled = false, r => r.version.graph.nodes[0].memberId = 'm2', r => delete r.reservations['a1:m1'], r => r.reservations['a1:m1'] = 0, r => r.tokens = 950, r => r.projectSettings.allowedConnections = ['other'], r => r.status = 'paused', r => r.attempts[0].status = 'completed']) {
    const f = fixture(t, change); await assert.rejects(f.start()); assert.equal(f.calls.length, 0); assert.equal(f.manager.busy(), 0);
  }
});

test('file session must belong to this project run member and frozen allowed root', async t => {
  const f = fixture(t); const base = { id: 'file', projectId: 'p', taskId: 'r', memberId: 'm1', status: 'isolated', root: f.root, isolatedRoot: path.join(f.root, 'isolated') };
  f.project().files.push({ id: 'file' });
  for (const override of [{ projectId: 'other' }, { taskId: 'other' }, { memberId: 'm2' }, { root: path.dirname(f.root) }, { status: 'merged' }, { status: 'conflict' }, { recoveryRequired: true }]) {
    f.sessions.set('file', { ...base, ...override }); await assert.rejects(f.start(1, { fileSessionId: 'file' }), /隔离区/);
  }
  f.sessions.set('file', base); const p = f.start(1, { fileSessionId: 'file' }); assert.equal(f.calls[0].options.cwd, base.isolatedRoot); f.calls[0].finish({ status: 'completed', text: 'done', error: null }); await p;
});

test('batched deltas persist as output without marking an attempt complete; terminal flush is durable', async t => {
  const f = fixture(t), p = f.start(), before = f.writes();
  for (let i = 0; i < 100; i++) f.calls[0].options.onEvent({ type: 'item/agentMessage/delta', threadId: 'thread-1', turnId: 'turn-1', delta: 'a' });
  assert.equal(f.writes(), before);
  f.calls[0].options.onEvent({ type: 'item/completed', threadId: 'thread-1', turnId: 'turn-1', item: { type: 'agentMessage', text: 'final' } });
  assert.equal(f.get().attempts[0].output, 'a'.repeat(100)); assert.equal(f.get().attempts[0].status, 'running');
  f.calls[0].finish({ status: 'completed', text: 'final', error: null }); const result = await p;
  assert.equal(result.text, 'final'); assert.equal(f.get().attempts[0].status, 'running'); assert.equal(f.get().attempts[0].clientOutputs.m1, 'final');
  await assert.rejects(f.start(), /已派发/);
});

test('connection status only exposes allowed account quota and model fields', async t => {
  const f = fixture(t); const result = await f.manager.check('codex'); assert.equal(JSON.stringify(result).includes('SECRET'), false);
  assert.equal(result.account.account.planType, 'plus'); assert.equal(result.rateLimits.rateLimits.primary.usedPercent, 20); assert.equal(f.clients[0].closed, true);
});

test('state changes while awaiting UI reject acceptance and never become success', async t => {
  const f = fixture(t), p = f.start(), decision = ask(f), id = f.get().pendingApproval.nodeId;
  f.get().status = 'cancelled'; assert.throws(() => f.manager.approve(id, true)); assert.equal(await decision, 'decline');
  const result = await p; assert.equal(result.status, 'unknown'); assert.equal(typeof result.text, 'string'); assert.equal(typeof result.error, 'string');
  assert.equal(f.get().pendingApproval, undefined); assert.deepEqual(f.get().approvalQueue, []);
});

test('startup removes stale native approvals while preserving the shared API queue', t => {
  const f = fixture(t, r => { r.approvalQueue = [{ nodeId: 'client:old', text: 'old' }, { nodeId: 'api:current', text: 'keep' }]; r.pendingApproval = r.approvalQueue[0]; });
  assert.deepEqual(f.get().approvalQueue, [{ nodeId: 'api:current', text: 'keep' }]); assert.equal(f.get().pendingApproval.nodeId, 'api:current');
});

test('wrong native scope never creates an approval and unknown statuses stay unknown', async t => {
  const f = fixture(t), p = f.start();
  assert.equal(await f.calls[0].options.onApproval({ method: 'item/commandExecution/requestApproval', threadId: 'other', turnId: 'turn-1', itemId: 'item' }), 'decline');
  assert.equal(f.get().pendingApproval, undefined); f.calls[0].finish({ status: 'maybe', text: 'partial' });
  assert.deepEqual(await p, { status: 'unknown', text: 'partial', error: null });
});
