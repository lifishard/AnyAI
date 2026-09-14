'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const path = require('node:path');
const { createCodexClient } = require('../electron/codex-client.cjs');

function fixture(custom = {}, settings = {}) {
  const messages = [], process = new EventEmitter();
  process.stdout = new PassThrough(); process.stderr = new PassThrough();
  process.kill = () => { process.killed = true; };
  let input = '', invocation;
  function send(message) { process.stdout.write(JSON.stringify(message) + '\n'); }
  process.stdin = new Writable({ write(chunk, encoding, done) {
    input += chunk.toString();
    let pos;
    while ((pos = input.indexOf('\n')) !== -1) {
      const request = JSON.parse(input.slice(0, pos)); input = input.slice(pos + 1); messages.push(request);
      queueMicrotask(() => {
        if (!request.method || request.method === 'initialized') return;
        if (custom[request.method]) { custom[request.method](request, send, process); return; }
        const defaults = { initialize: {}, 'account/read': { account: { type: 'chatgpt', email: 'private@example.test', planType: 'plus' } }, 'thread/start': { thread: { id: 'thread-1' } }, 'thread/resume': { thread: { id: 'thread-1' } }, 'turn/start': { turn: { id: 'turn-1', status: 'inProgress' } }, 'turn/interrupt': {} };
        send({ id: request.id, result: defaults[request.method] || {} });
      });
    }
    done();
  } });
  const client = createCodexClient({ binary: path.resolve('codex.exe'), cwd: path.resolve('.'), env: { PATH: 'safe', OPENAI_API_KEY: 'forbidden', ANTHROPIC_API_KEY: 'forbidden', CODEX_HOME: 'forbidden', NODE_OPTIONS: 'forbidden', HTTPS_PROXY: 'forbidden' }, spawn: (...args) => { invocation = args; return process; }, requestTimeoutMs: 500, turnTimeoutMs: 1000, cancelTimeoutMs: 20, ...settings });
  return { client, send, messages, process, invocation: () => invocation };
}
const terminal = (send, status = 'completed', threadId = 'thread-1', turnId = 'turn-1') => send({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status, error: status === 'failed' ? { message: 'quota reached' } : null } } });
const ready = () => new Promise(resolve => setImmediate(resolve));

test('conversation isolation disables external integrations and Chat command tools before starting a thread',async()=>{
  const f=fixture({'config/read':(request,send)=>send({id:request.id,result:{config:{mcp_servers:{custom:{}},plugins:{community:{}}}}})});
  const result=f.client.run({prompt:'Discuss only',sandbox:'readOnly',isolateTools:true});await ready();
  const config=f.messages.find(m=>m.method==='thread/start').params.config;
  assert.equal(config['features.shell_tool'],false);assert.equal(config['features.hooks'],false);assert.equal(config['features.apps'],false);
  assert.equal(config['mcp_servers."custom".enabled'],false);assert.equal(config['plugins."community".enabled'],false);
  terminal(f.send);assert.equal((await result).status,'completed');f.client.close();
});

test('conversation isolation fails before model dispatch if effective tool configuration cannot be verified',async()=>{
  const f=fixture();const result=await f.client.run({prompt:'Discuss only',isolateTools:true});assert.equal(result.status,'failed');
  assert.ok(!f.messages.some(m=>m.method==='turn/start'));f.client.close();
});

test('handshake and environment isolate subscription; only matched terminal completes', async () => {
  const f = fixture(); const events = [];
  const p = f.client.run({ prompt: 'hello', model: 'gpt-test', effort: 'high', sandbox: 'workspaceWrite', onEvent: e => events.push(e) });
  await ready();
  assert.deepEqual(f.messages.slice(0, 3).map(m => m.method), ['initialize', 'initialized', 'account/read']);
  const invocation = f.invocation(); assert.equal(invocation[2].shell, false); assert.equal(invocation[2].windowsHide, true);
  assert.deepEqual(invocation[2].env, { PATH: 'safe', NO_COLOR: '1' });
  assert.ok(invocation[1].includes('forced_login_method="chatgpt"'));
  const start = f.messages.find(m => m.method === 'turn/start');
  assert.equal(start.params.approvalPolicy, 'untrusted'); assert.equal(start.params.model, 'gpt-test');
  assert.deepEqual(start.params.sandboxPolicy.writableRoots, [path.resolve('.')]);
  f.send({ method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: 'turn-1', delta: 'partial' } });
  terminal(f.send, 'completed', 'other'); terminal(f.send, 'completed', 'thread-1', 'other');
  let settled = false; p.then(() => { settled = true; }); await ready(); assert.equal(settled, false);
  f.send({ method: 'item/completed', params: { threadId: 'thread-1', turnId: 'turn-1', item: { type: 'agentMessage', id: 'item-1', phase: 'final_answer', text: 'final' } } });
  terminal(f.send); const result = await p;
  assert.equal(result.status, 'completed'); assert.equal(result.text, 'final'); assert.equal(result.turnId, 'turn-1');
  assert.ok(events.some(e => e.type === 'turn/completed')); f.client.close();
});

test('split UTF8 JSONL and early terminal before turn acknowledgment are supported', async () => {
  const f = fixture({ 'turn/start': (r, send, proc) => {
    const bytes = Buffer.from(JSON.stringify({ method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: 'turn-1', delta: '你好' } }) + '\n');
    const split = bytes.indexOf(Buffer.from('你')) + 1;
    proc.stdout.write(bytes.subarray(0, split)); proc.stdout.write(bytes.subarray(split));
    terminal(send); send({ id: r.id, result: { turn: { id: 'turn-1' } } });
  } });
  const result = await f.client.run({ prompt: 'test' }); assert.equal(result.status, 'completed'); assert.equal(result.text, '你好'); f.client.close();
});

test('nonzero process exit with partial text remains unknown and does not retry', async () => {
  const f = fixture(); const p = f.client.run({ prompt: 'test' }); await ready();
  f.send({ method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: 'turn-1', delta: 'not complete' } });
  f.process.emit('close', 2);
  assert.equal((await p).status, 'unknown'); assert.equal(f.messages.filter(m => m.method === 'turn/start').length, 1);
});

test('cancellation requires interrupted terminal; acknowledgment alone is unknown', async () => {
  const f = fixture(); const abort = new AbortController(); const p = f.client.run({ prompt: 'test', signal: abort.signal }); await ready(); abort.abort();
  assert.equal((await p).status, 'unknown'); assert.ok(f.messages.some(m => m.method === 'turn/interrupt')); assert.equal(f.process.killed, true);
  const g = fixture({ 'turn/interrupt': (r, send) => { send({ id: r.id, result: {} }); terminal(send, 'interrupted'); } });
  const cancel = new AbortController(); const q = g.client.run({ prompt: 'test', signal: cancel.signal }); await ready(); cancel.abort();
  assert.equal((await q).status, 'cancelled'); g.client.close();
});

test('approval request is declined and scoped evidence prevents silent completion', async () => {
  const f = fixture({ 'turn/start': (r, send) => {
    send({ id: 'approval-1', method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'cmd-1', command: 'danger', cwd: path.resolve('.'), reason: 'needs approval' } });
    send({ id: r.id, result: { turn: { id: 'turn-1' } } }); terminal(send);
  } });
  const result = await f.client.run({ prompt: 'test' });
  assert.equal(result.status, 'approval_required'); assert.equal(result.pendingApprovals[0].command, 'danger');
  assert.deepEqual(f.messages.find(m => m.id === 'approval-1').result, { decision: 'decline' }); f.client.close();
});

test('unknown requests are denied and mismatched approvals do not affect current turn', async () => {
  const f = fixture(); const p = f.client.run({ prompt: 'test' }); await ready();
  f.send({ id: 'unknown', method: 'unknown/execute', params: {} });
  f.send({ id: 'wrong', method: 'item/fileChange/requestApproval', params: { threadId: 'thread-1', turnId: 'other' } });
  f.send({ method: 'unknown/progress', params: { threadId: 'thread-1', turnId: 'turn-1' } }); terminal(f.send);
  assert.equal((await p).status, 'completed'); assert.equal(f.messages.find(m => m.id === 'unknown').error.code, -32601); f.client.close();
});

test('API-key login is rejected before a thread or turn can start', async () => {
  const f = fixture({ 'account/read': (r, send) => send({ id: r.id, result: { account: { type: 'apiKey' } } }) });
  assert.equal((await f.client.run({ prompt: 'test' })).status, 'failed'); assert.equal(f.messages.some(m => m.method === 'thread/start'), false); f.client.close();
});

test('malformed protocol and explicit turn failures cannot become success', async () => {
  const f = fixture(); const p = f.client.run({ prompt: 'test' }); await ready(); f.process.stdout.write('ordinary stdout\n'); assert.equal((await p).status, 'unknown');
  const g = fixture(); const q = g.client.run({ prompt: 'test' }); await ready(); terminal(g.send, 'failed'); const failure = await q; assert.equal(failure.status, 'failed'); assert.equal(failure.error, 'quota reached'); g.client.close();
});

test('resume IDs are verified; read methods omit account email and use official login flow', async () => {
  const f = fixture({ 'account/login/start': (r, send) => { assert.deepEqual(r.params, { type: 'chatgpt' }); send({ id: r.id, result: { authUrl: 'https://auth.openai.com/login', loginId: 'login-1' } }); } });
  assert.deepEqual(await f.client.readAccount(), { account: { type: 'chatgpt', planType: 'plus' }, requiresOpenaiAuth: false });
  assert.equal((await f.client.login()).loginId, 'login-1');
  assert.equal((await f.client.run({ prompt: 'test', threadId: 'wrong-thread' })).status, 'failed'); assert.equal(f.messages.some(m => m.method === 'turn/start'), false); f.client.close();
});

test('event persistence failure is unknown and shuts down execution', async () => {
  const f = fixture(); const result = await f.client.run({ prompt: 'test', onEvent() { throw Error('disk full'); } });
  assert.equal(result.status, 'unknown'); assert.equal(f.process.killed, true); assert.equal(f.messages.some(m => m.method === 'turn/start'), false);
});

test('turn start timeout stays unknown and cannot submit another turn automatically', async () => {
  const f = fixture({ 'turn/start': () => {} }, { requestTimeoutMs: 15 });
  const result = await f.client.run({ prompt: 'test' }); assert.equal(result.status, 'unknown');
  assert.equal(f.messages.filter(m => m.method === 'turn/start').length, 1); assert.equal(f.process.killed, true);
});

test('cancellation before start acknowledgment interrupts the acknowledged turn', async () => {
  const abort = new AbortController();
  const f = fixture({ 'turn/start': (r, send) => { abort.abort(); send({ id: r.id, result: { turn: { id: 'turn-1' } } }); }, 'turn/interrupt': (r, send) => { assert.equal(r.params.turnId, 'turn-1'); send({ id: r.id, result: {} }); terminal(send, 'interrupted'); } });
  assert.equal((await f.client.run({ prompt: 'test', signal: abort.signal })).status, 'cancelled'); f.client.close();
});

test('permissions approval grants nothing and rate/model lookups use read methods', async () => {
  const f = fixture({ 'account/rateLimits/read': (r, send) => send({ id: r.id, result: { rateLimits: { primary: { usedPercent: 20 } } } }), 'model/list': (r, send) => { assert.equal(r.params.includeHidden, false); send({ id: r.id, result: { data: [{ id: 'test-model' }], nextCursor: null } }); } });
  assert.equal((await f.client.readRateLimits()).rateLimits.primary.usedPercent, 20); assert.equal((await f.client.listModels()).data[0].id, 'test-model');
  const p = f.client.run({ prompt: 'test' }); await ready();
  f.send({ id: 'permissions', method: 'item/permissions/requestApproval', params: { threadId: 'thread-1', turnId: 'turn-1', permissions: { network: { enabled: true } } } }); terminal(f.send);
  assert.equal((await p).status, 'approval_required'); assert.deepEqual(f.messages.find(m => m.id === 'permissions').result, { permissions: {}, scope: 'turn' }); f.client.close();
});

test('explicit approval accepts exactly once and includes file scope in the callback', async () => {
  const f = fixture(); const events = [], scopes = [];
  const p = f.client.run({ prompt: 'test', onEvent: event => events.push(event), onApproval: async request => { scopes.push(request); return 'accept'; } }); await ready();
  f.send({ method: 'item/started', params: { threadId: 'thread-1', turnId: 'turn-1', item: { id: 'file-1', type: 'fileChange', changes: [{ path: 'report.txt', kind: { type: 'update' }, diff: '+approved' }] } } });
  f.send({ id: 'file-approval', method: 'item/fileChange/requestApproval', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'file-1', grantRoot: path.resolve('.'), reason: 'change report' } });
  await ready();
  assert.equal(scopes.length, 1); assert.equal(scopes[0].changes[0].path, 'report.txt'); assert.equal(scopes[0].turnId, 'turn-1');
  assert.deepEqual(f.messages.filter(m => m.id === 'file-approval').map(m => m.result), [{ decision: 'accept' }]);
  assert.ok(events.some(e => e.type === 'approval/resolved' && e.decision === 'accept'));
  terminal(f.send); assert.equal((await p).status, 'completed'); f.client.close();
});

test('explicit decline and session-wide decision both remain declined', async () => {
  for (const choice of ['decline', 'acceptForSession']) {
    const f = fixture(); const p = f.client.run({ prompt: 'test', onApproval: async () => choice }); await ready();
    f.send({ id: 'approve', method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'cmd-1', command: 'echo hi' } }); await ready();
    assert.equal(f.messages.find(m => m.id === 'approve').result.decision, 'decline');
    terminal(f.send); assert.equal((await p).status, 'approval_required'); f.client.close();
  }
});

test('late approval after cancellation cannot grant a new turn even with reused IDs', async () => {
  let late; const abort = new AbortController();
  const f = fixture({ 'turn/interrupt': (r, send) => { send({ id: r.id, result: {} }); terminal(send, 'interrupted'); } });
  const p = f.client.run({ prompt: 'test', signal: abort.signal, onApproval: () => new Promise(resolve => { late = resolve; }) }); await ready();
  const approval = { id: 'approve', method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'cmd-1', command: 'echo hi' } };
  f.send(approval); await ready(); abort.abort(); assert.equal((await p).status, 'cancelled');
  const q = f.client.run({ prompt: 'new turn', onApproval: async () => 'decline' }); await ready();
  late('accept'); await ready();
  assert.deepEqual(f.messages.filter(m => m.id === 'approve').map(m => m.result), [{ decision: 'decline' }]);
  f.send(approval); await ready(); terminal(f.send); assert.equal((await q).status, 'approval_required');
  assert.equal(f.messages.some(m => m.result?.decision === 'accept'), false); f.client.close();
});

test('approval timeout rejects late acceptance and unsupported requests never use callback', async () => {
  let late, calls = 0;
  const f = fixture({}, { approvalTimeoutMs: 10 }); const p = f.client.run({ prompt: 'test', onApproval: () => { calls++; return new Promise(resolve => { late = resolve; }); } }); await ready();
  f.send({ id: 'unsupported', method: 'item/tool/requestUserInput', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'input-1' } });
  f.send({ id: 'approve', method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'cmd-1', command: 'echo hi' } });
  await new Promise(resolve => setTimeout(resolve, 25)); assert.equal(calls, 1); late('accept'); await ready();
  assert.deepEqual(f.messages.filter(m => m.id === 'approve').map(m => m.result), [{ decision: 'decline' }]);
  terminal(f.send); const result = await p; assert.equal(result.status, 'approval_required'); assert.ok(result.pendingApprovals.some(a => a.resolutionReason === 'timeout')); f.client.close();
});
