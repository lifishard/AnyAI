'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const path = require('node:path');
const {
  createAcpClient,
  safeEnvironment,
  validateExecutable,
  MAX_OUTPUT_BYTES,
  MAX_FRAME_BYTES,
} = require('../electron/acp-client.cjs');

const cwd = path.resolve(__dirname, '..');
const binary = path.join(cwd, 'kimi.exe');

function defaultSession(configOptions = []) {
  return {
    sessionId: 'session-1',
    configOptions,
    modes: { currentModeId: 'plan', availableModes: [
      { id: 'plan', name: 'Plan', description: 'Read-only planning' },
      { id: 'default', name: 'Default' },
      { id: 'auto', name: 'Auto' },
      { id: 'yolo', name: 'Yolo' },
    ] },
    models: [{ id: 'kimi-k2', name: 'Kimi K2', description: 'Fixture model' }],
  };
}

function fixture({ session = defaultSession(), initialize = {}, handlers = {}, options = {} } = {}) {
  const requests = [];
  const wire = [];
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.kill = () => { child.killed = true; };
  let input = '';
  let invocation = null;

  const send = message => { wire.push(message); child.stdout.write(`${JSON.stringify(message)}\n`); };
  const respond = (request, result = {}) => send({ jsonrpc: '2.0', id: request.id, result });
  const defaultInitialize = {
    protocolVersion: 1,
    agentInfo: { name: 'kimi', title: 'Kimi Code', version: 'fixture' },
    agentCapabilities: {
      loadSession: true,
      promptCapabilities: { image: true, audio: false, embeddedContext: true },
      mcpCapabilities: { http: true, sse: false },
      sessionCapabilities: { list: {}, delete: {}, additionalDirectories: {}, resume: {}, close: {} },
      auth: { logout: {} },
    },
  };

  const onRequest = request => {
    requests.push(request);
    const custom = handlers[request.method];
    if (custom) {
      custom(request, { child, send, respond, requests });
      return;
    }
    if (request.method === 'initialize') return respond(request, { ...defaultInitialize, ...initialize });
    if (request.method === 'session/new') return respond(request, session);
    if (request.method === 'session/set_config_option' || request.method === 'session/set_model' || request.method === 'session/set_mode') {
      return respond(request, { configOptions: session.configOptions });
    }
    if (request.method === 'session/close') return respond(request, {});
    if (request.method === 'session/prompt') return;
    // Notifications such as session/cancel have no id and need no response.
  };

  child.stdin = new Writable({
    write(chunk, encoding, done) {
      input += chunk.toString();
      let newline;
      while ((newline = input.indexOf('\n')) !== -1) {
        const line = input.slice(0, newline);
        input = input.slice(newline + 1);
        if (!line.trim()) continue;
        onRequest(JSON.parse(line));
      }
      done();
    },
  });

  const client = createAcpClient({
    binary,
    cwd,
    platform: 'win32',
    env: {
      PATH: 'fixture-path',
      SystemRoot: 'C:\\Windows',
      HOME: 'fixture-home',
      KIMI_API_KEY: 'must-not-forward',
      OPENAI_API_KEY: 'must-not-forward',
      ANTHROPIC_API_KEY: 'must-not-forward',
      NODE_OPTIONS: 'must-not-forward',
      HTTPS_PROXY: 'must-not-forward',
    },
    spawn: (...args) => { invocation = args; return child; },
    requestTimeoutMs: options.requestTimeoutMs ?? 250,
    turnTimeoutMs: options.turnTimeoutMs ?? 1000,
    cancelTimeoutMs: options.cancelTimeoutMs ?? 30,
  });

  return {
    client,
    child,
    send,
    respond,
    requests,
    wire,
    invocation: () => invocation,
  };
}

function nextTick() {
  return new Promise(resolve => setImmediate(resolve));
}

async function waitFor(predicate, timeoutMs = 500) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (predicate()) return;
    await nextTick();
  }
  assert.fail('Timed out waiting for fake ACP request');
}

test('safe environment and executable validation keep the native launch narrow', () => {
  assert.deepEqual(safeEnvironment({
    PATH: 'safe', HOME: 'home', KIMI_API_KEY: 'secret', OPENAI_API_KEY: 'secret', NODE_OPTIONS: 'secret', HTTPS_PROXY: 'secret',
  }), { PATH: 'safe', HOME: 'home', NO_COLOR: '1', FORCE_COLOR: '0' });
  assert.equal(validateExecutable(binary, 'win32'), binary);
  assert.throws(() => validateExecutable(path.join(cwd, 'kimi.cmd'), 'win32'), /native Kimi executable|shell scripts/);
  assert.throws(() => validateExecutable(path.join(cwd, 'kimi'), 'win32'), /\.exe/);
  assert.throws(() => validateExecutable('kimi.exe', 'win32'), /absolute path/);
});

test('inspect negotiates ACP v1 and returns safe models, modes, efforts, and capabilities', async () => {
  const configOptions = [
    {
      id: 'model', category: 'model', type: 'select', currentValue: 'kimi-k2',
      options: [
        { value: 'kimi-k2', name: 'Kimi K2', description: 'Fixture model' },
        { value: 'kimi-k2-thinking', name: 'Kimi K2 Thinking' },
      ],
    },
    {
      id: 'mode', category: 'mode', type: 'select', currentValue: 'plan',
      options: [
        { value: 'plan', name: 'Plan' },
        { value: 'default', name: 'Default' },
        { value: 'auto', name: 'Auto' },
        { value: 'yolo', name: 'Yolo' },
      ],
    },
    {
      id: 'thought_level', category: 'thought_level', type: 'select', currentValue: 'high',
      options: [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }],
    },
  ];
  const f = fixture({ session: defaultSession(configOptions) });
  const info = await f.client.inspect();
  const [initialize, sessionNew] = f.requests;
  assert.equal(initialize.method, 'initialize');
  assert.deepEqual(initialize.params.clientCapabilities, {
    fs: { readTextFile: false, writeTextFile: false },
    terminal: false,
  });
  assert.deepEqual(sessionNew.params, { cwd, mcpServers: [] });
  assert.deepEqual(f.invocation().slice(0, 2), [binary, ['acp']]);
  assert.equal(f.invocation()[2].shell, false);
  assert.equal(f.invocation()[2].windowsHide, true);
  assert.equal(f.invocation()[2].env.KIMI_API_KEY, undefined);
  assert.equal(f.invocation()[2].env.NODE_OPTIONS, undefined);
  assert.deepEqual(info, {
    sessionId: 'session-1',
    protocolVersion: 1,
    agent: { name: 'kimi', title: 'Kimi Code', version: 'fixture' },
    capabilities: {
      loadSession: true,
      prompt: { image: true, audio: false, embeddedContext: true },
      mcp: { http: true, sse: false },
      session: { list: true, delete: true, additionalDirectories: true, resume: true, close: true },
      auth: { logout: true },
    },
    models: [
      { id: 'kimi-k2', name: 'Kimi K2', description: 'Fixture model' },
      { id: 'kimi-k2-thinking', name: 'Kimi K2 Thinking', description: null },
    ],
    modes: [
      { id: 'plan', name: 'Plan', description: 'Read-only planning' },
      { id: 'default', name: 'Default', description: null },
      { id: 'auto', name: 'Auto', description: null },
      { id: 'yolo', name: 'Yolo', description: null },
    ],
    efforts: [
      { id: 'low', name: 'Low', description: null },
      { id: 'high', name: 'High', description: null },
    ],
    current: { model: 'kimi-k2', mode: 'plan', effort: 'high' },
  });
  await f.client.close();
});

test('AUTH_REQUIRED preserves only a safe login hint for the host', async () => {
  const f = fixture({ handlers: {
    'session/new': (request, { send }) => send({ jsonrpc: '2.0', id: request.id, error: {
      code: -32000,
      message: 'AUTH_REQUIRED',
      data: { authMethods: [{ id: 'login', name: 'Login with Kimi', description: 'Run kimi login', type: 'terminal', args: ['login'], env: { SECRET: 'drop' } }] },
    } }),
  } });
  await assert.rejects(f.client.inspect(), error => {
    assert.equal(error.code, -32000);
    assert.equal(error.authRequired, true);
    assert.deepEqual(error.authMethods, [{ id: 'login', name: 'Login with Kimi', description: 'Run kimi login', type: 'terminal' }]);
    return true;
  });
  await f.client.close();
});

test('inspect accepts the ACP SessionModelState object and model selection uses the Kimi extension', async () => {
  const session = defaultSession([]);
  session.models = {
    currentModelId: 'kimi-k2',
    availableModels: [
      { modelId: 'kimi-k2', name: 'Kimi K2' },
      { modelId: 'kimi-k2-thinking', name: 'Thinking' },
    ],
  };
  const f = fixture({ session });
  const info = await f.client.inspect();
  assert.deepEqual(info.models, [
    { id: 'kimi-k2', name: 'Kimi K2', description: null },
    { id: 'kimi-k2-thinking', name: 'Thinking', description: null },
  ]);
  assert.equal(info.current.model, 'kimi-k2');
  const pending = f.client.run({ prompt: 'test', model: 'kimi-k2-thinking' });
  await waitFor(() => f.requests.some(request => request.method === 'session/prompt'));
  assert.deepEqual(f.requests.find(request => request.method === 'session/set_model').params, { sessionId: 'session-1', model: 'kimi-k2-thinking' });
  f.respond(f.requests.find(request => request.method === 'session/prompt'), { stopReason: 'end_turn' });
  assert.equal((await pending).status, 'completed');
  await f.client.close();
});

test('run selects advertised model and effort, prefers safe chat mode, and exposes text only', async () => {
  const configOptions = [
    { id: 'model', category: 'model', type: 'select', currentValue: 'kimi-k2', options: [{ value: 'kimi-k2' }, { value: 'kimi-k2-thinking' }] },
    { id: 'mode', category: 'mode', type: 'select', currentValue: 'plan', options: [{ value: 'plan' }, { value: 'default' }, { value: 'auto' }, { value: 'yolo' }] },
    { id: 'thought_level', category: 'thought_level', type: 'select', currentValue: 'low', options: [{ value: 'low' }, { value: 'high' }] },
  ];
  const f = fixture({ session: defaultSession(configOptions) });
  const events = [];
  const pending = f.client.run({ prompt: 'hello ACP', model: 'kimi-k2-thinking', effort: 'high', mode: 'chat', onEvent: event => events.push(event) });
  await waitFor(() => f.requests.some(request => request.method === 'session/prompt'));
  const methods = f.requests.map(request => request.method);
  assert.deepEqual(methods, ['initialize', 'session/new', 'session/set_config_option', 'session/set_config_option', 'session/set_mode', 'session/prompt']);
  assert.deepEqual(f.requests[2].params, { sessionId: 'session-1', configId: 'model', value: 'kimi-k2-thinking' });
  assert.deepEqual(f.requests[3].params, { sessionId: 'session-1', configId: 'thought_level', value: 'high' });
  assert.deepEqual(f.requests[4].params, { sessionId: 'session-1', modeId: 'plan' });
  assert.deepEqual(f.requests[5].params, { sessionId: 'session-1', prompt: [{ type: 'text', text: 'hello ACP' }] });
  f.send({ method: 'session/update', params: { sessionId: 'session-1', update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'private thought' } } } });
  f.send({ method: 'session/update', params: { sessionId: 'session-1', update: { sessionUpdate: 'agent_message_chunk', content: [{ type: 'text', text: 'hello ' }, { type: 'image', data: 'private' }] } } });
  f.send({ method: 'session/update', params: { sessionId: 'session-1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'world' } } } });
  f.send({ method: 'session/update', params: { sessionId: 'session-1', update: { sessionUpdate: 'usage_update', used: 12, size: 100 } } });
  f.respond(f.requests[5], { stopReason: 'end_turn' });
  const result = await pending;
  assert.equal(result.status, 'completed');
  assert.equal(result.text, 'hello world');
  assert.deepEqual(result.usage, { used: 12, size: 100 });
  assert.deepEqual(events, [{ type: 'text', delta: 'hello ' }, { type: 'text', delta: 'world' }]);
  await f.client.close();
});

test('permission callback receives a scoped request and selected outcome is preserved', async () => {
  const f = fixture();
  let approvalRequest;
  const pending = f.client.run({
    prompt: 'inspect the repository',
    onApproval: request => {
      approvalRequest = request;
      return { optionId: 'allow_once' };
    },
  });
  await waitFor(() => f.requests.some(request => request.method === 'session/prompt'));
  const prompt = f.requests.find(request => request.method === 'session/prompt');
  f.send({
    jsonrpc: '2.0',
    id: 44,
    method: 'session/request_permission',
    params: {
      sessionId: 'session-1',
      toolCall: { toolCallId: 'tool-1', title: 'Read file', kind: 'read', status: 'in_progress', secret: 'must-not-forward' },
      options: [
        { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once', description: 'one turn' },
        { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' },
      ],
    },
  });
  await waitFor(() => f.requests.some(message => message.id === 44 && message.result));
  assert.deepEqual(approvalRequest, {
    type: 'permission_required',
    requestId: 44,
    sessionId: 'session-1',
    toolCall: { toolCallId: 'tool-1', title: 'Read file', kind: 'read', status: 'in_progress' },
    options: [
      { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' },
    ],
  });
  // Send a terminal response after the callback response has been emitted.
  f.respond(prompt, { stopReason: 'end_turn' });
  const result = await pending;
  assert.equal(result.status, 'completed');
  await f.client.close();
});

test('generic approval cannot escalate to a session-wide Kimi grant', async () => {
  const f = fixture();
  const pending = f.client.run({ prompt: 'work', onApproval: () => 'accept' });
  await waitFor(() => f.requests.some(request => request.method === 'session/prompt'));
  const prompt = f.requests.find(request => request.method === 'session/prompt');
  f.send({ jsonrpc: '2.0', id: 45, method: 'session/request_permission', params: {
    sessionId: 'session-1', toolCall: { title: 'Write file' }, options: [
      { optionId: 'allow-always', name: 'Allow for this session', kind: 'allow_always' },
      { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
    ],
  } });
  await waitFor(() => f.requests.some(message => message.id === 45 && message.result));
  assert.deepEqual(f.requests.find(message => message.id === 45).result, { outcome: { outcome: 'selected', optionId: 'reject-once' } });
  f.respond(prompt, { stopReason: 'end_turn' });
  assert.equal((await pending).status, 'permission_required');
  await f.client.close();
});

test('declined or mismatched permissions cannot silently complete a turn', async () => {
  const f = fixture();
  const pending = f.client.run({ prompt: 'run a tool' });
  await waitFor(() => f.requests.some(request => request.method === 'session/prompt'));
  const prompt = f.requests.find(request => request.method === 'session/prompt');
  f.send({ jsonrpc: '2.0', id: 10, method: 'session/request_permission', params: { sessionId: 'other', options: [] } });
  f.send({ jsonrpc: '2.0', id: 11, method: 'session/request_permission', params: { sessionId: 'session-1', options: [
    { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' },
  ] } });
  await nextTick();
  f.respond(prompt, { stopReason: 'end_turn' });
  const result = await pending;
  assert.equal(result.status, 'permission_required');
  // The mismatch is answered with a protocol error; the matching request is
  // declined because no approval callback was supplied.
  assert.equal(f.requests.find(message => message.id === 10).error.code, -32602);
  assert.deepEqual(f.requests.find(message => message.id === 11).result, { outcome: { outcome: 'selected', optionId: 'reject_once' } });
  await f.client.close();
});

test('unadvertised model and effort are rejected before prompt submission', async () => {
  const configOptions = [
    { id: 'model', category: 'model', type: 'select', currentValue: 'kimi-k2', options: [{ value: 'kimi-k2' }] },
    { id: 'thought_level', category: 'thought_level', type: 'select', currentValue: 'low', options: [{ value: 'low' }] },
  ];
  for (const option of [{ model: 'secret-model' }, { effort: 'ultra' }]) {
    const f = fixture({ session: defaultSession(configOptions) });
    const result = await f.client.run({ prompt: 'test', ...option });
    assert.equal(result.status, 'failed');
    assert.equal(f.requests.some(request => request.method === 'session/prompt'), false);
    assert.equal(f.requests.some(request => request.method === 'session/set_config_option'), false);
    await f.client.close();
  }
});

test('chat refuses a session that advertises only permissive modes', async () => {
  const session = defaultSession([{ id: 'mode', category: 'mode', type: 'select', currentValue: 'yolo', options: [{ value: 'auto' }, { value: 'yolo' }] }]);
  session.modes = { currentModeId: 'yolo', availableModes: [{ id: 'auto', name: 'Auto' }, { id: 'yolo', name: 'Yolo' }] };
  const f = fixture({ session });
  const result = await f.client.run({ prompt: 'test', mode: 'chat' });
  assert.equal(result.status, 'failed');
  assert.match(result.error, /safe chat mode/);
  assert.equal(f.requests.some(request => request.method === 'session/prompt'), false);
  await f.client.close();
});

test('user cancellation completes only after ACP confirms cancelled stopReason', async () => {
  const abort = new AbortController();
  const f = fixture({ handlers: {
    'session/cancel': () => {
      const prompt = f.requests.find(request => request.method === 'session/prompt');
      f.respond(prompt, { stopReason: 'cancelled' });
    },
  } });
  const pending = f.client.run({ prompt: 'long task', signal: abort.signal });
  await waitFor(() => f.requests.some(request => request.method === 'session/prompt'));
  abort.abort();
  const result = await pending;
  assert.equal(result.status, 'cancelled');
  assert.equal(f.requests.filter(request => request.method === 'session/cancel').length, 1);
  await f.client.close();
});

test('unconfirmed cancellation, malformed frames, and non-terminal stops remain uncertain or failed', async () => {
  const abort = new AbortController();
  const f = fixture({ options: { cancelTimeoutMs: 10 } });
  const pending = f.client.run({ prompt: 'long task', signal: abort.signal });
  await waitFor(() => f.requests.some(request => request.method === 'session/prompt'));
  abort.abort();
  assert.equal((await pending).status, 'unknown');
  assert.equal(f.child.killed, true);

  const malformed = fixture();
  const malformedPending = malformed.client.run({ prompt: 'test' });
  await waitFor(() => malformed.requests.some(request => request.method === 'session/prompt'));
  malformed.child.stdout.write('ordinary stdout\n');
  assert.equal((await malformedPending).status, 'unknown');

  const failed = fixture();
  const failedPending = failed.client.run({ prompt: 'test' });
  await waitFor(() => failed.requests.some(request => request.method === 'session/prompt'));
  failed.respond(failed.requests.find(request => request.method === 'session/prompt'), { stopReason: 'max_tokens' });
  const failedResult = await failedPending;
  assert.equal(failedResult.status, 'failed');
  assert.match(failedResult.error, /max_tokens/);
  await failed.client.close();
});

test('output and incomplete protocol frames are bounded', async () => {
  const output = fixture();
  const outputPending = output.client.run({ prompt: 'test' });
  await waitFor(() => output.requests.some(request => request.method === 'session/prompt'));
  output.send({ method: 'session/update', params: { sessionId: 'session-1', update: {
    sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'x'.repeat(MAX_OUTPUT_BYTES + 1) },
  } } });
  assert.equal((await outputPending).status, 'unknown');
  assert.equal(output.child.killed, true);

  const frame = fixture({ options: { requestTimeoutMs: 1000 } });
  const framePending = frame.client.run({ prompt: 'test' });
  await waitFor(() => frame.requests.some(request => request.method === 'session/prompt'));
  frame.child.stdout.write('x'.repeat(MAX_FRAME_BYTES + 1));
  assert.equal((await framePending).status, 'unknown');
  assert.equal(frame.child.killed, true);
});
